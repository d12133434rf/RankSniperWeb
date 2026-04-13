const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/sms/request-review
router.post('/request-review', authMiddleware, async (req, res) => {
  try {
    const { customerName, customerPhone, businessName, reviewLink } = req.body;
    if (!customerPhone) return res.status(400).json({ error: 'Customer phone number required' });
    if (!reviewLink) return res.status(400).json({ error: 'Review link required' });

    // Check plan - only Pro users can send SMS
    const { data: user } = await supabase.from('users').select('plan, phone').eq('id', req.user.id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.plan !== 'pro') return res.status(403).json({ error: 'SMS review requests are a Pro feature. Upgrade to send review requests.' });

    // Send SMS via Twilio
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const firstName = customerName ? customerName.split(' ')[0] : 'there';
    const biz = businessName || 'us';
    const message = `Hi ${firstName}! Thanks for visiting ${biz}. We hope you had a great experience! If you did, we'd really appreciate a quick Google review — it helps us a lot 🙏\n\n${reviewLink}\n\nThank you! 😊`;

    await twilio.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone
    });

    // Log the request
    await supabase.from('review_requests').insert({
      user_id: req.user.id,
      customer_name: customerName || '',
      customer_phone: customerPhone,
      sent_at: new Date().toISOString()
    });

    res.json({ success: true, message: 'Review request sent!' });
  } catch (err) {
    console.error('SMS error:', err);
    res.status(500).json({ error: err.message || 'Failed to send SMS' });
  }
});

// GET /api/sms/requests - get sent requests history
router.get('/requests', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('review_requests')
      .select('*')
      .eq('user_id', req.user.id)
      .order('sent_at', { ascending: false })
      .limit(20);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

module.exports = router;
