const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.post('/', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'All fields required' });

    // Save to Supabase
    await supabase.from('contact_messages').insert({ name, email, message, created_at: new Date().toISOString() });

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      const res2 = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'RankSniper Contact <no-reply@getranksniper.com>',
          to: 'contactranksniper@gmail.com',
          reply_to: email,
          subject: `New Contact Message from ${name}`,
          html: `
            <div style="font-family:sans-serif;max-width:500px;">
              <h2 style="color:#3b82f6;">New Contact Message</h2>
              <p><strong>Name:</strong> ${name}</p>
              <p><strong>Email:</strong> ${email}</p>
              <p><strong>Message:</strong></p>
              <p style="background:#f3f4f6;padding:16px;border-radius:8px;">${message}</p>
            </div>
          `
        })
      });
      const data = await res2.json();
      if (!res2.ok) console.error('Resend error:', data);
      else console.log('Contact email sent');
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
