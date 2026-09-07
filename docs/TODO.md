# AXA Chat — TODO

**Created:** 2026-07-16
**Last updated:** 2026-08-28

---

## P0 — Now

- [ ] **`~/.axa` root, visible projects, permanent backups** (design agreed
  2026-08-28). Full design: **`docs/STORAGE-REDESIGN.md`**.

  The real problem is not the layout, it is that **none of it is visible or
  manageable**: no list, no sizes, no rename, no delete, no merge. Measured
  here: 34 project dirs, ~1,557 conversations, 1.5 GB, all opaque.

  **The storage model does not change.** A project stays the folder you start
  `axa` in — that is already what the code does and it is correct. No
  workspaces, no git-root inference, no prefix matching, no re-layout, no
  index. Splits like `searcher` vs `searcher/packages/playground` are fixed by
  an explicit user-driven *merge*, not a heuristic.

  Key facts behind the design:
  - `sanitizePath` (`sessionStoragePortable.ts:311`) is lossy, but every JSONL
    line carries `cwd` verbatim — read the real path from the transcript.
  - `compact.ts:388` keeps 3 backup sets; this session compacted 27 times.
    Keep all, **uncompressed** — gzip would break grep over old conversations.
  - 115 MB in `-…-risikai/ad3e7466-…/subagents/` is stranded: 14 subagent
    transcripts whose parent transcript was deleted. Nothing surfaces it.
  - 1,504 of the 1,557 conversations are pmbot runs from `mkdtemp` cwds
    (`polymarket-bot/pmbot/agent/axa.py:47`). The temp cwd is a deliberate
    security measure and must stay; `--project <name>` lets the caller pin
    storage instead.
  - Credentials live in the macOS Keychain, not `~/.claude`. The service name
    (`macOsKeychainHelpers.ts:29`) only varies when `CLAUDE_CONFIG_DIR` is set,
    so `axa` needs its **own** entry or it shares one credential with Claude
    Code and token rotation logs the other out.

  - [x] PR 1 — new root + import (must ship together):
    `getClaudeConfigHomeDir()` (`envUtils.ts:7`) → `~/.axa`, created **empty**
    like a first install; `~/.claude` never read or written. Own keychain
    service name. `/import-conversations` in settings: source *Claude Code*,
    copies conversations + `settings.json` + credentials, idempotent,
    re-runnable, copy-only. `MAX_BACKUP_SETS` 3 → 1000.
    Shipped: `CONFIG_DIR_NAME = '.axa'` / `LEGACY_CONFIG_DIR_NAME`
    (`constants/product.ts:33,44`), `KEYCHAIN_SERVICE_NAME` threaded through
    `macOsKeychainHelpers.ts:41`, `commands/import-conversations/` +
    `services/import/claudeCodeImport.ts`, `MAX_BACKUP_SETS = 1000`
    (`compact.ts:398`).
  - [ ] PR 2 — `/projects`: list with real path, conversation count, size on disk,
    last used, and flags for dead paths and orphaned data; open, rename,
    favourite, delete, merge. `project.json` written lazily, only on first
    rename/favourite/merge. `--project <name>` override.
    **Half shipped.** Done: `services/projects/projectList.ts` (real path from
    the transcript `cwd`, recursive sizes, `missingPath` / `orphanedData` /
    `unreadable` flags), the read-only `/projects` screen
    (`commands/projects/projects.tsx`), and `--project <name>`
    (`services/projects/namedProject.ts`, applied in `main.tsx:2001`).
    **Still missing: every mutating action** — rename, favourite, delete,
    merge, and the lazy `project.json` they would write. The screen lists and
    drills in; the detail view's only exit is a `cd … && axa --resume` line to
    copy by hand. Delete and merge touch 1.5 GB of irreplaceable transcripts,
    so they need their confirmation and undo story agreed before they are
    built, not designed in the PR.

- [x] **Three-tier approval modes** (2026-07-18) — Manual (`default`) / Auto (`auto`) / Skip all (`bypassPermissions`). Auto uses local, network-free risk detection (`localAutoApprove.ts`): auto-approves routine ops, still prompts on sensitive files (`safetyCheck`), destructive shell (`getDestructiveCommandWarning`), PowerShell, and always surfaces AskUserQuestion/ExitPlanMode. Ungated the dormant `auto` mode (dropped `TRANSCRIPT_CLASSIFIER`/GrowthBook/model gates). Relabeled footer; added `meta+m` (Cmd+M) mode-cycle shortcut alongside Shift+Tab. Original design notes below:
  - **Manual** — pause to approve every permission request (current `default`).
  - **Auto** — auto-approve all permission requests so Claude runs on its own; NEVER pause for read/edit/bash file ops. Still surface genuine non-permission decision points: AskUserQuestion clarifications and plan changes ("something weird happened"). Maps onto existing gated `auto` mode but must work in the fork without Anthropic-internal `TRANSCRIPT_CLASSIFIER`/gate dependencies.
  - **Skip all** — never pause even for unsafe actions (existing `bypassPermissions`).
  - Key requirement: auto-approving *permissions* must NOT suppress *questions* that aren't permission-related.

---

## Fix plan — bug + architecture audit (2026-08-26)

Three structural faults, not seventeen independent bugs. Each one surfaced
repeatedly, which is why the plan is grouped by root cause rather than by symptom.

**R1 — Provider identity is inferred from credentials instead of asked of one
authority.** There is no function meaning "is Anthropic serving this request";
`getAPIProvider()` exists but the ambient convention is `isXSubscriber()`, so
authors reach for the wrong one. Telling detail: `claudeAiLimits.ts` has three
entry points that each re-check `isClaudeAISubscriber()` independently. PR #29
fixed one and missed two — the replicated gate made a partial fix look complete.

