/* Pure text operations shared by the browser and Node's built-in tests. */
(function (root) {
  'use strict';
  const glossary = Object.freeze([
    { term: '水蒸气', meaning: '水变成气体后的状态。它通常看不见。', example: '地上的水慢慢变干，其中一部分变成了水蒸气。' },
    { term: '蒸发', meaning: '液体表面的水等物质，慢慢变成气体。', example: '晾着的湿衣服慢慢变干，就有水蒸发的过程。' },
    { term: '凝结', meaning: '气体变成液体的过程。', example: '水蒸气碰到冷杯壁，可能变成小水珠。' },
    { term: '降水', meaning: '水从云中落到地面的现象，包括雨、雪等。', example: '下雨和下雪都属于降水。' },
    { term: '核实', meaning: '找材料、做检查，确认一个说法是否准确。', example: '看到活动时间后，再到主办方的通知中查一遍。' },
    { term: '来源', meaning: '一条信息原本来自哪里。', example: '一本书、一份通知或一段亲自观察的记录，都可能是信息的来源。' },
    { term: '证据', meaning: '能够帮助判断一个说法是否成立的材料。', example: '想知道昨天有没有下雨，可以查看当地的天气记录。' },
    { term: '推测', meaning: '根据已有信息作出的猜想，还需要进一步确认。', example: '看到地面湿了，猜想刚下过雨；也可能是有人洒了水。' },
    { term: '条件', meaning: '一件事成立或发生时，需要具备的情况。', example: '“如果明天不下雨，就去公园”中的“不下雨”是一个条件。' }
  ]);
  const samples = Object.freeze({
    water: {
      title: '云是怎么变成雨的？',
      text: '太阳照着地面，河流、湖泊和土壤中的一部分水会蒸发，变成水蒸气，进入空气。\n\n含有水蒸气的空气上升后，如果温度降低到一定程度，水蒸气会凝结成小水滴，或形成小冰晶。许多小水滴或小冰晶聚在一起，就形成了云。\n\n云里的小水滴会碰撞、合并，慢慢变大。当它们大到空气无法继续托住时，就会向下落。如果落到地面时是液态的水，我们就把它叫作雨。\n\n并不是每一朵云都会下雨。云里的水滴或冰晶是否能长大，以及下落途中会发生什么，都影响最终是否出现降水。'
    },
    verify: {
      title: '怎样核实 AI 的回答？',
      text: 'AI 可以帮助我们理解问题、整理想法，但回答得流畅，并不代表说得准确。遇到重要信息，我们还需要核实。\n\n可以先问：“这个说法的来源在哪里？”然后真的打开对应的书、通知或网页，看它是否存在，是否支持这个说法。只看到一个来源名称，还不够。\n\n再分清事实和推测。比如，“地面是湿的”是一项观察；“刚才下过雨”是一种推测。地面湿了，也可能是有人洒了水。我们需要更多证据。\n\n还要留意条件。“如果明天不下雨，就去公园”不等于“明天一定去公园”。请 AI 解释时，也要检查它有没有漏掉这些条件。'
    }
  });

  function splitText(source) {
    if (typeof source !== 'string' || !source.trim()) return [];
    const segments = [];
    const boundaries = new Set([source.length]);
    for (const match of source.matchAll(/\n+/g)) boundaries.add(match.index + match[0].length);
    let start = 0;
    let paragraphStart = 0;
    for (let i = 0; i < source.length; i++) {
      if (/[。！？!?]/u.test(source[i]) && i - paragraphStart >= 119) {
        let end = i + 1;
        while (end < source.length && /[”’」』"'）】]/u.test(source[end])) end++;
        boundaries.add(end);
        paragraphStart = end;
      }
      if (source[i] === '\n') paragraphStart = i + 1;
    }
    for (const end of [...boundaries].sort((a, b) => a - b)) {
      const text = source.slice(start, end);
      if (!text.trim() && segments.length) {
        const previous = segments[segments.length - 1];
        previous.end = end;
        previous.text = source.slice(previous.start, end);
      } else if (text.trim()) {
        segments.push({ start, end, text });
      } else {
        continue; // Leading whitespace remains attached to the first visible segment.
      }
      start = end;
    }
    return segments;
  }

  function findTerms(text) {
    const found = [];
    const ordered = [...glossary].sort((a, b) => b.term.length - a.term.length);
    for (let offset = 0; offset < text.length;) {
      const entry = ordered.find(item => text.startsWith(item.term, offset));
      if (entry) {
        found.push({ ...entry, start: offset, end: offset + entry.term.length });
        offset += entry.term.length;
      } else offset++;
    }
    return found;
  }

  function createExplanationRequest(source, segments, index, target, preferredStart = null) {
    const current = segments[index];
    const quote = target.trim();
    if (!current || !quote) throw new Error('请选中本段的词句，或选择“使用整段”。');
    if (quote.length > 1200) throw new Error('这次选中的内容较长，请选不超过 1200 个字符的词句。');
    let offset = preferredStart;
    if (!Number.isInteger(offset) || current.text.slice(offset, offset + quote.length) !== quote) {
      offset = current.text.indexOf(quote);
      if (offset < 0) throw new Error('要解释的内容必须是当前段落中的原文。');
      if (current.text.indexOf(quote, offset + 1) !== -1) throw new Error('这段原文中有多处相同文字，请在阅读区选中具体的一处，或使用整段。');
    }
    if (current.text.length > 6000) throw new Error('这一段太长，暂不发送给模型。请放入较短的完整原文后再试。');
    let start = current.start;
    let end = current.end;
    if (index > 0 && end - segments[index - 1].start <= 6000) start = segments[index - 1].start;
    if (index + 1 < segments.length && segments[index + 1].end - start <= 6000) end = segments[index + 1].end;
    const selectionStart = current.start + offset - start;
    return { context: source.slice(start, end), quote, start: selectionStart, end: selectionStart + quote.length };
  }

  const api = { splitText, findTerms, samples, createExplanationRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EasyReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
