//! Pure state of the workspace rail's edits: dragging a tile to a new place, and `Remove
//! workspace`.
//!
//! The spec is Conn's rail: `WorkspaceRail.tsx` (`@dnd-kit` `PointerSensor` with a 6px
//! `activationConstraint.distance`, `restrictToVerticalAxis`, `closestCenter`),
//! `reorderWorkspaces` in `workspaces.logic.ts` and `deleteWorkspace` in `workspaceStore.ts`.
//! No GPUI in here: the rail feeds it pointer positions and tile extents, and draws what it
//! says.

use conn_desktop::orbit::OrbitWorkspace;
use conn_state::sidebar_drag::DRAG_DISTANCE_PX;

/// Moves `moved_id` to the place `target_id` holds now (the dragged tile takes the dropped-on
/// tile's index; the tiles between shift by one). `None` for an unknown id or a drop on itself.
#[must_use]
pub(crate) fn moved(
    workspaces: &[OrbitWorkspace],
    moved_id: &str,
    target_id: &str,
) -> Option<Vec<OrbitWorkspace>> {
    let from = workspaces.iter().position(|w| w.id == moved_id)?;
    let to = workspaces.iter().position(|w| w.id == target_id)?;
    if from == to {
        return None;
    }
    let mut next = workspaces.to_vec();
    let workspace = next.remove(from);
    next.insert(to, workspace);
    Some(next)
}

/// The list as it is drawn while `held` hovers over `over`: the other tiles have made room.
#[must_use]
pub(crate) fn preview<'a>(
    workspaces: &'a [OrbitWorkspace],
    held: &str,
    over: &str,
) -> Vec<&'a OrbitWorkspace> {
    let mut order: Vec<&OrbitWorkspace> = workspaces.iter().collect();
    if let (Some(from), Some(to)) = (
        order.iter().position(|w| w.id == held),
        order.iter().position(|w| w.id == over),
    ) {
        let tile = order.remove(from);
        order.insert(to, tile);
    }
    order
}

/// The list without `id`. `None` when `id` is not in it.
#[must_use]
pub(crate) fn removed(workspaces: &[OrbitWorkspace], id: &str) -> Option<Vec<OrbitWorkspace>> {
    workspaces
        .iter()
        .any(|w| w.id == id)
        .then(|| workspaces.iter().filter(|w| w.id != id).cloned().collect())
}

/// The workspace in scope once `removed_id` is gone: a removed active workspace falls back to
/// "All projects" (`None`); any other stays.
#[must_use]
pub(crate) fn active_after_removal(active: Option<&str>, removed_id: &str) -> Option<String> {
    active.filter(|id| *id != removed_id).map(str::to_owned)
}

/// The pointer has moved far enough from where it went down for a press to become a drag
/// (`PointerSensor` `activationConstraint: { distance: 6 }`). A click never gets here.
#[must_use]
pub(crate) fn drag_begins(origin: (f32, f32), at: (f32, f32)) -> bool {
    (at.0 - origin.0).hypot(at.1 - origin.1) > DRAG_DISTANCE_PX
}

/// `closestCenter`: the slot whose centre is nearest `held_center`. The first of equals wins.
#[must_use]
pub(crate) fn slot_under(slots: &[(String, f32)], held_center: f32) -> Option<&str> {
    slots
        .iter()
        .fold(None::<&(String, f32)>, |best, slot| match best {
            Some(b) if (b.1 - held_center).abs() <= (slot.1 - held_center).abs() => Some(b),
            _ => Some(slot),
        })
        .map(|(id, _)| id.as_str())
}

/// Where the rail's tiles sit when a drag begins, measured by the caller. Every tile has a
/// slot; the held tile's slot is where it comes from.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Pickup {
    /// `(workspace id, vertical centre)` in list order.
    pub(crate) slots: Vec<(String, f32)>,
    /// The held tile's left and top edges.
    pub(crate) left: f32,
    pub(crate) top: f32,
}

