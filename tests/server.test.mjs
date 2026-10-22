import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReaderServer } from '../server.mjs';
import { getComplexFixture } from '../complex-fixtures.mjs';
import { sourceExample, sourcePlan } from '../reader-engine.mjs';
import { fixedReview } from './review-fixture.mjs';
import { readConfig, publicConfig, parseAnswer } from '../model.mjs';

const input = { context: '如果明天不下雨，就去公园。可能改期。', quote: '如果明天不下雨，就去公园。', start: 0, end: 14 };
input.end = input.quote.length;
const answer = { explanation: '是否去公园，取决于明天是否下雨。', example: '假设明天下雨，原来的条件就不满足。', conditions: ['如果明天不下雨', '可能改期'], uncertainty: '仅凭原文不能确定明天的天气。' };
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function fixture(t, options = {}) {
  const calls = [];
  let clientAborted = false;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); calls.push({ path: req.url, body, authorization: req.headers.authorization });
    res.once('close', () => { if (!res.writableEnded) clientAborted = true; });
    const isReview = body.messages[0].content.startsWith('慢读原意复核');
    const stage = isReview ? 'review' : calls.length > 1 ? 'repair' : 'generate';
    const delay = options.stageDelay?.[stage] || options.delay;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (res.destroyed) return;
    if (options.redirect) { res.writeHead(302, { Location: options.redirect }); res.end(); return; }
    if (options.status) { res.writeHead(options.status); res.end('secret-test-error-detail'); return; }
    const content = options.respond ? options.respond({ body, stage, number: calls.length }) : options.raw ?? JSON.stringify(isReview ? fixedReview(JSON.parse(body.messages[1].content)) : options.answer || answer);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(options.provider === 'chat-completions' ? { choices: [{ message: { content } }] } : { message: { content } }));
  });
  const upstreamURL = await listen(upstream);
  const config = { configured: true, provider: options.provider || 'ollama', model: 'TEST-ONLY-NOT-AI', endpoint: `${upstreamURL}/api/chat`, destination: upstreamURL, local: !options.cloud, apiKey: 'test-secret-never-expose', timeout: options.timeout || 2000 };
  const server = createReaderServer(config, { testDiagnostics: options.testDiagnostics });
  const url = await listen(server);
  t.after(async () => { await close(server); await close(upstream); });
  return { url, calls, config, wasAborted: () => clientAborted };
}
function post(url, body = input, extra = {}) { return fetch(`${url}/api/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers }, body: JSON.stringify(body), signal: extra.signal }); }

test('unconfigured service stays readable and reports its actual model state', async t => {
  const server = createReaderServer(readConfig({})); const url = await listen(server); t.after(() => close(server));
  const state = await (await fetch(`${url}/api/status`)).json(); assert.equal(state.configured, false);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await post(url)).status, 503);
  for (const route of ['/.env', '/model.mjs', '/prompts.json', '/prompts.mjs', '/prompts-v2.json', '/reader-engine.mjs', '/engine-loader.mjs', '/fidelity.mjs', '/tests/server.test.mjs', '/README.md']) assert.equal((await fetch(url + route)).status, 404);
});
test('configuration never returns credentials and rejects unsafe endpoint forms', () => {
  assert.equal(readConfig({ EASY_READER_PROVIDER: 'chat-completions', EASY_READER_MODEL: 'test', EASY_READER_ENDPOINT: 'http://external.example/api', EASY_READER_API_KEY: 'secret' }).configured, false);
  assert.equal(readConfig({ EASY_READER_PROVIDER: 'ollama', EASY_READER_MODEL: 'test', EASY_READER_ENDPOINT: 'http://secret@127.0.0.1:11434/api/chat' }).configured, false);
  const config = readConfig({ EASY_READER_PROVIDER: 'ollama', EASY_READER_MODEL: 'test', EASY_READER_API_KEY: 'secret' });
  assert.equal(config.configured, true); assert.equal(JSON.stringify(publicConfig(config)).includes('secret'), false);
});
test('Ollama contract uses exact source and validated extracted conditions', async t => {
  const f = await fixture(t); const res = await post(f.url); assert.equal(res.status, 200);
  const data = await res.json(); assert.equal(data.quote, input.quote); assert.deepEqual(data.conditions, answer.conditions);
  assert.equal(data.fidelity.calls, 2); assert.equal(data.fidelity.repairs, 0); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.stream, false); assert.equal(f.calls[0].body.format, 'json');
  const sent = JSON.parse(f.calls[0].body.messages[1].content); assert.equal(sent.上下文, input.context);
  assert.equal(f.calls[0].body.messages[0].role, 'system');
});
test('chat-completions adapter and one-step follow-up retain original context', async t => {
  const f = await fixture(t, { provider: 'chat-completions' });
  const response = await post(f.url, { ...input, question: '再简单一点', previous: JSON.stringify(answer) });
  assert.equal(response.status, 200); assert.equal(f.calls[0].body.max_tokens, 1000);
  const user = JSON.parse(f.calls[0].body.messages[1].content); assert.equal(user.本次追问, '再简单一点'); assert.equal(user.所选原文, input.quote);
});
test('foreign pages, missing cloud consent and ambiguous source cannot trigger upstream requests', async t => {
  const f = await fixture(t, { cloud: true });
  assert.equal((await post(f.url, input, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await post(f.url)).status, 400);
  assert.equal((await post(f.url, { ...input, quote: '一定去公园', cloudConsent: true })).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await post(f.url, { ...input, cloudConsent: true })).status, 200);
});
test('fabricated conditions or malformed JSON are rejected rather than displayed', async t => {
  assert.throws(() => parseAnswer(JSON.stringify({ ...answer, conditions: ['明天一定去公园'] }), input.context), /原文引用检查/);
  const f = await fixture(t, { raw: '这不是 JSON' }); assert.equal((await post(f.url)).status, 502);
});
test('upstream HTTP error details and credentials never reach the browser', async t => {
  const f = await fixture(t, { status: 401 }); const res = await post(f.url); assert.equal(res.status, 502);
  const body = await res.text(); assert.ok(body.includes('401')); assert.equal(body.includes('secret-test-error-detail'), false); assert.equal(body.includes(f.config.apiKey), false);
  const status = await (await fetch(f.url + '/api/status')).text(); assert.equal(status.includes(f.config.apiKey), false);
});
test('model requests time out and do not follow redirects', async t => {
  const delayed = await fixture(t, { delay: 300, timeout: 30 }); assert.equal((await post(delayed.url)).status, 504);
  const redirected = await fixture(t, { redirect: 'http://127.0.0.1:1/never' }); assert.equal((await post(redirected.url)).status, 502);
});
test('cancelling the browser request aborts its outstanding model request', async t => {
  const f = await fixture(t, { delay: 1000 }); const controller = new AbortController();
  const pending = post(f.url, input, { signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  for (let i = 0; i < 50 && !f.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1); controller.abort(); await rejected;
  for (let i = 0; i < 50 && !f.wasAborted(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.wasAborted(), true);
});

const survey = '这次调查的结果可能适用于参与调查的人，但不能据此确定所有儿童都有同样的情况。';
const surveyInput = { context: survey, quote: survey, start: 0, end: survey.length };
const unsafeSurvey = { explanation: '结果可能适用于参与调查的人，不能推及所有儿童。', example: '假设调查了一班学生，结果只说明这些学生的情况。', uncertainty: '', conditions: ['可能适用于参与调查的人'] };
const safeSurvey = { ...unsafeSurvey, example: '假设调查了一班学生，结果也许适用于这些学生，不能推断所有儿童都一样。' };
function sequence({ badField = 'example', persistent = false, uncertain = false, invalid = null, invalidRepair = false } = {}) {
  return ({ body, stage, number }) => {
    if (stage !== 'review') return JSON.stringify(number === 1 || persistent ? unsafeSurvey : invalidRepair ? { ...safeSurvey, conditions: ['不存在的原文'] } : safeSurvey);
    const data = JSON.parse(body.messages[1].content);
    const report = fixedReview(data, number === 2 || persistent ? { [badField]: uncertain ? 'uncertain' : 'needs_revision', risk: uncertain ? 'uncertain' : 'issue' } : {});
    if (invalid) invalid(report);
    return JSON.stringify(report);
  };
}
test('unsafe survey example is repaired and re-reviewed before the browser receives it', async t => {
  const f = await fixture(t, { respond: sequence() });
  const response = await post(f.url, surveyInput); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.example, safeSurvey.example);
  assert.equal(result.fidelity.repairs, 1); assert.equal(result.fidelity.calls, 4); assert.equal(result.fidelity.exampleQuality, 'concrete'); assert.equal(result.fidelity.examplePolicy, 'concrete-examples-v1'); assert.match(result.fidelity.promptDigest, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[1].body.messages[0].content, f.calls[3].body.messages[0].content);
  assert.ok(JSON.parse(f.calls[2].body.messages[1].content).修订依据);
});
test('an explanation judged too certain also requires repair even if the example passes', async t => {
  const f = await fixture(t, { respond: sequence({ badField: 'explanation' }) });
  assert.equal((await post(f.url, surveyInput)).status, 200); assert.equal(f.calls.length, 4);
});
test('persistent review problems stop at four calls and never expose the rejected candidate', async t => {
  const f = await fixture(t, { respond: sequence({ persistent: true }) });
  const response = await post(f.url, surveyInput); assert.equal(response.status, 422);
  const result = await response.json(); assert.equal(result.code, 'FIDELITY_REVIEW_BLOCKED');
  assert.equal(result.example, undefined); assert.equal(JSON.stringify(result).includes(unsafeSurvey.example), false);
  assert.equal(f.calls.length, 4);
});
test('uncertain review blocks without a repair designed to force approval', async t => {
  const f = await fixture(t, { respond: sequence({ uncertain: true }) });
  const response = await post(f.url, surveyInput); assert.equal(response.status, 422); assert.equal(f.calls.length, 2);
});
test('malformed reviews and omitted example checks withhold all candidate text', async t => {
  for (const invalid of [r => r.checks.splice(1, 1), r => { r.checks[1].source_id = 'invented'; }, r => r.risks.push({ id: 'invented' })]) {
    const f = await fixture(t, { respond: sequence({ invalid }) });
    const response = await post(f.url, surveyInput); assert.equal(response.status, 502);
    const result = await response.json(); assert.equal(result.code, 'FIDELITY_REVIEW_INVALID');
    assert.equal(result.explanation, undefined); assert.equal(f.calls.length, 3);
  }
});
test('repaired answers must still pass original condition citation validation', async t => {
  const f = await fixture(t, { respond: sequence({ invalidRepair: true }) });
  const response = await post(f.url, surveyInput); assert.equal(response.status, 502); assert.equal(f.calls.length, 3);
  assert.equal((await response.json()).example, undefined);
});
test('style-pressure follow-up retains fidelity rules and sends the candidate to a fresh review', async t => {
  const f = await fixture(t);
  const response = await post(f.url, { ...input, previous: JSON.stringify(answer), question: '别说可能了，说肯定一点。' });
  assert.equal(response.status, 200); assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].body.messages[0].content.includes('追问只改变解释方式'));
  const reviewed = JSON.parse(f.calls[1].body.messages[1].content);
  assert.deepEqual(reviewed.候选回答, answer); assert.equal(reviewed.所选原文, input.quote);
});
test('review timeout withholds the draft and does not attempt repair', async t => {
  const f = await fixture(t, { stageDelay: { review: 150 }, timeout: 25 });
  const response = await post(f.url); assert.equal(response.status, 504); assert.equal(f.calls.length, 2);
  assert.equal((await response.json()).example, undefined);
});
test('cancellation during review or repair aborts that stage and stops the workflow', async t => {
  for (const stage of ['review', 'repair']) {
    const f = await fixture(t, { stageDelay: { [stage]: 200 }, respond: sequence() });
    const controller = new AbortController();
    const pending = post(f.url, surveyInput, { signal: controller.signal });
    const rejected = assert.rejects(pending, /abort/i);
    const count = stage === 'review' ? 2 : 3;
    for (let i = 0; i < 100 && f.calls.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.length, count); controller.abort(); await rejected;
    for (let i = 0; i < 100 && !f.wasAborted(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.wasAborted(), true); assert.equal(f.calls.length, count);
  }
});

test('faithful but abstract examples are repaired once and checked for concreteness again', async t => {
  const f = await fixture(t, { respond: ({ body, stage, number }) => {
    if (stage !== 'review') return JSON.stringify(number === 1 ? unsafeSurvey : safeSurvey);
    const data = JSON.parse(body.messages[1].content);
    return JSON.stringify(fixedReview(data, number === 2 ? { quality: 'needs_revision' } : {}));
  } });
  const res = await post(f.url, surveyInput); assert.equal(res.status, 200);
  const result = await res.json(); assert.equal(result.fidelity.calls, 4); assert.equal(result.fidelity.exampleQuality, 'concrete');
  assert.ok(JSON.parse(f.calls[2].body.messages[1].content).修订依据.example_quality);
});
test('persistently abstract or unclear examples stop without exposing a candidate', async t => {
  for (const quality of ['needs_revision', 'uncertain']) {
    const f = await fixture(t, { respond: ({ body, stage }) => stage === 'review' ? JSON.stringify(fixedReview(JSON.parse(body.messages[1].content), { quality })) : JSON.stringify(safeSurvey) });
    const res = await post(f.url, surveyInput); assert.equal(res.status, 422);
    const value = await res.json(); assert.equal(value.code, 'EXAMPLE_REVIEW_BLOCKED'); assert.equal(value.example, undefined);
    assert.equal(f.calls.length, quality === 'uncertain' ? 2 : 4);
  }
});
test('quality approval cannot bypass the independent source fidelity decision', async t => {
  const f = await fixture(t, { respond: sequence({ persistent: true }) });
  const res = await post(f.url, surveyInput); assert.equal(res.status, 422); assert.equal((await res.json()).code, 'FIDELITY_REVIEW_BLOCKED');
});
test('missing example quality evidence rejects a review even if source checks pass', async t => {
  const f = await fixture(t, { respond: sequence({ invalid: r => { delete r.example_quality; } }) });
  const res = await post(f.url, surveyInput); assert.equal(res.status, 502); assert.equal((await res.json()).code, 'FIDELITY_REVIEW_INVALID'); assert.equal(f.calls.length, 3);
});


function diagnosticPost(url, body = { id: 'park', mode: 'pipeline', cloudConsent: true }, origin = url) {
  return fetch(url + '/api/dev/complex-test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
}
function syntheticResponder({ body, stage }) {
  const data = JSON.parse(body.messages[1].content);
  if (stage === 'review') return JSON.stringify(fixedReview(data));
  const id = data.上下文 === getComplexFixture('park').input.context ? 'park' : 'card';
  return JSON.stringify(getComplexFixture(id).good);
}
test('diagnostics are disabled by default and synthetic source files are not served', async t => {
  const f = await fixture(t);
  assert.equal((await diagnosticPost(f.url)).status, 404); assert.equal(f.calls.length, 0);
  assert.equal((await fetch(f.url + '/complex-fixtures.mjs')).status, 404);
});
test('diagnostics only accept named fixed sources, same origin and explicit consent', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: syntheticResponder });
  for (const body of [{ id: 'unknown', mode: 'pipeline', cloudConsent: true }, { id: 'park', mode: 'pipeline', cloudConsent: true, context: 'PRIVATE TEXT' }, { id: 'park', mode: 'pipeline' }, { id: 'park', mode: 'arbitrary', cloudConsent: true }]) assert.equal((await diagnosticPost(f.url, body)).status, 400);
  assert.equal((await diagnosticPost(f.url, undefined, '')).status, 403);
  assert.equal((await diagnosticPost(f.url, undefined, 'https://foreign.example')).status, 403);
  assert.equal(f.calls.length, 0);
});
test('diagnostic pipeline records candidates and reviews without credentials', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: syntheticResponder });
  const res = await diagnosticPost(f.url); assert.equal(res.status, 200);
  const value = await res.json(); assert.deepEqual(value.trace.map(x => x.stage), ['candidate', 'review']);
  assert.equal(value.trace[1].report.verdict, 'consistent'); assert.equal(value.input.quote, getComplexFixture('park').input.quote);
  assert.equal(JSON.stringify(value).includes(f.config.apiKey), false);
  assert.equal(value.trace[0].calls, 1); assert.equal(value.trace[1].calls, 2);
});
test('diagnostic controls only review the baked-in good or bad answer', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: ({ body }) => JSON.stringify(fixedReview(JSON.parse(body.messages[1].content))) });
  for (const mode of ['review-good', 'review-bad']) {
    const res = await diagnosticPost(f.url, { id: 'card', mode, cloudConsent: true }); assert.equal(res.status, 200);
    const value = await res.json(); assert.equal(value.result.calls, 1); assert.equal(value.result.candidate.example, getComplexFixture('card')[mode === 'review-good' ? 'good' : 'bad'].example);
  }
  assert.equal(f.calls.length, 2);
});
test('a rejected scaffold stops without re-reviewing unchanged text and ordinary responses hide the trace', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: ({ body, stage }) => stage === 'review' ? JSON.stringify(fixedReview(JSON.parse(body.messages[1].content), { example: 'needs_revision' })) : syntheticResponder({ body, stage }) });
  const res = await diagnosticPost(f.url); assert.equal(res.status, 422);
  const value = await res.json(); assert.deepEqual(value.trace.map(x => x.stage), ['candidate', 'review']); assert.equal(value.trace.at(-1).calls, 2);
  const ordinary = await post(f.url, getComplexFixture('park').input); assert.equal(ordinary.status, 422);
  const hidden = await ordinary.json(); assert.equal(hidden.trace, undefined); assert.equal(hidden.candidate, undefined); assert.equal(hidden.result, undefined);
});
test('malformed diagnostic reviews include only synthetic response text in the trace', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: ({ body, stage }) => stage === 'review' ? 'SYNTHETIC-MALFORMED-REVIEW' : syntheticResponder({ body, stage }) });
  const res = await diagnosticPost(f.url); assert.equal(res.status, 502);
  const value = await res.json(); assert.equal(value.code, 'FIDELITY_REVIEW_INVALID'); assert.equal(value.trace.at(-1).stage, 'review_error'); assert.equal(value.trace.at(-1).raw, 'SYNTHETIC-MALFORMED-REVIEW');
  assert.equal(JSON.stringify(value).includes(f.config.apiKey), false);
});
test('diagnostics can be disabled without forgetting the configured model', async t => {
  const f = await fixture(t, { testDiagnostics: true, respond: syntheticResponder });
  const route = f.url + '/api/dev/complex-test/disable';
  assert.equal((await fetch(route, { method: 'POST' })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { Origin: f.url } })).status, 200);
  const state = await (await fetch(f.url + '/api/status')).json(); assert.equal(state.configured, true); assert.equal(state.testDiagnostics, undefined);
  assert.equal((await diagnosticPost(f.url)).status, 404); assert.equal(f.calls.length, 0);
  assert.equal((await post(f.url, getComplexFixture('park').input)).status, 200);
});

test('a broken evidence report is retried once without regenerating or relaxing the candidate', async t => {
  const f = await fixture(t, { respond: ({ body, stage, number }) => {
    if (stage !== 'review') return JSON.stringify(answer);
    const review = fixedReview(JSON.parse(body.messages[1].content));
    if (number === 2) review.checks[0].candidate_id = 'invented';
    return JSON.stringify(review);
  } });
  const response = await post(f.url); assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.fidelity.calls, 3); assert.equal(value.fidelity.reviewRetries, 1); assert.equal(value.fidelity.repairs, 0); assert.equal(value.fidelity.policy, 'modality-review-v2'); assert.equal(value.fidelity.citations, 'bound');
  assert.deepEqual(JSON.parse(f.calls[1].body.messages[1].content).候选回答, JSON.parse(f.calls[2].body.messages[1].content).候选回答);
});
function unsupportedScaffoldFixture() { return JSON.parse(JSON.stringify(getComplexFixture('card')).replaceAll('大字说明卡','试验说明牌')); }
test('local complex contract catches added necessity for an object without a local scaffold', async t => {
  const sample = unsupportedScaffoldFixture(); const bad = { ...sample.good, explanation: sample.good.explanation + '只有光线充足才可能有效。' };
  const f = await fixture(t, { respond: ({ body, stage, number }) => stage === 'review' ? JSON.stringify(fixedReview(JSON.parse(body.messages[1].content))) : JSON.stringify(number === 1 ? bad : sample.good) });
  const response = await post(f.url, sample.input); assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.fidelity.repairs, 1); assert.equal(value.fidelity.calls, 3); assert.equal(value.explanation, sample.good.explanation);
});

test('contract repair and one evidence-format retry share the same four-call budget', async t => {
  const sample = unsupportedScaffoldFixture();
  const f = await fixture(t, { respond: ({ body, stage, number }) => {
    if (stage !== 'review') return JSON.stringify(number === 1 ? { ...sample.good, explanation: sample.good.explanation + '只有光线充足才可能有效。' } : sample.good);
    const report = fixedReview(JSON.parse(body.messages[1].content));
    if (number === 3) report.checks.pop();
    return JSON.stringify(report);
  } });
  const response = await post(f.url, sample.input); assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.fidelity.calls, 4); assert.equal(value.fidelity.repairs, 1); assert.equal(value.fidelity.reviewRetries, 1); assert.equal(f.calls.length, 4);
});

test('a source scaffold is visibly attributed and reviewed before it can be returned', async t => {
  const sample = getComplexFixture('park');
  const scaffold = sourceExample(sourcePlan(sample.input.quote));
  for (const verdict of ['consistent','needs_revision']) {
    const f = await fixture(t, { respond: ({ body, stage }) => {
      if (stage !== 'review') return JSON.stringify({...sample.good, example:'他们只好返回。'});
      const data = JSON.parse(body.messages[1].content);
      assert.equal(data.证据.example, scaffold);
      return JSON.stringify(fixedReview(data, {example:verdict}));
    } });
    const response = await post(f.url, sample.input); const value = await response.json();
    if (verdict === 'consistent') { assert.equal(response.status,200); assert.equal(value.example,scaffold); assert.equal(value.fidelity.exampleConstruction,'source-scaffold'); }
    else { assert.equal(response.status,422); assert.equal(value.example,undefined); }
  }
});
