//! Stateless UI renderers for the Database surface: the `dropdown-glass` connection menu,
//! the scrollable result rows grid (`RowsGrid`), the table column structure list
//! (`StructureList`), and the connection error alert.

use crate::a11y::ConnA11yExt as _;
use conn_desktop::database::DatabaseColumn;
use conn_desktop::database::api::{
    ConnectionSource, DatabaseQueryResult, PanelConnection, connection_target,
};
use conn_desktop::vault::VaultErrorKind;
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, BoxShadow, Context, FontWeight, IntoElement, MouseButton, ParentElement,
    SharedString, Styled, deferred, div, point, px, relative,
};

use super::super::chrome::{
    self, ROW_PAD_START_PX, TOOLBAR_PAD_END_PX, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX,
    XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::header::superhero_icon;
use super::DatabasePanel;
use super::store::{CellDisplay, format_cell_value, format_column_details, measure_column_widths};
use crate::theme::MONO_FONT;

/// Conn's `ConnectionMenu` popup (`dropdown-glass`, `sideOffset={6}`, `align="start"`).
pub(crate) fn render_connection_menu(
    tokens: &Tokens,
    connections: &[PanelConnection],
    selected: Option<&PanelConnection>,
    vault_status: Option<VaultErrorKind>,
    vault_error: Option<&str>,
    cx: &mut Context<'_, DatabasePanel>,
) -> AnyElement {
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let highlight = to_hsla(tokens.shell_highlight);
    let checked_bg = chrome::alpha(tokens.foreground, 0.08);
    let divider = chrome::alpha(tokens.foreground, 0.08);
    let (offset_y, blur, alpha) = match tokens.appearance {
        Appearance::Dark => (18.0, 44.0, 0.80),
        Appearance::Light => (16.0, 40.0, 0.55),
    };
    let shadow = BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    };

    let mut list = v_flex()
        .id("db-connection-menu")
        .a11y_group("panel.database.connection-menu", "Connections")
        .min_w(px(160.0))
        .max_w(px(360.0))
        .p(px(4.0))
        .rounded(px(12.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(divider)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    let selected_id = selected.map(|conn| conn.id.as_str());
    if !connections.is_empty() {
        for connection in connections {
            let is_selected = selected_id == Some(connection.id.as_str());
            let target = connection_target(&connection.connection, connection.ssh_host.as_deref());
            let id = connection.id.clone();
            let entity = entity.clone();
            list = list.child(
                h_flex()
                    .id(SharedString::from(format!("db-conn-item-{id}")))
                    .a11y_button(format!("panel.database.connection.{id}"), "Database connection")
                    .w_full()
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .gap(px(6.0))
                    .items_center()
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .when(is_selected, |el| el.bg(checked_bg))
                    .hover(move |s| s.bg(highlight))
                    .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                        cx.stop_propagation();
                        let id = id.clone();
                        entity.update(cx, |panel, cx| panel.select_connection(&id, cx));
                    })
                    .child(div().min_w_0().truncate().child(connection.name.clone()))
                    .child(
                        div()
                            .ml_auto()
                            .min_w_0()
                            .truncate()
                            .pl(px(12.0))
                            .text_color(muted)
                            .child(target),
                    ),
            );
        }
        list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
    }

    let menu_action = |id: &'static str,
                       label: &'static str,
                       on_pick: Box<
        dyn Fn(&mut DatabasePanel, &mut gpui_kit::Window, &mut Context<'_, DatabasePanel>),
    >| {
        let entity = entity.clone();
        h_flex()
            .id(id)
            .w_full()
            .min_h(px(28.0))
            .px(px(8.0))
            .py(px(4.0))
            .items_center()
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(14.0))
            .line_height(px(20.0))
            .text_color(fg)
            .hover(move |s| s.bg(highlight))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                entity.update(cx, |panel, cx| on_pick(panel, window, cx));
            })
            .child(div().min_w_0().flex_1().truncate().child(label))
    };

    list = list.child(menu_action(
        "db-menu-add",
        "Add connection…",
        Box::new(|panel, window, cx| panel.begin_add_connection(true, window, cx)),
    ));

    match vault_status {
        Some(VaultErrorKind::Locked) => {
            list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
            list = list.child(menu_action(
                "db-menu-unlock-vault",
                "Unlock Vault…",
                Box::new(|panel, _, cx| {
                    panel.menu_open = false;
                    panel.allow_unlock_next = true;
                    panel.load_vault_databases(true, cx);
                    cx.notify();
                }),
            ));
        }
        Some(VaultErrorKind::Error) => {
            list = list.child(div().mx(px(8.0)).my(px(4.0)).h(px(1.0)).bg(divider));
            let msg = vault_error.unwrap_or("Vault unavailable").to_owned();
            list = list.child(
                div()
                    .px(px(8.0))
                    .py(px(4.0))
                    .text_size(px(12.0))
                    .text_color(muted)
                    .child(msg),
            );
            list = list.child(menu_action(
                "db-menu-retry-vault",
                "Retry Vault",
                Box::new(|panel, _, cx| {
                    panel.menu_open = false;
                    panel.load_vault_databases(true, cx);
                    cx.notify();
                }),
            ));
        }
        _ => {}
    }

    if let Some(selected) = selected
        && selected.source != ConnectionSource::Vault
    {
        let label = if selected.source == ConnectionSource::Env {
            "Copy to a new connection…"
        } else {
            "Edit connection…"
        };
        list = list.child(menu_action(
            "db-menu-edit",
            label,
            Box::new(|panel, window, cx| panel.begin_edit_selected(window, cx)),
        ));
    }

    if selected.is_some_and(|conn| conn.source == ConnectionSource::Manual) {
        list = list.child(menu_action(
            "db-menu-delete",
            "Delete connection",
            Box::new(|panel, _, cx| panel.delete_selected_connection(cx)),
        ));
    }

    deferred(
        div()
            .absolute()
            .top(px(chrome::CONTROL_HEIGHT_PX + 6.0))
            .left(px(0.0))
            .child(list),
    )
    .with_priority(2)
    .into_any_element()
}

