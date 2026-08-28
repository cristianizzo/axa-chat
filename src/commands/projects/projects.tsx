import { basename } from 'path'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Pane } from '../../components/design-system/Pane.js'
import { BINARY_NAME } from '../../constants/product.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  listProjectConversations,
  listProjects,
  type ProjectSummary,
} from '../../services/projects/projectList.js'
import type { SessionInfo } from '../../utils/listSessionsImpl.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { formatFileSize, formatRelativeTime } from '../../utils/format.js'
import { logError } from '../../utils/log.js'

type Props = {
  onDone: () => void
}

type View =
  | { status: 'loading' }
  | { status: 'list'; projects: ProjectSummary[] }
  | { status: 'opening'; project: ProjectSummary }
  | {
      status: 'detail'
      project: ProjectSummary
      conversations: SessionInfo[]
    }
  | { status: 'error'; message: string }

/**
 * What to call a project.
 *
 * The last path segment, because that is how the user refers to the directory.
 * Falls back to the sanitized folder name when no transcript gave up a real
 * path — that name is unreadable, but it is the only handle that project has.
 */
function displayName(project: ProjectSummary): string {
  if (!project.path) return project.dirName
  return basename(project.path) || project.path
}

function projectFlags(project: ProjectSummary): string[] {
  const flags: string[] = []
  if (project.isCurrent) flags.push('current')
  if (project.missingPath) flags.push('folder deleted')
  if (project.orphanedData) flags.push('no conversations left')
  return flags
}

function ProjectRow({ project }: { project: ProjectSummary }): React.ReactNode {
  const flags = projectFlags(project)
  return (
    <Box>
      <Text>{displayName(project)}</Text>
      <Text dimColor>
        {'  '}
        {project.conversations} conv · {formatFileSize(project.bytes)}
        {project.lastUsed > 0
          ? ` · ${formatRelativeTime(new Date(project.lastUsed))}`
          : ''}
      </Text>
      {flags.length > 0 ? (
        <Text color={project.isCurrent ? 'success' : 'warning'}>
          {'  '}
          {flags.join(', ')}
        </Text>
      ) : null}
    </Box>
  )
}

