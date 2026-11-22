//! The API surface (Conn `apps/web/src/api/ApiPanel.tsx`, `ApiRequestEditor.tsx`,
//! `ApiResponseView.tsx`): build a request, send it natively (`conn_desktop::api_request`),
//! read the response. Requests persist per project, as Conn's `t3code:api-requests:v1`.

use crate::a11y::ConnA11yExt as _;
use std::collections::HashMap;
use std::path::PathBuf;

use conn_desktop::api_request::ApiResponse;
use conn_desktop::api_request::response_view::{
    BadgeVariant, IDLE_TEXT, SENDING_TEXT, format_response_body, response_notices,
    response_summary, status_variant,
};
use conn_desktop::api_request::store::{
    API_METHODS, ApiHeaderRow, ApiRequestDraft, ApiRequestPatch, ApiRequestStore, BODY_PLACEHOLDER,
    URL_PLACEHOLDER,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Entity, Hsla, IntoElement, KeyDownEvent, ParentElement, Render,
    SharedString, Styled, Subscription, Window, div, px,
};

use super::chrome::{
    self, ConnTooltipExt as _, MenuEntry, MenuRow, SectionTab, UI_LINE_HEIGHT_PX, UI_TEXT_PX,
    XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::color::to_hsla;
use super::header::superhero_icon;
use crate::theme::MONO_FONT;

/// Which popup menu is open in the toolbar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpenMenu {
    Requests,
    Method,
}

/// The API panel entity.
pub(crate) struct ApiPanel {
    tokens: Tokens,
    project_key: Option<String>,
    store: ApiRequestStore,
    url_input: Entity<InputState>,
    body_input: Entity<TextareaState>,
    header_inputs: HashMap<String, (Entity<InputState>, Entity<InputState>)>,
    /// The request whose values the inputs hold; a different selection reloads them.
    synced_request: Option<String>,
    editor_tab: &'static str,
    response_tab: &'static str,
    menu: Option<OpenMenu>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ApiPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiPanel")
            .field("project_key", &self.project_key)
            .field("synced_request", &self.synced_request)
            .finish_non_exhaustive()
    }
}

fn store_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/conn-gpui/api-requests.json"))
}

fn load_store() -> ApiRequestStore {
    store_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| ApiRequestStore::from_persisted_json(&json).ok())
        .unwrap_or_default()
}

