//! The page's right-click menu. The Browser view is windowless, so Chromium draws no menu: it
//! sends the finished rows and waits for one answer. This draws them in the app's own menu style
//! (the thread menu's surface and rows) at the click, and answers: the chosen command, or
//! "cancelled" when the menu is dismissed (Escape, a click outside, a navigation, or a new menu).
//! A menu that is dropped without an answer cancels itself, so Chromium never waits.

use conn_theme::Tokens;
use conn_web::{ContextMenuReply, ContextMenuRequest, MenuEntry};
use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement as _, ParentElement as _, Pixels,
    Point, SharedString, StatefulInteractiveElement as _, Styled as _, Window, anchored, deferred,
    div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::sidebar::thread_menu::{
    MENU_DISABLED_OPACITY, MENU_FONT_PX, MENU_ICON_OPACITY, MENU_ICON_PX, MENU_LINE_PX,
    MENU_ROW_HEIGHT_PX, MENU_ROW_RADIUS_PX, menu_surface,
};
use crate::theme::{hsla, hsla_alpha};

/// Extra left padding per submenu level.
const INDENT_PX: f32 = 12.0;

/// A menu Chromium asked the host to show.
pub(super) struct OpenMenu {
    /// Where the click landed, in the page view's own coordinates.
    x: i32,
    y: i32,
    entries: Vec<MenuEntry>,
    reply: ContextMenuReply,
    /// The row the keyboard or pointer is on.
    cursor: Option<usize>,
}

impl OpenMenu {
    pub(super) fn new(request: ContextMenuRequest) -> Self {
        Self {
            x: request.x,
            y: request.y,
            entries: request.entries,
            reply: request.reply,
            cursor: None,
        }
    }

    /// The click position, in the page view's coordinates.
    pub(super) fn position(&self) -> (i32, i32) {
        (self.x, self.y)
    }

    /// Highlights the row under the pointer (a disabled row or a heading takes no highlight).
    pub(super) fn hover(&mut self, index: usize) {
        if self
            .entries
            .get(index)
            .is_some_and(MenuEntry::is_actionable)
        {
            self.cursor = Some(index);
        }
    }

    /// Moves the keyboard highlight to the next (`forward`) or previous row you can choose,
    /// wrapping at the ends.
    pub(super) fn step(&mut self, forward: bool) {
        let rows: Vec<usize> = (0..self.entries.len())
            .filter(|&i| self.entries[i].is_actionable())
            .collect();
        if rows.is_empty() {
            self.cursor = None;
            return;
        }
        let at = self.cursor.and_then(|c| rows.iter().position(|&r| r == c));
        let next = match (at, forward) {
            (None, true) => 0,
            (None, false) => rows.len() - 1,
            (Some(i), true) => (i + 1) % rows.len(),
            (Some(i), false) => (i + rows.len() - 1) % rows.len(),
        };
        self.cursor = Some(rows[next]);
    }

    /// Runs the command of row `index`. Does nothing, and returns `false`, for a row that cannot
    /// be chosen.
    pub(super) fn choose(&self, index: usize) -> bool {
        match self.entries.get(index) {
            Some(MenuEntry::Item {
                command_id,
                enabled: true,
                ..
            }) => {
                self.reply.choose(*command_id);
                true
            }
            _ => false,
        }
    }

    /// Runs the highlighted row's command.
    pub(super) fn choose_cursor(&self) -> bool {
        self.cursor.is_some_and(|index| self.choose(index))
    }
}

