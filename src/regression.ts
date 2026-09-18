import type { Rule, Simulation, SimulationStatus } from './types';
import { METHOD_MATCHERS } from './types';
import { simulate } from './engine';
import { validateRules } from './validate';

/* ------------------------------------------------------------------ */
/* 持久化类型                                                           */
/* ------------------------------------------------------------------ */

/** 回归用例：一条「方法 + URL」输入 */
export interface RegressionCase {
  id: string;
  name: string;
  method: string;
  url: string;
}

/**
 * 冻结的基线：规则表在某一时刻的深拷贝。
 * 冻结后不再随规则编辑变化，直到用户重新冻结或清除。
 */
export interface RegressionBaseline {
  /** 深拷贝的规则表（validateRules 会重新构造对象，外部再改也不影响这里） */
  rules: Rule[];
  frozenAt: number;
  ruleCount: number;
}

/* ------------------------------------------------------------------ */
/* 结果比较                                                             */
/* ------------------------------------------------------------------ */

/** 两侧的可观察结果（刻意只保留判据字段，不含 reason 文案） */
export interface OutcomeView {
  status: SimulationStatus;
  /** final：finalUrl；redirect：Location；其余不比较此字段 */
  value?: string;
  /** redirect：状态码；其余不比较 */
  statusCode?: number;
}

/** 单次回归运行：同一份用例分别在基线 / 当前规则上跑出的结果 */
export interface CaseResult {
  baseline: Simulation;
  current: Simulation;
  /** 可观察结果是否变化（按终止类型及其可观察结果判定，不含 reason） */
  changed: boolean;
  outcomeDiff: OutcomeDifference;
  /** 首个差异步（按 rule.id / urlBefore / 动作结果对齐定位） */
  traceDiff: TraceComparison;
}

/** 可观察结果的差异描述 */
export interface OutcomeDifference {
  changed: boolean;
  /** 变化时给出结构化的差异维度，供 UI 与测试使用 */
  kind:
    | 'same'
    | 'termination' // 终止类型（含失败类型）变化
    | 'final-url'
    | 'redirect-location'
    | 'redirect-status';
  before: OutcomeView;
  after: OutcomeView;
}

/** 单步的可比较面：仅 rule.id、urlBefore 与动作结果 */
export interface StepView {
  ruleId: string;
  urlBefore: string;
  /** rewrite → urlAfter；redirect → status + Location；stop → null */
  action:
    | { type: 'rewrite'; urlAfter: string }
    | { type: 'redirect'; status: number; location: string }
    | { type: 'stop' };
}

export interface TraceComparison {
  /** 对齐后的每一步比较行 */
  rows: StepDiffRow[];
  /** 首个不同步骤的下标（对齐后的行号，从 0 起）；全部相同为 null */
  firstDiffIndex: number | null;
}

export interface StepDiffRow {
  index: number;
  baseline: StepView | null;
  current: StepView | null;
  same: boolean;
}

/**
 * 提取一次模拟的「可观察结果」。
 * 判据严格限定为：
 * - final：比较 finalUrl
 * - redirect：比较状态码与 Location
 * - stopped：比较终止类型（无额外字段）
 * - 各类失败：比较失败类型（status）
 * reason 文案绝不参与判定。
 */
export function outcomeOf(sim: Simulation): OutcomeView {
  switch (sim.status) {
    case 'final':
      return { status: 'final', value: sim.finalUrl };
    case 'redirect':
      return {
        status: 'redirect',
        value: sim.redirectLocation,
        statusCode: sim.redirectStatus,
      };
    default:
      // stopped / loop / max-steps / invalid-url / invalid-target
      // 终止类型（或失败类型）本身就是全部判据
      return { status: sim.status };
  }
}

/** 比较两次模拟的可观察结果（不比较 reason 文案） */
export function compareOutcomes(
  baseline: Simulation,
  current: Simulation,
): OutcomeDifference {
  const before = outcomeOf(baseline);
  const after = outcomeOf(current);

  if (before.status !== after.status) {
    return { changed: true, kind: 'termination', before, after };
  }
  if (before.status === 'final' && before.value !== after.value) {
    return { changed: true, kind: 'final-url', before, after };
  }
  if (before.status === 'redirect') {
    if (before.statusCode !== after.statusCode) {
      return { changed: true, kind: 'redirect-status', before, after };
    }
    if (before.value !== after.value) {
      return { changed: true, kind: 'redirect-location', before, after };
    }
  }
  return { changed: false, kind: 'same', before, after };
}

/** 提取单步的可比较面（rule.id / urlBefore / 动作结果） */
export function stepViewOf(step: Simulation['steps'][number]): StepView {
  switch (step.rule.action.type) {
    case 'rewrite':
      return {
        ruleId: step.rule.id,
        urlBefore: step.urlBefore,
        action: { type: 'rewrite', urlAfter: step.urlAfter ?? '' },
      };
    case 'redirect':
      return {
        ruleId: step.rule.id,
        urlBefore: step.urlBefore,
        action: {
          type: 'redirect',
          status: step.status ?? 0,
          location: step.location ?? '',
        },
      };
    case 'stop':
      return { ruleId: step.rule.id, urlBefore: step.urlBefore, action: { type: 'stop' } };
  }
}

