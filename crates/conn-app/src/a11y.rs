//! macOS Accessibility (`AXUIElement` / AccessKit) ergonomics for `conn-app`.
//!
//! GPUI (`gpui-pre = 0.3.11`) runs `accesskit_macos::SubclassingAdapter` on every window,
//! exposing any element with both an `.id(...)` and a non-`None` `.role(Role::...)` to macOS
//! Accessibility clients (VoiceOver, Accessibility Inspector, and Nick's native `Annotator` app).
//!
//! Every helper here sets:
//! - `Role` (`kAXRoleAttribute` / `kAXSubroleAttribute`),
//! - `accessibility_id` (`kAXIdentifierAttribute` — stable, grep-friendly key mapping back to Rust),
//! - `aria_label` (`kAXTitleAttribute` / `kAXDescriptionAttribute`).

use gpui_kit::{Role, SharedString, StatefulInteractiveElement, Toggled};

/// Ergonomic accessibility builders for any stateful GPUI element (`div().id(...)`).
pub(crate) trait ConnA11yExt: StatefulInteractiveElement + Sized {
    /// Exposes this element with an explicit AccessKit `role`, stable `AXIdentifier`, and label.
    fn a11y(
        self,
        role: Role,
        ax_id: impl Into<SharedString>,
        label: impl Into<SharedString>,
    ) -> Self {
        self.role(role).accessibility_id(ax_id).aria_label(label)
    }

    /// Same as [`Self::a11y`] plus supplementary `AXHelp` / `AXDescription` text.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "shared accessibility helper for elements with supplementary AXHelp text"
        )
    )]
    fn a11y_desc(
        self,
        role: Role,
        ax_id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        description: impl Into<SharedString>,
    ) -> Self {
        self.role(role)
            .accessibility_id(ax_id)
            .aria_label(label)
            .aria_description(description)
    }

    /// Exposes an interactive button (`AXButton`).
    fn a11y_button(self, ax_id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.a11y(Role::Button, ax_id, label)
    }

    /// Exposes a structural container group (`AXGroup`).
    fn a11y_group(self, ax_id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.a11y(Role::Group, ax_id, label)
    }

    /// Exposes a landmark region (`AXGroup` / `AXLandmarkRegion`).
    fn a11y_region(self, ax_id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.a11y(Role::Region, ax_id, label)
    }

    /// Exposes a tab (`AXRadioButton` / `AXTab`) with selected state.
    fn a11y_tab(
        self,
        ax_id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
    ) -> Self {
        self.a11y(Role::Tab, ax_id, label).aria_selected(selected)
    }

    /// Exposes a toggle switch (`AXCheckBox` / `AXSwitch`) with checked state.
    fn a11y_switch(
        self,
        ax_id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        checked: bool,
    ) -> Self {
        self.a11y(Role::Switch, ax_id, label)
            .aria_toggled(if checked {
                Toggled::True
            } else {
                Toggled::False
            })
    }
}

impl<E: StatefulInteractiveElement> ConnA11yExt for E {}

#[cfg(test)]
mod tests {
    use gpui_kit::{InteractiveElement as _, Role, StatefulInteractiveElement as _, Toggled, div};

    use super::ConnA11yExt as _;

    #[test]
    fn helpers_compile_and_chain_cleanly_on_stateful_divs() {
        let _btn = div()
            .id("test-btn")
            .a11y_button("test.button", "Test button");
        let _grp = div().id("test-grp").a11y_group("test.group", "Test group");
        let _reg = div()
            .id("test-reg")
            .a11y_region("test.region", "Test region");
        let _tab = div().id("test-tab").a11y_tab("test.tab", "Test tab", true);
        let _sw = div()
            .id("test-sw")
            .a11y_switch("test.switch", "Test switch", false);
        let _custom = div()
            .id("test-custom")
            .a11y_desc(Role::Toolbar, "test.toolbar", "Toolbar", "Actions")
            .aria_toggled(Toggled::True);
    }
}
