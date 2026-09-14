import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import notifocus, { text, safePreview } from './index.ts';
import { FocusStore } from './store.ts';
import { quote } from './platform.ts';

test('text and click parameters cannot inject terminal/shell control sequences', () => {
  assert.equal(text([{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'hello' }]), 'hello');
  assert.equal(safePreview('a\x1b]9;evil\x07b', 100), 'a]9;evilb');
  assert.equal(quote("a'b"), "'a'\\''b'");
});

test('composes pi-notify, observes real lifecycle shapes, and excludes summary recursion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifocus-extension-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  type Handler = (event: any, ctx: ExtensionContext) => any;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const statuses: string[] = [];
  let unregistered = false;
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand(name: string, definition: unknown) { commands.set(name, definition); },
    registerFlag() {}, getFlag() { return false; }, getSessionName() { return 'Phone feature'; },
    events: { on() { return () => { unregistered = true; }; }, emit() {} },
  } as unknown as ExtensionAPI;
  const context = {
    mode: 'tui', cwd: '/tmp/project',
    ui: { setStatus(_key: string, value: string) { statuses.push(value); }, notify() {} },
    sessionManager: {
      getSessionId() { return 'original'; }, getSessionFile() { return '/tmp/original.jsonl'; },
      getEntries() { return []; },
      getBranch() { return [
        { type: 'message', message: { role: 'user', content: 'Build the phone feature' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tests pass, ready for review.' }] } },
      ]; },
    },
  } as unknown as ExtensionContext;
  const fire = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  };
  let store: FocusStore | undefined;
  try {
    notifocus(pi);
    assert.ok(commands.has('notify')); assert.ok(commands.has('notifocus'));
    assert.ok(handlers.has('agent_settled')); assert.ok(handlers.has('ui_prompt_start'));
    await fire('session_start');
    store = new FocusStore(join(dir, 'notifocus', 'state.sqlite'));
    store.start(Date.now());
    // Automatic upstream OSC hook must be silent while focus is active.
    const writes: unknown[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
    try { await fire('agent_end'); } finally { process.stdout.write = originalWrite; }
    assert.deepEqual(writes, []);
    assert.equal(store.pending().length, 0, 'agent_end does not prematurely mark completion');
    await fire('agent_settled');
    assert.equal(store.pending()[0].kind, 'completion');
    await fire('input', { source: 'interactive' }); assert.equal(store.pending().length, 0);
    await fire('ui_prompt_start', { kind: 'confirm', title: 'Approve deployment?' });
    assert.equal(store.pending()[0].reason, 'Approve deployment?');
    await fire('ui_prompt_end'); assert.equal(store.pending().length, 0);
    await fire('agent_settled'); await fire('agent_start'); assert.equal(store.pending().length, 0);
    await commands.get('notifocus').handler('off', context);
    assert.equal(store.clock().startedAt, null);
    const restored: unknown[] = [];
    process.stdout.write = ((chunk: unknown) => { restored.push(chunk); return true; }) as typeof process.stdout.write;
    try { await fire('agent_end'); } finally { process.stdout.write = originalWrite; }
    assert.equal(restored.length, 1, 'upstream notification restored while off');
    await fire('session_shutdown'); assert.equal(unregistered, true);
  } finally {
    store?.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
