---
name: VirtualMessageList incremental key array — the precondition it rests on
description: The append fast-path in VirtualMessageList is sound only because every Messages.tsx collapse stage is an order-preserving single pass; an in-place rekey would break it silently.
type: project
---

`VirtualMessageList` keys its rows from an incremental array held in a ref: it appends for the new tail and only rebuilds when the guard says the keyed prefix moved. The guard checks one index — that `itemKey(messages[prevLen-1])` still equals the stored key there.

**Why:** that single-index check is sufficient *only* because every collapse stage in the `Messages.tsx` pipeline is an order-preserving left-to-right pass whose output over a prefix depends only on that prefix — so any insertion or removal shifts everything after it and surfaces at the last keyed index. The shape that would defeat it is a stage substituting an entry **in place, under a different key, without changing length**. No stage does that today: the grouping and read/search stages key off the *first* member, the others reuse or never touch the uuid.

Note the near-miss that is *not* a violation: a read/search group absorbing a newly appended message consumes one extra input and emits the same count, so output length is equal while a collapse really happened. Its key is the first member's uuid, so it doesn't move. Arguments of the form "the stages only ever shorten, so equal length means nothing collapsed" are wrong for exactly this case.

**How to apply:** before adding or reordering a stage in that pipeline, check it against the precondition written next to the guard. Also remember two stages are gated on `verbose` (`applyGrouping`, `collapseBackgroundBashNotifications`), so ctrl+O *grows* the rendered array — successive renders are not monotone even though each stage is.
