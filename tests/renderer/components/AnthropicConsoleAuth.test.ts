/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

const h = vi.hoisted(() => ({
  consoleLoginBegin: vi.fn(),
  consoleLoginComplete: vi.fn(),
}));

vi.mock('../../../src/renderer/lib/ipc/client', () => ({
  api: {
    tools: {
      consoleLoginBegin: h.consoleLoginBegin,
      consoleLoginComplete: h.consoleLoginComplete,
    },
  },
}));

import AnthropicConsoleAuth from '../../../src/renderer/lib/components/AnthropicConsoleAuth.svelte';

function mount() {
  const onGenerated = vi.fn();
  return { ...render(AnthropicConsoleAuth, { onGenerated }), onGenerated };
}

beforeEach(() => {
  h.consoleLoginBegin.mockReset().mockResolvedValue(undefined);
  h.consoleLoginComplete.mockReset().mockResolvedValue('pkce:sk-ant-generated');
});

afterEach(() => cleanup());

describe('AnthropicConsoleAuth', () => {
  it('hands the minted key to the parent rather than saving it', async () => {
    const { getByText, getByLabelText, onGenerated } = mount();

    await fireEvent.click(getByText('Generate via Console login'));
    expect(h.consoleLoginBegin).toHaveBeenCalledOnce();

    await fireEvent.input(getByLabelText('Authorization code'), {
      target: { value: ' code#state ' },
    });
    await fireEvent.click(getByText('Generate key'));

    expect(h.consoleLoginComplete).toHaveBeenCalledWith('code#state');
    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith('pkce:sk-ant-generated'));
  });

  it('collapses back to the button once the key is handed over', async () => {
    const { getByText, getByLabelText, queryByLabelText } = mount();
    await fireEvent.click(getByText('Generate via Console login'));
    await fireEvent.input(getByLabelText('Authorization code'), { target: { value: 'code#state' } });
    await fireEvent.click(getByText('Generate key'));
    await waitFor(() => expect(queryByLabelText('Authorization code')).toBeNull());
    expect(getByText('Generate via Console login')).toBeTruthy();
  });

  it('surfaces a failed exchange and keeps the pasted code for a retry', async () => {
    h.consoleLoginComplete.mockRejectedValue(new Error('Anthropic OAuth state mismatch.'));
    const { getByText, getByLabelText, onGenerated } = mount();

    await fireEvent.click(getByText('Generate via Console login'));
    const input = getByLabelText('Authorization code') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'code#state' } });
    await fireEvent.click(getByText('Generate key'));

    await waitFor(() => expect(getByText('Anthropic OAuth state mismatch.')).toBeTruthy());
    expect(onGenerated).not.toHaveBeenCalled();
    expect(input.value).toBe('code#state');
  });

  it('does not open the browser twice while a login is in flight', async () => {
    let release: (() => void) | undefined;
    h.consoleLoginBegin.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const { getByText } = mount();

    const button = getByText(/Generate via Console login|Opening…/);
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(h.consoleLoginBegin).toHaveBeenCalledOnce();
    release?.();
  });

  it('labels the flow as experimental and explains the system-prompt change', () => {
    const { getByText } = mount();
    expect(getByText('Experimental')).toBeTruthy();
    expect(getByText(/Claude Code's system prompt/)).toBeTruthy();
  });
});