/// A tile that is being dragged.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Drag {
    pub(crate) id: String,
    /// The slot the tile hovers over now (its own, until it has moved a slot).
    pub(crate) over: String,
    origin_y: f32,
    pointer_y: f32,
    origin_center: f32,
    pickup: Pickup,
}

impl Drag {
    /// The held tile's left edge: it moves on the vertical axis only (`restrictToVerticalAxis`).
    #[must_use]
    pub(crate) fn left(&self) -> f32 {
        self.pickup.left
    }

    /// The held tile's top edge, `pointer travel` below where it was picked up.
    #[must_use]
    pub(crate) fn top(&self) -> f32 {
        self.pickup.top + self.pointer_y - self.origin_y
    }
}

/// A press on a tile, and the drag it may become.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Gesture {
    press: Option<(String, (f32, f32))>,
    drag: Option<Drag>,
    /// The click that ends a drag selects nothing.
    suppress_click: bool,
}

impl Gesture {
    /// The pointer went down on a tile.
    pub(crate) fn pressed(&mut self, id: &str, at: (f32, f32)) {
        self.suppress_click = false;
        self.press = Some((id.to_owned(), at));
    }

    /// The pointer moved with the button down. `pickup` measures the tiles; it is asked once,
    /// when the press turns into a drag. Returns whether the rail needs to be drawn again.
    pub(crate) fn moved(
        &mut self,
        at: (f32, f32),
        pickup: impl FnOnce(&str) -> Option<Pickup>,
    ) -> bool {
        if let Some((id, origin)) = self.press.clone()
            && drag_begins(origin, at)
        {
            self.press = None;
            let Some(pickup) = pickup(&id) else {
                return false;
            };
            let Some(origin_center) = pickup.slots.iter().find(|(s, _)| *s == id).map(|s| s.1)
            else {
                return false;
            };
            self.suppress_click = true;
            self.drag = Some(Drag {
                over: id.clone(),
                id,
                origin_y: origin.1,
                pointer_y: at.1,
                origin_center,
                pickup,
            });
        }
        let Some(drag) = &mut self.drag else {
            return false;
        };
        drag.pointer_y = at.1;
        let held_center = drag.origin_center + at.1 - drag.origin_y;
        if let Some(over) = slot_under(&drag.pickup.slots, held_center) {
            over.clone_into(&mut drag.over);
        }
        true
    }

    /// The pointer went up, or the gesture was cancelled. Returns `(held, over)` when the drop
    /// puts a tile in another place.
    pub(crate) fn released(&mut self, cancel: bool) -> Option<(String, String)> {
        self.press = None;
        let drag = self.drag.take()?;
        (!cancel && drag.over != drag.id).then_some((drag.id, drag.over))
    }

    #[must_use]
    pub(crate) fn drag(&self) -> Option<&Drag> {
        self.drag.as_ref()
    }

    /// A press or drag wants the pointer, so the window follows it.
    #[must_use]
    pub(crate) fn is_active(&self) -> bool {
        self.press.is_some() || self.drag.is_some()
    }

