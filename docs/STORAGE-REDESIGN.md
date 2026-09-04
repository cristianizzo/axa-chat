# Storage: `~/.axa`, visible projects, permanent backups

**Design agreed 2026-08-28.** Supersedes the 2026-08-27 draft, which proposed a
workspace/project split, a hierarchical re-layout and gzipped backups. All three
were dropped — see *Rejected* at the end.

---

## The decision, in one line

**A project is the folder you start `axa` in.** That is what the code already
does, it is correct, and it does not change. Everything in this document is
about making that visible and manageable.

---

## What is actually wrong today

Measured on this machine, 2026-08-28: 34 project directories, ~1,557
conversations, 1.5 GB.

### 1. There is no way to see or manage any of it

No list, no sizes, no rename, no delete, no merge. The user's words: *"nothing I
can see, nothing I can manage, I don't even know what is stored and where."*
This is the whole problem. The rest are consequences.

### 2. The folder name is a lossy encoding of the path

`sanitizePath` (`sessionStoragePortable.ts:311`) replaces every non-alphanumeric
character with `-`, so `-Users-cristianizzo-Developers-axa-chat` cannot be
decoded back into a path: a real `-` and a `/` are now the same character.

The path is not lost, though — **every JSONL line carries `cwd` verbatim**:

```
cwd       = /Users/cristianizzo/Developers/risikai
sessionId = ad3e7466-e02c-42b1-bdde-f2193f843ea4
```

So the true path is read from inside the transcript, never from un-sanitizing a
directory name. That is what makes a project list possible with no new files.

### 3. Backups are deleted

`compact.ts:388`, `MAX_BACKUP_SETS = 3`. This session compacted 27 times; 24 of
those backups are gone. Backups are the only record of pre-compaction content.

### 4. Real data is stranded and invisible

`-Users-…-risikai/ad3e7466-…/subagents/` holds **14 subagent transcripts,
115 MB** — 7.5% of total storage — and the parent transcript has been deleted.
The origin path (`~/Developers/risikai`) still exists on disk. Nothing surfaces
this; nothing can reclaim it.

### 5. The same repo splits across directories

| Directory | Convs | Size |
|---|---|---|
| `-…-searcher` | 1 | 89 MB |
| `-…-searcher-packages-playground` | 4 | 64 MB |
| `-…-cryptocrash-liquidlpProtocol` | 1 | 243 MB |
| `-…-liquidlpProtocol-packages-contracts` | 0 | 0.8 MB |

Starting `axa` one directory deeper produces a second, unrelated history.
**Not fixed by heuristics** — no git-root inference, no prefix matching. The
manager gets an explicit *merge* action and the user decides.

Prefix matching is specifically unsafe here: `/Users/cristianizzo` is itself a
project with 30 conversations and is not a git repo, so prefix rules would make
`$HOME` swallow every non-repo directory beneath it.

### 6. pmbot: 1,504 conversations, and it is not a bug

Seven `/private/var/folders/…/T/pmbot-axa-*` directories hold 1,504 of the 1,557
conversations — 97%. They are not junk. They are the user's polymarket bot,
one conversation per candle:

```
Precomputed perception for this candle:
{"ts":…,"symbol":"BTCUSDT","regime":"trend","swing_hi":71670.0,…}
```

Source: `~/Developers/polymarket-bot/pmbot/agent/axa.py:47`

```python
self.cwd = cwd or tempfile.mkdtemp(prefix="pmbot-axa-")
```

with a deliberate rationale above it: a private 0700 empty dir stops a project
`CLAUDE.md` leaking into the bot's context, and stops another user planting a
config in a world-writable directory.

So the temp cwd is **correct and must stay**. Telling the bot to run from a
fixed folder would reintroduce exactly the attack that comment prevents, and
skipping temp dirs in `axa` would silently discard 1,504 real conversations.

The fix is to let the caller name the project: `--project pmbot`. The bot keeps
its isolated cwd for execution and pins where the transcript is stored.

---

## What changes

### Structure: nothing

```
~/.axa/projects/-Users-cristianizzo-Developers-axa-chat/
    a5511542-….jsonl        transcript
    a5511542-…/backups/     compaction backups, plain JSONL
    a5511542-…/subagents/
```

Identical to today. Sanitized folder names stay. Transcripts stay where they
are. Nothing moves, no new format, no index.

