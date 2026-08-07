# Board

The board shows every thread across every project and every connected environment as a card, grouped
by what its agent is doing right now. It answers the question the sidebar can't: not "what threads
exist" but "which ones need me".

Open it from the sidebar, from the command palette ("Open board"), or with **Ctrl/Cmd + Shift + B**.
The same shortcut takes you back to where you were.

## Columns

| Column        | What lands here                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Needs You** | The agent is blocked: waiting for an approval, waiting for an answer, or its session failed.                               |
| **Working**   | A turn is running, or subagents and workflows are still running after the turn finished. Watch loops show as _Monitoring_. |
| **Review**    | The agent stopped and you haven't looked yet, or it has a plan waiting for your decision.                                  |
| **Done**      | Settled threads, including ones settled automatically by a merged pull request or by going quiet.                          |
| **Idle**      | Nothing pending and nothing new to read.                                                                                   |
| **Snoozed**   | Hidden until their wake time.                                                                                              |

Columns are computed from live state, not set by hand — a card moves the moment its thread does. A
thread visits the board only until you archive it; archived threads leave the board the same way they
leave the sidebar.

Cards match the sidebar's grouping exactly, so the two never disagree about where a thread belongs.
Snoozing outranks pinning, and a pinned thread never drifts into **Done**.

## Moving cards

Only two columns accept a drop, because only those two are yours to set:

- Drag a card to **Done** to settle it. Settling a pinned thread also unpins it.
- Drag a card to **Snoozed** to snooze it.
- Drag a settled or snoozed card back to the left to return it to the active columns. It lands in
  whichever column its status puts it in, which may not be the one under your cursor.

The other columns belong to the agent, so dragging between them does nothing. If a move isn't
allowed — settling a thread that is still running, snoozing one that is waiting on you — the column
says why instead of failing after the fact.

## Cards

Each card shows its project, provider and model, branch or worktree, pull request state, and a status
dot. Working cards also show the current plan step and how long the turn has been running. A robot
icon means subagents or a watch loop are alive; open the thread's **Agents** panel to see what they
are doing.

The **⋯** menu on a card opens, pins, settles, snoozes, archives, or deletes the thread — the same
actions the sidebar offers.

## Filtering

The toolbar filters by project, by provider, and by title. Filters are per-session: reopening the
board shows everything again.

## Starting work

**New thread** in the toolbar, or the **+** on the first column, starts a thread the same way the
sidebar does. With more than one project, it asks which one.

## Availability

The board is part of the web and desktop apps. It is not in the mobile app — a six-column board
doesn't fit a phone. **Done** and **Snoozed** only appear when the server behind those threads
supports settling and snoozing; older servers simply show fewer columns.
