import { describe, expect, it } from 'vitest';
import type { Rule } from './types';
import {
  compareOutcomes,
  compareTraces,
  freezeBaseline,
  loadBaseline,
  loadCases,
  outcomeOf,
  runCase,
  stepViewOf,
} from './regression';
import { simulate } from './engine';

function rule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: partial.id,
    enabled: true,
    method: 'ANY',
    host: 'example.com',
    pathTemplate: '/',
    action: { type: 'rewrite', target: '/', status: 302 },
    ...partial,
  };
}

const rulesV1 = [
  rule({
    id: 'r1',
    name: 'v1 重写',
    pathTemplate: '/v1/:id',
    action: { type: 'rewrite', target: '/v2/:id', status: 302 },
  }),
];

const rulesV2 = [
  rule({
    id: 'r1',
    name: 'v2 重写到 v3（规则名改了）',
    pathTemplate: '/v1/:id',
    action: { type: 'rewrite', target: '/v3/:id', status: 302 },
  }),
];

describe('compareOutcomes：按终止类型与可观察结果判定，不看 reason', () => {
  it('final：比较 finalUrl，URL 变化才计变化', () => {
    const a = simulate(rulesV1, 'GET', 'http://example.com/v1/7');
    const b = simulate(rulesV2, 'GET', 'http://example.com/v1/7');
    expect(a.status).toBe('final');
    expect(b.status).toBe('final');
    const d = compareOutcomes(a, b);
    expect(d.changed).toBe(true);
    expect(d.kind).toBe('final-url');
    expect(d.before.value).toBe('http://example.com/v2/7');
    expect(d.after.value).toBe('http://example.com/v3/7');
  });

  it('原因文案不同但 finalUrl 相同：不计变化', () => {
    // a：零步放行到 /x；b：先重写一步再落到 /x。两者 reason 文案不同，finalUrl 相同
    const a = simulate([], 'GET', 'http://example.com/x');
    const b = simulate(
      [
        rule({
          id: 'self',
          pathTemplate: '/start',
          action: { type: 'rewrite', target: '/x', status: 302 },
        }),
      ],
      'GET',
      'http://example.com/start',
    );
    expect(b.steps.length).toBeGreaterThan(0);
    expect(a.finalUrl).toBe(b.finalUrl);
    expect(a.reason).not.toBe(b.reason);
    expect(compareOutcomes(a, b).changed).toBe(false);
  });

  it('redirect：状态码或 Location 变化分别标记', () => {
    const redir = (status: number, target: string) =>
      simulate(
        [
          rule({
            id: 'r1',
            pathTemplate: '/old',
            action: { type: 'redirect', target, status },
          }),
        ],
        'GET',
        'http://example.com/old',
      );

    const loc = compareOutcomes(
      redir(301, 'https://a.com/x'),
      redir(301, 'https://b.com/x'),
    );
    expect(loc.changed).toBe(true);
    expect(loc.kind).toBe('redirect-location');

    const code = compareOutcomes(
      redir(301, 'https://a.com/x'),
      redir(302, 'https://a.com/x'),
    );
    expect(code.changed).toBe(true);
    expect(code.kind).toBe('redirect-status');

    expect(
      compareOutcomes(redir(301, 'https://a.com/x'), redir(301, 'https://a.com/x'))
        .changed,
    ).toBe(false);
  });

  it('stopped：只比较终止类型，停止规则不同也不算变化', () => {
    const stopA = simulate(
      [rule({ id: 'sa', name: 'A', pathTemplate: '/x', action: { type: 'stop', target: '', status: 302 } })],
      'GET',
      'http://example.com/x',
    );
    const stopB = simulate(
      [rule({ id: 'sb', name: 'B', pathTemplate: '/x', action: { type: 'stop', target: '', status: 302 } })],
      'GET',
      'http://example.com/x',
    );
    expect(compareOutcomes(stopA, stopB).changed).toBe(false);
    expect(outcomeOf(stopA)).toEqual({ status: 'stopped' });
  });

  it('失败：比较失败类型', () => {
    const loop = simulate(
      [rule({ id: 'l', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } })],
      'GET',
      'http://example.com/a',
    );
    const maxSteps = simulate(
      [rule({ id: 'l', pathTemplate: '/a', action: { type: 'rewrite', target: '/a', status: 302 } })],
      'GET',
      'http://example.com/a',
    );
    expect(loop.ok).toBe(false);
    // 同类型一致
    expect(compareOutcomes(loop, maxSteps).changed).toBe(false);
    // 不同失败类型（invalid-url vs loop）计为终止类型变化
    const invalid = simulate([], 'GET', 'not-a-url');
    const d = compareOutcomes(loop, invalid);
    expect(d.changed).toBe(true);
    expect(d.kind).toBe('termination');
    expect(d.before.status).toBe('loop');
    expect(d.after.status).toBe('invalid-url');
  });

  it('成功终止变为失败、final 变为 redirect 均属终止类型变化', () => {
    const fin = simulate([], 'GET', 'http://example.com/x');
    const redir = simulate(
      [rule({ id: 'r', pathTemplate: '/x', action: { type: 'redirect', target: 'https://a.com/', status: 302 } })],
      'GET',
      'http://example.com/x',
    );
    expect(compareOutcomes(fin, redir).kind).toBe('termination');
  });
});

