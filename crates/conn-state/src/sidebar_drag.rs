//! Dragging threads in the sidebar (`Sidebar.logic.ts` `resolveSidebarDropTarget`,
//! `planSidebarThreadDrop`, `applySidebarThreadDrop`, `Sidebar.tsx` `isOptimisticDropReleased`,
//! `Sidebar.drag.ts` `createSidebarCollisionDetection` and `createSidebarSortingStrategy`): which
//! section a drop lands in, which commands it needs, what the list looks like while the row is
//! held, and the action sweep over a run of rows. Plain data in and out, so the iPhone app can
//! share it.
//!
//! Conn lists Working and Snoozed shelves too; `docs/scope.md` #9 drops both, so a thread is
//! pinned, active or settled here. Conn's `reorderableKeys` guards a thread in an environment that
//! is not connected; this client has one environment per window, so the caller checks it once.

use std::collections::{HashMap, HashSet};

use conn_contract::{
    OrchestrationV2AppThreadSettledOverride as SettledOverride,
    OrchestrationV2ThreadShell as ThreadShell,
};

use crate::order_keys::{OrderAssignment, plan_reorder};

/// `SIDEBAR_DRAG_DISTANCE`: the pointer moves this far before a press becomes a drag.
pub const DRAG_DISTANCE_PX: f32 = 6.0;
/// `SIDEBAR_DRAG_LABEL_HEIGHT`: the room a boundary label opens while a row is held.
pub const BOUNDARY_LABEL_HEIGHT_PX: f32 = 24.0;

/// Where a thread sits in the sidebar.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Pinned,
    Active,
    Settled,
}

/// The zero-height rows between the sections (`SidebarListMarker`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Marker {
    PinnedHeader,
    PinnedDivider,
    ActivePlaceholder,
    SettledHeader,
    SettledPlaceholder,
}

/// One row of the list a drag works on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ListItem {
    Thread { id: String, section: Section },
    Marker(Marker),
}

/// The list in the order it is drawn: `Pinned` label, pinned rows, `Active` label, the Active
/// placeholder, active rows, the Settled header, its placeholder, then the settled rows shown.
#[must_use]
pub fn list_items(pinned: &[String], active: &[String], settled: &[String]) -> Vec<ListItem> {
    fn rows(ids: &[String], section: Section) -> impl Iterator<Item = ListItem> + '_ {
        ids.iter().map(move |id| ListItem::Thread {
            id: id.clone(),
            section,
        })
    }
    let mut items = vec![ListItem::Marker(Marker::PinnedHeader)];
    items.extend(rows(pinned, Section::Pinned));
    items.push(ListItem::Marker(Marker::PinnedDivider));
    items.push(ListItem::Marker(Marker::ActivePlaceholder));
    items.extend(rows(active, Section::Active));
    items.push(ListItem::Marker(Marker::SettledHeader));
    items.push(ListItem::Marker(Marker::SettledPlaceholder));
    items.extend(rows(settled, Section::Settled));
    items
}

fn section_at_slot(items: &[ListItem], index: usize) -> Section {
    let mut section = Section::Pinned;
    for item in items.iter().take(index) {
        match item {
            ListItem::Marker(Marker::PinnedDivider) => section = Section::Active,
            ListItem::Marker(Marker::SettledHeader) => section = Section::Settled,
            _ => {}
        }
    }
    section
}

/// Where a dragged row would land.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DropTarget {
    pub section: Section,
    /// The pinned rows in their order after the drop.
    pub pinned_order: Vec<String>,
    /// The active rows in their order after the drop.
    pub active_order: Vec<String>,
}

/// The drop that holding `active_id` over the row at `over_index` would make
/// (`resolveSidebarDropTarget`).
#[must_use]
pub fn resolve_drop_target(
    items: &[ListItem],
    active_id: &str,
    over_index: usize,
) -> Option<DropTarget> {
    let active_index = items
        .iter()
        .position(|item| matches!(item, ListItem::Thread { id, .. } if id == active_id))?;
    if over_index >= items.len() {
        return None;
    }
    let mut moved: Vec<&ListItem> = items.iter().collect();
    let held = moved.remove(active_index);
    moved.insert(over_index, held);
    let owned: Vec<ListItem> = moved.iter().map(|item| (*item).clone()).collect();
    let section = section_at_slot(&owned, over_index);
    let mut pinned_order = Vec::new();
    let mut active_order = Vec::new();
    let mut current = Section::Pinned;
    for item in &owned {
        match item {
            ListItem::Marker(Marker::PinnedDivider) => current = Section::Active,
            ListItem::Marker(Marker::SettledHeader) => break,
            ListItem::Marker(_) => {}
            ListItem::Thread { id, .. } if current == Section::Pinned => {
                pinned_order.push(id.clone());
            }
            ListItem::Thread { id, .. } => active_order.push(id.clone()),
        }
    }
    Some(DropTarget {
        section,
        pinned_order,
        active_order,
    })
}

/// The badge a held row wears for where it would land (`SidebarDropVerb`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DropVerb {
    Pin,
    Unpin,
    Settle,
    Unsettle,
}

