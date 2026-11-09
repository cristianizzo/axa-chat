import { expect, test } from 'bun:test'
import { isRecognisedModelForDeepSeek, resolveClaudeModelForDeepSeek } from './deepseek.js'
import { isRecognisedModelForGrok, resolveClaudeModelForGrok } from './grok.js'

test('DeepSeek recognises its own IDs and the Claude families it maps', () => {
  expect(isRecognisedModelForDeepSeek('deepseek-v4-pro')).toBe(true)
  expect(isRecognisedModelForDeepSeek('claude-opus-5')).toBe(true)
  expect(isRecognisedModelForDeepSeek(undefined)).toBe(true)
})

test('DeepSeek flags an ID it only falls back on, so the adapter can warn', () => {
  expect(isRecognisedModelForDeepSeek('claude-typo-5')).toBe(false)
  expect(resolveClaudeModelForDeepSeek('claude-typo-5')).toBe('deepseek-v4-flash')
})

test('Grok recognises its own IDs and the Claude families it maps', () => {
  expect(isRecognisedModelForGrok('grok-4.6')).toBe(true)
  expect(isRecognisedModelForGrok('claude-sonnet-5')).toBe(true)
  expect(isRecognisedModelForGrok(undefined)).toBe(true)
})

test('Grok flags an ID it only falls back on, so the adapter can warn', () => {
  expect(isRecognisedModelForGrok('gpt-5')).toBe(false)
  expect(resolveClaudeModelForGrok('gpt-5')).toBe('grok-4.6')
})
