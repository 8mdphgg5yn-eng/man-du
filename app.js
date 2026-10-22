/* Reading remains local. Optional AI transport is isolated in ai.js. */
(() => {
  'use strict';
  const { splitText, findTerms, samples } = window.EasyReader;
  const $ = id => document.getElementById(id);
  const state = { source: '', segments: [], index: 0, title: '', font: 24, speaking: false, speechId: 0, selected: null };
  const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  let announcementTimer;
  function publishContext() {
    document.dispatchEvent(new CustomEvent('reader:context', { detail: { source: state.source, segments: state.segments, index: state.index, stale: $('source').value !== state.source } }));
  }
  document.addEventListener('reader:request-context', publishContext);
  document.addEventListener('reader:back-source', () => {
    $('original-details').open = true;
    const current = $('original').querySelector('[aria-current="true"]');
    if (current) { current.focus(); current.scrollIntoView({ block: 'nearest' }); }
  });
  function announce(message) {
    clearTimeout(announcementTimer);
    $('status').textContent = '';
    announcementTimer = setTimeout(() => { $('status').textContent = message; }, 30);
  }
  function stopSpeech() {
    state.speechId++;
    if (canSpeak) window.speechSynthesis.cancel();
    state.speaking = false;
    $('speak-label').textContent = '读这一段';
    $('speak').setAttribute('aria-label', '朗读当前段落');
  }
  function showWords(term) {
    state.selected = term;
    for (const button of $('reading-text').querySelectorAll('.term')) {
      button.setAttribute('aria-pressed', String(button.dataset.term === term));
    }
    for (const card of $('glossary').children) card.classList.toggle('selected', card.dataset.term === term);
    const entry = findTerms(state.segments[state.index]?.text || '').find(item => item.term === term);
    if (entry) announce(`${entry.term}：${entry.meaning} 例子：${entry.example}`);
  }
  function renderGlossary(matches) {
    $('glossary').replaceChildren();
    const entries = [...new Map(matches.map(entry => [entry.term, entry])).values()];
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-terms';
      empty.textContent = state.segments.length ? '这一段没有匹配到示例词库。你可以继续阅读，或回到原文核对。' : '放入文字后，这里会显示匹配到的词语。';
      $('glossary').append(empty);
    }
    entries.forEach((entry, index) => {
      const card = document.createElement('div');
      card.className = 'word-card'; card.dataset.term = entry.term; card.id = `word-${index}`;
      const title = document.createElement('h3'); title.textContent = entry.term;
      const meaning = document.createElement('p'); meaning.textContent = entry.meaning;
      const example = document.createElement('p'); example.className = 'example'; example.textContent = `比如：${entry.example}`;
      card.append(title, meaning, example); $('glossary').append(card);
    });
    return entries;
  }
  function render() {
    const current = state.segments[state.index];
    const hasText = Boolean(current);
    $('reader-title').textContent = hasText ? state.title : '准备好后，开始慢读';
    $('progress-label').textContent = hasText ? `第 ${state.index + 1} / ${state.segments.length} 段` : '还没有阅读文字';
    $('progress-fill').style.width = hasText ? `${(state.index + 1) / state.segments.length * 100}%` : '0%';
    $('reading-text').replaceChildren();
    const matches = findTerms(current?.text || '');
    const entries = renderGlossary(matches) || [];
    let cursor = 0;
    matches.forEach(match => {
      $('reading-text').append(document.createTextNode(current.text.slice(cursor, match.start)));
      const term = document.createElement('button');
      term.className = 'term'; term.textContent = match.term; term.dataset.term = match.term;
      term.setAttribute('aria-pressed', 'false');
      term.disabled = document.body.classList.contains('focus-reading');
      term.setAttribute('aria-controls', `word-${entries.findIndex(entry => entry.term === match.term)}`);
      term.setAttribute('aria-label', `解释词语：${match.term}`);
      term.addEventListener('click', () => showWords(match.term));
      const unit = document.createElement('span'); unit.className = 'word-unit';
      const punctuation = current.text.slice(match.end).match(/^[，。！？；：、,.!?;:）】”’」』]+/u)?.[0] || '';
      unit.append(term, document.createTextNode(punctuation));
      $('reading-text').append(unit); cursor = match.end + punctuation.length;
    });
    $('reading-text').append(document.createTextNode(hasText ? current.text.slice(cursor) : '把想读的内容放进文字框，或选择一个示例。'));
    $('word-hint').textContent = matches.length ? '带下划线的词语可以点开解释。' : '可以随时在下面对照完整原文。';
    $('previous').disabled = !hasText || state.index === 0;
    $('next').disabled = !hasText || state.index === state.segments.length - 1;
    $('speak').disabled = !hasText || !canSpeak;
    $('position-note').textContent = hasText && state.index === state.segments.length - 1 ? '这一遍，读到这里就完成了。' : '慢慢来，不用一次读完。';
    $('original').replaceChildren();
    state.segments.forEach((segment, index) => {
      const button = document.createElement('button'); button.className = 'original-segment';
      button.textContent = segment.text; button.setAttribute('aria-label', `阅读第 ${index + 1} 段：${segment.text.trim()}`);
      button.setAttribute('aria-current', String(index === state.index));
      button.addEventListener('click', () => navigate(index, true)); $('original').append(button);
    });
    publishContext();
  }
  function navigate(index, focus = false) {
    if (index < 0 || index >= state.segments.length) return;
    stopSpeech(); state.index = index; state.selected = null; render();
    announce(`第 ${index + 1} 段，共 ${state.segments.length} 段。${state.segments[index].text.trim()}`);
    if (focus) $('reader-title').focus();
  }
  function updateCount() { $('char-count').textContent = `${$('source').value.length} / 24000`; }
  function prepare(focus = true) {
    const text = $('source').value;
    if (!text.trim()) { $('input-error').textContent = '请先放入一段文字，或选择一个示例。'; $('source').focus(); return; }
    if (text.length > 24000) { $('input-error').textContent = '文字较多，请分成每次不超过 24000 个字符后阅读。'; return; }
    stopSpeech(); state.source = text; state.segments = splitText(text); state.index = 0;
    state.title = Object.values(samples).find(sample => sample.text === text)?.title || '按自己的节奏，读这一段';
    $('input-error').textContent = ''; $('pending-note').hidden = true; render(); updateCount();
    announce(`已分成 ${state.segments.length} 段，原文保留。现在是第 1 段。`);
    if (focus) $('reader-title').focus();
  }
  $('load-sample').addEventListener('click', () => {
    stopSpeech();
    $('source').value = samples[$('sample').value].text;
    $('pending-note').hidden = $('source').value === state.source;
    updateCount(); $('input-error').textContent = ''; announce('示例已放入文字框。选择“开始阅读”即可阅读。');
    publishContext();
  });
  $('source').addEventListener('input', () => {
    updateCount(); $('input-error').textContent = '';
    $('pending-note').hidden = $('source').value === state.source;
    if ($('source').value !== state.source) { stopSpeech(); announce('文字已修改，选择“开始阅读”以更新阅读内容。'); }
    publishContext();
  });
  $('prepare').addEventListener('click', () => prepare());
  $('clear').addEventListener('click', () => {
    stopSpeech(); $('source').value = ''; state.source = ''; state.segments = []; state.index = 0;
    $('input-error').textContent = ''; $('pending-note').hidden = true; updateCount(); render(); $('source').focus(); announce('阅读文字已清空。');
  });
  $('previous').addEventListener('click', () => navigate(state.index - 1));
  $('next').addEventListener('click', () => navigate(state.index + 1));
  function changeFont(amount) {
    state.font = Math.max(18, Math.min(36, state.font + amount));
    document.documentElement.style.setProperty('--font-size', `${state.font}px`); $('font-size').value = state.font;
    $('font-down').disabled = state.font === 18; $('font-up').disabled = state.font === 36;
    announce(`阅读字号 ${state.font}。`);
  }
  $('font-down').addEventListener('click', () => changeFont(-2));
  $('font-up').addEventListener('click', () => changeFont(2));
  $('contrast').addEventListener('click', () => {
    const enabled = document.body.classList.toggle('high-contrast'); $('contrast').setAttribute('aria-pressed', String(enabled));
    announce(enabled ? '已开启高对比。' : '已关闭高对比。');
  });
  $('focus-mode').addEventListener('click', () => {
    const enabled = document.body.classList.toggle('focus-reading'); $('focus-mode').setAttribute('aria-pressed', String(enabled));
    // Word explanations are outside focus mode. Remove unavailable controls from the tab order.
    $('reading-text').querySelectorAll('.term').forEach(button => { button.disabled = enabled; });
    announce(enabled ? '已开启专注阅读。选择“专注阅读”可以返回完整页面。' : '已返回完整页面。');
  });
  $('speak').addEventListener('click', () => {
    if (!canSpeak || !state.segments.length) return;
    if (state.speaking) { stopSpeech(); announce('已停止朗读。'); return; }
    stopSpeech();
    const speechId = state.speechId;
    const utterance = new SpeechSynthesisUtterance(state.segments[state.index].text.trim());
    utterance.lang = 'zh-CN'; utterance.rate = 0.85;
    const voice = speechSynthesis.getVoices().find(item => /^zh[-_]CN/i.test(item.lang)) || speechSynthesis.getVoices().find(item => /^zh/i.test(item.lang));
    if (voice) utterance.voice = voice;
    state.speaking = true; $('speak-label').textContent = '停止朗读'; $('speak').setAttribute('aria-label', '停止朗读当前段落');
    const finish = () => { if (state.speechId === speechId) { state.speaking = false; $('speak-label').textContent = '读这一段'; $('speak').setAttribute('aria-label', '朗读当前段落'); } };
    utterance.onend = finish;
    utterance.onerror = event => {
      if (state.speechId !== speechId) return;
      finish(); if (!['canceled', 'interrupted'].includes(event.error)) announce('这次未能朗读。请检查浏览器的语音支持，或使用设备的屏幕朗读功能。');
    };
    speechSynthesis.speak(utterance);
  });
  window.addEventListener('pagehide', stopSpeech);
  if (!canSpeak) $('speech-note').textContent = '当前浏览器不支持朗读，可使用设备的屏幕朗读功能。';
  $('source').value = samples.water.text;
  prepare(false);
})();
