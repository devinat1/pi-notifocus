import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const FOCUS_MS = 52 * 60_000;
export const BREAK_MS = 7 * 60_000;
export const CYCLE_MS = FOCUS_MS + BREAK_MS;

export interface Attention {
  id: string;
  pid: number;
  sessionFile: string;
  task: string;
  reason: string;
  kind: 'completion' | 'prompt';
  updatedAt: number;
}
export interface Clock {
  startedAt: number | null;
  generation: number;
  lastCycle: number;
  hubPid: number;
  hubPane: string;
  hubFile: string;
  launchingAt: number;
}
export interface Batch {
  generation: number;
  cycle: number;
  windowStart: number;
  items: Attention[];
}
export function phase(clock: Clock, now: number) {
  if (clock.startedAt === null) return { name: 'off' as const, cycle: -1, remaining: 0, windowStart: 0 };
  const elapsed = Math.max(0, now - clock.startedAt);
  const cycle = Math.floor(elapsed / CYCLE_MS);
  const offset = elapsed % CYCLE_MS;
  return {
    name: offset < FOCUS_MS ? 'focus' as const : 'check-in' as const,
    cycle,
    remaining: offset < FOCUS_MS ? FOCUS_MS - offset : CYCLE_MS - offset,
    windowStart: clock.startedAt + cycle * CYCLE_MS + FOCUS_MS,
  };
}
export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Local bookkeeping only. Intercom, not this database, transports instructions. */
export class FocusStore {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS clock (
        id INTEGER PRIMARY KEY CHECK (id=1), startedAt INTEGER, generation INTEGER NOT NULL DEFAULT 0,
        lastCycle INTEGER NOT NULL DEFAULT -1, hubPid INTEGER NOT NULL DEFAULT 0,
        hubPane TEXT NOT NULL DEFAULT '', hubFile TEXT NOT NULL DEFAULT '', launchingAt INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO clock (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS attention (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, sessionFile TEXT NOT NULL,
        task TEXT NOT NULL, reason TEXT NOT NULL, kind TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS summary (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, content TEXT NOT NULL, routes TEXT NOT NULL);`);
  }
  close() { this.db.close(); }
  clock(): Clock { return this.db.prepare('SELECT * FROM clock WHERE id=1').get() as unknown as Clock; }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  start(now: number) {
    this.db.prepare('UPDATE clock SET startedAt=?, generation=generation+1, lastCycle=-1 WHERE id=1 AND startedAt IS NULL').run(now);
    return this.clock();
  }
  stop() {
    this.db.exec('UPDATE clock SET startedAt=NULL, generation=generation+1, lastCycle=-1 WHERE id=1');
  }
  put(item: Attention) {
    this.db.prepare(`INSERT OR REPLACE INTO attention VALUES (?,?,?,?,?,?,?)`).run(
      item.id, item.pid, item.sessionFile, item.task, item.reason, item.kind, item.updatedAt,
    );
  }
  clear(id: string, kind?: Attention['kind']) {
    if (kind) this.db.prepare('DELETE FROM attention WHERE id=? AND kind=?').run(id, kind);
    else this.db.prepare('DELETE FROM attention WHERE id=?').run(id);
  }
  pending(): Attention[] {
    return this.db.prepare('SELECT * FROM attention ORDER BY updatedAt, id').all() as unknown as Attention[];
  }
  claim(now: number): Batch | undefined {
    return this.transaction(() => {
      const clock = this.clock();
      const current = phase(clock, now);
      if (current.name !== 'check-in' || current.cycle <= clock.lastCycle) return;
      // Claim before any asynchronous work: crashes cannot create duplicate interruptions.
      this.db.prepare('UPDATE clock SET lastCycle=? WHERE id=1').run(current.cycle);
      const items = this.pending().filter(item => item.updatedAt <= current.windowStart);
      return { generation: clock.generation, cycle: current.cycle, windowStart: current.windowStart, items };
    });
  }
  mayNotify(batch: Batch, now: number) {
    const clock = this.clock();
    const current = phase(clock, now);
    return clock.generation === batch.generation && current.name === 'check-in' && current.cycle === batch.cycle;
  }
  reserveHub(now: number): boolean {
    return this.transaction(() => {
      const clock = this.clock();
      if (alive(clock.hubPid) || (clock.launchingAt > 0 && now - clock.launchingAt < 30_000)) return false;
      this.db.prepare('UPDATE clock SET launchingAt=?, hubPid=0, hubPane=\'\' WHERE id=1').run(now);
      return true;
    });
  }
  saveSummary(content: string, routes: unknown) {
    this.db.prepare(`INSERT INTO summary VALUES (1,1,?,?) ON CONFLICT(id) DO UPDATE SET version=version+1, content=excluded.content, routes=excluded.routes`).run(content, JSON.stringify(routes));
  }
  summary(): { version: number; content: string; routes: string } | undefined {
    return this.db.prepare('SELECT version,content,routes FROM summary WHERE id=1').get() as { version: number; content: string; routes: string } | undefined;
  }
  setHubWindow(window: string) {
    this.db.prepare('UPDATE clock SET hubPane=? WHERE id=1').run(window);
  }
  registerHub(pid: number, file: string): boolean {
    return this.transaction(() => {
      const clock = this.clock();
      if (clock.hubPid !== pid && alive(clock.hubPid)) return false;
      this.db.prepare('UPDATE clock SET hubPid=?, hubFile=?, launchingAt=0 WHERE id=1').run(pid, file);
      return true;
    });
  }
  releaseHub(pid: number) {
    this.db.prepare('UPDATE clock SET hubPid=0, hubPane=\'\', launchingAt=0 WHERE id=1 AND hubPid=?').run(pid);
  }
  launchFailed() { this.db.exec('UPDATE clock SET launchingAt=0 WHERE id=1 AND hubPid=0'); }
}
