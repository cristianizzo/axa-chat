---
name: Verify command strings against the Commander registration, not the binary name
description: Claims have multiple axes — a command string can name the right binary and a nonexistent subcommand; a docstring can have the right path and the wrong scope. Fixing one axis makes the unchecked ones look credible.
type: feedback
---

When correcting strings that tell a user what to type, check **two independent
axes**: the binary name (`axa`, via `BINARY_NAME`) *and* the subcommand path.
A string can be right on the first and false on the second.

Worked example: `marketplaceManager.ts` printed
`${BINARY_NAME} marketplace remove <name>`. It interpolated `BINARY_NAME`
correctly, so it passed every grep for `claude`. But `marketplace` is registered
as `pluginCmd.command('marketplace')` nested under `program.command('plugin')`,
so the real path is `axa plugin marketplace remove`. The advertised command did
not exist.

**Why:** no search on the wrong binary name can surface this class — the string
is already "correct" by that test. It is only visible by reading the Commander
registrations (in `main.tsx`) and confirming the nesting. Two reviewers and two
greps missed it; the registration comparison found it immediately.

**How to apply:** whenever you touch a string a user is told to type, resolve the
subcommand against its `.command(...)` registration and confirm the parent chain.
Also grep the file for `BINARY_NAME` first: files that already import and use it
in one place while hardcoding `claude` in another are common, and a file that
contradicts *itself* in adjacent error messages is worse than one that is
uniformly wrong.

**Corollary — opening an axis obliges closing it.** Fixing only the sites an
auditor names reproduces their finding one subsystem over: the tree then tells a
user `axa plugin disable` from one code path and `claude plugin disable` from
another for the same operation. Sweep the whole axis in one branch.

**Related, same review:** when routing a defect you refuse on partition grounds
to another branch's owner, route *every* instance in that file. Handing over one
line and not its neighbour makes the neighbour survive precisely because the file
looks "already handled".

## The general form: a partial fix launders the rest of the sentence

Same failure, different axis. `settings/types.ts` documented "user settings files
(`.claude/settings.json`)". Correcting the *path* to `.axa/settings.json` left the
*scope* claim false — `.axa/settings.json` is the **projectSettings** location
(`settings.ts`, `getRelativeSettingsFilePathForSource`); user scope is
`~/.axa/settings.json`, and the schema governs all five sources, not one.

**Why this is worse than not fixing it:** an obviously-stale path invites doubt
about the whole sentence. A freshly-correct path makes the wrong half *credible*.
Fixing one axis of a claim raises the trust on the axes you did not check.

**How to apply:** when correcting part of a factual claim, re-read the **whole**
claim and verify every assertion in it, not the substring you came for. Cheap
tell used here: the docblock header two lines above already said "Unified schema
for settings files", so the file contradicted itself — and both the author and
the auditor missed it while looking at the path. Prefer pointing at the
authoritative accessor (`getSettingsFilePathForSource()`) over restating facts a
reader must re-verify.
