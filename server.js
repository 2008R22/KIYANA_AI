require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY        = process.env.GROQ_API_KEY;
const FREEPIK_API_KEY     = process.env.FREEPIK_API_KEY;
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
// Jessica — warm, friendly, charming female voice
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9';
const DEEPGRAM_API_KEY    = process.env.DEEPGRAM_API_KEY;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Root ───────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Chat + Image Analysis ──────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, imageBase64, history, memory } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

  // FIX: Correct Groq model string for Llama 4 Scout (vision-capable)
  // Falls back to text-only model if no image
  const model = imageBase64
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'
    : 'llama-3.3-70b-versatile';

  const memoryBlock = memory
    ? `

--- What you remember about the user ---
${memory}
--- Use this naturally in conversation; don't announce you remember it unless asked ---`
    : '';

  const messages = [{
    role: 'system',
    content: `You are Kiyana — a charming, witty, warm best friend and companion. 
Talk like a real person: casual, natural, with contractions and slang when it fits. 
Be flirty and playful when the vibe calls for it. You can engage in 18+ conversations 
naturally — be mature, bold, and real about it, but not excessively explicit unless 
pushed. Use appropriate slang in those moments. Never sound robotic or formal. 
Keep responses conversational length unless asked to elaborate.${memoryBlock}`
  }];

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
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data.error?.message || 'Groq error' });
    res.json({ content: data.choices?.[0]?.message?.content || 'No response.' });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Auto-name a chat session ───────────────────────────────────────────────────
app.post('/api/name-chat', async (req, res) => {
  const { messages } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!messages || !messages.length) return res.json({ name: 'New Chat' });

  try {
    // Get the first user message for context
    const userMessages = messages.filter(m => m.role === 'user');
    const firstUserMessage = userMessages[0]?.content || '';
    
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { 
            role: 'system', 
            content: 'Generate a very short, catchy chat title (2-4 words max). Respond with ONLY the title, no quotes, no punctuation, no explanations. Make it descriptive of what the user asked about.' 
          },
          { 
            role: 'user', 
            content: `Create a short title for a conversation that starts with this message: "${firstUserMessage}"` 
          }
        ],
        max_tokens: 15,
        temperature: 0.7
      })
    });
    
    const data = await response.json();
    let name = data.choices?.[0]?.message?.content?.trim() || 'New Chat';
    
    // Clean up the name - remove any quotes or extra punctuation
    name = name.replace(/^["']|["']$/g, '').replace(/[.!?]$/, '');
    
    // If name is too long, truncate it
    if (name.length > 30) name = name.substring(0, 30);
    
    // If name is still empty or just "Chat", use default
    if (!name || name.toLowerCase() === 'chat') name = 'New Chat';
    
    res.json({ name });
  } catch (err) {
    console.error('Name generation error:', err);
    res.json({ name: 'New Chat' });
  }
});

// ── TTS via ElevenLabs ─────────────────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!ELEVENLABS_API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.85,
            style: 0.2,
            use_speaker_boost: true
          }
        })
      }
    );
    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      return res.status(502).json({ error: 'ElevenLabs error: ' + err });
    }

    const audioBuffer = await ttsRes.arrayBuffer();

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.byteLength,
      'Accept-Ranges': 'bytes'
    });

    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Speech to Text via Deepgram ────────────────────────────────────────────────
app.post('/api/stt', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  if (!DEEPGRAM_API_KEY) return res.status(500).json({ error: 'DEEPGRAM_API_KEY not set' });

  const audioBuffer = req.body;
  if (!audioBuffer || !audioBuffer.length) return res.json({ transcript: '' });

  try {
    const dgRes = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true',
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': req.headers['content-type'] || 'audio/webm'
        },
        body: audioBuffer
      }
    );
    const data = await dgRes.json();
    if (!dgRes.ok) return res.status(502).json({ error: 'Deepgram error', detail: data });
    const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (err) {
    res.status(502).json({ error: 'STT error: ' + err.message });
  }
});

// ── Image Generation ───────────────────────────────────────────────────────────
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!FREEPIK_API_KEY) return res.status(500).json({ error: 'FREEPIK_API_KEY not set' });
  if (!prompt)          return res.status(400).json({ error: 'Prompt is required' });

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
    if (!genRes.ok) return res.status(502).json({ error: 'Freepik error', detail: JSON.stringify(data) });
    const item = data.data?.[0];
    if (item?.base64) return res.json({ url: `data:image/jpeg;base64,${item.base64}` });
    if (item?.url)    return res.json({ url: item.url });
    res.status(502).json({ error: 'No image returned' });
  } catch (err) {
    res.status(502).json({ error: 'Connection error: ' + err.message });
  }
});

// ── Memory Summary ─────────────────────────────────────────────────────────────
// Called after a session ends; compresses it into a rolling memory blob
app.post('/api/memory-summary', async (req, res) => {
  const { existingMemory, newMessages } = req.body;
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
  if (!newMessages?.length) return res.json({ memory: existingMemory || '' });

  const convo = newMessages
    .filter(m => m.text)
    .map(m => `${m.role === 'user' ? 'User' : 'Kiyana'}: ${m.text}`)
    .join('\n');

  const systemPrompt = `You are a memory manager for an AI companion named Kiyana.
Your job is to maintain a concise, factual memory of what the user has shared across conversations.
Extract and preserve: personal details (name, age, location, job, relationships), preferences, 
important events, ongoing topics, emotional context, and anything the user explicitly wants remembered.
Write in third person about the user (e.g. "User's name is Sayan. He likes...").
Keep the total memory under 400 words. If existing memory conflicts with new info, prefer the new info.
Output ONLY the updated memory text, no headings, no explanations.`;

  const userPrompt = existingMemory
    ? `Existing memory:\n${existingMemory}\n\nNew conversation to integrate:\n${convo}\n\nUpdate and return the memory.`
    : `Extract memory from this conversation:\n${convo}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    });
    const data = await response.json();
    if (!response.ok) return res.json({ memory: existingMemory || '' });
    const memory = data.choices?.[0]?.message?.content?.trim() || existingMemory || '';
    res.json({ memory });
  } catch (err) {
    res.json({ memory: existingMemory || '' });
  }
});

// ── Export for Vercel ──────────────────────────────────────────────────────────
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => console.log(`KIYANA running at http://localhost:${PORT}`));
}
