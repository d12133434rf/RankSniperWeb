const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function sendEmail(to, subject, html) {
  try {
    if (!process.env.RESEND_API_KEY) return false;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: 'RankSniper <no-reply@getranksniper.com>', to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// Check if a card fingerprint has already been used for a trial
async function hasCardUsedTrial(fingerprint) {
  if (!fingerprint) return false;
  const { data } = await supabase
    .from('used_trial_fingerprints')
    .select('id')
    .eq('card_fingerprint', fingerprint)
    .single();
  return !!data;
}

// Save card fingerprint after trial starts
async function saveTrialFingerprint(fingerprint, email) {
  if (!fingerprint) return;
  await supabase.from('used_trial_fingerprints').upsert({
    card_fingerprint: fingerprint,
    email
  }, { onConflict: 'card_fingerprint' });
}

// Get card fingerprint for a Stripe customer
async function getCardFingerprint(customerId) {
  try {
    const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    return paymentMethods.data[0]?.card?.fingerprint || null;
  } catch (e) {
    return null;
  }
}

// POST /api/stripe/create-checkout
router.post('/create-checkout', authMiddleware, async (req, res) => {
  try {
    const { trial } = req.body;

    const { data: user } = await supabase
      .from('users')
      .select('email, stripe_customer_id, had_trial')
      .eq('id', req.user.id)
      .single();

    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: req.user.id } });
      customerId = customer.id;
      await supabase.from('users').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    // Check 1: had_trial flag in Supabase (same account)
    let blockTrial = user.had_trial === true;

    // Check 2: card fingerprint (different account, same card)
    if (!blockTrial && trial !== false) {
      const fingerprint = await getCardFingerprint(customerId);
      if (fingerprint) {
        blockTrial = await hasCardUsedTrial(fingerprint);
      }
    }

    const sessionConfig = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      allow_promotion_codes: true,
      success_url: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/dashboard.html?upgraded=true',
      cancel_url: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/#pricing',
    };

    if (trial !== false && !blockTrial) {
      sessionConfig.subscription_data = { trial_period_days: 7 };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url, hadTrial: blockTrial });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/stripe/webhook
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
    if (customerId) {
      await supabase.from('users').update({ plan: 'pro' }).eq('stripe_customer_id', customerId);

      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('stripe_customer_id', customerId)
        .single();

      if (user?.email) {
        const isTrial = !!(session.subscription);

        if (isTrial) {
          // Mark had_trial in users table
          await supabase.from('users').update({ had_trial: true }).eq('stripe_customer_id', customerId);

          // Save card fingerprint to block same card on future accounts
          const fingerprint = await getCardFingerprint(customerId);
          if (fingerprint) {
            await saveTrialFingerprint(fingerprint, user.email);
          }
        }

        await sendEmail(
          user.email,
          '🎉 Welcome to RankSniper Pro!',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
            <h2 style="color:#3b82f6;">You're now on RankSniper Pro!</h2>
            <p>Hi there,</p>
            ${isTrial
              ? `<p>Thank you for starting your <strong>7-day free trial</strong>! You now have full access to all RankSniper Pro features. You won't be charged until your trial ends.</p>`
              : `<p>Thank you for subscribing to <strong>RankSniper Pro</strong>! You now have full access to all features.</p>`
            }
            <h3 style="color:#1e40af;">What's included:</h3>
            <ul>
              <li>✅ Unlimited AI-powered review responses</li>
              <li>✅ SMS review alerts</li>
              <li>✅ Smart tone matching</li>
              <li>✅ All future features included</li>
            </ul>
            <p>You can manage or cancel your subscription anytime from your dashboard.</p>
            <a href="${process.env.FRONTEND_URL}/dashboard.html"
               style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;">
              Go to Dashboard
            </a>
            <p style="margin-top:24px;color:#6b7280;font-size:14px;">Questions? Contact us at contactranksniper@gmail.com</p>
            <p style="color:#6b7280;font-size:14px;">— The RankSniper Team</p>
          </div>
          `
        );
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

  if (event.type === 'customer.subscription.updated') {
    const customerId = session.customer;
    if (customerId && session.cancel_at_period_end === true) {
      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('stripe_customer_id', customerId)
        .single();

      if (user?.email) {
        await sendEmail(
          user.email,
          'Your RankSniper subscription has been cancelled',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
            <h2 style="color:#ef4444;">Subscription Cancelled</h2>
            <p>Hi there,</p>
            <p>Your RankSniper Pro subscription has been cancelled. You will keep access to Pro features until the end of your current billing period.</p>
            <p>If you cancelled by mistake or change your mind, you can resubscribe anytime.</p>
            <a href="${process.env.FRONTEND_URL}/#pricing"
               style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;">
              Resubscribe
            </a>
            <p style="margin-top:24px;color:#6b7280;font-size:14px;">Questions? Contact us at contactranksniper@gmail.com</p>
            <p style="color:#6b7280;font-size:14px;">— The RankSniper Team</p>
          </div>
          `
        );
      }
    }
  }

  if (event.type === 'customer.subscription.deleted' ||
      event.type === 'invoice.payment_failed') {
    const customerId = session.customer;
    if (customerId) {
      await supabase.from('users').update({ plan: 'expired' }).eq('stripe_customer_id', customerId);

      const { data: user } = await supabase
        .from('users')
        .select('email')
        .eq('stripe_customer_id', customerId)
        .single();

      if (user?.email) {
        await sendEmail(
          user.email,
          'Your RankSniper Pro access has ended',
          `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
            <h2 style="color:#ef4444;">Pro Access Ended</h2>
            <p>Hi there,</p>
            <p>Your RankSniper Pro access has ended. You no longer have access to Pro features.</p>
            <p>You can resubscribe anytime to regain access.</p>
            <a href="${process.env.FRONTEND_URL}/#pricing"
               style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:16px;">
              Resubscribe
            </a>
            <p style="margin-top:24px;color:#6b7280;font-size:14px;">Questions? Contact us at contactranksniper@gmail.com</p>
            <p style="color:#6b7280;font-size:14px;">— The RankSniper Team</p>
          </div>
          `
        );
      }
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
