require('dotenv').config();
const path = require('path');
const express = require('express');
const { TOPIC, BOTS, debateRules } = require('./prompts');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const MAX_AUTO_TURNS = Number(process.env.MAX_AUTO_TURNS || 16);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Voices shown if the ElevenLabs voice list can't be loaded (all are ElevenLabs default voices).
const FALLBACK_VOICES = [
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda - Warm, Friendly' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George - Deep, Authoritative' },
  { id: 'EXAVITQu4vr4xnAN4Ez8', label: 'Sarah - Soft, Reassuring' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily - Velvety, British' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte - Seductive, Swedish' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica - Playful, Bright' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura - Enthusiastic, Quirky' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice - Clear, Engaging' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel - Steady, Broadcaster' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian - Deep, Resonant' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam - Dominant, Firm' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum - Husky, Trickster' },
  { id: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie - Deep, Confident' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger - Laid-back, Casual' },
];

// ---------- config for the front end ----------
app.get('/api/config', (req, res) => {
  res.json({
    topic: TOPIC,
    maxAutoTurns: MAX_AUTO_TURNS,
    mock: { llm: !ANTHROPIC_API_KEY, tts: !ELEVENLABS_API_KEY },
    bots: Object.fromEntries(
      Object.entries(BOTS).map(([id, b]) => [id, { name: b.name, defaultVoiceId: b.defaultVoiceId }])
    ),
  });
});

// ---------- ElevenLabs voice list ----------
let voiceCache = null;
app.get('/api/voices', async (req, res) => {
  if (!ELEVENLABS_API_KEY) return res.json({ voices: FALLBACK_VOICES, fallback: true });
  if (voiceCache) return res.json({ voices: voiceCache });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);
    const data = await r.json();
    voiceCache = (data.voices || [])
      .map((v) => {
        const l = v.labels || {};
        const extra = [l.description || l.descriptive, l.accent].filter(Boolean).map(cap).join(', ');
        const label = v.name.includes(' - ') || !extra ? v.name : `${v.name} - ${extra}`;
        return { id: v.voice_id, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    res.json({ voices: voiceCache });
  } catch (err) {
    console.error('[voices]', err.message);
    res.json({ voices: FALLBACK_VOICES, fallback: true });
  }
});
const cap = (s) => String(s).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

// ---------- PDF / text -> system prompt ----------
app.post('/api/prompt-file', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
  try {
    const buf = req.body;
    let text;
    if (buf.slice(0, 5).toString() === '%PDF-') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      text = (await extractText(pdf, { mergePages: true })).text;
    }
    else text = buf.toString('utf8');
    text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return res.status(422).json({ error: 'No readable text found in that file (is it a scanned image?).' });
    res.json({ text, words: text.split(/\s+/).length });
  } catch (err) {
    console.error('[prompt-file]', err.message);
    res.status(400).json({ error: 'Could not read that file.' });
  }
});

// ---------- Claude: next debate line ----------
const LABEL = { psychic: 'Psychic Interpreter', neuro: 'NeuroScientist', user: 'Audience' };

function buildMessages(botId, transcript) {
  const msgs = [];
  const push = (role, text) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else msgs.push({ role, content: text });
  };
  const openedWithDream = transcript[0]?.speaker === 'user';
  const opener = openedWithDream
    ? `[Moderator]: Welcome to tonight's debate: "${TOPIC}". Before we start, an audience member has shared a dream for you both to weigh in on. React to it, then let that carry you into the debate.`
    : botId === 'psychic'
      ? `[Moderator]: Welcome to tonight's debate: "${TOPIC}". Psychic Interpreter, you have the opening statement.`
      : `[Moderator]: Welcome to tonight's debate: "${TOPIC}". The Psychic Interpreter will open, then the NeuroScientist responds.`;
  push('user', opener);
  for (const t of transcript) {
    const text = t.interrupted ? `${t.text} [cut off by an audience member]` : t.text;
    if (t.speaker === botId) push('assistant', text);
    else push('user', `[${LABEL[t.speaker] || 'Audience'}]: ${text}`);
  }
  const last = transcript[transcript.length - 1];
  let cue = `[Moderator]: ${LABEL[botId]}, your turn.`;
  if (last && last.speaker === 'user') cue = `[Moderator]: ${LABEL[botId]}, please respond to the audience member first.`;
  push('user', cue);
  return msgs;
}

