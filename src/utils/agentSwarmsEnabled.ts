import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * This fork ships agent teams on by default — upstream's external-build
 * opt-in assumed a hosted product where the killswitch protects users from an
 * unfinished feature. Requiring CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 on every
 * launch made the feature present but unreachable.
 *
 * Off switch, kept deliberately: setting the variable to 0 disables it again.
 * Higher-precedence settings and a shell export still apply per the normal
 * env rules.
 */
export function isAgentSwarmsEnabled(): boolean {
  // Ant: always on
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // Opt-out only. isEnvTruthy treats "0"/"false"/"off" as false, so an
  // explicit CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 turns the feature off;
  // anything else, including the variable being unset, leaves it on.
  if (
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== undefined &&
    !isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS)
  ) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
