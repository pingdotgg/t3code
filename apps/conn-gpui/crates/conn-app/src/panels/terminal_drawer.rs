//! The terminal drawer under the chat (`ThreadTerminalDrawer.tsx`): Conn hosts the terminal as a
//! bottom sheet in the chat card, with a drag handle on its top edge.

use conn_theme::Tokens;
use gpui_kit::component::v_flex;
use gpui_kit::{
    Context, CursorStyle, Div, Entity, InteractiveElement as _, MouseButton, MouseDownEvent,
    ParentElement as _, Stateful, Styled as _, div, px,
};

use super::color::to_hsla;
use super::terminal::TerminalPanel;
use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;

/// The drag handle straddles the drawer's top edge (`h-1.5` in Conn).
const RESIZE_HANDLE_PX: f32 = 6.0;

/// Renders the drawer: a divider line, the drag handle, and the terminal at `height`.
pub(crate) fn render_terminal_drawer(
    terminal: &Entity<TerminalPanel>,
    height: f32,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> Stateful<Div> {
    let stripe = to_hsla(tokens.sidebar_border);
    let handle = div()
        .id("terminal-drawer-resize")
        .a11y_group("shell.terminal-drawer.resize", "Resize terminal drawer")
        .absolute()
        .top(px(-RESIZE_HANDLE_PX / 2.0))
        .left_0()
        .right_0()
        .h(px(RESIZE_HANDLE_PX))
        .flex()
        .items_center()
        .group("terminal-drawer-handle")
        .cursor(CursorStyle::ResizeUpDown)
        .child(
            div()
                .w_full()
                .h(px(1.0))
                .group_hover("terminal-drawer-handle", move |s| s.bg(stripe)),
        )
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|app, event: &MouseDownEvent, _, cx| {
                cx.stop_propagation();
                if event.click_count >= 2 {
                    app.reset_terminal_drawer_height(cx);
                } else {
                    app.begin_terminal_drawer_drag(f32::from(event.position.y), cx);
                }
            }),
        );

    div()
        .id("terminal-drawer")
        .a11y_group("shell.terminal-drawer", "Terminal drawer")
        .relative()
        .flex_shrink_0()
        .w_full()
        .h(px(height))
        .border_t_1()
        .border_color(to_hsla(tokens.shell_divider))
        .child(v_flex().size_full().child(terminal.clone()))
        .child(handle)
}
