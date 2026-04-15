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

const app = express();

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/user', userRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/sms', smsRoutes);
app.use('/api/reviews', reviewRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RankSniper server running on port ${PORT}`);

  // Run review check immediately on startup, then every 30 minutes
  checkAllUsersForNewReviews();
  setInterval(checkAllUsersForNewReviews, 30 * 60 * 1000);
});
