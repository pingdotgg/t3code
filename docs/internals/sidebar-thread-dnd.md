# Sidebar thread drag and drop

> For maintainers. Using T3 Code? See [docs/user](../user/).

Status: accepted

## Context

The sidebar shows Pinned, Regular, Snoozed, and Settled as categories, but the user drags through
them as one vertical list. Pinned has manual ordering. The other categories keep their existing
sort order. Pinned and Regular use cards; Snoozed and Settled use compact rows and may be collapsed
or empty.

Earlier implementations used separate drag containers or changed the rendered array on every
hover. Both approaches changed category geometry before the next collision pass. The target moved
away from a stationary pointer, which caused oscillation, cursor drift, scroll jumps, and, with
continuous measurement, a React update loop.

The interaction needs two stable points:

- The point grabbed inside the dragged row stays under the pointer while the row changes shape.
- The category or row under the pointer stays in the same viewport position when real layout
  changes occur.

## Decision

Web and desktop use one flat drag board. Mobile keeps its menu actions.

### One sortable board

The board has one `DndContext`, one `SortableContext`, and one direct `<ul>`. Its sortable entries
are stable category boundaries followed by visible thread rows:

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

Every boundary and row is a keyed sibling. Boundaries use `useSortable` with dragging disabled.
Their visible divider, header, or empty rail is the droppable node. The nearest preceding boundary
defines a row's category.

Drag start snapshots the rendered entries. React keeps that order while the pointer is down. Hover
updates only the semantic target and the dragged presentation. dnd-kit moves surrounding rows with
sortable transforms, so collision rectangles and scroll height stay stable.

The transaction is a discriminated union. `dragging` may have no target. Later phases require a
target. `dropping` stores the resolved action, `committing` stores only a command action, and only
`reconciling` stores receipt sequences. The transaction also owns the starting sidebar scope and a
selected snooze preset, so those values cannot drift in parallel refs.

### Pointer visual and morph

dnd-kit's `DragOverlay` is the pointer visual. It renders the same `SidebarThreadRow` component as
the list, with interaction disabled. The source row stays in the list at zero opacity, preserving
its measured slot without showing a duplicate.

Drag start records the pointer's normalized position inside the source row. The overlay keeps that
point fixed while its inner content morphs between the card and compact presentations. The morph is
a short FLIP animation around the captured pointer origin. It never changes list geometry.

The overlay uses dnd-kit's transform, vertical-axis restriction, and first-scrollable-ancestor
restriction. Rows below it ignore pointer events, so their hover controls and tooltips do not open
during a drag.

### Collision ownership

dnd-kit owns sensing, droppable measurement, sortable transforms, auto-scroll, and collision
ranking. The client adds only the category rules that dnd-kit cannot infer.

The overlay may change height, but category ownership always uses a collision rectangle rebuilt
from the original source size and captured pointer position. Morphing therefore cannot select the
category that controls its own size.

The visible top of each category defines its boundary. The cursor crossing the thin Regular divider
switches between Pinned and Regular. This makes pinning and unpinning symmetric at the divider.
Snoozed and Settled take ownership only after the source row center crosses their visible header,
so touching a shelf does not steal the last Regular slot.

After one category owns the drag, invalid destinations are removed. `pointerWithin` chooses an exact
row or boundary when possible; `closestCenter` fills the gaps between visible droppables. The active
row remains a candidate. Same-category Pinned reorder bypasses `pointerWithin` and uses dnd-kit's
measured rectangles with `closestCenter`, matching a normal sortable list without feeding transformed
row positions back into collision detection. Leaving the board width clears the target.

### Sortable projection and FLIP

Pinned keeps the hovered before or after edge because its order is manual. Regular and Settled
resolve the source through their normal sidebar sorters on release. Snoozed resolves its natural
position after the user chooses a wake time.

While dragging, a small sorting-strategy adapter turns the semantic target into a prospective flat
index and delegates to `verticalListSortingStrategy`. It adjusts dnd-kit's displacement only when
the card and compact heights differ. This opens a correctly sized target slot while the source row
continues to occupy its original slot. Same-category Pinned reorder uses dnd-kit's `overIndex`
without that projected-index override.

