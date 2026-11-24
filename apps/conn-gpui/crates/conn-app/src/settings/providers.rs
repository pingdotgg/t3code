//! Settings → Providers: the provider instances, their editor, and Antigravity's credential
//! check behind `Open provider setup` (`ProviderSettingsPanel.tsx`, `ProviderInstanceCard.tsx`,
//! `ProviderSetupSection.tsx`, `ProviderAuthenticationSection.tsx`).
//!
//! One row per provider instance: its status line, an enable switch, `Edit`, `Refresh` and
//! `Delete` or `Reset`. `Add provider` creates an instance. The edited instance opens its
//! identity, Setup, Runtime and Environment sections; `editor.rs` holds the settings writes.
//! Providers sign in through the Orbit AI router (`docs/scope.md` §2 #3, #4), so the only
//! sign-in here is Antigravity's check of the API key its settings hold
//! (`provider.auth.subscribe`, `provider.auth.start`, `provider.auth.cancel`).
//!
//! Settings are flat (`docs/scope.md` §2 #13): each switch is the environment's, with no
//! per-project override.

mod editor;
mod models;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;

use conn_client::{Connection, StreamId};
use conn_state::provider_auth::{AuthFlow, AuthPanel, StatusKey, offers_credential_check};
use conn_state::providers::{ProviderGroup, ServerConfigState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, ClickEvent, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, StatefulInteractiveElement as _, Styled as _, Task, TestSupportExt as _,
    Window, div, px,
};
use serde::Serialize;
use serde_json::{Value, json};

use super::controls::{settings_row, settings_section};
use crate::a11y::ConnA11yExt as _;
use crate::theme::{hsla, hsla_alpha};

/// What [`ProvidersView::new`] starts from.
pub(crate) struct ProvidersInit {
    pub(crate) tokens: Tokens,
    pub(crate) geometry: ShellGeometry,
    pub(crate) connection: Option<Connection>,
    pub(crate) environment_label: String,
}

/// Antigravity's credential check: its latest state, a call in flight or its failure.
#[derive(Default)]
struct Account {
    flow: Option<AuthFlow>,
    /// The subscription ended before any state arrived: this server has no check for it.
    load_failed: bool,
    error: Option<String>,
    pending: bool,
}

/// The Providers settings page.
pub(crate) struct ProvidersView {
    tokens: Tokens,
    geometry: ShellGeometry,
    connection: Option<Connection>,
    environment_label: String,
    config: Arc<ServerConfigState>,
    /// The instance whose editor is open.
    selected: Option<String>,
    account: Account,
    auth_stream: Option<StreamId>,
    _auth_task: Option<Task<()>>,
    refreshing: HashSet<String>,
    refreshing_all: bool,
    /// The inputs of the instance being edited.
    editor: Option<editor::Editor>,
    /// The Add provider form, while open.
    adding: Option<editor::AddForm>,
    write: editor::WriteState,
    /// The instance whose removal or reset waits for a second click.
    confirm_remove: Option<String>,
    /// The custom model whose editor is open.
    custom_edit: Option<models::CustomEdit>,
}

