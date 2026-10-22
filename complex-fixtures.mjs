// Self-authored public test data. No caller-supplied source or candidate is accepted.
const definitions = {
  park: {
    source: '只有明天上午没有下雨，而且公园正常开放，我们才去公园。即使出发了，也可能因为临时闭园而返回。',
    good: {
      explanation: '去公园需要明天上午没有下雨和公园正常开放，但条件都满足也不保证一定去。即使出发了，也可能因为临时闭园而返回。',
      example: '假设小林一家明早想去公园，先查看天气和开放通知。明天上午没有下雨、公园正常开放，这两项缺一不可，但都满足也不保证一定去。即使出发了，也可能因为临时闭园而返回。',
      conditions: ['只有明天上午没有下雨，而且公园正常开放，我们才去公园。', '即使出发了，也可能因为临时闭园而返回。'],
      uncertainty: '原文未保证出发，也没有说遇到闭园时只能返回。'
    },
    bad: {
      explanation: '只要明天上午不下雨且公园开放，我们就一定去公园。',
      example: '假设小林一家明早看到天晴且公园开放，就一定出发。若临时闭园，他们只能返回。',
      conditions: ['明天上午没有下雨', '公园正常开放'], uncertainty: ''
    }
  },
  card: {
    source: '在光线充足时，这种大字说明卡可能让部分参加试用的人读起来更轻松，但不能据此判断所有人都适合。',
    good: {
      explanation: '在光线充足的情况下，这种大字说明卡可能让部分参加试用的人读起来更轻松。不能据此判断所有人都适合，也没说明其他光线下的情况。',
      example: '假设小周参加这种大字说明卡的试用，在光线充足的桌前拿起卡片读一段说明。原文只说可能让部分参加试用的人读起来更轻松，小周会不会更轻松还未知；不能据此判断所有人都适合。',
      conditions: ['在光线充足时', '可能让部分参加试用的人读起来更轻松', '不能据此判断所有人都适合'],
      uncertainty: '光线不足时怎样、具体谁读起来更轻松，原文没有确定。'
    },
    bad: {
      explanation: '只要开灯，所有人用这种说明卡都能读得更轻松。',
      example: '假设小周打开台灯读卡片。他一定读得更快，所以所有人都适合。',
      conditions: ['在光线充足时'], uncertainty: ''
    }
  }
};
export function getComplexFixture(id) {
  if (!Object.hasOwn(definitions, id)) return null;
  const item = structuredClone(definitions[id]);
  return { input: { context: item.source, quote: item.source, start: 0, end: item.source.length, cloudConsent: true }, good: item.good, bad: item.bad };
}
