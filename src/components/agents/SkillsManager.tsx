import { stat, unlink } from 'fs/promises'
import capitalize from 'lodash-es/capitalize.js'
import { basename, isAbsolute, join, sep } from 'path'
import { useMemo, useState } from 'react'
import figures from 'figures'
import {
  type Command,
  type CommandBase,
  type PromptCommand,
  getCommandName,
} from '../../commands.js'
import { CONFIG_DIR_NAME } from '../../constants/product.js'
import { Box, Text, useInput } from '../../ink.js'
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../skills/loadSkillsDir.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode, toError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import { formatRelativeTimeAgo, formatTokens } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { getProjectConfigDirs } from '../../utils/markdownConfigLoader.js'
import {
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'

// Skills are always PromptCommands with CommandBase properties.
type SkillCommand = CommandBase & PromptCommand
type SkillSource = SettingSource | 'plugin' | 'mcp'

type Props = {
  commands: Command[]
  onBack: () => void
  changes?: string[]
}

type ViewState =
  | { mode: 'list' }
  | { mode: 'detail'; skill: SkillCommand }
  | { mode: 'delete-confirm'; skill: SkillCommand }

// Same display order as SkillsMenu.
const SOURCE_ORDER: SkillSource[] = [
  'projectSettings',
  'userSettings',
  'policySettings',
  'plugin',
  'mcp',
]

function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills'
  }
  if (source === 'mcp') {
    return 'MCP skills'
  }
  return `${capitalize(getSettingSourceName(source))} skills`
}

function getSourceSubtitle(
  source: SkillSource,
  skills: SkillCommand[],
): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [
      ...new Set(
        skills
          .map(s => {
            const idx = s.name.indexOf(':')
            return idx > 0 ? s.name.slice(0, idx) : null
          })
          .filter((n): n is string => n != null),
      ),
    ]
    return servers.length > 0 ? servers.join(', ') : undefined
  }
  const sourceKey = source as SettingSource | 'plugin'
  const skillsPath = getDisplayPath(getSkillsPath(sourceKey, 'skills'))
  const hasCommandsSkills = skills.some(
    s => s.loadedFrom === 'commands_DEPRECATED',
  )
  return hasCommandsSkills
    ? `${skillsPath}, ${getDisplayPath(getSkillsPath(sourceKey, 'commands'))}`
    : skillsPath
}

function isSkillCommand(cmd: Command): cmd is SkillCommand {
  return (
    cmd.type === 'prompt' &&
    (cmd.loadedFrom === 'skills' ||
      cmd.loadedFrom === 'commands_DEPRECATED' ||
      cmd.loadedFrom === 'plugin' ||
      cmd.loadedFrom === 'mcp')
  )
}

function isFileBacked(skill: SkillCommand): boolean {
  return (
    skill.loadedFrom === 'skills' || skill.loadedFrom === 'commands_DEPRECATED'
  )
}

/** Directory the loader reads this skill's source from. */
function getSourceDir(skill: SkillCommand, subdir: 'skills' | 'commands'): string {
  switch (skill.source) {
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'plugin':
      return getSkillsPath(skill.source, subdir)
    default:
      return ''
  }
}

/**
 * Candidate file paths for a file-backed skill, in priority order.
 *
 * `PromptCommand` does not expose the markdown file it came from, only
 * `skillRoot` (set for the `SKILL.md` directory layout). A legacy
 * `commands/` entry stored as a single `<name>.md` has no `skillRoot`, so its
 * path is rebuilt from the command name (namespace segments joined with the
 * platform separator) inside the directories the loader reads.
 */
function getSkillFileCandidates(skill: SkillCommand): string[] {
  if (skill.skillRoot) {
    // The loader accepts SKILL.md in any casing (`isSkillFile` is
    // case-insensitive), so try both spellings before giving up.
    return [
      join(skill.skillRoot, 'SKILL.md'),
      join(skill.skillRoot, 'skill.md'),
    ]
  }
  if (skill.loadedFrom !== 'commands_DEPRECATED') {
    return []
  }
  if (skill.name.includes('..') || skill.name.startsWith(sep)) {
    return []
  }
  const relative = `${skill.name.split(':').join(sep)}.md`
  const dirs: string[] = []
  switch (skill.source) {
    case 'userSettings':
      dirs.push(join(getClaudeConfigHomeDir(), 'commands'))
      break
    case 'policySettings':
      dirs.push(getSkillsPath('policySettings', 'commands'))
      break
    case 'projectSettings':
    case 'localSettings':
      dirs.push(...getProjectConfigDirs('commands', getCwd()))
      dirs.push(join(getCwd(), CONFIG_DIR_NAME, 'commands'))
      break
    default:
      break
  }
  return dirs.filter(dir => dir.length > 0).map(dir => join(dir, relative))
}