impl ApiPanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let url_input = cx.new(|cx| InputState::new(window, cx).placeholder(URL_PLACEHOLDER));
        let body_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(BODY_PLACEHOLDER)
                .auto_grow(6, 16)
        });
        let url_sub = cx.subscribe(&url_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let url = input.read(cx).value().to_string();
                this.patch(
                    ApiRequestPatch {
                        url: Some(url),
                        ..ApiRequestPatch::default()
                    },
                    cx,
                );
            }
        });
        let body_sub = cx.subscribe(&body_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let body = input.read(cx).value().to_string();
                this.patch(
                    ApiRequestPatch {
                        body: Some(body),
                        ..ApiRequestPatch::default()
                    },
                    cx,
                );
            }
        });
        Self {
            tokens,
            project_key: None,
            store: load_store(),
            url_input,
            body_input,
            header_inputs: HashMap::new(),
            synced_request: None,
            editor_tab: "headers",
            response_tab: "body",
            menu: None,
            _subscriptions: vec![url_sub, body_sub],
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// Shows the requests of `project_key` (Conn keys them by project), seeding a first one.
    pub(crate) fn set_project(&mut self, project_key: Option<String>, cx: &mut Context<'_, Self>) {
        if self.project_key == project_key {
            return;
        }
        self.project_key = project_key;
        if let Some(key) = &self.project_key {
            self.store.ensure_request(key, None);
        }
        self.synced_request = None;
        self.menu = None;
        cx.notify();
    }

    fn selected(&self) -> Option<&ApiRequestDraft> {
        self.store.selected(self.project_key.as_deref()?)
    }

    fn persist(&self) {
        let (Some(path), Ok(json)) = (store_path(), self.store.to_persisted_json()) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(error) = std::fs::write(&path, json) {
            eprintln!("api panel: could not save requests: {error}");
        }
    }

    fn patch(&mut self, patch: ApiRequestPatch, cx: &mut Context<'_, Self>) {
        let (Some(key), Some(id)) = (
            self.project_key.clone(),
            self.selected().map(|r| r.id.clone()),
        ) else {
            return;
        };
        self.store.change(&key, &id, patch);
        self.persist();
        cx.notify();
    }

    fn set_headers(&mut self, headers: Vec<ApiHeaderRow>, cx: &mut Context<'_, Self>) {
        self.patch(
            ApiRequestPatch {
                headers: Some(headers),
                ..ApiRequestPatch::default()
            },
            cx,
        );
    }

    /// Loads the selected request into the inputs when the selection changed.
    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(request) = self.selected().cloned() else {
            return;
        };
        if self.synced_request.as_deref() == Some(request.id.as_str()) {
            return;
        }
        self.synced_request = Some(request.id.clone());
        self.url_input
            .update(cx, |s, cx| s.set_value(request.url.clone(), window, cx));
        self.body_input
            .update(cx, |s, cx| s.set_value(request.body.clone(), window, cx));
        self.header_inputs.clear();
    }

    /// The name/value inputs of a header row, created on first render.
    fn header_row_inputs(
        &mut self,
        row: &ApiHeaderRow,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> (Entity<InputState>, Entity<InputState>) {
        if let Some(inputs) = self.header_inputs.get(&row.id) {
            return inputs.clone();
        }
        let name = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Header");
            state.set_value(row.name.clone(), window, cx);
            state
        });
        let value = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("Value");
            state.set_value(row.value.clone(), window, cx);
            state
        });
        for (input, is_name) in [(&name, true), (&value, false)] {
            let row_id = row.id.clone();
            let sub = cx.subscribe(input, move |this, input, event: &InputEvent, cx| {
                if !matches!(event, InputEvent::Change) {
                    return;
                }
                let text = input.read(cx).value().to_string();
                let Some(request) = this.selected() else {
                    return;
                };
                let headers = request
                    .headers
                    .iter()
                    .map(|h| {
                        if h.id != row_id {
                            return h.clone();
                        }
                        let mut h = h.clone();
                        if is_name {
                            h.name = text.clone();
                        } else {
                            h.value = text.clone();
                        }
                        h
                    })
                    .collect();
                this.set_headers(headers, cx);
            });
            self._subscriptions.push(sub);
        }
        self.header_inputs
            .insert(row.id.clone(), (name.clone(), value.clone()));
        (name, value)
    }

    fn send(&mut self, cx: &mut Context<'_, Self>) {
        let Some(key) = self.project_key.clone() else {
            return;
        };
        let Some((id, request)) = self.store.begin_send(&key) else {
            return;
        };
        cx.notify();
        let url = request.url.clone();
        let task =
            crate::live::RT.spawn(async move { conn_desktop::api_request::send(&request).await });
        cx.spawn(async move |this, cx| {
            let response = match task.await {
                Ok(response) => response,
                Err(error) => ApiResponse::failure(url, error.to_string(), 0.0),
            };
            let _ = this.update(cx, |panel, cx| {
                panel.store.finish_send(&id, response);
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_menu(&mut self, menu: OpenMenu, cx: &mut Context<'_, Self>) {
        self.menu = if self.menu == Some(menu) {
            None
        } else {
            Some(menu)
        };
        cx.notify();
    }

    fn render_toolbar(&self, request: &ApiRequestDraft, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let mono: SharedString = MONO_FONT.into();
        let sending = self.store.result(&request.id).is_some_and(|r| r.sending);

        // Saved requests menu (`RequestsMenu`).
        let entity = cx.entity();
        let mut requests_anchor = div().relative().child(
            chrome::toolbar_group(tokens).child(
                chrome::icon_button("api-requests-btn", "superhero/list.svg", tokens, false, {
                    let entity = entity.clone();
                    move |_, _, cx| entity.update(cx, |p, cx| p.toggle_menu(OpenMenu::Requests, cx))
                })
                .conn_tooltip("Requests", tokens),
            ),
        );
        if self.menu == Some(OpenMenu::Requests) {
            requests_anchor = requests_anchor.child(self.requests_menu(request, cx));
        }

        // Method menu inside the soft URL field.
        let method_trigger = h_flex()
            .id("api-method-btn")
            .a11y_button("panel.api-method-btn", "HTTP method")
            .relative()
            .h(px(24.0))
            .px(px(7.0))
            .gap(px(4.0))
            .items_center()
            .rounded(px(9999.0))
            .cursor_pointer()
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(to_hsla(tokens.foreground))
            .hover({
                let hover = to_hsla(tokens.shell_highlight);
                move |s| s.bg(hover)
            })
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| entity.update(cx, |p, cx| p.toggle_menu(OpenMenu::Method, cx))
            })
            .child(div().font_family(mono).child(request.method.clone()))
            .child(superhero_icon(
                "superhero/chevron-down.svg",
                chrome::ICON_BUTTON_GLYPH_PX,
                to_hsla(tokens.muted_foreground),
            ));
        let mut method_anchor = div().relative().pl(px(9.0)).child(method_trigger);
        if self.menu == Some(OpenMenu::Method) {
            method_anchor = method_anchor.child(self.method_menu(request, cx));
        }

        let url_field = chrome::soft_input_group(tokens).child(method_anchor).child(
            div().flex_1().min_w_0().pl(px(11.0)).pr(px(14.0)).child(
                Input::new(&self.url_input)
                    .appearance(false)
                    .text_size(px(UI_TEXT_PX)),
            ),
        );

        let send_icon = if sending {
            "superhero/spinner.svg"
        } else {
            "superhero/send.svg"
        };
        let send_group = chrome::toolbar_group(tokens).child(
            chrome::icon_button(
                "api-send-btn",
                send_icon,
                tokens,
                sending || !request.can_send(),
                move |_, _, cx| entity.update(cx, |p, cx| p.send(cx)),
            )
            .conn_tooltip("Send (⌘↵)", tokens),
        );

        chrome::toolbar_row(tokens)
            .child(requests_anchor)
            .child(url_field)
            .child(send_group)
            .into_any_element()
    }

    fn requests_menu(&self, selected: &ApiRequestDraft, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let Some(project) = self
            .project_key
            .as_deref()
            .and_then(|k| self.store.project(k))
        else {
            return div().into_any_element();
        };
        let mut entries: Vec<MenuEntry> = project
            .requests
            .iter()
            .map(|request| {
                let id = request.id.clone();
                let entity = entity.clone();
                MenuEntry::Row(MenuRow {
                    id: SharedString::from(format!("api-request-{id}")),
                    label: request.label().into(),
                    mono: false,
                    checked: request.id == selected.id,
                    on_select: Box::new(move |_, cx| {
                        entity.update(cx, |p, cx| {
                            if let Some(key) = p.project_key.clone() {
                                p.store.select(&key, &id);
                                p.persist();
                            }
                            p.menu = None;
                            cx.notify();
                        });
                    }),
                })
            })
            .collect();
        entries.push(MenuEntry::Separator);
        let action = |label: &'static str, f: fn(&mut ApiPanel)| {
            let entity = entity.clone();
            MenuEntry::Row(MenuRow {
                id: SharedString::from(format!("api-requests-{label}")),
                label: label.into(),
                mono: false,
                checked: false,
                on_select: Box::new(move |_, cx| {
                    entity.update(cx, |p, cx| {
                        f(p);
                        p.persist();
                        p.menu = None;
                        cx.notify();
                    });
                }),
            })
        };
        entries.push(action("New request", |p| {
            if let Some(key) = p.project_key.clone() {
                p.store.add(&key, ApiRequestDraft::new(None));
            }
        }));
        entries.push(action("Duplicate", |p| {
            if let (Some(key), Some(copy)) = (
                p.project_key.clone(),
                p.selected().map(ApiRequestDraft::duplicate),
            ) {
                p.store.add(&key, copy);
            }
        }));
        entries.push(action("Delete", |p| {
            if let (Some(key), Some(id)) =
                (p.project_key.clone(), p.selected().map(|r| r.id.clone()))
            {
                p.store.remove(&key, &id);
                p.store.ensure_request(&key, None);
            }
        }));
        chrome::dropdown_menu(
            "api-requests-menu",
            &self.tokens,
            entries,
            MONO_FONT.into(),
            chrome::CONTROL_HEIGHT_PX,
        )
    }

    fn method_menu(&self, selected: &ApiRequestDraft, cx: &mut Context<'_, Self>) -> AnyElement {
        let entity = cx.entity();
        let entries = API_METHODS
            .iter()
            .map(|method| {
                let entity = entity.clone();
                let method = (*method).to_owned();
                MenuEntry::Row(MenuRow {
                    id: SharedString::from(format!("api-method-{method}")),
                    label: method.clone().into(),
                    mono: true,
                    checked: method == selected.method,
                    on_select: Box::new(move |_, cx| {
                        let method = method.clone();
                        entity.update(cx, |p, cx| {
                            p.menu = None;
                            p.patch(
                                ApiRequestPatch {
                                    method: Some(method),
                                    ..ApiRequestPatch::default()
                                },
                                cx,
                            );
                        });
                    }),
                })
            })
            .collect();
        chrome::dropdown_menu(
            "api-method-menu",
            &self.tokens,
            entries,
            MONO_FONT.into(),
            24.0,
        )
    }

    fn render_editor(
        &mut self,
        request: &ApiRequestDraft,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let entity = cx.entity();
        let tabs = [
            SectionTab {
                id: "headers",
                label: "Headers",
                count: Some(request.enabled_header_count()),
            },
            SectionTab {
                id: "body",
                label: "Body",
                count: None,
            },
        ];
        let tab_row =
            chrome::section_tabs("api-editor-tabs", &tokens, &tabs, self.editor_tab, None, {
                let entity = entity.clone();
                move |tab, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.editor_tab = tab;
                        cx.notify();
                    });
                }
            });

        let mono: SharedString = MONO_FONT.into();
        let body: AnyElement = if self.editor_tab == "headers" {
            let divider = to_hsla(tokens.shell_divider);
            let row_hover = chrome::alpha(tokens.foreground, 0.04);
            let mut rows = v_flex();
            for row in request.headers.clone() {
                let (name, value) = self.header_row_inputs(&row, window, cx);
                let group = SharedString::from(format!("api-header-{}", row.id));
                let toggle_id = row.id.clone();
                let remove_id = row.id.clone();
                let entity_toggle = entity.clone();
                let entity_remove = entity.clone();
                let field = |input: &Entity<InputState>, dim: bool| {
                    // `py-2 text-xs`: a 16px line in a 32px row.
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
                rows = rows.child(
                    h_flex()
                        .id(SharedString::from(format!("api-header-row-{}", row.id)))
                        .group(group.clone())
                        .w_full()
                        .items_center()
                        .gap(px(12.0))
                        .pl(px(chrome::ROW_PAD_START_PX))
                        .pr(px(chrome::TOOLBAR_PAD_END_PX))
                        .border_b_1()
                        .border_color(divider)
                        .hover(move |s| s.bg(row_hover))
                        .child(chrome::checkbox(
                            SharedString::from(format!("api-header-check-{}", row.id)),
                            row.enabled,
                            &tokens,
                            move |_, _, cx| {
                                let id = toggle_id.clone();
                                entity_toggle.update(cx, |p, cx| {
                                    if let Some(r) = p.selected() {
                                        let headers = r
                                            .headers
                                            .iter()
                                            .map(|h| {
                                                let mut h = h.clone();
                                                if h.id == id {
                                                    h.enabled = !h.enabled;
                                                }
                                                h
                                            })
                                            .collect();
                                        p.set_headers(headers, cx);
                                    }
                                });
                            },
                        ))
                        .child(field(&name, !row.enabled))
                        .child(field(&value, false))
                        .child(
                            div().invisible().group_hover(group, |s| s.visible()).child(
                                chrome::icon_button(
                                    SharedString::from(format!("api-header-remove-{}", row.id)),
                                    "superhero/close.svg",
                                    &tokens,
                                    false,
                                    move |_, _, cx| {
                                        let id = remove_id.clone();
                                        entity_remove.update(cx, |p, cx| {
                                            if let Some(r) = p.selected() {
                                                let headers = r
                                                    .headers
                                                    .iter()
                                                    .filter(|h| h.id != id)
                                                    .cloned()
                                                    .collect();
                                                p.header_inputs.remove(&id);
                                                p.set_headers(headers, cx);
                                            }
                                        });
                                    },
                                )
                                .conn_tooltip("Remove header", &tokens),
                            ),
                        ),
                );
            }
            let entity_add = entity;
            rows = rows.child(div().pl(px(10.0)).pt(px(6.0)).child(chrome::text_button(
                "api-add-header",
                Some("superhero/add.svg"),
                "Add header",
                &tokens,
                move |_, _, cx| {
                    entity_add.update(cx, |p, cx| {
                        if let Some(r) = p.selected() {
                            let mut headers = r.headers.clone();
                            headers.push(ApiHeaderRow::empty());
                            p.set_headers(headers, cx);
                        }
                    });
                },
            )));
            rows.into_any_element()
        } else if request.is_bodyless() {
            div()
                .px(px(chrome::ROW_PAD_START_PX))
                .py(px(12.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(request.bodyless_notice())
                .into_any_element()
        } else {
            div()
                .px(px(chrome::ROW_PAD_START_PX))
                .py(px(12.0))
                .min_h(px(128.0))
                .font_family(mono)
                .child(
                    Textarea::new(&self.body_input)
                        .appearance(false)
                        .text_size(px(XS_TEXT_PX)),
                )
                .into_any_element()
        };

        v_flex()
            .w_full()
            .flex_shrink_0()
            .max_h(gpui_kit::relative(0.45))
            .border_b_1()
            .border_color(to_hsla(tokens.shell_divider))
            .child(tab_row)
            .child(
                div()
                    .id("api-editor-scroll")
                    .min_h_0()
                    .overflow_y_scroll()
                    .pb(px(8.0))
                    .child(body),
            )
            .into_any_element()
    }

    fn render_response(&self, request: &ApiRequestDraft, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let result = self.store.result(&request.id);
        let sending = result.is_some_and(|r| r.sending);
        let Some(response) = result.and_then(|r| r.response.as_ref()) else {
            return chrome::empty_state(tokens, if sending { SENDING_TEXT } else { IDLE_TEXT })
                .into_any_element();
        };
        let entity = cx.entity();
        let muted = to_hsla(tokens.muted_foreground);
        let trailing: Option<AnyElement> = if sending {
            Some(superhero_icon("superhero/spinner.svg", 16.0, muted).into_any_element())
        } else {
            response_summary(response).map(|summary| {
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(UI_TEXT_PX))
                    .text_color(muted)
                    .child(status_badge(tokens, summary.status))
                    .child(summary.duration)
                    .child(summary.size)
                    .into_any_element()
            })
        };
        let tabs = [
            SectionTab {
                id: "body",
                label: "Response",
                count: None,
            },
            SectionTab {
                id: "headers",
                label: "Headers",
                count: Some(response.headers.len()),
            },
        ];
        let tab_row = chrome::section_tabs(
            "api-response-tabs",
            tokens,
            &tabs,
            self.response_tab,
            trailing,
            move |tab, _, cx| {
                entity.update(cx, |p, cx| {
                    p.response_tab = tab;
                    cx.notify();
                });
            },
        );
        let mono: SharedString = MONO_FONT.into();
        let mut column = v_flex().flex_1().min_h_0().w_full().child(tab_row);
        for notice in response_notices(response) {
            column = column.child(chrome::warning_notice(tokens, notice));
        }
        let content: AnyElement = if self.response_tab == "body" {
            div()
                .px(px(chrome::ROW_PAD_START_PX))
                .py(px(12.0))
                .font_family(mono)
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.foreground))
                .child(format_response_body(response))
                .into_any_element()
        } else {
            let divider = to_hsla(tokens.shell_divider);
            let fg = to_hsla(tokens.foreground);
            let mut rows = v_flex().pb(px(8.0));
            for header in &response.headers {
                rows = rows.child(
                    h_flex()
                        .w_full()
                        .gap(px(12.0))
                        .px(px(chrome::ROW_PAD_START_PX))
                        .py(px(8.0))
                        .border_b_1()
                        .border_color(divider)
                        .font_family(mono.clone())
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .child(
                            div()
                                .w(gpui_kit::relative(0.4))
                                .flex_shrink_0()
                                .text_color(muted)
                                .child(header.name.clone()),
                        )
                        .child(div().min_w_0().text_color(fg).child(header.value.clone())),
                );
            }
            rows.into_any_element()
        };
        column
            .child(
                div()
                    .id("api-response-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(content),
            )
            .into_any_element()
    }
}

