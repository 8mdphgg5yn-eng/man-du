import { getComplexFixture } from './complex-fixtures.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { explain, publicConfig, readConfig, configureDeepSeek, ReaderError, inspectSyntheticAnswer } from './model.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ...['core.js', 'app.js', 'ai.js'].map(name => [`/${name}`, [name, 'text/javascript; charset=utf-8']]),
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);
function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}
async function bodyJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; if (size > 64000) throw new ReaderError(413, '本次请求过大，请缩短阅读文字。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReaderError(400, '请求格式不正确。'); }
}

export function createReaderServer(config = readConfig(), options = {}) {
  let active = false;
  let diagnosticsEnabled = options.testDiagnostics === true;
  return http.createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return json(response, 403, { error: '仅接受本机访问。' });
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error: '不接受其他网页发起的请求。' });
      const pathname = new URL(request.url, `http://${host}`).pathname;
      if (pathname === '/api/status' && request.method === 'GET') return json(response, 200, { ...publicConfig(config), ...(diagnosticsEnabled ? { testDiagnostics: true } : {}) });
      if (['/api/deepseek/configure', '/api/deepseek/forget'].includes(pathname) && request.method === 'POST') {
        if (origin !== `http://${host}`) return json(response, 403, { error: '请仅在本机页面中配置密钥。' });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return json(response, 415, { error: '请求需使用 JSON。' });
        if (config.provider !== 'deepseek') return json(response, 409, { error: '当前服务没有启用 DeepSeek 专用设置。' });
        const data = await bodyJson(request);
        if (active) return json(response, 409, { error: '请先停止当前解释，再修改模型配置。' });
        if (pathname.endsWith('/forget')) {
          config = readConfig({ EASY_READER_PROVIDER: 'deepseek', EASY_READER_MODEL: config.model });
        } else {
          config = configureDeepSeek(data?.apiKey, data?.model || 'deepseek-flash');
        }
        return json(response, 200, publicConfig(config));
      }
      if (pathname === '/api/dev/complex-test/disable' && request.method === 'POST' && diagnosticsEnabled) {
        if (origin !== `http://${host}`) return json(response, 403, { error: '仅本机同源页面可关闭测试入口。' });
        if (active) return json(response, 409, { error: '测试运行中，请稍后关闭。' });
        diagnosticsEnabled = false;
        return json(response, 200, { disabled: true });
      }
      const diagnostic = pathname === '/api/dev/complex-test' && diagnosticsEnabled;
      if ((pathname === '/api/explain' || diagnostic) && request.method === 'POST') {
        if (diagnostic && origin !== `http://${host}`) return json(response, 403, { error: '仅接受本机同源的固定样例测试。' });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return json(response, 415, { error: '请求需使用 JSON。' });
        if (active) return json(response, 429, { error: '已有解释正在生成，请稍后重试。' });
        active = true;
        const controller = new AbortController();
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', abort);
        try {
          const body = await bodyJson(request);
          if (diagnostic) {
            if (!body || Object.keys(body).some(key => !['id', 'mode', 'cloudConsent'].includes(key)) || typeof body.id !== 'string' || !['pipeline', 'review-good', 'review-bad'].includes(body.mode) || body.cloudConsent !== true) return json(response, 400, { error: '仅允许命名的自编样例和明确的测试发送允许。' });
            const fixture = getComplexFixture(body.id);
            if (!fixture) return json(response, 400, { error: '测试样例不存在。' });
            const trace = [];
            try {
              const result = body.mode === 'pipeline' ? await explain(config, fixture.input, controller.signal, step => trace.push(step)) : await inspectSyntheticAnswer(config, fixture.input, body.mode === 'review-good' ? fixture.good : fixture.bad, controller.signal);
              if (!response.destroyed) json(response, 200, { diagnostic: true, id: body.id, mode: body.mode, input: fixture.input, result, trace });
            } catch (error) {
              if (!(error instanceof ReaderError)) throw error;
              if (!response.destroyed) json(response, error.status, { diagnostic: true, id: body.id, mode: body.mode, input: fixture.input, error: error.message, code: error.code, trace });
            }
          } else {
            const result = await explain(config, body, controller.signal);
            if (!response.destroyed) json(response, 200, result);
          }
        } finally { active = false; response.removeListener('close', abort); }
        return;
      }
      if (pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在。' });
      if (pathname === '/favicon.ico' && request.method === 'GET') { response.writeHead(204); response.end(); return; }
      const asset = assets.get(pathname);
      if (!asset || !['GET', 'HEAD'].includes(request.method)) return json(response, 404, { error: '页面不存在。' });
      const content = await readFile(path.join(root, asset[0]));
      response.writeHead(200, {
        'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(response, error instanceof ReaderError ? error.status : 500, { error: error instanceof ReaderError ? error.message : '本机服务出现错误，请重试。', ...(error instanceof ReaderError && error.code ? { code: error.code } : {}) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.EASY_READER_PORT || 8770);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('EASY_READER_PORT 应为 1024 至 65535 的整数。');
  const server = createReaderServer(readConfig(), { testDiagnostics: process.env.EASY_READER_TEST_DIAGNOSTICS === '1' });
  server.on('error', () => { console.error('启动失败，请检查端口是否被占用。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`慢读已启动：http://127.0.0.1:${port}；模型状态请在页面查看。`));
}
