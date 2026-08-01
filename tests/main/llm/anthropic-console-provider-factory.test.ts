/**
 * The Console key rides in the ordinary Anthropic slot, tagged (`parseAnthropicKey`).
 * That single format decision is what keeps the feature out of the provider
 * factory, settings, and validation — so this pins the format contract, and
 * that BOTH construction paths (`getProvider` for conversations,
 * `createProviderForKey` for the settings connection check) inherit it without
 * knowing the tag exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getSettings: vi.fn(),
  providerConstructor: vi.fn(),
}));

vi.mock('../../../src/main/llm/settings', () => ({ getSettings: h.getSettings }));
vi.mock('../../../src/main/llm/provider/anthropic', () => ({
  AnthropicProvider: class MockAnthropicProvider {
    readonly id = 'anthropic';
    constructor(apiKey: string) {
      h.providerConstructor(apiKey);
    }
  },
}));

import { getProvider, createProviderForKey } from '../../../src/main/llm/provider';
import {
  parseAnthropicKey,
  tagConsoleKey,
} from '../../../src/main/llm/anthropic-console/request-middleware';

beforeEach(() => {
  h.providerConstructor.mockReset();
  h.getSettings.mockReset().mockResolvedValue({
    providers: { anthropic: { apiKey: tagConsoleKey('console-generated-key') } },
    model: 'claude-sonnet-4-6',
    web: { enabled: false, allowedDomains: [], blockedDomains: [] },
  });
});

describe('Console key format', () => {
  it('round-trips a tagged key and leaves an ordinary key untouched', () => {
    expect(parseAnthropicKey(tagConsoleKey('sk-ant-generated')))
      .toEqual({ apiKey: 'sk-ant-generated', isConsole: true });
    expect(parseAnthropicKey('sk-ant-typed-by-hand'))
      .toEqual({ apiKey: 'sk-ant-typed-by-hand', isConsole: false });
  });

  it('does not mistake an ordinary key that merely contains the marker', () => {
    // Only a prefix counts — a key with "pkce:" elsewhere is an ordinary key.
    expect(parseAnthropicKey('sk-ant-pkce:not-a-tag').isConsole).toBe(false);
  });
});

describe('provider construction', () => {
  it('passes the stored key through verbatim on the conversation path', async () => {
    // The factory stays ignorant of the tag: no branch, no separate credential
    // read. Stripping happens inside AnthropicProvider.
    await getProvider();
    expect(h.providerConstructor).toHaveBeenCalledWith(tagConsoleKey('console-generated-key'));
  });

  it('passes it through verbatim on the connection-check path too', () => {
    createProviderForKey('anthropic', tagConsoleKey('console-generated-key'));
    expect(h.providerConstructor).toHaveBeenCalledWith(tagConsoleKey('console-generated-key'));
  });

  it('still routes a non-Anthropic model away from the Anthropic provider', async () => {
    h.getSettings.mockResolvedValue({
      providers: { openai: { apiKey: 'openai-key' } },
      model: 'claude-sonnet-4-6',
      web: { enabled: false, allowedDomains: [], blockedDomains: [] },
    });
    const resolved = await getProvider('gpt-5');
    expect(resolved.provider.id).toBe('openai');
    expect(h.providerConstructor).not.toHaveBeenCalled();
  });
});
