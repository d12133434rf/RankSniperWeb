const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// GET /api/user/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('id, email, plan, usage_count, business_name, phone, phone2, phone3, created_at')
      .eq('id', req.user.id)
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST /api/user/usage - increment usage count
router.post('/usage', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('plan, usage_count')
      .eq('id', req.user.id)
      .single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.plan !== 'pro') {
      return res.status(403).json({ error: 'Start your free trial to use RankSniper.' });
    }
    const { data } = await supabase
      .from('users')
      .update({ usage_count: user.usage_count + 1 })
      .eq('id', req.user.id)
      .select('usage_count')
      .single();
    res.json({ usage_count: data.usage_count, plan: user.plan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update usage' });
  }
});

// POST /api/user/phone - save up to 3 phone numbers for SMS alerts
router.post('/phone', authMiddleware, async (req, res) => {
  try {
    const { phone, phone2, phone3 } = req.body;
    if (!phone) return res.status(400).json({ error: 'At least one phone number required' });

    const update = { phone };
    if (phone2 !== undefined) update.phone2 = phone2;
    if (phone3 !== undefined) update.phone3 = phone3;

    await supabase.from('users').update(update).eq('id', req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save phone numbers' });
  }
});

// POST /api/user/reset-usage - reset monthly usage (called by cron)
router.post('/reset-usage', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.JWT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await supabase.from('users').update({ usage_count: 0 });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset usage' });
  }
});

module.exports = router;
