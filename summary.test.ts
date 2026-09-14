import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import notifocus from './index.ts';
import { FocusStore, FOCUS_MS, type Attention } from './store.ts';

test('any terminal can summarize once, persist the hub view, and reuse exact Intercom routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifocus-summary-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const timers: Array<() => void> = [];
  const realSetInterval = global.setInterval;
  global.setInterval = ((callback: () => void) => { timers.push(callback); return { unref() {} }; }) as unknown as typeof setInterval;
  const store = new FocusStore(join(dir, 'notifocus', 'state.sqlite'));
  const now = Date.now();
  store.start(now - FOCUS_MS - 100);
  const item: Attention = { id: 'original', pid: process.pid, sessionFile: '/tmp/original.jsonl', task: 'Phone feature', reason: 'Ready for review', kind: 'completion', updatedAt: now - 1000 };
  store.put(item);
  const peers = [{ id: 'exact-original-id', pid: process.pid, endpointEpoch: 'epoch-1' }];
  const executions: { program: string; args: string[] }[] = [];
  const views: any[] = [];
  let summaries = 0;
  const errors: string[] = [];
  function harness(hub: boolean) {
    const handlers = new Map<string, any[]>();
    const pi = {
      on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
      registerCommand() {}, registerFlag() {}, getFlag() { return hub; },
      getSessionName() { return hub ? 'Notifocus' : 'Original'; },
      setActiveTools(names: string[]) { assert.deepEqual(names, ['intercom']); },
      appendEntry() {}, sendMessage(message: unknown) { views.push(message); },
      exec: async (program: string, args: string[]) => {
        executions.push({ program, args });
        return { code: 0, stdout: program === '/usr/bin/which' ? '/test/terminal-notifier\n' : '', stderr: '', killed: false };
      },
      events: {
        on() { return () => {}; },
        emit(_name: string, registration: any) { registration.onReady({ snapshot: () => ({ connected: true }), listSessions: async () => peers }); },
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: 'tui', cwd: '/tmp/project', model: { id: 'test-model', provider: 'test-provider' },
      modelRegistry: { complete: async () => { summaries++; return { stopReason: 'stop', content: [{ type: 'text', text: '- Phone feature: ready for review.' }], usage: {} }; } },
      ui: { setStatus(_key: string, message: string) { if (message?.includes('error')) errors.push(message); }, notify() {} },
      sessionManager: {
        getSessionId: () => hub ? 'hub' : 'observer', getSessionFile: () => hub ? '/tmp/hub.jsonl' : '/tmp/observer.jsonl',
        getEntries: () => [], getBranch: () => [],
      },
    } as unknown as ExtensionContext;
    notifocus(pi);
    const fire = async (name: string, event: unknown = {}) => {
      const results = [];
      for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
      return results;
    };
    return { fire };
  }
  const origin = harness(false);
  let hub: ReturnType<typeof harness> | undefined;
  try {
    await origin.fire('session_start');
    timers[0]();
    // Drain bounded asynchronous fixture work, not a background agent/provider wait.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(errors, []);
    assert.equal(summaries, 1);
    assert.match(store.summary()!.content, /Phone feature: ready for review/);
    assert.equal(views.length, 0, 'summary does not clutter the original chat');
    assert.equal(executions.filter(x => x.program === '/test/terminal-notifier').length, 1);
    assert.ok(executions.every(x => !JSON.stringify(x).includes('tmux')));
    timers[0](); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(summaries, 1);
    hub = harness(true); await hub.fire('session_start');
    timers[1](); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(views.length, 1); assert.match(views[0].content, /exact-original-id/);
    const call = { toolName: 'intercom', input: { action: 'send', to: 'exact-original-id', message: 'Continue' } };
    assert.ok((await hub.fire('tool_call', call)).some(result => result?.block), 'peer messages cannot authorize sends');
    await hub.fire('input', { source: 'interactive' });
    assert.ok((await hub.fire('tool_call', call)).every(result => !result?.block), 'explicit human reply can use existing routing');
    peers[0].endpointEpoch = 'epoch-2';
    assert.ok((await hub.fire('tool_call', call)).some(result => result?.block), 'replaced endpoint rejected');
    peers[0].endpointEpoch = 'epoch-1'; store.clear(item.id);
    assert.ok((await hub.fire('tool_call', call)).some(result => result?.block), 'addressed item rejected');
  } finally {
    await origin.fire('session_shutdown'); await hub?.fire('session_shutdown');
    global.setInterval = realSetInterval; store.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
