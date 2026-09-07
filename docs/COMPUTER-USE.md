# Computer Use — implementation specification

**Created:** 2026-09-05
**Status:** Decided. Building Feature B complete — full native desktop control,
full tool surface. Not staged behind a browser-only release, not shell-out.
**Research:** All seven area agents, 2026-09-05. Findings inline; corrections to
earlier drafts at the end.
**Tracked from:** `docs/TODO.md` (P1), which holds only a pointer to this file.

---

## 1. What we are building

The model sees the macOS screen and drives the mouse, keyboard, clipboard and
applications. Complete surface: screenshots, zoom, all mouse actions, keyboard
including held modifiers, clipboard read/write, app launching, display switching,
and batched actions. Session-scoped, per-app user consent. A global stop key.

This replaces three absent packages — `@ant/computer-use-mcp`,
`@ant/computer-use-input`, `@ant/computer-use-swift` — with in-tree equivalents,
and closes the fork-specific defects that would otherwise ship with them.

**Not in scope:** browser automation via MCP. That is a separate, config-only
feature and it is not a prerequisite for this one. It is recorded in
`docs/TODO.md` on its own.

### Why the existing code is not enough

`src/utils/computerUse/` contains the host half and it is good code — the MCP
interposition, the cross-process lock, the run-loop pump, the consent flow and
the cleanup paths are all present and all correct. What is missing is
everything that *defines* and *performs* the actions:

| Absent package | What it owned | We must write |
|---|---|---|
| `@ant/computer-use-mcp` | Tool schemas, MCP server factory, session-context dispatcher | Tool contract + dispatcher |
| `@ant/computer-use-input` | Mouse/keyboard synthesis (enigo) | Native input |
| `@ant/computer-use-swift` | ScreenCaptureKit capture, app enumeration, TCC checks, ESC tap | Native capture + AppKit + CGEvent |

None is in `package.json`; there is no `node_modules/@ant`. The tool
*parameters*, required flags and model-facing descriptions are therefore unknown
— `toolRendering.tsx` switches on names but has a `default: return ''`, so it is
a **lower bound on the surface, not an enumeration**. `switch_display` is
evidenced only in `wrapper.tsx` and `AppStateStore.ts` comments.

---

## 2. Target architecture

```
                    model
                      │  mcp__computer-use__screenshot { }
                      ▼
   ┌──────────────────────────────────────────────────┐
   │ services/mcp/client.ts                            │
   │  · name match → InProcessTransport (no subprocess)│
   │  · spreads getComputerUseMCPToolOverrides():      │
   │      .call()  → dispatcher      ← NEW             │
   │      .checkPermissions() → policy ← NEW           │
   │      rendering overrides                          │
   └───────────────┬──────────────────────────────────┘
                   ▼
   ┌──────────────────────────────────────────────────┐
   │ utils/computerUse/                                │
   │  tools/schemas.ts    24 tool definitions   ← NEW  │
   │  tools/dispatch.ts   name → executor call  ← NEW  │
   │  permissions.ts      per-tool-class policy ← NEW  │
   │  prompt.ts           system-prompt hint    ← NEW  │
   │  executor.ts         EXISTS — retarget imports    │
   │  wrapper.tsx         EXISTS — swap dispatcher     │
   │  mcpServer.ts        EXISTS — own Server factory  │
   │  gates.ts            EXISTS — replace sub gate    │
   │  lock/pump/cleanup/escHotkey  EXIST — unchanged   │
   └───────────────┬──────────────────────────────────┘
                   ▼  N-API
   ┌──────────────────────────────────────────────────┐
   │ native/computer-use/  (Rust, napi-rs)      ← NEW  │
   │  capture  ScreenCaptureKit → JPEG                 │
   │  input    enigo → mouse/keys/text                 │
   │  apps     NSWorkspace enumerate/launch/hide       │
   │  display  CGDisplay geometry, scale               │
   │  tcc      AXIsProcessTrusted, CGPreflight…        │
   │  hotkey   CGEvent tap (ESC)                       │
   │  pump     CFRunLoopRunInMode drain                │
   └──────────────────────────────────────────────────┘
```

The key structural fact that makes this tractable: **ListTools and CallTool are
independent seams.** `mcpServer.ts` answers ListTools from an in-process
`Server` whose handler it overwrites anyway; `client.ts` (~:1985) spreads
per-tool overrides supplying `.call()` directly. The package's own CallTool
handler was already a stub. So the tool contract can be built, listed, rendered
and permission-checked **before any native code exists** — and that is how we
sequence it, without it being a lesser product.

---

## 3. Dependencies

### 3.1 Already present — use these, add nothing

