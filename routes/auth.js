const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, businessName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Check if user exists
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) return res.status(400).json({ error: 'Email already registered' });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const { data: user, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password: hashedPassword,
        business_name: businessName || '',
        plan: 'free',
        usage_count: 0,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ token, user: { id: user.id, email: user.email, plan: user.plan, businessName: user.business_name } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ token, user: { id: user.id, email: user.email, plan: user.plan, businessName: user.business_name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
