//! The Tools, Resources, and Prompts tabs (Conn `McpCatalogViews.tsx`): a filterable 208px
//! item list beside an Overview / Playground detail pane with schema-driven forms and
//! Result / JSON response rendering.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash as _, Hasher as _};
use std::sync::Arc;

use conn_desktop::api_request::toolbar::{format_bytes, format_ms};
use conn_desktop::mcp::results::{has_markdown, pretty_json, raw_result_text};
use conn_desktop::mcp::servers::{
    McpField, McpFieldType, arguments_from_fields, expand_template, fields_from_schema,
    template_variables,
};
use conn_desktop::mcp::store::{McpCall, McpDetailTab, McpSession, McpTool};
use conn_desktop::mcp::{McpMethod, McpResponse};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, Entity, FontWeight, IntoElement, ParentElement,
    RenderImage, SharedString, Styled, Window, div, img, px, relative,
};
use serde_json::{Value, json};

use super::helpers::{
    CatalogListItem, PanelTab, ResourceEntry, base64_byte_len, build_prompt_arguments,
    build_resource_entries, capitalize, decode_base64, field_type_label, filter_catalog_items,
    prompt_fields, template_fields, validate_template_variables,
};
use super::widgets::{
    McpBadgeVariant, McpMenuEntry, McpMenuRow, badge, code_block, dropdown_menu, field_box,
    render_markdown,
};
use super::{FieldInputKey, McpPanel, OpenMenu, ResultTab};
use crate::panels::chrome::{
    self, ConnTooltipExt as _, ICON_BUTTON_GLYPH_PX, ROW_PAD_START_PX, SectionTab,
    UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use crate::panels::color::to_hsla;
use crate::panels::header::superhero_icon;
use crate::theme::MONO_FONT;

/// Width of the left item list (`w-52` = 208px).
const LIST_WIDTH_PX: f32 = 208.0;

/// What clicking the Playground run button executes.
#[derive(Clone)]
pub(super) enum RunAction {
    Tool {
        name: String,
        fields: Vec<McpField>,
    },
    Resource {
        uri: String,
    },
    Template {
        uri_template: String,
        variables: Vec<String>,
    },
    Prompt {
        name: String,
        fields: Vec<McpField>,
    },
}

struct DetailSpec {
    call_key: String,
    title: String,
    name: Option<String>,
    description: Option<String>,
    badges: Vec<AnyElement>,
    overview_details: Option<AnyElement>,
    fields: Vec<McpField>,
    no_fields: &'static str,
    run_label: &'static str,
    idle_result: &'static str,
    run_action: RunAction,
}

impl McpPanel {
    /// Executes the active catalog item's Playground call (used by the Run button and `Cmd+Enter`).
    pub(super) fn execute_run_action(
        &mut self,
        session_key: &str,
        call_key: &str,
        action: RunAction,
        cx: &mut Context<'_, Self>,
    ) {
        let values: HashMap<String, String> = self
            .sessions
            .get(session_key)
            .and_then(|s| s.forms.get(call_key))
            .cloned()
            .unwrap_or_default();

        match action {
            RunAction::Tool { name, fields } => match arguments_from_fields(&fields, &values) {
                Ok(arguments) => self.run_call(
                    session_key.to_owned(),
                    call_key.to_owned(),
                    McpMethod::ToolsCall,
                    json!({ "name": name, "arguments": arguments }),
                    cx,
                ),
                Err(error) => self.fail_call(session_key, call_key, error, cx),
            },
            RunAction::Resource { uri } => self.run_call(
                session_key.to_owned(),
                call_key.to_owned(),
                McpMethod::ResourcesRead,
                json!({ "uri": uri }),
                cx,
            ),
            RunAction::Template {
                uri_template,
                variables,
            } => match validate_template_variables(&variables, &values) {
                Ok(()) => {
                    let uri = expand_template(&uri_template, &values);
                    self.run_call(
                        session_key.to_owned(),
                        call_key.to_owned(),
                        McpMethod::ResourcesRead,
                        json!({ "uri": uri }),
                        cx,
                    );
                }
                Err(error) => self.fail_call(session_key, call_key, error, cx),
            },
            RunAction::Prompt { name, fields } => match build_prompt_arguments(&fields, &values) {
                Ok(arguments) => self.run_call(
                    session_key.to_owned(),
                    call_key.to_owned(),
                    McpMethod::PromptsGet,
                    json!({ "name": name, "arguments": arguments }),
                    cx,
                ),
                Err(error) => self.fail_call(session_key, call_key, error, cx),
            },
        }
    }

    /// Runs the currently shown item if the user is on a connected Playground tab.
    pub(super) fn run_active_playground(
        &mut self,
        session_key: &str,
        active_tab: PanelTab,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let Some(session) = self.sessions.get(session_key) else {
            return false;
        };
        if session.detail_tab != McpDetailTab::Playground {
            return false;
        }
        let target: Option<(String, RunAction)> = match active_tab {
            PanelTab::Tools => session.shown_tool().map(|tool| {
                (
                    format!("tool:{}", tool.name),
                    RunAction::Tool {
                        name: tool.name.clone(),
                        fields: fields_from_schema(&tool.input_schema),
                    },
                )
            }),
            PanelTab::Resources => {
                let (entries, _) = build_resource_entries(session);
                let selected_id = self.selected_resource.get(session_key).map(String::as_str);
                entries
                    .iter()
                    .find(|e| Some(e.id()) == selected_id)
                    .or_else(|| entries.first())
                    .map(|entry| match entry {
                        ResourceEntry::Resource { id, resource } => (
                            id.clone(),
                            RunAction::Resource {
                                uri: resource.uri.clone(),
                            },
                        ),
                        ResourceEntry::Template { id, template } => (
                            id.clone(),
                            RunAction::Template {
                                uri_template: template.uri_template.clone(),
                                variables: template_variables(&template.uri_template),
                            },
                        ),
                    })
            }
            PanelTab::Prompts => {
                let prompts = session.prompts.as_deref().unwrap_or_default();
                let selected_name = self.selected_prompt.get(session_key).map(String::as_str);
                prompts
                    .iter()
                    .find(|p| Some(p.name.as_str()) == selected_name)
                    .or_else(|| prompts.first())
                    .map(|prompt| {
                        (
                            format!("prompt:{}", prompt.name),
                            RunAction::Prompt {
                                name: prompt.name.clone(),
                                fields: prompt_fields(prompt),
                            },
                        )
                    })
            }
            PanelTab::Log | PanelTab::Server => None,
        };
        let Some((call_key, action)) = target else {
            return false;
        };
        if session.calls.get(&call_key).is_some_and(|c| c.running) {
            return true;
        }
        self.execute_run_action(session_key, &call_key, action, cx);
        true
    }

    pub(super) fn render_tools_tab(
        &mut self,
        session_key: &str,
        session: &McpSession,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tools = session.tools.as_deref().unwrap_or_default();
        let selected_tool: Option<McpTool> = session.shown_tool().cloned();
        let items: Vec<CatalogListItem> = tools
            .iter()
            .map(|tool| CatalogListItem {
                id: tool.name.clone(),
                label: tool_title(tool).to_owned(),
                detail: tool.description.clone(),
            })
            .collect();
        let loading = session.tools.is_none();
        let list_error = session
            .list_errors
            .get(&conn_desktop::mcp::store::McpListKind::Tools)
            .cloned();
        let filter_input = self.tools_filter_input.clone();
        let filter_query = filter_input.read(cx).value().to_string();
        let sk = session_key.to_owned();
        let entity = cx.entity();

        let list = self.render_item_list(
            "tools",
            &items,
            selected_tool.as_ref().map(|t| t.name.as_str()),
            None,
            list_error.as_deref(),
            loading,
            &filter_input,
            &filter_query,
            move |id, _, cx| {
                let sk = sk.clone();
                entity.update(cx, |panel, cx| {
                    panel.sessions.entry(sk).or_default().selected_tool = Some(id);
                    panel.menu = None;
                    cx.notify();
                });
            },
        );

        let detail = if let Some(tool) = selected_tool {
            let fields = fields_from_schema(&tool.input_schema);
            let badges = tool_badges(&self.tokens, &tool);
            let overview_details =
                (!fields.is_empty()).then(|| render_fields_list(&self.tokens, &fields));
            let spec = DetailSpec {
                call_key: format!("tool:{}", tool.name),
                title: tool_title(&tool).to_owned(),
                name: Some(tool.name.clone()),
                description: tool.description.clone(),
                badges,
                overview_details,
                fields: fields.clone(),
                no_fields: "This tool takes no arguments.",
                run_label: "Call",
                idle_result: "Call the tool to see its result.",
                run_action: RunAction::Tool {
                    name: tool.name,
                    fields,
                },
            };
            self.render_item_detail(session_key, session, spec, window, cx)
        } else {
            chrome::empty_state(
                &self.tokens,
                if loading {
                    ""
                } else {
                    "This server has no tools."
                },
            )
            .into_any_element()
        };

        h_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(list)
            .child(v_flex().flex_1().min_w_0().min_h_0().child(detail))
            .into_any_element()
    }

    pub(super) fn render_resources_tab(
        &mut self,
        session_key: &str,
        session: &McpSession,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let (entries, first_template_id) = build_resource_entries(session);
        let selected_id = self.selected_resource.get(session_key).map(String::as_str);
        let selected = entries
            .iter()
            .find(|e| Some(e.id()) == selected_id)
            .or_else(|| entries.first())
            .cloned();
        let items: Vec<CatalogListItem> = entries
            .iter()
            .map(|entry| CatalogListItem {
                id: entry.id().to_owned(),
                label: entry.title().to_owned(),
                detail: Some(entry.uri_display().to_owned()),
            })
            .collect();
        let loading = session.resources.is_none();
        let list_error = session
            .list_errors
            .get(&conn_desktop::mcp::store::McpListKind::Resources)
            .cloned();
        let filter_input = self.resources_filter_input.clone();
        let filter_query = filter_input.read(cx).value().to_string();
        let sk = session_key.to_owned();
        let entity = cx.entity();

        let list = self.render_item_list(
            "resources",
            &items,
            selected.as_ref().map(ResourceEntry::id),
            first_template_id.as_deref().map(|id| (id, "Templates")),
            list_error.as_deref(),
            loading,
            &filter_input,
            &filter_query,
            move |id, _, cx| {
                let sk = sk.clone();
                entity.update(cx, |panel, cx| {
                    panel.selected_resource.insert(sk, id);
                    panel.menu = None;
                    cx.notify();
                });
            },
        );

        let detail = if let Some(entry) = selected {
            let badges = entry
                .mime_type()
                .map(|mime| {
                    vec![
                        badge(
                            &self.tokens,
                            McpBadgeVariant::Outline,
                            mime.to_owned(),
                            false,
                        )
                        .into_any_element(),
                    ]
                })
                .unwrap_or_default();
            let overview_details = Some(
                div()
                    .w_full()
                    .min_w_0()
                    .font_family(SharedString::from(MONO_FONT))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(to_hsla(self.tokens.muted_foreground))
                    .child(entry.uri_display().to_owned())
                    .into_any_element(),
            );
            let (fields, run_action) = match &entry {
                ResourceEntry::Resource { resource, .. } => (
                    Vec::new(),
                    RunAction::Resource {
                        uri: resource.uri.clone(),
                    },
                ),
                ResourceEntry::Template { template, .. } => {
                    let vars = template_variables(&template.uri_template);
                    (
                        template_fields(&vars),
                        RunAction::Template {
                            uri_template: template.uri_template.clone(),
                            variables: vars,
                        },
                    )
                }
            };
            let spec = DetailSpec {
                call_key: entry.id().to_owned(),
                title: entry.title().to_owned(),
                name: None,
                description: entry.description().map(str::to_owned),
                badges,
                overview_details,
                fields,
                no_fields: "This resource takes no arguments.",
                run_label: "Read",
                idle_result: "Read the resource to see its contents.",
                run_action,
            };
            self.render_item_detail(session_key, session, spec, window, cx)
        } else {
            chrome::empty_state(
                &self.tokens,
                if loading {
                    ""
                } else {
                    "This server has no resources."
                },
            )
            .into_any_element()
        };

        h_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(list)
            .child(v_flex().flex_1().min_w_0().min_h_0().child(detail))
            .into_any_element()
    }

    pub(super) fn render_prompts_tab(
        &mut self,
        session_key: &str,
        session: &McpSession,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let prompts = session.prompts.as_deref().unwrap_or_default();
        let selected_name = self.selected_prompt.get(session_key).map(String::as_str);
        let selected = prompts
            .iter()
            .find(|p| Some(p.name.as_str()) == selected_name)
            .or_else(|| prompts.first())
            .cloned();
        let items: Vec<CatalogListItem> = prompts
            .iter()
            .map(|prompt| CatalogListItem {
                id: prompt.name.clone(),
                label: prompt.title.as_deref().unwrap_or(&prompt.name).to_owned(),
                detail: prompt.description.clone(),
            })
            .collect();
        let loading = session.prompts.is_none();
        let list_error = session
            .list_errors
            .get(&conn_desktop::mcp::store::McpListKind::Prompts)
            .cloned();
        let filter_input = self.prompts_filter_input.clone();
        let filter_query = filter_input.read(cx).value().to_string();
        let sk = session_key.to_owned();
        let entity = cx.entity();

        let list = self.render_item_list(
            "prompts",
            &items,
            selected.as_ref().map(|p| p.name.as_str()),
            None,
            list_error.as_deref(),
            loading,
            &filter_input,
            &filter_query,
            move |id, _, cx| {
                let sk = sk.clone();
                entity.update(cx, |panel, cx| {
                    panel.selected_prompt.insert(sk, id);
                    panel.menu = None;
                    cx.notify();
                });
            },
        );

        let detail = if let Some(prompt) = selected {
            let fields = prompt_fields(&prompt);
            let overview_details =
                (!fields.is_empty()).then(|| render_fields_list(&self.tokens, &fields));
            let title = prompt.title.as_deref().unwrap_or(&prompt.name).to_owned();
            let spec = DetailSpec {
                call_key: format!("prompt:{}", prompt.name),
                title,
                name: Some(prompt.name.clone()),
                description: prompt.description.clone(),
                badges: Vec::new(),
                overview_details,
                fields: fields.clone(),
                no_fields: "This prompt takes no arguments.",
                run_label: "Get",
                idle_result: "Get the prompt to see its messages.",
                run_action: RunAction::Prompt {
                    name: prompt.name,
                    fields,
                },
            };
            self.render_item_detail(session_key, session, spec, window, cx)
        } else {
            chrome::empty_state(
                &self.tokens,
                if loading {
                    ""
                } else {
                    "This server has no prompts."
                },
            )
            .into_any_element()
        };

        h_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(list)
            .child(v_flex().flex_1().min_w_0().min_h_0().child(detail))
            .into_any_element()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "internal helper mirroring Conn's ItemList props"
    )]
    fn render_item_list(
        &self,
        noun: &'static str,
        items: &[CatalogListItem],
        selected_id: Option<&str>,
        section: Option<(&str, &'static str)>,
        error: Option<&str>,
        loading: bool,
        filter_input: &Entity<InputState>,
        filter_query: &str,
        on_select: impl Fn(String, &mut Window, &mut gpui_kit::App) + Clone + 'static,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let highlight = to_hsla(tokens.shell_highlight);
        let row_hover = chrome::alpha(tokens.foreground, 0.04);

        let search_bar = div().w_full().flex_shrink_0().p(px(8.0)).child(
            chrome::soft_input_group(tokens)
                .child(div().pl(px(9.0)).flex_shrink_0().child(superhero_icon(
                    "superhero/search.svg",
                    ICON_BUTTON_GLYPH_PX,
                    muted,
                )))
                .child(
                    div().flex_1().min_w_0().pl(px(8.0)).pr(px(14.0)).child(
                        Input::new(filter_input)
                            .appearance(false)
                            .text_size(px(UI_TEXT_PX)),
                    ),
                ),
        );

        let visible = filter_catalog_items(items, filter_query);
        let has_query = !filter_query.trim().is_empty();

        let mut list = v_flex()
            .id(SharedString::from(format!("mcp-list-{noun}")))
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .px(px(6.0))
            .pb(px(8.0));

        if let Some(err) = error {
            list = list.child(chrome::warning_notice(tokens, err.to_owned()));
        }
        if loading {
            list = list.child(
                h_flex()
                    .w_full()
                    .justify_center()
                    .py(px(12.0))
                    .child(superhero_icon("superhero/spinner.svg", 16.0, muted)),
            );
        } else if visible.is_empty() {
            list = list.child(
                div()
                    .px(px(10.0))
                    .py(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(format!("No {noun}")),
            );
        }

        for item in visible {
            let is_selected = selected_id == Some(item.id.as_str());
            if !has_query
                && let Some((section_id, section_title)) = section
                && section_id == item.id
            {
                list = list.child(
                    div()
                        .px(px(10.0))
                        .pt(px(12.0))
                        .pb(px(4.0))
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(section_title),
                );
            }
            let item_id = item.id.clone();
            let on_select = on_select.clone();
            list = list.child(
                h_flex()
                    .id(SharedString::from(format!("mcp-{noun}-item-{}", item.id)))
                    .h(px(28.0))
                    .w_full()
                    .items_center()
                    .rounded(px(6.0))
                    .px(px(10.0))
                    .cursor_pointer()
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .when(is_selected, |el| el.bg(highlight).text_color(fg))
                    .when(!is_selected, |el| {
                        el.text_color(muted)
                            .hover(move |s| s.bg(row_hover).text_color(fg))
                    })
                    .on_click(move |_, window, cx| on_select(item_id.clone(), window, cx))
                    .child(div().min_w_0().truncate().child(item.label.clone())),
            );
        }

        v_flex()
            .w(px(LIST_WIDTH_PX))
            .flex_shrink_0()
            .min_h_0()
            .border_r_1()
            .border_color(divider)
            .child(search_bar)
            .child(list)
            .into_any_element()
    }

    fn render_item_detail(
        &mut self,
        session_key: &str,
        session: &McpSession,
        spec: DetailSpec,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let mono: SharedString = MONO_FONT.into();
        let entity = cx.entity();

        let active_detail_id = match session.detail_tab {
            McpDetailTab::Overview => "overview",
            McpDetailTab::Playground => "playground",
        };
        let detail_tabs = [
            SectionTab {
                id: "overview",
                label: "Overview",
                count: None,
            },
            SectionTab {
                id: "playground",
                label: "Playground",
                count: None,
            },
        ];
        let sk_tab = session_key.to_owned();
        let tab_bar = chrome::section_tabs(
            "mcp-detail-tabs",
            &tokens,
            &detail_tabs,
            active_detail_id,
            None,
            {
                let entity = entity.clone();
                move |tab_id, _, cx| {
                    let sk = sk_tab.clone();
                    entity.update(cx, |panel, cx| {
                        panel.sessions.entry(sk).or_default().detail_tab = if tab_id == "playground"
                        {
                            McpDetailTab::Playground
                        } else {
                            McpDetailTab::Overview
                        };
                        panel.menu = None;
                        cx.notify();
                    });
                }
            },
        );

        let mut root = v_flex().flex_1().min_h_0().w_full().child(tab_bar);

        if session.detail_tab == McpDetailTab::Overview {
            let mut title_row = h_flex().flex_wrap().items_center().gap(px(8.0)).child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(spec.title.clone()),
            );
            if let Some(name) = spec.name.as_deref().filter(|n| *n != spec.title) {
                title_row = title_row.child(
                    div()
                        .font_family(mono)
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(name.to_owned()),
                );
            }
            for b in spec.badges {
                title_row = title_row.child(b);
            }
            let mut header_block = v_flex().w_full().gap(px(4.0)).child(title_row);
            if let Some(description) = spec.description {
                header_block = header_block.child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(description),
                );
            }
            let mut overview = v_flex()
                .id("mcp-overview-scroll")
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_y_scroll()
                .gap(px(16.0))
                .px(px(ROW_PAD_START_PX))
                .py(px(12.0))
                .child(header_block);
            if let Some(details) = spec.overview_details {
                overview = overview.child(details);
            }
            return root.child(overview).into_any_element();
        }

        // Playground tab: form top half + result bottom half.
        let call: Option<McpCall> = session.calls.get(&spec.call_key).cloned();
        let running = call.as_ref().is_some_and(|c| c.running);
        let form_values: HashMap<String, String> = session
            .forms
            .get(&spec.call_key)
            .cloned()
            .unwrap_or_default();

        let run_icon = if running {
            "superhero/spinner.svg"
        } else {
            "superhero/play.svg"
        };
        let sk_run = session_key.to_owned();
        let ck_run = spec.call_key.clone();
        let action_run = spec.run_action.clone();
        let run_hover = to_hsla(tokens.shell_highlight);
        let mut run_btn = h_flex()
            .id(SharedString::from(format!("mcp-run-{}", spec.call_key)))
            .flex_shrink_0()
            .h(px(24.0))
            .px(px(7.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(9999.0))
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(superhero_icon(run_icon, ICON_BUTTON_GLYPH_PX, muted))
            .child(spec.run_label);
        if running {
            run_btn = run_btn.opacity(0.64);
        } else {
            run_btn = run_btn
                .cursor_pointer()
                .hover(move |s| s.bg(run_hover))
                .on_click(move |_, _, cx| {
                    let sk = sk_run.clone();
                    let ck = ck_run.clone();
                    let action = action_run.clone();
                    entity.update(cx, |panel, cx| {
                        panel.execute_run_action(&sk, &ck, action, cx);
                    });
                });
        }

        let form_header = h_flex()
            .w_full()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(mono)
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(spec.name.unwrap_or(spec.title)),
            )
            .child(chrome::toolbar_group(&tokens).child(run_btn));

        let fields_el = if spec.fields.is_empty() {
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(spec.no_fields)
                .into_any_element()
        } else {
            self.render_fields_form(
                session_key,
                &spec.call_key,
                &spec.fields,
                &form_values,
                spec.run_action,
                window,
                cx,
            )
        };

        let form_pane = v_flex()
            .id("mcp-playground-form-scroll")
            .w_full()
            .max_h(relative(0.5))
            .flex_shrink_0()
            .overflow_y_scroll()
            .gap(px(12.0))
            .border_b_1()
            .border_color(divider)
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0))
            .child(form_header)
            .child(fields_el);

        let result_pane = self.render_result_view(
            session_key,
            &spec.call_key,
            call.as_ref().and_then(|c| c.response.as_ref()),
            running,
            spec.idle_result,
            cx,
        );

        root = root.child(form_pane).child(result_pane);
        root.into_any_element()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "internal helper rendering schema form inputs"
    )]
    fn render_fields_form(
        &mut self,
        session_key: &str,
        call_key: &str,
        fields: &[McpField],
        values: &HashMap<String, String>,
        run_action: RunAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let destructive = to_hsla(tokens.destructive);
        let mono: SharedString = MONO_FONT.into();
        let entity = cx.entity();

        let mut grid = v_flex().w_full().gap(px(12.0));
        for field in fields {
            let current = values
                .get(&field.name)
                .cloned()
                .unwrap_or_else(|| field.default_text.clone());

            let field_name_el = div()
                .id(SharedString::from(format!(
                    "mcp-field-name-{call_key}-{}",
                    field.name
                )))
                .min_w_0()
                .font_family(mono.clone())
                .text_color(fg)
                .child(field.name.clone())
                .when_some(
                    field
                        .description
                        .as_deref()
                        .map(str::trim)
                        .filter(|d| !d.is_empty()),
                    |el, desc| el.conn_tooltip(desc.to_owned(), &tokens),
                );
            let label_col = v_flex()
                .w(relative(0.30))
                .min_w(px(96.0))
                .flex_shrink_0()
                .gap(px(2.0))
                .pt(px(6.0))
                .child(
                    h_flex()
                        .items_baseline()
                        .gap(px(4.0))
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .child(field_name_el)
                        .when(field.required, |el| {
                            el.child(div().text_color(destructive).child("*"))
                        }),
                )
                .child(
                    div()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(field_type_label(field.field_type)),
                );

            let input_el: AnyElement = match field.field_type {
                McpFieldType::Boolean => {
                    let checked = current == "true";
                    let sk = session_key.to_owned();
                    let ck = call_key.to_owned();
                    let fname = field.name.clone();
                    let entity = entity.clone();
                    div()
                        .pt(px(6.0))
                        .child(chrome::checkbox(
                            SharedString::from(format!("mcp-field-bool-{call_key}-{}", field.name)),
                            checked,
                            &tokens,
                            move |_, _, cx| {
                                let sk = sk.clone();
                                let ck = ck.clone();
                                let fname = fname.clone();
                                entity.update(cx, |panel, cx| {
                                    let next = if checked { "false" } else { "true" };
                                    panel.set_form_value(&sk, &ck, fname, next.to_owned(), cx);
                                });
                            },
                        ))
                        .into_any_element()
                }
                McpFieldType::Enum => {
                    let is_open = matches!(
                        &self.menu,
                        Some(OpenMenu::EnumField {
                            call_key: ck,
                            field_name: fnm,
                        }) if ck == call_key && fnm == &field.name
                    );
                    let dark = tokens.appearance == Appearance::Dark;
                    let bg = if dark {
                        to_hsla(tokens.input.with_alpha(0.32))
                    } else {
                        to_hsla(tokens.popover)
                    };
                    let hover_bg = if dark {
                        to_hsla(tokens.input.with_alpha(0.64))
                    } else {
                        to_hsla(tokens.accent.with_alpha(0.50))
                    };
                    let ck_toggle = call_key.to_owned();
                    let fname_toggle = field.name.clone();
                    let entity_toggle = entity.clone();
                    let display = if current.is_empty() {
                        "Choose…".to_owned()
                    } else {
                        current.clone()
                    };
                    let trigger = h_flex()
                        .id(SharedString::from(format!(
                            "mcp-field-enum-{call_key}-{}",
                            field.name
                        )))
                        .h(px(24.0))
                        .px(px(7.0))
                        .gap(px(4.0))
                        .items_center()
                        .rounded(px(6.0))
                        .bg(bg)
                        .border_1()
                        .border_color(to_hsla(tokens.input))
                        .cursor_pointer()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(fg)
                        .hover(move |s| s.bg(hover_bg))
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            let ck = ck_toggle.clone();
                            let fnm = fname_toggle.clone();
                            entity_toggle.update(cx, |panel, cx| {
                                panel.toggle_menu(
                                    OpenMenu::EnumField {
                                        call_key: ck,
                                        field_name: fnm,
                                    },
                                    cx,
                                );
                            });
                        })
                        .child(div().font_family(mono.clone()).child(display))
                        .child(superhero_icon(
                            "superhero/chevron-down.svg",
                            ICON_BUTTON_GLYPH_PX,
                            muted,
                        ));

                    let mut anchor = div().relative().child(trigger);
                    if is_open {
                        let entries: Vec<McpMenuEntry> = field
                            .options
                            .iter()
                            .map(|option| {
                                let sk = session_key.to_owned();
                                let ck = call_key.to_owned();
                                let fnm = field.name.clone();
                                let opt = option.clone();
                                let entity = entity.clone();
                                McpMenuEntry::Row(McpMenuRow {
                                    id: SharedString::from(format!(
                                        "mcp-enum-opt-{call_key}-{}-{option}",
                                        field.name
                                    )),
                                    label: option.clone().into(),
                                    mono_label: true,
                                    detail: None,
                                    mono_detail: false,
                                    checked: *option == current,
                                    on_select: Box::new(move |_, cx| {
                                        let sk = sk.clone();
                                        let ck = ck.clone();
                                        let fnm = fnm.clone();
                                        let opt = opt.clone();
                                        entity.update(cx, |panel, cx| {
                                            panel.menu = None;
                                            panel.set_form_value(&sk, &ck, fnm, opt, cx);
                                        });
                                    }),
                                })
                            })
                            .collect();
                        anchor = anchor.child(dropdown_menu(
                            SharedString::from(format!("mcp-enum-menu-{call_key}-{}", field.name)),
                            &tokens,
                            entries,
                            24.0,
                        ));
                    }
                    anchor.into_any_element()
                }
                McpFieldType::Json => {
                    let textarea = self.field_json_input(
                        session_key,
                        call_key,
                        &field.name,
                        &current,
                        window,
                        cx,
                    );
                    field_box(&tokens)
                        .child(
                            Textarea::new(&textarea)
                                .appearance(false)
                                .text_size(px(XS_TEXT_PX)),
                        )
                        .into_any_element()
                }
                McpFieldType::String | McpFieldType::Number | McpFieldType::Integer => {
                    let input = self.field_text_input(
                        session_key,
                        call_key,
                        &field.name,
                        &current,
                        run_action.clone(),
                        window,
                        cx,
                    );
                    field_box(&tokens)
                        .child(
                            Input::new(&input)
                                .appearance(false)
                                .text_size(px(XS_TEXT_PX)),
                        )
                        .into_any_element()
                }
            };

            grid = grid.child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap(px(16.0))
                    .child(label_col)
                    .child(div().flex_1().min_w_0().child(input_el)),
            );
        }
        grid.into_any_element()
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "field input lookup + subscription wiring"
    )]
    fn field_text_input(
        &mut self,
        session_key: &str,
        call_key: &str,
        field_name: &str,
        initial: &str,
        run_action: RunAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<InputState> {
        let key = FieldInputKey {
            session_key: session_key.to_owned(),
            call_key: call_key.to_owned(),
            field_name: field_name.to_owned(),
        };
        if let Some(input) = self.field_text_inputs.get(&key) {
            return input.clone();
        }
        let initial_value = initial.to_owned();
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(initial_value, window, cx);
            state
        });
        let sk = session_key.to_owned();
        let ck = call_key.to_owned();
        let fnm = field_name.to_owned();
        let sub = cx.subscribe(
            &input,
            move |this, input, event: &InputEvent, cx| match event {
                InputEvent::Change if !this.syncing_inputs => {
                    let val = input.read(cx).value().to_string();
                    this.set_form_value(&sk, &ck, fnm.clone(), val, cx);
                }
                InputEvent::PressEnter { .. } => {
                    this.execute_run_action(&sk, &ck, run_action.clone(), cx);
                }
                _ => {}
            },
        );
        self.field_subscriptions.insert(key.clone(), sub);
        self.field_text_inputs.insert(key, input.clone());
        input
    }

    fn field_json_input(
        &mut self,
        session_key: &str,
        call_key: &str,
        field_name: &str,
        initial: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Entity<TextareaState> {
        let key = FieldInputKey {
            session_key: session_key.to_owned(),
            call_key: call_key.to_owned(),
            field_name: field_name.to_owned(),
        };
        if let Some(input) = self.field_json_inputs.get(&key) {
            return input.clone();
        }
        let initial_value = initial.to_owned();
        let input = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .placeholder("{}")
                .auto_grow(3, 10);
            state.set_value(initial_value, window, cx);
            state
        });
        let sk = session_key.to_owned();
        let ck = call_key.to_owned();
        let fnm = field_name.to_owned();
        let sub = cx.subscribe(&input, move |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) && !this.syncing_inputs {
                let val = input.read(cx).value().to_string();
                this.set_form_value(&sk, &ck, fnm.clone(), val, cx);
            }
        });
        self.field_subscriptions.insert(key.clone(), sub);
        self.field_json_inputs.insert(key, input.clone());
        input
    }

    fn render_result_view(
        &mut self,
        session_key: &str,
        call_key: &str,
        response: Option<&McpResponse>,
        running: bool,
        idle_text: &'static str,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let muted = to_hsla(tokens.muted_foreground);
        let Some(response) = response.cloned() else {
            if running {
                return h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .items_center()
                    .justify_center()
                    .gap(px(8.0))
                    .px(px(ROW_PAD_START_PX))
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(superhero_icon("superhero/spinner.svg", 16.0, muted))
                    .child("Running…")
                    .into_any_element();
            }
            return chrome::empty_state(&tokens, idle_text).into_any_element();
        };

        let view_key = (session_key.to_owned(), call_key.to_owned());
        let view_state = self
            .result_views
            .get(&view_key)
            .copied()
            .unwrap_or_default();
        let is_error = response.error.is_some()
            || response.result.get("isError").and_then(Value::as_bool) == Some(true);

        let trailing: AnyElement = if running {
            superhero_icon("superhero/spinner.svg", 16.0, muted).into_any_element()
        } else {
            let mut row = h_flex()
                .items_center()
                .gap(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted);
            if is_error {
                row = row.child(badge(&tokens, McpBadgeVariant::Error, "Error", false));
            }
            row.child(format_ms(response.duration_ms))
                .into_any_element()
        };

        let tabs = [
            SectionTab {
                id: "content",
                label: "Result",
                count: None,
            },
            SectionTab {
                id: "json",
                label: "JSON",
                count: None,
            },
        ];
        let active_tab_id = match view_state.tab {
            ResultTab::Content => "content",
            ResultTab::Json => "json",
        };
        let entity = cx.entity();
        let vk_tab = view_key.clone();
        let tab_bar = chrome::section_tabs(
            "mcp-result-tabs",
            &tokens,
            &tabs,
            active_tab_id,
            Some(trailing),
            {
                let entity = entity.clone();
                move |tab_id, _, cx| {
                    let vk = vk_tab.clone();
                    entity.update(cx, |panel, cx| {
                        let entry = panel.result_views.entry(vk).or_default();
                        entry.tab = if tab_id == "json" {
                            ResultTab::Json
                        } else {
                            ResultTab::Content
                        };
                        cx.notify();
                    });
                }
            },
        );

        let content_el: AnyElement = if let Some(err) = &response.error {
            chrome::warning_notice(&tokens, err.clone()).into_any_element()
        } else if view_state.tab == ResultTab::Json {
            let json_text = serde_json::to_string_pretty(&response.result)
                .unwrap_or_else(|_| response.result.to_string());
            div()
                .px(px(ROW_PAD_START_PX))
                .py(px(12.0))
                .child(code_block(&tokens, &json_text, true))
                .into_any_element()
        } else {
            self.render_result_content(&response.result, view_state.raw)
        };

        let mut body_wrap = div()
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("mcp-result-scroll-{call_key}")))
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    .child(content_el),
            );

        if response.error.is_none() {
            let show_raw_toggle =
                view_state.tab == ResultTab::Content && has_markdown(&response.result);
            let copy_text = if view_state.tab == ResultTab::Json {
                serde_json::to_string_pretty(&response.result)
                    .unwrap_or_else(|_| response.result.to_string())
            } else {
                raw_result_text(&response.result)
            };
            let is_copied = self
                .copied_result
                .as_ref()
                .is_some_and(|(k, _)| k == call_key);

            let mut actions = chrome::toolbar_group(&tokens);
            if show_raw_toggle {
                let vk = view_key;
                let entity_raw = entity.clone();
                let raw_label = if view_state.raw {
                    "Show formatted"
                } else {
                    "Show raw Markdown"
                };
                actions = actions.child(
                    chrome::icon_button(
                        SharedString::from(format!("mcp-result-raw-{call_key}")),
                        if view_state.raw {
                            "superhero/show.svg"
                        } else {
                            "superhero/code.svg"
                        },
                        &tokens,
                        false,
                        move |_, _, cx| {
                            let vk = vk.clone();
                            entity_raw.update(cx, |panel, cx| {
                                let entry = panel.result_views.entry(vk).or_default();
                                entry.raw = !entry.raw;
                                cx.notify();
                            });
                        },
                    )
                    .conn_tooltip(raw_label, &tokens),
                );
            }
            let copy_label = if is_copied {
                "Copied"
            } else if !show_raw_toggle && view_state.tab == ResultTab::Json {
                "Copy JSON"
            } else {
                "Copy raw text"
            };
            let ck_copy = call_key.to_owned();
            actions = actions.child(
                chrome::icon_button(
                    SharedString::from(format!("mcp-result-copy-{call_key}")),
                    if is_copied {
                        "superhero/check.svg"
                    } else {
                        "superhero/copy.svg"
                    },
                    &tokens,
                    false,
                    move |_, _, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(copy_text.clone()));
                        let ck = ck_copy.clone();
                        entity.update(cx, |panel, cx| panel.flash_copied(ck, cx));
                    },
                )
                .conn_tooltip(copy_label, &tokens),
            );
            body_wrap =
                body_wrap.child(div().absolute().top(px(8.0)).right(px(8.0)).child(actions));
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(tab_bar)
            .child(body_wrap)
            .into_any_element()
    }

    fn render_result_content(&mut self, result: &Value, raw: bool) -> AnyElement {
        let tokens = self.tokens.clone();
        let muted = to_hsla(tokens.muted_foreground);
        let content = result.get("content").and_then(Value::as_array);
        let contents = result.get("contents").and_then(Value::as_array);
        let messages = result.get("messages").and_then(Value::as_array);
        let structured = result.get("structuredContent");
        let blocks = content.or(contents);

        let mut col = v_flex()
            .w_full()
            .min_w_0()
            .gap(px(12.0))
            .px(px(ROW_PAD_START_PX))
            .py(px(12.0));

        if let Some(messages) = messages {
            for message in messages {
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
                    .to_owned();
                let block = message.get("content").unwrap_or(&Value::Null);
                col = col.child(
                    v_flex()
                        .w_full()
                        .min_w_0()
                        .gap(px(4.0))
                        .child(h_flex().child(badge(
                            &tokens,
                            McpBadgeVariant::Outline,
                            role,
                            false,
                        )))
                        .child(self.render_content_block(block, raw)),
                );
            }
        }

        if let Some(blocks) = blocks {
            for block in blocks {
                col = col.child(self.render_content_block(block, raw));
            }
        }

        if let Some(structured) = structured {
            let pretty =
                serde_json::to_string_pretty(structured).unwrap_or_else(|_| structured.to_string());
            col = col.child(
                v_flex()
                    .w_full()
                    .min_w_0()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(XS_TEXT_PX))
                            .line_height(px(XS_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Structured content"),
                    )
                    .child(code_block(&tokens, &pretty, true)),
            );
        }

        if blocks.is_none() && messages.is_none() && structured.is_none() {
            let pretty =
                serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string());
            col = col.child(code_block(&tokens, &pretty, true));
        }

        col.into_any_element()
    }

    fn render_content_block(&mut self, block: &Value, raw: bool) -> AnyElement {
        let tokens = self.tokens.clone();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);
        let mono: SharedString = MONO_FONT.into();

        let kind = block.get("type").and_then(Value::as_str);
        let mime_type = block.get("mimeType").and_then(Value::as_str);
        let data = block.get("data").and_then(Value::as_str);

        if kind == Some("image")
            && let (Some(data), Some(mime)) = (data, mime_type)
        {
            return self.render_image_block(data, mime);
        }

        if kind == Some("audio")
            && let (Some(data), Some(mime)) = (data, mime_type)
        {
            return div()
                .rounded(px(6.0))
                .border_1()
                .border_color(divider)
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(format!(
                    "Audio ({mime}, {}). Inline audio playback is not available in GPUI.",
                    format_bytes(base64_byte_len(data))
                ))
                .into_any_element();
        }

        if kind == Some("resource_link") {
            let uri = block
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            return h_flex()
                .font_family(mono)
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .child(div().text_color(muted).child("Link "))
                .child(div().min_w_0().text_color(fg).child(uri))
                .into_any_element();
        }

        let resource = if kind == Some("resource") {
            block.get("resource").unwrap_or(&Value::Null)
        } else {
            block
        };
        let text = block_text_or_resource(block, resource);
        let blob = resource.get("blob").and_then(Value::as_str);
        let uri = resource.get("uri").and_then(Value::as_str);
        let resource_mime = resource.get("mimeType").and_then(Value::as_str);

        let mut col = v_flex().w_full().min_w_0().gap(px(4.0));
        if let Some(uri) = uri
            && kind != Some("text")
        {
            let header = match resource_mime {
                Some(mime) => format!("{uri} · {mime}"),
                None => uri.to_owned(),
            };
            col = col.child(
                div()
                    .font_family(mono)
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(header),
            );
        }

        if let Some(text) = text {
            col = col.child(render_result_text(&tokens, text, raw));
        } else if let Some(blob) = blob {
            if let Some(mime) = resource_mime.filter(|m| m.starts_with("image/")) {
                col = col.child(self.render_image_block(blob, mime));
            } else {
                col = col.child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(format!(
                            "Binary contents ({}).",
                            format_bytes(base64_byte_len(blob))
                        )),
                );
            }
        } else {
            let pretty = serde_json::to_string_pretty(block).unwrap_or_else(|_| block.to_string());
            col = col.child(code_block(&tokens, &pretty, true));
        }
        col.into_any_element()
    }

    fn render_image_block(&mut self, base64_data: &str, mime: &str) -> AnyElement {
        let tokens = &self.tokens;
        let divider = to_hsla(tokens.shell_divider);
        let muted = to_hsla(tokens.muted_foreground);

        if let Some(rendered) = self.cached_image(base64_data) {
            return div()
                .max_w_full()
                .max_h(px(384.0))
                .overflow_hidden()
                .rounded(px(6.0))
                .border_1()
                .border_color(divider)
                .child(img(rendered).max_w_full().max_h(px(384.0)))
                .into_any_element();
        }
        div()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .child(format!(
                "Image ({mime}, {}).",
                format_bytes(base64_byte_len(base64_data))
            ))
            .into_any_element()
    }

    fn cached_image(&mut self, base64_data: &str) -> Option<Arc<RenderImage>> {
        let mut hasher = DefaultHasher::new();
        base64_data.hash(&mut hasher);
        let key = hasher.finish();
        if let Some(cached) = self.image_cache.get(&key) {
            return cached.clone();
        }
        let decoded = decode_base64(base64_data).and_then(|bytes| {
            let mut rgba = image::load_from_memory(&bytes).ok()?.to_rgba8();
            // GPUI `RenderImage` expects premultiplied BGRA pixel order inside `RgbaImage`.
            for pixel in rgba.as_chunks_mut::<4>().0 {
                pixel.swap(0, 2);
            }
            Some(Arc::new(RenderImage::new(vec![image::Frame::new(rgba)])))
        });
        if self.image_cache.len() >= 16 {
            self.image_cache.clear();
        }
        self.image_cache.insert(key, decoded.clone());
        decoded
    }
}