**R2 — The provider descriptor is anemic, so provider knowledge scattered into 18
files with no exhaustiveness checking.** `AUTH_PROVIDERS` carries four fields;
everything else a provider *is* lives elsewhere (`activeAuthProvider.ts` encodes
the credential predicate twice; `modelStrings.ts:30` uses a string-literal list
where `configs.ts:15` correctly uses `Exclude<APIProvider,…>`; `client.ts` has
four sequential `if (isXSubscriber())` branches). It fails silently: the
`default:` at `activeAuthProvider.ts:46` makes a forgotten provider return
**Anthropic's** credential state, so it reports itself logged in. No compile error.

**R3 — Tool lifecycle state has two owners and two teardown paths that disagree.**
The executor adds to `setInProgressToolUseIDs` (:267) but the only removal (:435)
sits inside `getCompletedResults()`, which early-returns when discarded (:413).
REPL keeps a parallel Set it never reconciles.

### PR A — standalone fixes
- [x] **P0a — prompt history lost on write failure.** (2026-08-27) `history.ts:317` clears
  `pendingEntries` *before* `await appendFile(...)` on :319. On EACCES/ENOSPC the
  catch only logs and the retry loop at :346 finds an empty buffer. One line.
- [x] **P0b — sweep orphaned build artifacts.** (2026-08-27) 145 `.bun-build` files, 8.2 GB of
  a 9.1 GB repo, from `bun build --compile` (`scripts/build.ts:197`). Gitignored
  (`.gitignore:10`), which is why it went unnoticed. Add a sweep to the build script.
