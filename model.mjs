import { loadEngine } from './engine-loader.mjs';
import { EXAMPLE_POLICY, INITIAL_PROMPTS, loadPrompts } from './prompts.mjs';
import { GENERATION_INSTRUCTION } from './fidelity.mjs';

export class ReaderError extends Error {
  constructor(status, message, code = '') { super(message); this.status = status; this.code = code; }
}

export function readConfig(env = process.env) {
  const provider = env.EASY_READER_PROVIDER || '';
  const model = env.EASY_READER_MODEL || (provider === 'deepseek' ? 'deepseek-flash' : '');
  if (!provider && !model && !env.EASY_READER_ENDPOINT) return { configured: false, reason: '尚未配置模型。' };
  if (!['ollama', 'chat-completions', 'deepseek'].includes(provider)) return { configured: false, reason: '模型接口类型未配置或不受支持。' };
  if (provider === 'deepseek' && !['deepseek-flash', 'deepseek-v4-pro'].includes(model)) return { configured: false, reason: 'DeepSeek 模型名未在当前支持列表中。' };
  if (!model || model.length > 150) return { configured: false, reason: '请在本机配置模型名。' };
  let endpoint;
  try { endpoint = new URL(env.EASY_READER_ENDPOINT || (provider === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : provider === 'ollama' ? 'http://127.0.0.1:11434/api/chat' : '')); }
  catch { return { configured: false, reason: '模型地址未配置或格式不正确。' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((!local && endpoint.protocol !== 'https:') || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    return { configured: false, reason: '模型地址需使用本机 HTTP 或 HTTPS，且不能在地址中包含凭证或查询参数。' };
  }
  const apiKey = env.EASY_READER_API_KEY || '';
  if (provider === 'deepseek' && endpoint.href !== 'https://api.deepseek.com/chat/completions') return { configured: false, reason: 'DeepSeek 专用配置仅使用官方接口地址。' };
  if (provider === 'deepseek' && !apiKey) return { configured: false, provider, model, local: false, destination: endpoint.origin, reason: 'DeepSeek 已选定，等待在本机输入 API Key。' };
  if (!local && !apiKey) return { configured: false, reason: '云端接口尚未在本机配置密钥。' };
  return { configured: true, provider, model, endpoint: endpoint.href, local, destination: endpoint.origin, apiKey, timeout: 45000 };
}

export function publicConfig(config) {
  const setupDeepSeek = config.provider === 'deepseek';
  if (!config.configured) return { configured: false, reason: config.reason, setupDeepSeek, fidelityPolicy: 'modality-review-v2', examplePolicy: EXAMPLE_POLICY, ...(setupDeepSeek ? { provider: config.provider, model: config.model, destination: config.destination, local: false } : {}) };
  return { configured: true, provider: config.provider, model: config.model, local: config.local, destination: config.destination, setupDeepSeek, fidelityPolicy: 'modality-review-v2', examplePolicy: EXAMPLE_POLICY };
}

export function configureDeepSeek(apiKey, model = 'deepseek-flash') {
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(apiKey)) throw new ReaderError(400, '密钥为空或格式不正确，请在本机重新输入。');
  const config = readConfig({ EASY_READER_PROVIDER: 'deepseek', EASY_READER_MODEL: model, EASY_READER_API_KEY: apiKey });
  if (!config.configured) throw new ReaderError(400, config.reason);
  return config;
}

export function buildPayload(config, data, prompts = INITIAL_PROMPTS) {
  const messages = [
    { role: 'system', content: prompts.generation },
    { role: 'user', content: JSON.stringify({ 上下文: data.context, 所选原文: data.quote, 上次解释: data.previous, 本次追问: data.question }) }
  ];
  return payloadForMessages(config, messages);
}

export function payloadForMessages(config, messages, maxTokens = 1000) {
  if (config.provider === 'ollama') return { model: config.model, messages, stream: false, format: 'json', options: { temperature: 0.2, num_predict: maxTokens } };
  return { model: config.model, messages, stream: false, max_tokens: maxTokens, ...(config.provider === 'deepseek' ? { response_format: { type: 'json_object' }, thinking: { type: 'disabled' } } : {}) };
}

export function validateRequest(data) {
  if (!data || typeof data.context !== 'string' || !data.context.trim() || data.context.length > 6000) throw new ReaderError(400, '上下文为空或超过本次长度限制。');
  if (typeof data.quote !== 'string' || !data.quote.trim() || data.quote.length > 1200 || !Number.isInteger(data.start) || !Number.isInteger(data.end) || data.start < 0 || data.end > data.context.length || data.end <= data.start || data.context.slice(data.start, data.end) !== data.quote) {
    throw new ReaderError(400, '所选内容与原文位置不一致，请重新选择。');
  }
  const question = data.question ?? '';
  const previous = data.previous ?? '';
  if (typeof question !== 'string' || question.length > 400 || typeof previous !== 'string' || previous.length > 6000 || Boolean(question) !== Boolean(previous)) throw new ReaderError(400, '追问内容不完整或过长，请重新解释原句。');
  return { context: data.context, quote: data.quote, start: data.start, end: data.end, question, previous };
}

export const instruction = GENERATION_INSTRUCTION;

export function parseAnswer(content, context) {
  if (typeof content !== 'string' || content.length > 12000) throw new ReaderError(502, '模型返回的内容过长或格式不正确。');
  const clean = content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  let data;
  try { data = JSON.parse(clean); } catch { throw new ReaderError(502, '模型没有按约定返回解释，请重试或更换模型。'); }
  if (!data || Array.isArray(data) || typeof data.explanation !== 'string' || !data.explanation.trim() || data.explanation.length > 3000 || typeof data.example !== 'string' || data.example.length > 1800 || typeof data.uncertainty !== 'string' || data.uncertainty.length > 1200 || !Array.isArray(data.conditions) || data.conditions.length > 8 || data.conditions.some(item => typeof item !== 'string' || !item.trim() || item.length > 1200 || !context.includes(item))) {
    throw new ReaderError(502, '模型解释未通过格式或原文引用检查，本次结果不展示。');
  }
  return { explanation: data.explanation, example: data.example, conditions: data.conditions, uncertainty: data.uncertainty };
}

export async function callModel(config, payload, signal) {
  if (signal?.aborted) throw new ReaderError(504, '本次解释已停止或等待超时。');
  const combined = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(config.timeout || 45000)]);
  let response;
  try {
    response = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(payload), signal: combined, redirect: 'error' });
  } catch (error) {
    if (combined.aborted) throw new ReaderError(504, '本次解释已停止或等待超时。可以检查模型后重试。');
    throw new ReaderError(502, '未能连接已配置的模型，请检查本机配置或服务状态。');
  }
  if (!response.ok) { await response.body?.cancel(); throw new ReaderError(502, `模型接口返回 HTTP ${response.status}，请检查本机配置、额度或服务状态。`); }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 120000) { await reader.cancel(); throw new ReaderError(502, '模型接口返回内容超过限制。'); }
      chunks.push(value);
    }
    const upstream = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const content = config.provider === 'ollama' ? upstream.message?.content : upstream.choices?.[0]?.message?.content;
    return content;
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    if (combined.aborted) throw new ReaderError(504, '本次解释已停止或等待超时。');
    throw new ReaderError(502, '模型接口响应不完整或格式不正确，请重试。');
  }
}

async function engine() { try { return await loadEngine(); } catch { throw new ReaderError(503, '本地解释引擎暂不可用，请修复代码后重试。', 'ENGINE_UNAVAILABLE'); } }
export async function explain(...args) { return (await engine()).explain(...args); }
export async function inspectSyntheticAnswer(...args) { return (await engine()).inspectSyntheticAnswer(...args); }
