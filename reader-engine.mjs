// Version 2: fixed evidence IDs, local source contracts, at most four model calls.
import { loadPrompts } from './prompts.mjs';
import { ReaderError, validateRequest, parseAnswer, callModel, payloadForMessages } from './model.mjs';
import { scanFidelityRisks } from './fidelity.mjs';
export const POLICY = 'modality-review-v2';
const ENGINE_REVISION = new URL(import.meta.url).searchParams.get('revision') || 'static-test';
const fields = ['explanation', 'example', 'uncertainty'];
const escapeRE = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function sourcePlan(quote) {
  let match = /^只有([^，。]{1,100})，而且([^，。]{1,100})，([^，。]{1,30})才([^。]{1,80})。即使([^，。]{1,60})，也可能因为([^，。]{1,80})而([^。]{1,50})。?$/.exec(quote);
  if (match) return { type: 'necessary-and-possible-return', anchors: [match[1], match[2], match[4], `也可能因为${match[6]}而${match[7]}`], actor:match[3], action: match[4], departure: match[5], outcome: match[7], note: '解释与例子均逐字保留这些短句，并各自原样写出“不保证一定”。两项仅为必要条件。可能修饰完整的因果返回短句。具体动作放在假设准备场景，不补造已闭园或已返回的情节。' };
  match = /^在([^，。]{1,80})时，([^，。]{1,80})可能让部分([^，。]{1,100}?)(读起来[^，。]{1,60}|更容易[^，。]{1,60})，但(不能据此[^。]{1,100})。?$/.exec(quote);
  if (match) return { type: 'context-subset-possible-effect', anchors: [match[1], match[2].replace(/^(这种|这类|该)/, ''), `可能让部分${match[3]}${match[4]}`, match[5]], condition: match[1], group: match[3], effect: match[4], note: '解释与例子均逐字保留这些短句。“在……时”仅限定本句的适用情境，不得新增“只有……才……”或声称其他情境不可能有效。具体人物只是假设参与者，不保证其获得效果。' };
  return null;
}
// A visible, source-bound scaffold, applied before review, never an unchecked fallback.
// Actions add only hypothetical preparation/use, never an observed effect or a new condition.
export function sourceExample(plan, alternate = false) {
  if (!plan) return null;
  const [a, b, possible, limit] = plan.anchors;
  if (plan.type === 'necessary-and-possible-return') {
    const action = /下雨|下雪/.test(a) && /开放/.test(b) ? (alternate ? '假设小林和朋友出发前通电话，一人查看天气预报，一人查看场所的开放通知，一起核对' : '假设小林出发前打开天气预报，又查看场所的开放通知，逐项核对') : (alternate ? '假设小林和朋友出发前通电话，两人逐项对照' : '假设小林出发前拿出一张计划纸，逐项核对');
    return `${action}“${a}”和“${b}”。少一项，就不${plan.action}；两项都满足，也不保证一定${plan.action}。即使${plan.departure}，${limit}；是否真的${plan.outcome}，这里没有确定。`;
  }
  if (plan.type === 'context-subset-possible-effect') {
    let action;
    if (b === '大字说明卡' && plan.effect === '读起来更轻松') action = alternate ? `把${b}放在桌上，用手指着其中一句说明读` : `拿起一张${b}，读了一句说明`;
    else if (b === '语音提示' && plan.effect === '更容易找到按钮') action = alternate ? `在操作界面点击播放${b}，再试着寻找按钮` : `播放一次${b}，试着寻找按钮`;
    else return null; // Do not invent how an unfamiliar object is used.
    return `假设小林是${plan.group}中的一位。在${a}时，他${action}。${b}${possible}，但小林是否${plan.effect}还不知道；${limit}，其他人是否适合也不能由此确定。`;
  }
  return null;
}
export function sourceExplanation(plan) {
  if (!sourceExample(plan)) return null;
  const [a,b,possible,limit]=plan.anchors;
  if (plan.type === 'necessary-and-possible-return') return `按原句，${plan.actor}${plan.action}需要“${a}”和“${b}”同时满足。少一项，就不${plan.action}；两项都满足，也不保证一定${plan.action}。即使${plan.departure}，${limit}，这是可能发生的情况。`;
  return `这句话说明：在${a}时，${b}${possible}。这只是可能的效果，不保证某位参与者${plan.effect}；${limit}。`;
}
function prepareCandidate(answer, plan, alternate) {
  const example = sourceExample(plan, alternate);
  const uncertainty = plan?.type === 'necessary-and-possible-return' ? `所选这句话说“${plan.anchors[3]}”，并未说明已经${plan.outcome}；是否实际${plan.action}或${plan.outcome}没有确定。` : `所选这句话说“${plan?.anchors[2]}”，没有说明具体哪些人会${plan?.effect}，也没有说明其他情境下的效果。`;
  return normalize(example ? { ...answer, explanation:sourceExplanation(plan), example, uncertainty } : answer);
}
export function contractIssues(plan, answer, data) {
  const issues = [];
  if (!answer.example.trim() && !answer.uncertainty.trim()) issues.push({ field: 'example', reason: '未提供例子，也未说明具体困难。' });
  if (data) {
    for (const field of fields) {
      if (/部分/.test(data.quote) && !/只有|仅有/.test(data.context) && /(?:只有|仅有)[^。；]{0,12}部分/.test(answer[field])) issues.push({field, reason:'“部分”不等于“只有部分”；原文没有排除其他人也可能有这种感受。'});
      if (!/(?:不是|不存在)[^。；]{0,60}(?:关联|因果)/.test(data.context) && /(?:不是[^。；]{0,40}存在[^。；]{0,20}关联|不存在[^。；]{0,30}因果)/.test(answer[field])) issues.push({field,reason:'原文未说明因果关系不等于明确没有因果关系；不能增添确定的否定。'});
    }
    if (/试用/.test(data.quote) && /卡片/.test(data.quote) && answer.example && !/拿|读|看|指|放/.test(answer.example)) issues.push({field:'example',reason:'卡片试用例子缺少实际拿卡、查看或试读动作，不能只换人物重复可能感受。'});
  }
  if (!plan) return issues;
  for (const field of ['explanation', 'example']) {
    for (const anchor of plan.anchors) if (!answer[field].includes(anchor)) issues.push({ field, reason: `该句式的表达约定要求完整保留原文短句：${anchor}` });
    if (plan.outcome) {
      const expression = new RegExp(`(?:只好|只能|必须|必定|就得|于是|就只好)\\s*${escapeRE(plan.outcome)}`, 'g');
      const asserted = [...answer[field].matchAll(expression)].some(match => !/(?:不能说|不可说|不能写成|不要写成|不是|并非|而不是|而非)[“「"\s]*$/.test(answer[field].slice(0, match.index)));
      if (asserted) issues.push({ field, reason: '不能把可能结果写成只好、只能或于是发生；重写整个因果可能句，不只是替换一个词。' });
    }
    if (plan.type === 'necessary-and-possible-return') {
      if (!/不保证|不代表一定|不等于一定|没有保证|并未保证/.test(answer[field])) issues.push({ field, reason: '请明确两项条件满足也不保证一定去，不得改成充分保证。' });
      if (/(?:未满足|不满足|缺少|缺一|不具备)[^。；]{0,50}(?:未说明|不确定|不知道|未知)/.test(answer[field])) issues.push({field, reason: `必要条件缺少一项时不${plan.action}，这是已知限制；不能写成未满足条件时是否行动未知。`});
      if (/不(?:表示|代表|意味着)[^。；]{0,10}(?:未满足|不满足)[^。；]{0,30}不去|(?:未满足|不满足)[^。；]{0,25}(?:也可能去|未必不去|不一定不去)/.test(answer[field])) issues.push({field,reason:`原文明确缺少必要条件就不${plan.action}，不能再否认这一限制或允许未满足条件时行动。`});
    }
    if (plan.type === 'context-subset-possible-effect' && /只有|仅当|必须|才可能|才能/.test(answer[field])) issues.push({ field, reason: '原文只说明在该情境时可能有效，没有说只有该情境才有效；请用“在……时”，删除新增的必要性限制。' });
  }
  return issues;
}
function normalize(answer) { for (const field of ['example', 'uncertainty']) if (!answer[field].trim()) answer[field] = ''; return answer; }
export function reviewMessagesV2(data, answer, risks, prompts, formatRetry = false) {
  const active = fields.filter(field => answer[field] !== '');
  return [{ role: 'system', content: prompts.review + (formatRetry ? '\n格式重试：只返回待检查字段的完整列表与合法编号。重新判断内容，不因格式错误强行通过。' : '') }, { role: 'user', content: JSON.stringify({ 上下文: data.context, 所选原文: data.quote, 证据: { source: data.context, ...Object.fromEntries(active.map(field => [field, answer[field]])) }, 待检查字段: active, 空字段: fields.filter(field => !active.includes(field)), 候选回答: answer, 原文约束清单: sourcePlan(data.quote), 规则风险: risks }) }];
}
export function parseReviewV2(raw, data, answer, risks) {
  if (typeof raw !== 'string' || raw.length > 18000) throw new Error('复核内容格式不正确。');
  const report = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1'));
  const active = fields.filter(field => answer[field] !== '');
  if (!report || !Array.isArray(report.checks) || report.checks.length !== active.length || !Array.isArray(report.risks) || report.risks.length !== risks.length) throw new Error('复核缺少字段或风险。');
  let revise = false, uncertain = false; const seen = new Set(); const checks = [];
  const reasonOK = reason => typeof reason === 'string' && reason.trim() && reason.length <= 600;
  for (const item of report.checks) {
    if (!item || !active.includes(item.field) || seen.has(item.field) || !['consistent', 'needs_revision', 'uncertain'].includes(item.verdict) || item.source_id !== 'source' || item.candidate_id !== item.field || !reasonOK(item.reason)) throw new Error('复核字段状态或引用编号错误。');
    seen.add(item.field); checks.push({ ...item, source_quote: data.context, candidate_quote: answer[item.field] });
    revise ||= item.verdict === 'needs_revision'; uncertain ||= item.verdict === 'uncertain';
  }
  for (const field of fields.filter(field => !active.includes(field))) checks.push({ field, verdict: 'not_applicable', source_quote: '', candidate_quote: '', reason: '本地确认空字段，无需模型判断。' });
  const ids = new Set();
  for (const item of report.risks) {
    if (!item || !risks.some(risk => risk.id === item.id) || ids.has(item.id) || !['not_an_issue','issue','uncertain'].includes(item.verdict) || !reasonOK(item.reason)) throw new Error('复核风险编号错误。');
    ids.add(item.id); revise ||= item.verdict === 'issue'; uncertain ||= item.verdict === 'uncertain';
  }
  const fidelityVerdict = uncertain ? 'uncertain' : revise ? 'needs_revision' : 'consistent';
  let quality = report.example_quality;
  if (answer.example) {
    if (!quality || !['concrete','needs_revision','uncertain'].includes(quality.verdict) || quality.source_id !== 'source' || quality.candidate_id !== 'example' || !reasonOK(quality.reason)) throw new Error('例子质量的引用编号或状态错误。');
    revise ||= quality.verdict === 'needs_revision'; uncertain ||= quality.verdict === 'uncertain';
  } else {
    if (quality != null || !answer.uncertainty.trim()) throw new Error('省略例子时需说明原因，且不能伪造例子复核。');
    quality = { verdict: 'omitted', reason: '已给出省略原因。' };
  }
  return { verdict: uncertain ? 'uncertain' : revise ? 'needs_revision' : 'consistent', fidelityVerdict, checks, risks: report.risks, example_quality: quality };
}
function generationMessages(data, prompts, candidate, report) {
  return [{ role: 'system', content: prompts.generation }, { role: 'user', content: JSON.stringify({ 上下文: data.context, 所选原文: data.quote, 本次追问: data.question, 上次解释: data.previous, 原文约束清单: sourcePlan(data.quote), ...(candidate ? { 待修订回答: candidate, 修订依据: report, 修订要求: '按约束清单逐字保留锚点，修正整个错误命题。具体动作只补在假设背景；不得只换掉“只好”而留下“于是返回”。' } : {}) }) }];
}
export async function explain(config, input, signal, observe) {
  if (!config.configured) throw new ReaderError(503, '尚未配置模型。分段阅读仍可使用。');
  const data = validateRequest(input);
  if (!config.local && input.cloudConsent !== true) throw new ReaderError(400, '请先确认本次页面允许发送到所示云端模型。');
  let prompts; try { prompts = await loadPrompts(); } catch { throw new ReaderError(503, '本地解释规则暂不可用。', 'PROMPT_POLICY_UNAVAILABLE'); }
  const combined = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]);
  let calls = 0, repairs = 0, reviewRetries = 0;
  const emit = (stage, detail = {}) => observe?.(structuredClone({ stage, calls, repairs, reviewRetries, ...detail }));
  const invoke = async (messages, maxTokens = 1000) => { if (calls >= 4 || combined.aborted) throw new ReaderError(504, '本次解释已停止或达到调用上限。'); calls++; return callModel(config, payloadForMessages(config, messages, maxTokens), combined); };
  const plan = sourcePlan(data.quote);
  const alternate = Boolean(data.question) && !data.previous.includes('通电话') && !data.previous.includes('用手指着') && !data.previous.includes('操作界面点击');
  let candidate = prepareCandidate(parseAnswer(await invoke(generationMessages(data, prompts)), data.context), plan, alternate);
  for (;;) {
    emit('candidate', { answer: candidate, exampleConstruction: sourceExample(plan) ? 'source-scaffold' : 'model', promptDigest: prompts.digest });
    const issues = contractIssues(plan, candidate, data);
    let report;
    if (issues.length) {
      emit('contract', { issues }); report = { issues, verdict: 'needs_revision' };
    } else {
      const risks = scanFidelityRisks(data, candidate);
      for (;;) {
        let raw;
        try {
          raw = await invoke(reviewMessagesV2(data, candidate, risks, prompts, reviewRetries > 0), 1200);
          report = parseReviewV2(raw, data, candidate, risks); emit('review', { report, risks }); break;
        } catch (error) {
          if (error instanceof ReaderError) throw error;
          emit('review_error', { message: error.message, raw: typeof raw === 'string' ? raw.slice(0,18000) : null });
          if (reviewRetries >= 1 || calls >= 4) throw new ReaderError(502, '原意复核的格式未通过检查，本次结果不展示。', 'FIDELITY_REVIEW_INVALID');
          reviewRetries++;
        }
      }
      if (combined.aborted) throw new ReaderError(504, '本次解释已停止或等待超时。');
      if (report.verdict === 'consistent') return { ...candidate, quote: data.quote, start: data.start, end: data.end, model: config.model, fidelity: { policy: POLICY, engineRevision: ENGINE_REVISION, state: 'model_reviewed', method: 'same-model', checkedFields: fields, modelReviewedFields: fields.filter(field => candidate[field] !== ''), repairs, reviewRetries, calls, citations: 'bound', examplePolicy: prompts.examplePolicy, exampleQuality: report.example_quality.verdict, promptDigest: prompts.digest, sourceContract: plan?.type || null, exampleConstruction: sourceExample(plan) ? 'source-scaffold' : 'model', explanationConstruction: sourceExample(plan) ? 'source-scaffold' : 'model' } };
      if (report.verdict === 'uncertain' || sourceExample(plan)) throw new ReaderError(422, '仍无法确认这次解释或例子是否保留原意，本次暂不展示。', report.fidelityVerdict === 'consistent' ? 'EXAMPLE_REVIEW_BLOCKED' : 'FIDELITY_REVIEW_BLOCKED');
    }
    if (repairs >= 1 || calls > 2) throw new ReaderError(422, '这次解释或例子仍未保留全部条件、可能性或范围，本次暂不展示。', issues.length ? 'SOURCE_CONTRACT_BLOCKED' : report.fidelityVerdict === 'consistent' ? 'EXAMPLE_REVIEW_BLOCKED' : 'FIDELITY_REVIEW_BLOCKED');
    candidate = prepareCandidate(parseAnswer(await invoke(generationMessages(data, prompts, candidate, report)), data.context), plan, alternate); repairs++;
  }
}
export async function inspectSyntheticAnswer(config, input, answer, signal) {
  if (!config.configured) throw new ReaderError(503, '尚未配置模型。');
  const data = validateRequest(input); const candidate = normalize(parseAnswer(JSON.stringify(answer), data.context));
  if (!config.local && input.cloudConsent !== true) throw new ReaderError(400, '缺少测试发送允许。');
  const prompts = await loadPrompts(); const risks = scanFidelityRisks(data, candidate);
  const raw = await callModel(config, payloadForMessages(config, reviewMessagesV2(data, candidate, risks, prompts), 1200), signal);
  try { return { engineRevision: ENGINE_REVISION, promptDigest: prompts.digest, candidate, risks, report: parseReviewV2(raw, data, candidate, risks), contractIssues: contractIssues(sourcePlan(data.quote), candidate, data), calls: 1 }; }
  catch { throw new ReaderError(502, '固定样例的复核协议不完整。', 'FIDELITY_REVIEW_INVALID'); }
}
