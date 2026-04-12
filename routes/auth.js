const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Try to send email — fails silently if SMTP not configured
async function sendEmail(to, subject, html) {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.log('SMTP not configured, skipping email to:', to);
      return false;
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({ from: `"RankSniper" <${process.env.SMTP_USER}>`, to, subject, html });
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, businessName } = req.body;
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
      plan: 'free',
      usage_count: 0,
      email_verified: true, // auto-verify for now until SMTP is configured
      verification_token: verificationToken,
      created_at: new Date().toISOString()
    }).select().single();

    if (error) throw error;

    // Try to send welcome email
    await sendEmail(email, 'Welcome to RankSniper!', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <h2 style="color:#3b82f6;">Welcome to RankSniper!</h2>
        <p>Your account has been created successfully. You can now log in and start responding to reviews with AI.</p>
        <a href="${process.env.FRONTEND_URL || 'https://ranksniperweb-production.up.railway.app'}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Open RankSniper</a>
        <p style="color:#6b7280;font-size:13px;">Questions? Reply to this email or contact contactranksniper@gmail.com</p>
      </div>
    `);

    // Auto-login after signup
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, email: user.email, plan: user.plan, businessName: user.business_name }, message: 'Account created successfully!' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// GET /api/auth/verify?token=xxx
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { data: user, error } = await supabase.from('users')
      .update({ email_verified: true, verification_token: null })
      .eq('verification_token', token)
      .select().single();

    if (error || !user) return res.status(400).json({ error: 'Invalid or expired token' });

    const jwtToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.redirect(`${process.env.FRONTEND_URL || ''}/?token=${jwtToken}&verified=true`);
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
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

    const resetUrl = `${process.env.FRONTEND_URL || 'https://ranksniperweb-production.up.railway.app'}/?reset_token=${resetToken}`;
    const sent = await sendEmail(email, 'Reset your RankSniper password', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
        <h2 style="color:#3b82f6;">Password Reset</h2>
        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Reset Password</a>
        <p style="color:#6b7280;font-size:13px;">If you didn't request this, ignore this email.</p>
      </div>
    `);

    res.json({ success: true, message: sent ? 'Reset link sent! Check your email.' : 'Reset link created. Please contact contactranksniper@gmail.com if you need help.' });
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

module.exports = router;
