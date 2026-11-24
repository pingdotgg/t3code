//! The Log tab of the MCP panel (Conn `McpPanel.tsx` `LogTab` / `LogRow`).

use crate::a11y::ConnA11yExt as _;
use conn_desktop::mcp::store::McpLogEntry;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{AnyElement, Context, IntoElement, ParentElement, SharedString, Styled, div, px};

use super::McpPanel;
use super::helpers::{format_log_time, format_rpc_id, log_row_label};
use super::widgets::{McpBadgeVariant, badge};
use crate::panels::chrome::{self, ROW_PAD_START_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

impl McpPanel {
    pub(super) fn render_log_tab(
        &self,
        log: &[McpLogEntry],
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        if log.is_empty() {
            return chrome::empty_state(
                tokens,
                "Messages between the panel and the server appear here.",
            )
            .into_any_element();
        }

        let divider = to_hsla(tokens.shell_divider);
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let row_hover = chrome::alpha(tokens.foreground, 0.04);
        let expanded_bg = chrome::alpha(tokens.foreground, 0.02);
        let mono: SharedString = MONO_FONT.into();
        let entity = cx.entity();

        let mut list = v_flex()
            .id("mcp-log-scroll")
            .a11y_group("panel.mcp.log", "MCP log")
            .track_scroll(&self.log_scroll)
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll();

        for entry in log {
            let expandable = !entry.message.is_null();
            let expanded = expandable && self.expanded_log_ids.contains(&entry.id);
            let (label, is_response) = log_row_label(entry);
            let entry_id = entry.id;

            let (icon_path, icon_color) = match entry.kind.as_str() {
                "send" => ("superhero/arrow-up-right.svg", to_hsla(tokens.info)),
                "receive" => ("superhero/arrow-down-left.svg", to_hsla(tokens.success)),
                "stderr" => ("superhero/terminal-window.svg", muted),
                _ => ("superhero/unplug.svg", to_hsla(tokens.warning)),
            };

            let chevron = div()
                .w(px(14.0))
                .flex_shrink_0()
                .pt(px(1.0))
                .when(expandable, |el| {
                    el.child(superhero_icon(
                        if expanded {
                            "superhero/chevron-down.svg"
                        } else {
                            "superhero/chevron-right.svg"
                        },
                        14.0,
                        muted,
                    ))
                });

            let label_el = if entry.kind == "stderr" {
                div().flex_1().min_w_0().text_color(muted).child(label)
            } else {
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .child(div().truncate().text_color(fg).child(label))
                    .when(is_response, |el| {
                        el.child(div().flex_shrink_0().text_color(muted).child(" result"))
                    })
            };

            let mut row_button = h_flex()
                .id(SharedString::from(format!("mcp-log-row-{entry_id}")))
                .a11y_group(format!("panel.mcp.log-row.{entry_id}"), "MCP log entry")
                .w_full()
                .min_w_0()
                .items_start()
                .gap(px(8.0))
                .px(px(ROW_PAD_START_PX))
                .py(px(6.0))
                .font_family(mono.clone())
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .hover(move |s| s.bg(row_hover))
                .child(chevron)
                .child(superhero_icon(icon_path, 14.0, icon_color))
                .child(label_el);

            if entry.is_error {
                row_button =
                    row_button.child(badge(tokens, McpBadgeVariant::Error, "error", false));
            }
            if let Some(rpc_id) = &entry.rpc_id {
                row_button = row_button.child(
                    div()
                        .flex_shrink_0()
                        .text_color(muted)
                        .child(format_rpc_id(rpc_id)),
                );
            }
            row_button = row_button.child(
                div()
                    .flex_shrink_0()
                    .text_color(muted)
                    .child(format_log_time(entry.at)),
            );

            if expandable {
                let entity = entity.clone();
                row_button = row_button.cursor_pointer().on_click(move |_, _, cx| {
                    entity.update(cx, |panel, cx| {
                        if !panel.expanded_log_ids.remove(&entry_id) {
                            panel.expanded_log_ids.insert(entry_id);
                        }
                        cx.notify();
                    });
                });
            }

            let mut wrapper = v_flex()
                .w_full()
                .border_b_1()
                .border_color(divider)
                .child(row_button);

            if expanded {
                let pretty = serde_json::to_string_pretty(&entry.message)
                    .unwrap_or_else(|_| entry.message.to_string());
                wrapper = wrapper.child(
                    div()
                        .w_full()
                        .min_w_0()
                        .bg(expanded_bg)
                        .pl(px(40.0))
                        .pr(px(ROW_PAD_START_PX))
                        .py(px(8.0))
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(fg)
                        .child(pretty),
                );
            }

            list = list.child(wrapper);
        }

        list.into_any_element()
    }
}
