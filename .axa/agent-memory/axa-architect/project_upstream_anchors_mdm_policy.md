---
name: The managed/MDM policy surface still reads Claude Code's locations on every platform
description: getManagedFilePath and mdm/constants point at ClaudeCode dirs, the com.anthropic.claudecode plist and HKLM\SOFTWARE\Policies\ClaudeCode; the only override is dead because build.ts defines USER_TYPE to 'external'
type: project
---

Second confirmed instance of the **upstream-anchor** class — the first is the
native updater (`project_native_updater_points_at_upstream.md`). The class:
*the fork localised its **destination** (`BINARY_NAME`, `CONFIG_DIR_NAME`,
`PRODUCT_NAME`) and left an **authority or origin** pointing at the product it
forked from.* The updater **downloads from** upstream; this one **takes orders
from** upstream. Expect more; look for any constant naming Anthropic or
ClaudeCode that is not derived from `BINARY_NAME`.

**Verified against `origin/main` source.**

- `utils/settings/managedPath.ts` → `getManagedFilePath()` returns
  `/Library/Application Support/ClaudeCode` (macOS),
  `C:\Program Files\ClaudeCode` (Windows), else `/etc/claude-code`.
  `getManagedSettingsFilePath()` joins `managed-settings.json` onto it.
- `utils/settings/mdm/constants.ts` → `MACOS_PREFERENCE_DOMAIN =
  'com.anthropic.claudecode'`, read as
  `/Library/Managed Preferences/[$user/]<domain>.plist`; plus
  `HKLM\SOFTWARE\Policies\ClaudeCode` and the HKCU sibling.
- **Contrast that makes it a defect rather than a style choice:**
  `getBaseDirectories()` in `nativeInstaller/installer.ts` *is* built from
  `BINARY_NAME`. The same tree derives one and hardcodes the other.
- **No escape hatch.** The only override in `getManagedFilePath()` is gated on
  `process.env.USER_TYPE === 'ant'`, and `scripts/build.ts:176` defines
  `'process.env.USER_TYPE': JSON.stringify('external')` — the same `define`
  mechanism that kills `MACRO.NATIVE_PACKAGE_URL`. The branch folds to false in
  any built binary.

**Why it bites.** `policySettings` is the top-precedence, read-only, admin
source, and it carries `allowManagedPermissionRulesOnly`
(`permissions/permissionsLoader.ts`) and `strictPluginOnlyCustomization`
(`settings/pluginOnlyPolicy.ts`). So a configuration profile authored for Claude
Code silently governs `axa`'s permission rules. The sharper half is the converse:
**an admin has nowhere to put a policy that applies to `axa` and not to Claude
Code**, and a Claude Code allow/deny list has no vocabulary for this fork's
providers.

**How to apply:** it is a deployment decision (localise the paths, or inherit
deliberately and document it), belongs to the lead with `axa-platform`, and must
not ride inside a feature branch — least of all the product-name rename, where it
would look like a string change. Note also that `mdm/constants.ts` carries a
correct and load-bearing WOW64 comment about why the key must stay under
`SOFTWARE\Policies`; relocating the key is not a find-and-replace.