/// Top connection error alert (`tablesLoad.error` in `DatabasePanel.tsx`).
pub(crate) fn render_connection_alert(tokens: &Tokens, error: &str) -> AnyElement {
    let warning = to_hsla(tokens.warning);
    div()
        .w_full()
        .flex_shrink_0()
        .border_b_1()
        .border_color(to_hsla(tokens.shell_divider))
        .p(px(8.0))
        .child(
            h_flex()
                .items_start()
                .gap(px(8.0))
                .rounded(px(8.0))
                .bg(chrome::alpha(tokens.warning, 0.10))
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(warning)
                .child(div().mt(px(2.0)).flex_shrink_0().child(superhero_icon(
                    "superhero/error-circle.svg",
                    16.0,
                    warning,
                )))
                .child(div().flex_1().min_w_0().child(error.to_owned())),
        )
        .into_any_element()
}

/// Result rows table (`RowsGrid` in `DatabasePanel.tsx`): mono `text-xs`, `h-8` column header,
/// `px-3 py-1.5 first:ps-4` cells with `max-w-72` truncation and italic `NULL`.
pub(crate) fn render_rows_grid(tokens: &Tokens, result: &DatabaseQueryResult) -> AnyElement {
    if result.columns.is_empty() {
        return div()
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0))
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(to_hsla(tokens.muted_foreground))
            .child("The query returned no columns.")
            .into_any_element();
    }

    let mono: SharedString = MONO_FONT.into();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let null_color = chrome::alpha(tokens.muted_foreground, 0.7);
    let divider = to_hsla(tokens.shell_divider);
    let header_bg = to_hsla(tokens.shell_card);
    let row_hover = chrome::alpha(tokens.foreground, 0.04);

    let widths = measure_column_widths(result);
    let total_width: f32 = widths.iter().sum();
    let last_col = widths.len().saturating_sub(1);

    let mut header_row = h_flex()
        .w_full()
        .min_w(px(total_width))
        .h(px(32.0))
        .items_center()
        .bg(header_bg)
        .border_b_1()
        .border_color(divider)
        .font_family(mono.clone())
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(muted);

    for (index, column) in result.columns.iter().enumerate() {
        let width = widths.get(index).copied().unwrap_or(120.0);
        let mut cell = div()
            .h_full()
            .flex()
            .items_center()
            .pl(px(if index == 0 { 16.0 } else { 12.0 }))
            .pr(px(12.0))
            .overflow_hidden()
            .whitespace_nowrap()
            .truncate()
            .child(column.clone());
        if index == last_col {
            cell = cell.flex_1().min_w(px(width));
        } else {
            cell = cell.w(px(width)).flex_shrink_0();
        }
        header_row = header_row.child(cell);
    }

    let mut table = v_flex()
        .w_full()
        .min_w(px(total_width))
        .font_family(mono)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .child(header_row);

    for (row_index, row) in result.rows.iter().enumerate() {
        let mut line = h_flex()
            .id(SharedString::from(format!("db-row-{row_index}")))
            .a11y_group(format!("panel.database.row.{row_index}"), format!("Result row {}", row_index + 1))
            .w_full()
            .min_w(px(total_width))
            .items_center()
            .border_b_1()
            .border_color(divider)
            .text_color(fg)
            .hover(move |s| s.bg(row_hover));

        for (col_index, column) in result.columns.iter().enumerate() {
            let width = widths.get(col_index).copied().unwrap_or(120.0);
            let mut cell = div()
                .pl(px(if col_index == 0 { 16.0 } else { 12.0 }))
                .pr(px(12.0))
                .py(px(6.0))
                .overflow_hidden()
                .whitespace_nowrap()
                .truncate();
            if col_index == last_col {
                cell = cell.flex_1().min_w(px(width));
            } else {
                cell = cell.w(px(width)).flex_shrink_0();
            }
            match format_cell_value(row.get(column)) {
                CellDisplay::Null => {
                    cell = cell.italic().text_color(null_color).child("NULL");
                }
                CellDisplay::Text(text) => {
                    cell = cell.child(text);
                }
            }
            line = line.child(cell);
        }
        table = table.child(line);
    }

    table.into_any_element()
}

/// Column metadata list (`StructureList` in `DatabasePanel.tsx`).
pub(crate) fn render_structure_list(tokens: &Tokens, columns: &[DatabaseColumn]) -> AnyElement {
    let mono: SharedString = MONO_FONT.into();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let warning = to_hsla(tokens.warning);
    let divider = to_hsla(tokens.shell_divider);

    let mut list = v_flex().w_full().pb(px(8.0));
    for column in columns {
        let mut name_col = h_flex()
            .w(relative(0.4))
            .flex_shrink_0()
            .min_w_0()
            .items_center()
            .gap(px(6.0))
            .font_family(mono.clone())
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(div().min_w_0().truncate().child(column.name.clone()));

        if column.primary {
            name_col = name_col.child(superhero_icon("superhero/key.svg", 14.0, warning));
        }

        list = list.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(12.0))
                .py(px(8.0))
                .pl(px(ROW_PAD_START_PX))
                .pr(px(TOOLBAR_PAD_END_PX))
                .border_b_1()
                .border_color(divider)
                .child(name_col)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(format_column_details(column)),
                ),
        );
    }
    list.into_any_element()
}
