const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Extract Place ID or search query from Google Maps URL
function extractPlaceQuery(url) {
  try {
    // Handle place ID format: https://maps.google.com/?cid=... or place/...
    const placeIdMatch = url.match(/place\/([^/]+)\//);
    if (placeIdMatch) {
      return decodeURIComponent(placeIdMatch[1]).replace(/\+/g, ' ');
    }
    // Handle search query format
    const searchMatch = url.match(/search\/([^/@]+)/);
    if (searchMatch) {
      return decodeURIComponent(searchMatch[1]).replace(/\+/g, ' ');
    }
    // Handle q= parameter
    const qMatch = url.match(/[?&]q=([^&]+)/);
    if (qMatch) {
      return decodeURIComponent(qMatch[1]).replace(/\+/g, ' ');
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Send SMS via Twilio
async function sendSMS(to, message) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_PHONE_NUMBER;

    if (!accountSid || !authToken || !from) {
      console.log('Twilio not configured, skipping SMS to:', to);
      return false;
    }

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ To: to, From: from, Body: message }).toString()
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log('SMS sent to:', to);
    return true;
  } catch (e) {
    console.error('SMS send error:', e.message);
    return false;
  }
}

// Fetch reviews from Outscraper
async function fetchReviews(placeQuery) {
  try {
    const apiKey = process.env.OUTSCRAPER_API_KEY;
    if (!apiKey) throw new Error('OUTSCRAPER_API_KEY not set');

    const url = `https://api.app.outscraper.com/maps/reviews-v3?query=${encodeURIComponent(placeQuery)}&reviewsLimit=10&language=en&apiKey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) throw new Error(JSON.stringify(data));

    const reviews = data?.data?.[0]?.reviews_data || [];
    return reviews.map(r => ({
      review_id: r.review_id || r.review_link || `${r.reviewer_name}-${r.review_datetime_utc}`,
      reviewer_name: r.reviewer_name || 'Someone',
      rating: r.review_rating || 0,
      review_text: r.review_text || ''
    }));
  } catch (e) {
    console.error('Outscraper error:', e.message);
    return [];
  }
}

// Main polling function - called every 30 minutes by the scheduler
async function checkAllUsersForNewReviews() {
  console.log('[ReviewMonitor] Starting review check for all pro users...');

  try {
    // Get all pro users with a phone number and google maps URL
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, phone, phone2, phone3, google_maps_url, business_name')
      .eq('plan', 'pro')
      .not('phone', 'is', null)
      .not('google_maps_url', 'is', null)
      .neq('phone', '')
      .neq('google_maps_url', '');

    if (error) throw error;
    if (!users || users.length === 0) {
      console.log('[ReviewMonitor] No eligible users found');
      return;
    }

    console.log(`[ReviewMonitor] Checking ${users.length} users`);

    for (const user of users) {
      try {
        const placeQuery = extractPlaceQuery(user.google_maps_url);
        if (!placeQuery) {
          console.log(`[ReviewMonitor] Could not extract place query for user ${user.id}`);
          continue;
        }

        const reviews = await fetchReviews(placeQuery);
        if (reviews.length === 0) continue;

        // Get reviews we've already seen for this user
        const { data: seenReviews } = await supabase
          .from('monitored_reviews')
          .select('review_id')
          .eq('user_id', user.id);

        const seenIds = new Set((seenReviews || []).map(r => r.review_id));

        // Find new reviews
        const newReviews = reviews.filter(r => !seenIds.has(r.review_id));

        if (newReviews.length === 0) {
          console.log(`[ReviewMonitor] No new reviews for user ${user.email}`);
          continue;
        }

        console.log(`[ReviewMonitor] Found ${newReviews.length} new reviews for user ${user.email}`);

        // Save new reviews to database
        for (const review of newReviews) {
          await supabase.from('monitored_reviews').upsert({
            user_id: user.id,
            review_id: review.review_id,
            reviewer_name: review.reviewer_name,
            rating: review.rating,
            review_text: review.review_text,
            created_at: new Date().toISOString()
          }, { onConflict: 'user_id,review_id' });

          // Send SMS alert
          const stars = '⭐'.repeat(Math.min(review.rating, 5));
          const preview = review.review_text
            ? review.review_text.substring(0, 80) + (review.review_text.length > 80 ? '...' : '')
            : 'No text left';

          const message = `🎯 RankSniper Alert!\n${review.reviewer_name} left a ${review.rating}-star review${stars}:\n"${preview}"\n\nOpen RankSniper to respond: getranksniper.com/dashboard.html`;

          const phonesToAlert = [user.phone, user.phone2, user.phone3].filter(p => p && p.trim());
          for (const phoneNum of phonesToAlert) {
            await sendSMS(phoneNum, message);
          }
        }
      } catch (userErr) {
        console.error(`[ReviewMonitor] Error processing user ${user.id}:`, userErr.message);
      }
    }

    console.log('[ReviewMonitor] Review check complete');
  } catch (err) {
    console.error('[ReviewMonitor] Fatal error:', err.message);
  }
}

// POST /api/reviews/save-maps-url - save Google Maps URL
router.post('/save-maps-url', authMiddleware, async (req, res) => {
  try {
    const { google_maps_url } = req.body;
    if (!google_maps_url) return res.status(400).json({ error: 'URL required' });

    const placeQuery = extractPlaceQuery(google_maps_url);
    if (!placeQuery) return res.status(400).json({ error: 'Invalid Google Maps URL. Please paste the full URL from Google Maps.' });

    await supabase.from('users').update({ google_maps_url }).eq('id', req.user.id);
    res.json({ success: true, message: 'Google Maps URL saved!' });
  } catch (err) {
    console.error('Save maps URL error:', err);
    res.status(500).json({ error: 'Failed to save URL' });
  }
});

// GET /api/reviews/maps-url - get saved Google Maps URL
router.get('/maps-url', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('google_maps_url')
      .eq('id', req.user.id)
      .single();
    res.json({ google_maps_url: user?.google_maps_url || '' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get URL' });
  }
});

// GET /api/reviews/recent - get recent reviews for dashboard
router.get('/recent', authMiddleware, async (req, res) => {
  try {
    const { data: reviews } = await supabase
      .from('monitored_reviews')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(10);
    res.json(reviews || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

module.exports = { router, checkAllUsersForNewReviews };
