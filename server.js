require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const stripeRoutes = require('./routes/stripe');
const userRoutes = require('./routes/user');

const app = express();

// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/user', userRoutes);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RankSniper server running on port ${PORT}`));
