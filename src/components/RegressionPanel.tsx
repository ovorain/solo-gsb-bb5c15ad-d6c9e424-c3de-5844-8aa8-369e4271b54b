import { useEffect, useMemo, useState } from 'react';
import type { Rule, Simulation, SimulationStatus } from '../types';
import { REQUEST_METHODS } from '../types';
import { StepCard } from './TraceView';
import {
  makeCaseId,
  runCase,
  type CaseResult,
  type OutcomeView,
  type RegressionBaseline,
  type RegressionCase,
  type StepDiffRow,
} from '../regression';

interface Props {
  currentRules: Rule[];
  /** 规则表每次被编辑（含导入 / 分享替换）后自增，用于判定旧结果是否过期 */
  rulesEpoch: number;
  baseline: RegressionBaseline | null;
  cases: RegressionCase[];
  /** 主模拟面板当前的请求，供「取当前请求新增用例」 */
  draftMethod: string;
  draftUrl: string;
  onFreeze: () => void;
  onClearBaseline: () => void;
  onCasesChange: (cases: RegressionCase[]) => void;
}

interface RunRecord {
  result: CaseResult;
  rulesEpoch: number;
  baselineFrozenAt: number;
}

const STATUS_LABEL: Record<SimulationStatus, string> = {
  final: 'final · 最终放行',
  redirect: 'redirect · 重定向',
  stopped: 'stopped · 停止',
  loop: '失败 · 循环',
  'max-steps': '失败 · 超过步数上限',
  'invalid-url': '失败 · URL 无法解析',
  'invalid-target': '失败 · 目标无法解析',
};

const STATUS_CLS: Record<SimulationStatus, string> = {
  final: 'ok',
  redirect: 'ok',
  stopped: 'warn',
  loop: 'error',
  'max-steps': 'error',
  'invalid-url': 'error',
  'invalid-target': 'error',
};

const ACTION_LABEL = {
  rewrite: '重写',
  redirect: '重定向',
  stop: '停止',
} as const;

/** 一条可观察结果的紧凑展示（只显示判据字段，不显示 reason 文案） */
function OutcomeLine({ outcome }: { outcome: OutcomeView }) {
  return (
    <span className="reg-outcome">
      <code>{outcome.status}</code>
      {outcome.status === 'final' && outcome.value !== undefined && (
        <>
          {' '}
          → <code className="url-to">{outcome.value}</code>
        </>
      )}
      {outcome.status === 'redirect' && (
        <>
          {' '}
          → <code>{outcome.statusCode}</code>{' '}
          <code className="url-to">{outcome.value}</code>
        </>
      )}
    </span>
  );
}

function RuleRef(step: Simulation['steps'][number]): string {
  return `#${step.ruleIndex + 1}「${step.rule.name}」(${step.rule.id})`;
}

/** 定位并描述首个差异步；可观察结果一致但轨迹不同也会给出说明 */
function firstDiffNote(rec: CaseResult): string | null {
  const { traceDiff } = rec;
  const idx = traceDiff.firstDiffIndex;
  if (idx === null) return null;
  const row = traceDiff.rows[idx];
  const n = idx + 1;

  if (!row.baseline) {
    return `轨迹长度不同：基线轨迹在第 ${n} 步前结束，当前规则多出后续步骤`;
  }
  if (!row.current) {
    return `轨迹长度不同：当前轨迹在第 ${n} 步前结束，基线多出后续步骤`;
  }

  const bStep = rec.baseline.steps[idx];
  const cStep = rec.current.steps[idx];
  const dims: string[] = [];
  if (row.baseline.ruleId !== row.current.ruleId) {
    dims.push(`命中规则 ${RuleRef(bStep)} → ${RuleRef(cStep)}`);
  }
  if (row.baseline.urlBefore !== row.current.urlBefore) {
    dims.push(`动作前 URL ${row.baseline.urlBefore} → ${row.current.urlBefore}`);
  }
  const ba = row.baseline.action;
  const ca = row.current.action;
  if (ba.type !== ca.type) {
    dims.push(`动作 ${ACTION_LABEL[ba.type]} → ${ACTION_LABEL[ca.type]}`);
  } else if (ba.type === 'rewrite' && ca.type === 'rewrite') {
    if (ba.urlAfter !== ca.urlAfter) {
      dims.push(`重写结果 ${ba.urlAfter} → ${ca.urlAfter}`);
    }
  } else if (ba.type === 'redirect' && ca.type === 'redirect') {
    if (ba.status !== ca.status) dims.push(`状态码 ${ba.status} → ${ca.status}`);
    if (ba.location !== ca.location) dims.push(`Location ${ba.location} → ${ca.location}`);
  }

  const head = `首个差异在第 ${n} 步（按 rule.id / urlBefore / 动作结果对齐）`;
  return dims.length > 0 ? `${head}：${dims.join('；')}` : head;
}

