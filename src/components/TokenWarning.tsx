import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Text } from '../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { calculateTokenWarningState, getEffectiveContextWindowSize, isAutoCompactEnabled } from '../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js';
import { getUpgradeMessage } from '../utils/model/contextWindowUpgradeCheck.js';
type Props = {
  tokenUsage: number;
  model: string;
};

/**
 * Live collapse progress: "x / y summarized". Sub-component so
 * useSyncExternalStore can subscribe to store mutations unconditionally
 * (hooks-in-conditionals would violate React rules). The parent only
 * renders this when feature('CONTEXT_COLLAPSE') + isContextCollapseEnabled().
 */
function CollapseLabel(t0) {
  const $ = _c(8);
  const {
    upgradeMessage
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = require("../services/contextCollapse/index.js");
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const {
    getStats,
    subscribe
  } = t1 as typeof import('../services/contextCollapse/index.js');
  let t2;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      const s = getStats();
      const idleWarn = s.health.emptySpawnWarningEmitted ? 1 : 0;
      return `${s.collapsedSpans}|${s.stagedSpans}|${s.health.totalErrors}|${s.health.totalEmptySpawns}|${idleWarn}`;
    };
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const snapshot = useSyncExternalStore(subscribe, t2);
  let t3;
  if ($[2] !== snapshot) {
    t3 = snapshot.split("|").map(Number);
    $[2] = snapshot;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const [collapsed, staged, errors, emptySpawns, idleWarn_0] = t3 as [number, number, number, number, number];
  const total = collapsed + staged;
  if (errors > 0 || idleWarn_0) {
    const problem = errors > 0 ? `collapse errors: ${errors}` : `collapse idle (${emptySpawns} empty runs)`;
    const t4 = total > 0 ? `${collapsed} / ${total} summarized \u00b7 ${problem}` : problem;
    let t5;
    if ($[4] !== t4) {
      t5 = <Text color="warning" wrap="truncate">{t4}</Text>;
      $[4] = t4;
      $[5] = t5;
    } else {
      t5 = $[5];
    }
    return t5;
  }
  if (total === 0) {
    return null;
  }
  const label = `${collapsed} / ${total} summarized`;
  const t4 = upgradeMessage ? `${label} \u00b7 ${upgradeMessage}` : label;
  let t5;
  if ($[6] !== t4) {
    t5 = <Text dimColor={true} wrap="truncate">{t4}</Text>;
    $[6] = t4;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  return t5;
}
export function TokenWarning(t0) {
  const $ = _c(14);
  const {
    tokenUsage,
    model
  } = t0;
  let t1;
  if ($[0] !== model || $[1] !== tokenUsage) {
    t1 = calculateTokenWarningState(tokenUsage, model);
    $[0] = model;
    $[1] = tokenUsage;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold
  } = t1;
  const suppressWarning = useCompactWarningSuppression();

  // Resource usage stats (RAM) — quantized to 10MB to avoid busting memoization on every render.
  const quantize10MB = (bytes: number): number => Math.round(bytes / 1024 / 1024 / 10) * 10;
  let rssMB = 0;
  let heapMB = 0;
  try {
    const mem = process.memoryUsage();
    rssMB = quantize10MB(mem.rss);
    heapMB = quantize10MB(mem.heapUsed);
  } catch {}
  const resourceLabel = rssMB >= 1024
    ? `RAM: ${(rssMB / 1024).toFixed(1)}GB (heap: ${heapMB}MB)`
    : `RAM: ${rssMB}MB (heap: ${heapMB}MB)`;

  // Always show context usage so the user can see growth and decide when to /compact.
  // Visible even when suppressWarning is true (post-compaction) — that only suppresses the warning text.
  if (!isAboveWarningThreshold) {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    const usedPct = Math.round((tokenUsage / effectiveWindow) * 100);
    if (usedPct < 5) return null;
    return <Box flexDirection="row"><Text dimColor={true} wrap="truncate">{`Context: ${usedPct}% used · ${resourceLabel}`}</Text></Box>;
  }
  if (suppressWarning) {
    return null;
  }
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = isAutoCompactEnabled();
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const showAutoCompactWarning = t2;
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = getUpgradeMessage("warning");
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const upgradeMessage = t3;
  let displayPercentLeft = percentLeft;
  let reactiveOnlyMode = false;
  let collapseMode = false;
  if (feature("REACTIVE_COMPACT")) {
    if (getFeatureValue_CACHED_MAY_BE_STALE("tengu_cobalt_raccoon", false)) {
      reactiveOnlyMode = true;
    }
  }
  if (feature("CONTEXT_COLLAPSE")) {
    const {
      isContextCollapseEnabled
    } = require("../services/contextCollapse/index.js") as typeof import('../services/contextCollapse/index.js');
    if (isContextCollapseEnabled()) {
      collapseMode = true;
    }
  }
  if (reactiveOnlyMode || collapseMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    let t4;
    if ($[5] !== effectiveWindow || $[6] !== tokenUsage) {
      t4 = Math.round((effectiveWindow - tokenUsage) / effectiveWindow * 100);
      $[5] = effectiveWindow;
      $[6] = tokenUsage;
      $[7] = t4;
    } else {
      t4 = $[7];
    }
    displayPercentLeft = Math.max(0, t4);
  }
  if (collapseMode && feature("CONTEXT_COLLAPSE")) {
    let t4;
    if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
      t4 = <Box flexDirection="row"><CollapseLabel upgradeMessage={upgradeMessage} /></Box>;
      $[8] = t4;
    } else {
      t4 = $[8];
    }
    return t4;
  }
  const autocompactLabel = reactiveOnlyMode ? `${100 - displayPercentLeft}% context used` : `${displayPercentLeft}% until auto-compact`;
  let t4;
  if ($[9] !== autocompactLabel || $[10] !== isAboveErrorThreshold || $[11] !== percentLeft || $[13] !== resourceLabel) {
    t4 = <Box flexDirection="row">{showAutoCompactWarning ? <Text dimColor={true} wrap="truncate">{upgradeMessage ? `${autocompactLabel} \u00b7 ${resourceLabel} \u00b7 ${upgradeMessage}` : `${autocompactLabel} \u00b7 ${resourceLabel}`}</Text> : <Text color={isAboveErrorThreshold ? "error" : "warning"} wrap="truncate">{upgradeMessage ? `Context low (${percentLeft}% remaining) \u00b7 ${resourceLabel} \u00b7 ${upgradeMessage}` : `Context low (${percentLeft}% remaining) \u00b7 ${resourceLabel} \u00b7 Run /compact`}</Text>}</Box>;
    $[9] = autocompactLabel;
    $[10] = isAboveErrorThreshold;
    $[11] = percentLeft;
    $[12] = t4;
    $[13] = resourceLabel;
  } else {
    t4 = $[12];
  }
  return t4;
}
