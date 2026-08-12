# Session Board

The session board is an alternate workspace for keeping several live coding-agent sessions visible
at once. Open **Board** from the sidebar or use the command palette.

The normal chat workspace remains available at `/`. The board lives at `/board` and uses the same
sessions, messages, composer, approvals, questions, and provider controls. A card is not a separate
task or summary of a session.

## Arrange Sessions

Drag a card between lanes to place it. Use a session's context menu to choose a lane or remove it
from the board. New and previously unplaced sessions appear in the leftmost lane.

You can create, rename, describe, reorder, and archive lanes. Drag a lane's right edge to change its
width, and drag the bottom of a card to change that card's height.

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

Selecting a session in the sidebar while `/board` is open reveals and focuses its card instead of
navigating away. Select the focused session again, or use the expand control on its card, to open a
roomier chat over the board. Close the expanded view to return to the same spatial workspace.

The responsive web board remains available at phone-sized browser widths. A dedicated React Native
board is not included yet.
