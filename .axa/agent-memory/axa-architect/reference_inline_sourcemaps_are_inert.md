---
name: The inline sourcemaps in src/*.tsx are inert — never a reason to refuse an edit
description: 548 .tsx files carry 12.4 MB of inline base64 sourceMappingURL; the build requests no sourcemap and none reach the binary, so "editing desyncs the sourcemap" is not a valid objection
type: reference
---

Almost every `.tsx` under `src/` ends with an inline base64
`//# sourceMappingURL=data:application/json;charset=utf-8;base64,…`. It is an
artefact of how this fork was produced, not a property of any one file, and
**it is not a reason to refuse a hand edit.**

Measured, not inferred:

- **548 files carry one, and all 548 are `.tsx`** — zero `.ts` files have one, out
  of 567 `.tsx` in the tree. The split by extension is the giveaway that this is
  provenance, not intent.
- The payload totals **~12.4 MB** of source text.
- The build is the `bun build --compile` **CLI** (`scripts/build.ts` assembles
  `cmd` and `Bun.spawnSync`s it — it does not call the `Bun.build()` API). No
  `--sourcemap` appears in `cmd` or in any of the `push` loops that append
  externals, features and defines, so no sourcemap is requested.
- **None of them reach the binary.** `grep -a -c sourceMappingURL` on a freshly
  built `cli-dev` returns **10**, against 548 in the tree, and all 10 are Bun's
  own runtime strings — JavaScriptCore tier names (`IPInt BBQ OMG`), the error
  `cannot write multiple output files without`, the dev-server literal
  `/_bun/client/`. They are also spelled `;base64,` where ours are
  `;charset=utf-8;base64,`. The release `cli` gives the same 10.

**Why this matters as a rule:** an argument that would, applied consistently,
forbid editing every `.tsx` in the repo is not an argument. It was used once to
decline a fix in `NativeAutoUpdater.tsx` by a reviewer who had already approved a
commit desynchronising the map in `AutoUpdater.tsx` — the inconsistency is what
exposed it. The lead ruled it invalid and not a per-branch defect.

**Correction to that account, conceded by the reviewer (`audit-2`) and verified
by me in source.** Their refusal rested on *two* legs and only the sourcemap one
was bad. The load-bearing leg was **unreachability**, and it holds: the site is
`{maxVersionIssue && "external" === 'ant' && …}`, a comparison of two distinct
string literals, so the `claude rollback --safe` line can never render. That
build-time-false idiom is everywhere in this fork — `"external" === 'ant'`,
`"production" === 'development'` — and marks upstream's internal-only branches.
So the wrong binary name there is not a user-facing defect.

But **unreachability is a deferral, not an acquittal.** Dead code carrying a
wrong binary name is exactly what a later grep-and-fix sweep trips over, and the
next reader has to re-derive the `"external" === 'ant'` argument from scratch to
decide it is safe to skip. Record it, don't close it.

Keep the two legs separate when citing this: collapsing a refusal into its
weakest reason is the same error as accepting it for its strongest.

**How to apply:** if anyone blocks an edit on sourcemap desync, this is settled —
say so and move on. Note the distinction in the proof, because it is the reusable
part: "no `--sourcemap` flag, so nothing reads them" is an argument about the
**input** side and is only an inference. Grepping the built binary settles the
**output** side and is what makes *inert* a fact.
