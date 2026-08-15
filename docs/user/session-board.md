# Session Board

The session board is an alternate workspace for keeping several live coding-agent sessions visible
at once. Open **Board** from the sidebar or use the command palette.

The normal chat workspace remains available at `/`. The board lives at `/board` and uses the same
sessions, messages, composer, approvals, questions, and provider controls. A card is not a separate
task or summary of a session.

## Arrange Sessions

Every non-archived sidebar session exists on the board. The default workflow runs from **Triage**
through **Blocked**, **Ready**, **In Progress**, and **Review**. New and previously unplaced sessions
start in Triage. Triage is fixed at the left edge; the other workflow lanes can be created, renamed,
described, reordered, and archived.

**Snoozed** and **Settled** are lifecycle lanes rather than ordinary workflow placement. They are
fixed at the two rightmost positions, use a muted treatment, can be collapsed, and show each session
as a header-only card. Dragging into Snoozed opens the normal snooze-time picker, while dragging into
Settled settles the session. Dragging back into a workflow lane wakes or un-settles the session and
restores normal board placement. Archived sessions remain hidden, matching the sidebar.

Drag a lane's right edge to change its width, and drag the bottom of a normal card to change that
card's height. New cards open at the full working height, and that height is also the resize minimum;
cards can be made taller but not compacted below it. There is no separate compact-size mode.

Projects are listed alphabetically when project grouping is on. Cards do not move when a session
starts working or receives updates. A lane defaults to newest arrival first—using the time a card was
created or moved into that lane—and dragging a card above or below another card saves that manual
order locally.

Each card header has icon actions to snooze or settle the session. Its context menu offers the same
thread actions as the sidebar, along with workflow lane placement. Sessions cannot be removed from
the board independently because the board and sidebar are two views over the same collection.

Card status uses the same glyphs and hues as the sidebar. The full border carries the state color and
the card surface carries a very light wash of that hue, so working, completed, waiting, and failed
sessions remain easy to scan.

Lane definitions, widths, ordering, and session placements are saved by the client displaying the
board. They survive reloads on that browser or desktop installation. They are not synchronized to
T3 Code environments or to another client, so the same session can be arranged differently on two
devices.

Tabs from the same browser profile reconcile board changes through local storage. If two tabs edit
the board at exactly the same time, the last saved local change wins.

## Work Across Environments

One board shows sessions from every environment connected to that client. Each card identifies its
environment, and disconnected environments are labeled honestly. A disconnected card may remain
visible from cached state, while sessions from reachable environments continue to work normally.

Project grouping uses the same logical project identity as the sidebar. Matching clones of one
repository can therefore appear under one project heading even when they belong to different
environments. Turn **Group projects** off to view all sessions directly in each lane.

## Focus and Expand

Selecting a session in the sidebar while `/board` is open smoothly reveals its whole card instead of
navigating away. Select the focused session again, or use the expand control on its card, to open an
80%-sized chat over the board. Focusing a card smoothly reveals the matching session in the sidebar.
Close the expanded view to return to the same spatial workspace.

A new thread started from the board opens in that expanded view. When projects are grouped, each
project heading has its own new-thread button and supplies the project automatically. A new thread
started from a full-screen thread route stays in the classic full-screen route flow. Returning to
**Board** always closes any old expanded view first.

The responsive web board remains available at phone-sized browser widths. A dedicated React Native
board is not included yet.
