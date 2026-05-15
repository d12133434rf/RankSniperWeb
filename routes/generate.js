const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// POST /api/generate — calls Gemini using server-side API key
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Gemini API key not configured' });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 350, temperature: 0.7 }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err?.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    res.json({ text });

  } catch (err) {
    console.error('[Generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