function outcomeChangeNote(rec: CaseResult): string | null {
  const d = rec.outcomeDiff;
  if (!d.changed) return null;
  switch (d.kind) {
    case 'termination':
      return `终止类型变化：${d.before.status} → ${d.after.status}`;
    case 'final-url':
      return `最终 URL 变化：${d.before.value ?? ''} → ${d.after.value ?? ''}`;
    case 'redirect-status':
      return `重定向状态码变化：${d.before.statusCode} → ${d.after.statusCode}`;
    case 'redirect-location':
      return `Location 变化：${d.before.value ?? ''} → ${d.after.value ?? ''}`;
    default:
      return null;
  }
}

function SideResult({ sim }: { sim: Simulation }) {
  return (
    <div className={`banner ${STATUS_CLS[sim.status]} reg-side-banner`}>
      <strong>{STATUS_LABEL[sim.status]}</strong>
      {sim.status === 'final' && sim.finalUrl !== undefined && (
        <p>
          最终 URL：<code className="url-to">{sim.finalUrl}</code>
        </p>
      )}
      {sim.status === 'redirect' && (
        <p>
          {sim.redirectStatus} Location：<code className="url-to">{sim.redirectLocation}</code>
        </p>
      )}
    </div>
  );
}

function DiffRows({ rows, rec }: { rows: StepDiffRow[]; rec: CaseResult }) {
  const first = rec.traceDiff.firstDiffIndex;
  return (
    <div className="reg-diff-grid">
      <div className="reg-diff-col">
        <h4>基线轨迹</h4>
        {rows.map((row) => {
          const step = row.baseline ? rec.baseline.steps[row.index] : null;
          return step ? (
            <StepCard key={row.index} step={step} firstDiff={row.index === first} />
          ) : (
            <div key={row.index} className="step step-missing">
              基线轨迹到此结束（无第 {row.index + 1} 步）
            </div>
          );
        })}
        <SideResult sim={rec.baseline} />
      </div>
      <div className="reg-diff-col">
        <h4>当前轨迹</h4>
        {rows.map((row) => {
          const step = row.current ? rec.current.steps[row.index] : null;
          return step ? (
            <StepCard key={row.index} step={step} firstDiff={row.index === first} />
          ) : (
            <div key={row.index} className="step step-missing">
              当前轨迹到此结束（无第 {row.index + 1} 步）
            </div>
          );
        })}
        <SideResult sim={rec.current} />
      </div>
    </div>
  );
}

