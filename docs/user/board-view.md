# Board view

Board view keeps several agent conversations visible and usable across your connected
environments. It is useful when several agents are working at once and switching through the
thread sidebar would hide the conversations you are supervising.

## Open Board view

Use any of these entry points:

- Select **Board view** in the sidebar.
- Choose **Open Board view** from the command palette.
- Press `mod+alt+shift+b`. You can replace this shortcut in **Settings** → **Keybindings**.
- Visit `/board` directly.

The shortcut works from both the web and desktop clients. Like other global navigation shortcuts,
it stays inactive while the terminal has focus so it cannot consume terminal input.

## What appears

Board view reads the same live session state as the rest of T3 Code. It includes active sessions
from every connected environment and groups them by project, without copying or synchronizing
those sessions into a second store.

Settled, snoozed, and archived threads stay out of Board view. Sessions that need your attention,
such as a pending approval or input request, remain visible.

Each card is a compact view of an existing thread. It includes the live conversation timeline and
composer, so you can read progress and send a follow-up without leaving Board view. The card also
shows the context needed to distinguish simultaneous sessions:

- Session title and project
- Environment and branch
- Provider model and runtime mode
- Current status, including working, awaiting input, approval, monitoring, failure, or ready

Status comes from the same provider and server projections as the thread sidebar. **Working** means
the provider is currently running a turn or live background work is in progress. **Awaiting input**
and **Needs approval** identify sessions where progress depends on you. **Monitoring** identifies a
session following background work, while **Completed** marks finished work you have not visited yet
and **Ready** is active but currently idle. A failed turn remains visible as **Error** so it is not
lost among idle sessions.

The page header summarizes sessions that need attention or are still working.

Environment names remain visible even when projects share a title. This matters when a local server,
a desktop-hosted server, and a remote environment expose similar workspaces: selecting the card still
routes to the environment that owns the session.

Use the open-thread button on a card to move into its full thread view. You return to the same
conversation, worktree, and provider session shown on the board; the card is a view of that thread,
not a new task or duplicate conversation.

Chats mount as they approach the visible part of the board. A chat stays mounted while it has focus,
a draft or message in flight, or a timeline you scrolled away from the latest message. Other
off-screen chats unmount until they approach the viewport again.

Board view updates as connected environments publish new session state. A disconnected environment
does not become a separate cached workflow; when its live sessions are available again, they return
through the normal environment connection.

## Current scope

Board view is another surface for existing threads. Session lifecycle remains owned by the server
and the existing thread controls. The board does not assign workflow state or move work between
lanes.

The standard sidebar remains available, so projects, settings, usage, and updates keep their usual
navigation paths while Board view is open.

Card placement follows a responsive project grid, so the same page remains readable as the window
or desktop shell changes size. Custom lanes, persistent placement, manually resizable cards, and a
native mobile Board screen are not part of the current Board view.
