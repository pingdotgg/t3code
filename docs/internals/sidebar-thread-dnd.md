# Sidebar thread drag and drop

> For maintainers. Using T3 Code? See [docs/user](../user/).

Status: accepted

## Decision

Web and desktop use one sidebar drag-and-drop board for Pinned, Regular, Snooze, and Settled.
Mobile keeps its existing menu actions; it does not add native drag and drop.

The category part of a cross-section drop dispatches an existing lifecycle command. The decider makes
the category change atomic by emitting the required cleanup events with it. The categories are
exclusive. Pinning, settling, waking, un-settling, and snoozing clear conflicting state in the same
decision. The implementation adds no new command, event, capability, or protocol compatibility path
for drag and drop.

`thread.pin.reorder` remains separate and key-only. Pinned insertion computes the order keys needed
for the dropped position, then pins the source. Pinned threads use those keys for manual order.
Regular, Snooze, and Settled use their existing sort rules. A cross-section drop into one of those
sections changes state but does not write an arbitrary list index.

The client holds the source row and layout anchor until each affected environment's shell snapshot
reaches its receipt sequence. This keeps sorted lists from jumping during a drop and lets concurrent
canonical state win once the transaction completes.

## Rationale

Lifecycle commands already express the state transitions. Making their decisions atomic keeps a
cross-section move understandable to the server and avoids a temporary state where a thread appears
in two sections. Keeping pinned reorder key-only preserves its existing ordering model while the
other sections remain naturally sorted.
