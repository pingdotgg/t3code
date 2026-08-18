# Notifications

T3 Code tells you when an agent needs you or finishes work, so you can switch away and trust that you will be pulled back.

## What you get notified about

Four things, and only these four:

| Kind              | Fires when                                                  |
| ----------------- | ----------------------------------------------------------- |
| Turn completed    | A turn you started finished.                                |
| Turn failed       | A turn ended in an error.                                   |
| Approval required | The agent is blocked waiting for you to approve something.  |
| Input required    | The agent asked you a question and is waiting on an answer. |

Turns an agent spawned for itself — subagents and other background work — do not produce a "turn completed" notification, so one prompt never turns into a burst of them. Failures and approval or input requests from those turns still notify, because they need you regardless of who started the turn.

## Where they show up

On **desktop** you get a native OS notification. It keeps arriving while the window is minimized or closed, and clicking it focuses T3 Code and opens the exact thread it came from, in the environment it came from.

On **web** — whether you are on a local `npx t3` server or on app.t3.codes — you get an in-app toast. The desktop app shows only the native notification, never both.

A thread that is snoozed still notifies when it raises its hand. The sidebar and the OS never disagree about which threads need you.

## What stays quiet

The thread you are currently looking at never notifies you about itself. Anything happening in a _different_ thread still notifies, even while the app is focused — that is how parallel work surfaces without cycling through threads.

Events that happen while no client is connected are recorded but not replayed. Opening the app after a weekend will not fire a stack of stale notifications; the sidebar is the while-you-were-away surface.

## Turning them off

**Settings → General → Notifications** is a single switch for the whole feature. It is on by default.

Quiet hours and sounds are deliberately not settings here — your operating system's Do Not Disturb already owns both.