On release, React renders the projected target order. The destination copy remains invisible and
acts as the overlay's drop target. dnd-kit's `DragOverlay` drop animation moves the visible row from
its release rectangle to that target. Other rows use dnd-kit's sortable FLIP. The destination copy
disables its own cross-category layout transition so it does not replay a second source-to-target
move. The lifecycle command starts after the overlay animation completes. Reduced-motion clients
complete the handoff immediately.

The sortable gap is the insertion feedback. There is no separate line indicator. Snoozed and
Settled use an absolutely positioned category outline during hover; it takes no list space.

### Viewport stability

dnd-kit auto-scroll is limited to the sidebar viewport and uses its vertical layout-shift
compensation. The board does not add synthetic scroll headroom, which would expose blank space at
the viewport edges.

Some React changes still affect real layout: empty rails appear at activation for Pinned and
Settled, the empty Snoozed header appears, projected entries mount on release, and canonical entries
replace the projection after reconciliation. Empty Regular keeps an absolutely positioned boundary
droppable, which takes no layout space. Before the other changes, the client records one stable
entry's viewport position. After React commits, it changes only the sidebar `scrollTop` by that
entry's visual delta. The content disables native scroll anchoring so the browser and the client do
not both compensate. User scroll and dnd-kit auto-scroll update the anchor baseline.

Pinned reorder does not need manual viewport correction after release. Its membership, category
structure, and total height stay unchanged, so dnd-kit's layout animation is sufficient.

### Persistence

Cross-category drops use the existing lifecycle commands. Their deciders emit the primary event and
any events needed to clear conflicting pinned, settled, or snoozed state in one decision. Drag and
drop adds no command, event, or compatibility path.

`thread.pin.reorder` remains key-only. Moving into Pinned computes the order keys for the visible
position, prepares any neighbor keys, then pins the source with its key. Pinned preserves that
manual order. During an optimistic reorder, pinned rows without reorder capability keep their
existing slots. The other categories use the same sort functions for drop projection and canonical
rendering.

A Snoozed drop holds the projected compact slot while the standard duration menu is open. Choosing
a duration sorts the row by wake time before the drop animation. Cancelling restores the source
order and source preview before dnd-kit starts its return animation, so the card morph and movement
run together.

The projected row remains rendered while the command is pending. Reconciliation ends only after
each affected environment's shell snapshot reaches its receipt sequence. Canonical state then wins.
Changing sidebar scope or entering search clears the projection in every phase. An already-dispatched
command may still complete, but it cannot restore entries from the previous view. During an
interactive phase, the client also cancels if the source disappears, becomes archived, or loses the
needed capability.

## Consequences

There is one drag snapshot, one semantic target, and one projected order. dnd-kit owns pointer
movement, hover sorting, auto-scroll, surrounding-row FLIP, and the final overlay drop animation.
The client owns category semantics, the card-to-compact morph, and one viewport-anchor correction
for real layout changes.

New sidebar categories must join the same flat order. They must define a visible ownership boundary
and use the same transaction and viewport rules.

## Rejected alternatives

### Multiple sortable containers

Separate containers match the projected data but not the interaction. Moving a row changes later
containers' positions between collision passes and makes the target escape the pointer.

### Physically reorder on every hover

Changing the DOM array on every collision changes the rectangles used by the next collision. A
stationary pointer can alternate between targets. Sortable transforms provide the same visual
movement without changing layout.

### Move the real row under the pointer

The real row must keep its source slot measured while dnd-kit sorts siblings. Making that node fixed
or moving it between categories couples its card-to-compact height change to list geometry and hit
testing. A `DragOverlay` separates the pointer visual from the invisible source slot and supplies a
tested drop animation.

### A separate drop indicator

The sortable gap already shows the insertion index. Another line duplicates the same state. Category
outlines communicate shelf ownership without consuming list space.

### Target locks and category-specific scroll corrections

Locks, hysteresis, portal rails, and per-category scroll rules preserve stale geometry. The flat
board, source-sized collision rectangle, dnd-kit layout-shift compensation, and one anchor rule cover
the underlying layout changes directly.
