---
name: GrowthBook & feature flags are structurally dead in this fork's external build
description: How to reason about feature flags and GrowthBook gates when auditing axa-platform behavior
type: project
---

The external (shipped) build bakes `USER_TYPE='external'` (scripts/build.ts:176; many source sites also inline the literal `"external"`). Consequences to remember when auditing:

- **GrowthBook is fully dead**: firstPartyEventLogger.ts is a stub whose `is1PEventLoggingEnabled()` returns false, so `isGrowthBookEnabled()` (services/analytics/growthbook.ts:422) is false → every `getFeatureValue_CACHED_MAY_BE_STALE` / `checkStatsigFeatureGate_*` / blocking variant returns its default, never hitting disk or network.
- **All GB override/force paths are ant-only**: env `CLAUDE_INTERNAL_FC_OVERRIDES` (growthbook.ts:173), config overrides + `/config` Gates (211-220, 245-271). An external user/dev cannot flip any GB gate. Any default-false GB gate is permanently off.
- **Compile-time flags**: a runtime `feature('X')` (bun:bundle) is TRUE only if X is passed in build.ts. The dev-full list (build.ts:35-72) + defaultFeatures ['VOICE_MODE'] is all that can ever be on in cli-dev/install. ~52 distinct referenced flags are never declared (KAIROS, TRANSCRIPT_CLASSIFIER, COORDINATOR_MODE, HISTORY_SNIP, BG_SESSIONS, DAEMON, TEMPLATES, WORKFLOW_SCRIPTS, PROACTIVE, …). Off-by-default = DCE'd, safe; but those CLI subcommands/fast paths are not even registered.

**How to apply**: when told "feature X / tengu gate Y should work", assume it cannot in this build unless the compile-time flag is declared AND there is no GB default-false gate. Verify against source before claiming a flag is reachable.
