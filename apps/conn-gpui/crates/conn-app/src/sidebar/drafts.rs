//! Unsent new-thread drafts in the thread sidebar (`SidebarDraftBlock.tsx`). Which drafts get a
//! row, their order and their label come from `conn_state::sidebar`; this file draws them.
//!
//! A row shows the draft's project (pen, favicon, name) above the first line of its prompt.
//! Click reopens the draft, `x` discards it, right-click opens its menu. A hairline closes the
//! block.

use std::cell::Cell;
use std::collections::HashSet;
use std::rc::Rc;

use conn_state::{
    DraftRowKey, ProjectShell, SidebarDraftRow, draft_row_key, draft_row_label, is_activation_key,
};
use conn_theme::{Appearance, Tokens};
use gpui_kit::TestSupportExt as _;
use gpui_kit::{
    Context, InteractiveElement as _, IntoElement as _, MouseButton, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, canvas, div, point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::panels::chrome::ConnTooltipExt as _;
use crate::sidebar::{render_project_favicon, render_project_monogram};
use crate::theme::{hsla, hsla_alpha};

/// `h-[4.875rem]` row height.
const DRAFT_ROW_HEIGHT_PX: f32 = 78.0;
/// `--sidebar-row-content-inset` / `--sidebar-content-inset`.
const ROW_INSET_X_PX: f32 = 10.0;
const ROW_INSET_Y_PX: f32 = 8.0;
/// `rounded-md`.
const ROW_RADIUS_PX: f32 = 6.0;
const FAVICON_PX: f32 = 16.0;
/// `text-xs` project name, `text-sm` preview.
const PROJECT_FONT_PX: f32 = 12.0;
const PREVIEW_FONT_PX: f32 = 14.0;
const PREVIEW_LINE_PX: f32 = 20.0;

/// What the sidebar shows for drafts.
pub(crate) struct DraftSidebar<'a> {
    pub(crate) rows: Vec<DraftRowView<'a>>,
    /// A discarded draft can still be brought back.
    pub(crate) undo_available: bool,
    /// Started threads whose composer holds unsent input (their rows carry the pen mark).
    pub(crate) unsent_threads: HashSet<String>,
}

/// One draft row with the project it targets.
pub(crate) struct DraftRowView<'a> {
    pub(crate) row: &'a SidebarDraftRow,
    pub(crate) project: Option<&'a ProjectShell>,
}

