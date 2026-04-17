require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/auth');
const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/user');
const contactRoutes = require('./routes/contact');
const smsRoutes = require('./routes/sms');
const { router: reviewRoutes, checkAllUsersForNewReviews } = require('./routes/reviews');
const responsesRoutes = require('./routes/responses');

const app = express();

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow getranksniper.com and Chrome extensions
    if (
      origin === process.env.FRONTEND_URL ||
      origin === 'https://getranksniper.com' ||
      origin.startsWith('chrome-extension://') ||
      origin.includes('google.com')
    ) {
      return callback(null, true);
    }
    return callback(null, true); // Allow all for now
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/user', userRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/responses', responsesRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function sendBiWeeklyReports() {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data: users } = await supabase
      .from('users')
      .select('id, email, business_name')
      .eq('plan', 'pro');

    if (!users || users.length === 0) return;

    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    for (const user of users) {
      try {
        const { data: responses } = await supabase
          .from('review_responses')
          .select('rating, score, created_at')
          .eq('user_id', user.id)
          .gte('created_at', twoWeeksAgo);

        const total = responses ? responses.length : 0;
        if (total === 0) continue;

        const avgScore = total > 0 ? Math.round(responses.reduce((a, r) => a + (r.score || 80), 0) / total) : 0;
        const negative = responses ? responses.filter(r => r.rating <= 2).length : 0;
        const positive = responses ? responses.filter(r => r.rating >= 4).length : 0;
        const bizName = user.business_name || 'your business';
        const dashUrl = (process.env.FRONTEND_URL || 'https://getranksniper.com') + '/dashboard.html';

        const htmlBody = '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#050810;color:#f0f4ff;">' +
          '<h2 style="color:#3b82f6;margin-bottom:4px;">Your RankSniper Report</h2>' +
          '<p style="color:#6b7280;margin-bottom:24px;">Here\'s how ' + bizName + ' performed over the last 2 weeks.</p>' +
          '<table style="width:100%;border-collapse:separate;border-spacing:8px;margin-bottom:24px;">' +
          '<tr>' +
          '<td style="background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px;text-align:center;">' +
          '<div style="font-size:32px;font-weight:800;color:#3b82f6;">' + total + '</div>' +
          '<div style="font-size:12px;color:#6b7280;">Reviews responded to</div></td>' +
          '<td style="background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px;text-align:center;">' +
          '<div style="font-size:32px;font-weight:800;color:#22c55e;">' + avgScore + '</div>' +
          '<div style="font-size:12px;color:#6b7280;">Avg SEO score</div></td>' +
          '<td style="background:#0d1117;border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px;text-align:center;">' +
          '<div style="font-size:32px;font-weight:800;color:#f59e0b;">' + negative + '</div>' +
          '<div style="font-size:12px;color:#6b7280;">Negative reviews handled</div></td>' +
          '</tr></table>' +
          '<p style="color:#94a3b8;">You responded to <strong style="color:#fff">' + positive + ' positive</strong> and <strong style="color:#fff">' + negative + ' negative</strong> reviews. Keep it up — consistent responses help you rank higher on Google.</p>' +
          '<a href="' + dashUrl + '" style="display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin-top:20px;">View Dashboard</a>' +
          '<p style="margin-top:24px;color:#374151;font-size:12px;">You\'re receiving this because you\'re a RankSniper Pro member. Questions? Email contactranksniper@gmail.com</p>' +
          '</div>';

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
          body: JSON.stringify({
            from: 'RankSniper <no-reply@getranksniper.com>',
            to: [user.email],
            subject: 'Your RankSniper Report — Last 2 Weeks',
            html: htmlBody
          })
        });
        console.log('[BiWeeklyReport] Sent to:', user.email);
      } catch (userErr) {
        console.error('[BiWeeklyReport] Error for user:', user.email, userErr.message);
      }
    }
  } catch (err) {
    console.error('[BiWeeklyReport] Fatal error:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('RankSniper server running on port ' + PORT);

  checkAllUsersForNewReviews();
  setInterval(checkAllUsersForNewReviews, 30 * 60 * 1000);

  setInterval(async () => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 8) {
      const lastSent = global.lastReportSent || 0;
      const daysSince = (Date.now() - lastSent) / (1000 * 60 * 60 * 24);
      if (daysSince >= 14 || lastSent === 0) {
        console.log('[BiWeeklyReport] Sending bi-weekly reports...');
        await sendBiWeeklyReports();
        global.lastReportSent = Date.now();
      }
    }
  }, 60 * 60 * 1000);
});
