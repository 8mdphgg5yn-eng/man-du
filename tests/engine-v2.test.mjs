import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEngineLoader } from '../engine-loader.mjs';
import { sourcePlan, sourceExample, sourceExplanation, contractIssues, reviewMessagesV2, parseReviewV2 } from '../reader-engine.mjs';
import { getComplexFixture } from '../complex-fixtures.mjs';
import { INITIAL_PROMPTS } from '../prompts.mjs';
import { fixedReview } from './review-fixture.mjs';

for (const id of ['park','card']) test('source contract retains every anchored clause for ' + id, () => {
  const fixture = getComplexFixture(id); const plan = sourcePlan(fixture.input.quote);
  assert.ok(plan); assert.deepEqual(contractIssues(plan, fixture.good), []); assert.ok(contractIssues(plan, fixture.bad).length);
  for (const anchor of plan.anchors) {
    const answer = structuredClone(fixture.good); answer.example = answer.example.replace(anchor, '省掉的条件');
    assert.ok(contractIssues(plan, answer).some(x => x.field === 'example'));
  }
});
test('possible return cannot become unavoidable even if a later sentence says uncertain', () => {
  const f = getComplexFixture('park');
  for (const word of ['只能','只好','于是','必须']) {
    const answer = { ...f.good, example: f.good.example + `他们${word}返回，但不确定。` };
    assert.ok(contractIssues(sourcePlan(f.input.quote), answer).length);
  }
});
test('source contracts use new source words and do not silently broaden unrelated sentences', () => {
  const park = sourcePlan('只有周六上午没有下雪，而且图书馆正常开放，我们才去借书。即使出发了，也可能因为临时封路而返回。');
  assert.ok(park.anchors.includes('也可能因为临时封路而返回')); assert.equal(park.anchors.some(x => x.includes('公园')), false);
  const card = sourcePlan('在安静环境下时，这种语音提示可能让部分参加测试的人更容易找到按钮，但不能据此认定所有人都适用。');
  assert.ok(card.anchors.includes('可能让部分参加测试的人更容易找到按钮'));
  assert.equal(sourcePlan('明天可能下雨。'), null);
});
test('bound evidence reviews every nonempty field while empty fields are confirmed locally', () => {
  const f = getComplexFixture('park'); const answer = { ...f.good, uncertainty: '' };
  const data = JSON.parse(reviewMessagesV2(f.input, answer, [], INITIAL_PROMPTS)[1].content);
  assert.deepEqual(data.待检查字段, ['explanation','example']); assert.deepEqual(data.空字段, ['uncertainty']);
  const report = parseReviewV2(JSON.stringify(fixedReview(data)), f.input, answer, []);
  assert.equal(report.verdict, 'consistent'); assert.equal(report.checks.length, 3);
  assert.equal(report.checks.find(x => x.field === 'uncertainty').verdict, 'not_applicable');
  assert.equal(report.checks[0].candidate_quote, answer.explanation);
});
test('evidence IDs cannot be invented, duplicated, cross-bound or used to skip nonempty fields', () => {
  const f = getComplexFixture('park'); const data = JSON.parse(reviewMessagesV2(f.input, f.good, [], INITIAL_PROMPTS)[1].content);
  for (const mutate of [r => r.checks.pop(), r => r.checks.push(r.checks[0]), r => { r.checks[0].source_id = 'invented'; }, r => { r.checks[0].candidate_id = 'example'; }, r => { r.checks[2].verdict = 'not_applicable'; }, r => { r.example_quality.candidate_id = 'explanation'; }]) {
    const report = fixedReview(data); mutate(report); assert.throws(() => parseReviewV2(JSON.stringify(report), f.input, f.good, []));
  }
});
test('quality approval and valid evidence never override a semantic rejection or uncertainty', () => {
  const f = getComplexFixture('card'); const data = JSON.parse(reviewMessagesV2(f.input, f.good, [], INITIAL_PROMPTS)[1].content);
  assert.equal(parseReviewV2(JSON.stringify(fixedReview(data, { example: 'needs_revision' })), f.input, f.good, []).verdict, 'needs_revision');
  assert.equal(parseReviewV2(JSON.stringify(fixedReview(data, { example: 'uncertain' })), f.input, f.good, []).verdict, 'uncertain');
});
test('trusted engine reloads new code without replacing credentials or an in-flight snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reader-engine-')); t.after(() => rm(dir, {recursive:true,force:true}));
  const file = join(dir, 'engine.mjs');
  const source = n => `export const explain = async config => ({revision:${n}}); export const inspectSyntheticAnswer=()=>${n};`;
  await writeFile(file, source(1)); const load = createEngineLoader(pathToFileURL(file)); const first = await load();
  const configuration = Object.freeze({ configured:true, apiKey:'TEST_ONLY_KEY_NEVER_LOG' });
  await writeFile(file, source(2)); const second = await load();
  assert.equal((await first.explain(configuration)).revision, 1); assert.equal((await second.explain(configuration)).revision, 2); assert.equal(configuration.apiKey, 'TEST_ONLY_KEY_NEVER_LOG');
  await writeFile(file, 'bad javascript !'); await assert.rejects(load());
  await writeFile(file, source(3)); assert.equal((await load()).inspectSyntheticAnswer(), 3);
});