- [x] **P0c — product name consistently "axa".** (2026-08-27) No `PRODUCT_NAME` constant exists
  and no `'axa'` literal appears in `src/`. 411 × "Claude Code" across 193 files,
  ~34 product-voice phrases (e.g. `tipRegistry.ts:275` "Ask Claude to create a
  todo list…"). **Not a blanket replace** — preserve verbatim: (1) config paths and
  env vars (`~/.claude.json`, `CLAUDE.md`, `.claude/`, `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_*`) which are load-bearing for existing installs; (2) model identity
  (`claude-opus-5`, anything on the wire); (3) vendor/billing truth (`claude.ai`,
  "Claude Pro/Max"). Route copy through one constant instead of scattering a new
  literal. Decide explicitly whether the `claude` bin alias (`package.json:10`) stays.

### PR B — R3: tool lifecycle *(real harm today)*
- [x] **P1a — `discard()` must cancel, not abandon.** (2026-08-27) It only sets a flag
  (`StreamingToolExecutor.ts:69-71`); the abort is observed at :335 inside
  `for await`, so a tool already in its subprocess never sees it. `query.ts`
  (:740/:934/:1013) then re-issues the same calls — a `git push` or `Write` runs
  **twice**, the first invisible because its messages were tombstoned. Fix: abort
  `siblingAbortController`, as the sibling-error path already does at :362.
- [x] **P1b — idempotent teardown.** (2026-08-27) Clear IDs in `discard()`; move
  `markToolUseAsComplete` into a `finally` (also `toolOrchestration.ts:148/:173`).
  Found while fixing: the `finally` alone does nothing on the concurrent path,
  because `all()` (`utils/generators.ts`) drives sub-generators with bare
  `next()` calls and never forwards a `return()` — it now returns what it
  started, which also fixes `hooks.ts:2744` orphaning its sub-generators.
  **Note:** `StreamingToolExecutor` is dead code in this fork —
  `config.gates.streamingToolExecution` resolves through
  `is1PEventLoggingEnabled()`, hard-stubbed to `false`, and both gate overrides
  are `USER_TYPE === 'ant'` only while `scripts/build.ts` bakes `'external'`.
  So `runTools`/`toolOrchestration.ts` is the only live tool path, and P1a is
  dormant too.
- [x] **P1c — REPL reconciliation.** (2026-08-27) `inProgressToolUseIDs` and
  `hasInterruptibleToolInProgressRef` (`REPL.tsx:1391/1392`) are never reset in
  `resetLoadingState`, `onCancel` or turn-end. Stranded rows are excluded from
  static rendering so Ink re-renders them every frame and the OSC 9;4 progress
  bar latches on; a stale-true interruptible ref makes
  `handlePromptSubmit.ts:321-331` abort the user's *next* legitimate turn.
  Reconciled in `onQuery`'s `finally`, **outside** the `queryGuard.end()` branch:
  `onCancel` calls `forceEnd()`, which bumps the generation so `end()` returns
  false — and cancellation is exactly the case that strands them. Not in
  `resetLoadingState`, which `onCancel` calls before the abort has propagated.
  Guarded on `!queryGuard.isActive` so a cancel+resubmit race does not clear the
  newer turn's state (same guard the auto-restore below it uses).

### PR C — R1: provider-aware identity
- [x] **P2a — one gate at the `claudeAiLimits` boundary.** (2026-08-27) Added
  `isServedByAnthropic()` (`utils/model/providers.ts`) and a single module-local
  `shouldTrackClaudeAiLimits()` that all three entry points now use. `:491`
  persisted `cachedExtraUsageDisabledReason: null` from third-party responses,
  which `check1mAccess.ts:11-20` reads as *extra usage enabled* — one turn on
  Kimi silently flipped the claude.ai account state, then `/model` offered
  `opus[1m]` and the request 429s. `:518` forced `status='rejected'` on any 429,
  so a Moonshot throttle reported the claude.ai limit as spent. `checkQuotaStatus`
  already had an ad-hoc `getAPIProvider() !== 'firstParty'` guard — that is the
  predicate, it was just on one of three doors. Bonus: the early-return in
  `extractQuotaStatusFromHeaders` clears stale claude.ai limit UI on a
  third-party turn rather than leaving it on screen.
- [x] **P2b — false "Not logged in" footer.** (2026-08-27)
  `useApiKeyVerification.ts:27,45` enumerated only claude.ai + Codex, so
  Ollama/DeepSeek/Kimi-only users got a permanent red prompt
  (`Notifications.tsx:308`) while the session worked. Replaced the list with
  `requiresAnthropicApiKey()`, built on `isServedByAnthropic()` — exhaustive by
  construction, so the next provider added does not inherit the warning.
- [x] **P2c — provider-blind labels.** (2026-08-27) `model.ts:498` (via
  `status.tsx:356`, `model.ts:820`) and `logoV2Utils.ts:263-269` reported
  "Opus 5" / "Claude Max" while Moonshot served every request. Both roots now key
  on `getActiveAuthProvider()`: billing via an exhaustive `switch` with no
  `default` (a new provider without a label is a compile error), model
  description via the provider catalog, which subsumes the Codex special case.
  Removed the now-dead `describeDefaultCodexModel()`. Verified across all five
  providers with Anthropic tokens still stored — the condition that produced the
  bug — and confirmed the pre-fix code reports "API Usage Billing / Sonnet 5"
  for every one of them.

### PR D — R2: descriptor refactor *(the centerpiece)*
- [x] **P3a — `ProviderDescriptor` + `PROVIDERS: Record<AuthProviderId, …>`.** A
  full `Record`, not `Partial`, not an array — incompleteness becomes a compile
  error. New `src/config/providers/`, one file per provider. Merges the two
  registries (`authProviders.ts` + `providerModels.ts`).
- [x] **P3b — credentials into the descriptor** (`hasCredentials`, `clearAuth`,
  `storedModel` policy). Removes the double-encoded predicate
  (`activeAuthProvider.ts:34-51` vs :77-88), the dangerous `default:` at :46, the
  Ollama special-cases at :128/:153, and `logout.tsx:86-122`'s four copies.
- [x] **P3c — model-string resolution type-enforced.** Kill the literal list at
  `modelStrings.ts:30`; adopt the `Exclude<APIProvider,…>` pattern from
  `configs.ts:15`. Review `model.ts` and `modelOptions.ts` for the same shape.
- [x] **P3d — collapse `client.ts`'s four branches** (:320/:335/:360/:378) behind
  `createFetch` on the descriptor, and apply `limitRequestConcurrency` centrally.
  Fixes by construction: `getMaxConcurrentRequests` currently has ONE call site
  (:381) inside the Kimi branch, so any other provider declaring a limit is
  silently ignored — the exact bug class PR #29 existed to prevent.
- [x] **P3e — account UI iterates the registry** (`logout`, `switchAccount`,
  `ConsoleOAuthFlow`).
  - **Success criterion:** adding a provider drops from **18 files / +503 lines**
    (measured from the Kimi commit `269271b`) to ~2, with the compiler rejecting
    an incomplete one.

### PR E — narrow dedup
- [x] **P4a — extract `anthropic-sse.ts`.** The ~55-line backpressure engine is
  character-identical between `codex:610-700` and `deepseek:275-365` (the 42
  differing lines are comments); `estimateTokenCountResponse` has **three** copies
  (`count-tokens-shim.ts:32`, `codex:1267`, `deepseek:818`); `formatSSE` is
  duplicated; and `anthropicErrorType` has already diverged — deepseek:838 is
  missing the `413 → request_too_large` case. **Do not unify the adapters
  themselves**: Codex targets the Responses API, DeepSeek targets Chat Completions,
  and a shared translation interface would be forced.
- [x] **P4b — delete dead per-provider helpers.** Zero references:
  `getKimiModelLabel`, `isKimiModelId`, `getDeepSeekModelLabel`,
  `isDeepSeekModelId`. Also over-exported: `getToolSearchMode`,
  `getAutoToolSearchCharThreshold`, `DEFAULT_OLLAMA_BASE_URL`, `CODEX_EFFORTS`.

### PR F — backlog hygiene
- [x] **P5 — correct the stale P2/P3 entries below** (2026-08-27). Doc-only, and
  `docs/` is gitignored, so there is no PR F; the change lives in this file.

### PR G — user-facing feature
- [x] **F1 — provider status lights on the startup banner** (2026-08-27, PR #35,
  `ef96a67`). Shipped as `getProviderStatusLights()` in `logoV2Utils.ts` plus a
  shared `components/LogoV2/ProviderStatusLights.tsx`, rendered by both `LogoV2`
  and `CondensedLogo`. Four departures from the plan below:
  - **Added a line rather than replacing one.** P2c had already made the billing
    label provider-aware, so the identity line was no longer wrong; the lights
    sit above it.
  - **Hidden below two connected accounts** — one account needs no
    disambiguation, and a row of dim glyphs reads as a setup checklist.
  - **Hidden when `CLAUDE_CODE_USE_BEDROCK/_VERTEX/_FOUNDRY` is set**, since no
    stored account serves the session and there is no active one to emphasise.
    (Copilot round 1 caught this.)
  - **Width-aware**: unconfigured entries drop from the right, and the line is
    dropped entirely rather than truncated. `ProviderDescriptor` gained an
    optional `shortLabel`, used only for `OpenAI Codex` → `Codex` — the single
    label pushing the five-provider line past the 50-column panel.
  - Still open: the `layoutMode === 'compact'` branch (< 70 columns) renders only
    the billing line; the lights do not fit and were left out.

  Original description: Replace the
  Anthropic-shaped identity line ("Opus 5 (1M context) · Claude Max ·
  <org>", which renders even when another provider is serving) with a list of
  connected providers, each with a status light, plus the active provider and
  its model.
  - Where: `logoV2Utils.ts` `getLogoDisplayData()` (:248-279) supplies
    `billingType`; `src/components/LogoV2/` renders it; `getBannerOrganization()`
    (:281+) supplies the org. `CondensedLogo` shares the same data.
  - Why the current shape is wrong: `billingType` (:266-270) is an ordered
    ternary, and the comment at :262-265 records that Codex had to be moved
    *first* because a Codex session reported "Claude Max" from leftover Anthropic
    tokens. That fixed the symptom by ordering, not by asking which provider is
    active — so Kimi/DeepSeek/Ollama still fall through to "Claude Max". Fault R1,
    on the banner. Supersedes the `logoV2Utils` half of P2c.
  - Buildable **before** P3: `hasCredentialsForAuthProvider()`
    (`activeAuthProvider.ts:31`) already covers all five providers, and
    `getActiveAuthProvider()` gives the current one. Cleaner after P3 (iterate
    `PROVIDERS` rather than two registries).
  - **Decided 2026-08-26 — (a) credentials-only.** Green = stored credentials,
    dim = not configured. Zero latency, zero cost; it cannot detect an expired
    key or a dead Ollama daemon, and that is accepted. The rejected alternative
    was a live probe, which adds startup latency and spends rate-limit budget —
    on Kimi (1 concurrent / 3 RPM) it could 429 before the user types anything.
    A local-only probe for Ollama stays possible later, where "configured but
    daemon down" is the realistic failure.
  - Layout: the box is ~95 chars and shares a row with the activity feed, so the
    list needs one compact line (e.g. `Anthropic ● Codex ● Kimi ○ DeepSeek ○`)
    with the active provider emphasised and the model on its own line.

### Verified stale (2026-08-26) — acted on 2026-08-27
The audit found that five of six P2/P3 maintenance entries described work that
was already done, or described it wrongly. They have been removed from those
sections, with the reason for each recorded under "Removed as already done".
Only *config-driven custom models* survived as real.

### Verification (no test suite exists)
Per PR: `tsc --noEmit` diff against baseline must show **zero new** errors, clean
`bun run build:dev:full`, and a manual smoke on two providers via
`/switch-account`. This constraint is why PR D is shaped around exhaustive
`Record`s — it makes the type checker the safety net.

The baseline is **1441** errors on `main`, not the ~1700 this section claimed
until 2026-09-04. Measured four ways on 2026-09-04 — bare on `main`, bare in a
worktree, with `-p .`, and again after a merge — all 1441; there is exactly one
`tsconfig.json`, so `-p .` is a no-op and the variable is the *tree*, never the
invocation. A looser `grep -c error` gives 1474 and is not the same measure.
Compare sorted sets, never counts, and regenerate the baseline in the same
worktree: the absolute figure does not travel between checkouts, the delta does.

**What the gate cannot see.** Template-literal text is not code to `tsc`,
`noUnusedLocals` is off, and there is **no eslint config at the repo root and no
lint script in `package.json`** — while the tree carries inert
`// eslint-disable-next-line custom-rules/...` comments that imply otherwise. A
branch shipped a broken model-facing prompt on 2026-09-04 with a perfect 1441.
So for any branch touching model- or user-facing strings, a delta typecheck is
**not** a verification: the string has to be executed or rendered and its output
asserted.

### Follow-ups opened by the 2026-09-04 fix round
Each is a separate branch with its own audit — none is a "known issue, not
fixed".

- [ ] **Async hook registry is keyed on the pid, and pids get recycled.**
  `processId` is built as `async_hook_${child.pid}` at both spawn sites in
  `src/utils/hooks.ts` and used as the `pendingHooks` key in
  `src/utils/hooks/AsyncHookRegistry.ts`. If a hook is still pending when a later
  hook is born on a recycled pid, `pendingHooks.set` **silently replaces** the
  earlier entry: that hook leaves the registry with no outcome — no
  `emitHookResponse`, no attachment, nothing shown to the user — while its
  process keeps running. The window is not as theoretical as it sounds:
  `CONFIG_ASYNC_HOOK_TIMEOUT_MS` keeps a hook pending for up to 10 minutes, and
  on Linux with the default `pid_max` (32768) a wraparound inside that window is
  within reach of a loaded machine. Fix: give the registry its own key (a counter
  or an id minted at registration) instead of deriving it from the pid, which is
  the OS's identifier and not ours; the pid stays useful as data, not as
  identity. **Pre-existing, not introduced by PR #81.** #81 closed only the
  consequence it had itself introduced — an orphaned timer reporting the
  *replacement* entry as expired — with an identity guard in
  `registerPendingAsyncHook`. That guard prevents the false report but does
  **not** recover the lost hook, which is this entry. Audit separately: it
  touches the registry key, so every `get`/`set`/`delete` on `pendingHooks`,
  including `removeDeliveredAsyncHooks` and `attachments.ts`.
- [ ] **R5 — `asyncRewake` hooks are still bounded by the wrong thing.**
  `executeInBackground` has two exits; with `asyncRewake` it returns `true`
  *before* `shellCommand.background()` and before `registerPendingAsyncHook` —
  deliberately, since `background()` calls `spillToDisk()` and would break
  in-memory stdout capture. No `background()` means no `#cleanupListeners()`, so
  `wrapSpawn`'s timer stays armed and `{"timeout": 30, "async": true,
  "asyncRewake": true}` is still killed at 30s. This is the regression R1 closed,
  surviving on the *other* exit of the same function. Non-blocking (the hook is
  bounded by the wrong thing, not unbounded); PR #81 only scoped the
  `CONFIG_ASYNC_HOOK_TIMEOUT_MS` docblock so it stops promising a backstop it
  does not provide.
- [ ] **`supportsToolSearch` passes by omission.** The gate is `if (catalog &&
  !catalog.supportsToolSearch)`, and `supportsToolSearch` lives on
  `ProviderModelCatalog` — but `ollama.ts` has no `catalog` at all, so Ollama
  reads as capable with no fetch adapter to protect it. Fix: make the field
  required on `ProviderDescriptor` itself. No "is Anthropic" predicate.
- [ ] **This fork has no working auto-update path.** `MACRO.PACKAGE_URL` resolves
  to `pkg.name` = `axa-chat` (`build.ts:190`), `package.json` is `private: true`
  with no `publishConfig`, and `npm view axa-chat version` returns **E404** (run,
  not inferred). `getLatestVersion()` returns `null` on that, the `latestVersion
  &&` guard never passes, and the whole npm branch of the auto-updater — both its
  user-facing strings and the stuck `isUpdating` flag PR #77 fixes — is inert
  until the package is published or `PACKAGE_URL` points at a real registry.
- [ ] **Product-name axis** (`audit-2`, after the merges; classification pass
  first, no edits). `PRODUCT_NAME` is `'AXA Chat'` but `git grep "Claude Code" --
  src/` gives 388 hits across 185 files, ~193 inside string literals. Three
  different things, only one of which is drift: **self-reference** (tip registry,
  `skills/bundled/stuck.ts`, `debug.ts`) is real drift; **model-facing identity**
  (`constants/system.ts:9-10`, `prompts.ts:470`, `DEFAULT_AGENT_PROMPT` at
  `prompts.ts:782`) changes what the model is told it *is* and is a product
  decision, not a rename; **references to the actual product**
  (`constants/github-app.ts`) must stay. Exemplar, verified at source:
  `bridge/bridgeEnabled.ts:170` says "Your version of Claude Code" *and* a
  hand-written `` `claude update` `` with no `BINARY_NAME` — both axes in one
  literal. Its neighbours at `:74`/`:77`/`:80` say "claude.ai", which is the real
  product and stays.
- [ ] **`/issue` and `/share` route users to an Anthropic-internal Slack
  channel.** `prompts.ts:263` and `skills/bundled/stuck.ts:69` name
  `#claude-code-feedback` (`C07VBSHV7EV`). In a fork the model confidently offers
  a place the user cannot reach. Separate from the naming sweep and more urgent
  than it: this is a feedback path that does not exist.
- [x] **`.axa/settings.json` had narrower protection than the
  `.claude/settings.json` it replaced — FIXED by `1e957b4` on
  `fix/carveout-symlink-resolution`, unmerged as of 2026-09-04.** Kept here
  because the defect is live on `main` until that branch lands, and because the
  follow-on constraint below is the thing that actually bites.
  On `main` (`d29a5bc`), `isClaudeSettingsPath` accepts the two spellings by
  **different mechanisms with different reach**: `.claude/settings.json` and
  `.claude/settings.local.json` match an unconditional `endsWith`, commented
  *"Include .claude/settings.json even for other projects"*, so they are caught
  anywhere on disk; the `.axa` spelling is reached only through
  `getSettingsPaths().some(exact equality)`, which is session-scoped, and the rest
  of `isClaudeConfigFilePath` is `join(getOriginalCwd(), CONFIG_DIR_NAME, …)`,
  also cwd-anchored. A foreign project's `.axa/settings.json` was matched by
  neither. `1e957b4` extracts an `isSettingsFileUnder(configDirName)` helper and
  calls it for both `CONFIG_DIR_NAME` and the `'.claude'` literal, keeping the
  legacy arm rather than replacing it.
  **Consequence for the naming sweep, and it inverts with the merge.** The
  docblock example at `pathValidation.ts:130`/`:132` is a sibling-directory
  payload (`-/../.claude/settings.local.json`). Respelled to `.axa` *on `main`* it
  would no longer be caught by `isClaudeConfigFilePath` at all — the sentence
  would stay defensible while ceasing to be true for the reason it states. After
  `1e957b4` merges, `.axa` is matched by the same arm and the respelling becomes
  safe. **So this rewrite is blocked on that merge, not on judgement.** The
  general gate still applies to the rest of the sweep: does the comment name a
  spelling-specific mechanism? If yes, the code is deliberate — leave it.
- [ ] **`getClaudeConfigHomeDir` is one lexical root provider behind six roots —
  canonicalising it is the actual fix; the fold on
  `fix/carveout-symlink-resolution` is containment.** The permission chokepoint
  `allowOnlyIfResolvedFormsAgree` keeps an `allow` only if every form from
  `getPathsForPermissionCheck` decides with the *same reason string*. A carve-out
  therefore breaks exactly when its root is spelled lexically: the path-as-written
  hits the carve-out, the resolved form falls through to a different arm, the two
  reason strings differ, and the allow is dropped. Reached through a symlinked
  config dir — `CLAUDE_CONFIG_DIR=/link` where `/link -> /real`, which is the
  normal shape on macOS (`/tmp -> /private/tmp`) and for any home on a symlinked
  volume — the carve-outs below stop firing and the user is denied access to their
  own config files.
  Roots that build lexically off it, verified at `d29a5bc`:
  `getTeamsDir` (`utils/envUtils.ts:17`), `getProjectsDir`
  (`utils/sessionStorage.ts:198`, `utils/sessionStoragePortable.ts:325`),
  `getProjectDir` (`sessionStoragePortable.ts:329`, and through it `getSessionDir`
  → `getToolResultsDir` in `utils/toolResultStorage.ts`), `getMemoryBaseDir`
  (`memdir/paths.ts:85`), `getPlansDirectory` (`utils/plans.ts:79`), and the
  inline `jobsRoot` in `utils/permissions/filesystem.ts`. One defect, six
  symptoms — which is why fixing it at the root repairs carve-outs no fixture has
  measured, and why the per-carve-out fold cannot.
  Two adjacent facts found while enumerating:
  `getMemoryBaseDir` returns `CLAUDE_CODE_REMOTE_MEMORY_DIR` verbatim when set, so
  it is a second un-canonicalised root, not just a derived one. And
  `getPlansDirectory`'s traversal guard for the `plansDirectory` setting is
  `resolved.startsWith(cwd + sep)` over a `resolve()` result — `resolve()` does not
  consult the filesystem, so the guard is satisfied lexically regardless of where
  the directory actually points.
  **Not done on that branch, deliberately.** `getClaudeConfigHomeDir`
  (`utils/envUtils.ts:8`) has 157 references across 61 files, many on hot paths,
  and is `memoize`d on `() => process.env.CLAUDE_CONFIG_DIR` — so a canonicalising
  version computed once before the config dir exists (first run creates it) would
  cache the un-canonicalised value for the whole process, with the key giving no
  reason to recompute. `realpathSync` also throws on a path that does not exist
  yet, so the canonicalisation needs the same ancestor-walk-and-fall-back that
  `getPathsForPermissionCheck` already does (`utils/fsOperations.ts:255-267`).
  None of that is unsolvable; all of it is a blast radius that does not belong in
  a permissions bugfix. Do it as its own change, with the config-dir carve-out
  matrix (canonical root vs symlinked root, expected identical) as the gate.
- [ ] **No test suite at all.** No `test` script in `package.json`, no `*.test.*`
  anywhere. Every verification in the 2026-09-04 round therefore ran through
  baseline-diff typechecking, source reading, and hand-written probes. That
  worked, but it is a cost paid on every branch, and it is why the string-defect
  gate hole above exists.

### Facts worth not rediscovering (2026-09-04)
- **Copilot re-reviews.** `copilot-swe-agent` (`BOT_kgDOC9w8XQ`) starts the
  *first* review and then silently no-ops on every re-request, so it looks like
  it works. The reviewer that responds to re-requests is
  `copilot-pull-request-reviewer` (`BOT_kgDOCnlnWA`), and a REST attach is a
  silent no-op — the GraphQL `requestReviews` mutation is required.
- **Copilot findings are not all inline.** Some arrive as *suppressed comments*
  inside the `<details>` of the review body and never appear in
  `/pulls/N/comments`. Reading only the inline comments hid the most substantial
  finding of six rounds on PR #76.
- **`git push` cannot report a detached-HEAD miss.** With the worktree detached,
  `git push origin <branch>` resolves the stale *local* branch ref and
  republishes it identically: no failure to catch, and `git rev-parse HEAD` does
  not expose it because HEAD *is* the new commit. Verify with `git ls-remote
  --heads origin <branch>`, never with the exit code.
- **`git diff main..<branch>` is not a branch's change.** If the branch's base is
  old, commits added on `main` show up as *deletions by the branch*. Use `git
  diff $(git merge-base main <branch>)..<branch>`. This produced a false
  "two branches are removing `.axa/` from .gitignore" alarm.
- **Inline sourcemaps in `src/` are inert, and this was proved on the output
  side.** 548 files carry a `sourceMappingURL`, all of them `.tsx` — 96.6% of the
  567 `.tsx`, and zero of the `.ts` — ~12.4 MB of base64. The split by extension
  is what identifies it as an artefact of the transformation that produced the
  `.tsx` sources, which the raw count alone does not. `scripts/build.ts` never
  passes `--sourcemap`; note it shells out to the `bun build` **CLI** via
  `Bun.spawnSync` and does *not* call the `Bun.build()` API, so quoting the API
  default is the wrong citation for the right conclusion. But that is an
  *input*-side argument — it says the bundler was never told to consume them, not
  where they end up. The output side settles it: `grep -a -c sourceMappingURL` on
  a freshly built `cli-dev` returns **10**, against 548 in the tree, and those ten
  are Bun's own runtime strings (the JavaScriptCore tier names, the dev-server
  `/_bun/client/` literal), written `;base64,` where ours are
  `;charset=utf-8;base64,`. Zero of the 548 reach the binary. So editing a `.tsx`
  by hand desyncs a map nothing reads: **not a reason to refuse a fix, and not a
  per-branch defect.** An argument that, applied consistently, would freeze every
  `.tsx` in the repo is not an argument — and the thing that exposed it was the
  inconsistency, not the reasoning: the same reviewer refused one file for this
  reason after approving a commit that desynced its sibling.