export function RegressionPanel({
  currentRules,
  rulesEpoch,
  baseline,
  cases,
  draftMethod,
  draftUrl,
  onFreeze,
  onClearBaseline,
  onCasesChange,
}: Props) {
  const [records, setRecords] = useState<Record<string, RunRecord>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 基线被清除时旧对比结果不再有意义
  useEffect(() => {
    if (!baseline) setRecords({});
  }, [baseline]);

  const isFresh = (rec: RunRecord | undefined): rec is RunRecord =>
    !!rec &&
    !!baseline &&
    rec.rulesEpoch === rulesEpoch &&
    rec.baselineFrozenAt === baseline.frozenAt;

  const updateCases = (next: RegressionCase[]) => onCasesChange(next);

  const addCase = (method: string, url: string) => {
    updateCases([...cases, { id: makeCaseId(), name: '', method, url }]);
  };

  const patchCase = (id: string, patch: Partial<RegressionCase>) => {
    updateCases(cases.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    // 输入变了，旧结果必然不再对应用例本身：清掉
    setRecords((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const removeCase = (id: string) => {
    updateCases(cases.filter((c) => c.id !== id));
    setRecords((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setExpanded((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const runOne = (c: RegressionCase) => {
    if (!baseline || c.url.trim() === '') return;
    const result = runCase(baseline.rules, currentRules, c.method, c.url);
    setRecords((prev) => ({
      ...prev,
      [c.id]: {
        result,
        rulesEpoch,
        baselineFrozenAt: baseline.frozenAt,
      },
    }));
  };

  const runAll = () => {
    if (!baseline) return;
    const next: Record<string, RunRecord> = {};
    for (const c of cases) {
      if (c.url.trim() === '') continue;
      next[c.id] = {
        result: runCase(baseline.rules, currentRules, c.method, c.url),
        rulesEpoch,
        baselineFrozenAt: baseline.frozenAt,
      };
    }
    setRecords(next);
  };

  const validCases = cases.filter((c) => c.url.trim() !== '');

  const stats = useMemo(() => {
    let changed = 0;
    let same = 0;
    for (const c of cases) {
      const rec = records[c.id];
      if (isFresh(rec)) {
        if (rec.result.changed) changed++;
        else same++;
      }
    }
    return { changed, same };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, cases, rulesEpoch, baseline]);

  const frozenLabel = baseline
    ? new Date(baseline.frozenAt).toLocaleString('zh-CN', { hour12: false })
    : '';

  return (
    <section className="panel reg-panel">
      <div className="panel-title">
        <h2>规则回归对比</h2>
        <div className="toolbar">
          <button className="primary" onClick={onFreeze}>
            {baseline ? '重新冻结基线' : '冻结当前规则为基线'}
          </button>
          <button
            className="danger"
            onClick={onClearBaseline}
            disabled={!baseline}
          >
            清除基线
          </button>
          <button onClick={() => addCase(draftMethod, draftUrl)} disabled={draftUrl.trim() === ''}>
            取当前请求新增用例
          </button>
          <button
            onClick={() => addCase('GET', 'http://example.com/')}
          >
            ＋ 新增用例
          </button>
          <button className="primary" onClick={runAll} disabled={!baseline || validCases.length === 0}>
            运行全部对比
          </button>
        </div>
      </div>

      {baseline ? (
        <p className="reg-baseline-info">
          🧊 基线冻结于 {frozenLabel}，共 {baseline.ruleCount} 条规则。
          基线为冻结时刻的深拷贝，之后编辑规则不会改变它。
          {(stats.changed > 0 || stats.same > 0) && (
            <>
              {' '}
              最近一次结果：<strong className="reg-changed-text">{stats.changed} 条变化</strong>
              ，{stats.same} 条一致。
            </>
          )}
        </p>
      ) : (
        <p className="empty reg-baseline-info">
          尚未冻结基线。点击「冻结当前规则为基线」保存此刻的规则表，之后编辑规则即可对同一组用例做前后对比。
        </p>
      )}

      {cases.length === 0 ? (
        <p className="empty">暂无回归用例。点击「＋ 新增用例」维护「方法 + URL」用例。</p>
      ) : (
        <ul className="reg-cases">
          {cases.map((c, i) => {
            const rec = records[c.id];
            const fresh = isFresh(rec);
            const invalidUrl = c.url.trim() === '';
            const open = !!expanded[c.id];
            return (
              <li key={c.id} className="reg-case">
                <div className="reg-case-head">
                  <button
                    className="reg-toggle"
                    title={open ? '收起两侧轨迹' : '展开两侧轨迹'}
                    disabled={!fresh}
                    onClick={() => setExpanded((p) => ({ ...p, [c.id]: !p[c.id] }))}
                  >
                    {open ? '▼' : '▶'}
                  </button>
                  <input
                    className="reg-case-name"
                    value={c.name}
                    placeholder={`用例 ${i + 1}`}
                    onChange={(e) => patchCase(c.id, { name: e.target.value })}
                  />
                  <select
                    value={c.method}
                    onChange={(e) => patchCase(c.id, { method: e.target.value })}
                  >
                    {REQUEST_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <input
                    className={`reg-case-url${invalidUrl ? ' invalid' : ''}`}
                    value={c.url}
                    placeholder="http://api.example.com/v1/users/42"
                    spellCheck={false}
                    onChange={(e) => patchCase(c.id, { url: e.target.value })}
                  />
                  <button onClick={() => runOne(c)} disabled={!baseline || invalidUrl}>
                    运行
                  </button>
                  <button className="danger" onClick={() => removeCase(c.id)}>
                    删除
                  </button>
                </div>

                {!fresh ? (
                  <div className="reg-verdict reg-verdict-stale">
                    {!baseline
                      ? '基线已清除，无法对比'
                      : rec
                        ? '规则或基线已变化，结果已过期，请重新运行'
                        : '尚未运行'}
                  </div>
                ) : (
                  <>
                    <div
                      className={`reg-verdict ${
                        rec.result.changed ? 'reg-verdict-changed' : 'reg-verdict-same'
                      }`}
                    >
                      <span className="reg-verdict-badge">
                        {rec.result.changed ? '● 发生变化' : '○ 结果一致'}
                      </span>
                      <span className="reg-side">
                        基线：<OutcomeLine outcome={rec.result.outcomeDiff.before} />
                      </span>
                      <span className="reg-vs">⇄</span>
                      <span className="reg-side">
                        当前：<OutcomeLine outcome={rec.result.outcomeDiff.after} />
                      </span>
                    </div>

                    {open && (
                      <div className="reg-detail">
                        {rec.result.changed && (
                          <div className="banner error">
                            {outcomeChangeNote(rec.result)}
                          </div>
                        )}
                        {!rec.result.changed &&
                          rec.result.traceDiff.firstDiffIndex !== null && (
                            <div className="banner warn">
                              可观察结果一致（按判据不计变化），但执行轨迹存在差异：
                              {firstDiffNote(rec.result)}
                            </div>
                          )}
                        {rec.result.changed && firstDiffNote(rec.result) && (
                          <div className="banner warn">{firstDiffNote(rec.result)}</div>
                        )}
                        {rec.result.traceDiff.rows.length === 0 ? (
                          <p className="empty">两侧轨迹均为空（无任何步骤）。</p>
                        ) : (
                          <DiffRows rows={rec.result.traceDiff.rows} rec={rec.result} />
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
