const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/stripe/create-checkout - create Stripe checkout session
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('email, stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    let customerId = user.stripe_customer_id;

    // Create Stripe customer if doesn't exist
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: req.user.id } });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      subscription_data: {
        trial_period_days: 30,
      },
      success_url: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/dashboard.html?upgraded=true',
      cancel_url: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/#pricing',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/stripe/webhook - handle Stripe events
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  const session = event.data.object;

  // Trial started or payment succeeded - give pro access
  if (event.type === 'checkout.session.completed' || 
      event.type === 'invoice.payment_succeeded' ||
      event.type === 'customer.subscription.trial_will_end') {
    const customerId = session.customer;
    if (customerId) {
      await supabase.from('users').update({ plan: 'pro' }).eq('stripe_customer_id', customerId);
    }
  }

  // Subscription cancelled or trial ended without payment
  if (event.type === 'customer.subscription.deleted' || 
      event.type === 'invoice.payment_failed') {
    const customerId = session.customer;
    if (customerId) {
      await supabase.from('users').update({ plan: 'expired' }).eq('stripe_customer_id', customerId);
    }
  }

  res.json({ received: true });
});

// POST /api/stripe/portal - customer portal for managing subscription
router.post('/portal', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    if (!user?.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// GET /api/stripe/subscription - get subscription details
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    if (!user?.stripe_customer_id) return res.json({ status: 'none' });

    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id,
      limit: 1,
      status: 'all'
    });

    if (!subscriptions.data.length) return res.json({ status: 'none' });

    const sub = subscriptions.data[0];
    res.json({
      status: sub.status,
      trial_end: sub.trial_end,
      current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end
    });
  } catch (err) {
    console.error('Subscription fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

module.exports = router;
