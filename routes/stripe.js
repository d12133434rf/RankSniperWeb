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
      success_url: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/dashboard?upgraded=true',
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

  if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
    const customerId = session.customer;
    await supabase
      .from('users')
      .update({ plan: 'pro' })
      .eq('stripe_customer_id', customerId);
  }

  if (event.type === 'customer.subscription.deleted') {
    const customerId = session.customer;
    await supabase
      .from('users')
      .update({ plan: 'free' })
      .eq('stripe_customer_id', customerId);
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

module.exports = router;