impl ProvidersView {
    pub(crate) fn new(init: ProvidersInit) -> Self {
        Self {
            tokens: init.tokens,
            geometry: init.geometry,
            connection: init.connection,
            environment_label: init.environment_label,
            config: Arc::default(),
            selected: None,
            account: Account::default(),
            auth_stream: None,
            _auth_task: None,
            refreshing: HashSet::new(),
            refreshing_all: false,
            editor: None,
            adding: None,
            write: editor::WriteState::default(),
            confirm_remove: None,
            custom_edit: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// A new connection: the credential check follows the new server.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        environment_label: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.environment_label = environment_label;
        self.account = Account::default();
        self.subscribe_auth(cx);
        cx.notify();
    }

    /// The live provider catalog.
    pub(crate) fn set_server_config(
        &mut self,
        config: Arc<ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.config = config;
        // An editor opened before the catalog arrived starts its credential check now.
        if self.auth_stream.is_none() && self.account.flow.is_none() {
            self.subscribe_auth(cx);
        }
        cx.notify();
    }

    /// `Open provider setup`: open the editor of `instance_id` (Antigravity's credential check,
    /// or another provider's runtime fields).
    pub(crate) fn focus_provider(&mut self, instance_id: String, cx: &mut Context<'_, Self>) {
        self.select(Some(instance_id), cx);
    }

    fn select(&mut self, instance_id: Option<String>, cx: &mut Context<'_, Self>) {
        if self.selected == instance_id {
            return;
        }
        self.selected = instance_id;
        self.account = Account::default();
        self.subscribe_auth(cx);
        cx.notify();
    }

    fn stop_auth(&mut self) {
        self._auth_task = None;
        if let (Some(stream), Some(connection)) = (self.auth_stream.take(), &self.connection) {
            connection.cancel_stream(stream);
        }
    }

    /// Follows `provider.auth.subscribe` for the selected instance when it offers the
    /// credential check (`providerAuthState`).
    fn subscribe_auth(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_auth();
        let (Some(connection), Some(instance_id)) =
            (self.connection.clone(), self.selected.clone())
        else {
            return;
        };
        let checks = self
            .config
            .catalog()
            .all_groups()
            .iter()
            .any(|g| g.instance_id == instance_id && offers_credential_check(g));
        if !checks {
            return;
        }
        let (stream, mut rx) = connection.stream_json(
            "provider.auth.subscribe",
            json!({ "instanceId": instance_id }),
        );
        self.auth_stream = Some(stream);
        self._auth_task = Some(cx.spawn(async move |this, cx| {
            while let Some(value) = rx.recv().await {
                let Ok(state) = serde_json::from_value::<conn_contract::ProviderAuthState>(value)
                else {
                    continue;
                };
                let flow = AuthFlow::from_state(&state);
                let alive = this.update(cx, |view, cx| {
                    if view.selected.as_deref() == Some(flow.instance_id.as_str()) {
                        view.account.flow = Some(flow);
                        view.account.load_failed = false;
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    return;
                }
            }
            // The stream ended: with no state yet, this server offers no check for it.
            let _ = this.update(cx, |view, cx| {
                if view.account.flow.is_none() {
                    view.account.load_failed = true;
                    cx.notify();
                }
            });
        }));
    }

    /// Runs one `provider.auth.*` call and applies the state it answers.
    fn run_auth_call<P: Serialize + 'static>(
        &mut self,
        tag: &'static str,
        payload: P,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        if self.account.pending {
            return;
        }
        self.account.pending = true;
        self.account.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = connection.call::<P, Value>(tag, &payload).await;
            let _ = this.update(cx, |view, cx| {
                view.account.pending = false;
                match result {
                    Ok(value) => {
                        if let Ok(state) =
                            serde_json::from_value::<conn_contract::ProviderAuthState>(value)
                        {
                            view.account.flow = Some(AuthFlow::from_state(&state));
                        }
                    }
                    Err(err) => {
                        view.account.error = Some(conn_client::commands::format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// `Connect`: checks the credentials the instance's settings hold.
    fn start_check(&mut self, cx: &mut Context<'_, Self>) {
        let Some(instance_id) = self.selected.clone() else {
            return;
        };
        let payload = conn_contract::ProviderAuthStartInput {
            instance_id,
            method_id: None,
            return_url: None,
            callback_mode: None,
        };
        self.run_auth_call("provider.auth.start", payload, cx);
    }

    fn cancel_check(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(instance_id), Some(flow_id)) = (
            self.selected.clone(),
            self.account.flow.as_ref().and_then(|f| f.flow_id.clone()),
        ) else {
            return;
        };
        let payload = conn_contract::ProviderAuthCancelInput {
            instance_id,
            flow_id,
        };
        self.run_auth_call("provider.auth.cancel", payload, cx);
    }

    /// `Refresh` for one provider, or all of them from the section header.
    fn refresh(&mut self, instance_id: Option<String>, cx: &mut Context<'_, Self>) {
        use conn_client::commands::{ProviderRefresh, refresh_providers_payload};
        let Some(connection) = self.connection.clone() else {
            return;
        };
        let (refresh, key) = match &instance_id {
            Some(id) => (ProviderRefresh::Instance(id), Some(id.clone())),
            None => (ProviderRefresh::All, None),
        };
        match &key {
            Some(id) => {
                if !self.refreshing.insert(id.clone()) {
                    return;
                }
            }
            None => {
                if self.refreshing_all {
                    return;
                }
                self.refreshing_all = true;
            }
        }
        let payload = refresh_providers_payload(refresh);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let _ = connection
                .call::<_, Value>("server.refreshProviders", &payload)
                .await;
            let _ = this.update(cx, |view, cx| {
                match &key {
                    Some(id) => {
                        view.refreshing.remove(id);
                    }
                    None => view.refreshing_all = false,
                }
                cx.notify();
            });
        })
        .detach();
    }

    // --- rendering ----------------------------------------------------------------------

    fn dot_color(&self, key: StatusKey) -> gpui_kit::Hsla {
        match key {
            StatusKey::Disabled => hsla_alpha(self.tokens.muted_foreground, 0.5),
            StatusKey::Neutral => hsla(self.tokens.muted_foreground),
            StatusKey::Error => hsla(self.tokens.destructive),
            StatusKey::Ready => hsla(self.tokens.success),
            StatusKey::Warning => hsla(self.tokens.warning),
        }
    }

    /// A small outlined (or primary) button. `on_click` is `None` while it is disabled.
    fn button(
        &self,
        ax_id: String,
        label: &str,
        primary: bool,
        on_click: Option<impl Fn(&ClickEvent, &mut Window, &mut App) + 'static>,
    ) -> AnyElement {
        styled_button(&self.tokens, ax_id, label, label, primary, on_click)
    }

    /// [`Self::button`] whose accessible name says more than its visible label.
    fn labelled_button(
        &self,
        ax_id: String,
        label: &str,
        ax_label: &str,
        primary: bool,
        on_click: Option<impl Fn(&ClickEvent, &mut Window, &mut App) + 'static>,
    ) -> AnyElement {
        styled_button(&self.tokens, ax_id, label, ax_label, primary, on_click)
    }

    fn muted_line(&self, text: impl Into<SharedString>) -> gpui_kit::Div {
        div()
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(hsla(self.tokens.muted_foreground_raised))
            .child(text.into())
    }

    /// Antigravity's credential-check row (`ProviderAuthenticationSection`): `Connect`, its
    /// progress, `Cancel`, and a failure.
    fn account_rows(&self, group: &ProviderGroup, cx: &mut Context<'_, Self>) -> Vec<AnyElement> {
        let tokens = self.tokens.clone();
        let id = group.instance_id.clone();
        let ax = |suffix: &str| format!("settings.providers.{id}.account.{suffix}");
        if self.account.load_failed {
            return vec![settings_row(
                "Setup unavailable",
                Some("This server offers no credential check for this provider."),
                div().into_any_element(),
                &tokens,
                &self.geometry,
            )];
        }
        let panel = AuthPanel::derive(
            group,
            self.account.flow.as_ref(),
            self.account.load_failed,
            &self.environment_label,
        );
        let disabled = self.account.pending;
        let control = if panel.offers_cancel {
            self.button(
                ax("cancel"),
                "Cancel",
                false,
                (!disabled).then(|| cx.listener(|view, _, _, cx| view.cancel_check(cx))),
            )
        } else if let Some(label) = panel.connect_label {
            self.button(
                ax("connect"),
                label,
                false,
                (!disabled && panel.connect_enabled)
                    .then(|| cx.listener(|view, _, _, cx| view.start_check(cx))),
            )
        } else {
            div().into_any_element()
        };
        let mut rows = vec![settings_row(
            "Account",
            Some(&panel.description),
            control,
            &tokens,
            &self.geometry,
        )];
        if let Some(message) = &panel.status_message {
            rows.push(self.note_row(message.clone(), false, &ax("status")));
        }
        if let Some(error) = self.account.error.clone() {
            rows.push(self.note_row(error, true, &ax("error")));
        }
        rows
    }

    fn note_row(&self, text: String, error: bool, ax_id: &str) -> AnyElement {
        div()
            .id(SharedString::from(ax_id.to_owned()))
            .a11y_group(ax_id.to_owned(), text.clone())
            .px(px(14.0))
            .py(px(10.0))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(if error {
                hsla(self.tokens.destructive)
            } else {
                hsla(self.tokens.muted_foreground_raised)
            })
            .child(text)
            .test_support()
            .into_any_element()
    }
}

pub(crate) fn styled_button(
    tokens: &Tokens,
    ax_id: String,
    label: &str,
    ax_label: &str,
    primary: bool,
    on_click: Option<impl Fn(&ClickEvent, &mut Window, &mut App) + 'static>,
) -> AnyElement {
    let fg = if primary {
        hsla(tokens.primary_foreground)
    } else {
        hsla(tokens.foreground)
    };
    let hover = hsla(tokens.shell_highlight);
    let base = div()
        .id(SharedString::from(ax_id.clone()))
        .a11y_button(ax_id, ax_label.to_owned())
        .flex()
        .items_center()
        .h(px(28.0))
        .px(px(10.0))
        .rounded(px(6.0))
        .text_size(px(12.0))
        .text_color(fg)
        .when(primary, |el| el.bg(hsla(tokens.primary)))
        .when(!primary, |el| {
            el.border_1().border_color(hsla_alpha(tokens.border, 0.8))
        });
    match on_click {
        Some(on_click) => base
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .on_click(on_click)
            .child(label.to_owned())
            .test_support()
            .into_any_element(),
        None => base
            .opacity(0.5)
            .child(label.to_owned())
            .test_support()
            .into_any_element(),
    }
}

impl Render for ProvidersView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let config = Arc::clone(&self.config);
        let groups = config.catalog().all_groups();
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        self.ensure_editor(window, cx);

        let mut page = div()
            .id("settings-providers-page")
            .flex()
            .flex_col()
            .gap(px(20.0))
            .w_full();

        let refreshing_all = self.refreshing_all;
        let header = settings_row(
            "Providers",
            Some("Check every provider again, including its models, or add another."),
            div()
                .flex()
                .flex_row()
                .gap(px(8.0))
                .child(
                    self.button(
                        "settings.providers.add".to_owned(),
                        "Add provider",
                        false,
                        (self.adding.is_none() && config.settings().is_some()).then(|| {
                            cx.listener(|view, _, window, cx| view.open_add_form(window, cx))
                        }),
                    ),
                )
                .child(self.button(
                    "settings.providers.refresh-all".to_owned(),
                    if refreshing_all {
                        "Refreshing..."
                    } else {
                        "Refresh all"
                    },
                    false,
                    (!refreshing_all).then(|| cx.listener(|view, _, _, cx| view.refresh(None, cx))),
                ))
                .into_any_element(),
            &tokens,
            &geometry,
        );
        let mut rows = vec![header];
        match config.settings() {
            None => {
                rows.push(self.note_row(
                    "Waiting for the server to report its providers.".to_owned(),
                    false,
                    "settings.providers.empty",
                ));
            }
            Some(settings) => {
                let show_cursor = config.provider("cursor").is_some();
                let instance_rows = conn_state::provider_settings::instance_rows(
                    settings,
                    show_cursor,
                    self.selected.as_deref(),
                );
                if instance_rows.is_empty() {
                    rows.push(self.note_row(
                        "This server lists no providers.".to_owned(),
                        false,
                        "settings.providers.empty",
                    ));
                }
                for row in &instance_rows {
                    let group = groups.iter().find(|g| g.instance_id == row.instance_id);
                    rows.push(self.instance_row(row, group.copied(), cx));
                }
            }
        }
        if let Some(error) = self.write_error_row() {
            rows.push(error);
        }
        if let Some(add) = self.add_form_section(cx) {
            page = page.child(add);
        }
        page = page.child(settings_section("Providers", rows, &tokens, &geometry));

        if let Some(selected) = self.selected.clone() {
            let group = groups.iter().find(|g| g.instance_id == selected).copied();
            for section in self.editor_sections(group, cx) {
                page = page.child(section);
            }
        }
        page
    }
}
