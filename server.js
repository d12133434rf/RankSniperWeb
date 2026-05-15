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
const generateRoutes = require('./routes/generate');

const app = express();

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (
      origin === process.env.FRONTEND_URL ||
      origin === 'https://getranksniper.com' ||
      origin.startsWith('chrome-extension://') ||
      origin.includes('google.com')
    ) {
      return callback(null, true);
    }
    return callback(null, true);
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
app.use('/api/generate', generateRoutes);

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

        const htmlBody = '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#ffffff;color:#111111;">' +
          '<div style="margin-bottom:24px;"><span style="font-size:20px;font-weight:800;color:#3b82f6;">RankSniper</span></div>' +
          '<h2 style="font-size:22px;font-weight:700;color:#111111;margin-bottom:8px;">Your bi-weekly summary</h2>' +
          '<p style="color:#6b7280;margin-bottom:28px;font-size:15px;">Here is how ' + bizName + ' performed over the last 2 weeks.</p>' +
          '<table style="width:100%;border-collapse:collapse;margin-bottom:28px;"><tr>' +
          '<td style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:20px;text-align:center;">' +
          '<div style="font-size:36px;font-weight:800;color:#3b82f6;">' + total + '</div>' +
          '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Reviews responded to</div></td>' +
          '<td style="width:8px;"></td>' +
          '<td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;text-align:center;">' +
          '<div style="font-size:36px;font-weight:800;color:#16a34a;">' + avgScore + '</div>' +
          '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Avg SEO score</div></td>' +
          '<td style="width:8px;"></td>' +
          '<td style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:20px;text-align:center;">' +
          '<div style="font-size:36px;font-weight:800;color:#d97706;">' + negative + '</div>' +
          '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Negative reviews handled</div></td>' +
          '</tr></table>' +
          '<p style="color:#374151;font-size:15px;line-height:1.6;margin-bottom:24px;">You responded to <strong>' + positive + ' positive</strong> and <strong>' + negative + ' negative</strong> reviews this period. Consistent responses help you rank higher on Google Maps.</p>' +
          '<a href="' + dashUrl + '" style="display:inline-block;background:#3b82f6;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">View Dashboard</a>' +
          '<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0;">' +
          '<p style="color:#9ca3af;font-size:12px;">You are receiving this as a RankSniper Pro member. Questions? Email contactranksniper@gmail.com</p>' +
          '</div>';

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
          body: JSON.stringify({
            from: 'RankSniper <hello@getranksniper.com>',
            to: [user.email],
            subject: 'Your RankSniper summary for the last 2 weeks',
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
