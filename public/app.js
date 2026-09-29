/* Dream Debate: front end (multi-topic) */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const OTHER = { a: 'b', b: 'a' };
  let NAMES = { a: 'Bot A', b: 'Bot B', user: 'You' };

  // ---------------- state ----------------
  const bots = {
    a: { prompt: '', promptFile: '', voiceId: '', knowledgeNotes: [], speed: 1, pitch: 1 },
    b: { prompt: '', promptFile: '', voiceId: '', knowledgeNotes: [], speed: 1, pitch: 1 },
  };
  // The global system prompt is intentionally kept separate from `bots.a`/`bots.b` — it's one
  // shared value injected into both bots' requests, never merged into either bot's own prompt.
  let globalSettings = { prompt: '' };
  let config = { topics: [], maxAutoTurns: 16, mock: {} };
  let voices = [];
  let currentTopic = null;

  const CHECK_IN_EVERY = 2; // pause and invite the user back in after this many auto-turns (one exchange each)

  const debate = {
    running: false,
    gen: 0, // bumps whenever the flow is interrupted; stale async work checks this and bails
    transcript: [],
    next: 'a',
    autoTurns: 0,
    turnsSinceUser: 0, // resets whenever the user speaks; triggers a check-in pause at CHECK_IN_EVERY
    prefetch: null, // { gen, speaker, version, promise, controller }
    settingsVersion: 0,
    paused: false,
    muted: { a: false, b: false }, // a muted bot's turns are skipped; the other one keeps going solo
    speaking: null, // { speaker, entry }
  };

  // debate.paused is on if a settings popup is open or the mic is listening.
  function updatePauseState() {
    debate.paused = !!settingsOpen || !!rec;
  }
  const bothMuted = () => debate.muted.a && debate.muted.b;

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
      voices = (await (await fetch('/api/voices')).json()).voices || [];
    } catch {
      toast('Could not reach the server. Is `npm start` running?');
    }
    buildTopicList();
  }

  // ---------------- topic picker ----------------
  function buildTopicList() {
    const list = $('.topic-list');
    list.innerHTML = '';
    (config.topics || []).forEach((topic) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'topic-card';
      card.innerHTML = `<div class="t-title glow">${escapeHtml(topic.title)}</div><p class="t-sub">${escapeHtml(topic.bots.a.name)} vs. ${escapeHtml(topic.bots.b.name)}</p>`;
      card.addEventListener('click', () => selectTopic(topic.id));
      list.append(card);
    });
  }

  function selectTopic(topicId) {
    currentTopic = (config.topics || []).find((t) => t.id === topicId);
    if (!currentTopic) return;
    NAMES = { a: currentTopic.bots.a.name, b: currentTopic.bots.b.name, user: 'You' };
    bots.a = { prompt: '', promptFile: '', voiceId: currentTopic.bots.a.defaultVoiceId, knowledgeNotes: [], speed: 1, pitch: 1 };
    bots.b = { prompt: '', promptFile: '', voiceId: currentTopic.bots.b.defaultVoiceId, knowledgeNotes: [], speed: 1, pitch: 1 };
    globalSettings = { prompt: currentTopic.globalPrompt || '' };
    applyTopicChrome();
    buildSetupCards();
    show('setup-a');
  }

  // Pushes the current topic's names/labels into every screen that shows them.
  function applyTopicChrome() {
    if (!currentTopic) return;
    $('#screen-setup-a .head-label').textContent = currentTopic.bots.a.name;
    $('#screen-setup-b .head-label').textContent = currentTopic.bots.b.name;

    $$('.topic strong').forEach((el) => (el.textContent = currentTopic.title));

    const introLeft = $('#screen-intro .intro-bot.left .head-label');
    const introRight = $('#screen-intro .intro-bot.right .head-label');
    if (introLeft) introLeft.textContent = currentTopic.bots.a.name;
    if (introRight) introRight.textContent = currentTopic.bots.b.name;

    $$('.fighter').forEach((f) => {
      const slot = f.dataset.bot;
      const name = currentTopic.bots[slot].name;
      $('.fighter-label', f).textContent = name;
      const pauseBtn = $('.bot-pause-btn', f);
      pauseBtn.setAttribute('aria-label', `Pause ${name}`);
      pauseBtn.title = `Pause ${name}`;
    });
    renderCharacters();
  }

  // ---------------- characters (illustrated bots with blinking/breathing/expressions) ----------------
  // Coordinates are % of the source image's own width/height, measured from the artwork so the
  // overlaid eyes/mouth line up with it at any render size. Topics without an entry here (e.g.
  // Interpreting Dreams) fall back to the generic silhouette symbol.
  const CHAR_ASSETS = {
    relationship: {
      a: { // Relationship Advisor
        img: 'assets/advisor_base.png',
        skin: '#a284e3',
        eyeL: { x: 33.9, y: 25.6, w: 20.1, h: 16.0 },
        eyeR: { x: 65.4, y: 25.6, w: 20.1, h: 16.0 },
        mouth: {
          x: 51.2, y: 43.8, w: 26.1, h: 9.0, viewBox: '0 0 74 32',
          smile: '<path class="m-smile" d="M6,6 Q37,26 68,6" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round"/>',
          talk: '<ellipse class="m-talk" cx="37" cy="16" rx="15" ry="9" fill="#2a0f4e"/>',
          think: '<path class="m-think" d="M14,16 L60,16" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round"/>',
        },
      },
      b: { // Girl Best Friend
        img: 'assets/bestie_base.png',
        skin: '#ebaae9',
        eyeL: { x: 22, y: 25.1, w: 23.5, h: 13.2 },
        eyeR: { x: 65.5, y: 25.1, w: 23.5, h: 13.2 },
        mouth: {
          x: 43.75, y: 40, w: 39.5, h: 14.6, viewBox: '0 0 79 52',
          smile: '<path class="m-smile" d="M8,26 C8,14 22,10 39,20 C56,10 71,14 71,26 C71,40 55,48 39,44 C23,48 8,40 8,26 Z" fill="#c04e4e" stroke="#000" stroke-width="2.5"/>',
          talk: '<ellipse class="m-talk" cx="39" cy="28" rx="17" ry="9" fill="#5c1414"/>',
          think: '<path class="m-think" d="M22,28 L56,28" fill="none" stroke="#c04e4e" stroke-width="5" stroke-linecap="round"/>',
        },
      },
    },
  };

  function charAssetFor(slot) {
    return CHAR_ASSETS[currentTopic?.id]?.[slot] || null;
  }

  function characterHTML(slot) {
    const asset = charAssetFor(slot);
    if (!asset) return `<svg class="head ${slot}"><use href="#head" /></svg>`;
    const eyeStyle = (e, delay) =>
      `left:${e.x}%;top:${e.y}%;width:${e.w}%;height:${e.h}%;background:${asset.skin};--d:${delay}s`;
    const m = asset.mouth;
    return `<div class="char-breathe">
      <img class="char-img" src="${asset.img}" alt="" draggable="false">
      <div class="char-eye" style="${eyeStyle(asset.eyeL, (Math.random() * 3).toFixed(2))}"></div>
      <div class="char-eye" style="${eyeStyle(asset.eyeR, (Math.random() * 3).toFixed(2))}"></div>
      <svg class="char-mouth" style="left:${m.x}%;top:${m.y}%;width:${m.w}%;height:${m.h}%" viewBox="${m.viewBox}">${m.smile}${m.talk}${m.think}</svg>
    </div>`;
  }

  function renderCharacters() {
    $$('.char-mount').forEach((mount) => {
      const slot = mount.dataset.bot;
      const person = !!charAssetFor(slot);
      mount.classList.toggle('person', person);
      mount.classList.toggle('silhouette', !person);
      mount.innerHTML = characterHTML(slot);
      mount.closest('.fighter')?.classList.toggle('person-bot', person); // moves the gear onto a hand for illustrated characters
    });
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
    const notesBlock = $('.knowledge-block', container);
    const requireNotes = !!currentTopic?.bots?.[botId]?.requiresKnowledgeNotes;
    if (!Array.isArray(draft.knowledgeNotes)) draft.knowledgeNotes = [];

    function updateApplyState() {
      const fileOk = !requireFile || !!draft.prompt;
      const notesOk = !requireNotes || draft.knowledgeNotes.length === 2;
      applyBtn.disabled = !(fileOk && notesOk);
      applyBtn.title = fileOk ? (notesOk ? '' : 'Drop exactly 2 knowledge note files onto the bot first') : 'Drop a system prompt file first';
    }

    const refreshDz = () => {
      const loaded = !!draft.prompt;
      dz.classList.toggle('loaded', loaded);
      dzText.textContent = loaded ? draft.promptFile : (requireFile ? 'Drop PDF here (required)' : 'Drop PDF here');
      dz.title = loaded ? 'Custom system prompt loaded. Drop another file to replace it.' : (requireFile ? 'A system prompt file is required to continue.' : 'No file = built-in persona');
      reset.classList.toggle('hidden', !loaded || requireFile); // no "use default" once a file is required
      updateApplyState();
    };
    refreshDz();

    if (requireNotes) {
      notesBlock.classList.remove('hidden');
      setupKnowledgeUploads(notesBlock, draft, updateApplyState);
    }
    updateApplyState();

    // Editable system-prompt textarea (used by the compact Chatbot Settings panel; the dropzone
    // above is used unchanged by the setup screens). Pre-filled with the bot's built-in default
    // persona when no custom prompt has been set yet, and stays fully editable/droppable.
    const promptTA = $('.prompt-textarea', container);
    const promptFileBtn = $('.prompt-upload-btn', container);
    const promptFileInput = $('.prompt-file-input', container);
    const promptFileName = $('.prompt-file-name', container);
    const defaultPersona = currentTopic?.bots?.[botId]?.defaultPrompt || '';
    function refreshPromptEdit() {
      if (document.activeElement !== promptTA) promptTA.value = draft.prompt || defaultPersona;
      promptFileName.textContent = draft.promptFile || '';
    }
    refreshPromptEdit();
    promptTA.addEventListener('input', () => {
      draft.prompt = promptTA.value;
      draft.promptFile = '';
      promptFileName.textContent = '';
      refreshDz();
      updateApplyState();
    });
    promptFileBtn.addEventListener('click', () => promptFileInput.click());
    promptFileInput.addEventListener('change', () => { handleFile(promptFileInput.files[0]); promptFileInput.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => promptTA.addEventListener(ev, (e) => { e.preventDefault(); promptTA.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => promptTA.addEventListener(ev, (e) => { e.preventDefault(); promptTA.classList.remove('drag'); }));
    promptTA.addEventListener('drop', (e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); });

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
      refreshPromptEdit();
    }
    dz.addEventListener('click', (e) => { if (e.target !== reset) fileInput.click(); });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
    reset.addEventListener('click', (e) => { e.stopPropagation(); draft.prompt = ''; draft.promptFile = ''; refreshDz(); refreshPromptEdit(); });

    // Voice Speed / Voice Pitch: independent per bot, carried in the same draft/Apply flow as
    // everything else. Speed is honored for real (forwarded to ElevenLabs); pitch has no ElevenLabs
    // equivalent, so it's wired honestly to the browser-voice fallback only (see playClip).
    const speedSlider = $('.speed-slider', container);
    const pitchSlider = $('.pitch-slider', container);
    const speedVal = $('.speed-val', container);
    const pitchVal = $('.pitch-val', container);
    if (draft.speed == null) draft.speed = 1;
    if (draft.pitch == null) draft.pitch = 1;
    speedSlider.value = draft.speed;
    pitchSlider.value = draft.pitch;
    speedVal.textContent = `${draft.speed.toFixed(2)}×`;
    pitchVal.textContent = `${draft.pitch.toFixed(1)}×`;
    speedSlider.addEventListener('input', () => {
      draft.speed = parseFloat(speedSlider.value);
      speedVal.textContent = `${draft.speed.toFixed(2)}×`;
    });
    pitchSlider.addEventListener('input', () => {
      draft.pitch = parseFloat(pitchSlider.value);
      pitchVal.textContent = `${draft.pitch.toFixed(1)}×`;
    });

    const list = voices.length ? voices : [{ id: draft.voiceId, label: 'Default voice' }];
    if (!list.some((v) => v.id === draft.voiceId)) list.unshift({ id: draft.voiceId, label: 'Default voice' });
    select.innerHTML = list.map((v) => `<option value="${v.id}">${escapeHtml(v.label)}</option>`).join('');
    select.value = draft.voiceId;
    select.addEventListener('change', () => (draft.voiceId = select.value));

    $('.preview-btn', container).addEventListener('click', async () => {
      const line = `Hi, I'm the ${NAMES[botId]}. Let's get into it.`;
      const audio = await fetchAudio(line, draft.voiceId, draft.speed).catch(() => null);
      stopAudio();
      playClip(audio, line, draft.voiceId, draft.speed, draft.pitch);
    });
    applyBtn.addEventListener('click', () => { if (!applyBtn.disabled) onApply({ ...draft }); });
    $('.close-btn', container).addEventListener('click', () => onClose && onClose());
  }

  // Real-file knowledge notes: the user drags (or clicks to browse for) up to 2 actual PDF/text
  // files onto the drop zone. Each file is read server-side (same /api/prompt-file endpoint the
  // System Prompt box uses) and the extracted text is appended to that bot's system prompt —
  // nothing here is pre-loaded or baked into the app.
  function setupKnowledgeUploads(block, draft, onChange) {
    const drop = $('.kn-drop', block);
    const dropText = $('.kn-drop-text', drop);
    const fileInput = $('input[type=file]', drop);
    const filesEl = $('.kn-files', block);
    const countEl = $('.kn-count', block);

    function render() {
      filesEl.innerHTML = '';
      draft.knowledgeNotes.forEach((note, i) => {
        const chip = document.createElement('div');
        chip.className = 'kn-selected-chip' + (note.pending ? ' pending' : '');
        const label = document.createElement('span');
        label.textContent = note.pending ? `Reading ${note.name}…` : `${note.name} (${note.words} words)`;
        chip.append(label);
        if (!note.pending) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.className = 'kn-remove';
          rm.textContent = '×';
          rm.addEventListener('click', () => { draft.knowledgeNotes.splice(i, 1); render(); });
          chip.append(rm);
        }
        filesEl.append(chip);
      });
      const doneCount = draft.knowledgeNotes.filter((n) => !n.pending).length;
      countEl.textContent = `(${doneCount}/2)`;
      dropText.textContent = draft.knowledgeNotes.length
        ? 'Drop another file to replace, or click to browse'
        : 'Drop up to 2 files here, or click to browse';
      onChange();
    }

    async function addFile(file) {
      if (!file) return;
      if (draft.knowledgeNotes.filter((n) => !n.pending).length >= 2) {
        toast('Only 2 knowledge note files allowed — remove one first.', 'info', 2500);
        return;
      }
      const entry = { name: file.name, text: '', words: 0, pending: true };
      draft.knowledgeNotes.push(entry);
      render();
      try {
        const r = await fetch('/api/prompt-file', { method: 'POST', body: file });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        entry.text = data.text;
        entry.words = data.words;
        entry.pending = false;
      } catch (e) {
        draft.knowledgeNotes.splice(draft.knowledgeNotes.indexOf(entry), 1);
        toast(e.message || `Could not read ${file.name}.`);
      }
      render();
    }
    function addFiles(fileList) {
      const remaining = 2 - draft.knowledgeNotes.filter((n) => !n.pending).length;
      const files = [...fileList];
      if (remaining <= 0) { toast('Only 2 knowledge note files allowed — remove one first.', 'info', 2500); return; }
      if (files.length > remaining) toast(`Only room for ${remaining} more file${remaining === 1 ? '' : 's'} — using the first ${remaining}.`, 'info', 2500);
      files.slice(0, remaining).forEach(addFile);
    }

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag-over'); }));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    render();
  }

  function buildSetupCards() {
    ['a', 'b'].forEach((botId) => {
      const card = $(`#screen-setup-${botId} .setup-card`);
      mountForm(card, botId, {
        requireFile: true,
        draft: { ...bots[botId], knowledgeNotes: bots[botId].knowledgeNotes.map((n) => ({ ...n })) },
        onApply: (d) => {
          Object.assign(bots[botId], d);
          stopAudio();
          if (botId === 'a') show('setup-b');
          else startIntro();
        },
      });
    });
  }

  // ---------------- navigation ----------------
  $('#screen-opening').addEventListener('click', () => {
    unlockAudio();
    show('topic-select');
  });
  $('#screen-setup-a .back-btn').addEventListener('click', () => show('topic-select'));
  $('#screen-setup-b .back-btn').addEventListener('click', () => show('setup-a'));
  $$('.end-btn').forEach((b) => b.addEventListener('click', endSession));

  function endSession() {
    stopDebate();
    closeModal(true);
    debate.transcript = [];
    show('topic-select');
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
    beginWithSharePrompt();
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
  async function fetchAudio(text, voiceId, speed, signal) {
    const r = await fetch('/api/tts', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId, speed }),
    });
    if (r.status === 204) return null; // no ElevenLabs key: browser voice fallback
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Voice generation failed');
    }
    return URL.createObjectURL(await r.blob());
  }
  // Resolves when the clip finishes (or is stopped). `speed`/`pitch` only affect the browser-voice
  // fallback (url is null) — real ElevenLabs audio already has speed baked in server-side, and
  // ElevenLabs has no pitch parameter at all, so pitch is never applied to it.
  function playClip(url, text, voiceId, speed = 1, pitch = 1) {
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
        u.rate = speed;
        u.pitch = pitch;
        const done = () => minDone.then(finish);
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      } else {
        setTimeout(finish, 2500 + text.length * 45);
      }
    });
  }

  // ---------------- debate engine ----------------
  function botSettingsFor(speaker) {
    return { systemPrompt: bots[speaker].prompt, voiceId: bots[speaker].voiceId, speed: bots[speaker].speed, pitch: bots[speaker].pitch };
  }

  // Get a line of dialogue + its audio for `speaker`, based on a snapshot of the transcript.
  function prepare(speaker, transcriptSnapshot) {
    const controller = new AbortController();
    const { systemPrompt, voiceId, speed, pitch } = botSettingsFor(speaker);
    const topicId = currentTopic.id;
    const promise = (async () => {
      const r = await fetch('/api/turn', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topicId, slot: speaker, transcript: transcriptSnapshot, systemPrompt,
          globalPrompt: globalSettings.prompt, // same value injected into both bots' requests
          knowledgeNotes: (bots[speaker].knowledgeNotes || [])
            .filter((n) => !n.pending)
            .map((n) => ({ label: n.name, text: n.text })),
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'The chatbot could not respond');
      let audio = null;
      try { audio = await fetchAudio(data.text, voiceId, speed, controller.signal); }
      catch (e) { if (e.name === 'AbortError') throw e; toast(`Voice: ${e.message}`); }
      return { text: data.text, audio, voiceId, speed, pitch };
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
    debate.next = 'a';
    debate.autoTurns = 0;
    debate.turnsSinceUser = 0;
    debate.paused = false;
    debate.muted = { a: false, b: false };
    setBotPauseUI();
    setSkipVisible(false);
    dropPrefetch();
  }

  // Starts (or restarts) the debate with the bots' usual opening statements — no shared prompt.
  function startDebate() {
    resetDebateState();
    debate.running = true;
    runLoop();
  }

  // Opens the ring by asking the audience to share something first; the bots then react to it
  // and the debate grows out of that. "Skip" falls back to the normal opening statements.
  function beginWithSharePrompt() {
    resetDebateState();
    showBubble('user', 'Before we begin…', currentTopic.openPrompt,
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

      // Pause after a short exchange so this stays a conversation with the user, not the bots running solo.
      if (debate.turnsSinceUser >= CHECK_IN_EVERY) {
        showBubble('user', 'Your turn', `What do you think — does that sound right to you? Ask a question, share more about your ${currentTopic.shareNoun}, or let them keep going.`, true);
        return;
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
      debate.turnsSinceUser++;
      const aboutToCheckIn = debate.turnsSinceUser >= CHECK_IN_EVERY;

      // Start preparing the opponent's reply while this one is being spoken (skip if we're about to pause for the user).
      if (debate.autoTurns < config.maxAutoTurns && !aboutToCheckIn) debate.prefetch = prepare(debate.next, debate.transcript.slice());

      await waitUntil(() => (!debate.paused && !bothMuted()) || !alive());
      if (!alive()) return;
      debate.speaking = { speaker, entry };
      setFighter(speaker, 'speaking');
      showBubble(speaker, NAMES[speaker], line.text);
      setSkipVisible(true);
      await playClip(line.audio, line.text, line.voiceId, line.speed, line.pitch);
      debate.speaking = null;
      setSkipVisible(false);
      if (!alive()) return;
      setFighter(null);
      await sleep(350);
    }
  }

  // Does the audience member's text call out one of the bots by name or alias?
  function wantsSlot(t, slot) {
    const bot = currentTopic.bots[slot];
    if ((bot.aliases || []).some((a) => t.includes(a))) return true;
    const nameWords = bot.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return nameWords.some((w) => t.includes(w));
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
    setSkipVisible(false);

    debate.transcript.push({ speaker: 'user', text });
    const t = text.toLowerCase();
    const wantsA = wantsSlot(t, 'a');
    const wantsB = wantsSlot(t, 'b');
    if (wantsA && !wantsB) debate.next = 'a';
    else if (wantsB && !wantsA) debate.next = 'b';
    else if (wasSpeaking) debate.next = wasSpeaking; // the one you cut off answers you
    // otherwise keep whoever was up next

    debate.autoTurns = 0;
    debate.turnsSinceUser = 0; // the user just spoke, so the check-in clock restarts
    debate.running = true;
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
  // or { label, onClick } for a custom action button (e.g. the opening prompt's Skip button).
  function showBubble(kind, name, text, action = false) {
    bubble.className = `bubble ${kind}`;
    $('.bubble-name', bubble).textContent = name;
    const body = $('.bubble-text', bubble);
    body.textContent = text;
    body.scrollTop = 0;
    $('.continue-btn', bubble)?.remove();
    const spec = action === true
      ? { label: 'Let them keep going', onClick: () => { debate.autoTurns = 0; debate.turnsSinceUser = 0; debate.gen++; debate.running = true; hideBubble(); runLoop(); } }
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
  function hideBubble() { bubble.className = 'bubble hidden'; setSkipVisible(false); }

  // ---------------- skip current line ----------------
  const skipBtn = $('#skip-line-btn');
  function setSkipVisible(v) { skipBtn.classList.toggle('hidden', !v); }
  skipBtn.addEventListener('click', () => { if (debate.speaking) stopAudio(); });

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

  // ---------------- ESP32 talking LED (Web Serial) ----------------
  // One LED on the Feather's GPIO 27 lights while either bot is speaking. Protocol (firmware/talking_led):
  // the board prints READY:<id> on boot, answers ID? with ID:<id>, and takes LED:<0-255> with no reply.
  const esp32 = (() => {
    const btn = $('#esp32-btn');
    const label = $('.esp32-label', btn);
    // USB-UART bridge chips. The Feather V2 uses a WCH CH9102 (vendor 0x1A86); the rest cover common alternatives.
    const FILTERS = [0x1a86, 0x10c4, 0x0403, 0x303a, 0x239a].map((usbVendorId) => ({ usbVendorId }));
    const enc = new TextEncoder();
    let port = null, reader = null, writer = null, boardId = '', lit = null;

    function render() {
      btn.classList.toggle('connected', !!port);
      label.textContent = port ? `ESP32: ${boardId || 'connecting…'}` : 'Connect ESP32';
      btn.title = port ? 'Disconnect the ESP32' : 'Connect the ESP32 talking LED over USB';
    }

    function send(line) {
      if (!writer) return;
      writer.write(enc.encode(line + '\n')).catch(() => lost());
    }

    async function readLoop() {
      const dec = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const m = buf.slice(0, i).trim().match(/^(?:READY|ID):(\S+)$/);
            buf = buf.slice(i + 1);
            if (m) { boardId = m[1]; render(); }
          }
          if (buf.length > 256) buf = ''; // boot noise with no newline
        }
      } catch { /* port closed or unplugged */ }
    }

    async function connect() {
      if (!('serial' in navigator)) return toast('The ESP32 connection needs Chrome or Edge (Web Serial).');
      toast('Pick "USB Single Serial" (the ESP32). Ignore any Bluetooth ports.', 'info', 6000);
      let p;
      try { p = await navigator.serial.requestPort({ filters: FILTERS }); }
      catch { return; } // picker cancelled, or no matching device
      try { await p.open({ baudRate: 115200 }); }
      catch {
        return toast('Couldn\'t open the ESP32 port. Something else is holding it: another tab of this app, the Arduino Serial Monitor, or arduino-cli. Close that and try again.', 'error', 9000);
      }
      port = p; boardId = ''; lit = null;
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      readLoop();
      render();
      // Opening the port resets the board; let it boot, then ask who it is.
      await sleep(1500);
      if (port !== p) return;
      send('ID?');
      setSpeaking(!!debate.speaking);
      await sleep(1500);
      if (port === p && !boardId) toast('Connected, but the board didn\'t answer. The talking-LED firmware may not be on it.', 'error', 7000);
    }

    async function disconnect() {
      const p = port;
      if (!p) return;
      if (writer) { try { await writer.write(enc.encode('LED:0\n')); } catch {} }
      port = null;
      try { await reader?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      try { writer?.releaseLock(); } catch {}
      reader = writer = null;
      try { await p.close(); } catch {}
      render();
    }

    function lost() {
      if (!port) return;
      disconnect();
      toast('ESP32 disconnected. Reseat the USB-C cable, then click Connect ESP32 again.');
    }

    function setSpeaking(on) {
      if (!port || on === lit) return;
      lit = on;
      send(on ? 'LED:255' : 'LED:0');
    }

    btn.addEventListener('click', () => (port ? disconnect() : connect()));
    if ('serial' in navigator) navigator.serial.addEventListener('disconnect', (e) => { if (e.target === port) lost(); });
    addEventListener('pagehide', () => send('LED:0'));
    render();
    return { setSpeaking };
  })();

  // Mirror debate.speaking to the LED without touching the debate loop: every assignment passes through here.
  let speakingNow = null;
  Object.defineProperty(debate, 'speaking', {
    get: () => speakingNow,
    set: (v) => { speakingNow = v; esp32.setSpeaking(!!v); },
  });

  // ---------------- settings popup (one global button, both bots in an accordion) ----------------
  let settingsOpen = false;
  $('#chatbot-settings-btn')?.addEventListener('click', () => openModal());

  // Colors match the mockups (same mapping the old per-bot modal used).
  const MODAL_COLOR = { a: 'teal', b: 'purple' };

  // Global Instructions section: a lone editable textarea, deliberately much simpler than
  // mountForm (no voice/knowledge-notes) since it's just one shared value. Kept visually distinct
  // (see .accordion-item.global in styles.css) so it doesn't read as a third chatbot.
  function mountGlobalForm(container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="card-title">Global Instructions</div>
      <p class="global-hint">Applies to both chatbots</p>
      <textarea class="global-textarea" rows="5" spellcheck="false"></textarea>
      <div class="btn-row">
        <button type="button" class="apply-btn global-apply-btn">Apply Changes</button>
      </div>
    `;
    container.append(...wrap.childNodes);
    $('.global-textarea', container).value = globalSettings.prompt;
    $('.global-apply-btn', container).addEventListener('click', () => {
      globalSettings.prompt = $('.global-textarea', container).value;
      debate.settingsVersion++;
      toast('Global Instructions updated. Changes apply from the next turn.', 'info', 2500);
    });
  }

  function openModal() {
    settingsOpen = true;
    updatePauseState(); // finish the current sentence, then wait
    const modal = $('#modal');
    modal.querySelectorAll('.accordion-item').forEach((item, i) => {
      const openCls = i === 0 ? ' open' : '';
      if (item.dataset.section === 'global') {
        item.className = `accordion-item global${openCls}`;
        mountGlobalForm(item);
      } else {
        const botId = item.dataset.bot;
        item.className = `accordion-item ${MODAL_COLOR[botId]}${openCls}`;
        mountForm(item, botId, {
          draft: { ...bots[botId], knowledgeNotes: bots[botId].knowledgeNotes.map((n) => ({ ...n })) },
          onApply: (d) => {
            Object.assign(bots[botId], d);
            debate.settingsVersion++;
            toast(`${NAMES[botId]} updated. Changes apply from their next turn.`, 'info', 2500);
          },
        });
      }
      // The section's own title doubles as this section's accordion toggle.
      $('.card-title', item).addEventListener('click', () => {
        const wasOpen = item.classList.contains('open');
        modal.querySelectorAll('.accordion-item').forEach((it) => it.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
      });
    });
    $('#modal-backdrop').classList.remove('hidden');
  }
  function closeModal(silent) {
    settingsOpen = false;
    $('#modal-backdrop').classList.add('hidden');
    if (!silent) updatePauseState();
  }
  $('.modal-close-btn')?.addEventListener('click', () => closeModal());
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen) closeModal(); });

  // ---------------- utils ----------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  boot();
})();
