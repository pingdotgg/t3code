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
down. Pinned reorder uses dnd-kit's row collision and `overIndex` directly. Cross-category collision
produces a semantic target consisting of a category and either a row edge or category boundary. A
small sorting-strategy adapter converts that target to a prospective index and delegates to dnd-kit's
`verticalListSortingStrategy`. When card and compact heights differ, the adapter applies that fixed
height difference to every sibling whose projected position follows the active row. This sizes the
target gap and moves the remaining tail as one projected list. The active row and affected siblings
move with dnd-kit's sortable FLIP behavior without changing collision rectangles.

On release, Pinned keeps the hovered insertion target because its order is manual. Regular and
Settled replace the hover target with the result of their normal sidebar sorter. Snoozed waits for the
duration choice, then sorts using the selected wake time. React applies that projected natural order
once. The active row keeps its fixed pointer presentation while its new in-flow position acts as an
invisible target slot. The client measures both viewport rectangles and animates the active row into
that slot. dnd-kit FLIP-animates every other row affected by the sort. The same projected array remains
rendered while the command is pending. React replaces it with canonical order after reconciliation.

Collapsed Snoozed and Settled sections omit their canonical rows, but their boundaries remain mounted
and droppable. Empty destinations expose a fixed-height boundary target while the pointer is down.
On release, the projected row and normal category header replace that temporary target before the
client measures the drop slot. Drag-over never changes pagination.

The sortable gap is the insertion feedback. There is no separate drop indicator.

### Geometry ownership

dnd-kit owns pointer sensing, droppable measurement, collision rectangles, sortable transforms, and
auto-scroll. Within Pinned, same-category reorder keeps the active row in the collision set and uses
`closestCenter`, matching dnd-kit's normal sortable-list behavior. The dragged card changes slots when
its center becomes closer to another row instead of when the pointer crosses the target row's
midpoint. Other paths filter out the active row and domain-invalid destinations, then use
`pointerWithin` followed by `rectIntersection`. The client clears the target when neither strategy
reports a valid collision.
Each category boundary uses its wrapper for sortable movement and registers its visible header,
divider, or empty rail as the droppable node. Gaps between visible droppables resolve to the closest
target so the sortable projection cannot alternate between a row and no target. Snoozed and Settled
own collisions only after the center of dnd-kit's constrained active rectangle crosses their visible
header. A card can overlap a shelf while the last slot in the preceding category remains reachable.
After a shelf owns the collision, normal pointer and closest-center selection chooses its row. When
the pointer leaves the viewport vertically but remains within the board width, `closestCenter` uses
the same constrained active rectangle. The top and bottom insertion slots therefore remain sortable.

The strategy adapter contains no DOM measurements, animation state, direction lock, or
category-specific correction. For cross-category moves it computes the index that the pure flat-array
move would produce and passes that index to `verticalListSortingStrategy`. It adjusts only the rows
between the source and projected index so they move by the card or compact presentation height rather
than dnd-kit's measured active height. When a compact source grows into a card above its source slot,
the adapter also moves the rows after that slot by the height difference. This prevents overlap
without changing the source placeholder or any collision rectangle. Same-category Pinned reorder
bypasses the projected index and uses dnd-kit's `overIndex`. The adapter is necessary elsewhere
because the domain target distinguishes before, after, and the first slot after a category boundary,
while dnd-kit's strategy receives only an `overIndex`.

Pointer movement updates only the semantic target, dragged-row variant, and dragged-row translation.
It does not change DOM order, row height, scroll range, or measured rectangles. The
`SortableContext.items` array keeps the same identity while the snapshot is unchanged; otherwise
dnd-kit disables transitions for one frame on every pointer update. A layout revision therefore
cannot create another collision under the same sensor event.

The active sortable row is the pointer visual. Its outer element keeps the dimensions measured at
activation. The normal `SidebarThreadRow` renderer changes between card and compact layouts around the
captured pointer offset. Dragging does not use a second, simplified copy of the row.
The fixed child derives its translation from dnd-kit's pointer coordinates and the activation pointer
captured inside the source rectangle. List layout and scroll offsets never enter that translation.
The source-sized outer rectangle clamps the visual only at the sidebar viewport edges. The fixed card
cannot increase the list's scroll range. The board ignores pointer hit-testing so rows under the
active row do not show hover actions or tooltips. The active sensor keeps tracking pointer movement at
the document level, while dnd-kit still owns collision, auto-scroll, and surrounding sortable
transforms.

dnd-kit's derived layout transform is disabled only for an active row that crosses categories. Its
source placeholder is not the card's visible release position, so that transform would replay a move
from the source category. A short client-side FLIP instead measures the fixed card and its projected
target slot, then animates between those exact viewport rectangles. Surrounding rows continue to use
dnd-kit's sortable FLIP. The lifecycle command starts after this visual handoff, and reduced-motion
clients complete it immediately.

The client owns one small piece of geometry that dnd-kit does not: viewport anchoring during a real
React layout change. Before such a change, it records one stable entry's visible viewport position,
including its current sortable transform. After React commits, it adjusts only the sidebar
viewport's `scrollTop` by that entry's visual delta. The thread content disables native browser scroll
anchoring so the browser and the client cannot both correct the same change. The pointer and dragged
row do not move. The list moves around them.

Hover updates need no correction because sortable transforms do not affect layout. Activation anchors
the source while empty rails mount. Drop anchors the first stable entry after the resulting insertion
slot. Transaction teardown uses the same rule when the projected array returns to canonical order.
User scroll and dnd-kit auto-scroll establish a new anchor baseline. The board does not add synthetic
scroll headroom because auto-scroll would expose it as blank space at the viewport edges.

Pinned reorder uses the same release-to-slot handoff as a cross-category drop, then commits its
optimistic order without viewport correction. It keeps the same rows, category structure, and total
height, so surrounding rows can FLIP without changing `scrollTop`.

### Persistence

Drag start snapshots the rendered flat order. Canonical thread content may update during the drag,
but canonical membership does not rewrite the snapshot. If the source disappears, becomes
archived, loses the needed capability, or leaves the current sidebar scope, the client cancels the
transaction.

The projected row stays at the dropped position while the existing lifecycle command and shell
projection complete. Reconciliation replaces the projected array with canonical order in one
sortable layout animation. The drop handoff is client state and adds no server round trip.

A Snooze drop keeps the hovered compact slot in flow while the standard duration menu is open. The
fixed card remains at its release position above that slot. Choosing a duration moves the projected
row to its naturally sorted slot before the drop handoff; cancelling restores the source order. The
viewport anchor applies to both changes, so opening or closing the menu does not collapse the space
under the card.

Cross-category drops use the existing lifecycle commands. Their deciders atomically clear conflicting
state while pinning, unpinning, settling, un-settling, snoozing, or waking the thread. Drag and drop
adds no command, event, capability, or protocol compatibility path.

`thread.pin.reorder` remains key-only. Moving into Pinned computes the order keys for the visible
position, then pins the source. Pinned threads preserve that manual order. Regular, Snoozed, and
Settled use the same sort functions for drop projection and canonical rendering, so reconciliation
does not introduce a second unsignalled move.

The client keeps the projected row until each affected environment's shell snapshot reaches its
receipt sequence. Concurrent canonical state wins at reconciliation.

## Consequences

There is one immutable drag snapshot, one semantic target, and one projected order. Category rendering
cannot move a collision target while the pointer is down. dnd-kit performs hover motion and surrounding
layout FLIP; the client performs only the active card's final rectangle-to-rectangle handoff. The
sidebar code maps domain rules to an index and preserves the viewport around the few real layout
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
