# Sidebar thread drag and drop

> For maintainers. Using T3 Code? See [docs/user](../user/).

Status: accepted

## Context

The sidebar renders Pinned, Regular, Snoozed, and Settled as categories, but the user drags through
them as one vertical list. A thread may move between any supported categories. Pinned has manual
ordering. The other categories keep their existing natural order. Pinned and Regular use cards;
Snoozed and Settled use compact rows and may be collapsed or empty.

The previous implementation represented those categories as separate drag containers. Moving a row
changed one container's height before the next collision pass. Everything below it moved, so the row
under the pointer stopped being the target. Portal rails, target locks, extra indicators, and
category-specific scroll corrections hid individual cases but left several systems changing the same
geometry.

Later flat-list versions removed the container boundary but still changed the DOM order during every
hover. The active row then changed the collision rectangles used to choose its next position. This
produced oscillation under a stationary pointer and, with continuous measurement, a React update
loop. Flattening the DOM was necessary but not sufficient. Drag-time layout also has to stay stable.

## Decision

Web and desktop use one flat sidebar drag board. Mobile keeps its existing menu actions.

### One rendered list

The board has one `DndContext`, one `SortableContext`, and one direct `<ul>`. The sortable entries are
stable category boundaries followed by their visible thread rows:

```text
Pinned boundary
Pinned threads
Regular boundary
Regular threads
Snoozed boundary
Snoozed threads
Settled boundary
Settled threads
```

Each boundary and thread is a keyed sibling. Boundaries use `useSortable` with dragging disabled and
dropping enabled. The nearest preceding boundary determines a thread's category.

Drag start snapshots this array. React keeps the snapshot in the same DOM order while the pointer is
down. The current collision produces a semantic target consisting of a category and either a row
edge or category boundary. A small sorting-strategy adapter converts that target to a prospective
index and delegates to dnd-kit's `verticalListSortingStrategy`. When card and compact heights differ,
the adapter applies that fixed height difference to every sibling whose projected position follows
the active row. This sizes the target gap and moves the remaining tail as one projected list. The
active row and affected siblings move with dnd-kit's sortable FLIP behavior without changing
collision rectangles.

On release, React applies the projected array once. The same projected array remains rendered while
the command is pending. React replaces it with canonical order after reconciliation.

Collapsed Snoozed and Settled sections omit their canonical rows, but their boundaries remain mounted
and droppable. Empty destinations expose a fixed-height boundary target for the whole transaction.
Drag-over never mounts a new rail, expands a category, or changes pagination.

The sortable gap is the insertion feedback. There is no separate drop indicator.

### Geometry ownership

dnd-kit owns pointer sensing, droppable measurement, collision rectangles, sortable transforms,
auto-scroll, and drop animation. Collision filters out the active row and domain-invalid destinations,
then uses `pointerWithin` followed by `rectIntersection`. The client clears the target when neither
strategy reports a valid collision.

The strategy adapter contains no DOM measurements, animation state, direction lock, or
category-specific correction. It computes the index that the pure flat-array move would produce,
passes that index to `verticalListSortingStrategy`, then adjusts rows after the projected insertion by
the difference between the measured source height and the card or compact presentation height. The
index adapter is necessary because the domain target distinguishes before, after, and the first slot
after a category boundary, while dnd-kit's strategy receives only an `overIndex`.

Pointer movement updates only the semantic target and dragged-row variant. It does not change DOM order,
row height, scroll range, or measured rectangles. A layout revision therefore cannot create another
collision under the same sensor event.

The active sortable row is the pointer visual. Its outer element keeps the dimensions measured at
activation, while the normal `SidebarThreadRow` renderer changes between card and compact layouts
around the captured pointer offset. Dragging does not use a second, simplified copy of the row.
dnd-kit controls the row transform, including scroll adjustment. While dragging, the board ignores
pointer hit-testing so rows under the active row do not show hover actions or tooltips. The active
sensor keeps tracking pointer movement at the document level.

The client owns one small piece of geometry that dnd-kit does not: viewport anchoring during a real
React layout change. Before such a change, it records one stable entry's untransformed position.
After React commits, it adjusts only the sidebar viewport's `scrollTop` by that entry's layout delta.
The pointer and dragged row do not move. The list moves around them.

Hover updates need no correction because sortable transforms do not affect layout. Activation anchors
the source while empty rails mount. Drop anchors the first stable entry after the resulting insertion
slot. Transaction teardown uses the same rule when the projected array returns to canonical order.
User scroll and dnd-kit auto-scroll establish a new anchor baseline. The board does not add synthetic
scroll headroom because auto-scroll would expose it as blank space at the viewport edges.

### Persistence

Drag start snapshots the rendered flat order. Canonical thread content may update during the drag,
but canonical membership does not rewrite the snapshot. If the source disappears, becomes
archived, loses the needed capability, or leaves the current sidebar scope, the client cancels the
transaction.

The projected row stays at the dropped position while the existing lifecycle command and shell
projection complete. Reconciliation replaces the projected array with canonical order in one
sortable layout animation.

Cross-category drops use the existing lifecycle commands. Their deciders atomically clear conflicting
state while pinning, unpinning, settling, un-settling, snoozing, or waking the thread. Drag and drop
adds no command, event, capability, or protocol compatibility path.

`thread.pin.reorder` remains key-only. Moving into Pinned computes the order keys for the visible
position, then pins the source. Pinned threads preserve that manual order. Regular, Snoozed, and
Settled keep their existing sort rules and ignore the transient insertion index after persistence.

The client keeps the projected row until each affected environment's shell snapshot reaches its
receipt sequence. Concurrent canonical state wins at reconciliation.

## Consequences

There is one immutable drag snapshot, one semantic target, and one projected order. Category rendering
cannot move a collision target while the pointer is down. dnd-kit performs all hover and drop motion.
The sidebar code maps domain rules to an index and preserves the viewport around the few real layout
changes.

The board must keep boundaries mounted and their dimensions stable for the full transaction. New
sidebar categories must join the same flat order instead of adding another nested sortable context.

## Rejected alternatives

### Multiple sortable containers

Separate containers match the server projection but not the interaction. Moving a row changes later
containers' positions between collision passes and makes the target escape the pointer.

### Physically reorder on hover

Changing the flat DOM array on every collision also changes the next collision's rectangles. The
active row can cover the pointer while being excluded from collision, or move a category boundary
away from the pointer. Updating from `onDragMove` instead of `onDragOver` avoids a React feedback loop
but does not remove this geometric feedback. Sortable transforms provide the same visible movement
without changing layout.

### A separate drag overlay

An overlay duplicates the active row and requires hiding the original copy. Keeping the sortable row
as the pointer visual gives dnd-kit one transform to own. A source-sized outer row isolates the
card-to-compact morph from list geometry.

### A separate drop indicator

The sortable gap already shows the resulting index. Another indicator duplicates the same state.

### Target locks and category-specific corrections

Locks, hysteresis, portal rails, and per-category scroll rules preserve stale geometry. They make one
case look stable by changing collision or layout elsewhere. The flat list and one anchor rule remove
the underlying container shift.
