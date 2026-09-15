import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir, getPackageDir } from '@earendil-works/pi-coding-agent';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export async function command(exec: ExtensionAPI['exec'], program: string, args: string[]) {
  const result = await exec(program, args, { timeout: 10_000 });
  if (result.code !== 0 || result.killed) throw new Error(`${program}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout.trim();
}
export async function prerequisites(exec: ExtensionAPI['exec']) {
  if (process.platform !== 'darwin') throw new Error('Notifocus currently requires macOS notifications. No particular terminal is required.');
  return command(exec, '/usr/bin/which', ['terminal-notifier']);
}
export async function notifySummary(exec: ExtensionAPI['exec'], body: string, cwd: string, model?: { provider: string; id: string }) {
  const notifier = await prerequisites(exec);
  const agentDir = getAgentDir();
  const config = join(agentDir, 'notifocus', 'launch.json');
  const temporary = `${config}.${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify({
    agentDir, cwd, node: process.execPath,
    cli: join(getPackageDir(), 'dist/bundle/cli.js'), model,
  }), { mode: 0o600 });
  renameSync(temporary, config);
  const launcher = join(dirname(fileURLToPath(import.meta.url)), 'launch.ts');
  const click = [process.execPath, '--experimental-strip-types', launcher, config].map(quote).join(' ');
  // terminal-notifier requires a leading escape for bullets and property-list punctuation.
  await command(exec, notifier, ['-title', 'Pi · 7-minute check-in', '-message', '\\' + body,
    '-group', 'pi-notifocus', '-execute', click]);
}
