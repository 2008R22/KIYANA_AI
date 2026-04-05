require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // default: Bella

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

// ── Serve index.html at root ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Chat + Image Analysis ──────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, imageBase64, history } = req.body;

  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set in .env' });
  }

  const model = imageBase64
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'
    : 'llama-3.3-70b-versatile';

  const messages = [
    { role: 'system', content: 'You are Kiyana, a close friend and partner. Talk casually like a real person — use natural language, contractions, slang when it fits. Be warm, witty, and real.' }
  ];

  if (!imageBase64 && Array.isArray(history)) {
    for (const h of history) {
      if (h.role === 'user' || h.role === 'assistant') {
        messages.push({ role: h.role, content: h.content });
      }
    }
  }

  if (imageBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message || 'Describe this image.' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: message || '' });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: data.error?.message || 'Groq error' });
    }
    res.json({ content: data.choices?.[0]?.message?.content || 'No response.' });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Streaming Chat ─────────────────────────────────────────────────────────────
app.post('/api/chat-stream', async (req, res) => {
  const { message, history } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  const messages = [
    { role: 'system', content: 'You are Kiyana, a close friend and partner on a voice call. Talk like a real person — casual, warm, natural. Keep it short, 1-3 sentences. No emojis, no markdown, no lists.' },
    ...( Array.isArray(history) ? history.filter(h => h.role === 'user' || h.role === 'assistant') : [] ),
    { role: 'user', content: message }
  ];

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, stream: true })
    });

    for await (const chunk of upstream.body) {
      const lines = Buffer.from(chunk).toString().split('\n').filter(l => l.startsWith('data:'));
      for (const line of lines) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') { res.end(); return; }
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) res.write(delta);
        } catch {}
      }
    }
    res.end();
  } catch (err) {
    res.status(502).end('Stream error: ' + err.message);
  }
});

// ── TTS via ElevenLabs ─────────────────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2',
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0, use_speaker_boost: false }
        })
      }
    );

    if (!ttsRes.ok) return res.status(502).json({ error: 'ElevenLabs error' });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    ttsRes.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Image Generation ───────────────────────────────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!FREEPIK_API_KEY) {
    return res.status(500).json({ error: 'FREEPIK_API_KEY not set in .env' });
  }
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    const genRes = await fetch('https://api.freepik.com/v1/ai/text-to-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-freepik-api-key': FREEPIK_API_KEY,
        'Accept': 'application/json'
      },
      body: JSON.stringify({ prompt, num_images: 1, image: { size: 'square_1_1' }, output_format: 'jpeg' })
    });

    const data = await genRes.json();
    if (!genRes.ok) {
      return res.status(502).json({ error: 'Freepik error', detail: JSON.stringify(data) });
    }

    const item = data.data?.[0];
    if (item?.base64) return res.json({ url: `data:image/jpeg;base64,${item.base64}` });
    if (item?.url) return res.json({ url: item.url });
    res.status(502).json({ error: 'No image returned' });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Export for Vercel (required — do NOT call app.listen in serverless) ────────
module.exports = app;

// ── Local dev fallback ─────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`KIYANA running at http://localhost:${PORT}`);
  });
}
