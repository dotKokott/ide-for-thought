/**
 * Anthropic Console PKCE login (experimental).
 *
 * Mints a persistent Claude CLI API key through Console's OAuth flow and hands
 * it back tagged — it is then stored, cleared and used exactly like a typed
 * Anthropic key, in the ordinary provider slot. This module owns only the
 * handshake; it persists nothing of its own. The key-generation endpoint is
 * undocumented and may change without notice.
 */
import { createHash, randomBytes } from 'node:crypto';
import { tagConsoleKey } from './request-middleware';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://console.anthropic.com/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const CREATE_API_KEY_URL = 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key';
const SCOPES = 'org:create_api_key user:profile user:inference';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_REMOTE_ERROR_LENGTH = 500;

interface PendingLogin {
  verifier: string;
  state: string;
  expiresAt: number;
  completing: boolean;
}

interface OAuthTokens {
  access_token: string;
}

let pendingLogin: PendingLogin | undefined;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function redactRemoteError(raw: string): string {
  const redacted = raw
    .replace(
      /("(?:access_token|refresh_token|raw_key|authorization_code)"\s*:\s*")[^"]*(")/gi,
      '$1[redacted]$2',
    )
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  return redacted.length > MAX_REMOTE_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_REMOTE_ERROR_LENGTH)}…`
    : redacted;
}

export function parseAnthropicConsoleCallback(raw: string): { code?: string; state?: string } {
  const value = raw.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    return {
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
    };
  } catch {
    // The Console commonly shows a `code#state` value rather than a URL.
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return {
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
    };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    const code = params.get('code');
    const state = params.get('state');
    return {
      ...(code ? { code } : {}),
      ...(state ? { state } : {}),
    };
  }
  return { code: value };
}

async function postJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic Console request failed (${response.status}): ${redactRemoteError(responseText)}`,
    );
  }
  try {
    return JSON.parse(responseText) as T;
  } catch {
    throw new Error('Anthropic Console returned an invalid response.');
  }
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
): Promise<OAuthTokens> {
  return postJson<OAuthTokens>(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

async function createApiKey(accessToken: string): Promise<string> {
  const response = await fetch(CREATE_API_KEY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic API-key creation failed (${response.status}): ${redactRemoteError(responseText)}`,
    );
  }
  try {
    const parsed = JSON.parse(responseText) as { raw_key?: unknown };
    if (typeof parsed.raw_key !== 'string' || !parsed.raw_key) {
      throw new Error('missing raw_key');
    }
    return parsed.raw_key;
  } catch {
    throw new Error('Anthropic returned an invalid API-key response.');
  }
}

/** Start a main-owned PKCE flow. The caller opens the returned URL from main. */
export function beginAnthropicConsoleOAuth(): { url: string } {
  const { verifier, challenge } = generatePkce();
  const state = base64Url(randomBytes(32));
  pendingLogin = {
    verifier,
    state,
    expiresAt: Date.now() + LOGIN_TTL_MS,
    completing: false,
  };

  const params = new URLSearchParams({
    code: 'true',
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}` };
}

/**
 * Exchange the pasted callback for a freshly minted key, tagged for the
 * ordinary Anthropic key slot. The caller saves it through the normal settings
 * path — nothing is persisted here.
 */
export async function completeAnthropicConsoleOAuth(callbackInput: string): Promise<string> {
  const pending = pendingLogin;
  if (!pending || pending.expiresAt <= Date.now()) {
    pendingLogin = undefined;
    throw new Error('Anthropic Console login expired. Start a new login and try again.');
  }
  if (pending.completing) {
    throw new Error('Anthropic Console login is already being completed.');
  }

  const parsed = parseAnthropicConsoleCallback(callbackInput);
  if (!parsed.code) throw new Error('Missing Anthropic authorization code.');
  if (parsed.state && parsed.state !== pending.state) {
    throw new Error('Anthropic OAuth state mismatch. Start a new login and try again.');
  }

  // Authorization codes are single-use. Once exchange starts, require a fresh
  // login after any network/token/key-creation failure rather than retrying the
  // consumed code. Validation failures above deliberately retain the login.
  pending.completing = true;
  pendingLogin = undefined;
  const tokens = await exchangeCode(parsed.code, parsed.state ?? pending.state, pending.verifier);
  if (!tokens.access_token) throw new Error('Anthropic token exchange returned no access token.');
  return tagConsoleKey(await createApiKey(tokens.access_token));
}

/** Test-only reset for the module-local, ephemeral PKCE state. */
export function resetAnthropicConsoleOAuthForTest(): void {
  pendingLogin = undefined;
}
