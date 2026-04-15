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
    console.log('Email sent successfully to:', to);
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// POST /api/stripe/create-checkout - create Stripe checkout session
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

    // Check if user already used a trial via Stripe
    let alreadyUsedTrial = user.had_trial === true;

    if (!alreadyUsedTrial && trial !== false) {
      // Check Stripe for any previous subscriptions with trial
      const previousSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10
      });
      alreadyUsedTrial = previousSubs.data.some(sub => sub.trial_end !== null);

      // Also check if any other Stripe customer shares the same card fingerprint
      const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
      if (paymentMethods.data.length > 0) {
        const fingerprint = paymentMethods.data[0].card.fingerprint;
        if (fingerprint) {
          // Search for other customers with same card fingerprint
          const allCustomers = await stripe.customers.search({
            query: `metadata['cardFingerprint']:'${fingerprint}'`,
            limit: 5
          });
          if (allCustomers.data.some(c => c.id !== customerId)) {
            alreadyUsedTrial = true;
          }
        }
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

    // Only add trial if explicitly requested AND user hasn't used one before
    if (trial !== false && !alreadyUsedTrial) {
      sessionConfig.subscription_data = { trial_period_days: 7 };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url, hadTrial: alreadyUsedTrial });
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
        const isTrial = session.subscription ? true : false;

        // Store card fingerprint to prevent future trial abuse
        if (session.payment_intent || session.setup_intent) {
          try {
            const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
            if (paymentMethods.data.length > 0) {
              const fingerprint = paymentMethods.data[0].card.fingerprint;
              await stripe.customers.update(customerId, { metadata: { cardFingerprint: fingerprint } });
            }
          } catch (e) {
            console.error('Error storing card fingerprint:', e.message);
          }
        }

        // Mark that this user has used a trial
        if (isTrial) {
          await supabase.from('users').update({ had_trial: true }).eq('stripe_customer_id', customerId);
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

  if (event.type === 'customer.subscription.updated') {
    const customerId = session.customer;
    if (customerId && session.cancel_at_period_end === true) {
      console.log('Subscription set to cancel at period end for:', customerId);
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
