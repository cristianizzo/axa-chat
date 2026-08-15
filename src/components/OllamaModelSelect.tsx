import * as React from 'react'
import { useEffect, useState } from 'react'
import { getOllamaBaseUrl } from '../config/ollama.js'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'

/**
 * Lets the user pick which installed Ollama model the account should use,
 * instead of making them export OLLAMA_MODEL by hand.
 *
 * Models are read from the daemon's `/api/tags` endpoint, so the list is
 * exactly what `ollama pull` has made available locally. If OLLAMA_MODEL is
 * set it is offered as the default selection, but it is no longer required.
 */
type Props = {
  onSelect: (model: string) => void
  onError: (message: string) => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; models: string[] }

export function OllamaModelSelect({ onSelect, onError }: Props): React.ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const baseUrl = getOllamaBaseUrl()
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/tags`)
        if (!res.ok) {
          throw new Error(`Ollama responded ${res.status}`)
        }
        const body = (await res.json()) as { models?: { name?: string }[] }
        const models = (body.models ?? [])
          .map(m => m.name)
          .filter((name): name is string => !!name)
        if (cancelled) {
          return
        }
        if (models.length === 0) {
          onError(
            `No models installed. Run e.g. \`ollama pull qwen3:8b\`, then /login again.`,
          )
          return
        }
        setState({ status: 'ready', models })
      } catch (err) {
        if (cancelled) {
          return
        }
        onError(
          `Could not reach the Ollama daemon at ${baseUrl} (${(err as Error).message}). Is it running?`,
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [onError])

  if (state.status === 'loading') {
    return <Text dimColor={true}>Loading installed Ollama models…</Text>
  }

  const preferred = process.env.OLLAMA_MODEL?.trim()
  const defaultValue = preferred && state.models.includes(preferred)
    ? preferred
    : state.models[0]

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold={true}>Select an Ollama model:</Text>
      <Select
        options={state.models.map(model => ({ label: model, value: model }))}
        defaultValue={defaultValue}
        onChange={value => onSelect(value as string)}
      />
    </Box>
  )
}
