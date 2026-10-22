// Cross-platform localhost launcher. No credentials are stored in this file.
import { createReaderServer } from './server.mjs';
import { readConfig } from './model.mjs';

const port = Number(process.env.EASY_READER_PORT || 8770);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('EASY_READER_PORT 应为 1024 至 65535 的整数。');
}
const config = readConfig({
  ...process.env,
  EASY_READER_PROVIDER: 'deepseek',
  EASY_READER_MODEL: process.env.EASY_READER_MODEL || 'deepseek-flash',
  EASY_READER_ENDPOINT: 'https://api.deepseek.com/chat/completions'
});
// Diagnostic endpoints are disabled in this everyday launcher.
const server = createReaderServer(config);
server.on('error', () => {
  console.error('启动失败，请检查端口是否被占用。');
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`慢读已启动：http://127.0.0.1:${port}；请在本机页面配置模型。`);
});
