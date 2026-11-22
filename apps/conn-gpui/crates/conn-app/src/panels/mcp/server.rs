//! The Server tab of the MCP panel (Conn `McpPanel.tsx` `ServerTab`): connected server info,
//! capabilities, instructions, server name, stdio working folder, and environment/header rows.

use conn_desktop::mcp::servers::{McpRow, McpServerDraft, McpTransport};
use conn_desktop::mcp::store::McpSession;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, FontWeight, IntoElement, ParentElement, SharedString, Styled,
    Window, div, px,
};

use super::McpPanel;
use super::helpers::capitalize;
use super::widgets::{McpBadgeVariant, badge, field_box};
use crate::panels::chrome::{
    self, ConnTooltipExt as _, ROW_PAD_START_PX, TOOLBAR_PAD_END_PX, UI_LINE_HEIGHT_PX, UI_TEXT_PX,
    XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use crate::panels::color::to_hsla;
use crate::theme::MONO_FONT;

impl McpPanel {
    /// Returns (or creates) the name/value inputs for an env or header row.
    fn server_row_inputs(
        &mut self,
        row: &McpRow,
        is_env: bool,
        name_placeholder: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> (Entity<InputState>, Entity<InputState>) {
        if let Some(inputs) = self.row_inputs.get(&row.id) {
            return inputs.clone();
        }
        let placeholder = name_placeholder.to_owned();
        let name = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(placeholder);
            state.set_value(row.name.clone(), window, cx);
            state
        });
        let value = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Value");
            state.set_value(row.value.clone(), window, cx);
            state
        });
        let mut subs = Vec::with_capacity(2);
        for (input, is_name) in [(&name, true), (&value, false)] {
            let row_id = row.id.clone();
            let sub = cx.subscribe(input, move |this, input, event: &InputEvent, cx| {
                if !matches!(event, InputEvent::Change) || this.syncing_inputs {
                    return;
                }
                let text = input.read(cx).value().to_string();
                this.edit_selected_server(cx, |server| {
                    let rows = if is_env {
                        &mut server.env
                    } else {
                        &mut server.headers
                    };
                    if let Some(target) = rows.iter_mut().find(|r| r.id == row_id) {
                        if is_name {
                            target.name = text;
                        } else {
                            target.value = text;
                        }
                    }
                });
            });
            subs.push(sub);
        }
        self.row_subscriptions.insert(row.id.clone(), subs);
        self.row_inputs
            .insert(row.id.clone(), (name.clone(), value.clone()));
        (name, value)
    }

    pub(super) fn render_server_tab(
        &mut self,
        server: &McpServerDraft,
        session: &McpSession,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let row_hover = chrome::alpha(tokens.foreground, 0.04);
        let mono: SharedString = MONO_FONT.into();
        let entity = cx.entity();

        let mut scroller = v_flex()
            .id("mcp-server-scroll")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .pb(px(12.0));

        if let Some(info) = &session.info {
            let title = info.title.as_deref().unwrap_or(&info.name).to_owned();
            let mut header = h_flex().flex_wrap().items_center().gap(px(8.0)).child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(title),
            );
            if !info.version.is_empty() {
                header = header.child(
                    div()
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(info.version.clone()),
                );
            }
            if let Some(pv) = &info.protocol_version {
                header = header.child(badge(&tokens, McpBadgeVariant::Outline, pv.clone(), true));
            }

            let caps = [
                ("tools", info.capabilities.tools),
                ("resources", info.capabilities.resources),
                ("prompts", info.capabilities.prompts),
                ("logging", info.capabilities.logging),
            ];
            let mut caps_row = h_flex().flex_wrap().gap(px(6.0));
            for (name, offered) in caps {
                if offered {
                    caps_row = caps_row.child(badge(&tokens, McpBadgeVariant::Info, name, false));
                }
            }

            let mut info_card = v_flex()
                .w_full()
                .gap(px(8.0))
                .border_b_1()
                .border_color(divider)
                .px(px(ROW_PAD_START_PX))
                .py(px(12.0))
                .child(header)
                .child(caps_row);
            if let Some(instructions) = info.instructions.as_deref().filter(|text| !text.is_empty())
            {
                info_card = info_card.child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(instructions.to_owned()),
                );
            }
            scroller = scroller.child(info_card);
        }

        // Server name + stdio folder inputs.
        let mut form = v_flex()
            .w_full()
            .gap(px(12.0))
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0))
            .child(
                v_flex()
                    .w_full()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Name"),
                    )
                    .child(
                        field_box(&tokens).child(
                            Input::new(&self.name_input)
                                .appearance(false)
                                .text_size(px(XS_TEXT_PX)),
                        ),
                    ),
            );

        if server.transport == McpTransport::Stdio {
            form = form.child(
                v_flex()
                    .w_full()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Folder on this machine"),
                    )
                    .child(
                        field_box(&tokens).child(
                            Input::new(&self.cwd_input)
                                .appearance(false)
                                .text_size(px(XS_TEXT_PX)),
                        ),
                    ),
            );
        }
        scroller = scroller.child(form);

        let is_env = server.transport == McpTransport::Stdio;
        let noun = if is_env { "variable" } else { "header" };
        let noun_cap = capitalize(noun);
        let section_title = if is_env {
            "Environment variables"
        } else {
            "Headers"
        };
        scroller = scroller.child(
            div()
                .px(px(ROW_PAD_START_PX))
                .pb(px(4.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(section_title),
        );

        let rows_snapshot = if is_env {
            server.env.clone()
        } else {
            server.headers.clone()
        };

        let mut rows_col = v_flex().w_full();
        for row in rows_snapshot {
            let (name_input, value_input) =
                self.server_row_inputs(&row, is_env, &noun_cap, window, cx);
            let group = SharedString::from(format!("mcp-kv-{}", row.id));
            let toggle_id = row.id.clone();
            let remove_id = row.id.clone();
            let entity_toggle = entity.clone();
            let entity_remove = entity.clone();

            let cell = |input: &Entity<InputState>, dim: bool| {
                div()
                    .flex_1()
                    .min_w_0()
                    .h(px(32.0))
                    .flex()
                    .items_center()
                    .font_family(mono.clone())
                    .when(dim, |el| el.opacity(0.5))
                    .child(
                        Input::new(input)
                            .appearance(false)
                            .text_size(px(XS_TEXT_PX)),
                    )
            };

            rows_col = rows_col.child(
                h_flex()
                    .id(SharedString::from(format!("mcp-kv-row-{}", row.id)))
                    .group(group.clone())
                    .w_full()
                    .items_center()
                    .gap(px(12.0))
                    .pl(px(ROW_PAD_START_PX))
                    .pr(px(TOOLBAR_PAD_END_PX))
                    .border_b_1()
                    .border_color(divider)
                    .hover(move |s| s.bg(row_hover))
                    .child(chrome::checkbox(
                        SharedString::from(format!("mcp-kv-check-{}", row.id)),
                        row.enabled,
                        &tokens,
                        move |_, _, cx| {
                            let id = toggle_id.clone();
                            entity_toggle.update(cx, |panel, cx| {
                                panel.edit_selected_server(cx, |server| {
                                    let rows = if is_env {
                                        &mut server.env
                                    } else {
                                        &mut server.headers
                                    };
                                    if let Some(target) = rows.iter_mut().find(|r| r.id == id) {
                                        target.enabled = !target.enabled;
                                    }
                                });
                            });
                        },
                    ))
                    .child(cell(&name_input, !row.enabled))
                    .child(cell(&value_input, false))
                    .child(
                        div().invisible().group_hover(group, |s| s.visible()).child(
                            chrome::icon_button(
                                SharedString::from(format!("mcp-kv-remove-{}", row.id)),
                                "superhero/close.svg",
                                &tokens,
                                false,
                                move |_, _, cx| {
                                    let id = remove_id.clone();
                                    entity_remove.update(cx, |panel, cx| {
                                        panel.row_inputs.remove(&id);
                                        panel.row_subscriptions.remove(&id);
                                        panel.edit_selected_server(cx, |server| {
                                            let rows = if is_env {
                                                &mut server.env
                                            } else {
                                                &mut server.headers
                                            };
                                            rows.retain(|r| r.id != id);
                                        });
                                    });
                                },
                            )
                            .conn_tooltip(format!("Remove {noun}"), &tokens),
                        ),
                    ),
            );
        }

        let entity_add = entity;
        rows_col = rows_col.child(div().pl(px(10.0)).pt(px(6.0)).child(chrome::text_button(
            SharedString::from(format!("mcp-add-{noun}")),
            Some("superhero/add.svg"),
            format!("Add {noun}"),
            &tokens,
            move |_, _, cx| {
                entity_add.update(cx, |panel, cx| {
                    panel.edit_selected_server(cx, |server| {
                        let rows = if is_env {
                            &mut server.env
                        } else {
                            &mut server.headers
                        };
                        rows.push(McpRow::new("", ""));
                    });
                });
            },
        )));

        scroller.child(rows_col).into_any_element()
    }
}