| Package | Version | Used for |
|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.29.0` | `Server`, `ListToolsRequestSchema`. We write our own `createComputerUseMcpServer` against this — no new dep. |
| `sharp` | `^0.34.5` | Only if we post-process captures. Prefer encoding JPEG natively; see 3.3. |
| `execa` (via `utils/execFileNoThrow.ts`) | `^9.6.1` | `pbcopy`/`pbpaste`, `codesign`, any shell-out. |
| `zod` (transitively, via the MCP SDK) | — | Tool input schemas. Check the resolved version before authoring schemas. |

**No new npm dependency is required for the TypeScript half.** That is a
deliberate constraint: the only new artifact is our own native addon.

### 3.2 The native addon — one Rust crate, replacing two packages

A single N-API addon at `native/computer-use/`, built with **napi-rs v3**
(`napi`, `napi-derive`, and `@napi-rs/cli` as a devDependency). One crate rather
than two because the original split was Rust-for-input / Swift-for-capture, and
that split forces a Swift toolchain into the release path for no benefit —
ScreenCaptureKit and AppKit are reachable from Rust through the `objc2` family.

| Crate | Purpose | Replaces |
|---|---|---|
| `napi`, `napi-derive` | N-API bindings, async task support | — |
| `enigo` | Mouse move/click/scroll, key press/release, text typing | `@ant/computer-use-input` |
| `objc2`, `objc2-foundation` | Objective-C runtime and base types | `-swift` |
| `objc2-app-kit` | `NSWorkspace` (list installed/running, launch, hide, activate), `NSRunningApplication` | `-swift` apps.* |
| `objc2-screen-capture-kit` | `SCShareableContent`, `SCContentFilter`, `SCScreenshotManager` | `-swift` screenshot.* |
| `objc2-core-graphics` | `CGEvent` tap for the ESC hotkey, `CGDisplay*` geometry, `CGPreflightScreenCaptureAccess` | `-swift` display.*, hotkey.*, tcc.screenRecording |
| `objc2-application-services` | `AXIsProcessTrusted` | `-swift` tcc.accessibility |
| `core-foundation` | `CFRunLoopRunInMode` for the main-queue pump | `-swift` `_drainMainRunLoop` |
| `objc2-image-io` (or `CGImageDestination` via `objc2-core-graphics`) | Encode `CGImage` → JPEG q0.75 in-process | `-swift` screenshot encoding |

Pin exact versions in `Cargo.toml`; the `objc2-*` family moves fast and its
bindings are generated, so a minor bump can rename types.

### 3.3 Encode JPEG natively, do not round-trip through sharp

Capture yields a `CGImage`. Encoding to JPEG in the addon via
`CGImageDestination` keeps a multi-megabyte RGBA buffer out of JS entirely and
matches the original's quality 0.75. Returning raw pixels for `sharp` to encode
would cross the N-API boundary with the largest possible payload on the hottest
path. Resize is done **at capture time** by passing target dimensions into
`SCScreenshotManager`, exactly as the original did via `targetImageSize`.

We must reimplement `targetImageSize(physW, physH, API_RESIZE_PARAMS)` — its job
is to pre-size so the server-side transcoder early-returns. Put it in
`utils/computerUse/resize.ts`, in TypeScript, so the policy is inspectable, and
pass the result into the native call.

---

## 4. Files to add

```
native/computer-use/
  Cargo.toml                 pinned deps, cdylib crate-type
  build.rs                   link ScreenCaptureKit, AppKit, ApplicationServices
  src/lib.rs                 #[napi] exports — the whole surface in §5
  src/capture.rs             SCShareableContent → SCContentFilter → CGImage → JPEG
  src/input.rs               enigo wrappers; grapheme-aware typing
  src/apps.rs                NSWorkspace enumerate / launch / hide / unhide / activate
  src/display.rs             CGDisplay geometry, scale factor, display list
  src/tcc.rs                 AXIsProcessTrusted, CGPreflightScreenCaptureAccess
  src/hotkey.rs              CGEvent tap register/unregister/notifyExpected
  src/pump.rs                CFRunLoopRunInMode drain
  prebuilds/
    darwin-arm64/computer-use.node
    darwin-x64/computer-use.node

scripts/
  build-native.ts            cargo build → prebuilds/, invoked before build.ts
  install-native.ts          extract embedded addon to cache dir at runtime

src/utils/computerUse/
  tools/schemas.ts           the 24 tool definitions (§6)
  tools/dispatch.ts          replaces bindSessionContext
  tools/types.ts             the types formerly from @ant/computer-use-mcp/types
  permissions.ts             per-tool-class policy (§7)
  prompt.ts                  provider-neutral system-prompt hint (§9)
  resize.ts                  targetImageSize + API_RESIZE_PARAMS equivalents
  sentinelApps.ts            getSentinelCategory — shell/filesystem/system_settings
  nativeLoader.ts            replaces inputLoader.ts + swiftLoader.ts