impl DropVerb {
    /// The badge text.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Pin => "Pin",
            Self::Unpin => "Unpin",
            Self::Settle => "Settle",
            Self::Unsettle => "Un-settle",
        }
    }
}

/// `resolveSidebarDropVerb`: none while the row stays in its section.
#[must_use]
pub fn drop_verb(from: Section, to: Option<Section>) -> Option<DropVerb> {
    match to? {
        to if to == from => None,
        Section::Pinned => Some(DropVerb::Pin),
        Section::Settled => Some(DropVerb::Settle),
        Section::Active if from == Section::Pinned => Some(DropVerb::Unpin),
        Section::Active => Some(DropVerb::Unsettle),
    }
}

/// What a drop does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DropPlan {
    None,
    /// `thread.pin.reorder` for each assignment.
    ReorderPinned {
        order: Vec<String>,
        assignments: Vec<OrderAssignment>,
    },
    /// `thread.pin` with `order_key`, then `thread.pin.reorder` for the extra assignments.
    Pin {
        order: Vec<String>,
        order_key: Option<String>,
        extra: Vec<OrderAssignment>,
    },
    /// Unpin and un-settle as needed, then `thread.active.reorder` for each assignment.
    MoveActive {
        order: Vec<String>,
        assignments: Vec<OrderAssignment>,
        unpin: bool,
        unsettle: bool,
    },
    /// `thread.settle`.
    Settle,
}

/// What `plan_thread_drop` needs to know about the held row and the lists.
#[derive(Debug)]
pub struct DropInput<'a> {
    pub active_id: &'a str,
    pub from: Section,
    pub target: &'a DropTarget,
    /// The pinned rows now, in order.
    pub pinned_order: &'a [String],
    /// Every thread's `pinOrderKey`, hidden rows included.
    pub pinned_keys: &'a HashMap<String, Option<String>>,
    /// The active rows now, in order.
    pub active_order: &'a [String],
    /// Every thread's `activeOrderKey`.
    pub active_keys: &'a HashMap<String, Option<String>>,
    /// The server takes settle and un-settle (`supportsSettlement`).
    pub supports_settlement: bool,
}

/// The commands a drop needs (`planSidebarThreadDrop`).
#[must_use]
pub fn plan_thread_drop(input: &DropInput<'_>) -> DropPlan {
    let DropInput {
        active_id,
        from,
        target,
        ..
    } = input;
    if !input.supports_settlement
        && (target.section == Section::Settled || *from == Section::Settled)
    {
        return DropPlan::None;
    }
    let same = |left: &[String], right: &[String]| left == right;
    match target.section {
        Section::Active => {
            if *from == Section::Active && same(&target.active_order, input.active_order) {
                return DropPlan::None;
            }
            DropPlan::MoveActive {
                order: target.active_order.clone(),
                assignments: plan_reorder(&target.active_order, input.active_keys, active_id),
                unpin: *from == Section::Pinned,
                unsettle: *from == Section::Settled,
            }
        }
        Section::Settled => {
            if *from == Section::Settled {
                DropPlan::None
            } else {
                DropPlan::Settle
            }
        }
        Section::Pinned => {
            if *from == Section::Pinned && same(&target.pinned_order, input.pinned_order) {
                return DropPlan::None;
            }
            let assignments = plan_reorder(&target.pinned_order, input.pinned_keys, active_id);
            if *from == Section::Pinned {
                return if assignments.is_empty() {
                    DropPlan::None
                } else {
                    DropPlan::ReorderPinned {
                        order: target.pinned_order.clone(),
                        assignments,
                    }
                };
            }
            DropPlan::Pin {
                order: target.pinned_order.clone(),
                order_key: assignments
                    .iter()
                    .find(|a| a.id == *active_id)
                    .map(|a| a.order_key.clone()),
                extra: assignments
                    .into_iter()
                    .filter(|a| a.id != *active_id)
                    .collect(),
            }
        }
    }
}

/// The section of a thread as the server has it.
#[must_use]
pub fn thread_section(thread: &ThreadShell) -> Section {
    if crate::ShellState::is_settled(thread) {
        Section::Settled
    } else if thread.pinned_at.as_ref().is_some_and(Option::is_some) {
        Section::Pinned
    } else {
        Section::Active
    }
}

/// `applySidebarThreadDrop`: the thread as it will be once the drop is through, so the list
/// does not jump back while the commands travel.
pub fn apply_drop(thread: &mut ThreadShell, section: Section, now: &str, order_key: Option<&str>) {
    let was_settled = thread_section(thread) == Section::Settled;
    if section == Section::Settled {
        thread.pinned_at = Some(None);
        thread.pin_order_key = Some(None);
        thread.active_order_key = Some(None);
        thread.settled_override = Some(SettledOverride::Settled);
        if !was_settled || thread.settled_at.is_none() {
            thread.settled_at = Some(now.to_owned());
        }
        thread.unsettled_at = Some(None);
        return;
    }
    if was_settled {
        thread.settled_override = Some(SettledOverride::Active);
        thread.settled_at = None;
        thread.archived_at = None;
        thread.unsettled_at = Some(Some(now.to_owned()));
    }
    if section == Section::Pinned {
        if !thread.pinned_at.as_ref().is_some_and(Option::is_some) {
            thread.pinned_at = Some(Some(now.to_owned()));
        }
        if let Some(key) = order_key {
            thread.pin_order_key = Some(Some(key.to_owned()));
        }
    } else {
        thread.pinned_at = Some(None);
        thread.pin_order_key = Some(None);
        if let Some(key) = order_key {
            thread.active_order_key = Some(Some(key.to_owned()));
        }
    }
}

