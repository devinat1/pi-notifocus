import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FocusStore, FOCUS_MS, BREAK_MS, CYCLE_MS, phase, type Attention } from './store.ts';

const item = (id: string, updatedAt: number): Attention => ({ id, pid: process.pid, sessionFile: `/tmp/${id}.jsonl`, task: 'Phone feature', reason: 'Tests pass; review the result', kind: 'completion', updatedAt });

test('shared 52/7 clock, strict snapshots, recurrence, ack, stop, sleep and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifocus-test-'));
  const file = join(dir, 'state.sqlite');
  const a = new FocusStore(file); const b = new FocusStore(file);
  try {
    const start = 1_000_000;
    a.start(start); b.start(start + 100);
    assert.equal(b.clock().startedAt, start, 'second start must not reset timer');
    assert.equal(FOCUS_MS, 52 * 60_000); assert.equal(BREAK_MS, 7 * 60_000);
    assert.equal(phase(a.clock(), start + FOCUS_MS - 1).name, 'focus');
    a.put(item('early', start + 1));
    a.put(item('at-boundary', start + FOCUS_MS));
    a.put(item('late', start + FOCUS_MS + 1));
    assert.equal(a.claim(start + FOCUS_MS - 1), undefined);
    const batch = a.claim(start + FOCUS_MS + 5)!;
    assert.deepEqual(batch.items.map(x => x.id), ['early', 'at-boundary']);
    assert.equal(b.claim(start + FOCUS_MS + 6), undefined, 'one claim across connections');
    assert.equal(a.mayNotify(batch, start + FOCUS_MS), true);
    assert.equal(a.mayNotify(batch, start + CYCLE_MS), false, 'never notify in next focus block');
    a.clear('early');
    const next = b.claim(start + CYCLE_MS + FOCUS_MS)!;
    assert.deepEqual(next.items.map(x => x.id), ['at-boundary', 'late']);
    a.put({ ...item('dialog', start + 2 * CYCLE_MS), kind: 'prompt' });
    a.clear('dialog', 'completion'); assert.ok(a.pending().some(x => x.id === 'dialog'));
    a.clear('dialog', 'prompt'); assert.ok(!a.pending().some(x => x.id === 'dialog'));
    a.stop(); assert.equal(phase(b.clock(), start).name, 'off');
    assert.equal(b.mayNotify(next, start + CYCLE_MS + FOCUS_MS), false);
    a.start(start + 2 * CYCLE_MS);
    assert.equal(a.claim(start + 9 * CYCLE_MS), undefined, 'sleep landing in focus does not replay old summaries');
    assert.equal(a.claim(start + 9 * CYCLE_MS + FOCUS_MS)?.cycle, 7);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(a.reserveHub(start), true); assert.equal(b.reserveHub(start + 1), false);
    assert.equal(b.reserveHub(start + 30_001), true, 'failed launches expire');
    assert.equal(a.registerHub(process.pid, '/tmp/hub.jsonl'), true);
    assert.equal(b.reserveHub(start + 60_001), false, 'live hub is never duplicated');
    a.releaseHub(process.pid); assert.equal(b.reserveHub(start + 60_002), true);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('empty window is claimed, so late completions do not interrupt it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifocus-test-')); const store = new FocusStore(join(dir, 'state.sqlite'));
  try {
    store.start(10);
    assert.deepEqual(store.claim(10 + FOCUS_MS)?.items, []);
    store.put(item('late', 11 + FOCUS_MS));
    assert.equal(store.claim(12 + FOCUS_MS), undefined);
    assert.equal(store.claim(10 + CYCLE_MS + FOCUS_MS)?.items.length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent processes cannot claim the same notification window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notifocus-race-')); const file = join(dir, 'state.sqlite');
  const store = new FocusStore(file); store.start(10); store.put(item('one', 20)); store.close();
  try {
    const script = `import {FocusStore} from './store.ts';const s=new FocusStore(process.argv[1]);console.log(s.claim(${10 + FOCUS_MS}) ? 'won' : 'lost');s.close();`;
    const outputs = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, file], { cwd: import.meta.dirname })));
    assert.equal(outputs.filter(x => x.stdout.trim() === 'won').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
