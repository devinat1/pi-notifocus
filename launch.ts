// Invoked only by a notification click. Uses macOS's built-in Terminal, not the
// terminal hosting the user's original Pi sessions. No tmux or iTerm dependency.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FocusStore, alive } from './store.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const configFile = process.argv[2];
if (!configFile) throw new Error('Missing private launcher configuration');
const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
  agentDir: string; cwd: string; node: string; cli: string; model?: { provider: string; id: string };
};
for (const key of ['agentDir', 'cwd', 'node', 'cli'] as const) {
  if (typeof config[key] !== 'string' || !config[key].startsWith('/')) throw new Error(`Invalid ${key}`);
}
const store = new FocusStore(join(config.agentDir, 'notifocus', 'state.sqlite'));
const script = (source: string, args: string[]) => execFileSync('/usr/bin/osascript', ['-e', source, ...args], { encoding: 'utf8', timeout: 15_000 }).trim();
try {
  const clock = store.clock();
  if (alive(clock.hubPid)) {
    if (!/^\d+$/.test(clock.hubPane)) throw new Error('Summary chat is already running; open its existing terminal.');
    script(`on run argv
      tell application "Terminal"
        set index of window id (item 1 of argv as integer) to 1
        activate
      end tell
    end run`, [clock.hubPane]);
  } else if (store.reserveHub(Date.now())) {
    try {
      // A fresh session avoids a second writer on an old Pi JSONL file. The
      // latest full summary and routing metadata are restored from local state.
      const args = [config.node, config.cli, '--notifocus-hub', '--name', 'Notifocus', '--no-context-files', '--no-skills', '--tools', 'intercom'];
      if (config.model) args.push('--provider', config.model.provider, '--model', config.model.id);
      const shell = `cd ${quote(config.cwd)} || exit; unset PI_INTERCOM_STABLE_ID PI_INTERCOM_SCOPE_ID PI_SUBAGENT_CHILD PI_SESSION_ID PI_SESSION_FILE; export PI_CODING_AGENT_DIR=${quote(config.agentDir)}; exec ${args.map(quote).join(' ')}`;
      const windowId = script(`on run argv
        tell application "Terminal"
          set newTab to do script (item 1 of argv)
          set custom title of newTab to "Pi Notifocus"
          set newWindow to first window whose selected tab is newTab
          activate
          return id of newWindow
        end tell
      end run`, [shell]);
      if (!/^\d+$/.test(windowId)) throw new Error('Could not identify the new summary window');
      store.setHubWindow(windowId);
    } catch (error) { store.launchFailed(); throw error; }
  }
} finally { store.close(); }
