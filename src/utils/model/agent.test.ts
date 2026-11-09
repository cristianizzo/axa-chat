import { expect, test } from 'bun:test'
import { setActiveAuthProviderForSession } from '../activeAuthProvider.js'
import { saveGlobalConfig } from '../config.js'
import { getAgentModel } from './agent.js'

// Under bun test, config is an in-memory object, so this login never touches disk.
const OLLAMA_MODEL = 'deepseek-v4.1-flash:1017-cloud'
saveGlobalConfig(config => ({
  ...config,
  ollamaAuth: { baseUrl: 'http://localhost:11434', model: OLLAMA_MODEL },
}))

test('on Ollama, a tier alias falls back to the parent model instead of a claude-* ID', () => {
  setActiveAuthProviderForSession('ollama')
  expect(getAgentModel('opus', OLLAMA_MODEL)).toBe(OLLAMA_MODEL)
  expect(getAgentModel('sonnet', OLLAMA_MODEL)).toBe(OLLAMA_MODEL)
  expect(getAgentModel(undefined, OLLAMA_MODEL, 'haiku')).toBe(OLLAMA_MODEL)
})

test('on Ollama, a concrete model ID is kept: it is a deliberate choice', () => {
  setActiveAuthProviderForSession('ollama')
  expect(getAgentModel('deepseek-v4-pro:0813-cloud', OLLAMA_MODEL)).toBe(
    'deepseek-v4-pro:0813-cloud',
  )
})

test('on Anthropic, a tier alias still resolves to a Claude model', () => {
  setActiveAuthProviderForSession('anthropic')
  expect(getAgentModel('opus', 'claude-sonnet-5-5')).toMatch(/^claude-opus/)
})

test('the subagent env override goes through the alias fallback too', () => {
  setActiveAuthProviderForSession('ollama')
  process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'opus'
  try {
    expect(getAgentModel(undefined, OLLAMA_MODEL)).toBe(OLLAMA_MODEL)
  } finally {
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL
  }
})