/**
 * Refuses anything that is not a `SKILL.md` inside a `skills`/`commands`
 * directory or a `.md` file inside a `commands` directory, and refuses paths
 * that do not resolve to an existing regular file.
 *
 * @returns `null` when safe to unlink, otherwise a human-readable reason.
 */
async function verifySkillFilePath(filePath: string): Promise<string | null> {
  if (!isAbsolute(filePath) || filePath.length === 0) {
    return 'Refusing to delete a path that is not absolute.'
  }
  const segments = filePath.split(sep)
  const inExpectedDir =
    segments.includes('skills') || segments.includes('commands')
  const base = basename(filePath)
  // The loader matches SKILL.md case-insensitively (isSkillFile), so this
  // check must too or a valid lowercase skill.md would be refused.
  if (base.toLowerCase() === 'skill.md') {
    if (!inExpectedDir) {
      return `Refusing to delete ${filePath}: not inside a skills or commands directory.`
    }
  } else if (!(base.toLowerCase().endsWith('.md') && segments.includes('commands'))) {
    return `Refusing to delete ${filePath}: expected SKILL.md or a .md file inside a commands directory.`
  }
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return `Refusing to delete ${filePath}: not a regular file.`
    }
  } catch (e: unknown) {
    return getErrnoCode(e) === 'ENOENT'
      ? `File not found: ${filePath}`
      : `Could not stat ${filePath}: ${toError(e).message}`
  }
  return null
}

function getLastUsedLabel(skill: SkillCommand): string {
  const usage = getGlobalConfig().skillUsage?.[skill.name]
  if (!usage) {
    return 'never used'
  }
  return `last used ${formatRelativeTimeAgo(new Date(usage.lastUsedAt))}`
}

function getInvocationLabel(skill: SkillCommand): string {
  return skill.disableModelInvocation ? '[manual only]' : '[model-invocable]'
}

