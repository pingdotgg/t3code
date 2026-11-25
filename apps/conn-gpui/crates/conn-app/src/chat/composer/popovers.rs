//! One composer popover at a time (Nick, #323).
//!
//! The model picker, the permission menus, the context meter, the implement menu, the prompt
//! stash and the branch and workspace pickers each own an `open` flag that their trigger flips.
//! Rather than make every trigger close the others, [`Composer::keep_one_popover`] runs before
//! each render: when more than one is open it keeps the one that opened last and closes the rest.

use gpui_kit::Context;

use super::Composer;

/// A composer popover that must not overlap another.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Popover {
    ModelPicker,
    FooterPermissions,
    Implement,
    ContextMeter,
    Stash,
    BranchPicker,
    WorkspaceMenu,
}

/// The popover to keep among `open` ones: the first one that was not open in `previous`, else the
/// first open one. `None` when none is open.
pub(super) fn popover_to_keep(open: &[Popover], previous: &[Popover]) -> Option<Popover> {
    open.iter()
        .rev()
        .find(|popover| !previous.contains(popover))
        .or_else(|| open.first())
        .copied()
}

impl Composer {
    fn open_popovers(&self) -> Vec<Popover> {
        let flags = [
            (Popover::ModelPicker, self.model_picker_open),
            (Popover::FooterPermissions, self.footer_permissions_open),
            (Popover::Implement, self.implement_menu_open),
            (Popover::ContextMeter, self.context_meter_open),
            (Popover::Stash, self.stash.menu_open),
            (Popover::BranchPicker, self.branch.picker_open),
            (Popover::WorkspaceMenu, self.branch.workspace_menu_open),
        ];
        flags
            .into_iter()
            .filter_map(|(popover, open)| open.then_some(popover))
            .collect()
    }

    fn close_popover(&mut self, popover: Popover) {
        match popover {
            Popover::ModelPicker => {
                self.model_picker_open = false;
                self.picker_permissions_open = false;
                self.permission_preview = None;
            }
            Popover::FooterPermissions => self.footer_permissions_open = false,
            Popover::Implement => self.implement_menu_open = false,
            Popover::ContextMeter => self.context_meter_open = false,
            Popover::Stash => self.stash.menu_open = false,
            Popover::BranchPicker => self.branch.picker_open = false,
            Popover::WorkspaceMenu => self.branch.workspace_menu_open = false,
        }
    }

    /// Closes all but the most recently opened popover. Called at the start of each render.
    pub(super) fn keep_one_popover(&mut self, cx: &mut Context<'_, Self>) {
        // A closed meter is not pinned, however it was closed (Escape, another popover).
        if !self.context_meter_open {
            self.meter.pinned = false;
        }
        let open = self.open_popovers();
        if open.len() > 1
            && let Some(keep) = popover_to_keep(&open, &self.seen_popovers)
        {
            for popover in open.iter().filter(|popover| **popover != keep) {
                self.close_popover(*popover);
            }
            cx.notify();
        }
        self.seen_popovers = self.open_popovers();
    }
}

#[cfg(test)]
mod tests {
    use super::Popover::{BranchPicker, ContextMeter, ModelPicker, Stash};
    use super::popover_to_keep;

    #[test]
    fn the_popover_opened_last_wins() {
        // The context meter was open; the model picker opens: it stays, the meter closes.
        assert_eq!(
            popover_to_keep(&[ModelPicker, ContextMeter], &[ContextMeter]),
            Some(ModelPicker)
        );
        // And the other way round.
        assert_eq!(
            popover_to_keep(&[ModelPicker, ContextMeter], &[ModelPicker]),
            Some(ContextMeter)
        );
        // Two at once from nothing: one is kept, deterministically.
        assert_eq!(
            popover_to_keep(&[Stash, BranchPicker], &[]),
            Some(BranchPicker)
        );
        // A single or no popover needs no choice.
        assert_eq!(popover_to_keep(&[Stash], &[Stash]), Some(Stash));
        assert_eq!(popover_to_keep(&[], &[Stash]), None);
    }
}
