//! Conn window shell primitives: inset cards and full-height two-tone dividers.
//!
//! Follows `docs/design-spec.md` §1 and `apps/web/src/index.css`:
//! - Outer shell inset: `4px` (`ShellGeometry::shell_inset_px`).
//! - Inset card corner radius: `14px` concentric with `18px` window radius
//!   (`ShellGeometry::shell_corner_px`).
//! - Exposed card edges carry a `0.5px` `shell_inner_border`; joined panel
//!   edges drop their border so the single `1px` two-tone divider owns the seam.
//! - Full-height `1px` dividers paint `shell_divider_header` through the top
//!   `44px` header band and `shell_divider` below.

use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::{Div, ParentElement as _, Styled as _, div, px};

use crate::theme::hsla;

/// Width of the leftmost workspace rail (`w-13.5` = `54px` in `WorkspaceRail.tsx`).
pub(crate) const WORKSPACE_RAIL_WIDTH_PX: f32 = 54.0;
/// Left inset reserving space for macOS traffic lights when the sidebar is collapsed.
pub(crate) const MACOS_TRAFFIC_LIGHTS_INSET_PX: f32 = 90.0;
/// Half-pixel inner panel border width (`0.5px` on exposed edges).
pub(crate) const INNER_BORDER_PX: f32 = 0.5;
/// Full-height seam divider width (`1px`).
pub(crate) const DIVIDER_WIDTH_PX: f32 = 1.0;

/// Which horizontal edges of an inset card join an adjacent panel across a
/// `1px` two-tone seam divider.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CardJoin {
    /// True when a panel sits immediately to the left across a seam divider.
    pub(crate) left: bool,
    /// True when a panel sits immediately to the right across a seam divider.
    pub(crate) right: bool,
}

/// Builds a `shell-inner-panel` card: painted with `tokens.shell_inner_fill`,
/// inset `4px` from exposed window edges, `14px` corner radius on unjoined
/// sides, and a `0.5px` `tokens.shell_inner_border` on exposed edges only.
#[must_use]
pub(crate) fn inset_card(tokens: &Tokens, geometry: &ShellGeometry, join: CardJoin) -> Div {
    let inset = px(geometry.shell_inset_px);
    let corner = px(geometry.shell_corner_px);
    let border = px(INNER_BORDER_PX);

    let mut card = div()
        .relative()
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .overflow_hidden()
        .bg(hsla(tokens.shell_inner_fill))
        .mb(inset)
        .border_color(hsla(tokens.shell_inner_border))
        .border_t(border)
        .border_b(border);

    if join.left {
        card = card.border_l(px(0.0));
    } else {
        card = card
            .ml(inset)
            .border_l(border)
            .rounded_tl(corner)
            .rounded_bl(corner);
    }

    if join.right {
        card = card.border_r(px(0.0));
    } else {
        card = card
            .mr(inset)
            .border_r(border)
            .rounded_tr(corner)
            .rounded_br(corner);
    }

    card
}

/// Builds a full-height `1px` two-tone vertical seam divider between adjacent
/// shell columns: `shell_divider_header` for the top `44px`, `shell_divider`
/// below.
#[must_use]
pub(crate) fn two_tone_divider(tokens: &Tokens, geometry: &ShellGeometry) -> Div {
    div()
        .flex()
        .flex_col()
        .w(px(DIVIDER_WIDTH_PX))
        .h_full()
        .flex_shrink_0()
        .child(
            div()
                .w_full()
                .h(px(geometry.header_height_px))
                .flex_shrink_0()
                .bg(hsla(tokens.shell_divider_header)),
        )
        .child(div().w_full().flex_1().bg(hsla(tokens.shell_divider)))
}