- **A closed task hides a decayed signature.** Approvals are on a SHA, never on a
  branch — so a push after a signature decays it even when the commit is
  perfect. If the task is already marked `completed`, neither signal is visible.
  A push reopens the task.
- **Partition clearances come from the lead and are always verified.** Ownership
  reconstructed from file contents rather than from the assignment was wrong
  three times in one session, twice from an auditor and once from the lead.
- **A string can be right on the axis you are checking and wrong on another.**
  `marketplaceManager.ts:2145` interpolated `BINARY_NAME` correctly — so it
  passed every binary-name grep — but named `axa marketplace remove`, and
  `marketplace` is registered as `pluginCmd.command('marketplace')` under
  `program.command('plugin')` (`main.tsx:4181`), so that command path does not
  exist. For any string the user types, verify against the **command
  registration**, not against the constant.
- **`${...}` in a JSDoc or `//` comment does not interpolate.** Both directions
  are live defects: a `\${` inside a template literal ships the literal text
  `${CONFIG_DIR_NAME}` to the model, and a `${...}` written into a comment
  invents a dead interpolation. A future sweep must **not** "fix"
  `${CLAUDE_PLUGIN_DATA}` / `${CLAUDE_PLUGIN_ROOT}`: those are placeholder tokens
  substituted literally by `.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, …)`, so the
  braces are part of the real name.
