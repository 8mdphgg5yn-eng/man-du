import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, configureDeepSeek, publicConfig, readConfig, validateRequest } from '../model.mjs';
import { createReaderServer } from '../server.mjs';

const fakeKey = 'TEST_ONLY_NOT_A_REAL_API_KEY_20261022';
const preset = () => readConfig({ EASY_READER_PROVIDER: 'deepseek' });
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function post(url, route, data, origin = url) {
  return fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(data) });
}

test('DeepSeek preset names the verified model and endpoint but never pretends a key exists', () => {
  const config = preset(); assert.equal(config.configured, false); assert.equal(config.model, 'deepseek-flash');
  assert.equal(publicConfig(config).destination, 'https://api.deepseek.com');
  assert.equal(publicConfig(config).setupDeepSeek, true);
  assert.equal(readConfig({ EASY_READER_PROVIDER: 'deepseek', EASY_READER_ENDPOINT: 'https://untrusted.example/chat/completions', EASY_READER_API_KEY: fakeKey }).configured, false);
});
test('DeepSeek payload requests bounded JSON output with thinking disabled', () => {
  const config = configureDeepSeek(fakeKey);
  const quote = '如果明天不下雨，就去公园。';
  const input = validateRequest({ context: quote, quote, start: 0, end: quote.length });
  const payload = buildPayload(config, input);
  assert.equal(config.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(payload.model, 'deepseek-flash'); assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.deepEqual(payload.thinking, { type: 'disabled' }); assert.equal(payload.max_tokens, 1000);
  assert.equal(JSON.stringify(payload).includes(fakeKey), false);
});
test('invalid keys and unsupported models are rejected without reflecting credentials', () => {
  for (const key of ['', 'short', 'invalid key with spaces', 'line\nbreak-is-invalid']) assert.throws(() => configureDeepSeek(key), /密钥/);
  assert.throws(() => configureDeepSeek(fakeKey, 'unknown-model'), /模型名/);
  assert.equal(JSON.stringify(publicConfig(configureDeepSeek(fakeKey))).includes(fakeKey), false);
});
test('same-origin key configuration and forgetting operate in memory without an inference call', async t => {
  const server = createReaderServer(preset()); const url = await listen(server); t.after(() => close(server));
  let response = await post(url, '/api/deepseek/configure', { apiKey: fakeKey, model: 'deepseek-flash' });
  assert.equal(response.status, 200); const publicText = await response.text(); assert.equal(publicText.includes(fakeKey), false); assert.equal(JSON.parse(publicText).configured, true);
  const status = await (await fetch(url + '/api/status')).json(); assert.equal(status.configured, true);
  response = await post(url, '/api/deepseek/forget', {}); assert.equal(response.status, 200); assert.equal((await response.json()).configured, false);
  assert.equal((await (await fetch(url + '/api/status')).json()).configured, false);
});
test('configuration rejects cross-origin, originless and non-DeepSeek service requests', async t => {
  const server = createReaderServer(preset()); const url = await listen(server); t.after(() => close(server));
  assert.equal((await post(url, '/api/deepseek/configure', { apiKey: fakeKey }, 'https://foreign.example')).status, 403);
  assert.equal((await post(url, '/api/deepseek/configure', { apiKey: fakeKey }, '')).status, 403);
  assert.equal((await (await fetch(url + '/api/status')).json()).configured, false);
  const otherServer = createReaderServer(readConfig({})); const other = await listen(otherServer); t.after(() => close(otherServer));
  assert.equal((await post(other, '/api/deepseek/configure', { apiKey: fakeKey })).status, 409);
});
