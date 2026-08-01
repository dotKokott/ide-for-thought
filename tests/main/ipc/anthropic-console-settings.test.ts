/**
 * The two Console-login handlers. They deliberately do NOT persist: the minted
 * key goes back to the settings dialog as an unsaved candidate and is saved by
 * the ordinary `tool:setSettings` path, so the whole feature adds no write path
 * of its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '../../../src/shared/channels';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(),
  getSettingsForDisplay: vi.fn(),
  saveSettings: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('electron', () => ({ shell: { openExternal: h.openExternal } }));
vi.mock('../../../src/main/ipc/typed-ipc', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    h.handlers.set(channel, handler);
  },
}));
vi.mock('../../../src/main/menu', () => ({ rebuildMenu: vi.fn() }));
vi.mock('../../../src/main/tools/executor', () => ({
  executeTool: vi.fn(),
  prepareConversationTool: vi.fn(),
}));
vi.mock('../../../src/main/skills/loader', () => ({ getSkillCatalog: vi.fn() }));
vi.mock('../../../src/main/skills/register', () => ({
  reloadAndRegisterSkills: vi.fn(),
  reapplyMenuConfig: vi.fn(),
}));
vi.mock('../../../src/main/skills/manage', () => ({
  pickAndImportSkill: vi.fn(),
  removeUserSkill: vi.fn(),
  revealSkillsFolder: vi.fn(),
}));
vi.mock('../../../src/main/skills/menu-config-store', () => ({
  getMenuConfig: vi.fn(),
  saveMenuConfig: vi.fn(),
}));
vi.mock('../../../src/main/llm/settings', () => ({
  getSettingsForDisplay: h.getSettingsForDisplay,
  saveSettings: h.saveSettings,
  getApiKeyStorage: vi.fn(),
}));
vi.mock('../../../src/main/llm/validate', () => ({ checkConnection: vi.fn() }));
vi.mock('../../../src/main/llm/anthropic-console/oauth', () => ({
  beginAnthropicConsoleOAuth: h.begin,
  completeAnthropicConsoleOAuth: h.complete,
}));
vi.mock('../../../src/main/ipc/helpers', () => ({ winFromEvent: vi.fn() }));

import { registerTools } from '../../../src/main/ipc/register-tools';

registerTools();

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = h.handlers.get(channel);
  if (!registered) throw new Error(`missing handler ${channel}`);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingsForDisplay.mockResolvedValue({
    model: 'claude-sonnet-4-6',
    hasApiKey: false,
    providers: {},
  });
  h.begin.mockReturnValue({ url: 'https://console.anthropic.test/authorize' });
  h.complete.mockResolvedValue('pkce:sk-ant-generated');
});

describe('Anthropic Console login handlers', () => {
  it('opens the consent page from main', async () => {
    await handler(Channels.TOOL_CONSOLE_LOGIN_BEGIN)({});
    expect(h.openExternal).toHaveBeenCalledWith('https://console.anthropic.test/authorize');
  });

  it('returns the minted key to the caller instead of persisting it', async () => {
    const key = await handler(Channels.TOOL_CONSOLE_LOGIN_COMPLETE)({}, 'code#state');
    expect(h.complete).toHaveBeenCalledWith('code#state');
    expect(key).toBe('pkce:sk-ant-generated');
    // No write path of its own — saving is the ordinary settings mutation.
    expect(h.saveSettings).not.toHaveBeenCalled();
  });

  it('leaves the settings read and write handlers untouched', async () => {
    await expect(handler(Channels.TOOL_GET_SETTINGS)({})).resolves.toEqual({
      model: 'claude-sonnet-4-6',
      hasApiKey: false,
      providers: {},
    });

    const update = { model: 'claude-opus-5' };
    await handler(Channels.TOOL_SET_SETTINGS)({}, update);
    expect(h.saveSettings).toHaveBeenCalledWith(update);
  });
});