/// A drop the server has not caught up with yet (`SidebarOptimisticDrop`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OptimisticDrop {
    pub id: String,
    pub source: Section,
    pub section: Section,
    pub occurred_at: String,
    /// The destination order the drop made; `None` for a settle.
    pub order: Option<Vec<String>>,
    /// The destination's keys when the drop happened.
    pub keys_at_drop: HashMap<String, Option<String>>,
    /// The keys the drop writes.
    pub assigned: HashMap<String, String>,
}

impl OptimisticDrop {
    /// The drop of `plan` for the held thread, or none when the plan changes nothing.
    #[must_use]
    pub fn new(
        plan: &DropPlan,
        id: &str,
        source: Section,
        target: Section,
        occurred_at: &str,
        pinned_keys: &HashMap<String, Option<String>>,
        active_keys: &HashMap<String, Option<String>>,
    ) -> Option<Self> {
        let pairs = |list: &[OrderAssignment]| -> Vec<(String, String)> {
            list.iter()
                .map(|a| (a.id.clone(), a.order_key.clone()))
                .collect()
        };
        let (order, assigned): (Option<Vec<String>>, Vec<(String, String)>) = match plan {
            DropPlan::None => return None,
            DropPlan::Settle => (None, Vec::new()),
            DropPlan::ReorderPinned { order, assignments }
            | DropPlan::MoveActive {
                order, assignments, ..
            } => (Some(order.clone()), pairs(assignments)),
            DropPlan::Pin {
                order,
                order_key,
                extra,
            } => (
                Some(order.clone()),
                order_key
                    .iter()
                    .map(|key| (id.to_owned(), key.clone()))
                    .chain(pairs(extra))
                    .collect(),
            ),
        };
        Some(Self {
            id: id.to_owned(),
            source,
            section: target,
            occurred_at: occurred_at.to_owned(),
            order,
            keys_at_drop: if target == Section::Active {
                active_keys.clone()
            } else {
                pinned_keys.clone()
            },
            assigned: assigned.into_iter().collect(),
        })
    }

    /// The key the held thread gets, for the projection.
    #[must_use]
    pub fn own_key(&self) -> Option<&str> {
        self.assigned.get(&self.id).map(String::as_str)
    }
}

/// `isOptimisticDropReleased`: the server's shell shows the drop through (or something else
/// moved the thread), so the projection ends. `pinned` and `active` are the server's own lists.
#[must_use]
pub fn drop_released(
    drop: &OptimisticDrop,
    threads: &[ThreadShell],
    pinned: &[String],
    active: &[String],
) -> bool {
    let Some(thread) = threads.iter().find(|t| t.id == drop.id) else {
        return true;
    };
    if thread.deleted_at.is_some() {
        return true;
    }
    let canonical = thread_section(thread);
    if canonical != drop.source && canonical != drop.section {
        return true;
    }
    let Some(order) = &drop.order else {
        return canonical == drop.section
            && !thread.pinned_at.as_ref().is_some_and(Option::is_some);
    };
    if canonical != drop.section {
        return false;
    }
    let destination = if drop.section == Section::Pinned {
        pinned
    } else {
        active
    };
    let key_of = |id: &str| -> Option<&str> {
        let thread = threads.iter().find(|t| t.id == id)?;
        let key = if drop.section == Section::Pinned {
            &thread.pin_order_key
        } else {
            &thread.active_order_key
        };
        key.as_ref().and_then(Option::as_deref)
    };
    let held: HashSet<&str> = order.iter().map(String::as_str).collect();
    let membership_changed = destination.len() != order.len()
        || destination.iter().any(|id| !held.contains(id.as_str()));
    let foreign_key_landed = destination.iter().any(|id| {
        let current = key_of(id);
        let at_drop = drop.keys_at_drop.get(id).and_then(Option::as_deref);
        current != at_drop && current != drop.assigned.get(id).map(String::as_str)
    });
    let all_landed = drop
        .assigned
        .iter()
        .all(|(id, key)| key_of(id) == Some(key.as_str()));
    membership_changed || foreign_key_landed || all_landed
}

/// `orderItemsByPreferredIds`: the ids in `preferred` order first (those `ids` holds), then the
/// rest as they were. A drop keeps its destination in the order it made until the server's keys
/// land.
#[must_use]
pub fn order_by_preferred(ids: &[String], preferred: &[String]) -> Vec<String> {
    let held: HashSet<&String> = ids.iter().collect();
    let mut emitted: HashSet<&String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::with_capacity(ids.len());
    for id in preferred {
        if held.contains(id) && emitted.insert(id) {
            ordered.push(id.clone());
        }
    }
    ordered.extend(ids.iter().filter(|id| !emitted.contains(id)).cloned());
    ordered
}

/// A row's painted extent, top to bottom, in window coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Extent {
    pub top: f32,
    pub bottom: f32,
}