### `~/.axa` is a fresh install, not a copy

`getClaudeConfigHomeDir()` (`envUtils.ts:7`) returns `~/.axa`. On first run the
directory is created **empty**, exactly as a first-time install would.

`~/.claude` is never read and never written. Not moved, not deleted, not
touched. Existing data arrives only through an explicit import.

### `/import-conversations`

In settings. Pick a source — for now only *Claude Code* — confirm, and it copies
from `~/.claude` into `~/.axa`. Re-runnable at any time, so someone who keeps
using Claude Code can pull in new conversations later.

- Copies conversations, `settings.json`, and credentials.
- Idempotent: skips a conversation already present; re-copies it if the source
  has grown (size/mtime), picking up messages appended since the last import.
- Copy only. `~/.claude` is left byte-for-byte intact.
- On APFS, `cp -c` clones — near-instant and ~0 extra disk for 1.5 GB.

### Credentials need their own keychain entry

`macOsKeychainHelpers.ts:29` builds the service name as
`Claude Code${OAUTH_FILE_SUFFIX}${suffix}${dirHash}`, and `dirHash` is empty
unless `CLAUDE_CONFIG_DIR` is set. Changing only the config dir would therefore
leave `axa` reading **Claude Code's own keychain entry**: login would work for
free, but the two installs would share one credential, and a refresh-token
rotation by one can log the other out.

So `axa` gets its own service name, and the import copies the credential across
once. Independent installs, no shared mutable state.

### Backups: keep everything, uncompressed

`MAX_BACKUP_SETS = 3` → `1000`. Retention logic and 5 MB chunking are untouched;
only the ceiling moves.

Not gzipped, deliberately: compressed backups cannot be grepped, and searching
old conversations is the reason to keep them at all. Cost is ~46 MB for a heavy
session, which is accepted.

### `/projects`

The deliverable. For every project:

- name, **real path** (from `cwd` in the transcript), conversation count, size
  on disk, last used
- flags: *path no longer exists*, *transcript missing but subagent/backup data
  present* (risikai)

Actions: open, rename, favourite, delete, **merge**. Merge relocates `*.jsonl`
and sidecar directories into the target and removes the empty source — same
filesystem, so it is a rename: a measured 200 MB move takes 7 ms.

### `project.json`, written lazily

Path, count and size are all derivable, so a project that is never customised
gets **no new file**. `project.json` is created only on the first rename,
favourite or merge, and holds only what cannot be derived:

```json
{ "name": "pmbot", "favourite": true, "mergedPaths": ["/private/var/…"] }
```

### `--project <name>`

Overrides cwd-derived storage for a single run. Built for pmbot; also useful for
any wrapper that runs `axa` from a scratch directory.

---

## Phases

**PR 1 — new root + import.** Must ship together: `~/.axa` alone would leave the
user logged out with no history.
- `getClaudeConfigHomeDir()` → `~/.axa`; sweep the hardcoded `.claude` literals
  behind a grep gate
- own keychain service name
- `/import-conversations`: Claude Code source, conversations + settings +
  credentials, idempotent, re-runnable, non-destructive
- `MAX_BACKUP_SETS = 1000`

**PR 2 — visibility and management.**
- `/projects`: list with real path, count, size, last used, orphan flags
- open, rename, favourite, delete, merge
- lazy `project.json`
- `--project <name>`

---

## Rejected

- **A separate "workspace" layer above projects.** Path *is* the identity;
  a second concept added nothing.
- **Linking one conversation into several projects.** Deferred — one home per
  conversation for now.
- **Git-root or prefix-based project inference.** `$HOME` is a non-repo project
  with 30 conversations; prefix rules would swallow everything under it. Splits
  are fixed by explicit merge instead.
- **Skipping temp directories.** Would discard pmbot's 1,504 real conversations.
  Solved with `--project`.
- **Gzipped backups.** Breaks grep over old conversations.
- **Copying `~/.claude` in automatically on first run.** Replaced by explicit,
  re-runnable `/import-conversations`.
- **Re-layout into `data/`, `index.json`, per-conversation `meta.json`.**
  Structure stays as-is; titles already live in the transcript as `custom-title`
  entries (`sessionStorage.ts:2617`), so no new metadata files are needed.
