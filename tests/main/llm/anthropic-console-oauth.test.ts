/**
 * Anthropic Console PKCE login. The module persists nothing — it hands back a
 * tagged key that the caller saves through the ordinary provider path — so
 * these cover the handshake: PKCE/state separation, single-use code handling,
 * callback parsing, and error redaction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginAnthropicConsoleOAuth,
  completeAnthropicConsoleOAuth,
  parseAnthropicConsoleCallback,
  resetAnthropicConsoleOAuthForTest,
} from '../../../src/main/llm/anthropic-console/oauth';
import { parseAnthropicKey } from '../../../src/main/llm/anthropic-console/request-middleware';

beforeEach(() => {
  resetAnthropicConsoleOAuthForTest();
  vi.restoreAllMocks();
});

describe('Anthropic Console OAuth', () => {
  it('parses the supported Console callback formats', () => {
    expect(parseAnthropicConsoleCallback('code-1#state-1')).toEqual({ code: 'code-1', state: 'state-1' });
    expect(parseAnthropicConsoleCallback('https://example.test/cb?code=code-2&state=state-2'))
      .toEqual({ code: 'code-2', state: 'state-2' });
    expect(parseAnthropicConsoleCallback('code-3')).toEqual({ code: 'code-3' });
  });

  it('uses separate OAuth state and PKCE verifier, and returns the key tagged for the ordinary slot', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'temporary-access',
        refresh_token: 'temporary-refresh',
        expires_in: 3600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ raw_key: 'sk-ant-api03-generated' }), { status: 200 }));

    const { url } = beginAnthropicConsoleOAuth();
    const state = new URL(url).searchParams.get('state');
    expect(state).toBeTruthy();

    const key = await completeAnthropicConsoleOAuth(`authorization-code#${state}`);

    const tokenBody = (fetchMock.mock.calls[0]![1] as RequestInit).body;
    if (typeof tokenBody !== 'string') throw new Error('expected JSON request body');
    const tokenRequest = JSON.parse(tokenBody);
    expect(tokenRequest).toMatchObject({ code: 'authorization-code', state });
    expect(tokenRequest.code_verifier).toEqual(expect.any(String));
    expect(tokenRequest.code_verifier).not.toBe(state);

    const keyRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(keyRequest.headers).toMatchObject({ Authorization: 'Bearer temporary-access' });

    // Tagged on the way out, and the tag round-trips back to the raw key —
    // that pairing is the whole integration contract with the provider.
    expect(key).not.toBe('sk-ant-api03-generated');
    expect(parseAnthropicKey(key)).toEqual({ apiKey: 'sk-ant-api03-generated', isConsole: true });
    // The short-lived OAuth tokens are never part of what the caller stores.
    expect(key).not.toContain('temporary-access');
    expect(key).not.toContain('temporary-refresh');
  });

  it('retains pending login after pre-exchange validation failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const state = new URL(beginAnthropicConsoleOAuth().url).searchParams.get('state');

    await expect(completeAnthropicConsoleOAuth('   ')).rejects.toThrow(/missing.*authorization code/i);
    await expect(completeAnthropicConsoleOAuth('code#wrong-state')).rejects.toThrow(/state mismatch/i);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ raw_key: 'sk-ant-api03-generated' }), { status: 200 }));
    await expect(completeAnthropicConsoleOAuth(`code#${state}`)).resolves.toContain('sk-ant-api03-generated');
  });

  it('consumes the pending login once code exchange starts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const state = new URL(beginAnthropicConsoleOAuth().url).searchParams.get('state');

    await expect(completeAnthropicConsoleOAuth(`code#${state}`)).rejects.toThrow(/invalid response/i);
    await expect(completeAnthropicConsoleOAuth(`code#${state}`)).rejects.toThrow(/expired/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates an older begin and consumes a successful login', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ raw_key: 'sk-ant-api03-generated' }), { status: 200 }));

    const firstState = new URL(beginAnthropicConsoleOAuth().url).searchParams.get('state');
    const secondState = new URL(beginAnthropicConsoleOAuth().url).searchParams.get('state');
    await expect(completeAnthropicConsoleOAuth(`code#${firstState}`)).rejects.toThrow(/state mismatch/i);
    expect(fetchMock).not.toHaveBeenCalled();

    await completeAnthropicConsoleOAuth(`code#${secondState}`);
    await expect(completeAnthropicConsoleOAuth(`code#${secondState}`)).rejects.toThrow(/expired/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts and bounds remote error bodies', async () => {
    const secret = 'sk-ant-api03-super-secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ access_token: 'token-secret', raw_key: secret, detail: 'x'.repeat(900) }),
      { status: 401 },
    ));
    const state = new URL(beginAnthropicConsoleOAuth().url).searchParams.get('state');

    const error = await completeAnthropicConsoleOAuth(`code#${state}`).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain('token-secret');
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThan(650);
  });
});
