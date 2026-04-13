const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Resend HTTP API
async function sendEmail(to, subject, html) {
  try {
    console.log('Attempting to send email to:', to);
    if (!process.env.RESEND_API_KEY) {
      console.log('RESEND_API_KEY not set, skipping email to:', to);
      return false;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'RankSniper <no-reply@getranksniper.com>',
        to: [to],
        subject,
        html
      })
    });
    const data = await res.json();
    console.log('Resend API response:', JSON.stringify(data));
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log('Welcome email sent successfully to:', to);
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// POST /api/stripe/create-checkout - create Stripe checkout session
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('email, stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    let customerId = user.stripe_customer_id;

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
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  console.log('Webhook event received:', event.type);
  const session = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const customerId = session.customer;
    console.log('checkout.session.completed fired, customerId:', customerId);
    if (customerId) {
      await supabase.from('users').update({ plan: 'pro' }).eq('stripe_customer_id', customerId);

      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('stripe_customer_id', customerId)
        .single();

      console.log('User found in Supabase:', user);

      if (user?.email) {
        await sendEmail(
          user.email,
          '🎉 Welcome to RankSniper Pro!',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
            <h2 style="color:#3b82f6;">You're now on RankSniper Pro!</h2>
            <p>Hi there,</p>
            <p>Thank you for subscribing! Your 30-day free trial has started and you now have full access to all RankSniper Pro features.</p>
            <h3 style="color:#1e40af;">What's included:</h3>
            <ul>
              <li>✅ Unlimited AI-powered review responses</li>
              <li>✅ Smart tone matching</li>
              <li>✅ All future features included</li>
            </ul>
            <p>You won't be charged until your trial ends. You can manage or cancel your subscription anytime from your dashboard.</p>
            <a href="${process.env.FRONTEND_URL}/dashboard.html" 
               style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;">
              Go to Dashboard
            </a>
            <p style="margin-top:24px;color:#6b7280;font-size:14px;">Questions? Reply to this email or contact us at contactranksniper@gmail.com</p>
            <p style="color:#6b7280;font-size:14px;">— The RankSniper Team</p>
          </div>
          `
        );
      } else {
        console.log('No user found in Supabase for customerId:', customerId);
      }
    }
  }

  if (event.type === 'invoice.payment_succeeded' ||
      event.type === 'customer.subscription.trial_will_end') {
    const customerId = session.customer;
    if (customerId) {
      await supabase.from('users').update({ plan: 'pro' }).eq('stripe_customer_id', customerId);
    }
  }

  if (event.type === 'customer.subscription.deleted' ||
      event.type === 'invoice.payment_failed') {
    const customerId = session.customer;
    if (customerId) {
      await supabase.from('users').update({ plan: 'expired' }).eq('stripe_customer_id', customerId);
    }
  }

  res.json({ received: true });
});

// POST /api/stripe/portal
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

// GET /api/stripe/subscription
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
