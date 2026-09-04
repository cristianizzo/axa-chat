---
name: heightCache 0 is a sentinel, not a height
description: In useVirtualScroll a cached height of 0 means "this row renders nothing"; anything that scales or rounds cached heights must preserve it and must not manufacture it.
type: project
---

In `useVirtualScroll`, a `heightCache` value of `0` is a deliberate sentinel meaning **the row renders nothing** — written by the measurement effect only when Yoga reports `getComputedWidth() > 0` with height 0, which proves layout ran. It exists so the start-advance gate doesn't block forever on a null-rendering row (the symptom was a blank viewport when scrolling down after scrolling up). `VirtualMessageList`'s `isVisible` reads `h === 0` as not-navigable.

**Why:** the resize path rescales every cached height by the column ratio, and its `Math.max(1, …)` clamp promoted the sentinel to a real 1-row height — making an invisible row cursor-selectable and adding a phantom row to every later offset. Mounted rows re-measure back to 0 on the next commit; unmounted ones kept the wrong value for the whole session.

**How to apply:** any code that scales, rounds or otherwise derives cached heights must (a) skip `0` rather than transform it, and (b) keep a clamp that prevents a genuine 1-row item rounding *down* to 0 — otherwise it fabricates the sentinel instead of preserving it. The distinction to hold in mind is "0 by construction" vs "0 by rounding". Note also that the prune is a `useMemo` on `itemKeys` **identity**, so changing when the cache is *written* does not change when it is *pruned* — check both separately.
