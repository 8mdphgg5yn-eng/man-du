// Test-only protocol fixture. Its verdicts are scripted, never semantic validation.
export function fixedReview(data, verdicts = {}) {
  if (data.证据) return {
    checks: data.待检查字段.map(field => ({ field, verdict: verdicts[field] || 'consistent', source_id: 'source', candidate_id: field, reason: '固定测试判定，不证明语义可靠。' })),
    example_quality: data.候选回答.example ? { verdict: verdicts.quality || 'concrete', source_id: 'source', candidate_id: 'example', reason: '固定测试质量判定。' } : null,
    risks: data.规则风险.map(risk => ({ id: risk.id, verdict: verdicts.risk || 'not_an_issue', reason: '固定测试风险判定。' }))
  };
  return {
    checks: ['explanation', 'example', 'uncertainty'].map(field => ({
      field, verdict: data.候选回答[field] ? verdicts[field] || 'consistent' : 'not_applicable',
      source_quote: data.候选回答[field] ? data.所选原文 : '',
      candidate_quote: data.候选回答[field] || '', reason: '固定测试判定，仅检查流程。'
    })),
    example_quality: { verdict: data.候选回答.example ? verdicts.quality || 'concrete' : verdicts.quality || 'omitted', scene_quote: data.候选回答.example || '', mapping_quote: data.候选回答.example || '', reason: '固定测试质量判定，不证明例子真实具体。' },
    risks: data.规则风险.map(risk => ({ id: risk.id, verdict: verdicts.risk || 'not_an_issue', reason: '固定测试判定，仅检查协议。' }))
  };
}
