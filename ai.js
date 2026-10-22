/* Only this module sends optional explanation requests to the same-origin local server. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { createExplanationRequest } = window.EasyReader;
  const fidelityPolicy = 'modality-review-v2';
  const examplePolicy = 'concrete-examples-v1';
  const reviewReady = () => model.fidelityPolicy === fidelityPolicy && model.examplePolicy === examplePolicy;
  let context = null, contextKey = '', model = { configured: false }, preferredStart = null;
  let controller = null, requestNumber = 0, lastAnswer = null, lastRequest = null, settingUp = false;

  function cancel(message = '') {
    requestNumber++;
    controller?.abort(); controller = null;
    $('ai-progress').textContent = message;
    $('ai-cancel').hidden = true;
    $('ai-answer').setAttribute('aria-busy', 'false');
    updateButtons();
  }
  function resetAnswer() {
    lastAnswer = null; lastRequest = null; $('ai-answer').hidden = true;
    // Release old text references rather than retaining a hidden history.
    for (const id of ['answer-source', 'answer-quote', 'answer-explanation', 'answer-example', 'answer-uncertainty', 'answer-fidelity']) $(id).textContent = '';
    $('answer-conditions').replaceChildren(); $('ai-question').value = '';
  }
  function updateButtons() {
    const available = context?.segments?.length && !context.stale;
    $('ai-explain').disabled = !available || !model.configured || !reviewReady() || Boolean(controller) || settingUp || (!model.local && !$('ai-consent').checked);
    $('ai-use-paragraph').disabled = !available || Boolean(controller);
    $('ai-selection').disabled = !available || Boolean(controller);
    for (const id of ['ai-followup', 'ai-simpler', 'ai-example', 'ai-question']) $(id).disabled = !lastAnswer || !reviewReady() || Boolean(controller) || (!model.local && !$('ai-consent').checked);
    $('ai-refresh').disabled = Boolean(controller);
    $('deepseek-save').disabled = Boolean(controller) || settingUp;
    $('deepseek-forget').disabled = !model.configured || !model.setupDeepSeek || Boolean(controller) || settingUp;
    $('deepseek-key').disabled = Boolean(controller) || settingUp;
    $('deepseek-model').disabled = Boolean(controller) || settingUp;
  }
  function buildRequest() {
    if (!context || context.stale) throw new Error('阅读文字已修改，请先选择“开始阅读”更新内容。');
    return createExplanationRequest(context.source, context.segments, context.index, $('ai-selection').value, preferredStart);
  }
  function updatePreview() {
    try { $('ai-context').textContent = buildRequest().context; }
    catch { $('ai-context').textContent = '请先选中或填入当前段落中的原文。'; }
    updateButtons();
  }
  document.addEventListener('reader:context', event => {
    const next = event.detail;
    const key = JSON.stringify([next.source, next.index, next.stale]);
    context = next;
    if (key !== contextKey) {
      contextKey = key; cancel(); resetAnswer(); preferredStart = null;
      $('ai-selection').value = ''; $('ai-error').textContent = '';
      if (next.stale) $('ai-progress').textContent = '文字已修改，请先更新阅读内容。';
    }
    updatePreview();
  });
  function captureSelection() {
    if (!context || context.stale || controller) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const root = $('reading-text');
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const raw = selection.toString(); const selected = raw.trim();
    if (!selected || selected.length > 1200) return;
    const prefix = range.cloneRange(); prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
    preferredStart = prefix.toString().length + raw.indexOf(selected);
    $('ai-selection').value = selected; $('ai-error').textContent = '';
    cancel(); resetAnswer(); updatePreview();
  }
  document.addEventListener('selectionchange', captureSelection);
  $('ai-selection').addEventListener('input', () => { preferredStart = null; cancel(); resetAnswer(); updatePreview(); });
  $('ai-use-paragraph').addEventListener('click', () => {
    const text = context?.segments[context.index]?.text.trim() || '';
    if (text.length > 1200) { $('ai-error').textContent = '这一段较长，请选其中不超过 1200 个字符的词句。'; return; }
    cancel(); resetAnswer(); $('ai-selection').value = text;
    preferredStart = context.segments[context.index].text.indexOf(text); $('ai-error').textContent = ''; updatePreview();
  });
  async function refreshModel() {
    model = { configured: false }; $('ai-consent').checked = false; updateButtons();
    if (!['http:', 'https:'].includes(location.protocol)) {
      $('model-status').textContent = '当前直接打开了文件。请使用本机服务地址打开页面后连接模型。';
      $('ai-availability').textContent = '当前为文件模式，暂时不能生成 AI 解释。分段阅读仍可使用。';
      $('model-badge').textContent = '文件模式 · AI 尚未连接'; return;
    }
    try {
      const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      model = await response.json();
      $('test-mode').hidden = model.testDiagnostics !== true;
      if (model.configured && (!['ollama', 'chat-completions', 'deepseek'].includes(model.provider) || typeof model.destination !== 'string' || typeof model.model !== 'string' || typeof model.local !== 'boolean')) throw new Error();
      $('deepseek-settings').hidden = !model.setupDeepSeek;
      if (model.setupDeepSeek) {
        $('deepseek-model').value = model.model;
        if (!model.configured) $('deepseek-settings').open = true;
      }
      $('model-status').textContent = model.configured ? `已配置 ${model.model}，请求将发往 ${model.destination}。配置可读取，实际生成需在点击解释后验证。` : `${model.reason || '尚未配置模型。'}分段阅读和示例词库仍可使用。`;
      $('ai-availability').textContent = model.configured ? `使用 ${model.model}。${model.local ? '请求将发送到所示本机地址。' : '请在下方“模型状态与发送范围”中确认发送目标后使用。'}` : `${model.reason || '尚未配置模型。'}暂时不能生成 AI 解释。`;
      $('model-badge').textContent = model.configured ? `模型已配置 · ${model.model}` : (model.setupDeepSeek ? 'DeepSeek 已选定 · 等待 API Key' : '本地阅读 · 模型待配置');
      if (!reviewReady()) {
        $('model-status').textContent = '当前服务不支持本版复核协议，请更新并从本版启动器重新启动。密钥需在本机重新输入。';
        $('ai-availability').textContent = '当前服务版本较旧，解释功能已暂停。请使用本版启动器。';
        $('model-badge').textContent = '需要启用新版例子规则';
      }
      $('consent-label').hidden = !model.configured || model.local || !reviewReady();
      $('model-destination').textContent = model.configured ? model.destination : '';
    } catch {
      model = { configured: false }; $('test-mode').hidden = true; $('consent-label').hidden = true; $('deepseek-settings').hidden = true;
      $('model-status').textContent = '当前页面没有可用的模型服务。请通过本机 Node 服务打开，分段阅读仍可使用。';
      $('ai-availability').textContent = '模型服务未连接，暂时不能生成 AI 解释。分段阅读仍可使用。';
      $('model-badge').textContent = '本地阅读 · 模型服务未连接';
    }
    updateButtons();
  }
  function displayAnswer(answer, request) {
    $('answer-source').textContent = `第 ${context.index + 1} 段中的原文 · 模型：${answer.model}`;
    $('answer-quote').textContent = request.quote;
    $('answer-explanation').textContent = answer.explanation;
    $('answer-heading').textContent = answer.fidelity.explanationConstruction === 'source-scaffold' ? '按原文拆开的解释' : 'AI 的解释';
    $('answer-example').textContent = answer.example || '本次没有提供例子。';
    $('example-section').hidden = false;
    $('answer-fidelity').textContent = `${answer.fidelity.explanationConstruction === 'source-scaffold' ? '解释、例子及未知说明采用原文条件拆解。' : ''}${answer.fidelity.repairs ? '已自动修订一次。' : ''}同一 AI 已另行核对原意，并检查例子的场景和对应关系；仍可能遗漏，请对照原文。`;
    $('answer-conditions').replaceChildren();
    for (const quote of answer.conditions) { const item = document.createElement('li'); item.textContent = quote; $('answer-conditions').append(item); }
    $('conditions-section').hidden = !answer.conditions.length;
    $('answer-uncertainty').textContent = answer.uncertainty;
    $('uncertainty-section').hidden = !answer.uncertainty;
    $('ai-answer').hidden = false;
  }
  function validAnswer(answer, request) {
    const f = answer?.fidelity;
    const checked = f?.policy === fidelityPolicy && f.state === 'model_reviewed' && f.method === 'same-model' && f.citations === 'bound' && f.examplePolicy === examplePolicy && f.exampleQuality === (answer.example ? 'concrete' : 'omitted') && /^[a-f0-9]{64}$/.test(f.promptDigest || '') && [0, 1].includes(f.repairs) && Number.isInteger(f.calls) && f.calls >= 2 && f.calls <= 4 && [0, 1].includes(f.reviewRetries) && f.calls >= 2 + f.repairs + f.reviewRetries && Array.isArray(f.modelReviewedFields) && f.modelReviewedFields.length === ['explanation', 'example', 'uncertainty'].filter(field => answer[field]).length && ['explanation', 'example', 'uncertainty'].filter(field => answer[field]).every(field => f.modelReviewedFields.includes(field)) && Array.isArray(f.checkedFields) && f.checkedFields.length === 3 && ['explanation', 'example', 'uncertainty'].every(field => f.checkedFields.includes(field));
    return checked && answer && answer.quote === request.quote && answer.start === request.start && answer.end === request.end && typeof answer.model === 'string' && typeof answer.explanation === 'string' && answer.explanation.trim() && typeof answer.example === 'string' && typeof answer.uncertainty === 'string' && Array.isArray(answer.conditions) && answer.conditions.every(item => typeof item === 'string' && item.trim() && request.context.includes(item));
  }
  async function ask(question = '') {
    if (controller || !model.configured || !reviewReady()) return;
    let request;
    try { request = buildRequest(); }
    catch (error) { $('ai-error').textContent = error.message; return; }
    if (question.length > 400) { $('ai-error').textContent = '追问请控制在 400 个字符以内。'; return; }
    if (question && (!lastAnswer || JSON.stringify(request) !== JSON.stringify(lastRequest))) { $('ai-error').textContent = '原文选择已改变，请先重新解释。'; return; }
    if (!model.local && !$('ai-consent').checked) { $('ai-error').textContent = '请先确认允许发送到所示云端模型。'; return; }
    const previous = question ? JSON.stringify({ explanation: lastAnswer.explanation, example: lastAnswer.example, conditions: lastAnswer.conditions, uncertainty: lastAnswer.uncertainty }) : '';
    if (previous.length > 6000) { $('ai-error').textContent = '上一条解释较长，请先重新解释原句。'; return; }
    controller = new AbortController(); const ownController = controller;
    const id = ++requestNumber;
    $('ai-error').textContent = ''; $('ai-progress').textContent = question ? '正在结合原文回答追问并复核原意。' : '正在解释并复核原意，通常需要两次模型调用。';
    $('ai-cancel').hidden = false; $('ai-answer').setAttribute('aria-busy', 'true'); updateButtons();
    try {
      const response = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, question, previous, cloudConsent: $('ai-consent').checked }), signal: AbortSignal.any([ownController.signal, AbortSignal.timeout(65000)]) });
      const answer = await response.json();
      if (id !== requestNumber) return;
      if (!response.ok) throw new Error(answer.error || '这次未能取得解释，请重试。');
      if (!validAnswer(answer, request)) throw new Error('解释未通过原文对应或复核状态检查，本次结果不展示。');
      lastAnswer = answer; lastRequest = request; displayAnswer(answer, request);
      $('answer-heading').focus();
      $('ai-progress').textContent = '解释已生成并经同一 AI 复核，仍需对照原文。';
      $('ai-question').value = '';
    } catch (error) {
      if (id !== requestNumber) return;
      $('ai-error').textContent = ownController.signal.aborted ? '本次等待已停止。' : (error.name === 'TimeoutError' ? '等待模型超时，请稍后重试。' : error.message);
      $('ai-progress').textContent = lastAnswer ? '本次没有取得新解释，下方保留的是上一条解释。' : '';
      $('ai-error').focus();
    } finally {
      if (id === requestNumber) { controller = null; $('ai-cancel').hidden = true; $('ai-answer').setAttribute('aria-busy', 'false'); updateButtons(); }
    }
  }
  $('ai-explain').addEventListener('click', () => ask());
  $('ai-cancel').addEventListener('click', () => { cancel('已停止等待，模型服务可能已经产生本次调用费用。'); $('ai-explain').focus(); });
  $('ai-refresh').addEventListener('click', refreshModel);
  async function setupDeepSeek(forget = false) {
    if (controller || settingUp) return;
    let apiKey = $('deepseek-key').value.trim();
    if (!forget && !apiKey) { $('deepseek-setup-status').textContent = '请先在本机输入 API Key。'; $('deepseek-key').focus(); return; }
    settingUp = true; cancel(); resetAnswer(); updateButtons();
    $('deepseek-setup-status').textContent = forget ? '正在清除本次服务密钥。' : '正在应用本机配置。';
    const modelName = $('deepseek-model').value;
    // Remove the key from the input immediately; it is never put in status or error text.
    $('deepseek-key').value = '';
    try {
      const response = await fetch(forget ? '/api/deepseek/forget' : '/api/deepseek/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forget ? {} : { apiKey, model: modelName }), signal: AbortSignal.timeout(5000) });
      apiKey = '';
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '本机配置失败，请重试。');
      await refreshModel();
      $('deepseek-setup-status').textContent = forget ? '本次服务密钥已清除。' : '配置已应用，但密钥是否有效仍待真实调用验证。请确认下方的发送范围后解释原文。';
    } catch { $('deepseek-setup-status').textContent = '本机配置未完成，请检查密钥格式或服务状态后重试。'; }
    finally { apiKey = ''; settingUp = false; updateButtons(); }
  }
  $('deepseek-save').addEventListener('click', () => setupDeepSeek());
  $('deepseek-forget').addEventListener('click', () => setupDeepSeek(true));
  $('deepseek-key').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); setupDeepSeek(); } });
  $('ai-consent').addEventListener('change', () => { if (!$('ai-consent').checked && !model.local) cancel('已撤回本次页面后续发送的允许。已经发出的内容无法撤回。'); updateButtons(); });
  $('ai-followup').addEventListener('click', () => { const question = $('ai-question').value.trim(); if (!question) { $('ai-error').textContent = '请先写下想继续问的内容。'; $('ai-question').focus(); return; } ask(question); });
  $('ai-simpler').addEventListener('click', () => ask('请用更短、更容易理解的句子再解释一次，保留原文的确定程度、条件和范围。'));
  $('ai-example').addEventListener('click', () => ask('请换一个有具体人物或对象、场景和动作的短假设例子，说明原句的意思；仍保留原文的可能性、条件和范围，不添加使结论必然成立的新前提。'));
  $('ai-back-source').addEventListener('click', () => document.dispatchEvent(new CustomEvent('reader:back-source')));
  window.addEventListener('pagehide', () => cancel());
  document.dispatchEvent(new CustomEvent('reader:request-context'));
  refreshModel();
})();
