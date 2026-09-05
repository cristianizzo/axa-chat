import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { installOAuthTokens } from '../cli/handlers/auth.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { setClipboard } from '../ink/termio/osc.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { Box, Link, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import { getSSLErrorHint } from '../services/api/errorUtils.js';
import { sendNotification } from '../services/notifier.js';
import { runCodexOAuthFlow } from '../services/oauth/codex-client.js';
import { OAuthService } from '../services/oauth/index.js';
import { getOauthAccountInfo, saveCodexOAuthTokens, saveOllamaAuth, validateForceLoginOrg } from '../utils/auth.js';
import { getOllamaAuthToken, getOllamaBaseUrl, OLLAMA_PROVIDER_ID } from '../config/ollama.js';
import { CODEX_PROVIDER_ID } from '../config/codex.js';
import { ALL_PROVIDERS, ANTHROPIC_PROVIDER_ID, API_KEY_PATTERN, type AuthProviderId, getProvider, isAuthProviderId } from '../config/providers/index.js';
import { saveGlobalConfig } from '../utils/config.js';
import { logError } from '../utils/log.js';
import { getSettings_DEPRECATED } from '../utils/settings/settings.js';
import { Select } from './CustomSelect/select.js';
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js';
import { Spinner } from './Spinner.js';
import TextInput from './TextInput.js';
import { OllamaModelSelect } from './OllamaModelSelect.js';
import { PRODUCT_NAME } from '../constants/product.js';
type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: 'login' | 'setup-token';
  forceLoginMethod?: 'claudeai' | 'console';
};
type OAuthStatus = {
  state: 'idle';
} // Initial state, waiting to select login method
| {
  state: 'platform_setup';
} // Show platform setup info (Bedrock/Vertex/Foundry)
| {
  state: 'ollama_model_select';
} // Ollama chosen: pick which installed model to use
| {
  state: 'api_key';
  provider: AuthProviderId;
} // A key-based provider chosen: enter its API key
| {
  state: 'ready_to_start';
} // Flow started, waiting for browser to open
| {
  state: 'waiting_for_login';
  url: string;
} // Browser opened, waiting for user to login
| {
  state: 'creating_api_key';
} // Got access token, creating API key
| {
  state: 'about_to_retry';
  nextState: OAuthStatus;
} | {
  state: 'success';
  token?: string;
} | {
  state: 'error';
  message: string;
  toRetry?: OAuthStatus;
};
const PASTE_HERE_MSG = 'Paste code here if prompted > ';
export function ConsoleOAuthFlow({
  onDone,
  startingMessage,
  mode = 'login',
  forceLoginMethod: forceLoginMethodProp
}: Props): React.ReactNode {
  const settings = getSettings_DEPRECATED() || {};
  const forceLoginMethod = forceLoginMethodProp ?? settings.forceLoginMethod;
  const orgUUID = settings.forceLoginOrgUUID;
  const forcedMethodMessage = forceLoginMethod === 'claudeai' ? 'Login method pre-selected: Subscription Plan (Claude Pro/Max)' : forceLoginMethod === 'console' ? 'Login method pre-selected: API Usage Billing (Anthropic Console)' : null;
  const terminal = useTerminalNotification();
  const [oauthStatus, setOAuthStatus] = useState<OAuthStatus>(() => {
    if (mode === 'setup-token') {
      return {
        state: 'ready_to_start'
      };
    }
    if (forceLoginMethod === 'claudeai' || forceLoginMethod === 'console') {
      return {
        state: 'ready_to_start'
      };
    }
    return {
      state: 'idle'
    };
  });
  const [pastedCode, setPastedCode] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [oauthService] = useState(() => new OAuthService());
  const [loginWithClaudeAi, setLoginWithClaudeAi] = useState(() => {
    // Use Claude AI auth for setup-token mode to support user:inference scope
    return mode === 'setup-token' || forceLoginMethod === 'claudeai';
  });
  const [loginWithCodex, setLoginWithCodex] = useState(false);
  // After a few seconds we suggest the user to copy/paste url if the
  // browser did not open automatically. In this flow we expect the user to
  // copy the code from the browser and paste it in the terminal
  const [showPastePrompt, setShowPastePrompt] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const textInputColumns = useTerminalSize().columns - PASTE_HERE_MSG.length - 1;

  // Log forced login method on mount
  useEffect(() => {
    if (forceLoginMethod === 'claudeai') {
      logEvent('tengu_oauth_claudeai_forced', {});
    } else if (forceLoginMethod === 'console') {
      logEvent('tengu_oauth_console_forced', {});
    }
  }, [forceLoginMethod]);

  // Retry logic
  useEffect(() => {
    if (oauthStatus.state === 'about_to_retry') {
      const timer = setTimeout(setOAuthStatus, 1000, oauthStatus.nextState);
      return () => clearTimeout(timer);
    }
  }, [oauthStatus]);

  // Handle Enter to continue on success state
  useKeybinding('confirm:yes', () => {
    logEvent('tengu_oauth_success', {
      loginWithClaudeAi
    });
    onDone();
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'success' && mode !== 'setup-token'
  });

  // Handle Enter to continue from platform setup
  useKeybinding('confirm:yes', () => {
    setOAuthStatus({
      state: 'idle'
    });
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'platform_setup'
  });

  // Handle Enter to retry on error state
  useKeybinding('confirm:yes', () => {
    if (oauthStatus.state === 'error' && oauthStatus.toRetry) {
      setPastedCode('');
      setOAuthStatus({
        state: 'about_to_retry',
        nextState: oauthStatus.toRetry
      });
    }
  }, {
    context: 'Confirmation',
    isActive: oauthStatus.state === 'error' && !!oauthStatus.toRetry
  });
  useEffect(() => {
    if (pastedCode === 'c' && oauthStatus.state === 'waiting_for_login' && showPastePrompt && !urlCopied) {
      void setClipboard(oauthStatus.url).then(raw => {
        if (raw) process.stdout.write(raw);
        setUrlCopied(true);
        setTimeout(setUrlCopied, 2000, false);
      });
      setPastedCode('');
    }
  }, [pastedCode, oauthStatus, showPastePrompt, urlCopied]);
  async function handleSubmitCode(value: string, url: string) {
    try {
      // Expecting format "authorizationCode#state" from the authorization callback URL
      const [authorizationCode, state] = value.split('#');
      if (!authorizationCode || !state) {
        setOAuthStatus({
          state: 'error',
          message: 'Invalid code. Please make sure the full code was copied',
          toRetry: {
            state: 'waiting_for_login',
            url
          }
        });
        return;
      }

      // Track which path the user is taking (manual code entry)
      logEvent('tengu_oauth_manual_entry', {});
      oauthService.handleManualAuthCodeInput({
        authorizationCode,
        state
      });
    } catch (err: unknown) {
      logError(err);
      setOAuthStatus({
        state: 'error',
        message: (err as Error).message,
        toRetry: {
          state: 'waiting_for_login',
          url
        }
      });
    }
  }
  const startOAuth = useCallback(async () => {
    try {
      logEvent('tengu_oauth_flow_start', {
        loginWithClaudeAi
      });
      const result = await oauthService.startOAuthFlow(async url_0 => {
        setOAuthStatus({
          state: 'waiting_for_login',
          url: url_0
        });
        setTimeout(setShowPastePrompt, 3000, true);
      }, {
        loginWithClaudeAi,
        inferenceOnly: mode === 'setup-token',
        expiresIn: mode === 'setup-token' ? 365 * 24 * 60 * 60 : undefined,
        // 1 year for setup-token
        orgUUID
      }).catch(err_1 => {
        const isTokenExchangeError = err_1.message.includes('Token exchange failed');
        // Enterprise TLS proxies (Zscaler et al.) intercept the token
        // exchange POST and cause cryptic SSL errors. Surface an
        // actionable hint so the user isn't stuck in a login loop.
        const sslHint_0 = getSSLErrorHint(err_1);
        setOAuthStatus({
          state: 'error',
          message: sslHint_0 ?? (isTokenExchangeError ? 'Failed to exchange authorization code for access token. Please try again.' : err_1.message),
          toRetry: mode === 'setup-token' ? {
            state: 'ready_to_start'
          } : {
            state: 'idle'
          }
        });
        logEvent('tengu_oauth_token_exchange_error', {
          error: err_1.message,
          ssl_error: sslHint_0 !== null
        });
        throw err_1;
      });
      if (mode === 'setup-token') {
        // For setup-token mode, return the OAuth access token directly (it can be used as an API key)
        // Don't save to keychain - the token is displayed for manual use with CLAUDE_CODE_OAUTH_TOKEN
        setOAuthStatus({
          state: 'success',
          token: result.accessToken
        });
      } else {
        await installOAuthTokens(result);
        const orgResult = await validateForceLoginOrg();
        if (!orgResult.valid) {
          throw new Error('message' in orgResult ? (orgResult as any).message : 'Invalid organization');
        }
        setOAuthStatus({
          state: 'success'
        });
        void sendNotification({
          message: `${PRODUCT_NAME} login successful`,
          notificationType: 'auth_success'
        }, terminal);
      }
    } catch (err_0) {
      const errorMessage = (err_0 as Error).message;
      const sslHint = getSSLErrorHint(err_0);
      setOAuthStatus({
        state: 'error',
        message: sslHint ?? errorMessage,
        toRetry: {
          state: mode === 'setup-token' ? 'ready_to_start' : 'idle'
        }
      });
      logEvent('tengu_oauth_error', {
        error: errorMessage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ssl_error: sslHint !== null
      });
    }
  }, [oauthService, setShowPastePrompt, loginWithClaudeAi, mode, orgUUID]);

  // Codex-specific OAuth flow — completely separate from the Anthropic OAuthService
  const startCodexOAuth = useCallback(async () => {
    try {
      logEvent('tengu_oauth_codex_flow_start', {});
      const codexTokens = await runCodexOAuthFlow(async (url) => {
        setOAuthStatus({ state: 'waiting_for_login', url });
        setTimeout(setShowPastePrompt, 3000, true);
      });
      // Save directly via saveCodexOAuthTokens (bypasses installOAuthTokens Anthropic path)
      saveCodexOAuthTokens(codexTokens);
      logEvent('tengu_oauth_codex_success', {});
      setOAuthStatus({ state: 'success' });
      void sendNotification({ message: 'Codex login successful', notificationType: 'auth_success' }, terminal);
    } catch (err) {
      const msg = (err as Error).message;
      logEvent('tengu_oauth_codex_error', {
        error: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setOAuthStatus({ state: 'error', message: msg, toRetry: { state: 'idle' } });
    }
  }, [setShowPastePrompt, terminal]);

  const pendingOAuthStartRef = useRef(false);
  useEffect(() => {
    if (oauthStatus.state === 'ready_to_start' && !pendingOAuthStartRef.current) {
      pendingOAuthStartRef.current = true;
      if (loginWithCodex) {
        process.nextTick((startCodexOAuth_0: () => Promise<void>, pendingOAuthStartRef_0: React.MutableRefObject<boolean>) => {
          void startCodexOAuth_0();
          pendingOAuthStartRef_0.current = false;
        }, startCodexOAuth, pendingOAuthStartRef);
      } else {
        process.nextTick((startOAuth_0: () => Promise<void>, pendingOAuthStartRef_0: React.MutableRefObject<boolean>) => {
          void startOAuth_0();
          pendingOAuthStartRef_0.current = false;
        }, startOAuth, pendingOAuthStartRef);
      }
    }
  }, [oauthStatus.state, startOAuth, startCodexOAuth, loginWithCodex]);

  // Auto-exit for setup-token mode
  useEffect(() => {
    if (mode === 'setup-token' && oauthStatus.state === 'success') {
      // Delay to ensure static content is fully rendered before exiting
      const timer_0 = setTimeout((loginWithClaudeAi_0, onDone_0) => {
        logEvent('tengu_oauth_success', {
          loginWithClaudeAi: loginWithClaudeAi_0
        });
        // Don't clear terminal so the token remains visible
        onDone_0();
      }, 500, loginWithClaudeAi, onDone);
      return () => clearTimeout(timer_0);
    }
  }, [mode, oauthStatus, loginWithClaudeAi, onDone]);

  // Cleanup OAuth service when component unmounts
  useEffect(() => {
    return () => {
      oauthService.cleanup();
    };
  }, [oauthService]);
  return <Box flexDirection="column" gap={1}>
      {oauthStatus.state === 'waiting_for_login' && showPastePrompt && <Box flexDirection="column" key="urlToCopy" gap={1} paddingBottom={1}>
          <Box paddingX={1}>
            <Text dimColor>
              Browser didn&apos;t open? Use the url below to sign in{' '}
            </Text>
            {urlCopied ? <Text color="success">(Copied!)</Text> : <Text dimColor>
                <KeyboardShortcutHint shortcut="c" action="copy" parens />
              </Text>}
          </Box>
          <Link url={oauthStatus.url}>
            <Text dimColor>{oauthStatus.url}</Text>
          </Link>
        </Box>}
      {mode === 'setup-token' && oauthStatus.state === 'success' && oauthStatus.token && <Box key="tokenOutput" flexDirection="column" gap={1} paddingTop={1}>
            <Text color="success">
              ✓ Long-lived authentication token created successfully!
            </Text>
            <Box flexDirection="column" gap={1}>
              <Text>Your OAuth token (valid for 1 year):</Text>
              <Text color="warning">{oauthStatus.token}</Text>
              <Text dimColor>
                Store this token securely. You won&apos;t be able to see it
                again.
              </Text>
              <Text dimColor>
                Use this token by setting: export
                CLAUDE_CODE_OAUTH_TOKEN=&lt;token&gt;
              </Text>
            </Box>
          </Box>}
      <Box paddingLeft={1} flexDirection="column" gap={1}>
        <OAuthStatusMessage oauthStatus={oauthStatus} mode={mode} startingMessage={startingMessage} forcedMethodMessage={forcedMethodMessage} showPastePrompt={showPastePrompt} pastedCode={pastedCode} setPastedCode={setPastedCode} cursorOffset={cursorOffset} setCursorOffset={setCursorOffset} textInputColumns={textInputColumns} handleSubmitCode={handleSubmitCode} setOAuthStatus={setOAuthStatus} setLoginWithClaudeAi={setLoginWithClaudeAi} setLoginWithCodex={setLoginWithCodex} />
      </Box>
    </Box>;
}
type OAuthStatusMessageProps = {
  oauthStatus: OAuthStatus;
  mode: 'login' | 'setup-token';
  startingMessage: string | undefined;
  forcedMethodMessage: string | null;
  showPastePrompt: boolean;
  pastedCode: string;
  setPastedCode: (value: string) => void;
  cursorOffset: number;
  setCursorOffset: (offset: number) => void;
  textInputColumns: number;
  handleSubmitCode: (value: string, url: string) => void;
  setOAuthStatus: (status: OAuthStatus) => void;
  setLoginWithClaudeAi: (value: boolean) => void;
  setLoginWithCodex: (value: boolean) => void;
};
function OAuthStatusMessage(t0) {
  const $ = _c(52);
  const {
    oauthStatus,
    mode,
    startingMessage,
    forcedMethodMessage,
    showPastePrompt,
    pastedCode,
    setPastedCode,
    cursorOffset,
    setCursorOffset,
    textInputColumns,
    handleSubmitCode,
    setOAuthStatus,
    setLoginWithClaudeAi,
    setLoginWithCodex
  } = t0;
  switch (oauthStatus.state) {
    case "idle":
      {
        const t1 = startingMessage ? startingMessage : "Sign in with a Claude subscription or Anthropic Console account, an OpenAI Codex account, a local/self-hosted Ollama model, or a DeepSeek or Kimi API key.";
        let t2;
        if ($[0] !== t1) {
          t2 = <Text bold={true}>{t1}</Text>;
          $[0] = t1;
          $[1] = t2;
        } else {
          t2 = $[1];
        }
        let t3;
        if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
          t3 = <Text>Select login method:</Text>;
          $[2] = t3;
        } else {
          t3 = $[2];
        }
        let t4;
        if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
          t4 = {
            label: <Text>Claude account with subscription ·{" "}<Text dimColor={true}>Pro, Max, Team, or Enterprise</Text>{false && <Text>{"\n"}<Text color="warning">[ANT-ONLY]</Text>{" "}<Text dimColor={true}>Please use this option unless you need to login to a special org for accessing sensitive data (e.g. customer data, HIPI data) with the Console option</Text></Text>}{"\n"}</Text>,
            value: "claudeai"
          };
          $[3] = t4;
        } else {
          t4 = $[3];
        }
        let t5;
        if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
          t5 = {
            label: <Text>Anthropic Console account ·{" "}<Text dimColor={true}>API usage billing</Text>{"\n"}</Text>,
            value: "console"
          };
          $[4] = t5;
        } else {
          t5 = $[4];
        }
        let t6;
        if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
          // The third-party accounts come straight from the registry, so their
          // names here cannot drift from the ones /switch-account shows — they
          // already had. Anthropic is excluded because its two entries above
          // split the one descriptor into subscription and Console billing.
          t6 = [t4, t5, {
            label: <Text>3rd-party platform ·{" "}<Text dimColor={true}>Amazon Bedrock, Microsoft Foundry, or Vertex AI</Text>{"\n"}</Text>,
            value: "platform"
          }, ...ALL_PROVIDERS.filter(provider => provider.id !== ANTHROPIC_PROVIDER_ID).map(provider => ({
            label: <Text>{provider.label} ·{" "}<Text dimColor={true}>{provider.description}</Text>{"\n"}</Text>,
            value: provider.id
          }))];
          $[5] = t6;
        } else {
          t6 = $[5];
        }
        let t7;
        if ($[6] !== setLoginWithClaudeAi || $[7] !== setOAuthStatus || $[8] !== setLoginWithCodex) {
          t7 = <Box><Select options={t6} onChange={value_0 => {
              if (value_0 === "platform") {
                logEvent("tengu_oauth_platform_selected", {});
                setOAuthStatus({
                  state: "platform_setup"
                });
              } else if (value_0 === CODEX_PROVIDER_ID) {
                logEvent("tengu_oauth_codex_selected", {});
                setLoginWithCodex(true);
                setLoginWithClaudeAi(false);
                setOAuthStatus({ state: "ready_to_start" });
              } else if (value_0 === OLLAMA_PROVIDER_ID) {
                logEvent("tengu_oauth_ollama_selected", {});
                setLoginWithCodex(false);
                setLoginWithClaudeAi(false);
                // Ollama has no browser OAuth: the daemon is already signed in,
                // so the base URL and token are known and the model is the only
                // thing to record. Let the user pick it from the installed
                // models rather than driving the OAuth state machine.
                setOAuthStatus({ state: "ollama_model_select" });
              } else if (isAuthProviderId(value_0) && getProvider(value_0).apiKeyLogin) {
                // Every provider whose whole login is "paste a key" lands here,
                // so a new one needs no branch of its own. The event name is
                // built from the ID because logEvent's metadata takes no
                // strings; for the two providers that reach here it spells the
                // same names the hardcoded branches emitted.
                logEvent(`tengu_oauth_${value_0}_selected`, {});
                setLoginWithCodex(false);
                setLoginWithClaudeAi(false);
                setOAuthStatus({ state: "api_key", provider: value_0 });
              } else {
                setLoginWithCodex(false);
                setOAuthStatus({
                  state: "ready_to_start"
                });
                if (value_0 === "claudeai") {
                  logEvent("tengu_oauth_claudeai_selected", {});
                  setLoginWithClaudeAi(true);
                } else {
                  logEvent("tengu_oauth_console_selected", {});
                  setLoginWithClaudeAi(false);
                }
              }
            }} /></Box>;
          $[6] = setLoginWithClaudeAi;
          $[7] = setOAuthStatus;
          $[8] = setLoginWithCodex;
          $[9] = t7;
        } else {
          t7 = $[9];
        }
        let t8;
        if ($[10] !== t2 || $[11] !== t7) {
          t8 = <Box flexDirection="column" gap={1} marginTop={1}>{t2}{t3}{t7}</Box>;
          $[10] = t2;
          $[11] = t7;
          $[12] = t8;
        } else {
          t8 = $[12];
        }
        return t8;
      }
    case "ollama_model_select":
      return <OllamaModelSelect onSelect={model => {
        saveOllamaAuth({
          baseUrl: getOllamaBaseUrl(),
          authToken: getOllamaAuthToken(),
          model
        });
        logEvent("tengu_oauth_ollama_success", {});
        setOAuthStatus({ state: "success" });
      }} onError={message => {
        setOAuthStatus({ state: "error", message, toRetry: { state: "idle" } });
      }} />;
    case "platform_setup":
      {
        let t1;
        if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Text bold={true}>Using 3rd-party platforms</Text>;
          $[13] = t1;
        } else {
          t1 = $[13];
        }
        let t2;
        let t3;
        if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
          t2 = <Text>{`${PRODUCT_NAME} supports Amazon Bedrock, Microsoft Foundry, and Vertex AI. Set the required environment variables, then restart ${PRODUCT_NAME}.`}</Text>;
          t3 = <Text>If you are part of an enterprise organization, contact your administrator for setup instructions.</Text>;
          $[14] = t2;
          $[15] = t3;
        } else {
          t2 = $[14];
          t3 = $[15];
        }
        let t4;
        if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
          t4 = <Text bold={true}>Documentation:</Text>;
          $[16] = t4;
        } else {
          t4 = $[16];
        }
        let t5;
        if ($[17] === Symbol.for("react.memo_cache_sentinel")) {
          t5 = <Text>· Amazon Bedrock:{" "}<Link url="https://code.claude.com/docs/en/amazon-bedrock">https://code.claude.com/docs/en/amazon-bedrock</Link></Text>;
          $[17] = t5;
        } else {
          t5 = $[17];
        }
        let t6;
        if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
          t6 = <Text>· Microsoft Foundry:{" "}<Link url="https://code.claude.com/docs/en/microsoft-foundry">https://code.claude.com/docs/en/microsoft-foundry</Link></Text>;
          $[18] = t6;
        } else {
          t6 = $[18];
        }
        let t7;
        if ($[19] === Symbol.for("react.memo_cache_sentinel")) {
          t7 = <Box flexDirection="column" marginTop={1}>{t4}{t5}{t6}<Text>· Vertex AI:{" "}<Link url="https://code.claude.com/docs/en/google-vertex-ai">https://code.claude.com/docs/en/google-vertex-ai</Link></Text></Box>;
          $[19] = t7;
        } else {
          t7 = $[19];
        }
        let t8;
        if ($[20] === Symbol.for("react.memo_cache_sentinel")) {
          t8 = <Box flexDirection="column" gap={1} marginTop={1}>{t1}<Box flexDirection="column" gap={1}>{t2}{t3}{t7}<Box marginTop={1}><Text dimColor={true}>Press <Text bold={true}>Enter</Text> to go back to login options.</Text></Box></Box></Box>;
          $[20] = t8;
        } else {
          t8 = $[20];
        }
        return t8;
      }
    case "waiting_for_login":
      {
        let t1;
        if ($[21] !== forcedMethodMessage) {
          t1 = forcedMethodMessage && <Box><Text dimColor={true}>{forcedMethodMessage}</Text></Box>;
          $[21] = forcedMethodMessage;
          $[22] = t1;
        } else {
          t1 = $[22];
        }
        let t2;
        if ($[23] !== showPastePrompt) {
          t2 = !showPastePrompt && <Box><Spinner /><Text>Opening browser to sign in…</Text></Box>;
          $[23] = showPastePrompt;
          $[24] = t2;
        } else {
          t2 = $[24];
        }
        let t3;
        if ($[25] !== cursorOffset || $[26] !== handleSubmitCode || $[27] !== oauthStatus.url || $[28] !== pastedCode || $[29] !== setCursorOffset || $[30] !== setPastedCode || $[31] !== showPastePrompt || $[32] !== textInputColumns) {
          t3 = showPastePrompt && <Box><Text>{PASTE_HERE_MSG}</Text><TextInput value={pastedCode} onChange={setPastedCode} onSubmit={value => handleSubmitCode(value, oauthStatus.url)} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} columns={textInputColumns} mask="*" /></Box>;
          $[25] = cursorOffset;
          $[26] = handleSubmitCode;
          $[27] = oauthStatus.url;
          $[28] = pastedCode;
          $[29] = setCursorOffset;
          $[30] = setPastedCode;
          $[31] = showPastePrompt;
          $[32] = textInputColumns;
          $[33] = t3;
        } else {
          t3 = $[33];
        }
        let t4;
        if ($[34] !== t1 || $[35] !== t2 || $[36] !== t3) {
          t4 = <Box flexDirection="column" gap={1}>{t1}{t2}{t3}</Box>;
          $[34] = t1;
          $[35] = t2;
          $[36] = t3;
          $[37] = t4;
        } else {
          t4 = $[37];
        }
        return t4;
      }
    case "creating_api_key":
      {
        let t1;
        if ($[38] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Box flexDirection="column" gap={1}><Box><Spinner /><Text>{`Creating API key for ${PRODUCT_NAME}…`}</Text></Box></Box>;
          $[38] = t1;
        } else {
          t1 = $[38];
        }
        return t1;
      }
    case "about_to_retry":
      {
        let t1;
        if ($[39] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Box flexDirection="column" gap={1}><Text color="permission">Retrying…</Text></Box>;
          $[39] = t1;
        } else {
          t1 = $[39];
        }
        return t1;
      }
    case "success":
      {
        let t1;
        if ($[40] !== mode || $[41] !== oauthStatus.token) {
          t1 = mode === "setup-token" && oauthStatus.token ? null : <>{getOauthAccountInfo()?.emailAddress ? <Text dimColor={true}>Logged in as{" "}<Text>{getOauthAccountInfo()?.emailAddress}</Text></Text> : null}<Text color="success">Login successful. Press <Text bold={true}>Enter</Text> to continue…</Text></>;
          $[40] = mode;
          $[41] = oauthStatus.token;
          $[42] = t1;
        } else {
          t1 = $[42];
        }
        let t2;
        if ($[43] !== t1) {
          t2 = <Box flexDirection="column">{t1}</Box>;
          $[43] = t1;
          $[44] = t2;
        } else {
          t2 = $[44];
        }
        return t2;
      }
    case "error":
      {
        let t1;
        if ($[45] !== oauthStatus.message) {
          t1 = <Text color="error">OAuth error: {oauthStatus.message}</Text>;
          $[45] = oauthStatus.message;
          $[46] = t1;
        } else {
          t1 = $[46];
        }
        let t2;
        if ($[47] !== oauthStatus.toRetry) {
          t2 = oauthStatus.toRetry && <Box marginTop={1}><Text color="permission">Press <Text bold={true}>Enter</Text> to retry.</Text></Box>;
          $[47] = oauthStatus.toRetry;
          $[48] = t2;
        } else {
          t2 = $[48];
        }
        let t3;
        if ($[49] !== t1 || $[50] !== t2) {
          t3 = <Box flexDirection="column" gap={1}>{t1}{t2}</Box>;
          $[49] = t1;
          $[50] = t2;
          $[51] = t3;
        } else {
          t3 = $[51];
        }
        return t3;
      }
    case "api_key":
      {
        // One prompt for every key-based provider: the strings, the validation
        // and the place the key is written all come from the descriptor, so the
        // DeepSeek and Kimi copies of this block — identical but for four
        // strings and one setter — are gone, and a third such provider adds no
        // code here.
        const provider = oauthStatus.provider;
        const login = getProvider(provider).apiKeyLogin;
        if (!login) {
          return null;
        }
        return <Box flexDirection="column" gap={1}>
          <Text bold={true}>{login.prompt}</Text>
          <Text dimColor={true}>{login.hint}</Text>
          <TextInput value={pastedCode} onChange={setPastedCode} onSubmit={value => {
            const trimmed = value.trim();
            if (!trimmed) return;
            if (!API_KEY_PATTERN.test(trimmed)) {
              setOAuthStatus({
                state: "error",
                message: login.invalidMessage,
                toRetry: {
                  state: "api_key",
                  provider
                }
              });
              return;
            }
            // One write, so the key and the active provider cannot disagree —
            // the guarantee the per-provider save helpers used to give. The
            // descriptor writes only its own credential; which account that
            // makes active is the picker's business, not the descriptor's.
            saveGlobalConfig(config => ({
              ...login.storeCredentials(config, trimmed),
              activeAuthProvider: provider
            }));
            setPastedCode('');
            logEvent(`tengu_oauth_${provider}_success`, {});
            setOAuthStatus({
              state: "success"
            });
          }} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} columns={textInputColumns} mask="*" />
        </Box>;
      }
    default:
      {
        return null;
      }
  }
}
