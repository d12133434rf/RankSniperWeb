const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function sendEmail(to, subject, html) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.log('RESEND_API_KEY not configured, skipping email to:', to);
      return false;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'RankSniper <no-reply@getranksniper.com>',
        to,
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) { console.error('Resend error:', data); return false; }
    console.log('Email sent to:', to);
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, businessName, phone } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).single();
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const { data: user, error } = await supabase.from('users').insert({
      email: email.toLowerCase(),
      password: hashedPassword,
      business_name: businessName || '',
      phone: phone || '',
      plan: 'free',
      usage_count: 0,
      email_verified: false,
      verification_token: verificationToken,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://getranksniper.com'}/api/auth/verify?token=${verificationToken}`;
    await sendEmail(email, 'Verify your RankSniper account', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#3b82f6;">Welcome to RankSniper!</h2>
        <p>Thanks for signing up. Click the button below to verify your email address and activate your account.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:20px 0;font-size:15px;">Verify My Email</a>
        <p style="color:#6b7280;font-size:13px;">Or copy this link: ${verifyUrl}</p>
        <p style="color:#6b7280;font-size:13px;">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </div>
    `);

    res.json({ success: true, message: 'Account created! Check your email to verify your account before logging in.' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// GET /api/auth/verify?token=xxx
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Invalid token');

    const { data: user, error } = await supabase.from('users')
      .update({ email_verified: true, verification_token: null })
      .eq('verification_token', token)
      .select().single();

    if (error || !user) return res.status(400).send('Invalid or expired verification link');

    res.send(`
      <html><head><meta http-equiv="refresh" content="3;url=${process.env.FRONTEND_URL || 'https://getranksniper.com'}/#auth"></head>
      <body style="font-family:sans-serif;background:#050810;color:#f0f4ff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;">
        <div>
          <div style="font-size:48px;margin-bottom:16px;">✅</div>
          <h2 style="color:#22c55e;margin-bottom:8px;">Email Verified!</h2>
          <p style="color:#94a3b8;">Your account is ready. Redirecting you to log in...</p>
        </div>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Verification failed');
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    if (!user.email_verified) return res.status(401).json({ error: 'Please verify your email first. Check your inbox for the verification link.' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, plan: user.plan, businessName: user.business_name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase.from('users').select('id').eq('email', email.toLowerCase()).single();
    if (!user) return res.json({ success: true, message: 'If that email exists, you will receive a reset link.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 3600000).toISOString();

    await supabase.from('users').update({ reset_token: resetToken, reset_token_expires: expires }).eq('id', user.id);

    const resetUrl = `${process.env.FRONTEND_URL || 'https://getranksniper.com'}/?reset_token=${resetToken}`;
    await sendEmail(email, 'Reset your RankSniper password', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#3b82f6;">Password Reset</h2>
        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:20px 0;font-size:15px;">Reset Password</a>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, ignore this email.</p>
      </div>
    `);

    res.json({ success: true, message: 'Reset link sent! Check your email.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });

    const { data: user } = await supabase.from('users').select('*')
      .eq('reset_token', token)
      .gt('reset_token_expires', new Date().toISOString())
      .single();

    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await supabase.from('users').update({ password: hashedPassword, reset_token: null, reset_token_expires: null }).eq('id', user.id);

    res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: user } = await supabase.from('users').select('*').eq('email', email.toLowerCase()).single();
    if (!user) return res.json({ success: true, message: 'If that email exists, a verification link will be sent.' });
    if (user.email_verified) return res.json({ success: true, message: 'Email already verified. You can log in.' });

    const verificationToken = crypto.randomBytes(32).toString('hex');
    await supabase.from('users').update({ verification_token: verificationToken }).eq('id', user.id);

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://getranksniper.com'}/api/auth/verify?token=${verificationToken}`;
    await sendEmail(email, 'Verify your RankSniper account', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#3b82f6;">Verify your email</h2>
        <p>Click the button below to verify your email address.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:20px 0;">Verify My Email</a>
      </div>
    `);

    res.json({ success: true, message: 'Verification email sent! Check your inbox.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

module.exports = router;
