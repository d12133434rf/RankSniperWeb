const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.post('/', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'All fields required' });

    // Save to Supabase
    await supabase.from('contact_messages').insert({ name, email, message, created_at: new Date().toISOString() });

    // Send email notification to RankSniper
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });

      await transporter.sendMail({
        from: `"RankSniper Contact" <${process.env.SMTP_USER}>`,
        to: process.env.SMTP_USER,
        replyTo: email,
        subject: `New Contact Form Message from ${name}`,
        html: `
          <div style="font-family:sans-serif;max-width:500px;">
            <h2 style="color:#3b82f6;">New Contact Message</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p style="background:#f3f4f6;padding:16px;border-radius:8px;">${message}</p>
          </div>
        `
      });
      console.log('Contact email sent to', process.env.SMTP_USER);
    } catch (emailErr) {
      console.error('Email error:', emailErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
