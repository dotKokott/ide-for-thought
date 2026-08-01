export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Marks an Anthropic key minted by the Console PKCE login rather than typed by
 * the user. The tag travels *with* the key through the ordinary provider slot —
 * one credential store, one settings row, one clear button — so the request
 * policy below can never desync from the key it applies to. A hand-typed key
 * has no prefix and is therefore untouched.
 */
const CONSOLE_KEY_PREFIX = 'pkce:';

/** Tag a freshly minted Console key for storage in the ordinary key slot. */
export function tagConsoleKey(rawKey: string): string {
  return `${CONSOLE_KEY_PREFIX}${rawKey}`;
}

/**
 * Split a stored Anthropic key into the wire credential and whether Console
 * request rules apply. Called at the single point where the SDK client is
 * constructed, so no caller has to know the tag exists.
 */
export function parseAnthropicKey(stored: string): { apiKey: string; isConsole: boolean } {
  return stored.startsWith(CONSOLE_KEY_PREFIX)
    ? { apiKey: stored.slice(CONSOLE_KEY_PREFIX.length), isConsole: true }
    : { apiKey: stored, isConsole: false };
}
const MINERVA_CONTEXT_MARKER = '\x00minerva-system-context\x00';

export interface AnthropicConsoleTextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

export interface AnthropicConsoleContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicConsoleMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicConsoleContentBlock[];
  [key: string]: unknown;
}

/** SDK-neutral structural subset of a canonical Anthropic messages request. */
export interface AnthropicConsoleRequestBody {
  system?: string | AnthropicConsoleTextBlock[];
  messages: AnthropicConsoleMessage[];
  [key: string]: unknown;
}

function systemText(system: AnthropicConsoleRequestBody['system']): string {
  if (typeof system === 'string') return system.trim();
  if (!system) return '';
  return system
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function claudeCodeSystem(
  original: AnthropicConsoleRequestBody['system'],
): string | AnthropicConsoleTextBlock[] {
  if (!Array.isArray(original)) return CLAUDE_CODE_SYSTEM_PROMPT;
  const cacheControl = original.find((block) => block.type === 'text')?.cache_control;
  return [{
    type: 'text',
    text: CLAUDE_CODE_SYSTEM_PROMPT,
    ...(cacheControl !== undefined ? { cache_control: cacheControl } : {}),
  }];
}

function injectSystemIntoFirstUserMessage(
  messages: AnthropicConsoleMessage[],
  originalSystem: string,
): AnthropicConsoleMessage[] {
  const prefix = `${MINERVA_CONTEXT_MARKER}${originalSystem}${MINERVA_CONTEXT_MARKER}\n\n`;
  let injected = false;
  const rewritten = messages.map((message): AnthropicConsoleMessage => {
    if (injected || message.role !== 'user') return message;

    if (typeof message.content === 'string') {
      injected = true;
      return { ...message, content: prefix + message.content };
    }

    const firstTextIndex = message.content.findIndex((block) => block.type === 'text');
    if (firstTextIndex < 0) {
      injected = true;
      return {
        ...message,
        content: [{ type: 'text', text: prefix.trimEnd() }, ...message.content],
      };
    }

    const firstText = message.content[firstTextIndex];
    if (!firstText || firstText.type !== 'text' || typeof firstText.text !== 'string') {
      return message;
    }
    const firstTextValue = firstText.text;
    injected = true;
    return {
      ...message,
      content: message.content.map((block, index) =>
        index === firstTextIndex
          ? { ...block, text: prefix + firstTextValue }
          : block),
    };
  });

  if (!injected) {
    rewritten.unshift({ role: 'user', content: prefix.trimEnd() });
  }
  return rewritten;
}

/**
 * Console-minted Claude CLI keys reject any system text beyond the exact
 * Claude Code identity. Carry Minerva's real instructions in the first user
 * message instead. The provider installs this policy only for Console keys.
 */
export function prepareAnthropicConsoleRequest(
  body: AnthropicConsoleRequestBody,
): AnthropicConsoleRequestBody {
  const originalSystem = systemText(body.system);
  if (!originalSystem || originalSystem === CLAUDE_CODE_SYSTEM_PROMPT) {
    return { ...body, system: claudeCodeSystem(body.system) };
  }
  return {
    ...body,
    system: claudeCodeSystem(body.system),
    messages: injectSystemIntoFirstUserMessage(body.messages, originalSystem),
  };
}

export function isAnthropicConsoleRequestBody(
  value: unknown,
): value is AnthropicConsoleRequestBody {
  if (!value || typeof value !== 'object') return false;
  return Array.isArray((value as { messages?: unknown }).messages);
}
