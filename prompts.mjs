// Trusted server-side prompt text only. Never served or editable through HTTP.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const EXAMPLE_POLICY = 'concrete-examples-v1';
const promptURL = new URL('./prompts-v2.json', import.meta.url);
export function parsePrompts(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 50000) throw new Error('本地提示规则过大。');
  const value = JSON.parse(text);
  if (!value || value.schema !== 'reader-prompts-v1' || value.examplePolicy !== EXAMPLE_POLICY || ['generation', 'review'].some(field => typeof value[field] !== 'string' || value[field].trim().length < 100 || value[field].length > 18000)) throw new Error('本地提示规则格式不正确。');
  return Object.freeze({ generation: value.generation, review: value.review, examplePolicy: value.examplePolicy, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
}
export const INITIAL_PROMPTS = parsePrompts(readFileSync(promptURL, 'utf8'));
// Snapshot once per explanation so edits cannot mix two policies mid-workflow.
export async function loadPrompts(url = promptURL) { return parsePrompts(await readFile(url, 'utf8')); }
