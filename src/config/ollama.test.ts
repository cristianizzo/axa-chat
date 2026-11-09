import { expect, test } from 'bun:test'
import { formatOllamaCredits } from './ollama.js'

test('reports the share of the allowance spent', () => {
  expect(formatOllamaCredits({ allowance_usd: 60, balance_usd: 54.34 })).toBe(
    '9% used',
  )
})

test('a local-only account has no allowance, so there is nothing to report', () => {
  expect(formatOllamaCredits({ allowance_usd: 0, balance_usd: 0 })).toBeNull()
  expect(formatOllamaCredits(undefined)).toBeNull()
})

test('a refunded balance above the allowance clamps to 0%, not negative', () => {
  expect(formatOllamaCredits({ allowance_usd: 10, balance_usd: 12 })).toBe(
    '0% used',
  )
  expect(formatOllamaCredits({ allowance_usd: 10, balance_usd: 0 })).toBe(
    '100% used',
  )
})
