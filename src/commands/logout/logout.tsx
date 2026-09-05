import * as React from 'react';
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js';
import { Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js';
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js';
// flushTelemetry is loaded lazily to avoid pulling in ~1.1MB of OpenTelemetry at startup
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js';
import { getProvider } from '../../config/providers/index.js';
import { clearActiveAuthProvider, getActiveAuthProvider } from '../../utils/activeAuthProvider.js';
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js';
import { clearBetasCaches } from '../../utils/betas.js';
import { saveGlobalConfig } from '../../utils/config.js';
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js';
import { getSecureStorage } from '../../utils/secureStorage/index.js';
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js';
import { resetUserCache } from '../../utils/user.js';
export async function performLogout({
  clearOnboarding = false
}): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const {
    flushTelemetry
  } = await import('../../utils/telemetry/instrumentation.js');
  await flushTelemetry();
  await removeApiKey();

  // Wipe all secure storage data on logout
  const secureStorage = getSecureStorage();
  secureStorage.delete();
  await clearAuthRelatedCaches();
  saveGlobalConfig(current => {
    const updated = {
      ...current
    };
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false;
      updated.subscriptionNoticeCount = 0;
      updated.hasAvailableSubscription = false;
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: []
        };
      }
    }
    updated.oauthAccount = undefined;
    // Not pinned to a provider any more. Resolution falls back to whatever
    // credentials remain, so a user who is also logged into Codex lands there
    // rather than on an Anthropic account that no longer exists.
    updated.activeAuthProvider = undefined;
    return updated;
  });
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  // Clear the OAuth token cache
  getClaudeAIOAuthTokens.cache?.clear?.();
  clearTrustedDeviceTokenCache();
  clearBetasCaches();
  clearToolSchemaCache();

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache();
  refreshGrowthBookAfterAuthChange();

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.();
  getGroveSettings.cache?.clear?.();

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache();

  // Clear policy limits cache
  await clearPolicyLimitsCache();
}
export async function call(): Promise<React.ReactNode> {
  // Log out of the account actually in use. Running the Anthropic logout while
  // signed in with Codex would wipe the keychain and leave the ChatGPT tokens —
  // and the session — exactly as they were.
  const {
    logout
  } = getProvider(getActiveAuthProvider());
  switch (logout.kind) {
    case 'configKey':
      // Drop only this provider's credentials, leaving the keychain and every
      // other account untouched. clearActiveAuthProvider then lets resolution
      // fall back to whatever remains signed in.
      saveGlobalConfig(logout.clearCredentials);
      clearActiveAuthProvider();
      await clearAuthRelatedCaches();
      break;
    case 'anthropicKeychain':
      await performLogout({
        clearOnboarding: true
      });
      break;
  }
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout');
  }, 200);
  return <Text>{logout.message}</Text>;
}