/// `StatusBadge`: the status code in a small badge colored by class.
fn status_badge(tokens: &Tokens, status: u16) -> impl IntoElement {
    let (fg, bg): (Hsla, Hsla) = match status_variant(status) {
        BadgeVariant::Success => (to_hsla(tokens.success), chrome::alpha(tokens.success, 0.12)),
        BadgeVariant::Warning => (to_hsla(tokens.warning), chrome::alpha(tokens.warning, 0.12)),
        BadgeVariant::Error => (
            to_hsla(tokens.destructive),
            chrome::alpha(tokens.destructive, 0.12),
        ),
        BadgeVariant::Info => (
            to_hsla(tokens.muted_foreground),
            chrome::alpha(tokens.foreground, 0.06),
        ),
    };
    div()
        .px(px(6.0))
        .rounded(px(4.0))
        .bg(bg)
        .text_color(fg)
        .text_size(px(XS_TEXT_PX))
        .line_height(px(XS_LINE_HEIGHT_PX))
        .font_weight(gpui_kit::FontWeight::MEDIUM)
        .child(status.to_string())
}

impl Render for ApiPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_inputs(window, cx);
        let Some(request) = self.selected().cloned() else {
            return chrome::empty_state(
                &self.tokens,
                "API requests are only available from a project thread.",
            )
            .into_any_element();
        };
        let toolbar = self.render_toolbar(&request, cx);
        let editor = self.render_editor(&request, window, cx);
        let response = self.render_response(&request, cx);
        v_flex()
            .id("api-panel")
            .size_full()
            .on_key_down(cx.listener(|p, event: &KeyDownEvent, _, cx| {
                let k = &event.keystroke;
                if k.key == "enter" && (k.modifiers.platform || k.modifiers.control) {
                    p.send(cx);
                    cx.stop_propagation();
                }
            }))
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(|p, _, _, cx| {
                    if p.menu.take().is_some() {
                        cx.notify();
                    }
                }),
            )
            .child(toolbar)
            .child(editor)
            .child(response)
            .into_any_element()
    }
}