fn block_text_or_resource<'a>(block: &'a Value, resource: &'a Value) -> Option<&'a str> {
    block
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| resource.get("text").and_then(Value::as_str))
}

fn render_result_text(tokens: &Tokens, text: &str, raw: bool) -> AnyElement {
    if let Some(pretty) = pretty_json(text) {
        return code_block(tokens, &pretty, true);
    }
    if raw {
        return code_block(tokens, text, false);
    }
    render_markdown(tokens, text)
}

fn tool_title(tool: &McpTool) -> &str {
    tool.title
        .as_deref()
        .or_else(|| tool.annotations.as_ref().and_then(|a| a.title.as_deref()))
        .unwrap_or(&tool.name)
}

fn tool_badges(tokens: &Tokens, tool: &McpTool) -> Vec<AnyElement> {
    let Some(hints) = &tool.annotations else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if hints.read_only_hint == Some(true) {
        out.push(badge(tokens, McpBadgeVariant::Success, "read-only", false).into_any_element());
    }
    if hints.destructive_hint == Some(true) {
        out.push(badge(tokens, McpBadgeVariant::Error, "destructive", false).into_any_element());
    }
    if hints.idempotent_hint == Some(true) {
        out.push(badge(tokens, McpBadgeVariant::Info, "idempotent", false).into_any_element());
    }
    if hints.open_world_hint == Some(true) {
        out.push(badge(tokens, McpBadgeVariant::Outline, "open world", false).into_any_element());
    }
    out
}