function ProjectsScreen({ onDone }: Props): React.ReactNode {
  const [view, setView] = useState<View>({ status: 'loading' })

  /**
   * Identifies the navigation a pending read belongs to.
   *
   * Reading a project with hundreds of conversations takes long enough to press
   * Esc during, and the resolved promise would otherwise drop the user back
   * into the screen they just left. Every navigation takes a new token and only
   * the newest is allowed to render.
   */
  const navigation = useRef(0)
  const beginNavigation = (): number => ++navigation.current
  const isCurrent = (token: number): boolean => navigation.current === token

  useEffect(() => {
    const token = beginNavigation()
    void (async () => {
      try {
        const projects = await listProjects()
        if (isCurrent(token)) setView({ status: 'list', projects })
      } catch (error) {
        logError(error)
        if (isCurrent(token)) setView({ status: 'error', message: String(error) })
      }
    })()
    // Mount only: the list is re-read through reload() after an action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc goes back a level rather than straight out, so opening a project by
  // mistake is one keypress to undo.
  useKeybinding(
    'confirm:no',
    () => {
      if (view.status === 'detail' || view.status === 'opening') {
        void reload()
        return
      }
      onDone()
    },
    { context: 'Confirmation' },
  )

  async function reload(): Promise<void> {
    const token = beginNavigation()
    setView({ status: 'loading' })
    try {
      const projects = await listProjects()
      if (isCurrent(token)) setView({ status: 'list', projects })
    } catch (error) {
      logError(error)
      if (isCurrent(token)) setView({ status: 'error', message: String(error) })
    }
  }

  function open(project: ProjectSummary): void {
    const token = beginNavigation()
    setView({ status: 'opening', project })
    void (async () => {
      try {
        const conversations = await listProjectConversations(project.dir)
        if (isCurrent(token)) {
          setView({ status: 'detail', project, conversations })
        }
      } catch (error) {
        logError(error)
        if (isCurrent(token)) setView({ status: 'error', message: String(error) })
      }
    })()
  }

  switch (view.status) {
    case 'loading':
      return (
        <Pane>
          <Text dimColor>Reading projects…</Text>
        </Pane>
      )

    case 'error':
      return (
        <Pane>
          <Text color="error">{view.message}</Text>
          <Box marginTop={1}>
            <Text dimColor>(press esc to close)</Text>
          </Box>
        </Pane>
      )

    case 'list': {
      if (view.projects.length === 0) {
        return (
          <Pane>
            <Text>No projects yet.</Text>
            <Text dimColor>
              A project appears here after the first conversation you have in a
              folder.
            </Text>
            <Box marginTop={1}>
              <Text dimColor>(press esc to close)</Text>
            </Box>
          </Pane>
        )
      }

      const totalConversations = view.projects.reduce(
        (total, project) => total + project.conversations,
        0,
      )
      const totalBytes = view.projects.reduce(
        (total, project) => total + project.bytes,
        0,
      )

      return (
        <Pane>
          <Box marginBottom={1}>
            <Text bold>Projects</Text>
            <Text dimColor>
              {'  '}
              {view.projects.length} projects · {totalConversations}{' '}
              conversations · {formatFileSize(totalBytes)}
            </Text>
          </Box>
          <Select
            options={view.projects.map(project => ({
              label: <ProjectRow project={project} />,
              value: project.dirName,
              description: project.path ?? 'original folder unknown',
            }))}
            visibleOptionCount={10}
            onChange={dirName => {
              const project = view.projects.find(p => p.dirName === dirName)
              if (project) open(project)
            }}
            onCancel={onDone}
          />
          <Box marginTop={1}>
            <Text dimColor>
              enter to see a project&apos;s conversations · esc to close
            </Text>
          </Box>
        </Pane>
      )
    }

    case 'opening':
      return (
        <Pane>
          <Text dimColor>Reading {displayName(view.project)}…</Text>
        </Pane>
      )

    case 'detail': {
      const { project, conversations } = view
      return (
        <Pane>
          <Box marginBottom={1}>
            <Text bold>{displayName(project)}</Text>
          </Box>
          <Text dimColor>{project.path ?? project.dir}</Text>
          <Text dimColor>
            {project.conversations} conversations ·{' '}
            {formatFileSize(project.bytes)}
            {project.lastUsed > 0
              ? ` · last used ${formatRelativeTime(new Date(project.lastUsed))}`
              : ''}
          </Text>
          {project.missingPath ? (
            <Text color="warning">
              The folder {project.path} no longer exists.
            </Text>
          ) : null}
          {project.orphanedData ? (
            <Text color="warning">
              No conversations left here, but {formatFileSize(project.bytes)} of
              backups or subagent transcripts remain.
            </Text>
          ) : null}

          <Box marginTop={1} flexDirection="column">
            {conversations.length === 0 ? (
              <Text dimColor>Nothing readable to list.</Text>
            ) : (
              conversations.slice(0, 10).map(conversation => (
                <Box key={conversation.sessionId}>
                  <Text dimColor>
                    {formatRelativeTime(
                      new Date(conversation.lastModified),
                    ).padEnd(10)}
                  </Text>
                  <Text wrap="truncate-end">{conversation.summary}</Text>
                </Box>
              ))
            )}
            {conversations.length > 10 ? (
              <Text dimColor>…and {conversations.length - 10} more</Text>
            ) : null}
          </Box>

          <Box marginTop={1}>
            <Text dimColor>
              {project.path && !project.missingPath
                ? // Quoted: paths with spaces are normal on macOS and Windows,
                  // and this line is meant to be copied straight into a shell.
                  `cd ${quote([project.path])} && ${BINARY_NAME} --resume`
                : 'esc to go back'}
            </Text>
          </Box>
        </Pane>
      )
    }
  }
}

export const call: LocalJSXCommandCall = async onDone => {
  return <ProjectsScreen onDone={onDone} />
}