function sameStep(a: StepView, b: StepView): boolean {
  if (a.ruleId !== b.ruleId || a.urlBefore !== b.urlBefore) return false;
  if (a.action.type !== b.action.type) return false;
  switch (a.action.type) {
    case 'rewrite':
      return (
        b.action.type === 'rewrite' && a.action.urlAfter === b.action.urlAfter
      );
    case 'redirect':
      return (
        b.action.type === 'redirect' &&
        a.action.status === b.action.status &&
        a.action.location === b.action.location
      );
    case 'stop':
      return true;
  }
}

/**
 * 逐步对齐两条轨迹并定位首个差异。
 * 以行下标对齐（两条轨迹都从第 1 步开始），任一侧轨迹先结束则该侧记为 null；
 * 因此轨迹长度不同也会在「第一个缺失行」处被标记为差异。
 */
export function compareTraces(
  baseline: Simulation,
  current: Simulation,
): TraceComparison {
  const b = baseline.steps.map(stepViewOf);
  const c = current.steps.map(stepViewOf);
  const len = Math.max(b.length, c.length);
  const rows: StepDiffRow[] = [];
  let firstDiffIndex: number | null = null;

  for (let i = 0; i < len; i++) {
    const bs = b[i] ?? null;
    const cs = c[i] ?? null;
    // 两侧均缺失（理论上不会发生，len 取较大值）视为相同；一侧缺失即不同
    const same = bs !== null && cs !== null && sameStep(bs, cs);
    if (!same && firstDiffIndex === null) firstDiffIndex = i;
    rows.push({ index: i, baseline: bs, current: cs, same });
  }

  return { rows, firstDiffIndex };
}

/** 用同一 simulate 引擎分别运行基线与当前规则，并比较结果 */
export function runCase(
  baselineRules: Rule[],
  currentRules: Rule[],
  method: string,
  url: string,
): CaseResult {
  const baseline = simulate(baselineRules, method, url);
  const current = simulate(currentRules, method, url);
  const outcomeDiff = compareOutcomes(baseline, current);
  return {
    baseline,
    current,
    changed: outcomeDiff.changed,
    outcomeDiff,
    traceDiff: compareTraces(baseline, current),
  };
}

/* ------------------------------------------------------------------ */
/* localStorage 持久化（损坏数据回退为空，且不影响现有规则）              */
/* ------------------------------------------------------------------ */

export const BASELINE_STORAGE_KEY = 'url-route-debugger.baseline.v1';
export const CASES_STORAGE_KEY = 'url-route-debugger.cases.v1';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 读取并校验基线快照。
 * 任何结构损坏 / 规则校验失败都回退为 null（视为没有基线），
 * 调用方仍可继续正常使用现有规则。
 */
export function loadBaseline(raw: string | null): RegressionBaseline | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!isRecord(data) || !Array.isArray(data.rules)) return null;
    const frozenAt = typeof data.frozenAt === 'number' ? data.frozenAt : Date.now();
    // validateRules 会逐条校验并构造全新对象，损坏的规则数组会抛错 → 回退 null
    const rules = validateRules(data.rules);
    return { rules, frozenAt, ruleCount: rules.length };
  } catch {
    return null;
  }
}

/** 校验用例数组：字段缺失给默认值，结构非法时整条丢弃；整体非数组则回退空数组 */
export function loadCases(raw: string | null): RegressionCase[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const cases: RegressionCase[] = [];
    for (const item of data) {
      if (!isRecord(item)) continue;
      const method = typeof item.method === 'string' ? item.method.toUpperCase() : 'GET';
      if (!(METHOD_MATCHERS as readonly string[]).includes(method) || method === 'ANY') {
        continue;
      }
      const url = typeof item.url === 'string' ? item.url : '';
      if (url === '') continue;
      cases.push({
        id: typeof item.id === 'string' && item.id !== '' ? item.id : makeCaseId(),
        name: typeof item.name === 'string' ? item.name : '',
        method,
        url,
      });
    }
    return cases;
  } catch {
    return [];
  }
}

export function makeCaseId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 写入 localStorage 时静默容错（隐私模式 / 配额不足都不应影响编辑） */
export function safeStorageWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 持久化失败不影响内存中的使用
  }
}

/**
 * 冻结基线：对当前规则做深拷贝。
 * 这里再经 validateRules 构造一遍对象，确保基线与外部状态完全解耦。
 */
export function freezeBaseline(rules: Rule[]): RegressionBaseline {
  return {
    rules: validateRules(structuredClone(rules)),
    frozenAt: Date.now(),
    ruleCount: rules.length,
  };
}