fn render_fields_list(tokens: &Tokens, fields: &[McpField]) -> AnyElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let mono: SharedString = MONO_FONT.into();

    let mut card = v_flex()
        .w_full()
        .rounded(px(8.0))
        .border_1()
        .border_color(divider);

    for (idx, field) in fields.iter().enumerate() {
        let mut header = h_flex()
            .items_baseline()
            .gap(px(6.0))
            .child(
                div()
                    .font_family(mono.clone())
                    .text_size(px(UI_TEXT_PX))
                    .line_height(px(UI_LINE_HEIGHT_PX))
                    .text_color(fg)
                    .child(field.name.clone()),
            )
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(field_type_label(field.field_type)),
            );
        if field.required {
            header = header.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("required"),
            );
        }

        let mut row = v_flex()
            .w_full()
            .gap(px(2.0))
            .px(px(12.0))
            .py(px(8.0))
            .when(idx > 0, |el| el.border_t_1().border_color(divider))
            .child(header);
        if let Some(description) = &field.description {
            row = row.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(description.clone()),
            );
        }
        if !field.options.is_empty() {
            row = row.child(
                div()
                    .font_family(mono.clone())
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(field.options.join(" | ")),
            );
        }
        card = card.child(row);
    }

    v_flex()
        .w_full()
        .gap(px(8.0))
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Input"),
        )
        .child(card)
        .into_any_element()
}

/// Placeholder for a catalog search input (`"Tools"`, `"Resources"`, `"Prompts"`).
pub(super) fn filter_placeholder(noun: &str) -> String {
    capitalize(noun)
}