app.post('/api/turn', async (req, res) => {
  const { botId, transcript = [], systemPrompt } = req.body || {};
  if (!BOTS[botId]) return res.status(400).json({ error: 'Unknown bot' });
  const system = (systemPrompt && systemPrompt.trim() ? systemPrompt.trim() : BOTS[botId].defaultPrompt) + debateRules(botId);

  if (!ANTHROPIC_API_KEY) return res.json({ text: mockLine(botId, transcript), mock: true });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system,
        messages: buildMessages(botId, transcript.slice(-40)),
        output_config: { effort: 'low' }, // quicker, shorter replies for a live debate
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Anthropic ${r.status}`);
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .replace(/\*[^*]+\*/g, '') // strip *stage directions*
      .replace(/^\s*\[[^\]]+\]:\s*/, '') // strip a stray speaker label
      .trim();
    res.json({ text });
  } catch (err) {
    console.error('[turn]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- ElevenLabs: speech ----------
app.post('/api/tts', async (req, res) => {
  const { text, voiceId } = req.body || {};
  if (!text) return res.status(400).end();
  if (!ELEVENLABS_API_KEY) return res.status(204).end(); // front end falls back to browser voice
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      }
    );
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${await r.text()}`);
    res.set('content-type', 'audio/mpeg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('[tts]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- demo lines when no Anthropic key is set ----------
const MOCK = {
  psychic: [
    "Dreams are letters from the soul, written in symbols. You dream of water, and your heart is speaking about the tides of your own emotions.",
    "A brain scan can't read meaning, George. It can only show you the lamp is lit.",
    "Carl Jung spent his whole career on this: archetypes that show up in dreamers who never met, never read the same book. That is not coincidence, that is a shared inner language.",
    "Then why does everyone dream of falling right before they wake with a jolt?",
    "I have sat with clients who dreamed of a phone call three nights before it came. At some point the pattern itself becomes the evidence.",
    "Recurring dreams are the psyche knocking on the same door until you finally open it.",
    "Every culture, everywhere, in every era, has treated dreams as messages worth listening to. That is not superstition surviving by accident, that is something true surviving translation.",
    "Explaining the machinery is not the same as explaining the meaning.",
  ],
  neuro: [
    "During REM sleep your emotional centers light up while the logic centers go quiet. That's exactly why dreams feel vivid but make no sense once you're awake.",
    "Symbol dictionaries don't even agree with each other. The symbol isn't fixed, Madame, the interpreter is just filling in blanks.",
    "Billions of people dream every single night. A few will resemble something that happens later purely by chance, and we remember the hits and quietly forget the thousands of misses.",
    "That's just the Barnum effect. Vague enough, and it fits anyone's life.",
    "There's a real phenomenon called threat-simulation: your brain rehearses danger in sleep because it was useful for survival. That explains the falling and the chasing without any messages from beyond.",
    "I'll grant you dreams can help you notice a worry you'd been ignoring. That's real. It just isn't supernatural.",
    "Sleep paralysis alone explains centuries of 'visitor in the room' stories: your body stays locked while your visual cortex keeps firing. Terrifying, yes. Otherworldly, no.",
    "If dreams predicted the future, why didn't anyone dream about their last flight delay?",
  ],
};
const MOCK_DREAM_REPLY = {
  psychic: [
    "What a gift, sharing that with us. Dreams like that are rarely about the surface image, they're about what you're standing in front of in your waking life and haven't turned to face yet.",
    "I felt something the moment you described that. The details you chose to tell us are never random, they're exactly the ones your deeper self wanted spoken out loud tonight.",
    "Thank you for trusting us with that. Whatever came up for you in that dream has been trying to reach you for a while now. Tonight it finally found a voice.",
  ],
  neuro: [
    "Thanks for sharing that. Whatever's been sitting heaviest on your mind lately, that's almost certainly what your brain was quietly processing while you slept.",
    "That's a great example, actually. Your brain was likely stitching together a recent worry with older memories, which is exactly why it came out feeling strange and vivid rather than literal.",
    "Appreciate you telling us that one. It probably felt meaningful because it drew on something real from your day, not because it was predicting or revealing anything beyond that.",
  ],
};
function mockLine(botId, transcript) {
  const userTurns = transcript.filter((t) => t.speaker === 'user').length;
  const last = transcript[transcript.length - 1];
  if (last && last.speaker === 'user') {
    const bank = MOCK_DREAM_REPLY[botId];
    return bank[(userTurns - 1) % bank.length];
  }
  const n = transcript.filter((t) => t.speaker === botId).length;
  return MOCK[botId][n % MOCK[botId].length];
}

app.listen(PORT, () => {
  console.log(`\n  Dream Debate running at http://localhost:${PORT}`);
  if (!ANTHROPIC_API_KEY) console.log('  ! ANTHROPIC_API_KEY missing: using demo lines');
  if (!ELEVENLABS_API_KEY) console.log('  ! ELEVENLABS_API_KEY missing: using the browser voice');
  console.log('');
});