    #[must_use]
    pub(crate) fn click_suppressed(&self) -> bool {
        self.suppress_click
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(id: &str) -> OrbitWorkspace {
        OrbitWorkspace {
            id: id.to_owned(),
            name: id.to_uppercase(),
            color: "#3b82f6".to_owned(),
            icon: None,
            image: None,
            project_refs: Vec::new(),
            project_keys: Vec::new(),
        }
    }

    fn ids<'a>(list: impl IntoIterator<Item = &'a OrbitWorkspace>) -> Vec<&'a str> {
        list.into_iter().map(|w| w.id.as_str()).collect()
    }

    fn abcd() -> Vec<OrbitWorkspace> {
        ["a", "b", "c", "d"].map(ws).to_vec()
    }

    /// Tiles `a..d`, 38px tall with an 8px gap: centres 19, 65, 111, 157; `a` starts at x 8.
    fn pickup() -> Pickup {
        Pickup {
            slots: ["a", "b", "c", "d"]
                .iter()
                .enumerate()
                .map(|(i, id)| ((*id).to_owned(), 19.0 + 46.0 * i as f32))
                .collect(),
            left: 8.0,
            top: 0.0,
        }
    }

    // ---- reorder ----

    #[test]
    fn dragging_down_takes_the_dropped_on_place() {
        let next = moved(&abcd(), "a", "c").expect("a changes place");
        assert_eq!(ids(&next), ["b", "c", "a", "d"]);
    }

    #[test]
    fn dragging_up_takes_the_dropped_on_place() {
        let next = moved(&abcd(), "d", "b").expect("d changes place");
        assert_eq!(ids(&next), ["a", "d", "b", "c"]);
    }

    #[test]
    fn dropping_on_the_next_neighbour_swaps_the_pair() {
        let next = moved(&abcd(), "b", "c").expect("b changes place");
        assert_eq!(ids(&next), ["a", "c", "b", "d"]);
    }

    #[test]
    fn a_drop_on_itself_or_an_unknown_id_changes_nothing() {
        assert!(moved(&abcd(), "b", "b").is_none());
        assert!(moved(&abcd(), "x", "b").is_none());
        assert!(moved(&abcd(), "b", "x").is_none());
        assert!(moved(&[], "a", "b").is_none());
    }

    #[test]
    fn a_move_keeps_every_workspace_whole() {
        let mut list = abcd();
        list[1].project_refs = vec!["env:proj".to_owned()];
        let next = moved(&list, "b", "d").expect("b changes place");
        assert_eq!(next.len(), 4);
        let b = next.iter().find(|w| w.id == "b").expect("b stays");
        assert_eq!(b.project_refs, ["env:proj"]);
    }

    #[test]
    fn the_preview_shows_the_order_a_drop_would_leave() {
        let list = abcd();
        let order = |held, over| ids(preview(&list, held, over));
        assert_eq!(order("a", "c"), ["b", "c", "a", "d"]);
        assert_eq!(order("d", "b"), ["a", "d", "b", "c"]);
        assert_eq!(order("b", "b"), ["a", "b", "c", "d"]);
        assert_eq!(
            order("x", "b"),
            ["a", "b", "c", "d"],
            "an unknown tile moves nothing"
        );
        assert_eq!(
            ids(&moved(&list, "a", "c").expect("a moves")),
            order("a", "c"),
            "the preview is the drop"
        );
    }

    // ---- remove ----

    #[test]
    fn removing_drops_only_that_workspace_and_keeps_the_order() {
        let next = removed(&abcd(), "b").expect("b is in the list");
        assert_eq!(ids(&next), ["a", "c", "d"]);
    }

    #[test]
    fn removing_an_unknown_workspace_changes_nothing() {
        assert!(removed(&abcd(), "x").is_none());
        assert!(removed(&[], "a").is_none());
    }

    #[test]
    fn removing_the_last_workspace_leaves_an_empty_list() {
        let next = removed(&[ws("a")], "a").expect("a is in the list");
        assert!(next.is_empty());
    }

    #[test]
    fn removing_the_active_workspace_falls_back_to_all_projects() {
        assert_eq!(active_after_removal(Some("b"), "b"), None);
    }

    #[test]
    fn removing_another_workspace_keeps_the_active_one() {
        assert_eq!(active_after_removal(Some("a"), "b"), Some("a".to_owned()));
        assert_eq!(active_after_removal(None, "b"), None);
    }

    // ---- activation distance ----

    #[test]
    fn a_press_becomes_a_drag_only_past_six_pixels() {
        let origin = (20.0, 20.0);
        assert!(!drag_begins(origin, (20.0, 20.0)));
        assert!(!drag_begins(origin, (20.0, 26.0)), "exactly 6px is a click");
        assert!(drag_begins(origin, (20.0, 26.5)));
        assert!(drag_begins(origin, (13.0, 20.0)), "either direction");
        assert!(!drag_begins(origin, (24.0, 24.0)), "4,4 is 5.7px");
        assert!(drag_begins(origin, (25.0, 24.0)), "5,4 is 6.4px");
    }

    #[test]
    fn a_click_with_a_small_wobble_never_starts_a_drag() {
        let mut gesture = Gesture::default();
        gesture.pressed("b", (20.0, 60.0));
        assert!(!gesture.moved((22.0, 63.0), |_| panic!("measured too early")));
        assert!(gesture.drag().is_none());
        assert_eq!(gesture.released(false), None);
        assert!(!gesture.click_suppressed(), "the click selects the tile");
    }

    // ---- the gesture ----

    #[test]
    fn a_drag_follows_the_pointer_and_drops_on_the_nearest_slot() {
        let mut gesture = Gesture::default();
        gesture.pressed("a", (20.0, 19.0));
        assert!(gesture.is_active());
        // 10px down: a drag, still over its own slot.
        assert!(gesture.moved((20.0, 29.0), |_| Some(pickup())));
        let drag = gesture.drag().expect("dragging");
        assert_eq!((drag.id.as_str(), drag.over.as_str()), ("a", "a"));
        assert!((drag.top() - 10.0).abs() < f32::EPSILON);
        assert!((drag.left() - 8.0).abs() < f32::EPSILON);
        // 70px down: its centre is 89, between b (65) and c (111) and nearer c.
        assert!(gesture.moved((50.0, 89.0), |_| panic!("measured twice")));
        let drag = gesture.drag().expect("dragging");
        assert_eq!(drag.over, "c");
        assert!(
            (drag.left() - 8.0).abs() < f32::EPSILON,
            "no sideways travel"
        );
        assert_eq!(
            gesture.released(false),
            Some(("a".to_owned(), "c".to_owned()))
        );
        assert!(
            gesture.click_suppressed(),
            "the click that ends a drag selects nothing"
        );
        assert!(!gesture.is_active());
    }

    #[test]
    fn a_drag_dropped_over_its_own_slot_changes_nothing() {
        let mut gesture = Gesture::default();
        gesture.pressed("b", (20.0, 65.0));
        assert!(gesture.moved((20.0, 80.0), |_| Some(pickup())));
        assert_eq!(gesture.released(false), None);
    }

    #[test]
    fn a_dragged_tile_can_come_back_to_its_place() {
        let mut gesture = Gesture::default();
        gesture.pressed("a", (20.0, 19.0));
        gesture.moved((20.0, 120.0), |_| Some(pickup()));
        assert_eq!(gesture.drag().map(|d| d.over.as_str()), Some("c"));
        gesture.moved((20.0, 25.0), |_| None);
        assert_eq!(gesture.drag().map(|d| d.over.as_str()), Some("a"));
        assert_eq!(gesture.released(false), None);
    }

    #[test]
    fn cancelling_lets_go_without_a_drop() {
        let mut gesture = Gesture::default();
        gesture.pressed("a", (20.0, 19.0));
        gesture.moved((20.0, 120.0), |_| Some(pickup()));
        assert_eq!(gesture.released(true), None);
        assert!(gesture.drag().is_none());
        assert!(gesture.click_suppressed());
    }

    #[test]
    fn a_drag_does_not_start_when_the_tiles_cannot_be_measured() {
        let mut gesture = Gesture::default();
        gesture.pressed("a", (20.0, 19.0));
        assert!(!gesture.moved((20.0, 120.0), |_| None));
        assert!(gesture.drag().is_none());
        assert!(!gesture.is_active());
        assert!(!gesture.click_suppressed());
    }

    #[test]
    fn the_nearest_slot_wins_and_the_first_of_equals() {
        let slots = pickup().slots;
        assert_eq!(slot_under(&slots, -50.0), Some("a"));
        assert_eq!(slot_under(&slots, 300.0), Some("d"));
        assert_eq!(slot_under(&slots, 88.0), Some("b"), "equal: the first");
        assert_eq!(slot_under(&slots, 88.5), Some("c"));
        assert_eq!(slot_under(&[], 10.0), None);
    }
}