export function SkillsManager({ commands, onBack, changes }: Props) {
  const [view, setView] = useState<ViewState>({ mode: 'list' })
  const [focusIndex, setFocusIndex] = useState(0)
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined)

  const skills = useMemo(() => {
    return commands.filter(isSkillCommand).filter(s => {
      return !deletedKeys.has(`${s.source}:${s.name}`)
    })
  }, [commands, deletedKeys])

  const groups = useMemo(() => {
    const grouped: Record<SkillSource, SkillCommand[]> = {
      policySettings: [],
      userSettings: [],
      projectSettings: [],
      localSettings: [],
      flagSettings: [],
      plugin: [],
      mcp: [],
    }
    for (const skill of skills) {
      const source = skill.source as SkillSource
      if (source in grouped) {
        grouped[source].push(skill)
      }
    }
    for (const group of Object.values(grouped)) {
      group.sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)))
    }
    return grouped
  }, [skills])

  // Flat row order across every group, matching the render order below.
  const flatSkills = useMemo(
    () => SOURCE_ORDER.flatMap(source => groups[source] ?? []),
    [groups],
  )
  const rowIndexBySkill = useMemo(() => {
    const map = new Map<SkillCommand, number>()
    flatSkills.forEach((skill, index) => map.set(skill, index))
    return map
  }, [flatSkills])

  const backIndex = flatSkills.length
  const totalRows = flatSkills.length + 1
  const activeIndex = Math.min(focusIndex, totalRows - 1)

  function handleDelete(skill: SkillCommand): void {
    void (async () => {
      const candidates = getSkillFileCandidates(skill)
      if (candidates.length === 0) {
        setDeleteError(
          'Could not determine the file for this skill, so nothing was deleted.',
        )
        return
      }
      // Never guess between several existing files. `skillRoot` yields one
      // exact path; the legacy single-file case rebuilds the path from the
      // command name, so more than one match means the guess is unsafe.
      const matches: string[] = []
      let lastReason = 'No candidate path passed the safety check.'
      for (const candidate of candidates) {
        const reason = await verifySkillFilePath(candidate)
        if (reason === null) {
          matches.push(candidate)
        } else {
          lastReason = reason
        }
      }
      if (matches.length === 0) {
        setDeleteError(lastReason)
        return
      }
      if (matches.length > 1 && !skill.skillRoot) {
        setDeleteError(
          `Refusing to delete: ${matches.length} files match ${getCommandName(skill)}. Delete it manually.`,
        )
        return
      }
      const filePath = matches[0]!
      try {
        await unlink(filePath)
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'ENOENT') {
          logError(toError(e))
          setDeleteError(`Failed to delete ${filePath}: ${toError(e).message}`)
          return
        }
      }
      setDeletedKeys(prev => {
        const next = new Set(prev)
        next.add(`${skill.source}:${skill.name}`)
        return next
      })
      setStatus(`Deleted skill: ${getCommandName(skill)}`)
      setDeleteError(undefined)
      setView({ mode: 'list' })
    })()
  }

  useInput(
    (_input, key) => {
      if (view.mode !== 'list') {
        return
      }
      if (key.upArrow) {
        setFocusIndex(prev =>
          prev <= 0 ? totalRows - 1 : Math.min(prev, totalRows - 1) - 1,
        )
        return
      }
      if (key.downArrow) {
        setFocusIndex(prev =>
          Math.min(prev, totalRows - 1) >= totalRows - 1
            ? 0
            : Math.min(prev, totalRows - 1) + 1,
        )
        return
      }
      if (key.return) {
        if (activeIndex === backIndex) {
          onBack()
          return
        }
        const skill = flatSkills[activeIndex]
        if (skill) {
          setStatus(undefined)
          setDeleteError(undefined)
          setView({ mode: 'detail', skill })
        }
      }
    },
    { isActive: view.mode === 'list' },
  )

  if (flatSkills.length === 0) {
    return (
      <Dialog
        title="Skills"
        subtitle="No skills found"
        onCancel={onBack}
        hideInputGuide={true}
      >
        <Text dimColor={true}>
          Create skills in .claude/skills/ or ~/.claude/skills/
        </Text>
        <Text dimColor={true} italic={true}>
          Esc to go back
        </Text>
      </Dialog>
    )
  }

  if (view.mode === 'detail') {
    const skill = view.skill
    const sourceKey = skill.source as SkillSource
    const subdir =
      skill.loadedFrom === 'commands_DEPRECATED' ? 'commands' : 'skills'
    const fallbackDir =
      sourceKey === 'plugin' || sourceKey === 'mcp'
        ? ''
        : getSourceDir(skill, subdir)
    // `skillRoot` is set for the SKILL.md directory layout. A legacy
    // single-file command has neither it nor a per-file path on the command,
    // so fall back to the directory the loader reads (honest, not exact).
    const skillPath = skill.skillRoot
      ? getDisplayPath(skill.skillRoot)
      : fallbackDir
        ? getDisplayPath(fallbackDir)
        : undefined
    const pathLabel = skill.skillRoot
      ? 'Path'
      : fallbackDir
        ? 'Source directory'
        : undefined
    const pluginName = skill.pluginInfo?.pluginManifest.name
    const usage = getGlobalConfig().skillUsage?.[skill.name]
    const deletable = isFileBacked(skill)
    const candidates = deletable ? getSkillFileCandidates(skill) : []
    const targetFile = candidates[0] ? getDisplayPath(candidates[0]) : undefined

    const options: { label: string; value: 'delete' | 'back' }[] = deletable
      ? [
          { label: 'Delete skill', value: 'delete' },
          { label: 'Back', value: 'back' },
        ]
      : [{ label: 'Back', value: 'back' }]

    return (
      <Dialog
        title={getCommandName(skill)}
        subtitle={sourceKey === 'mcp' ? 'MCP skill' : getSourceTitle(sourceKey)}
        onCancel={() => setView({ mode: 'list' })}
        hideInputGuide={true}
      >
        <Box flexDirection="column">
          {skillPath ? (
            <Text dimColor={true}>
              {pathLabel ? `${pathLabel}: ` : ''}
              {skillPath}
            </Text>
          ) : (
            <Text dimColor={true}>No local path (provided by a plugin or MCP server)</Text>
          )}
          {pluginName ? (
            <Text dimColor={true}>Plugin: {pluginName}</Text>
          ) : null}
          <Box marginTop={1}>
            <Text>{skill.description}</Text>
          </Box>
          {skill.whenToUse ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold={true}>When to use</Text>
              <Text>{skill.whenToUse}</Text>
            </Box>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text bold={true}>Last used</Text>:{' '}
              {usage ? getLastUsedLabel(skill) : 'never used'}
            </Text>
            <Text>
              <Text bold={true}>Times used</Text>:{' '}
              {usage ? usage.usageCount : 0}
            </Text>
            <Text>
              <Text bold={true}>Model invocation</Text>: {getInvocationLabel(skill)}
            </Text>
            <Text>
              <Text bold={true}>Prompt size</Text>: {skill.contentLength}{' '}
              characters
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor={true}>
              The skill body is not rendered here. Only frontmatter fields are
              shown.
            </Text>
          </Box>
          {deletable ? (
            <Box marginTop={1} flexDirection="column">
              {targetFile ? (
                <Text dimColor={true}>Target file: {targetFile}</Text>
              ) : (
                <Text dimColor={true}>
                  Target file: could not be determined from the loaded command
                </Text>
              )}
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor={true}>
                {skill.loadedFrom === 'plugin'
                  ? 'Plugin skills belong to a plugin. Remove the plugin to delete them.'
                  : 'MCP skills come from an MCP server. There is no local file to delete.'}
              </Text>
            </Box>
          )}
          {deleteError ? (
            <Box marginTop={1}>
              <Text color="error">{deleteError}</Text>
            </Box>
          ) : null}
        </Box>
        <Box marginTop={1}>
          <Select
            options={options}
            onChange={value => {
              if (value === 'delete') {
                setDeleteError(undefined)
                setView({ mode: 'delete-confirm', skill })
              } else {
                setView({ mode: 'list' })
              }
            }}
            onCancel={() => setView({ mode: 'list' })}
          />
        </Box>
        <Text dimColor={true} italic={true}>
          Esc to go back
        </Text>
      </Dialog>
    )
  }

  if (view.mode === 'delete-confirm') {
    const skill = view.skill
    const candidates = getSkillFileCandidates(skill)
    const targetFile = candidates[0] ? getDisplayPath(candidates[0]) : undefined
    return (
      <Dialog
        title="Delete skill"
        onCancel={() => setView({ mode: 'detail', skill })}
        color="error"
        hideInputGuide={true}
      >
        <Text>
          Are you sure you want to delete{' '}
          <Text bold={true}>{getCommandName(skill)}</Text>?
        </Text>
        {targetFile ? (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor={true}>
              {skill.skillRoot ? 'File' : 'Expected file'}: {targetFile}
            </Text>
            {skill.skillRoot ? null : (
              <Text dimColor={true}>
                This path is rebuilt from the command name. If it does not
                match exactly one file, the delete is refused.
              </Text>
            )}
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text color="error">
              The skill file could not be determined, so deletion would be
              refused.
            </Text>
          </Box>
        )}
        {deleteError ? (
          <Box marginTop={1}>
            <Text color="error">{deleteError}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Select
            options={[
              { label: 'Yes, delete', value: 'yes' as const },
              { label: 'No, cancel', value: 'no' as const },
            ]}
            onChange={value => {
              if (value === 'yes') {
                handleDelete(skill)
              } else {
                setView({ mode: 'detail', skill })
              }
            }}
            onCancel={() => setView({ mode: 'detail', skill })}
          />
        </Box>
        <Text dimColor={true} italic={true}>
          Esc to cancel
        </Text>
      </Dialog>
    )
  }

  const latestChange = changes && changes.length > 0 ? changes[changes.length - 1] : undefined

  return (
    <Dialog
      title="Skills"
      subtitle={`${flatSkills.length} ${plural(flatSkills.length, 'skill')}`}
      onCancel={onBack}
      hideInputGuide={true}
    >
      <Box flexDirection="column" gap={1}>
        {SOURCE_ORDER.map(source => {
          const groupSkills = groups[source] ?? []
          if (groupSkills.length === 0) {
            return null
          }
          const title = getSourceTitle(source)
          const subtitle = getSourceSubtitle(source, groupSkills)
          return (
            <Box flexDirection="column" key={source}>
              <Box>
                <Text bold={true} dimColor={true}>
                  {title}
                </Text>
                {subtitle ? <Text dimColor={true}> ({subtitle})</Text> : null}
              </Box>
              {groupSkills.map(skill => {
                const isFocused = rowIndexBySkill.get(skill) === activeIndex
                return (
                  <Box key={`${skill.source}:${skill.name}`}>
                    <Text color={isFocused ? 'suggestion' : undefined}>
                      {isFocused ? `${figures.pointer} ` : '  '}
                    </Text>
                    <Text color={isFocused ? 'suggestion' : undefined}>
                      {getCommandName(skill)}
                    </Text>
                    <Text dimColor={true} color={isFocused ? 'suggestion' : undefined}>
                      {' \xB7 '}~{formatTokens(estimateSkillFrontmatterTokens(skill))}{' '}
                      description tokens{' \xB7 '}
                      {getInvocationLabel(skill)}
                      {' \xB7 '}
                      {getLastUsedLabel(skill)}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )
        })}
        <Box>
          <Text color={activeIndex === backIndex ? 'suggestion' : undefined}>
            {activeIndex === backIndex ? `${figures.pointer} ` : '  '}
          </Text>
          <Text color={activeIndex === backIndex ? 'suggestion' : undefined}>
            Back
          </Text>
        </Box>
      </Box>
      {status ? (
        <Box marginTop={1}>
          <Text dimColor={true}>{status}</Text>
        </Box>
      ) : null}
      {latestChange ? (
        <Box marginTop={1}>
          <Text dimColor={true}>{latestChange}</Text>
        </Box>
      ) : null}
      <Text dimColor={true} italic={true}>
        {'\u2191\u2193'} to navigate {'\xB7'} Enter to select {'\xB7'} Esc to go
        back
      </Text>
    </Dialog>
  )
}