/// The draft block: one row per draft, then the divider.
#[must_use]
pub(crate) fn render_draft_block(
    rows: &[DraftRowView<'_>],
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> Vec<gpui_kit::AnyElement> {
    if rows.is_empty() {
        return Vec::new();
    }
    let mut elements: Vec<gpui_kit::AnyElement> = rows
        .iter()
        .map(|view| render_draft_row(view, tokens, cx).into_any_element())
        .collect();
    elements.push(
        div()
            .w_full()
            .px(px(ROW_INSET_X_PX))
            .py(px(6.0))
            .child(div().h(px(1.0)).bg(hsla_alpha(tokens.sidebar_border, 0.60)))
            .into_any_element(),
    );
    elements
}

fn render_draft_row(
    view: &DraftRowView<'_>,
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::Div {
    let row = view.row;
    let muted = hsla(tokens.sidebar_muted_foreground);
    let fg = hsla(tokens.foreground);
    let hover_bg = hsla_alpha(tokens.warning, 0.08);
    let button_hover = hsla(tokens.sidebar_row_hover);
    let project_name = view.project.map_or("", |p| p.title.as_str());
    let favicon = view.project.map_or_else(
        || render_project_monogram("New", FAVICON_PX, tokens),
        |p| render_project_favicon(p, FAVICON_PX, tokens),
    );
    let group = SharedString::from(format!("sidebar-draft-group-{}", row.draft_id));

    let discard_id = row.draft_id.clone();
    let discard_key_id = row.draft_id.clone();
    let discard = div()
        .id(SharedString::from(format!(
            "sidebar-draft-discard-{}",
            row.draft_id
        )))
        .test_support()
        .a11y_button(
            format!("sidebar.draft.discard.{}", row.draft_id),
            "Discard draft",
        )
        .flex()
        .items_center()
        .justify_center()
        .size(px(20.0))
        .flex_shrink_0()
        .rounded(px(5.0))
        .cursor_pointer()
        // Not `invisible()`: a hidden element cannot take keyboard focus, and the button shows
        // on row hover or keyboard focus (`has-[:focus-visible]`).
        .opacity(0.0)
        .group_hover(group.clone(), |s| s.opacity(1.0))
        .focus_visible(|s| s.opacity(1.0))
        .tab_index(0)
        .hover(move |s| s.bg(button_hover))
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .on_key_down(cx.listener(move |app, event: &gpui_kit::KeyDownEvent, _, cx| {
            // Keys on the button belong to the button, not to the row around it.
            if is_activation_key(&event.keystroke.key) {
                cx.stop_propagation();
                app.discard_draft_row(&discard_key_id, cx);
            }
        }))
        .on_click(cx.listener(move |app, _, _, cx| {
            cx.stop_propagation();
            app.discard_draft_row(&discard_id, cx);
        }))
        .conn_tooltip("Discard draft", tokens)
        .child(icons::concept("superhero/close.svg", 12.0, muted));

    let open_id = row.draft_id.clone();
    let key_id = row.draft_id.clone();
    let menu_id = row.draft_id.clone();
    // Where the row was last painted, for a menu opened from the keyboard.
    let below_row: Rc<Cell<Option<gpui_kit::Point<gpui_kit::Pixels>>>> = Rc::default();
    let measured = Rc::clone(&below_row);
    let ring = gpui_kit::BoxShadow {
        color: hsla(tokens.ring),
        offset: point(px(0.0), px(0.0)),
        blur_radius: px(0.0),
        spread_radius: px(2.0),
        inset: true,
    };
    let mut card = div()
        .id(SharedString::from(format!(
            "sidebar-draft-row-{}",
            row.draft_id
        )))
        .a11y(
            gpui_kit::Role::ListItem,
            format!("sidebar.draft.{}", row.draft_id),
            draft_row_label(&row.preview, view.project.map(|p| p.title.as_str())),
        )
        .aria_selected(row.active)
        .group(group)
        .relative()
        // `role="button" tabIndex={0}` with `focus-visible:ring-2 ring-inset`.
        .tab_index(0)
        .focus_visible(move |s| s.shadow(vec![ring]))
        .on_key_down(cx.listener(move |app, event: &gpui_kit::KeyDownEvent, window, cx| {
            let keystroke = &event.keystroke;
            match draft_row_key(&keystroke.key, keystroke.modifiers.shift) {
                Some(DraftRowKey::Open) => {
                    cx.stop_propagation();
                    app.open_draft(&key_id, Some(window), cx);
                }
                Some(DraftRowKey::Menu) => {
                    cx.stop_propagation();
                    if let Some(position) = below_row.get() {
                        app.open_draft_menu(key_id.clone(), position, cx);
                    }
                }
                None => {}
            }
        }))
        .flex()
        .flex_col()
        .w_full()
        .h(px(DRAFT_ROW_HEIGHT_PX))
        .px(px(ROW_INSET_X_PX))
        .py(px(ROW_INSET_Y_PX))
        .rounded(px(ROW_RADIUS_PX))
        .border_t_1()
        .cursor_pointer()
        .on_click(cx.listener(move |app, _, window, cx| {
            app.open_draft(&open_id, Some(window), cx);
        }))
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |app, event: &gpui_kit::MouseDownEvent, _, cx| {
                cx.stop_propagation();
                app.open_draft_menu(menu_id.clone(), event.position, cx);
            }),
        );
    card = if row.active {
        card.bg(hsla(tokens.sidebar_row_active))
            .border_color(hsla_alpha(tokens.shell_divider_raised, 0.50))
    } else {
        card.bg(hsla_alpha(tokens.warning, 0.04))
            .border_color(gpui_kit::transparent_black())
            .hover(move |s| s.bg(hover_bg))
    };
    if tokens.appearance == Appearance::Light && !row.active {
        card = card
            .border_1()
            .border_color(hsla_alpha(tokens.sidebar_border, 0.70));
    }

    let top = div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .w_full()
        .h(px(20.0))
        .min_w_0()
        .child(icons::concept(
            "superhero/edit.svg",
            12.0,
            hsla(tokens.warning_foreground),
        ))
        .child(favicon)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(PROJECT_FONT_PX))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(muted)
                .child(project_name.to_owned()),
        )
        .child(discard);
    let preview = div()
        .mt(px(2.0))
        .w_full()
        .min_w_0()
        .truncate()
        .text_size(px(PREVIEW_FONT_PX))
        .line_height(px(PREVIEW_LINE_PX))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .text_color(fg.opacity(0.9))
        .child(row.preview.clone());

    div().w_full().py(px(2.0)).child(
        card.child(top)
            .child(preview)
            .child(
                canvas(
                    move |bounds, _, _| {
                        measured.set(Some(point(bounds.left(), bounds.bottom())));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .test_support(),
    )
}

/// `Discarded 1 draft` with its `Undo` button (`showThreadUndoNotice`), at the foot of the
/// sidebar card.
#[must_use]
pub(crate) fn render_draft_undo_notice(
    tokens: &Tokens,
    cx: &mut Context<'_, ConnApp>,
) -> gpui_kit::AnyElement {
    let muted = hsla(tokens.sidebar_muted_foreground);
    let fg = hsla(tokens.foreground);
    let hover_bg = hsla(tokens.sidebar_row_hover);
    div()
        .id("sidebar-draft-undo-notice")
        .test_support()
        .a11y_group("sidebar.draft-undo", "Discarded 1 draft")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .flex_shrink_0()
        .mx(px(8.0))
        .mb(px(8.0))
        .px(px(ROW_INSET_X_PX))
        .h(px(36.0))
        .rounded(px(ROW_RADIUS_PX))
        .border_1()
        .border_color(hsla_alpha(tokens.sidebar_border, 0.70))
        .text_size(px(PROJECT_FONT_PX))
        .text_color(muted)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .child("Discarded 1 draft"),
        )
        .child(
            div()
                .id("sidebar-draft-undo")
                .test_support()
                .a11y_button("sidebar.draft-undo.button", "Undo discard")
                .flex_shrink_0()
                .px(px(6.0))
                .py(px(2.0))
                .rounded(px(4.0))
                .cursor_pointer()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(fg)
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|app, _, _, cx| app.undo_discard_draft(cx)))
                .child("Undo"),
        )
        .into_any_element()
}
