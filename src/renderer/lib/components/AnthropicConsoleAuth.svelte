<script lang="ts">
  /**
   * Anthropic Console login (experimental) — a generate button for the ordinary
   * Anthropic key field it sits under.
   *
   * The minted key is handed to the parent as an unsaved candidate key, so it
   * applies on Done, Cancel discards it, and clearing it is the existing "Clear
   * saved key". Nothing here persists anything. Both calls are reads/OS
   * side-effects from the renderer's point of view: main owns the PKCE state.
   */
  import { api } from '../ipc/client';

  interface Props {
    /** Hand the minted key to the parent's unsaved-key input. */
    onGenerated: (apiKey: string) => void;
  }

  let { onGenerated }: Props = $props();

  let authorizing = $state(false);
  let callbackInput = $state('');
  let busy = $state(false);
  let error = $state('');

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  const begin = () => run(async () => {
    await api.tools.consoleLoginBegin();
    authorizing = true;
    callbackInput = '';
  });

  const complete = () => run(async () => {
    const value = callbackInput.trim();
    if (!value) return;
    onGenerated(await api.tools.consoleLoginComplete(value));
    authorizing = false;
    callbackInput = '';
  });

  function cancel(): void {
    authorizing = false;
    callbackInput = '';
    error = '';
  }
</script>

<div class="console-login">
  {#if authorizing}
    <label for="console-login-code">Authorization code</label>
    <input
      id="console-login-code"
      type="text"
      bind:value={callbackInput}
      placeholder="Paste code#state or the full callback URL"
      autocomplete="off"
      spellcheck="false"
      autocapitalize="off"
      disabled={busy}
    />
    <div class="actions">
      <button class="btn-generate" onclick={complete} disabled={busy || !callbackInput.trim()}>
        {busy ? 'Generating…' : 'Generate key'}
      </button>
      <button class="link-btn" onclick={cancel} disabled={busy}>Cancel</button>
    </div>
  {:else}
    <button class="btn-generate" onclick={begin} disabled={busy}>
      {busy ? 'Opening…' : 'Generate via Console login'}
    </button>
  {/if}
  <p class="hint">
    <span class="experimental">Experimental</span>
    Logs in to Anthropic Console and generates a Claude CLI key into the field above.
    Minerva sends Claude Code's system prompt on requests made with it — the
    key-generation endpoint is undocumented and may change without notice.
  </p>
  {#if error}<p class="error">{error}</p>{/if}
</div>

<style>
  .console-login {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  label { color: var(--text); font-size: 12px; }
  input {
    padding: 5px 8px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
  }
  input:focus { outline: none; border-color: var(--accent); }
  .actions { display: flex; align-items: center; gap: 10px; }
  .btn-generate {
    align-self: flex-start;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-button, var(--bg));
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn-generate:hover:not(:disabled) { border-color: var(--accent); }
  .btn-generate:disabled,
  .link-btn:disabled { opacity: 0.5; cursor: default; }
  .link-btn {
    padding: 0;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
  }
  .link-btn:hover:not(:disabled) { color: var(--text); }
  .experimental {
    margin-right: 4px;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 9px;
  }
  .hint {
    margin: 2px 0 0;
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.45;
  }
  .error { margin: 2px 0 0; color: var(--rust); font-size: 11px; }
</style>
