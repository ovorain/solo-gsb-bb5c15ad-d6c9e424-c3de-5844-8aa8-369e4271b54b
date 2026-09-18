import { useCallback, useEffect, useState } from 'react';
import type { Rule, Simulation } from './types';
import { simulate } from './engine';
import { validateRules } from './validate';
import { SAMPLE_RULES, PRESETS } from './samples';
import { RulesPanel } from './components/RulesPanel';
import { Simulator } from './components/Simulator';
import { TraceView } from './components/TraceView';
import { RegressionPanel } from './components/RegressionPanel';
import { ShareCreateDialog } from './components/ShareCreateDialog';
import { ShareUnlock } from './components/ShareUnlock';
import {
  BASELINE_STORAGE_KEY,
  CASES_STORAGE_KEY,
  freezeBaseline,
  loadBaseline,
  loadCases,
  safeStorageWrite,
  type RegressionBaseline,
  type RegressionCase,
} from './regression';
import {
  cleanLocationUrl,
  parseShareHash,
  type SharePayload,
} from './share';

const STORAGE_KEY = 'url-route-debugger.rules.v1';

function loadRules(): Rule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return validateRules(JSON.parse(raw));
  } catch {
    // 本地缓存损坏时回退到示例规则
  }
  return structuredClone(SAMPLE_RULES);
}

/** 基线缓存损坏时回退为无基线，不影响规则表 */
function loadStoredBaseline(): RegressionBaseline | null {
  try {
    return loadBaseline(localStorage.getItem(BASELINE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 用例缓存损坏时回退为空列表，不影响规则表 */
function loadStoredCases(): RegressionCase[] {
  try {
    return loadCases(localStorage.getItem(CASES_STORAGE_KEY));
  } catch {
    return [];
  }
}

function readPendingShare(): string | null {
  try {
    return parseShareHash(window.location.hash);
  } catch {
    return null;
  }
}

/** 移除地址栏中的分享 hash（用 replaceState，不新增历史记录） */
function removeShareHash() {
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', cleanLocationUrl());
  }
}

export default function App() {
  // 打开分享链接时，整个调试台让位给口令解锁页；任何解密/校验失败都保持当前状态不变
  const [pendingShare, setPendingShare] = useState<string | null>(readPendingShare);
  const [sharing, setSharing] = useState(false);

  const [rules, setRulesState] = useState<Rule[]>(loadRules);
  // 规则表每次变更后自增：回归面板据此把旧对比结果标记为过期
  const [rulesEpoch, setRulesEpoch] = useState(0);
  const [method, setMethod] = useState(PRESETS[0].method);
  const [url, setUrl] = useState(PRESETS[0].url);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [baseline, setBaseline] = useState<RegressionBaseline | null>(
    loadStoredBaseline,
  );
  const [regCases, setRegCases] = useState<RegressionCase[]>(loadStoredCases);

  // 所有规则编辑入口都经过这里：更新规则表并推进 epoch
  const setRules = useCallback((next: Rule[]) => {
    setRulesState(next);
    setRulesEpoch((e) => e + 1);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);

  useEffect(() => {
    safeStorageWrite(
      BASELINE_STORAGE_KEY,
      baseline ? { ...baseline, ruleCount: baseline.rules.length } : null,
    );
  }, [baseline]);

  useEffect(() => {
    safeStorageWrite(CASES_STORAGE_KEY, regCases);
  }, [regCases]);

  const freeze = () => setBaseline(freezeBaseline(rules));
  const clearBaseline = () => {
    if (window.confirm('确定清除已冻结的基线？相关对比结果将一并清空。')) {
      setBaseline(null);
    }
  };

  // 监听浏览器前进 / 后退或手工改写 hash 带来的分享链接变化
  useEffect(() => {
    const onHashChange = () => setPendingShare(readPendingShare());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const run = () => setSim(simulate(rules, method, url));

  // 用户在预览页确认：此刻才真正替换状态，同时清空旧轨迹与地址栏 hash
  const confirmImport = (payload: SharePayload) => {
    setRules(payload.rules);
    setMethod(payload.method);
    setUrl(payload.url);
    setSim(null);
    removeShareHash();
    setPendingShare(null);
  };

  // 用户放弃导入：仅移除 hash 回到调试台，当前规则表 / 请求 / 轨迹一概不动
  const abortImport = () => {
    removeShareHash();
    setPendingShare(null);
  };

  // 创建者关闭分享对话框：清掉自己刚写入地址栏的 hash（复制出的链接不受影响）
  const closeShareDialog = () => {
    setSharing(false);
    removeShareHash();
  };

  if (pendingShare) {
    return (
      <ShareUnlock
        fragment={pendingShare}
        onConfirm={confirmImport}
        onAbort={abortImport}
      />
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>URL 路由规则调试台</h1>
        <p>
          编排有序规则（方法 / 主机 / 路径模板 → 重写、重定向或停止），模拟请求逐步追踪命中过程。
          重写后从第一条规则重新匹配；以「方法 + URL」识别循环，最多执行 20 步。
        </p>
      </header>
      <main className="layout">
        <RulesPanel
          rules={rules}
          onRulesChange={setRules}
          onShare={() => setSharing(true)}
        />
        <div className="right-col">
          <Simulator
            method={method}
            url={url}
            onMethodChange={setMethod}
            onUrlChange={setUrl}
            onRun={run}
          />
          {sim && <TraceView sim={sim} />}
        </div>
      </main>
      <RegressionPanel
        currentRules={rules}
        rulesEpoch={rulesEpoch}
        baseline={baseline}
        cases={regCases}
        draftMethod={method}
        draftUrl={url}
        onFreeze={freeze}
        onClearBaseline={clearBaseline}
        onCasesChange={setRegCases}
      />
      {sharing && (
        <ShareCreateDialog
          rules={rules}
          method={method}
          url={url}
          onClose={closeShareDialog}
        />
      )}
    </div>
  );
}
