import { INITIAL_PROMPTS } from './prompts.mjs';
// Policy checks describe source fidelity; they do not verify the truth of the source.
export const FIDELITY_POLICY = 'modality-review-v1';
export const GENERATION_INSTRUCTION = INITIAL_PROMPTS.generation;

export const REVIEW_INSTRUCTION = INITIAL_PROMPTS.review;

const fields = ['explanation', 'example', 'uncertainty'];
const tentative = /可能|也许|或许|未必|不一定|尚不确定|不能确定|无法确定|似乎|大概/;
function hasTentative(text) { return tentative.test(text.replace(/不可能/g, '')); }
function strongAffirmation(text) {
  const clauses = text.split(/[，,。！？!?；;\n]/);
  return clauses.some(clause => {
    const match = /一定会|必然|必定|肯定会|保证|已证实|已经证明/.exec(clause);
    if (!match) return false;
    return !/不|未|没有|并非|而非|不是|无法/.test(clause.slice(0, match.index));
  });
}

export function scanFidelityRisks(data, answer) {
  const risks = [];
  for (const field of fields) {
    const text = answer[field]; if (!text) continue;
    const add = (kind, note) => risks.push({ id: `${field}:${kind}`, field, kind, note });
    if (hasTentative(data.quote) && !hasTentative(text)) add('missing_modality', '所选原文有不确定性词语，此字段没有同类词。也可能是在解释词语本身，需语义判断，不能仅凭词表判错。');
    if (hasTentative(data.quote) && strongAffirmation(text)) add('affirmative_certainty', '原文不确定，此字段出现正向确定性用语，需核对是否指向同一个命题。');
    if (/不一定|未必/.test(data.quote) && /一定不|肯定不|必定不/.test(text)) add('negated_probability', '可能把“不一定发生”改成了“一定不发生”。');
    if (/只有|才/.test(data.quote) && /只要[^。！？\n]*就|就一定/.test(text)) add('necessary_to_sufficient', '可能把必要条件改成了充分保证。');
  }
  return risks;
}

export function reviewMessages(data, answer, risks, prompts = INITIAL_PROMPTS) {
  return [{ role: 'system', content: prompts.review }, { role: 'user', content: JSON.stringify({ 上下文: data.context, 所选原文: data.quote, 候选回答: answer, 规则风险: risks }) }];
}

export function repairMessages(data, answer, report, prompts = INITIAL_PROMPTS) {
  return [{ role: 'system', content: prompts.generation }, { role: 'user', content: JSON.stringify({ 上下文: data.context, 所选原文: data.quote, 本次追问: data.question, 待修订回答: answer, 复核指出的问题: report, 修订要求: '按复核理由修正原意或补足具体场景；例子要有具体动作及对应的限制，不能只换词复述。解释和例子各自保留不确定性、条件和范围，不得靠额外提示遮盖强断言；不能为生动而补造结论。确实无法给出忠实例子时不举例，并说明原因。返回约定的四个 JSON 字段。' }) }];
}

export function parseReview(content, data, answer, risks) {
  if (typeof content !== 'string' || content.length > 18000) throw new Error('原意复核响应格式不正确。');
  let report;
  try { report = JSON.parse(content.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')); }
  catch { throw new Error('原意复核没有返回有效 JSON。'); }
  if (!report || !Array.isArray(report.checks) || report.checks.length !== fields.length || !Array.isArray(report.risks) || report.risks.length !== risks.length) throw new Error('原意复核未完整检查各字段及风险。');
  const seen = new Set(); let revise = false, uncertain = false;
  for (const check of report.checks) {
    if (!check || !fields.includes(check.field) || seen.has(check.field) || typeof check.reason !== 'string' || !check.reason.trim() || check.reason.length > 600 || typeof check.source_quote !== 'string' || typeof check.candidate_quote !== 'string') throw new Error('原意复核字段不完整。');
    seen.add(check.field);
    const text = answer[check.field];
    if (!text) {
      if (check.verdict !== 'not_applicable' || check.source_quote !== '' || check.candidate_quote !== '') throw new Error('原意复核的空字段状态不正确。');
    } else if (!['consistent', 'needs_revision', 'uncertain'].includes(check.verdict) || !check.source_quote.trim() || !check.candidate_quote.trim() || !data.context.includes(check.source_quote) || !text.includes(check.candidate_quote)) throw new Error('原意复核的依据与原文或候选文字不一致。');
    revise ||= check.verdict === 'needs_revision'; uncertain ||= check.verdict === 'uncertain';
  }
  const ids = new Set();
  for (const risk of report.risks) {
    if (!risk || !risks.some(item => item.id === risk.id) || ids.has(risk.id) || !['not_an_issue', 'issue', 'uncertain'].includes(risk.verdict) || typeof risk.reason !== 'string' || !risk.reason.trim() || risk.reason.length > 600) throw new Error('原意复核遗漏或混淆了规则风险。');
    ids.add(risk.id); revise ||= risk.verdict === 'issue'; uncertain ||= risk.verdict === 'uncertain';
  }
  const fidelityVerdict = uncertain ? 'uncertain' : revise ? 'needs_revision' : 'consistent';
  const quality = report.example_quality;
  if (!quality || !['concrete', 'needs_revision', 'uncertain', 'omitted'].includes(quality.verdict) || typeof quality.reason !== 'string' || !quality.reason.trim() || quality.reason.length > 600 || typeof quality.scene_quote !== 'string' || typeof quality.mapping_quote !== 'string') throw new Error('例子具体程度复核不完整。');
  if (answer.example) {
    if (quality.verdict === 'omitted' || !quality.scene_quote.trim() || !quality.mapping_quote.trim() || !answer.example.includes(quality.scene_quote) || !answer.example.includes(quality.mapping_quote)) throw new Error('例子的场景或原文对应引用不一致。');
  } else if (!['omitted', 'needs_revision', 'uncertain'].includes(quality.verdict) || quality.scene_quote !== '' || quality.mapping_quote !== '' || (quality.verdict === 'omitted' && !answer.uncertainty.trim())) throw new Error('省略例子时缺少原因或状态不一致。');
  revise ||= quality.verdict === 'needs_revision'; uncertain ||= quality.verdict === 'uncertain';
  return { verdict: uncertain ? 'uncertain' : revise ? 'needs_revision' : 'consistent', fidelityVerdict, checks: report.checks, risks: report.risks, example_quality: quality };
}