impl Extent {
    fn center(self) -> f32 {
        f32::midpoint(self.top, self.bottom)
    }
}

/// The painted extent of every item of `items` as the list rests, from the rows' painted extents
/// (`rows`) and the Settled header's. A marker has no height at rest: it sits where the row
/// before it ends, and the Settled header keeps its own extent.
#[must_use]
pub fn item_extents(
    items: &[ListItem],
    rows: &HashMap<String, Extent>,
    first_row_top: f32,
    settled_header: Option<Extent>,
) -> Vec<Extent> {
    let mut cursor = first_row_top;
    items
        .iter()
        .map(|item| match item {
            ListItem::Thread { id, .. } => match rows.get(id) {
                Some(extent) => {
                    cursor = extent.bottom;
                    *extent
                }
                None => Extent {
                    top: cursor,
                    bottom: cursor,
                },
            },
            ListItem::Marker(Marker::SettledHeader) => match settled_header {
                Some(extent) => {
                    cursor = extent.bottom;
                    extent
                }
                None => Extent {
                    top: cursor,
                    bottom: cursor,
                },
            },
            ListItem::Marker(_) => Extent {
                top: cursor,
                bottom: cursor,
            },
        })
        .collect()
}

/// `.sidebar-drag-boundary-label` of the Pinned divider: `top-1 h-4` below where the divider sits.
#[must_use]
pub fn boundary_label_extent(divider: Extent) -> Extent {
    Extent {
        top: divider.top + 4.0,
        bottom: divider.top + 20.0,
    }
}

/// `restrictBelowSidebarLabel`: the lowest the held row's centre may sit above the Pinned label,
/// so the row never rides over it (`label_top` is the top of the first marker).
#[must_use]
pub fn min_held_center(label_top: f32, held_height: f32) -> f32 {
    label_top + BOUNDARY_LABEL_HEIGHT_PX + held_height / 2.0
}

/// What the collision detector reads for one pointer position.
pub struct CollisionInput<'a> {
    pub items: &'a [ListItem],
    pub active_id: &'a str,
    /// The painted extent of each item, taken when the row was picked up.
    pub extents: &'a [Extent],
    /// The vertical centre of the held row.
    pub center_y: f32,
    pub pointer_y: f32,
    /// The `Active` boundary label (`.sidebar-drag-boundary-label`).
    pub boundary: Option<Extent>,
    /// The top of the first shelf header, where Active ends.
    pub shelf_top: Option<f32>,
    /// Whether the plan of dropping over item `index` does anything (`isValidTarget`).
    pub is_valid: &'a dyn Fn(usize) -> bool,
}

impl std::fmt::Debug for CollisionInput<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CollisionInput").finish_non_exhaustive()
    }
}

/// `createSidebarCollisionDetection`: which row the held row is over. Keeps what the pointer
/// last did, so a held row crossing the Pinned and Active boundary follows the pointer's
/// direction, not whatever the opening section pushes under it.
#[derive(Clone, Debug, Default)]
pub struct Collision {
    boundary_section: Option<Section>,
    previous_pointer_y: Option<f32>,
}

impl Collision {
    /// A detector for a drag that began with the pointer at `activation_y`.
    #[must_use]
    pub fn new(activation_y: f32) -> Self {
        Self {
            boundary_section: None,
            previous_pointer_y: Some(activation_y),
        }
    }

    /// The index of the item the held row is over.
    pub fn over(&mut self, input: &CollisionInput<'_>) -> usize {
        let active_index = input
            .items
            .iter()
            .position(|item| matches!(item, ListItem::Thread { id, .. } if id == input.active_id))
            .unwrap_or(0);
        let mut order: Vec<usize> = (0..input.items.len().min(input.extents.len())).collect();
        order.sort_by(|a, b| {
            let da = (input.extents[*a].center() - input.center_y).abs();
            let db = (input.extents[*b].center() - input.center_y).abs();
            da.total_cmp(&db)
        });
        if let Some(boundary) = input.boundary {
            let held_section = match input.items.get(active_index) {
                Some(ListItem::Thread { section, .. }) => *section,
                _ => Section::Active,
            };
            let section = self
                .boundary_section
                .get_or_insert(if held_section == Section::Pinned {
                    Section::Pinned
                } else {
                    Section::Active
                });
            // Only pointer movement changes sections; opening the destination moves rows under
            // a stationary pointer.
            let previous = self.previous_pointer_y.unwrap_or(input.pointer_y);
            self.previous_pointer_y = Some(input.pointer_y);
            if input.pointer_y < previous && input.pointer_y <= boundary.bottom {
                *section = Section::Pinned;
            } else if input.pointer_y > previous && input.pointer_y >= boundary.top {
                *section = Section::Active;
            }
            let wanted = *section;
            let active_ends = input.shelf_top;
            if wanted == Section::Pinned || active_ends.is_some_and(|end| input.pointer_y < end) {
                let hit = order.iter().position(|index| {
                    resolve_drop_target(input.items, input.active_id, *index)
                        .is_some_and(|target| target.section == wanted)
                });
                if let Some(at) = hit {
                    let found = order.remove(at);
                    order.insert(0, found);
                }
            }
        }
        match order.first() {
            Some(nearest) if *nearest != active_index && !(input.is_valid)(*nearest) => {
                active_index
            }
            Some(nearest) => *nearest,
            None => active_index,
        }
    }
}

