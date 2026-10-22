import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseReview, reviewMessages, repairMessages, scanFidelityRisks, GENERATION_INSTRUCTION } from '../fidelity.mjs';
import { fixedReview } from './review-fixture.mjs';
const source = '结果可能适用于参与者，但不能确定所有儿童都有同样情况。';
const data = { context: source, quote: source, question: '' };
const bad = { explanation: '结果也许适用于参与者。', example: '假设调查一班学生，结果只说明这些学生的情况。', uncertainty: '' };
const risks = scanFidelityRisks(data, bad);
const payload = JSON.parse(reviewMessages(data, bad, risks)[1].content);
const parse = report => parseReview(JSON.stringify(report), data, bad, risks);

test('known survey example is flagged independently of tentative explanation', () => {
  assert.deepEqual(risks.map(r => r.id), ['example:missing_modality']);
  const report = fixedReview(payload, { example: 'needs_revision', risk: 'issue' });
  assert.equal(parse(report).verdict, 'needs_revision');
  const repair = JSON.parse(repairMessages(data, bad, parse(report))[1].content);
  assert.equal(repair.待修订回答.example, bad.example);
  assert.ok(GENERATION_INSTRUCTION.includes('不能用 uncertainty'));
});
test('risk hints detect negation and necessary-condition inversions, allowing negated guarantees', () => {
  const riskIds = (quote, explanation) => scanFidelityRisks({ quote }, { explanation, example: '', uncertainty: '' }).map(r => r.kind);
  assert.ok(riskIds('不一定入选。', '一定不能入选。').includes('negated_probability'));
  assert.ok(riskIds('只有不下雨才去。', '只要不下雨就去。').includes('necessary_to_sufficient'));
  assert.equal(riskIds('可能下雨。', '不能保证一定会下雨。').includes('affirmative_certainty'), false);
  assert.equal(riskIds('可能下雨。', '也许下雨；一定会变冷。').includes('affirmative_certainty'), true);
  assert.equal(riskIds('不可能入选。', '不能入选。').includes('missing_modality'), false);
});
test('mixed context does not force uncertainty onto a definite selected sentence', () => {
  assert.deepEqual(scanFidelityRisks({ quote: '今天的活动已经取消。', context: '明天可能下雨。今天的活动已经取消。' }, { explanation: '今天的活动取消了。', example: '', uncertainty: '' }), []);
});
test('review must cover each field and exact source/candidate evidence', () => {
  assert.equal(parse(fixedReview(payload)).verdict, 'consistent');
  for (const mutate of [
    r => r.checks.pop(), r => { r.checks[1] = r.checks[0]; },
    r => { r.checks[1].source_quote = '所有人一定适用'; },
    r => { r.checks[1].candidate_quote = '例子并没有这句话'; },
    r => { r.checks[2].verdict = 'consistent'; },
    r => { r.checks[0].reason = ''; },
    r => { r.checks[0].verdict = 'passed'; },
    r => { r.checks[1].candidate_quote = ''; }
  ]) { const report = fixedReview(payload); mutate(report); assert.throws(() => parse(report)); }
});
test('review cannot omit risk responses, invent risk ids or force uncertain into approval', () => {
  for (const mutate of [r => r.risks.pop(), r => { r.risks[0].id = 'invented'; }, r => r.risks.push(r.risks[0])]) {
    const report = fixedReview(payload); mutate(report); assert.throws(() => parse(report));
  }
  assert.equal(parse(fixedReview(payload, { example: 'uncertain' })).verdict, 'uncertain');
  assert.equal(parse(fixedReview(payload, { risk: 'uncertain' })).verdict, 'uncertain');
});
test('regression corpus includes probability, scope, negation, necessary conditions and style pressure', async () => {
  const cases = JSON.parse(await readFile(new URL('./fidelity-cases.json', import.meta.url)));
  assert.equal(cases.length, 8); assert.equal(new Set(cases.map(c => c.id)).size, 8);
  assert.ok(cases.every(c => c.source && c.badExplanation && c.badExample && c.expected));
  const pressured = cases.find(c => c.question);
  assert.ok(GENERATION_INSTRUCTION.includes('追问只改变解释方式'));
  assert.equal(pressured.id, 'style-pressure');
});

