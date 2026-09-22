/* Interpreting Dreams Debate: front end */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const OTHER = { psychic: 'neuro', neuro: 'psychic' };
  const NAMES = { psychic: 'Psychic Interpreter', neuro: 'NeuroScientist', user: 'You' };

  // ---------------- state ----------------
  const bots = {
    psychic: { prompt: '', promptFile: '', voiceId: '' },
    neuro: { prompt: '', promptFile: '', voiceId: '' },
  };
  let config = { maxAutoTurns: 16, mock: {} };
  let voices = [];

  const debate = {
    running: false,
    gen: 0, // bumps whenever the flow is interrupted; stale async work checks this and bails
    transcript: [],
    next: 'psychic',
    autoTurns: 0,
    prefetch: null, // { gen, speaker, version, promise, controller }
    settingsVersion: 0,
    paused: false,
    userPaused: false, // true when the person hit the Pause button — holds the loop until they hit Resume
    muted: { psychic: false, neuro: false }, // a muted bot's turns are skipped; the other one keeps going solo
    speaking: null, // { speaker, entry }
  };

  // debate.paused is on if the user paused it, a settings popup is open, or the mic is listening.
  function updatePauseState() {
    debate.paused = debate.userPaused || !!modalBot || !!rec;
  }
  const bothMuted = () => debate.muted.psychic && debate.muted.neuro;

  // ---------------- stage scaling ----------------
  const stage = $('#stage');
  function fit() {
    const s = Math.min(innerWidth / 967, innerHeight / 550);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  addEventListener('resize', fit);
  fit();

  // ---------------- screens ----------------
  let current = 'opening';
  function show(name) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    current = name;
  }

  function toast(msg, type = 'error', ms = 4500) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = type === 'info' ? 'info' : '';
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------------- boot ----------------
  async function boot() {
    try {
      config = await (await fetch('/api/config')).json();
      bots.psychic.voiceId = config.bots.psychic.defaultVoiceId;
      bots.neuro.voiceId = config.bots.neuro.defaultVoiceId;
      voices = (await (await fetch('/api/voices')).json()).voices || [];
    } catch {
      toast('Could not reach the server. Is `npm start` running?');
    }
    buildSetupCards();
  }

  // ---------------- setup form (setup pages + popup) ----------------
  function mountForm(container, botId, { onApply, onClose, draft, requireFile = false }) {
    container.innerHTML = '';
    container.append($('#setup-form').content.cloneNode(true));
    $('.card-title', container).textContent = NAMES[botId];
    $('.setup-hint', container).textContent = requireFile
      ? `Drop a PDF or text file below to give them a personality and stance — required before you can continue. Then pick a voice and hit Apply Changes.`
      : `Optional: drop a PDF or text file below to give them a custom personality, or skip it to use our default. Then pick a voice and hit Apply Changes.`;

    const dz = $('.dropzone', container);
    const dzText = $('.dz-text', dz);
    const fileInput = $('input[type=file]', dz);
    const reset = $('.dz-reset', dz);
    const select = $('.voice-select', container);
    const applyBtn = $('.apply-btn', container);

    const refreshDz = () => {
      const loaded = !!draft.prompt;
      dz.classList.toggle('loaded', loaded);
      dzText.textContent = loaded ? draft.promptFile : (requireFile ? 'Drop PDF here (required)' : 'Drop PDF here');
      dz.title = loaded ? 'Custom system prompt loaded. Drop another file to replace it.' : (requireFile ? 'A system prompt file is required to continue.' : 'No file = built-in persona');
      reset.classList.toggle('hidden', !loaded || requireFile); // no "use default" once a file is required
      if (requireFile) {
        applyBtn.disabled = !loaded;
        applyBtn.title = loaded ? '' : 'Drop a system prompt file first';
      }
    };
    refreshDz();

    async function handleFile(file) {
      if (!file) return;
      dzText.textContent = 'Reading…';
      try {
        const r = await fetch('/api/prompt-file', { method: 'POST', body: file });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        draft.prompt = data.text;
        draft.promptFile = `${file.name} (${data.words} words)`;
      } catch (e) {
        toast(e.message || 'Could not read that file.');
      }
      refreshDz();
    }
    dz.addEventListener('click', (e) => { if (e.target !== reset) fileInput.click(); });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
    reset.addEventListener('click', (e) => { e.stopPropagation(); draft.prompt = ''; draft.promptFile = ''; refreshDz(); });

    const list = voices.length ? voices : [{ id: draft.voiceId, label: 'Default voice' }];
    if (!list.some((v) => v.id === draft.voiceId)) list.unshift({ id: draft.voiceId, label: 'Default voice' });
    select.innerHTML = list.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('');
    select.value = draft.voiceId;
    select.addEventListener('change', () => (draft.voiceId = select.value));

    $('.preview-btn', container).addEventListener('click', async () => {
      const line = botId === 'psychic' ? 'Your dreams are speaking to you. Shall we listen?' : 'Let’s look at what the evidence says about dreams.';
      const audio = await fetchAudio(line, draft.voiceId).catch(() => null);
      stopAudio();
      playClip(audio, line, draft.voiceId);
    });
    applyBtn.addEventListener('click', () => { if (!applyBtn.disabled) onApply({ ...draft }); });
    $('.close-btn', container).addEventListener('click', () => onClose && onClose());
  }

  function buildSetupCards() {
    ['psychic', 'neuro'].forEach((botId) => {
      const card = $(`#screen-setup-${botId} .setup-card`);
      mountForm(card, botId, {
        requireFile: true,
        draft: { ...bots[botId] },
        onApply: (d) => {
          Object.assign(bots[botId], d);
          stopAudio();
          if (botId === 'psychic') show('setup-neuro');
          else startIntro();
        },
      });
    });
  }

  // ---------------- navigation ----------------
  $('#screen-opening').addEventListener('click', () => {
    unlockAudio();
    show('setup-psychic');
  });
  $('#screen-setup-psychic .back-btn').addEventListener('click', () => show('opening'));
  $('#screen-setup-neuro .back-btn').addEventListener('click', () => show('setup-psychic'));
  $$('.end-btn').forEach((b) => b.addEventListener('click', endSession));

  function endSession() {
    stopDebate();
    closeModal(true);
    debate.transcript = [];
    buildSetupCards();
    show('opening');
  }

  let introTimer;
  function startIntro() {
    const intro = $('#screen-intro');
    intro.classList.remove('go');
    show('intro');
    requestAnimationFrame(() => requestAnimationFrame(() => intro.classList.add('go')));
    clearTimeout(introTimer);
    introTimer = setTimeout(enterRing, 3400);
    intro.onclick = (e) => { if (!e.target.closest('.end-btn')) enterRing(); };
  }

  function enterRing() {
    clearTimeout(introTimer);
    if (current !== 'intro') return;
    show('ring');
    if (config.mock?.llm) toast('Demo mode: add ANTHROPIC_API_KEY to .env for real debate lines.', 'info');
    else if (config.mock?.tts) toast('No ELEVENLABS_API_KEY in .env, so the browser voice is used for now.', 'info');
    beginWithDreamPrompt();
  }

  // ---------------- audio ----------------
  const audioEl = new Audio();
  let audioDone = null;
  function unlockAudio() {
    // Play a silent clip inside the click so later autoplay is allowed.
    audioEl.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    audioEl.play().catch(() => {});
  }
  function stopAudio() {
    audioEl.pause();
    audioEl.removeAttribute('src');
    window.speechSynthesis?.cancel();
    if (audioDone) { const d = audioDone; audioDone = null; d(); }
  }
  async function fetchAudio(text, voiceId, signal) {
    const r = await fetch('/api/tts', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId }),
    });
    if (r.status === 204) return null; // no ElevenLabs key: browser voice fallback
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Voice generation failed');
    }
    return URL.createObjectURL(await r.blob());
  }
  // Resolves when the clip finishes (or is stopped).
  function playClip(url, text, voiceId) {
    return new Promise((resolve) => {
      audioDone = resolve;
      const finish = () => { if (audioDone === resolve) { audioDone = null; resolve(); } };
      if (url) {
        audioEl.src = url;
        audioEl.onended = finish;
        audioEl.onerror = finish;
        audioEl.play().catch(finish);
      } else if ('speechSynthesis' in window && speechSynthesis.getVoices().length) {
        // Fallback when no ElevenLabs key is set: browser voice, but never shorter than reading time.
        const minDone = sleep(1200 + text.length * 40);
        const u = new SpeechSynthesisUtterance(text);
        const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
        if (vs.length) u.voice = vs[(voiceId || '').charCodeAt(0) % vs.length];
        const done = () => minDone.then(finish);
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      } else {
        setTimeout(finish, 2500 + text.length * 45);
      }
    });
  }

  // ---------------- debate engine ----------------
  function botSettingsFor(speaker) { return { systemPrompt: bots[speaker].prompt, voiceId: bots[speaker].voiceId }; }

  // Get a line of dialogue + its audio for `speaker`, based on a snapshot of the transcript.
  function prepare(speaker, transcriptSnapshot) {
    const controller = new AbortController();
    const { systemPrompt, voiceId } = botSettingsFor(speaker);
    const promise = (async () => {
      const r = await fetch('/api/turn', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botId: speaker, transcript: transcriptSnapshot, systemPrompt }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'The chatbot could not respond');
      let audio = null;
      try { audio = await fetchAudio(data.text, voiceId, controller.signal); }
      catch (e) { if (e.name === 'AbortError') throw e; toast(`Voice: ${e.message}`); }
      return { text: data.text, audio, voiceId };
    })();
    promise.catch(() => {}); // handled by whoever awaits it
    return { gen: debate.gen, speaker, version: debate.settingsVersion, promise, controller };
  }

  function dropPrefetch() {
    if (debate.prefetch) debate.prefetch.controller.abort();
    debate.prefetch = null;
  }

  const waitUntil = (cond) => new Promise((res) => {
    const tick = () => (cond() ? res() : setTimeout(tick, 120));
    tick();
  });

  function resetDebateState() {
    debate.running = false;
    debate.gen++;
    debate.transcript = [];
    debate.next = 'psychic';
    debate.autoTurns = 0;
    debate.userPaused = false;
    debate.paused = false;
    debate.muted = { psychic: false, neuro: false };
    setPauseUI();
    setBotPauseUI();
    dropPrefetch();
  }

  // Starts (or restarts) the debate with the bots' usual opening statements — no shared dream.
  function startDebate() {
    resetDebateState();
    debate.running = true;
    runLoop();
  }

  // Opens the ring by asking the audience to share a dream first; the bots then react to it
  // and the debate grows out of that. "Skip" falls back to the normal opening statements.
  function beginWithDreamPrompt() {
    resetDebateState();
    showBubble('user', 'Before we begin…',
      "Share a dream you've had — the Psychic Interpreter and NeuroScientist will each respond to it, then debate it out. Type below or tap the mic.",
      { label: 'Skip — start the debate', onClick: () => { hideBubble(); startDebate(); } });
  }

  function stopDebate() {
    debate.running = false;
    debate.gen++;
    dropPrefetch();
    stopAudio();
    stopListening(true);
    setFighter(null);
    hideBubble();
  }

  async function runLoop() {
    const gen = debate.gen;
    const alive = () => debate.running && gen === debate.gen;

    while (alive()) {
      await waitUntil(() => (!debate.paused && !bothMuted()) || !alive());
      if (!alive()) return;

      // If it's a muted bot's turn, hand the turn straight to their opponent instead.
      if (debate.muted[debate.next] && !debate.muted[OTHER[debate.next]]) {
        dropPrefetch();
        debate.next = OTHER[debate.next];
      }

      if (debate.autoTurns >= config.maxAutoTurns) {
        showBubble('user', 'Round over', 'The debaters are catching their breath. Jump in with a question, or…', true);
        return;
      }

      const speaker = debate.next;
      let job = debate.prefetch;
      if (!job || job.gen !== gen || job.speaker !== speaker || job.version !== debate.settingsVersion) {
        dropPrefetch();
        job = prepare(speaker, debate.transcript.slice());
      }
      debate.prefetch = null;

      setFighter(speaker, 'thinking');
      showThinking(speaker);
      let line;
      try {
        line = await job.promise;
      } catch (e) {
        if (!alive() || e.name === 'AbortError') return;
        setFighter(null);
        showBubble('user', 'Connection problem', e.message, true);
        return;
      }
      if (!alive()) return;

      const entry = { speaker, text: line.text };
      debate.transcript.push(entry);
      debate.next = OTHER[speaker];
      debate.autoTurns++;

      // Start preparing the opponent's reply while this one is being spoken.
      if (debate.autoTurns < config.maxAutoTurns) debate.prefetch = prepare(debate.next, debate.transcript.slice());

      await waitUntil(() => (!debate.paused && !bothMuted()) || !alive());
      if (!alive()) return;
      debate.speaking = { speaker, entry };
      setFighter(speaker, 'speaking');
      showBubble(speaker, NAMES[speaker], line.text);
      await playClip(line.audio, line.text, line.voiceId);
      debate.speaking = null;
      if (!alive()) return;
      setFighter(null);
      await sleep(350);
    }
  }

  // The audience butts in.
  function interject(text) {
    text = text.trim();
    if (!text || current !== 'ring') return;
    debate.gen++; // cancel whatever was in progress
    dropPrefetch();
    if (debate.speaking) debate.speaking.entry.interrupted = true;
    const wasSpeaking = debate.speaking?.speaker;
    stopAudio();
    debate.speaking = null;

    debate.transcript.push({ speaker: 'user', text });
    const t = text.toLowerCase();
    const wantsPsychic = /psychic|interpreter|madame|medium/.test(t);
    const wantsNeuro = /neuro|scientist|science|doctor|dr\.?\s/.test(t);
    if (wantsPsychic && !wantsNeuro) debate.next = 'psychic';
    else if (wantsNeuro && !wantsPsychic) debate.next = 'neuro';
    else if (wasSpeaking) debate.next = wasSpeaking; // the one you cut off answers you
    // otherwise keep whoever was up next

    debate.autoTurns = 0;
    debate.running = true;
    debate.userPaused = false; // answering a message means the debate should proceed
    updatePauseState();
    setFighter(null);
    showBubble('user', 'You', text);
    setTimeout(() => runLoop(), 900);
  }

  // ---------------- ring UI ----------------
  function setFighter(botId, mode) {
    $$('.fighter').forEach((f) => {
      f.classList.toggle('speaking', f.dataset.bot === botId && mode === 'speaking');
      f.classList.toggle('thinking', f.dataset.bot === botId && mode === 'thinking');
    });
  }
  const bubble = $('#bubble');
  // `action`: false (no button), true (the classic "Let them keep going" round-over button),
  // or { label, onClick } for a custom action button (e.g. the dream-prompt's Skip button).
  function showBubble(kind, name, text, action = false) {
    bubble.className = `bubble ${kind}`;
    $('.bubble-name', bubble).textContent = name;
    const body = $('.bubble-text', bubble);
    body.textContent = text;
    body.scrollTop = 0;
    $('.continue-btn', bubble)?.remove();
    const spec = action === true
      ? { label: 'Let them keep going', onClick: () => { debate.autoTurns = 0; debate.gen++; debate.running = true; hideBubble(); runLoop(); } }
      : (action && typeof action === 'object' ? action : null);
    if (spec) {
      const b = document.createElement('button');
      b.className = 'continue-btn';
      b.textContent = spec.label;
      b.onclick = spec.onClick;
      bubble.append(b);
    }
    // restart the pop animation
    bubble.style.animation = 'none'; void bubble.offsetWidth; bubble.style.animation = '';
  }
  function showThinking(speaker) {
    showBubble(speaker, NAMES[speaker], '');
    $('.bubble-text', bubble).innerHTML = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
  }
  function hideBubble() { bubble.className = 'bubble hidden'; }

  // ---------------- pause / resume ----------------
  const pauseBtn = $('#pause-btn');
  function setPauseUI() {
    pauseBtn.classList.toggle('active', debate.userPaused);
    pauseBtn.title = debate.userPaused ? 'Resume debate' : 'Pause debate';
  }
  pauseBtn.addEventListener('click', () => {
    debate.userPaused = !debate.userPaused;
    updatePauseState();
    setPauseUI();
    if (debate.userPaused) {
      // Pausing holds the loop before the next turn, and freezes whoever's mid-sentence right now.
      if (debate.speaking) { audioEl.pause(); window.speechSynthesis?.pause(); }
    } else if (debate.speaking) {
      if (audioEl.src && audioEl.paused) audioEl.play().catch(() => {});
      window.speechSynthesis?.resume();
    }
  });

  // text input
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    interject(input.value);
    input.value = '';
  });

  // ---------------- microphone (Web Speech API) ----------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let heard = '';
  const micBtn = $('#mic-btn');
  micBtn.addEventListener('click', () => (rec ? stopListening(false) : startListening()));

  function startListening() {
    if (!SR) return toast('Voice input needs Chrome or Edge. You can still type!');
    heard = '';
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    updatePauseState(); // rec is set, so this holds the next turn while you talk
    audioEl.pause();
    window.speechSynthesis?.pause();
    micBtn.classList.add('listening');
    $('#chat-input').placeholder = 'Listening…';
    rec.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join(' ');
      $('#chat-input').value = heard;
    };
    rec.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone permission was blocked.'); };
    rec.onend = () => {
      const text = heard.trim();
      finishListening();
      if (text) { $('#chat-input').value = ''; interject(text); }
      else resumeAfterMic();
    };
    rec.start();
  }
  function stopListening(cancel) {
    if (!rec) return;
    if (cancel) { heard = ''; rec.onresult = null; }
    rec.stop();
  }
  function finishListening() {
    rec = null;
    micBtn.classList.remove('listening');
    $('#chat-input').placeholder = 'Type Here';
  }
  function resumeAfterMic() {
    updatePauseState();
    if (!debate.paused) {
      if (audioEl.src && audioEl.paused && debate.speaking) audioEl.play().catch(() => {});
      window.speechSynthesis?.resume();
    }
  }

  // ---------------- per-bot pause ----------------
  function setBotPauseUI() {
    $$('.fighter').forEach((f) => {
      const on = debate.muted[f.dataset.bot];
      $('.bot-pause-btn', f)?.classList.toggle('active', on);
      $('.bot-pause-btn', f)?.setAttribute('title', on ? `Resume ${NAMES[f.dataset.bot]}` : `Pause ${NAMES[f.dataset.bot]}`);
    });
  }
  $$('.fighter .bot-pause-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const botId = b.closest('.fighter').dataset.bot;
      debate.muted[botId] = !debate.muted[botId];
      setBotPauseUI();
      // If this bot is the one mid-sentence right now, freeze/resume their audio immediately.
      if (debate.speaking?.speaker === botId) {
        if (debate.muted[botId]) { audioEl.pause(); window.speechSynthesis?.pause(); }
        else {
          if (audioEl.src && audioEl.paused) audioEl.play().catch(() => {});
          window.speechSynthesis?.resume();
        }
      }
      toast(`${NAMES[botId]} ${debate.muted[botId] ? 'paused — ' + NAMES[OTHER[botId]] + ' will keep going solo.' : 'resumed.'}`, 'info', 2500);
    })
  );

  // ---------------- settings popup (gear icons) ----------------
  let modalBot = null;
  $$('.fighter .gear').forEach((g) =>
    g.addEventListener('click', () => openModal(g.closest('.fighter').dataset.bot))
  );
  function openModal(botId) {
    modalBot = botId;
    updatePauseState(); // finish the current sentence, then wait
    const modal = $('#modal');
    modal.className = `card ${botId === 'psychic' ? 'teal' : 'purple'}`; // colors match the mockups
    mountForm(modal, botId, {
      draft: { ...bots[botId] },
      onApply: (d) => {
        Object.assign(bots[botId], d);
        debate.settingsVersion++;
        toast(`${NAMES[botId]} updated. Changes apply from their next turn.`, 'info', 2500);
        closeModal();
      },
      onClose: () => closeModal(),
    });
    $('#modal-backdrop').classList.remove('hidden');
  }
  function closeModal(silent) {
    modalBot = null;
    $('#modal-backdrop').classList.add('hidden');
    if (!silent) updatePauseState();
  }
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalBot) closeModal(); });

  // ---------------- utils ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  boot();
})();