/// The lists as they will look if the held row drops where it is: the held row sits in its
/// target slot (`createSidebarSortingStrategy`'s projection), so the rows around it make room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Projection {
    pub pinned: Vec<String>,
    pub active: Vec<String>,
    pub settled: Vec<String>,
}

/// `settled` is the rows the shelf shows now, newest first; `shelf_open` says whether the held
/// row would show in it.
#[must_use]
pub fn project(
    held: &str,
    target: &DropTarget,
    pinned: &[String],
    active: &[String],
    settled: &[String],
    shelf_open: bool,
) -> Projection {
    let without = |list: &[String]| -> Vec<String> {
        list.iter().filter(|id| *id != held).cloned().collect()
    };
    let mut settled_rows = without(settled);
    if target.section == Section::Settled && shelf_open {
        // It settles now, so it is the newest.
        settled_rows.insert(0, held.to_owned());
    }
    Projection {
        pinned: if target.section == Section::Pinned {
            target.pinned_order.clone()
        } else {
            without(pinned)
        },
        active: if target.section == Section::Active {
            target.active_order.clone()
        } else {
            without(active)
        },
        settled: settled_rows,
    }
}

/// Whether a section's empty placeholder shows its dashed hint while a row is held
/// (`SidebarSectionPlaceholder` `showHint`).
#[must_use]
pub fn placeholder_hint(
    section: Section,
    held_from: Option<Section>,
    rows_shown: usize,
    target: Option<Section>,
) -> bool {
    let Some(from) = held_from else {
        return false;
    };
    rows_shown == 0
        || (from == section && rows_shown == 1 && target.is_some_and(|target| target != section))
}

/// What a press on a row's Settle or Un-settle button sweeps (`SidebarSweepAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SweepAction {
    Settle,
    Unsettle,
}

impl SweepAction {
    /// The badge a swept row wears.
    #[must_use]
    pub fn verb(self) -> DropVerb {
        match self {
            Self::Settle => DropVerb::Settle,
            Self::Unsettle => DropVerb::Unsettle,
        }
    }
}

/// `resolveSidebarSweepKeys`: the rows from `origin` to `target` in list order, those the
/// action applies to.
#[must_use]
pub fn sweep_keys(
    ordered: &[String],
    origin: &str,
    target: &str,
    can_apply: impl Fn(&str) -> bool,
) -> Vec<String> {
    let (Some(from), Some(to)) = (
        ordered.iter().position(|id| id == origin),
        ordered.iter().position(|id| id == target),
    ) else {
        return Vec::new();
    };
    ordered[from.min(to)..=from.max(to)]
        .iter()
        .filter(|id| can_apply(id))
        .cloned()
        .collect()
}