- **A zero from a dead pipeline looks exactly like a real zero.** `tac` does not
  exist on macOS; a comment-strip that matched nothing and a comment-strip that
  matched everything both print an empty diff. Make the filter demonstrate that
  it ran — count the lines it matched, or inject a known defect and confirm the
  check reports it.

---

## P1 — Next

Competitor survey 2026-08-26. Two things worth stating up front, because both
were checked against the code rather than assumed:

- Nobody else has **concurrent multi-provider auth**. Crush and Pi switch
  *models*; this fork switches *accounts*, mid-conversation, with per-account
  persisted models. That is the part not to trade away.
- Rewind with file restore was on the shortlist until `/rewind` turned out to
  already do it (`MessageSelector.tsx:93-106`, `fileHistory.ts`). It is not a
  gap. The gap inside it is item 4 below.

- [x] **Kimi (Moonshot) as a concurrent provider** (2026-08-26, PR #28) — Landed
  as an account alongside the others: `/login`, `/logout`, `/switch-account`,
  persisted per-account model. No fetch adapter — the endpoint speaks Anthropic,
  so the SDK points at `https://api.moonshot.ai/anthropic` with a Bearer token.
  Four of the planning assumptions above were wrong; corrected here so they are
  not carried into the next provider:
  - **Model id is plain `kimi-k3`**, not `kimi-k3[1m]`. The suffix appears in
    Moonshot's Claude Code guide but 404s on the endpoint; `GET /v1/models`
    returns exactly `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`,
    `kimi-k2.6`. K2.5 and `moonshot-v1` are already gone.
  - **WebFetch is not unavailable.** It routes through `queryHaiku` →
    `getSmallFastModel()`, so the small-fast mapping fixes it. No separate
    capability flag was needed.
  - **Temperature is not rescaled** — Moonshot is 0–1, the same scale as
    Anthropic. The planned `temperature` descriptor field was dropped.
  - **Tool search does need forcing off**; that one was right, and is now
    `supportsToolSearch: false` on the descriptor rather than an env var.
  - Generalised beyond Kimi: `ProviderModelCatalog` gained `smallFastModel`
    (fixing a pre-existing Ollama 404 too) and `supportsToolSearch`; the Ollama
    count-tokens adapter became the shared `count-tokens-shim.ts`; and an
    `Authorization` header leak affecting both native-Anthropic providers was
    closed.
  - Still open: pricing remains unverified from primary source.

- [x] **Per-provider rate-limit handling** (2026-08-26, PR #29) — Closes the
  Tier-1 gap noted above (concurrency 1, 3 RPM below $10 spend, versus a ten-way
  subagent fan-out). `src/services/api/requestLimiter.ts` caps in-flight requests
  per provider at the **fetch** layer, the one place every caller (subagents,
  session titles, WebFetch, quota probes) already passes through.
  - The slot is held until the response **body** finishes, not until the fetch
    resolves — `claude.ts:1861` returns the stream and it is consumed outside
    `withRetry`, so releasing on resolution would let the whole fan-out through
    at once. The Response is rebuilt rather than having `.body` patched, since
    `.json()`/`.text()` read the internal body and would never release.
  - Kimi caps at 1, overridable via `CLAUDE_CODE_MAX_CONCURRENT_REQUESTS` for
    accounts that have moved up a tier (nothing in the API reports the tier).
  - Two provider-blind bugs fixed alongside: the 429 retry gate and the
    `checkQuotaStatus` probe both keyed off `isClaudeAISubscriber()`, which
    reports on stored Anthropic credentials no matter which account is active —
    so after `/switch-account` a third-party 429 got no retries at all, and every
    turn paid for a quota probe only Anthropic can answer. Fixed at those two
    decision points, not globally: the helper has ~70 callers and most
    legitimately mean "has a claude.ai subscription" for billing/upgrade UI.
  - Also: `Retry-After: 0` is floored at the backoff minimum, and background jobs
    bail on 429 rather than retrying into a spent per-minute window.

- [ ] **Computer use — native desktop control** (design 2026-09-05). Full design:
  **`docs/COMPUTER-USE.md`**. Everything — libraries, files to add, files to
  change, tool contract, permissions, signing, packaging, implementation order —
  lives there; do not duplicate it here.

- [ ] **Browser use via MCP** — separate from the above and not a prerequisite
  for it. No repo code: point the existing MCP layer at a pinned
  browser-automation server. Reads pages as accessibility snapshots, not pixels,
  so it works on every provider and costs a fraction of screenshot control. Real
  work is (1) a first-class enablement path instead of hand-edited MCP JSON,
  (2) the capability set — `storage`/`network`/`devtools`/`testing` off by
  default, (3) permission rules written *before* it ships, (4) a decision on
  `browser_evaluate` / `browser_run_code_unsafe`, which run arbitrary page code
  and sit in the server's core set, and (5) persistent profile (inherits the
  user's logins) vs isolated.

- [ ] **MCP permission rules have no argument granularity** — `toolMatchesRule`
  returns `false` for any rule with `ruleContent`, and the generic MCP
  `checkPermissions` returns `passthrough`, so `mcp__computer-use__type(Terminal)`
  parses, persists, and silently never matches. Found while designing computer
  use; affects every MCP server, so it is its own defect.

- [ ] **`/fork` — branch a session and stay in the original** — Shipped by both
  Kimi Code and Codex CLI (`codex exec fork`), so the interaction is proven.
  Take the current conversation to a new session id, leave this one untouched,
  and let the user keep going in whichever they choose. Natural pairing with the
  existing `/rewind`: rewind discards a branch, fork keeps it.
  - Touches `src/utils/sessionStorage.ts` and the resume picker; the message
    array is already persisted per session, so the work is mostly identity and
    UI, not data model.

- [ ] **Goal mode (`/goal`)** — The ambitious one; a change of mental model, not
  an afternoon. Only Kimi has it (Droid "Missions" and Amp's self-scheduling
  agents are different things).
  - Declare an *outcome*, not a task. Every turn re-evaluates against it and
    reports one of complete / paused / blocked, so a long task stops drifting
    from what was actually asked.
  - Kimi also ships a goal **queue** (`pause|resume|cancel|replace|next`) and
    non-interactive exit codes 0/3/6. The queue is the half that makes it more
    than a persistent reminder in the prompt.
  - Prerequisite worth settling first: what counts as evidence a goal is met.
    Without that it degrades into a system prompt that says "remember the goal".

---

## P2 — Medium

- [ ] **Config-driven custom models (zero-PR model registration)** — Build on the model registry (PR #16, `src/utils/model/registry.ts`). Add a `customModels` array in `settings.json` that is loaded into `MODEL_REGISTRY` at startup, so a new model (e.g. Opus 5.1 when it ships) can be added with no code change / no PR. Each entry mirrors `ModelDescriptor`: `{ id, family, displayName, pricingTier|pricing, supports1M, effort, maxEffort, adaptiveThinking, structuredOutputs, maxOutput, knowledgeCutoff, default? }`.
  - Surface it in the two-level `/model` picker under the right family (`getModelFamilies()` currently hardcodes the version list — make it merge registry + customModels).
  - `default: true` should make it the default for that family (feeds `getDefaultOpusModel()` etc.).
  - Adapt the load-time assertion: config-supplied descriptors aren't in `ALL_MODEL_CONFIGS`, so relax the key/config-identity check for them (keep canonical⊂providerIDs, output-range, single fast-mode).
  - Optional: a `/model` "add version" interactive flow that writes the settings entry for the user.
  - Note: today you can already *use/default* an unregistered model via `settings.model` / `--model` / `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL`, and `ANTHROPIC_CUSTOM_MODEL_OPTION` adds a flat picker entry — but none of those give it registry capabilities (pricing, 1M, effort) or place it under the family. This task closes that gap.


## P3 — Low (Maintenance)

- [x] **Update Bun** — 1.3.11 is old and newer versions bring memory
  improvements. The "fixes ZlibError on startup" rationale this entry used to
  carry was removed on 2026-08-27: it could not be reproduced, and no such error
  appears anywhere in the codebase or the build output.

### Removed as already done (2026-08-27)
Each of these was verified against the code before deletion, so they are
recorded here rather than silently dropped.

| Entry | Why it went |
|---|---|
| Codex stream backpressure (P2) | `desiredSize` was already checked before every enqueue. The whole buffer then moved to the shared `sse-backpressure.ts` in PR #34. |
| Codex pull-based stream refactor (P3) | The stream had already been `pull()`-based; the entry's premise ("`start()`-based, doesn't pause upstream reads") was false. Now shared, and covered by a backpressure assertion in PR #34's verification. |
| SSE sequence number cleanup (P3) | `SSETransport.ts:368-374` already caps the set at 200 and evicts oldest. Not unbounded. |
| MCP auth error logging (P3) | Misdescribed: there are 105 log calls on those paths. The one genuinely silent catch (:1093) is deliberate and commented. |

---

## Completed

### Repo sentinel (2026-08-25, PR #26 + #27)
- [x] After a turn that changed files, run the project's verify command and report **only** the failures those edits introduced — baseline is shrink-only, diagnostics compared with line/column stripped
- [x] Change detection via `git diff HEAD` + `ls-files --others`, not `git status` (which collapses untracked dirs and whose output does not change on a second edit to the same file)
- [x] Opt-in `repair`: fixes the regression in a throwaway worktree, re-verifies there, and shows a patch — the user's working tree is never written to
- [x] PR #27: the patch was emitted at `info` level, which `SystemTextMessage.tsx:201` drops without `--verbose`, so the whole repair was invisible

### Auto approval mode by default (2026-07-29)
- [x] New interactive local sessions now start in **Auto** approval mode (`isDefaultPermissionModeAuto()` + `initialPermissionModeFromCLI` fallback)
- [x] Guardrails: respects an explicit `permissions.defaultMode`, never forces auto in `CLAUDE_CODE_REMOTE` or non-interactive/print sessions

### P2 Dynamic Model Registry (2026-07-29)
- [x] Data-driven registry `src/utils/model/registry.ts` — each 4.5+/5-series model declares capabilities (1M, effort, maxEffort, adaptiveThinking, structuredOutputs, maxOutput, pricingTier, knowledgeCutoff, displayName, family) in one entry
- [x] `getModelDescriptor()` resolves by canonical substring across all provider ID forms (+ `[1m]`); pre-4.5 models fall through to legacy substring ladders
- [x] Rewired name/canonical/cost + `modelSupportsX` (effort, 1M, thinking, structured outputs, max output, knowledge cutoff) to be registry-first
- [x] Adding a model is now a single registry entry — fixes the `claude-opus-5`-breaks-`claude-opus-4`-prefix trap
- [x] Added **Opus 5** via the registry: new firstParty default Opus (Max/Team/ant), `$5/$25`, 1M context, effort + max effort, 64k/128k output, two-level picker entry
- [x] Folded stale display constants into the registry: system-prompt "latest models" line, fast-mode model display (`getFastModeModelDescriptor`), commit `sanitizeModelName`, and the codename-leak attribution fallback now all derive from the registry (fast mode intentionally stays Opus 4.6 — premium infra is 4.6-specific)

### Project Setup (2026-07-16)
- [x] Connected local folder to GitHub, renamed to `axa-chat`, alias `axa`, `bun run update`

### P0 Memory Leak Fixes (2026-07-17)
- [x] Reset permissionDenials + loadedNestedMemoryPaths per turn
- [x] Release Codex stream reader in finally block
- [x] Fix compaction circuit breaker → exponential backoff (never give up)
- [x] Pre-compaction backup to disk + backup path in summary
- [x] Live context & RAM usage indicator in status bar
- [x] Discriminated union for AutoCompactOutcome + CompactFailureTracking
- [x] Backup chunking (5MB) + cleanup (keep last 3 sets)

### P1 New Model Support (2026-07-17)
- [x] Added Opus 4.7, 4.8, Sonnet 5, Fable 5, Mythos 5
- [x] Updated defaults: Opus 4.8 (Max), Sonnet 5 (standard)
- [x] New aliases: fable, mythos, fable[1m], mythos[1m]
- [x] Pricing tiers for all new models
- [x] 1M context + 128k output for all new models
- [x] Adaptive thinking + effort for new models
- [x] Fable 5 always-on thinking guard with logged overrides
- [x] Two-level model picker (family → version selection)
- [x] Dynamic model picker labels (derive from getMarketingNameForModel)

### P2 Bug Fixes (2026-07-17)
- [x] Rebrand UI: "Free Code" → "AXA Chat" + ▲▲ ╳ ▲▲ logo
- [x] Voice recorder SIGKILL fallback (500ms timeout, identity guard, safe kill)
- [x] SSE close callback (idempotent, fires onCloseCallback)
- [x] Build feature flag validation (warns on unknown flags)
- [x] Codex error logging (logForDebugging on JSON parse + body errors)
- [x] MCP timeout → AbortController (replaces Promise.race)