/// What the menu's rows do in the panel that owns them.
pub(super) struct MenuActions<T> {
    pub(super) choose: fn(&mut T, usize, &mut Window, &mut Context<'_, T>),
    pub(super) hover: fn(&mut T, usize, &mut Context<'_, T>),
    pub(super) dismiss: fn(&mut T, &mut Window, &mut Context<'_, T>),
}

/// The menu at `origin` (window coordinates), above everything else.
pub(super) fn render_context_menu<T: 'static>(
    menu: &OpenMenu,
    origin: Point<Pixels>,
    tokens: &Tokens,
    actions: &MenuActions<T>,
    cx: &mut Context<'_, T>,
) -> AnyElement {
    let fg = hsla(tokens.popover_foreground);
    let muted = hsla(tokens.muted_foreground);
    let highlight = hsla(tokens.shell_highlight);
    let separator = hsla_alpha(tokens.foreground, 0.08);
    let dismiss = actions.dismiss;
    let has_checks = menu.entries.iter().any(|e| {
        matches!(
            e,
            MenuEntry::Item {
                checked: Some(_),
                ..
            }
        )
    });

    let mut list = menu_surface(SharedString::from("browser-context-menu"), tokens)
        .a11y(gpui_kit::Role::Menu, "browser.context-menu", "Page menu")
        .on_mouse_down_out(cx.listener(move |this, _, window, cx| dismiss(this, window, cx)));

    for (index, entry) in menu.entries.iter().enumerate() {
        match entry {
            MenuEntry::Separator => {
                list = list.child(div().mx(px(-4.0)).my(px(4.0)).h(px(1.0)).bg(separator));
            }
            MenuEntry::Heading { label, depth } => {
                list = list.child(
                    div()
                        .id(SharedString::from(format!("browser-context-menu-h{index}")))
                        .a11y_group(
                            format!("browser.context-menu.heading.{index}"),
                            label.clone(),
                        )
                        .px(px(8.0 + INDENT_PX * f32::from(*depth)))
                        .py(px(4.0))
                        .text_size(px(MENU_FONT_PX))
                        .line_height(px(MENU_LINE_PX))
                        .text_color(muted)
                        .child(label.clone()),
                );
            }
            MenuEntry::Item {
                command_id,
                label,
                enabled,
                checked,
                depth,
            } => {
                let highlighted = menu.cursor == Some(index) && *enabled;
                let mut row = div()
                    .id(SharedString::from(format!("browser-context-menu-{index}")))
                    .a11y(
                        gpui_kit::Role::MenuItem,
                        format!("browser.context-menu.item.{command_id}"),
                        label.clone(),
                    )
                    .aria_selected(highlighted)
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .w_full()
                    .min_h(px(MENU_ROW_HEIGHT_PX))
                    .pl(px(8.0 + INDENT_PX * f32::from(*depth)))
                    .pr(px(8.0))
                    .py(px(4.0))
                    .rounded(px(MENU_ROW_RADIUS_PX))
                    .text_size(px(MENU_FONT_PX))
                    .line_height(px(MENU_LINE_PX))
                    .text_color(fg);
                if has_checks {
                    row = row.child(if *checked == Some(true) {
                        icons::concept(
                            "superhero/check.svg",
                            MENU_ICON_PX,
                            fg.opacity(MENU_ICON_OPACITY),
                        )
                        .into_any_element()
                    } else {
                        div().size(px(MENU_ICON_PX)).flex_none().into_any_element()
                    });
                }
                row = row.child(div().flex_1().min_w_0().truncate().child(label.clone()));

                if *enabled {
                    let choose = actions.choose;
                    let hover = actions.hover;
                    if highlighted {
                        row = row.bg(highlight);
                    }
                    row = row
                        .cursor_pointer()
                        .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                            if *hovered {
                                hover(this, index, cx);
                            }
                        }))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            choose(this, index, window, cx);
                        }));
                } else {
                    row = row.opacity(MENU_DISABLED_OPACITY);
                }
                list = list.child(row);
            }
        }
    }

    deferred(
        anchored()
            .position(origin)
            .snap_to_window_with_margin(px(8.0))
            .child(list),
    )
    .with_priority(6)
    .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_web::MenuAnswer;
    use std::sync::{Arc, Mutex};

    fn item(id: i32, enabled: bool) -> MenuEntry {
        MenuEntry::Item {
            command_id: id,
            label: format!("Item {id}"),
            enabled,
            checked: None,
            depth: 0,
        }
    }

    fn menu(entries: Vec<MenuEntry>) -> (OpenMenu, Arc<Mutex<Vec<MenuAnswer>>>) {
        let answers = Arc::new(Mutex::new(Vec::new()));
        let sink = answers.clone();
        let reply = ContextMenuReply::new(move |answer| {
            sink.lock().expect("lock").push(answer);
        });
        let open = OpenMenu::new(ContextMenuRequest {
            x: 10,
            y: 20,
            entries,
            reply,
        });
        (open, answers)
    }

    fn answered(answers: &Arc<Mutex<Vec<MenuAnswer>>>) -> Vec<MenuAnswer> {
        answers.lock().expect("lock").clone()
    }

    #[test]
    fn choosing_a_row_runs_its_command_once() {
        let (open, answers) = menu(vec![item(100, true), item(101, true)]);
        assert!(open.choose(1));
        assert!(open.choose(0), "a second pick is accepted but not sent");
        assert_eq!(answered(&answers), vec![MenuAnswer::Choose(101)]);
    }

    #[test]
    fn disabled_rows_headings_and_separators_cannot_be_chosen() {
        let (open, answers) = menu(vec![
            MenuEntry::Heading {
                label: "More".into(),
                depth: 0,
            },
            MenuEntry::Separator,
            item(7, false),
        ]);
        assert!(!open.choose(0));
        assert!(!open.choose(1));
        assert!(!open.choose(2));
        assert!(!open.choose(99));
        assert!(answered(&answers).is_empty());
    }

    #[test]
    fn dismissing_cancels_and_a_chosen_menu_is_not_cancelled_after() {
        // Escape, an outside click or a navigation all drop the open menu.
        let (open, answers) = menu(vec![item(1, true)]);
        drop(open);
        assert_eq!(answered(&answers), vec![MenuAnswer::Cancel]);

        let (open, answers) = menu(vec![item(1, true)]);
        assert!(open.choose(0));
        drop(open);
        assert_eq!(answered(&answers), vec![MenuAnswer::Choose(1)]);
    }

    #[test]
    fn replacing_an_open_menu_cancels_the_old_one() {
        let (first, first_answers) = menu(vec![item(1, true)]);
        let (second, second_answers) = menu(vec![item(2, true)]);
        let mut slot = Some(first);
        drop(slot.replace(second));
        assert_eq!(answered(&first_answers), vec![MenuAnswer::Cancel]);
        assert!(answered(&second_answers).is_empty());
        drop(slot);
        assert_eq!(answered(&second_answers), vec![MenuAnswer::Cancel]);
    }

    #[test]
    fn keyboard_steps_over_rows_that_cannot_be_chosen_and_wraps() {
        let (mut open, answers) = menu(vec![
            MenuEntry::Heading {
                label: "H".into(),
                depth: 0,
            },
            item(1, true),
            item(2, false),
            MenuEntry::Separator,
            item(3, true),
        ]);
        open.step(true);
        assert_eq!(open.cursor, Some(1));
        open.step(true);
        assert_eq!(open.cursor, Some(4));
        open.step(true);
        assert_eq!(open.cursor, Some(1));
        open.step(false);
        assert_eq!(open.cursor, Some(4));
        assert!(open.choose_cursor());
        assert_eq!(answered(&answers), vec![MenuAnswer::Choose(3)]);
    }

    #[test]
    fn stepping_up_from_nothing_starts_at_the_last_row_and_hover_skips_disabled() {
        let (mut open, _) = menu(vec![item(1, true), item(2, false), item(3, true)]);
        open.step(false);
        assert_eq!(open.cursor, Some(2));
        open.hover(1);
        assert_eq!(open.cursor, Some(2), "a disabled row takes no highlight");
        open.hover(0);
        assert_eq!(open.cursor, Some(0));
        assert_eq!(open.position(), (10, 20));
        assert!(!menu(vec![]).0.choose_cursor());
    }
}
