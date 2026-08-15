import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  isServableByActiveProvider,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)

  // parseUserSpecifiedModel reads tengu_ant_model_override via
  // _CACHED_MAY_BE_STALE (in resolveAntModel). Until GB init completes,
  // that's the stale disk cache; after, it's the in-memory remoteEval map.
  // AppState doesn't change when GB init finishes, so we subscribe to the
  // refresh signal and force a re-render to re-resolve with fresh values.
  // Without this, the alias resolution is frozen until something else
  // happens to re-render the component — the API would sample one model
  // while /model (which also re-resolves) displays another.
  const [, forceRerender] = useReducer(x => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  // The request path uses this value directly, so it is the last line of
  // defence against a model leaking to a provider that can't serve it. A
  // concrete ID pinned for one account (e.g. Ollama's qwen3:8b) must never be
  // sent to another (e.g. Codex, which 400s it) if state is stale for any
  // reason. Aliases and null always pass; only a non-servable concrete ID is
  // dropped, falling back to the active provider's default.
  const candidate = mainLoopModelForSession ?? mainLoopModel
  const setting =
    candidate != null && !isServableByActiveProvider(candidate)
      ? getDefaultMainLoopModelSetting()
      : (candidate ?? getDefaultMainLoopModelSetting())

  const model = parseUserSpecifiedModel(setting)
  return model
}
