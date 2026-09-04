---
name: axa-build
description: Build and smoke-verify axa-chat after a code change. Use whenever you have edited source and need to confirm it compiles and the binary still starts, before committing or opening a PR.
---

Build the fork and verify the result actually runs.

## Build

Normal dev build — all feature gates on, produces `./cli-dev`:

```
bun run build:dev:full
```

Other targets, for reference: `bun run build` → `./cli` (production),
`bun run build:dev` → dev without the full feature set, `bun run compile` →
standalone executable, `bun run dev` → run from source without building.

`bun` is at `/opt/homebrew/bin/bun` if it is not on `PATH`.

## Smoke-verify

A build that compiles but won't start is not a passing build. At minimum:

```
./cli-dev --version
```

Then exercise the path you actually changed. Prefer the narrowest check that would
have caught your bug — a targeted run beats a broad one that proves nothing.

If your change touches provider or network code, do not point it at a real account
just to see it work. Use a local fake; note that the fake must speak **SSE**, since
the streaming path is what most provider code actually exercises.

## Rules

- Never write the user's real global config from a build or test script. Set the
  config-dir environment variable to a temp path first. Writing the live config
  hijacks the running session and forces a re-login.
- Do not skip hooks or bypass checks to make a build pass. If a hook fails,
  fix the cause.
- Report honestly. "Builds, but I could not verify behaviour X" is useful;
  claiming verification you did not do is not.
