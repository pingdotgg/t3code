# Keep working toward an Objective

A **Goal** is T3 Code's completion contract on a Thread. You name an **Objective** — the outcome
that should become true — and T3 Code keeps working until that happens, or until you Pause, or
until the work is Blocked or Usage-limited.

`/goal` is T3 Code's command. It is not sent to Codex, Claude, Cursor, Grok, or OpenCode as a
provider command.

## Set an Objective

In the composer, type `/goal` followed by the outcome, then send:

```text
/goal Reduce p95 below 120ms
```

If the Thread is idle, T3 Code records that Objective as your message (without the `/goal` prefix)
and starts a Turn. The composer `/` menu lists `/goal` under Built-in, separate from provider
commands.

A Thread has at most one Goal. Sending `/goal` with a new Objective replaces the current one. If a
Turn is already running, that Turn is left alone; later Continuations follow the new Objective.

Setting a Goal while the Thread is in plan mode switches it to normal build mode so Continuations
can execute.

## Status

The chip above the composer shows the Objective and its status:

- **Active** — T3 Code will start the next Turn when the current one finishes
- **Paused** — the next Continuation will not start until you Resume
- **Blocked** — the work stopped itself; Resume tries again
- **Usage-limited** — the account hit a quota or rate limit; Resume tries again after the window
  resets
- **Complete** — the agent accepted the outcome as met

Inbox and sidebar rows mark Threads that have an **Active** Goal, so you can find independent work
without opening the Thread.

Type `/goal` with no arguments, or choose **Show Objective status** in the command palette, to see
the current Objective and status.

## Edit the Objective

Click the Objective text on the chip to load `/goal <objective>` into the composer. Edit it and
send to replace the current Objective.

## Pause, Resume, and Delete

These actions live as icons on the chip, in the command palette, and as composer commands.

**Pause** (`/goal pause`) prevents the next Continuation. It does not interrupt a Turn that is
already running.

**Stop** interrupts this Turn and also Pauses. Use Stop when you want work to halt now; use Pause
when you only want to prevent the next Continuation.

**Resume** (`/goal resume`) makes a Paused, Blocked, or Usage-limited Goal Active again. If the
Thread is idle, T3 Code starts a Continuation immediately. Resume from Complete is not available;
set a new Objective instead.

**Delete** (`/goal clear`) removes the Goal. Deleting from the chip or command palette asks for
confirmation first. The Thread goes back to one Turn at a time, and a running Turn is interrupted.

Only the agent can mark a Goal **Complete**, when its criteria are met. If the outcome is not what
you wanted, Delete the Goal and set a sharper Objective.

## What does not Pause

**Settle**, **Snooze**, and closing the client do not Pause. The server keeps the Goal. Work
continues if you shelf the Thread, hide it until later, or close the laptop or the mobile app.

Restarting the server does not Pause either. On startup an Active Goal picks up where it left off:
if a Turn was cut off mid-run T3 Code settles it as interrupted, then starts a fresh Continuation.

## Continuations

When a Turn finishes and the Goal is still Active, T3 Code starts the next Turn by itself. That
**Continuation** has no extra user message in the timeline. An activity labeled **Continued**
marks why a Turn began.

The agent can Complete or Block only with T3 Code's completion or blocked markers, not by saying
it is done in chat. After several Continuations with no tools and no file
changes, T3 Code marks the Goal Blocked so empty Turns cannot run forever. Quota and rate-limit
errors mark it Usage-limited instead of retrying.

Approvals and questions delay the next Continuation until you answer. Pending permission prompts
are not skipped.
