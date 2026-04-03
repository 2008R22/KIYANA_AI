require('dotenv').config();
const express = require('express');
  const API = ''; // empty = same origin (localhost:3000)
  const CHAT_KEY = 'kiyana_chat';
  const IMG_KEY = 'kiyana_imgs';
  const VOICE_SETTINGS_KEY = 'kiyana_voice_enabled';

  let messages = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
  let imgHistory = JSON.parse(localStorage.getItem(IMG_KEY) || '[]');
  let isVoiceEnabled = localStorage.getItem(VOICE_SETTINGS_KEY) !== 'false'; 
  
  let pendingBase64 = null;
  let isCalling = false;
  let recognition = null;
  
  // Persistent Audio Object to bypass Android WebView restrictions
  const kiyanaAudio = new Audio();

  const viewport = document.getElementById('viewport');
  const msgInput = document.getElementById('msgInput');
  const thinking = document.getElementById('thinking');
  const thinkLabel = document.getElementById('thinkLabel');
  const imgPreview = document.getElementById('imgPreview');
  const previewThumb = document.getElementById('previewThumb');

  // --- UTILS & STORAGE ---
  function save() { localStorage.setItem(CHAT_KEY, JSON.stringify(messages)); }
  function saveImgs() { localStorage.setItem(IMG_KEY, JSON.stringify(imgHistory)); }
  
  function updateVoiceUI() {
    const onIcon = document.getElementById('voiceOnIcon');
    const offIcon = document.getElementById('voiceOffIcon');
    if(onIcon && offIcon) {
        onIcon.style.display = isVoiceEnabled ? 'block' : 'none';
        offIcon.style.display = isVoiceEnabled ? 'none' : 'block';
    }
  }

  // CRITICAL: Unlocks the audio channel for Android/Median
  // Must be called directly inside a click handler
  function unlockAudio() {
    kiyanaAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA="; 
    kiyanaAudio.play().catch(() => {});
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function buildHistory() {
    return messages.filter(m => !m.isUserImg && !m.imageUrl).slice(-20).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant', content: m.text
    }));
  }

  // --- CORE CHAT LOGIC ---
  async function speak(text, forceSpeak = false, onEnd) {
    if (!text) { if (onEnd) onEnd(); return; }
    
    // Check if voice is disabled (and we aren't in a live call)
    if (!isVoiceEnabled && !forceSpeak) {
        if (onEnd) onEnd();
        return;
    }

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!res.ok) throw new Error('TTS failed');
      
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      
      kiyanaAudio.src = url;
      kiyanaAudio.onended = () => { URL.revokeObjectURL(url); if (onEnd) onEnd(); };
      kiyanaAudio.onerror = () => { if (onEnd) onEnd(); };
      await kiyanaAudio.play();
    } catch (err) {
      console.error("Audio error:", err);
      // Fallback to browser TTS if server/network fails
      const u = new SpeechSynthesisUtterance(text); 
      u.rate = 1.05;
      if (onEnd) u.onend = onEnd;
      window.speechSynthesis.speak(u);
    }
  }

  async function sendChat(text, base64) {
    thinkLabel.textContent = 'Thinking';
    thinking.style.display = 'flex';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            message: text, 
            imageBase64: base64 || undefined, 
            history: base64 ? undefined : buildHistory() 
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) return null;
      return data.content;
    } catch(e) { return null; }
    finally { thinking.style.display = 'none'; }
  }

  async function onSend() {
    unlockAudio(); // Unlock audio for Android on click
    const text = msgInput.value.trim();
    if (!text && !pendingBase64) return;
    
    const b64 = pendingBase64;
    const imgSrc = b64 ? `data:image/jpeg;base64,${b64}` : null;
    addMsg('user', text || 'Analyzing image...', imgSrc, !!b64);
    
    msgInput.value = ''; 
    msgInput.style.height = 'auto';
    pendingBase64 = null; 
    imgPreview.style.display = 'none';
    
    const reply = await sendChat(text, b64);
    if (reply) { 
        addMsg('ai', reply); 
        speak(reply); // This will only play if isVoiceEnabled is true
    }
  }

  // --- CALL FEATURE ---
  document.getElementById('callBtn').onclick = () => {
    unlockAudio(); // Critical for APKs
    isCalling = true;
    document.getElementById('callOverlay').style.display = 'flex';

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { 
        document.getElementById('callStatus').textContent = 'NOT SUPPORTED'; 
        return; 
    }

    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    const listenLoop = () => {
      if (!isCalling) return;
      document.getElementById('callStatus').textContent = 'LISTENING';
      try { recognition.start(); } catch(e) {}
    };

    recognition.onresult = async (e) => {
      const said = e.results[0][0].transcript.trim();
      if (!said) { listenLoop(); return; }

      document.getElementById('transcript').textContent = `"${said}"`;
      document.getElementById('callStatus').textContent = 'THINKING';
      addMsg('user', said);

      let fullReply = '';
      try {
        const res = await fetch('/api/chat-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: said, history: buildHistory() })
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        document.getElementById('callStatus').textContent = 'SPEAKING';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fullReply += decoder.decode(value, { stream: true });
          document.getElementById('transcript').textContent = fullReply;
        }
      } catch (err) { fullReply = 'Sorry, I had trouble connecting.'; }

      if (fullReply) {
        addMsg('ai', fullReply);
        // During a call, we set forceSpeak to TRUE
        speak(fullReply, true, () => { if (isCalling) listenLoop(); });
      } else if (isCalling) listenLoop();
    };

    recognition.onerror = (e) => { if (e.error !== 'aborted' && isCalling) listenLoop(); };
    listenLoop();
    speak("Hey, it's Kiyana! What's up?", true);
  };

  // --- UI HANDLERS ---
  function addMsg(role, text, imageUrl, isUserImg, fromHistory) {
    const entry = { role, text, imageUrl, isUserImg };
    if (!fromHistory) { messages.push(entry); save(); }

    const div = document.createElement('div');
    div.className = `msg ${role}`;
    let imgHtml = '';
    if (imageUrl) {
      imgHtml = `<div class="img-wrap">
        <img src="${imageUrl}" alt="${isUserImg ? 'Uploaded' : 'Generated'}">
        ${!isUserImg ? `<button class="dl-btn" onclick="dlImg('${imageUrl}')">
          <svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>` : ''}
      </div>`;
    }
    div.innerHTML = `<div class="bubble">${escHtml(text)}${imgHtml}</div>`;
    viewport.appendChild(div);
    viewport.scrollTop = viewport.scrollHeight;
  }

  // Voice Toggle Button
  document.getElementById('voiceToggle').onclick = () => {
    unlockAudio();
    isVoiceEnabled = !isVoiceEnabled;
    localStorage.setItem(VOICE_SETTINGS_KEY, isVoiceEnabled);
    updateVoiceUI();
  };

  document.getElementById('endCallBtn').onclick = () => {
    isCalling = false;
    document.getElementById('callOverlay').style.display = 'none';
    if (recognition) { try { recognition.abort(); } catch {} }
    kiyanaAudio.pause();
    kiyanaAudio.src = '';
  };

  // Settings & History
  document.getElementById('settingsBtn').onclick = () => document.getElementById('settingsOverlay').classList.add('show');
  document.getElementById('closeSettings').onclick = () => document.getElementById('settingsOverlay').classList.remove('show');
  document.getElementById('clearChatBtn').onclick = () => {
    messages = []; save(); viewport.innerHTML = '';
    document.getElementById('settingsOverlay').classList.remove('show');
    addMsg('ai', 'Memory cleared.');
  };

  // Image generation
  document.getElementById('genBtn').onclick = onGenerate;
  async function onGenerate() {
    unlockAudio();
    const prompt = msgInput.value.trim();
    if (!prompt) return;
    addMsg('user', 'Generate image: ' + prompt);
    msgInput.value = ''; 
    thinkLabel.textContent = 'Painting'; 
    thinking.style.display = 'flex';
    try {
      const res = await fetch(`${API}/api/generate-image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (data.url) {
        addMsg('ai', 'Here is your image.', data.url);
        imgHistory.unshift({ url: data.url, prompt, ts: Date.now() }); 
        saveImgs();
      }
    } catch(e) { addMsg('ai', 'Connection error.'); }
    finally { thinking.style.display = 'none'; }
  }

  // Image Upload Logic
  document.getElementById('analyzeBtn').onclick = () => {
    unlockAudio();
    document.getElementById('fileInput').click();
  };
  document.getElementById('fileInput').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (f) => {
      pendingBase64 = f.target.result.split(',')[1];
      previewThumb.src = f.target.result;
      imgPreview.style.display = 'flex';
      msgInput.focus();
    };
    reader.readAsDataURL(file); e.target.value = '';
  };
  document.getElementById('clearImg').onclick = () => { pendingBase64 = null; imgPreview.style.display = 'none'; };

  // Final Init
  document.getElementById('sendBtn').onclick = onSend;
  msgInput.onkeydown = (e) => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } };
  updateVoiceUI();
  if (messages.length) messages.forEach(m => addMsg(m.role, m.text, m.imageUrl, m.isUserImg, true));
  else addMsg('ai', 'Kiyana online. How can I help?');
