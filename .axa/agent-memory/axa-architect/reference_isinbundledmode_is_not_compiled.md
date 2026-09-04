---
name: isInBundledMode() does not mean "compiled binary" — and the tree already says so
description: The predicate is Bun.embeddedFiles.length > 0, which is 0 for every binary this repo builds; its own docstring claims the opposite, and swarm/spawnUtils.ts already documents the trap
type: reference
---

`utils/bundledMode.ts` — `isInBundledMode()` returns
`Bun.embeddedFiles.length > 0`. Its docstring says *"Detects if running as a
Bun-compiled standalone executable… checks for embedded files which are present
in compiled binaries."* **The docstring is false.** `scripts/build.ts` embeds no
assets and `src/` has no `import … with { type: "file" }`, so the array is empty
and the predicate is **false for exactly the compiled binaries it claims to
detect**.

Proof, with the control that had to fire: two scratch `bun build --compile`
binaries differing only by one `import a from "./asset.txt" with { type: "file" }`
→ plain `len:0`, embedded `len:1`. Independently, `./cli doctor` on a real binary
of this repo prints `Invoked: /$bunfs/root/cli` while the predicate is false.

**The part that makes this a standing rule rather than one bug: the repo already
told me.** `utils/swarm/spawnUtils.ts` carries a comment, written from a
verification against a compiled binary:

> `isInBundledMode()` does not identify a compiled binary. It keys off
> `Bun.embeddedFiles`, which is empty unless the build embeds assets, so it
> reports false for exactly the binaries that need handling.

Two comments in this tree contradict each other on a checkable fact, and I
believed the one attached to the function because it was attached to the
function. **Proximity is not authority.** When two comments disagree, neither is
evidence — run the predicate.

**Blast radius.** Anything keyed on `isInBundledMode()` is reasoning about asset
embedding, not about packaging. Concretely: `getCurrentInstallationType()`
(`utils/doctorDiagnostic.ts`) returns `'native'` *only inside* that branch, so
`AutoUpdaterWrapper` never mounts `NativeAutoUpdater` — see
`project_native_updater_points_at_upstream.md`. Use `process.execPath` (what
`spawnUtils.ts` does) when the real question is "am I a compiled binary".

**How to apply:** never cite `isInBundledMode()` as evidence that a code path is
or is not reachable in a shipped binary without running the predicate. And treat
a docstring that names its own mechanism as a claim to check, not a summary to
trust — this repo has a documented history of exactly that.
