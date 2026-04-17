const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/responses/save - save a generated response
router.post('/save', authMiddleware, async (req, res) => {
  try {
    const { reviewerName, rating, reviewText, responseText, businessName, score } = req.body;
    if (!responseText) return res.status(400).json({ error: 'Response text required' });

    await supabase.from('review_responses').insert({
      user_id: req.user.id,
      reviewer_name: reviewerName || 'Unknown',
      rating: rating || 5,
      review_text: (reviewText || '').substring(0, 500),
      response_text: responseText,
      business_name: businessName || '',
      score: score || null,
      created_at: new Date().toISOString()
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Save response error:', err);
    res.status(500).json({ error: 'Failed to save response' });
  }
});

// GET /api/responses - get response history for current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('review_responses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Fetch responses error:', err);
    res.status(500).json({ error: 'Failed to fetch responses' });
  }
});

// GET /api/responses/stats - get stats for email report
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('review_responses')
      .select('rating, score, created_at')
      .eq('user_id', req.user.id)
      .gte('created_at', twoWeeksAgo);

    if (error) throw error;

    const total = data?.length || 0;
    const avgScore = total > 0 ? Math.round(data.reduce((a, r) => a + (r.score || 80), 0) / total) : 0;
    const negative = data?.filter(r => r.rating <= 2).length || 0;

    res.json({ total, avgScore, negative });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// DELETE /api/responses/:id - delete a single response
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('review_responses')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id); // ensure user can only delete their own
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete response error:', err);
    res.status(500).json({ error: 'Failed to delete response' });
  }
});

// DELETE /api/responses - delete all responses for current user
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase
      .from('review_responses')
      .delete()
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Delete all responses error:', err);
    res.status(500).json({ error: 'Failed to delete history' });
  }
});

// GET /api/responses/place-search - search for a business and return review link
router.get('/place-search', authMiddleware, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Places API not configured' });

    const url = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' +
      encodeURIComponent(query) + '&inputtype=textquery&fields=place_id,name,formatted_address&key=' + apiKey;

    const response = await fetch(url);
    const data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      return res.status(404).json({ error: 'No results found. Try adding your city name.' });
    }

    const place = data.candidates[0];
    res.json({
      place_id: place.place_id,
      name: place.name,
      address: place.formatted_address
    });
  } catch (err) {
    console.error('Place search error:', err);
    res.status(500).json({ error: 'Search failed. Try again.' });
  }
});

module.exports = router;
