# Pi Notifocus

Run `/notifocus` in any interactive Pi session on macOS. It starts one shared, continuously repeating **52-minute focus / 7-minute check-in** cycle. No iTerm2, tmux, or particular terminal host is required.

At each check-in start, one participating Pi session claims and summarizes a snapshot of pending top-level sessions using its selected model and existing authentication. One macOS notification opens a dedicated Pi chat in macOS's built-in Terminal when clicked (or focuses it if already running). The original Pi sessions can remain in any terminal. Reply there to route explicit instructions using **pi-intercom**, not a second messaging implementation.

## Commands

- `/notifocus`: start, or join the already-running cycle (does not reset it).
- `/notifocus status`: phase, minutes remaining, pending count, last error.
- `/notifocus off`: stop globally and restore ordinary pi-notify notifications.
- `/notifocus ack`: mark the current original session's completion addressed without sending a prompt.

Reload all participating Pi sessions after installation. Sessions without the extension cannot be observed or silenced. Scoped Intercom sessions and noninteractive/delegated children do not participate.

## Install

Requires Node >=22.19, Pi with `agent_settled` and `ui_prompt_start/end`, and terminal-notifier. Notification permissions and macOS Focus settings still apply. macOS may request Automation permission for the click helper to open/focus the built-in Terminal app.

```sh
pi install npm:pi-notifocus
```

Or install from GitHub:

```sh
pi install git:github.com/devinat1/pi-notifocus
```

For local development, run `npm install --ignore-scripts` and `pi install /absolute/path/to/pi-notifocus`.

Disable the separately loaded `npm:@jmcombs/pi-notify` extension using Pi's package filter (`"extensions": []`). This package wraps that exact dependency, keeping `/notify` and its original disabled-mode behavior. Loading both causes duplicate/uncontrolled notifications. Intercom is included as a package resource; do not also load another copy.

## Semantics and limits

- Use `agent_settled`, not premature `agent_end`, to record completions; blocking extension dialogs are recorded separately.
- Manual input, resumed work, `/notifocus ack`, or dialog closure clears the relevant attention state. Merely reading a summary does not.
- Items arriving after a window's starting boundary wait until the next window. Unresolved items repeat. No empty notifications.
- Timer and attention metadata live in `$PI_CODING_AGENT_DIR/notifocus/state.sqlite` (default `~/.pi/agent/notifocus/state.sqlite`), in a private directory. Native SQLite transactions arbitrate claims across processes. A claim is consumed before asynchronous work: a crash can skip a notification, but never duplicate it; pending items remain for the next window.
- The timer uses wall-clock time. After sleep, old windows are not replayed. No alerts during focus, including if summarization runs late. The summary can still appear in the hub for manual reading.
- Summary model failure produces a clearly labeled raw pending-item fallback, not a fabricated LLM summary. Errors appear quietly in the footer and `/notifocus status`.
- Prompts are bounded to 2,000 characters of task context and 3,000 of latest response per session, without tool output or model thinking. These are sent to the summarizing session's configured model provider. Model usage is recorded in a `notifocus-summary-usage` session entry (not Pi's ordinary footer totals).
- Replies use exact Intercom IDs and endpoint epochs. A live endpoint must still match, and the attention item must be unchanged. Delivery is not proof of execution.
- Native approval dialogs **must be answered in their original sessions**. Messaging never bypasses them. The hub cannot run coding tools, create workers, or send merely because a peer message asked it to.
- Closing an original session removes it from pending attention. Reload preserves recorded pending items; completions that occurred before the extension was first loaded are not reconstructed. A closed hub is opened again on the next notification click. Summaries do not require the hub to be running. `/notifocus off` leaves the hub available but quiet.
- The latest complete summary and routing metadata persist in SQLite and load into the hub even before its first assistant reply. A reopened hub starts a fresh Pi chat and restores the latest summary; it never opens a second writer on an existing session file.

## Verification

```sh
npm run typecheck
npm test
```

Manual end-to-end: reload two Pi sessions; run `/notifocus`; finish a task in each and confirm no individual desktop alerts; at the check-in, confirm one summary, click to the hub, and send an explicit instruction to one exact session. A completion during the 7-minute window must wait until the next check-in. Run `/notifocus off` to restore ordinary alerts.

Uninstall by removing this local package from Pi settings and re-enabling the original pi-notify package, then reloading sessions. No installed upstream source files are patched.