test('a faithful but abstract example must still be revised when the quality review flags it', () => {
  const report = parse(fixedReview(payload, { quality: 'needs_revision' }));
  assert.equal(report.fidelityVerdict, 'consistent'); assert.equal(report.verdict, 'needs_revision');
  assert.equal(report.example_quality.verdict, 'needs_revision');
});
test('concrete scenes cannot override a review finding that the example changed the source', () => {
  const report = parse(fixedReview(payload, { example: 'needs_revision', quality: 'concrete' }));
  assert.equal(report.verdict, 'needs_revision'); assert.equal(report.fidelityVerdict, 'needs_revision');
});
test('example review requires grounded scene and mapping quotes, not merely an approval label', () => {
  for (const mutate of [r => { delete r.example_quality; }, r => { r.example_quality.scene_quote = '书中没有的人物动作'; }, r => { r.example_quality.mapping_quote = ''; }, r => { r.example_quality.verdict = 'omitted'; }, r => { r.example_quality.reason = ''; }]) {
    const report = fixedReview(payload); mutate(report); assert.throws(() => parse(report));
  }
  assert.equal(parse(fixedReview(payload, { quality: 'uncertain' })).verdict, 'uncertain');
});
test('omission requires an explanation, and an unnecessary omission can trigger revision', () => {
  const noExample = { ...bad, example: '', uncertainty: '这段缺少描述具体动作所需的信息，本次不举例。' };
  const risk = scanFidelityRisks(data, noExample);
  const value = JSON.parse(reviewMessages(data, noExample, risk)[1].content);
  assert.equal(parseReview(JSON.stringify(fixedReview(value)), data, noExample, risk).verdict, 'consistent');
  assert.equal(parseReview(JSON.stringify(fixedReview(value, { quality: 'needs_revision' })), data, noExample, risk).verdict, 'needs_revision');
  noExample.uncertainty = ''; const emptyRisk = scanFidelityRisks(data, noExample);
  const emptyPayload = JSON.parse(reviewMessages(data, noExample, emptyRisk)[1].content);
  assert.throws(() => parseReview(JSON.stringify(fixedReview(emptyPayload)), data, noExample, emptyRisk));
});

test('captured complex review cannot label a nonempty uncertainty field as empty', async () => {
  const fixture = JSON.parse(await readFile(new URL('./complex-review-regression.json', import.meta.url)));
  assert.ok(fixture.candidate.uncertainty.trim());
  const risks = scanFidelityRisks(fixture.input, fixture.candidate);
  assert.throws(() => parseReview(fixture.rawReview, fixture.input, fixture.candidate, risks), /依据与原文或候选文字不一致/);
  const corrected = JSON.parse(fixture.rawReview);
  const field = corrected.checks.find(x => x.field === 'uncertainty');
  Object.assign(field, { verdict: 'consistent', source_quote: '可能让部分参加试用的人读起来更轻松', candidate_quote: '既没有保证任何一位参加者会觉得轻松', reason: '仅修正误报的空状态并给出真实引用；保留全部语义检查。' });
  assert.equal(parseReview(JSON.stringify(corrected), fixture.input, fixture.candidate, risks).verdict, 'consistent');
});

test('captured complex reviews cannot paraphrase candidate quotes or cite candidates as source', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./complex-quote-regressions.json', import.meta.url)));
  assert.equal(fixtures.length, 2);
  for (const fixture of fixtures) {
    const report = JSON.parse(fixture.rawReview);
    assert.ok(report.checks.some(check => (check.source_quote && !fixture.input.context.includes(check.source_quote)) || (check.candidate_quote && !fixture.candidate[check.field].includes(check.candidate_quote))));
    assert.throws(() => parseReview(fixture.rawReview, fixture.input, fixture.candidate, scanFidelityRisks(fixture.input, fixture.candidate)), /依据与原文或候选文字不一致/);
  }
});
