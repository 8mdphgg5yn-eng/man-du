import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrompts, parsePrompts } from '../prompts.mjs';

test('later requests read updated prompts while an in-flight snapshot remains unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-prompts-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'prompts.json');
  const original = JSON.parse(await readFile(new URL('../prompts-v2.json', import.meta.url), 'utf8'));
  await writeFile(file, JSON.stringify(original));
  const first = await loadPrompts(file); assert.equal(Object.isFrozen(first), true);
  await writeFile(file, JSON.stringify({ ...original, generation: original.generation + '\n测试下一次读取。' }));
  const second = await loadPrompts(file); assert.notEqual(second.digest, first.digest);
  assert.equal(first.generation, original.generation); assert.ok(second.generation.endsWith('测试下一次读取。'));
  await writeFile(file, '{broken'); await assert.rejects(loadPrompts(file));
});
test('invalid or incompatible policies never silently fall back to an older prompt', async () => {
  const original = JSON.parse(await readFile(new URL('../prompts-v2.json', import.meta.url), 'utf8'));
  for (const value of [{ ...original, examplePolicy: 'unknown' }, { ...original, generation: '' }, { ...original, review: 5 }, { ...original, generation: 'a'.repeat(18001) }]) assert.throws(() => parsePrompts(JSON.stringify(value)));
  assert.throws(() => parsePrompts('a'.repeat(50001)));
});