```

`inputLoader.ts` and `swiftLoader.ts` are deleted; `nativeLoader.ts` loads the
single addon.

---

## 5. Native addon API surface

Reconstructed from every call site in `executor.ts`, `hostAdapter.ts`,
`escHotkey.ts`, `drainRunLoop.ts` and `cleanup.ts`. **E** = evidenced by a call
site, **I** = inferred. Implement all of E; treat I as design freedom.

### 5.1 Input (was `@ant/computer-use-input`)

| Export | Signature | Notes |
|---|---|---|
| `isSupported` | `boolean` | Discriminant checked before use (E) |
| `moveMouse` | `(x, y, relative: boolean) => Promise<void>` | Called with `false` (E) |
| `mouseButton` | `(btn: 'left'\|'right'\|'middle', action: 'click'\|'press'\|'release', count?: 1\|2\|3) => Promise<void>` | E |
| `mouseScroll` | `(amount: number, axis: 'vertical'\|'horizontal') => Promise<void>` | E |
| `mouseLocation` | `() => Promise<{x, y}>` | E |
| `key` | `(name: string, action: 'press'\|'release') => Promise<void>` | E |
| `keys` | `(parts: string[]) => Promise<void>` | Chord; `'+'`-split upstream (E) |
| `typeText` | `(text: string) => Promise<void>` | E |
| `getFrontmostAppInfo` | `() => {bundleId?: string, appName: string} \| null` | **Synchronous** (E) |

### 5.2 Capture, apps, display, TCC, hotkey (was `@ant/computer-use-swift`)

| Namespace | Export | Signature | Notes |
|---|---|---|---|
| `display` | `getSize` | `(displayId?) => {width, height, scaleFactor}` | **Synchronous** (E). Logical dims + scale |
| | `listAll` | `() => Display[]` | E |
| `screenshot` | `captureExcluding` | `(allowedBundleIds: string[], jpegQuality: number, targetW, targetH, displayId?) => Promise<ScreenshotResult>` | **Allow-list despite the name** (E) |
| | `captureRegion` | `(allowed, x, y, w, h, outW, outH, quality, displayId?) => Promise<ScreenshotResult>` | Logical coords (E) |
| `apps` | `prepareDisplay` | `(allowlist, hostBundleId, displayId?) => {hidden: string[], activated?: string}` | E |
| | `previewHideSet` | `(allowlist, displayId?) => Array<{bundleId, displayName}>` | Feeds the consent dialog's "N hidden" (E) |
| | `findWindowDisplays` | `(bundleIds) => Array<{bundleId, displayIds: number[]}>` | E |
| | `appUnderPoint` | `(x, y) => App \| null` | E |
| | `listInstalled` | `() => InstalledApp[]` | E |
| | `iconDataUrl` | `(path) => string \| null` | **Synchronous** (E) |
| | `listRunning` | `() => RunningApp[]` | E |
| | `open` | `(bundleId) => Promise<void>` | E |
| | `unhide` | `(bundleIds: string[]) => Promise<void>` | E |
| | `resolvePrepareCapture` | `(allowed, host, quality, targetW, targetH, preferredDisplayId?, autoResolve, doHide?) => Promise<…>` | E |
| `tcc` | `checkAccessibility` / `checkScreenRecording` | `() => boolean` | **Synchronous** (E) |
| `hotkey` | `registerEscape` | `(cb) => boolean` | Returns `false` on failure, never throws (E) |
| | `unregister` / `notifyExpectedEscape` | `() => void` | E |
| — | `_drainMainRunLoop` | `() => void` | **Synchronous**, called every 1ms (E) |

### 5.3 Two constraints that are not negotiable

**Main-queue starvation.** Under Bun, `DispatchQueue.main` never drains, so any
API that hops to the main actor hangs forever. Evidenced for exactly four
capture/app calls plus `key`/`keys`; **not** needed for `typeText`, `moveMouse`,
`mouseButton`, `unhide`. `drainRunLoop.ts` already solves this with a refcounted
1ms `setInterval` pumping `_drainMainRunLoop`, 30s ceiling. Our addon must
expose the same drain and the same set of pumped calls, or every screenshot
hangs. **Do not "simplify" this away.**

**Timing behaviour to preserve**, evidenced from the call sites: 50 ms settle
after every mouse move; 8 ms between key repeats and between graphemes; 100 ms
after Cmd+V; animated drag is ease-out-cubic, 60 fps, 2000 px/s, capped at 0.5 s;
JPEG quality 0.75; coordinates are logical dimensions × `scaleFactor`.

**Already ours, do not port:** the clipboard. `executor.ts` implements it
host-side with `pbcopy`/`pbpaste`, read-back verification and a `finally`
restore. It stays in TypeScript.

---

## 6. The tool contract

24 tools. Parameters below are what the renderer and executor signatures
evidence; everything marked *unknown* is ours to define, and the definition must
be written into `tools/schemas.ts` with a model-facing description, since no
original exists to copy.

| Tool | Evidenced params | To decide |
|---|---|---|
| `screenshot` | none | whether display selection is model-facing |
| `zoom` | `region: [x,y,w,h]` | units/origin (logical, per `display.getSize`) |
| `cursor_position` | none | — |
| `mouse_move` | `coordinate: [n,n]` | — |
| `left_click` `right_click` `middle_click` `double_click` `triple_click` | `coordinate: [n,n]` | `modifiers: string[]` — executor takes it, renderer never shows it |
| `left_mouse_down` `left_mouse_up` | none | — |
| `left_click_drag` | `coordinate` (dest), `start_coordinate?` | — |
| `scroll` | `direction`, `amount`, `coordinate` | `direction` enum; mapping onto `scroll(x,y,dx,dy)` |
| `type` | `text: string` | `viaClipboard` is host-decided by the `clipboardPasteMultiline` gate — **not** a model param |
| `key` | `text: string`, `'+'`-separated (xdotool syntax, e.g. `ctrl+shift+a`) | a `repeat` param |
| `hold_key` | `text: string` | duration param name **and unit** — executor is ms, `wait` is seconds. Pick one and be consistent |
| `wait` | `duration: number` (**seconds**) | — |
| `read_clipboard` | none | — |
| `write_clipboard` | `text: string` | — |
| `open_application` | `bundle_id: string` | model is given *display names* via `appNames.ts` but must supply bundle IDs — fix this asymmetry |
| `list_granted_applications` | none | — |
| `request_access` | `apps: [{displayName?}]` | `reason`, `requestedFlags` |
| `computer_batch` | `actions: unknown[]` | element shape entirely undefined |
| `switch_display` | — | takes a display name; `"auto"` unpins |

**One trap to honour:** `setup.ts` derives `allowedTools` from
`CLI_CU_CAPABILITIES` while `mcpServer.ts` derives ListTools from
`adapter.executor.capabilities`. Both must come from one source once we own
`buildComputerUseTools`, or a listed tool has no matching entry.

---

## 7. Permissions — what to change and why

### 7.1 Correcting the record

`allowedTools` is **not** an engine bypass. `main.tsx:1625` pushes the names →
`:1748` passes them as `allowedToolsCli` → `permissionSetup.ts` puts them in
`alwaysAllowRules.cliArg`, consumed by `toolAlwaysAllowedRule` at **step 2b** of
`hasPermissionsToUseToolInner`. Everything before 2b still runs: deny rules,
ask rules, `tool.checkPermissions`, `requiresUserInteraction`, content ask rules,
`safetyCheck`. PreToolUse hooks are untouched. Only step 3's
`passthrough → ask` is skipped. `--disallowedTools 'mcp__computer-use__type'`
works today.

### 7.2 The three real defects

1. **Auto mode is this fork's default** (`isDefaultPermissionModeAuto()`,
   `permissionSetup.ts:1436`) and turns every `ask` into `allow` unless
   `requiresUserInteraction()` or `isLocallyRiskyAction()` — and the latter only
   matches literal `BASH_TOOL_NAME`, `POWERSHELL_TOOL_NAME` or a `safetyCheck`
   reason, none of which an MCP tool can produce. **Desktop control would run
   fully unattended on default settings.**
2. **MCP rules have no argument granularity.** `toolMatchesRule` returns `false`
   for any rule carrying `ruleContent`, and the generic MCP `checkPermissions`
   (`client.ts` ~:1816) returns `passthrough` unconditionally. So
   `mcp__computer-use__type(Terminal)` parses, persists, and **silently never
   matches**. This is a standalone defect — file it separately, it also affects
   MCP servers generally.
3. **The Bash classifier never sees keystrokes.** It lives in
   `BashTool.checkPermissions`; nothing routes MCP arguments to it.

### 7.3 The design to implement

Drop the `allowedTools.push` at `main.tsx:1625`. Supply `checkPermissions`
through the existing override seam — `getComputerUseMCPToolOverrides`
(`wrapper.tsx:248`) is spread at `client.ts:1985-1989` *after* the generic
`checkPermissions` in the same object literal, so it wins without touching the
MCP client.

- **Auto-allow, given a live app grant:** `screenshot`, `zoom`,
  `cursor_position`, `mouse_move`, `scroll`, `wait`, all clicks and drags,
  `left_mouse_down/up`, `hold_key`, `list_granted_applications`,
  `switch_display`. Per-call prompting on `mouse_move` would make the feature
  unusable — the policy is per tool class, never per call.
- **Always prompt, Auto-immune:** `open_application`, `read_clipboard`,
  `write_clipboard`, and `type`/`key` when the frontmost app is shell-class.
  Implement with `requiresUserInteraction()` (`Tool.ts:435`), which returns at
  step 1e *before* the allow rule, **and** emit
  `decisionReason: {type: 'safetyCheck'}` — the only reason string Auto mode
  re-prompts on. This closes defect 1 without touching `localAutoApprove.ts`.
- **`computer_batch` recurses** into its members and takes the strictest verdict
  of any member. Otherwise it is a universal bypass.
- **App-scoping is the real control.** `open_application` may only reach apps
  already in the granted set; shell, filesystem and password-manager bundle IDs
  must never be silently grantable by `request_access`.
- **`getDestructiveCommandWarning` is advisory only.** It is a pure string
  function already used by `localAutoApprove.ts`; run `type` payloads through it
  when the front app is terminal-class. Keystrokes are not a command line —
  never treat it as a boundary.

`request_access` remains compatible: its app-set grant lives in session state and
is orthogonal to per-call decisions.

### 7.4 Consent dialog changes

`src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx`.
Verified correct today: the title *"Computer Use wants to control these apps"*,
*"Allow for this session (N apps)"*, the *"N other apps will be hidden"* warning,
and the bold sentinel warning driven by `getSentinelCategory`.

Four changes required:

1. **Per-app toggling.** `const [checked] = useState(...)` has **no setter** and
   `options` is exactly `['allow_all','deny']`; the circles are static glyphs
   whose empty branch is unreachable for resolved apps. Today a request bundling
   Terminal with Safari is accept-both-or-refuse-both. Add the setter and a
   per-row toggle.
2. **Disclose the screen capture.** No string anywhere in the component says the
   screen is captured and sent to the model. Add it, plainly.
3. **Human-readable flags.** They render as raw keys (`· clipboardRead`).
4. **Remember denials.** `getUserDeniedBundleIds` returns `[]` and the deny path
   sets `denied: []`, so per-app denial reasons are only recorded on the *allow*
   path — the model can immediately re-ask.

### 7.5 The stop key

`escHotkey.ts` registers a `CGEvent` tap on fresh lock acquire, serviced by the
`drainRunLoop` interval; the callback aborts `tuc().abortController`. ESC is
consumed system-wide while registered — a deliberate prompt-injection defence —
and `notifyExpectedEscape()` hole-punches model-synthesised Escapes. Delivery
depends on **our** pump, so an unresponsive foreground app cannot block it.

Two hazards, both must-test and both currently unhandled:

- macOS disables a tap that exceeds its callback timeout, and there is **no
  `kCGEventTapDisabledByTimeout` re-enable path** anywhere in the file. Add one
  in the addon's tap callback.
- Secure-input contexts (password fields, auth sheets) suppress delivery to
  unprivileged taps. Detect and surface it rather than silently losing the stop
  key.

---

## 8. Context hygiene

A screenshot-per-step loop breaks four things that no one had listed. All four
are required, not optional.

1. **Memory extraction re-sends every screenshot.** Extraction is "a perfect fork
   of the main conversation" — `forkedAgent.ts:524` builds
   `[...forkContextMessages, ...promptMessages]` — and
   `services/extractMemories/extractMemories.ts` does not strip images. Same for
   autoDream and any `cacheSafeParams` fork. On a non-vision provider that is
   dozens of image blocks sent to a model that cannot read them. **Strip images
   from `forkContextMessages`.** Cheapest, largest win.
2. **Nothing drops stale screenshots.** `snipCompact.ts` is stubbed
   (`isSnipRuntimeEnabled()` → `false`); time-based microcompact clears only
   `COMPACTABLE_TOOLS` (`microCompact.ts:41` — Read/Bash/Grep/Glob/Web/Edit/Write)
   and only on an idle gap, never on volume. **MCP names are not in that set.**
   Implement keep-last-N: only the most recent screenshot is usually useful.
3. **The disk-offload valve is structurally closed.** `contains_images` skips
   persistence in both `services/mcp/client.ts:2763` and
   `utils/toolResultStorage.ts` (~:301, and excluded from budget candidates at
   ~:553), so images stay resident until compaction deletes them. Transcripts are
   JSONL with inline base64 and no image-path indirection: ~400–670 KB per
   screenshot line, so a 100-step task is **40–70 MB of JSONL** that `/resume`
   parses back into memory. Decide whether screenshots move to storage by
   reference.
4. **The image token estimate is 2.6× low.** `services/tokenEstimation.ts` (~:404)
   charges a flat 2000 (`IMAGE_MAX_TOKEN_SIZE`, same constant at
   `microCompact.ts:38`) where the real cost is `(w*h)/750` ≈ 5333 for 2000×2000.
   The comment calling 2000 "conservative" is wrong. Bounded normally; unbounded
   on any provider that does not report `usage`, where a 50-screenshot session
   reads as 100k instead of 265k.

**Accepted, with eyes open:** `stripImagesFromMessages`
(`services/compact/compact.ts` ~:137) replaces every image with `[image]` before
summarising, so compaction cannot 413 — but the summariser is therefore blind and
a mid-task compact loses which of five dialogs was open. Recoverable by
re-screenshotting. Do not "fix" this by feeding images to the summariser.

**Subagents.** The three `CHICAGO_MCP` turn-loop sites — `query.ts` ~:1155
(abort during streaming), ~:1611 (abort during tool execution),
`query/stopHooks.ts:169` (natural turn end) — all call
`cleanupComputerUseAfterTurn`, guarded on `!toolUseContext.agentId` because the
lock's local-ownership flag in `computerUseLock.ts` is **module-level and
process-wide**. That guard is lock hygiene; `stopHooks.ts` notes "subagents don't
start CU sessions" as an *observation*. **Nothing prevents a subagent from
calling these tools.** Decide the policy explicitly and enforce it in
`checkPermissions`; do not rely on the existing guard to mean something it
doesn't.

---

## 9. Provider gating

### 9.1 Which providers can actually do this

Screenshot-driven control means every step sends an image. Probed against live
APIs and adapter source, 2026-09-05:

| Provider | Result |
|---|---|
| Anthropic | **Works** |
| Codex | **Works, including tool-result images.** `imageBlockToUrl()` renders base64 → data URL, and `translateMessages` re-emits `tool_result` images as a follow-up `role: 'user'` turn because `function_call_output.output` is a plain string. The comment records this was fixed because it "left the model blind to every screenshot a tool returned" — literally our path |
| Grok | **Works** |
| DeepSeek | **Broken, unfixably.** A user `image` block becomes the literal text `[Unsupported image attachment omitted from this request.]`; images inside `tool_result` are filtered out with no placeholder at all. Patching the adapter would not help — probing the API directly with an OpenAI `image_url` part returns 200, but a 64×64 and a 512×512 PNG both yield `prompt_tokens: 89`. Accepted and discarded |
| Ollama | **Per-model, fails loudly.** Live daemon 0.32.13 + `qwen3:8b`: HTTP 400, *"Multimodal data provided, but model does not support images"*. Controls: no image → 200/15 tokens, text instead → 200/16 |
| Kimi | **Unknown.** Anthropic-shaped passthrough, so blocks arrive verbatim, but the account 429s on balance before validation. Test: one image block with `max_tokens: 16`, compare `usage.input_tokens` against the same request without it |

### 9.2 Where the capability field goes

**A required field on `ProviderDescriptor` (`src/config/providers/types.ts`).**
Not on `ProviderModelCatalog`: `catalog` is optional and **two** providers omit
it — `ollama.ts` and `anthropic.ts` — so `if (catalog && !catalog.x)` passes by
omission for both the least *and* the most capable provider. That is the
`supportsToolSearch` trap in `docs/TODO.md:333-337`, doubled. Required on the
descriptor makes a new provider a compile error, which is the stated purpose of
`PROVIDERS` being an exhaustive `Record`. **No "is Anthropic" predicate.**

Then replace `hasRequiredSubscription()` in `gates.ts:39-43` — currently
`getSubscriptionType() === 'max' | 'pro'`, unpassable on any third-party account
— with a lookup on the active provider. Keep the platform and interactive checks.
Drop the GrowthBook `tengu_malort_pedway` dependency, or default it to
`enabled: true`: it is an Anthropic rollout channel this fork does not receive.

### 9.3 The system-prompt hint

`setup.ts:16-21` records that Anthropic's API backend detects the
`mcp__computer-use__*` names and injects a computer-use hint **server-side**. No
other provider does that, so on Codex or Grok the tools would be present and
unexplained. The naming has no other in-tree meaning — outside `computerUse/` it
appears only in the reserved-name rejection (`main.tsx:1480`), telemetry and MCP
config — so keep the names and supply the hint ourselves.

Exact precedent to mirror: `main.tsx:1571` appends `CLAUDE_IN_CHROME_SKILL_HINT`
(from `utils/claudeInChrome/prompt.ts`) to `appendSystemPrompt` at the same point
it merges the Chrome MCP config. Put our text in
`utils/computerUse/prompt.ts` and append it in the `setupComputerUseMCP()`
success branch — that site already knows the tools were installed and only runs
when the feature is live. Gate the append on the provider not being Anthropic,
or accept the duplication; a second consistent hint is far less harmful than a
missing one.

---

## 10. Build and packaging

### 10.1 The problem, established rather than assumed

`bun build --compile` does not embed `.node` addons here. Evidence: `sharp` is a
real dependency and is **not** in the externals list, yet the only `sharp.node`
strings in `cli-dev` are sharp's own JS loader paths, and there are **no
`/$bunfs/root/*.node` entries in the binary at all**. That is precisely why
`tools/FileReadTool/imageProcessor.ts:42` tries `image-processor-napi` first
under `isInBundledMode()` and falls back to `sharp` — and `image-processor-napi`
is one of four `*-napi` packages marked external at `scripts/build.ts:215-221`
that are **all absent** from `package.json` and `node_modules`.

So there is no working native-addon precedent in this repo, and the loaders we
inherited expect a `build-with-plugins.ts` that **does not exist here** to bake
`COMPUTER_USE_INPUT_NODE_PATH` / `COMPUTER_USE_SWIFT_NODE_PATH`. Building that
pipeline is part of this feature, not a prerequisite someone else supplies.

### 10.2 What to build

1. **`scripts/build-native.ts`** — `cargo build --release` per target triple
   (`aarch64-apple-darwin`, `x86_64-apple-darwin`), copying the `.dylib` to
   `native/computer-use/prebuilds/<platform>-<arch>/computer-use.node`. Committed
   to the repo so a normal clone builds without a Rust toolchain; regenerated
   only when the crate changes.
2. **Embed and extract, do not bake a path.** `scripts/build.ts` embeds the
   prebuild as an asset; on first use `scripts/install-native.ts` extracts it to
   `~/.axa/native/<version>/computer-use.node` and `nativeLoader.ts` `require`s
   that path. Version the directory so an upgrade cannot load a stale addon.
   A baked absolute path breaks the moment the binary is moved or installed
   elsewhere, which is the normal case.
3. **`nativeLoader.ts`** replaces both old loaders: one lazy CJS `require`,
   cached at module level, throwing a single actionable error if the addon is
   missing. Keep it lazy — see 10.3.
4. **Add `CHICAGO_MCP` to `fullExperimentalFeatures`** (`scripts/build.ts:35+`)
   once the binary boots with it. Note `:196-200` only *warns* on unknown flags,
   so `--feature=CHICAGO_MCP` already takes effect today; the warning loop is a
   spell-checker, not a gate, and the comment there says so explicitly.

### 10.3 Why laziness is load-bearing

Measured against Bun's DCE: a **static** import of an external package survives
elimination even when its only consumer is `if (false)` — Bun demotes it to a
bare side-effect import in both outputs — whereas a **dynamic** `import()` inside
a false `feature()` gate is removed entirely. Confirmed on the artifact:
`grep -a -c '@ant/computer-use-mcp' cli-dev` → 0, control `CLAUDE_CONFIG_DIR` →
12. Under `--compile`, an unresolvable external is fatal before user code runs.

Every current gate site is already dynamic (`entrypoints/cli.tsx:96`,
`main.tsx:1477-1482`, `main.tsx:1608-1620`, lazy `require` at
`client.ts:242-243`). **Preserve that.** A single static import of the native
addon would make the binary unlaunchable on any machine where extraction failed.

### 10.4 Code signing and TCC — a development blocker

`codesign -dv ./cli-dev` → `Identifier=a.out`, `Signature=adhoc`,
`linker-signed`, `TeamIdentifier=not set`. There are **zero**
`codesign`/`notarytool`/`entitlements` references in `scripts/`, `install.sh` or
`package.json`. TCC keys ad-hoc binaries by cdhash, so **every
`build:dev:full` plausibly voids the Screen Recording and Accessibility grants**
— which makes iterating on this feature painful in a way that has nothing to do
with the code.

Required work: a stable signing identity for `cli-dev` (a self-signed cert with a
fixed identifier is enough for TCC persistence locally), applied in
`scripts/build.ts` after compile, plus the two usage-description keys. This must
be settled early — it is measured in hours and it gates every manual test of
everything else.

---

## 11. Files to change

| File | Change |
|---|---|
| `src/utils/computerUse/setup.ts` | Drop `@ant/computer-use-mcp` import; build tools from `tools/schemas.ts`; single source for the tool list shared with `mcpServer.ts`; stop pushing `allowedTools` |
| `src/utils/computerUse/mcpServer.ts` | Own `createComputerUseMcpServer` on `@modelcontextprotocol/sdk`; keep the `installedAppNames` injection into `request_access` and the `isDisabled()` → `{tools: []}` behaviour |
| `src/utils/computerUse/wrapper.tsx` | Replace `bindSessionContext` with `tools/dispatch.ts`; add `checkPermissions` to `getComputerUseMCPToolOverrides`; keep `runPermissionDialog` and the `defersLockAcquire` contract |
| `src/utils/computerUse/executor.ts` | Retarget imports to `nativeLoader.ts` and `tools/types.ts`; keep the clipboard, hiding and coordinate logic verbatim |
| `src/utils/computerUse/gates.ts` | Replace `hasRequiredSubscription()` with the provider-descriptor lookup; drop or invert the GrowthBook default; keep the frozen `coordinateMode` |
| `src/utils/computerUse/hostAdapter.ts` | Point at the new native module; keep the adapter contract |
| `src/utils/computerUse/escHotkey.ts` | Add `kCGEventTapDisabledByTimeout` re-enable; surface secure-input suppression |
| `src/utils/computerUse/toolRendering.tsx` | Add `switch_display`; keep the `default` but log unknown names in dev so the surface can't silently drift again |
| `src/utils/computerUse/inputLoader.ts`, `swiftLoader.ts` | **Delete** — replaced by `nativeLoader.ts` |
| `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx` | Per-app toggle, capture disclosure, readable flags, remembered denials (§7.4) |
| `src/main.tsx` | Remove the `allowedTools.push` (~:1625); append the prompt hint in the `setupComputerUseMCP()` branch; keep the reserved-name rejection and the platform/interactive gate |
| `src/config/providers/types.ts` + all six provider files | Required `canDriveComputer` field on `ProviderDescriptor` |
| `src/services/extractMemories/extractMemories.ts` (or `forkedAgent.ts:524`) | Strip image blocks from the forked context |
| `src/services/compact/microCompact.ts` | Keep-last-N screenshots; MCP tool names in the compactable set |
| `src/services/tokenEstimation.ts` | Fix the 2000 → `(w*h)/750` image estimate and the wrong "conservative" comment |
| `scripts/build.ts` | Native embed step; `CHICAGO_MCP` in `fullExperimentalFeatures`; codesign step |
| `FEATURES.md` | Correct the `CHICAGO_MCP` entries — the boot failure is at first gate pass, not at import time |

---

## 12. Implementation order

Each phase ends in something verifiable. Phases 1–3 need no Rust, which is why
they come first — they de-risk the contract before the expensive part.

1. **Signing and TCC.** Stable identity for `cli-dev`; confirm a granted Screen
   Recording permission survives a rebuild. Hours, and it gates manual testing of
   everything after it.
2. **Tool contract, no native code.** `tools/schemas.ts`, `tools/types.ts`, our
   own `createComputerUseMcpServer`, and a `.call()` returning a structured
   error. Validates name shaping, ListTools, the reserved-name rejection,
   rendering and image-block mapping. **Requires a stub adapter, not the real
   one** — `getComputerUseHostAdapter()` calls `createCliExecutor()`, which loads
   both native modules and throws with no degraded mode; `mcpServer.ts`'s app
   enumeration goes through `executor.listInstalledApps()`; and `wrapper.tsx`'s
   `.call()` reaches `escHotkey.ts` via `acquireCuLock`.
3. **Permission policy and consent dialog.** §7. Testable against the stub, in
   Auto mode specifically, since that is the default.
4. **Native addon — capture and display.** `screenshot`, `zoom`,
   `display.getSize`, TCC checks, and the run-loop pump. First build where the
   model can see. The pump is the risk; prove it before building on it.
5. **Native addon — input.** enigo mouse and keyboard, with the evidenced timing.
   First build where the model can act.
6. **Native addon — apps.** NSWorkspace enumeration, launch, hide/unhide,
   `prepareDisplay`, `previewHideSet`. Completes `request_access` and the hiding
   behaviour the consent dialog already promises.
7. **Context hygiene.** §8 — all four items.
8. **Provider gating and prompt hint.** §9.
9. **Packaging.** Prebuilds, embed/extract, `fullExperimentalFeatures`,
   `FEATURES.md` correction.

---

## 13. Verification

No test suite exists. The standing gate applies: a `tsc --noEmit` **sorted-set**
diff against a baseline regenerated **in the same worktree** (the absolute number
does not travel between checkouts — only the delta), a clean
`bun run build:dev:full`, and a manual smoke on two providers via
`/switch-account`.

That gate cannot see this feature's most likely defect. Tool descriptions and the
system-prompt hint are template text, invisible to `tsc`, and a branch shipped a
broken model-facing prompt on 2026-09-04 with a perfect baseline. **Every
description and hint must be rendered and asserted, not inferred from a clean
compile.**

Feature-specific:

- **TCC matrix** — grants survive a rebuild; missing-grant path reports which one
  is missing; the ESC tap degrades to "press Ctrl+C" rather than failing hard.
- **Permission matrix in Auto mode** — auto-allow class runs unprompted;
  always-prompt class prompts; `computer_batch` inherits the strictest verdict.
- **Provider matrix** — a screenshot reaches the model on Codex and Grok; the
  feature is unavailable and says so on DeepSeek and on a text-only Ollama model.
- **Long-session context** — images are not re-sent to memory extraction; stale
  screenshots are dropped; transcript growth is bounded.
- **Lock** — two concurrent axa sessions cannot both drive the mouse; a stale
  lock from a killed process recovers.

---

## 14. Open questions to settle during implementation

1. `hold_key` duration: seconds (consistent with `wait`) or milliseconds
   (consistent with the executor)? Pick one; the inconsistency is inherited.
2. `computer_batch` element schema — entirely undefined, and it is the tool with
   the widest permission blast radius.
3. `open_application` takes bundle IDs while the model is shown display names.
   Accept names and resolve, or expose bundle IDs in `request_access`?
4. Do screenshots stay inline base64 in transcripts, or move to storage by
   reference? (§8.3 — 40–70 MB per long session.)
5. May subagents drive the desktop? Today's guard is lock hygiene; no policy
   exists either way.

---

## 15. Corrections to earlier drafts

Recorded rather than silently fixed, because each was checkable and wrong.

- **"23 tools"** — 24, and `toolRendering.tsx` is a *lower bound* because its
  switch has a `default`. `switch_display` is absent from it.
- **"a checkbox per resolved app"** — there is no per-app toggle; the `useState`
  has no setter and the grant is all-or-nothing.
- **"bypasses the permission engine entirely"** — it is a max-priority allow rule
  at step 2b; deny rules, ask rules, `checkPermissions`,
  `requiresUserInteraction`, `safetyCheck` and PreToolUse hooks all still run.
- **"the binary doesn't boot because of an import-time crash"** — the imports are
  dynamic and eliminated; the crash is at first gate pass (`main.tsx:1608`).
- **A retraction that was itself wrong:** `FEATURES.md:26-28` does say
  `build:dev:full` ships minus `CHICAGO_MCP` because the binary "does not boot
  cleanly with it". `:187-190` is a second consistent description, not a
  contradiction.
- **"sharp proves Bun can embed native addons"** — it does not. The binary
  contains sharp's JS loader strings and no `/$bunfs/root/*.node` entries at all.

## 16. Facts verified at source (2026-09-05)

- No GUI or browser tool is active in `getAllBaseTools()` (`src/tools.ts`).
- `WEB_BROWSER_TOOL` and `TERMINAL_PANEL` are registered behind flags but their
  implementations are absent (`FEATURES.md:280-286`). Neither is a route here.
- No Anthropic server-side computer-use tool type (`computer_20241022`,
  `computer_20250124`, `bash_20250124`, `text_editor_*`) appears anywhere; every
  tool goes out client-side, which is what makes this portable at all.
- `@ant/computer-use-{mcp,input,swift}` and all four `*-napi` externals: absent
  from `package.json` and `node_modules`.
- `@modelcontextprotocol/sdk@^1.29.0` and `sharp@^0.34.5` are present.
- `CHICAGO_MCP` is absent from `fullExperimentalFeatures` (`scripts/build.ts:35`);
  `defaultFeatures` is `['VOICE_MODE']`; unknown flags only warn.
- `computer-use` is a reserved MCP server name, rejected at `main.tsx:1480-1483`.
- MCP image content is already converted to `type: 'image'` base64 and resized
  (`services/mcp/client.ts`, `utils/imageResizer.ts`); the clipboard path is
  already host-side `pbcopy`/`pbpaste` in `executor.ts`.
- `codesign -dv ./cli-dev` → `Identifier=a.out`, adhoc, linker-signed, no team ID.