/// `sidebarThreadKeyAtY`: the last row whose top is at or above `y`, `y` held inside the
/// viewport; the first row when `y` is above them all.
#[must_use]
pub fn row_at_y(rows: &[(String, f32)], y: f32, viewport: Option<Extent>) -> Option<&str> {
    let visible_y = viewport.map_or(y, |v| y.clamp(v.top, (v.bottom - 1.0).max(v.top)));
    let mut found = None;
    for (id, top) in rows {
        if found.is_some() && *top > visible_y {
            break;
        }
        found = Some(id.as_str());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_threads::thread;
    use serde_json::json;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    fn items() -> Vec<ListItem> {
        list_items(
            &ids(&["p1", "p2"]),
            &ids(&["a1", "a2", "a3"]),
            &ids(&["s1"]),
        )
    }

    fn index_of(items: &[ListItem], id: &str) -> usize {
        items
            .iter()
            .position(|item| matches!(item, ListItem::Thread { id: found, .. } if found == id))
            .unwrap_or(usize::MAX)
    }

    fn no_keys() -> HashMap<String, Option<String>> {
        HashMap::new()
    }

    #[test]
    fn holding_a_row_over_another_puts_it_in_that_slot() {
        let items = items();
        let target = resolve_drop_target(&items, "a1", index_of(&items, "a3")).unwrap();
        assert_eq!(target.section, Section::Active);
        assert_eq!(target.active_order, ids(&["a2", "a3", "a1"]));
        assert_eq!(target.pinned_order, ids(&["p1", "p2"]));
    }

    #[test]
    fn holding_a_row_above_the_divider_pins_it_and_below_the_settled_header_settles_it() {
        let items = items();
        let pinned = resolve_drop_target(&items, "a2", index_of(&items, "p2")).unwrap();
        assert_eq!(pinned.section, Section::Pinned);
        assert_eq!(pinned.pinned_order, ids(&["p1", "a2", "p2"]));
        let settled = resolve_drop_target(&items, "a2", index_of(&items, "s1")).unwrap();
        assert_eq!(settled.section, Section::Settled);
        let marker = items
            .iter()
            .position(|i| *i == ListItem::Marker(Marker::SettledPlaceholder))
            .unwrap();
        assert_eq!(
            resolve_drop_target(&items, "a2", marker).unwrap().section,
            Section::Settled
        );
        assert!(resolve_drop_target(&items, "nope", 0).is_none());
        assert!(resolve_drop_target(&items, "a1", 99).is_none());
    }

    #[test]
    fn an_empty_pinned_section_still_takes_a_drop_at_the_divider() {
        let items = list_items(&[], &ids(&["a1", "a2"]), &[]);
        let divider = items
            .iter()
            .position(|i| *i == ListItem::Marker(Marker::PinnedDivider))
            .unwrap();
        let target = resolve_drop_target(&items, "a1", divider).unwrap();
        assert_eq!(target.section, Section::Pinned);
        assert_eq!(target.pinned_order, ids(&["a1"]));
    }

    #[test]
    fn verbs_name_the_section_change() {
        use Section::{Active, Pinned, Settled};
        assert_eq!(drop_verb(Active, Some(Pinned)), Some(DropVerb::Pin));
        assert_eq!(drop_verb(Pinned, Some(Active)), Some(DropVerb::Unpin));
        assert_eq!(drop_verb(Active, Some(Settled)), Some(DropVerb::Settle));
        assert_eq!(drop_verb(Settled, Some(Active)), Some(DropVerb::Unsettle));
        assert_eq!(drop_verb(Settled, Some(Pinned)), Some(DropVerb::Pin));
        assert_eq!(drop_verb(Active, Some(Active)), None);
        assert_eq!(drop_verb(Active, None), None);
    }

    fn plan(from: Section, target: &DropTarget, held: &str) -> DropPlan {
        let pinned = ids(&["p1", "p2"]);
        let active = ids(&["a1", "a2", "a3"]);
        plan_thread_drop(&DropInput {
            active_id: held,
            from,
            target,
            pinned_order: &pinned,
            pinned_keys: &no_keys(),
            active_order: &active,
            active_keys: &no_keys(),
            supports_settlement: true,
        })
    }

    #[test]
    fn a_drop_in_place_does_nothing() {
        let items = items();
        let target = resolve_drop_target(&items, "a2", index_of(&items, "a2")).unwrap();
        assert_eq!(plan(Section::Active, &target, "a2"), DropPlan::None);
    }

    #[test]
    fn reordering_active_rows_writes_keys_for_the_new_order() {
        let items = items();
        let target = resolve_drop_target(&items, "a1", index_of(&items, "a3")).unwrap();
        let DropPlan::MoveActive {
            order,
            assignments,
            unpin,
            unsettle,
        } = plan(Section::Active, &target, "a1")
        else {
            panic!("expected a move");
        };
        assert_eq!(order, ids(&["a2", "a3", "a1"]));
        assert!(!unpin && !unsettle);
        // No row has a key, so the section is rewritten in order.
        assert_eq!(assignments.len(), 3);
        assert!(
            assignments
                .windows(2)
                .all(|pair| pair[0].order_key < pair[1].order_key)
        );
    }

    #[test]
    fn pinning_carries_the_new_key_and_settling_needs_no_order() {
        let items = items();
        let pin = resolve_drop_target(&items, "a1", index_of(&items, "p1")).unwrap();
        match plan(Section::Active, &pin, "a1") {
            DropPlan::Pin { order_key, .. } => assert!(order_key.is_some()),
            other => panic!("expected a pin, got {other:?}"),
        }
        let settle = resolve_drop_target(&items, "a1", index_of(&items, "s1")).unwrap();
        assert_eq!(plan(Section::Active, &settle, "a1"), DropPlan::Settle);
        assert_eq!(plan(Section::Settled, &settle, "s1"), DropPlan::None);
    }

    #[test]
    fn a_server_without_settlement_refuses_every_settled_drop() {
        let items = items();
        let settle = resolve_drop_target(&items, "a1", index_of(&items, "s1")).unwrap();
        let pinned = ids(&["p1", "p2"]);
        let active = ids(&["a1", "a2", "a3"]);
        let refused = plan_thread_drop(&DropInput {
            active_id: "a1",
            from: Section::Active,
            target: &settle,
            pinned_order: &pinned,
            pinned_keys: &no_keys(),
            active_order: &active,
            active_keys: &no_keys(),
            supports_settlement: false,
        });
        assert_eq!(refused, DropPlan::None);
    }

    #[test]
    fn the_projection_leaves_a_slot_for_the_held_row_in_its_target() {
        let items = items();
        let target = resolve_drop_target(&items, "a1", index_of(&items, "p2")).unwrap();
        let shown = project(
            "a1",
            &target,
            &ids(&["p1", "p2"]),
            &ids(&["a1", "a2", "a3"]),
            &ids(&["s1"]),
            true,
        );
        assert_eq!(shown.pinned, ids(&["p1", "a1", "p2"]));
        assert_eq!(shown.active, ids(&["a2", "a3"]));
        let settle = resolve_drop_target(&items, "a1", index_of(&items, "s1")).unwrap();
        let shelf = project(
            "a1",
            &settle,
            &ids(&["p1", "p2"]),
            &ids(&["a1", "a2", "a3"]),
            &ids(&["s1"]),
            true,
        );
        assert_eq!(shelf.settled, ids(&["a1", "s1"]));
        let closed = project(
            "a1",
            &settle,
            &ids(&["p1", "p2"]),
            &ids(&["a1", "a2", "a3"]),
            &[],
            false,
        );
        assert!(closed.settled.is_empty());
    }

    #[test]
    fn placeholders_hint_only_while_a_row_is_held_and_the_section_has_no_other_row() {
        use Section::{Active, Settled};
        assert!(!placeholder_hint(Active, None, 0, None));
        assert!(placeholder_hint(Active, Some(Settled), 0, Some(Settled)));
        assert!(placeholder_hint(Active, Some(Active), 1, Some(Settled)));
        assert!(!placeholder_hint(Active, Some(Active), 1, Some(Active)));
        assert!(!placeholder_hint(Active, Some(Settled), 2, Some(Active)));
    }

    #[test]
    fn a_sweep_covers_the_rows_between_the_ends_that_the_action_applies_to() {
        let order = ids(&["p1", "a1", "a2", "a3", "s1"]);
        let active = |id: &str| id.starts_with('a');
        assert_eq!(
            sweep_keys(&order, "a1", "a3", active),
            ids(&["a1", "a2", "a3"])
        );
        assert_eq!(
            sweep_keys(&order, "a3", "p1", active),
            ids(&["a1", "a2", "a3"])
        );
        assert_eq!(sweep_keys(&order, "a2", "a2", active), ids(&["a2"]));
        assert!(sweep_keys(&order, "a2", "zz", active).is_empty());
    }

    #[test]
    fn the_row_under_the_pointer_is_the_last_one_that_starts_above_it() {
        let rows = vec![
            ("a".to_owned(), 0.0),
            ("b".to_owned(), 40.0),
            ("c".to_owned(), 80.0),
        ];
        assert_eq!(row_at_y(&rows, 45.0, None), Some("b"));
        assert_eq!(row_at_y(&rows, -20.0, None), Some("a"));
        assert_eq!(row_at_y(&rows, 500.0, None), Some("c"));
        let viewport = Extent {
            top: 0.0,
            bottom: 50.0,
        };
        assert_eq!(row_at_y(&rows, 500.0, Some(viewport)), Some("b"));
        assert_eq!(row_at_y(&[], 5.0, None), None);
    }

    #[test]
    fn the_collision_detector_picks_the_nearest_centre_and_refuses_a_target_that_does_nothing() {
        let items = items();
        // One 40px row per thread, markers have no height.
        let mut top = 0.0;
        let extents: Vec<Extent> = items
            .iter()
            .map(|item| {
                let height = if matches!(item, ListItem::Thread { .. }) {
                    40.0
                } else {
                    0.0
                };
                let extent = Extent {
                    top,
                    bottom: top + height,
                };
                top += height;
                extent
            })
            .collect();
        let accept = |_: usize| true;
        let mut collision = Collision::default();
        let input = CollisionInput {
            items: &items,
            active_id: "a1",
            extents: &extents,
            center_y: extents[index_of(&items, "a3")].center(),
            pointer_y: 0.0,
            boundary: None,
            shelf_top: None,
            is_valid: &accept,
        };
        assert_eq!(collision.over(&input), index_of(&items, "a3"));
        let refuse = |_: usize| false;
        let refused = CollisionInput {
            is_valid: &refuse,
            ..input
        };
        assert_eq!(collision.over(&refused), index_of(&items, "a1"));
    }

    #[test]
    fn crossing_the_boundary_follows_the_pointer_direction() {
        let items = list_items(&ids(&["p1"]), &ids(&["a1", "a2"]), &[]);
        let mut top = 0.0;
        let extents: Vec<Extent> = items
            .iter()
            .map(|item| {
                let height = if matches!(item, ListItem::Thread { .. }) {
                    40.0
                } else {
                    0.0
                };
                let extent = Extent {
                    top,
                    bottom: top + height,
                };
                top += height;
                extent
            })
            .collect();
        let divider = items
            .iter()
            .position(|i| *i == ListItem::Marker(Marker::PinnedDivider))
            .unwrap();
        let boundary = Extent {
            top: extents[divider].top + 4.0,
            bottom: extents[divider].top + 20.0,
        };
        let accept = |_: usize| true;
        let mut collision = Collision::new(60.0);
        // Pulled up into the label: the pinned section wins even though a1 is nearer.
        let up = CollisionInput {
            items: &items,
            active_id: "a1",
            extents: &extents,
            center_y: extents[index_of(&items, "a1")].center(),
            pointer_y: 30.0,
            boundary: Some(boundary),
            shelf_top: Some(1000.0),
            is_valid: &accept,
        };
        let over = collision.over(&up);
        assert_eq!(
            resolve_drop_target(&items, "a1", over).unwrap().section,
            Section::Pinned
        );
    }

    fn drop_for(plan: &DropPlan, held: &str, from: Section, to: Section) -> OptimisticDrop {
        OptimisticDrop::new(
            plan,
            held,
            from,
            to,
            "2026-11-20T10:00:00.000Z",
            &no_keys(),
            &no_keys(),
        )
        .unwrap()
    }

    #[test]
    fn applying_a_settle_clears_pin_and_order_and_stamps_the_time() {
        let mut pinned = thread("t", "p", |t| {
            t["pinnedAt"] = json!("2026-11-13T09:00:00.000Z");
            t["pinOrderKey"] = json!("c");
        });
        apply_drop(
            &mut pinned,
            Section::Settled,
            "2026-11-20T10:00:00.000Z",
            None,
        );
        assert_eq!(thread_section(&pinned), Section::Settled);
        assert_eq!(pinned.pin_order_key, Some(None));
        assert_eq!(
            pinned.settled_at.as_deref(),
            Some("2026-11-20T10:00:00.000Z")
        );
    }

    #[test]
    fn applying_a_move_to_active_unsettles_and_takes_the_key() {
        let mut settled = thread("t", "p", |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!("2026-11-14T09:00:00.000Z");
        });
        apply_drop(
            &mut settled,
            Section::Active,
            "2026-11-20T10:00:00.000Z",
            Some("m"),
        );
        assert_eq!(thread_section(&settled), Section::Active);
        assert_eq!(settled.active_order_key, Some(Some("m".to_owned())));
        assert_eq!(
            settled.unsettled_at,
            Some(Some("2026-11-20T10:00:00.000Z".to_owned()))
        );
        let mut active = thread("u", "p", |_| {});
        apply_drop(
            &mut active,
            Section::Pinned,
            "2026-11-20T10:00:00.000Z",
            Some("c"),
        );
        assert_eq!(thread_section(&active), Section::Pinned);
        assert_eq!(active.pin_order_key, Some(Some("c".to_owned())));
    }

    #[test]
    fn markers_sit_where_the_row_before_them_ends_and_the_settled_header_keeps_its_extent() {
        let items = items();
        let mut rows = HashMap::new();
        let mut top = 10.0;
        for item in &items {
            if let ListItem::Thread { id, .. } = item {
                rows.insert(
                    id.clone(),
                    Extent {
                        top,
                        bottom: top + 40.0,
                    },
                );
                top += 41.0;
            }
        }
        let header = Extent {
            top: 300.0,
            bottom: 332.0,
        };
        let extents = item_extents(&items, &rows, 10.0, Some(header));
        assert_eq!(extents.len(), items.len());
        let at = |marker: Marker| {
            items
                .iter()
                .position(|item| *item == ListItem::Marker(marker))
                .unwrap()
        };
        assert_eq!(extents[at(Marker::PinnedHeader)].top, 10.0);
        let divider = extents[at(Marker::PinnedDivider)];
        assert_eq!(divider.top, divider.bottom);
        assert_eq!(divider.top, rows["p2"].bottom);
        assert_eq!(extents[at(Marker::SettledHeader)], header);
        assert_eq!(extents[at(Marker::SettledPlaceholder)].top, header.bottom);
        assert_eq!(extents[index_of(&items, "a2")], rows["a2"]);
        let label = boundary_label_extent(divider);
        assert_eq!(label.bottom - label.top, 16.0);
        assert_eq!(min_held_center(10.0, 40.0), 54.0);
    }

    #[test]
    fn a_held_destination_order_leads_and_unknown_rows_follow() {
        let ids = ids(&["a", "b", "c", "d"]);
        assert_eq!(
            order_by_preferred(&ids, &["c".to_owned(), "gone".to_owned(), "a".to_owned()]),
            ["c", "a", "b", "d"]
        );
        assert_eq!(order_by_preferred(&ids, &[]), ["a", "b", "c", "d"]);
    }

    #[test]
    fn a_settle_is_released_once_the_server_has_it_settled_and_unpinned() {
        let settle = drop_for(&DropPlan::Settle, "t", Section::Active, Section::Settled);
        let before = thread("t", "p", |_| {});
        assert!(!drop_released(&settle, &[before], &[], &ids(&["t"])));
        let after = thread("t", "p", |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!("2026-11-20T10:00:01.000Z");
        });
        assert!(drop_released(&settle, &[after], &[], &[]));
        // A thread that is gone, or moved somewhere else, ends it too.
        assert!(drop_released(&settle, &[], &[], &[]));
        let elsewhere = thread("t", "p", |t| {
            t["pinnedAt"] = json!("2026-11-20T10:00:01.000Z")
        });
        assert!(drop_released(&settle, &[elsewhere], &ids(&["t"]), &[]));
    }

    #[test]
    fn a_reorder_is_released_when_the_assigned_keys_land() {
        let plan = DropPlan::MoveActive {
            order: ids(&["a2", "a1"]),
            assignments: vec![OrderAssignment {
                id: "a1".to_owned(),
                order_key: "z".to_owned(),
            }],
            unpin: false,
            unsettle: false,
        };
        let held = drop_for(&plan, "a1", Section::Active, Section::Active);
        let a1 = thread("a1", "p", |_| {});
        let a2 = thread("a2", "p", |_| {});
        assert!(!drop_released(
            &held,
            &[a1, a2.clone()],
            &[],
            &ids(&["a1", "a2"])
        ));
        let landed = thread("a1", "p", |t| t["activeOrderKey"] = json!("z"));
        assert!(drop_released(
            &held,
            &[landed, a2],
            &[],
            &ids(&["a2", "a1"])
        ));
    }
}