describe('compareTraces：按 rule.id / urlBefore / 动作结果定位首个差异', () => {
  it('首个差异在规则 id：不看规则名', () => {
    const withR1 = simulate(
      [rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/z', status: 302 } })],
      'GET',
      'http://example.com/a',
    );
    const withR2 = simulate(
      [rule({ id: 'r2', name: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/z', status: 302 } })],
      'GET',
      'http://example.com/a',
    );
    // 可观察结果一致
    expect(compareOutcomes(withR1, withR2).changed).toBe(false);
    const t = compareTraces(withR1, withR2);
    expect(t.firstDiffIndex).toBe(0);
    expect(t.rows[0].same).toBe(false);
    expect(t.rows[0].baseline?.ruleId).toBe('r1');
    expect(t.rows[0].current?.ruleId).toBe('r2');
  });

  it('动作结果（重写目标）不同标记为差异', () => {
    const a = simulate(rulesV1, 'GET', 'http://example.com/v1/9');
    const b = simulate(rulesV2, 'GET', 'http://example.com/v1/9');
    const t = compareTraces(a, b);
    expect(t.firstDiffIndex).toBe(0);
    expect(t.rows[0].baseline?.action).toEqual({
      type: 'rewrite',
      urlAfter: 'http://example.com/v2/9',
    });
    expect(t.rows[0].current?.action).toEqual({
      type: 'rewrite',
      urlAfter: 'http://example.com/v3/9',
    });
  });

  it('轨迹长度不同：多出的一步标记为首个差异且缺失侧为 null', () => {
    // 基线：/a → /b 后无命中（1 步）；当前：/a → /b，再 /b → /c（2 步）
    const base = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
    ];
    const cur = [
      rule({ id: 'r1', pathTemplate: '/a', action: { type: 'rewrite', target: '/b', status: 302 } }),
      rule({ id: 'r2', pathTemplate: '/b', action: { type: 'rewrite', target: '/c', status: 302 } }),
    ];
    const a = simulate(base, 'GET', 'http://example.com/a');
    const b = simulate(cur, 'GET', 'http://example.com/a');
    expect(a.steps).toHaveLength(1);
    expect(b.steps).toHaveLength(2);

    const t = compareTraces(a, b);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].same).toBe(true);
    expect(t.firstDiffIndex).toBe(1);
    expect(t.rows[1].baseline).toBeNull();
    expect(t.rows[1].current).not.toBeNull();
    expect(t.rows[1].same).toBe(false);
  });

  it('完全相同的轨迹：无首个差异', () => {
    const a = simulate(rulesV1, 'GET', 'http://example.com/v1/1');
    const b = simulate(rulesV1, 'GET', 'http://example.com/v1/1');
    const t = compareTraces(a, b);
    expect(t.firstDiffIndex).toBeNull();
    expect(t.rows.every((r) => r.same)).toBe(true);
  });

  it('两条空轨迹：无差异', () => {
    const a = simulate([], 'GET', 'http://example.com/');
    const b = simulate([], 'GET', 'http://example.com/');
    expect(compareTraces(a, b).rows).toEqual([]);
    expect(compareTraces(a, b).firstDiffIndex).toBeNull();
  });

  it('重定向步比较状态码与 Location', () => {
    const mk = (status: number, target: string) =>
      simulate(
        [rule({ id: 'r', pathTemplate: '/x', action: { type: 'redirect', target, status } })],
        'GET',
        'http://example.com/x',
      );
    const view = stepViewOf(mk(301, 'https://a.com/').steps[0]);
    expect(view.action).toEqual({
      type: 'redirect',
      status: 301,
      location: 'https://a.com/',
    });
    const t = compareTraces(mk(301, 'https://a.com/'), mk(302, 'https://a.com/'));
    expect(t.firstDiffIndex).toBe(0);
  });
});

describe('runCase：同一引擎分别运行基线与当前规则', () => {
  it('返回两侧结果并给出变化结论', () => {
    const rec = runCase(rulesV1, rulesV2, 'GET', 'http://example.com/v1/3');
    expect(rec.baseline.finalUrl).toBe('http://example.com/v2/3');
    expect(rec.current.finalUrl).toBe('http://example.com/v3/3');
    expect(rec.changed).toBe(true);
  });

  it('基线深拷贝：冻结后再改原规则不影响基线结果', () => {
    const original = [
      rule({
        id: 'r1',
        pathTemplate: '/v1/:id',
        action: { type: 'rewrite', target: '/v2/:id', status: 302 },
      }),
    ];
    const frozen = freezeBaseline(original);
    // 冻结后外部继续编辑（同一对象引用上的原地修改）
    original[0].action.target = '/mutated/:id';
    const current = [
      rule({
        id: 'r1',
        pathTemplate: '/v1/:id',
        action: { type: 'rewrite', target: '/hacked/:id', status: 302 },
      }),
    ];
    const rec = runCase(frozen.rules, current, 'GET', 'http://example.com/v1/5');
    expect(rec.baseline.finalUrl).toBe('http://example.com/v2/5');
    expect(rec.current.finalUrl).toBe('http://example.com/hacked/5');
  });
});

describe('localStorage 数据：损坏回退为空，不影响现有规则', () => {
  it('loadBaseline：非 JSON / 结构错误 / 规则非法都回退 null', () => {
    expect(loadBaseline(null)).toBeNull();
    expect(loadBaseline('not-json{')).toBeNull();
    expect(loadBaseline('{"rules": {}}')).toBeNull();
    expect(loadBaseline('[]')).toBeNull();
    expect(loadBaseline('{"rules":[{"method":"BOGUS"}]}')).toBeNull();
    expect(loadBaseline('{"rules":[],"frozenAt":"x"}')).toEqual({
      rules: [],
      frozenAt: expect.any(Number),
      ruleCount: 0,
    });
  });

  it('loadBaseline：合法数据深拷贝恢复', () => {
    const stored = JSON.stringify({
      rules: rulesV1,
      frozenAt: 123456,
      ruleCount: 99, // 故意错误：应按实际规则数重算
    });
    const bl = loadBaseline(stored);
    expect(bl).not.toBeNull();
    expect(bl!.frozenAt).toBe(123456);
    expect(bl!.ruleCount).toBe(1);
    expect(bl!.rules[0].id).toBe('r1');
  });

  it('loadCases：非数组回退空、坏条目被跳过、合法条目规范化', () => {
    expect(loadCases(null)).toEqual([]);
    expect(loadCases('garbage')).toEqual([]);
    expect(loadCases('{}')).toEqual([]);
    const out = loadCases(
      JSON.stringify([
        null,
        'str',
        { method: 'POST', url: 'http://a.com/1' },
        { method: 'ANY', url: 'http://a.com/2' }, // ANY 不是合法请求方法
        { method: 'get', url: 'http://a.com/3', name: '小写方法' },
        { method: 'GET', url: '' }, // 空 URL
        { method: 'GET', url: 'http://a.com/4', id: 'fixed-id' },
      ]),
    );
    expect(out.map((c) => c.url)).toEqual([
      'http://a.com/1',
      'http://a.com/3',
      'http://a.com/4',
    ]);
    expect(out[0].id).toEqual(expect.any(String));
    expect(out[1].method).toBe('GET');
    expect(out[1].name).toBe('小写方法');
    expect(out[2].id).toBe('fixed-id');
  });
});
