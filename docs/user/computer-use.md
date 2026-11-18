# Computer use

Agents in any thread can use a Mac you connect: open and quit apps, change
the volume, media, dark mode or lock the screen, and work through an app's
window by reading it through accessibility and clicking, typing and scrolling.
Every step is checked by the environment first. Routine steps run at once;
steps that type, send, buy or delete wait for your tap.

Agents either take single steps themselves (read the window, then click, type,
press a key, scroll or open a web address in your default browser) or hand
computer use a goal to work through. Both are checked the same way.

Computer use runs on macOS. Approving, stopping and settings work from any
client, including the mobile app and browsers on Windows or Linux.

## Turn it on

1. Open **Settings → Computer use** and turn on **Agent computer use**. It is
   off by default. A project can override it from the same page with the
   project picker. It applies when an agent session next starts, such as in a
   new thread.
2. Connect a computer:
   - **Desktop app:** on the Mac you want agents to use, turn on **Let this
     environment use this computer** for each environment that may use it.
     It is off for every environment until you turn it on. The Mac is
     available only while Ada is open on it.
   - **`ada serve` in a Mac terminal:** the server offers that Mac by itself.
3. Grant **Accessibility** in **System Settings → Privacy & Security** to Ada,
   or to the terminal app that runs `ada serve`. **Screen Recording** lets it read
   windows accessibility cannot, and **Automation** lets it control apps. The
   settings page shows what is granted.

**Connected computers** lists each computer, which environment it belongs to
and whether it is ready.

A device paired before computer use existed can see tasks and stop them but
cannot approve steps. Pair it again to let it approve.

## Working alongside it

Steps run in the background: Ada presses controls and sets text through
accessibility and sends keys to the app itself, so your pointer and keyboard
stay yours and keep working while it acts. A ring shows where each step lands.

A step that cannot be done that way, such as a click on a canvas, asks on an
approval card for your mouse for a moment. Only that step uses the real
pointer, shown as a filled dot, and moving your mouse during it stops the task.

## What needs a tap

A step that types, sends, buys, deletes or otherwise changes something waits
on an approval card. The card shows the action, the exact text it will type,
the app, window and address, the reason, the goal and a 60-second countdown.
It appears above the message box of the thread that asked, and in the strip
at the top of every other screen. In the mobile app it appears on the thread.
Approvals show only while Ada is open: there is no push notification for them,
so keep a window or the mobile app open while a task runs.

An approval covers that one step only. If the window changes before the step
runs, it does not run. **Deny** ends the task, and so does letting the
countdown run out. Agents cannot approve a step.

Clicks the built-in rules cannot judge also ask, unless you set a **decision
endpoint** in **Settings → Computer use**. **Jev (TypeSafe)** answers once you
paste an API key from the TypeSafe console; **Custom** takes an
OpenAI-compatible or System One endpoint of your own. That endpoint sees
control labels and up to 1,500 characters of visible text, never the text a
task types.

### Skip approvals

Turn off **Ask before consequential actions** to let steps run without a tap.
A step that needs your mouse still asks. Refused actions stay refused, the step and time limits still apply, every
skipped step is still written to the activity log, and running tasks show
**approvals off**. Turning it back on applies from the next step of a task
that is already running. A project can override this setting too.

## Limits

A task gets 15 steps and 90 seconds of working time. Time spent waiting for
your tap or for the agent does not count. Each computer runs one task at a
time.

## Stop a task

Any of these ends a task at once:

- **Stop** in the strip at the top of the window, or on the mobile app's
  working indicator.
- **Stop computer use** in the command palette, or the `computer.stop`
  keybinding command (no default key, see [Keybindings](./keybindings.md)).
- <kbd>⌘</kbd><kbd>⇧</kbd><kbd>⎋</kbd> on the Mac being used, while a task runs.
- Moving the pointer into the top-left corner of a screen on that Mac. This
  works without a network.
- Interrupting the thread's run.
- Quitting Ada or disconnecting the computer.

## Activity log

Every task, step, approval and stop is written to
`<Ada home>/userdata/computer/audit.jsonl`, and the latest entries are shown in
**Settings → Computer use**. Typed text is never written: the log records its
length and a short fingerprint.