test('explicitly denying an unavoidable return is not the same as asserting one', () => {
  const f = getComplexFixture('park');
  const safe = { ...f.good, example: f.good.example + '不能说“只能返回”。' };
  assert.deepEqual(contractIssues(sourcePlan(f.input.quote), safe), []);
  const unsafe = { ...f.good, example: f.good.example + '不知道其他情况，他们只能返回。' };
  assert.ok(contractIssues(sourcePlan(f.input.quote), unsafe).length);
});

test('a contextual possibility must not gain an only-if restriction', () => {
  const f = getComplexFixture('card');
  for (const extra of ['只有光线充足才可能有效。', '光线充足才能读得轻松。']) {
    assert.ok(contractIssues(sourcePlan(f.input.quote), {...f.good, explanation: f.good.explanation + extra}).length);
  }
});

test('source scaffolds keep conditions and unknown results with concrete neutral actions', () => {
  for (const id of ['park','card']) {
    const f = getComplexFixture(id); const plan = sourcePlan(f.input.quote);
    const example = sourceExample(plan);
    assert.deepEqual(contractIssues(plan, {...f.good, explanation:sourceExplanation(plan), example}), []);
    assert.match(example, /假设/); assert.doesNotMatch(example, /只好返回|有人觉得更轻松/);
  }
  assert.equal(sourceExample(null), null);
  assert.equal(sourceExample(sourcePlan('在环境安静时，这种未知物件可能让部分参加测试的人更容易找到按钮，但不能据此认定所有人都适用。')), null);
});

test('known failure of a necessary condition cannot be described as unknown', () => {
  const f = getComplexFixture('park');
  for (const text of ['未满足这些条件时是否去公园，原文未说明。','也不表示未满足条件时一定不去或一定去。','未满足条件时也可能去。']) {
    const answer = {...f.good, explanation:f.good.explanation + text};
    assert.ok(contractIssues(sourcePlan(f.input.quote), answer).length);
  }
});

test('follow-up scaffolds change the action scene while retaining all source limits', () => {
  for (const id of ['park','card']) {
    const f=getComplexFixture(id), plan=sourcePlan(f.input.quote);
    assert.notEqual(sourceExample(plan), sourceExample(plan,true));
    assert.deepEqual(contractIssues(plan,{...f.good, example:sourceExample(plan,true)}),[]);
  }
});

test('captured wider regressions cannot add exclusive subsets or definite absence of a cause', () => {
  const answer={explanation:'只有部分孩子可能觉得卡片更好读。', example:'假设小林拿卡试读。',uncertainty:''};
  const data={quote:'部分孩子可能觉得卡片更好读。',context:'部分孩子可能觉得卡片更好读。'};
  assert.ok(contractIssues(null,answer,data).length);
  assert.deepEqual(contractIssues(null,{...answer,explanation:'部分孩子可能觉得卡片更好读。'},data),[]);
  assert.ok(contractIssues(null,{...answer,explanation:'不是取消与下雨存在因果关联。'},{quote:'今天的活动已经取消。',context:'明天可能下雨。今天的活动已经取消。'}).length);
});
