const test = require('node:test');
const assert = require('node:assert/strict');
const { splitText, findTerms, samples, createExplanationRequest } = require('../core.js');

test('every source character and its location survive segmentation', () => {
  const cases = [samples.water.text, samples.verify.text, '  开头\n\n中间。\n\n', '\n\n甲。\n乙。', 'a\r\n\r\nb\n', '如果条件成立，才可以继续。'.repeat(30), '😀<script>alert("x")</script>\n金额：100.00；不得省略。', '没有标点的长内容'.repeat(500)];
  for (const source of cases) {
    const segments = splitText(source);
    assert.equal(segments.map(segment => segment.text).join(''), source);
    assert.equal(segments[0].start, 0);
    assert.equal(segments.at(-1).end, source.length);
    segments.forEach((segment, index) => {
      assert.equal(source.slice(segment.start, segment.end), segment.text);
      assert.ok(segment.text.trim());
      if (index) assert.equal(segments[index - 1].end, segment.start);
    });
  }
});
test('blank input creates no reading segments', () => {
  for (const source of ['', ' \n\t', null, undefined]) assert.deepEqual(splitText(source), []);
});
test('glossary matches exact words and retains correct source positions', () => {
  const source = '水蒸气凝结。需要核实来源，而不是把推测当作证据。';
  const matches = findTerms(source);
  assert.deepEqual(matches.map(match => match.term), ['水蒸气', '凝结', '核实', '来源', '推测', '证据']);
  for (const match of matches) assert.equal(source.slice(match.start, match.end), match.term);
  assert.deepEqual(findTerms('这是词库尚未收录的内容。'), []);
});

test('AI selection is bound to exact original position, including repeated words', () => {
  const source = '开头。\n\n如果条件满足，才可以继续。如果条件不满足，则不能继续。\n\n后文。';
  const segments = splitText(source);
  assert.throws(() => createExplanationRequest(source, segments, 1, '如果'), /多处/);
  const second = segments[1].text.lastIndexOf('如果');
  const request = createExplanationRequest(source, segments, 1, '如果', second);
  assert.equal(request.context.slice(request.start, request.end), request.quote);
  assert.equal(request.start, segments[1].start + second);
  assert.equal(request.context, source);
  assert.throws(() => createExplanationRequest(source, segments, 1, '一定可以继续'), /必须是/);
});

test('AI context remains bounded without altering the selected paragraph', () => {
  const source = '甲'.repeat(4000) + '\n\n' + '乙'.repeat(3000) + '\n\n' + '丙'.repeat(1000);
  const segments = splitText(source);
  const request = createExplanationRequest(source, segments, 1, '乙'.repeat(1000), 0);
  assert.ok(request.context.length <= 6000);
  assert.equal(request.context, source.slice(segments[1].start));
  assert.equal(request.context.slice(request.start, request.end), request.quote);
  assert.throws(() => createExplanationRequest('甲'.repeat(6001), splitText('甲'.repeat(6001)), 0, '甲', 0), /太长/);
});
