---
name: Enumerate the callers before arguing a path is dead
description: Three reviewers each proved one installLatest entry point dead and wrongly concluded the feature was inert; plus the near-miss gate that makes the finding look refuted, and the after-state write that hides it
type: reference
---

**Scope note.** The `isInBundledMode()` half of this thread is `audit-2`'s and
lives in `reference_isinbundledmode_is_not_compiled.md` — they ran the predicate
against two scratch binaries, which is a measurement where I only had an
inference. Do not restate it here; this file is the reachability half only.

## The shape

`git grep -n installLatest` returns **three** callers, each needing a different
answer:

- `components/NativeAutoUpdater.tsx` — dead, gated behind the always-false
  `isInBundledMode()` chain.
- `cli/update.ts` — gated on `diagnostic.installationType === 'native'`.
- `commands/install.tsx` — **no gate**, reached from
  `program.command('install [target]')` registered unconditionally in
  `src/main.tsx`, sitting *between* two `if ("external" === 'ant')` blocks.

Three reviewers in sequence each proved *one* entry point dead and concluded the
feature was inert. Every proof was correct and every conclusion was wrong: the
npm path 404s, `NativeAutoUpdater` never mounts, and the manual path was open the
whole time.

**The rule, which is `audit-2`'s and is the durable part: proving a path dead
proves nothing until you have established that path was the one that runs.**
Enumerate the callers first, then argue reachability caller by caller. This is
the same error as a claim that is true only inside an unstated implicit scope —
the scope here being "the entry point I happened to open".

## Two traps sitting on top of it

**A near-miss gate that makes a correct finding look refuted.**
`nativeInstaller/installer.ts` contains `getCurrentInstallationType()`, an
`installationType === 'development'` early return, and
`force || installationType === 'native' || config.installMethod === 'native'` —
one grep away from `installLatestImpl` and reading exactly like the gate a
colleague just said was missing. It is inside **`checkInstall`**, the variable is
`shouldCheckNative`, and it decides whether to print *warnings*. I nearly replied
with it as a refutation. When a grep appears to contradict a teammate, check
which function the hit is in before answering — a fast verification that lands in
the wrong function is worse than no verification, because it arrives with
confidence.

**State written after the act, leaving a consistent after-state.**
`installLatestImpl` writes `installMethod: 'native'` into the global config on
success. The operation therefore leaves the configuration *agreeing* with what it
just did, so a later diagnostic sees a legitimate native install and there is no
inconsistency to notice. Look for the write, not for the discrepancy: an
operation that repairs the evidence of itself cannot be found by comparing state
against expectation.
