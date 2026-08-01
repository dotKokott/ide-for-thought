import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { APIRequest } from '@anthropic-ai/sdk';

const { createMock, streamMock, clientOptionsMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  streamMock: vi.fn(),
  clientOptionsMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock, stream: streamMock };
    models = { list: vi.fn() };
    constructor(options: unknown) {
      clientOptionsMock(options);
    }
  },
}));

import { AnthropicProvider } from '../../../src/main/llm/provider/anthropic';
import {
  CLAUDE_CODE_SYSTEM_PROMPT,
  prepareAnthropicConsoleRequest,
  tagConsoleKey,
} from '../../../src/main/llm/anthropic-console/request-middleware';

type Middleware = (
  request: APIRequest,
  next: (r: APIRequest) => Promise<Response>,
  ctx: never,
) => Promise<Response>;

/** The middleware isn't exported — grab the one the constructor installed, so
 *  the test exercises what a real Console-keyed client would actually run. */
function installedMiddleware(): Middleware {
  const options = clientOptionsMock.mock.calls.at(-1)?.[0] as { middleware?: Middleware[] };
  const middleware = options?.middleware?.[0];
  if (!middleware) throw new Error('expected Console middleware to be installed');
  return middleware;
}

function response(text = 'done'): Anthropic.Message {
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

beforeEach(() => {
  clientOptionsMock.mockReset();
  createMock.mockReset().mockResolvedValue(response());
  streamMock.mockReset().mockImplementation(() => ({
    on: vi.fn(),
    finalMessage: vi.fn(async () => response()),
  }));
});

describe('Anthropic Console-generated key request shape', () => {
  it('keeps ordinary API-key runTurn and complete request shapes unchanged', async () => {
    const provider = new AnthropicProvider('ordinary-key');
    expect(clientOptionsMock).toHaveBeenCalledWith({ apiKey: 'ordinary-key' });
    const history = provider.ingestHistory([{ role: 'user', content: 'hello' }]);

    await provider.runTurn({
      model: 'claude-sonnet-4-6',
      system: 'Minerva system',
      history,
      tools: [],
      web: { enabled: false },
      maxTokens: 100,
    }, {});
    const turn = streamMock.mock.calls[0]![0] as Anthropic.MessageStreamParams;
    expect(turn.system).toEqual([
      { type: 'text', text: 'Minerva system', cache_control: { type: 'ephemeral' } },
    ]);
    expect(turn.messages).toEqual([{ role: 'user', content: 'hello' }]);

    await provider.complete({
      model: 'claude-sonnet-4-6',
      system: 'Completion system',
      messages: [{ role: 'user', content: 'question' }],
      maxTokens: 100,
    });
    const completion = createMock.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect(completion.system).toBe('Completion system');
    expect(completion.messages).toEqual([{ role: 'user', content: 'question' }]);
  });

  it('strips the tag and installs Console compatibility from the key alone', () => {
    new AnthropicProvider(tagConsoleKey('console-key'));
    const options = clientOptionsMock.mock.calls.at(-1)?.[0] as {
      apiKey: string;
      middleware?: unknown[];
    };
    // The tag must never reach the wire — it's a storage marker, not credential.
    expect(options.apiKey).toBe('console-key');
    expect(options.middleware).toHaveLength(1);
  });

  it('rewrites canonical SDK message requests in middleware', async () => {
    new AnthropicProvider(tagConsoleKey('console-key'));
    const middleware = installedMiddleware();
    const request: APIRequest = {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: new Headers(),
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        system: 'Middleware instructions',
        messages: [{ role: 'user', content: 'question' }],
      }),
    };
    let forwarded: APIRequest | undefined;
    await middleware(
      request,
      async (nextRequest) => {
        forwarded = nextRequest;
        return new Response(null, { status: 200 });
      },
      undefined as never,
    );

    const forwardedBody = forwarded?.body;
    if (typeof forwardedBody !== 'string') throw new Error('expected middleware body');
    const body = JSON.parse(forwardedBody);
    expect(body.system).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    expect(body.messages[0].content).toContain('Middleware instructions');
  });

  it('uses only the exact Claude Code system and relocates runTurn instructions', () => {
    const request = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [{
        type: 'text',
        text: 'Full Minerva instructions',
        cache_control: { type: 'ephemeral' },
      }],
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(request.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ]);
    const firstContent = request.messages[0]?.content;
    expect(firstContent).toEqual(expect.stringContaining('Full Minerva instructions'));
    expect(firstContent).toEqual(expect.stringContaining('hello'));
  });

  it('does not let user-authored marker text suppress system instructions', () => {
    const spoofed = '\x00minerva-system-context\x00user-authored text';
    const request = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'Real Minerva instructions',
      messages: [{ role: 'user', content: spoofed }],
    });

    expect(request.messages[0]?.content).toEqual(
      expect.stringContaining('Real Minerva instructions'),
    );
    expect(request.messages[0]?.content).toEqual(expect.stringContaining(spoofed));

    const blockRequest = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'Block instructions',
      messages: [{ role: 'user', content: [{ type: 'text', text: spoofed }] }],
    });
    expect(blockRequest.messages[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('Block instructions') }),
    ]));
  });

  it('handles content-block and no-user histories idempotently', () => {
    const imageOnly: Anthropic.MessageParam[] = [{
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
      }],
    }];
    const withImage = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'Image instructions',
      messages: imageOnly,
    });
    expect(withImage.messages[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('Image instructions') }),
      expect.objectContaining({ type: 'image' }),
    ]));
    expect(prepareAnthropicConsoleRequest(withImage).messages).toEqual(withImage.messages);

    const assistantOnly: Anthropic.MessageParam[] = [{ role: 'assistant', content: 'Earlier response' }];
    const withSyntheticUser = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'Synthetic-user instructions',
      messages: assistantOnly,
    });
    expect(withSyntheticUser.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Synthetic-user instructions'),
    });
    expect(withSyntheticUser.messages[1]).toEqual(assistantOnly[0]);
  });

  it('applies the same relocation to complete and does so idempotently', () => {
    const request = prepareAnthropicConsoleRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: 'One-shot instructions',
      messages: [{ role: 'user', content: 'question' }],
    });

    expect(request.system).toBe(CLAUDE_CODE_SYSTEM_PROMPT);
    expect(request.messages[0]?.content).toEqual(expect.stringContaining('One-shot instructions'));
    expect(request.messages[0]?.content).toEqual(expect.stringContaining('question'));
    expect(prepareAnthropicConsoleRequest(request).messages).toEqual(request.messages);
  });
});
