//! Settings → Providers: the provider instances, their editor, and the sign-in flow behind
//! `Open provider setup` (`ProviderSettingsPanel.tsx`, `ProviderInstanceCard.tsx`,
//! `ProviderSetupSection.tsx`, `ProviderAuthenticationSection.tsx`).
//!
//! One row per provider instance: its status line, an enable switch, `Edit`, `Refresh` and
//! `Delete` or `Reset`. `Add provider` creates an instance. The edited instance opens its
//! identity, Setup (the Account row, driven by `provider.auth.subscribe` and the
//! `provider.auth.*` calls), Runtime and Environment sections; `editor.rs` holds the settings
//! writes.
//!
//! A project scope (`?project=` in Conn, picked on Settings → Projects) turns each switch into
//! that project's own override (`projectSettingsOverrides`), shown next to the device setting.
//!
//! Drift from Conn: a sign-in terminal shows its output as plain text with a one-line input, since
//! there is no terminal emulator for a remote stream.

mod editor;
mod models;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;

use conn_client::{Connection, StreamId};
use conn_state::provider_auth::{
    AuthFlow, AuthInteraction, AuthPanel, StatusKey, is_web_url, plain_terminal_output,
};
use conn_state::providers::{ProviderGroup, ServerConfigState};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, Entity,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, px,
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

/// A command in flight or its failure, shown under the Account row.
#[derive(Default)]
struct Account {
    flow: Option<AuthFlow>,
    /// The subscription ended before any state arrived: this server has no sign-in for it.
    load_failed: bool,
    error: Option<String>,
    pending: bool,
    /// The sign-in method picked from several; `None` is `Provider default`.
    method_id: Option<String>,
    confirm_sign_out: bool,
}

/// The Providers settings page.
pub(crate) struct ProvidersView {
    tokens: Tokens,
    geometry: ShellGeometry,
    connection: Option<Connection>,
    environment_label: String,
    config: Arc<ServerConfigState>,
    /// The instance whose Account row is open.
    selected: Option<String>,
    account: Account,
    auth_stream: Option<StreamId>,
    _auth_task: Option<Task<()>>,
    refreshing: HashSet<String>,
    refreshing_all: bool,
    callback_input: Entity<InputState>,
    terminal_input: Entity<InputState>,
    /// One input per field of the current credentials interaction.
    credential_inputs: Vec<(String, Entity<InputState>)>,
    credential_for: Option<String>,
    _subscriptions: Vec<Subscription>,
    /// The inputs of the instance being edited.
    editor: Option<editor::Editor>,
    /// The Add provider form, while open.
    adding: Option<editor::AddForm>,
    write: editor::WriteState,
    /// The instance whose removal or reset waits for a second click.
    confirm_remove: Option<String>,
    /// `(project id, title)` whose switches this page edits, or `None` for the device.
    project_scope: Option<(String, String)>,
    /// The last `Check` of each secret reference, by slot.
    secret_checks: std::collections::HashMap<String, editor::SecretCheck>,
    /// The custom model whose editor is open.
    custom_edit: Option<models::CustomEdit>,
}

impl ProvidersView {
    pub(crate) fn new(
        init: ProvidersInit,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let callback_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("http://localhost:..."));
        let terminal_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Type a response and press Enter"));
        let terminal_sub = cx.subscribe(&terminal_input, |view, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                view.send_terminal_line(cx);
            }
        });
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
            callback_input,
            terminal_input,
            credential_inputs: Vec::new(),
            credential_for: None,
            _subscriptions: vec![terminal_sub],
            editor: None,
            adding: None,
            write: editor::WriteState::default(),
            confirm_remove: None,
            project_scope: None,
            secret_checks: std::collections::HashMap::new(),
            custom_edit: None,
        }
    }

    /// Edits `project`'s own provider switches, or with `None` the device's.
    pub(crate) fn set_project_scope(
        &mut self,
        project: Option<(String, String)>,
        cx: &mut Context<'_, Self>,
    ) {
        self.project_scope = project;
        self.confirm_remove = None;
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// A new connection: the Account row follows the new server.
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
        cx.notify();
    }

    /// `Open provider setup`: open the editor, with its Account row, of `instance_id`.
    pub(crate) fn focus_provider(&mut self, instance_id: String, cx: &mut Context<'_, Self>) {
        self.project_scope = None;
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

    /// Follows `provider.auth.subscribe` for the selected instance (`providerAuthState`).
    fn subscribe_auth(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_auth();
        let (Some(connection), Some(instance_id)) =
            (self.connection.clone(), self.selected.clone())
        else {
            return;
        };
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
            // The stream ended: with no state yet, this server offers no sign-in for it.
            let _ = this.update(cx, |view, cx| {
                if view.account.flow.is_none() {
                    view.account.load_failed = true;
                    cx.notify();
                }
            });
        }));
    }

    /// Runs one `provider.auth.*` call and applies the state it answers. `then` runs after a
    /// success, for example to open the browser.
    fn run_auth_call<P: Serialize + 'static>(
        &mut self,
        tag: &'static str,
        payload: P,
        then: Option<Box<dyn FnOnce(&mut Self, &mut Context<'_, Self>)>>,
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
                        if let Some(then) = then {
                            then(view, cx);
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

    fn start_sign_in(&mut self, cx: &mut Context<'_, Self>) {
        let Some(instance_id) = self.selected.clone() else {
            return;
        };
        let method = self.account.method_id.clone().filter(|id| {
            self.account
                .flow
                .as_ref()
                .and_then(|f| f.methods.as_ref())
                .is_some_and(|methods| methods.iter().any(|m| &m.id == id))
        });
        let payload = conn_contract::ProviderAuthStartInput {
            instance_id,
            method_id: method,
            return_url: None,
            callback_mode: None,
        };
        self.run_auth_call("provider.auth.start", payload, None, cx);
    }

    fn cancel_sign_in(&mut self, cx: &mut Context<'_, Self>) {
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
        self.run_auth_call("provider.auth.cancel", payload, None, cx);
    }

    fn sign_out(&mut self, cx: &mut Context<'_, Self>) {
        let Some(instance_id) = self.selected.clone() else {
            return;
        };
        self.account.confirm_sign_out = false;
        let payload = conn_contract::ProviderSetupInput { instance_id };
        self.run_auth_call("provider.auth.logout", payload, None, cx);
    }

    /// `respond` with an interaction answer.
    fn respond(
        &mut self,
        response: Value,
        then: Option<Box<dyn FnOnce(&mut Self, &mut Context<'_, Self>)>>,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(instance_id), Some(flow), Some(interaction_id)) = (
            self.selected.clone(),
            self.account.flow.as_ref().and_then(|f| f.flow_id.clone()),
            self.account
                .flow
                .as_ref()
                .and_then(|f| match f.interaction.as_ref()? {
                    AuthInteraction::Browser { id, .. }
                    | AuthInteraction::DeviceCode { id, .. }
                    | AuthInteraction::Terminal { id, .. }
                    | AuthInteraction::Credentials { id, .. } => Some(id.clone()),
                }),
        ) else {
            return;
        };
        let payload = json!({
            "instanceId": instance_id,
            "flowId": flow,
            "interactionId": interaction_id,
            "response": response,
        });
        self.run_auth_call("provider.auth.respond", payload, then, cx);
    }

    /// `Open browser`: record consent first when the server asks, then open the link.
    fn open_browser(&mut self, cx: &mut Context<'_, Self>) {
        let Some(flow) = self.account.flow.clone() else {
            return;
        };
        let Some(url) = flow.url().map(str::to_owned) else {
            return;
        };
        if !is_web_url(&url) {
            self.account.error =
                Some("This sign-in link is not a web address, so it was not opened.".to_owned());
            cx.notify();
            return;
        }
        let consent = matches!(
            flow.interaction,
            Some(AuthInteraction::Browser {
                requires_consent: true,
                ..
            })
        );
        let open: Box<dyn FnOnce(&mut Self, &mut Context<'_, Self>)> =
            Box::new(move |_, cx| cx.open_url(&url));
        if consent {
            self.respond(
                json!({ "type": "browser", "action": "accept" }),
                Some(open),
                cx,
            );
        } else {
            open(self, cx);
        }
    }

    /// `Copy sign-in link`: consent is recorded once the link leaves the app.
    fn copy_link(&mut self, cx: &mut Context<'_, Self>) {
        let Some(flow) = self.account.flow.clone() else {
            return;
        };
        let Some(url) = flow.url().map(str::to_owned) else {
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(url));
        if matches!(
            flow.interaction,
            Some(AuthInteraction::Browser {
                requires_consent: true,
                ..
            })
        ) {
            self.respond(json!({ "type": "browser", "action": "accept" }), None, cx);
        }
    }

    /// `If the final localhost page does not load, paste its full URL here.`
    fn submit_callback(&mut self, cx: &mut Context<'_, Self>) {
        let url = self.callback_input.read(cx).value().trim().to_owned();
        let (Some(instance_id), Some(flow_id)) = (
            self.selected.clone(),
            self.account.flow.as_ref().and_then(|f| f.flow_id.clone()),
        ) else {
            return;
        };
        if url.is_empty() {
            return;
        }
        let payload = conn_contract::ProviderAuthCompleteInput {
            instance_id,
            flow_id,
            callback_url: url,
        };
        self.run_auth_call("provider.auth.complete", payload, None, cx);
    }

    fn submit_credentials(&mut self, cx: &mut Context<'_, Self>) {
        let values: serde_json::Map<String, Value> = self
            .credential_inputs
            .iter()
            .map(|(name, input)| (name.clone(), json!(input.read(cx).value().to_string())))
            .collect();
        self.respond(json!({ "type": "credentials", "values": values }), None, cx);
    }

    fn send_terminal_line(&mut self, cx: &mut Context<'_, Self>) {
        let line = self.terminal_input.read(cx).value().to_string();
        self.respond(
            json!({ "type": "terminal", "data": format!("{line}\r") }),
            None,
            cx,
        );
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

    /// The Account row of the selected provider (`ProviderAuthenticationSection`).
    fn account_rows(
        &mut self,
        group: &ProviderGroup,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Vec<AnyElement> {
        let tokens = self.tokens.clone();
        let panel = AuthPanel::derive(
            group,
            self.account.flow.as_ref(),
            self.account.load_failed,
            &self.environment_label,
        );
        let id = group.instance_id.clone();
        let disabled = self.account.pending;
        let ax = |suffix: &str| format!("settings.providers.{id}.account.{suffix}");
        let mut rows = vec![settings_row(
            "Environment",
            Some("Device that runs this provider."),
            self.muted_line(self.environment_label.clone())
                .into_any_element(),
            &tokens,
            &self.geometry,
        )];

        if self.account.load_failed && !panel.offers_docs {
            rows.push(settings_row(
                "Setup unavailable",
                Some("This server offers no sign-in for this provider."),
                div().into_any_element(),
                &tokens,
                &self.geometry,
            ));
            return rows;
        }

        let mut controls = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(6.0));
        if panel.offers_method_choice
            && let Some(methods) = self.account.flow.as_ref().and_then(|f| f.methods.clone())
        {
            let picked = self.account.method_id.clone();
            let mut choices: Vec<(Option<String>, String)> =
                vec![(None, "Provider default".to_owned())];
            choices.extend(methods.into_iter().map(|m| (Some(m.id), m.name)));
            for (method, label) in choices {
                let selected = picked == method;
                let method_id = method.clone();
                controls = controls.child(self.button(
                    ax(&format!(
                        "method.{}",
                        method.as_deref().unwrap_or("default")
                    )),
                    &label,
                    selected,
                    (!disabled).then(|| {
                        cx.listener(move |view, _, _, cx| {
                            view.account.method_id = method_id.clone();
                            cx.notify();
                        })
                    }),
                ));
            }
        }
        if panel.url.is_some() {
            controls = controls
                .child(self.button(
                    ax("open-browser"),
                    "Open browser",
                    false,
                    (!disabled).then(|| cx.listener(|view, _, _, cx| view.open_browser(cx))),
                ))
                .child(self.button(
                    ax("copy-link"),
                    "Copy sign-in link",
                    false,
                    (!disabled).then(|| cx.listener(|view, _, _, cx| view.copy_link(cx))),
                ));
        }
        if panel.offers_docs {
            if let Some(url) = group.documentation_url.clone().filter(|u| is_web_url(u)) {
                controls = controls.child(self.button(
                    ax("docs"),
                    "Open docs",
                    false,
                    Some(cx.listener(move |_, _, _, cx| cx.open_url(&url))),
                ));
            }
        } else if panel.offers_cancel {
            controls = controls.child(self.button(
                ax("cancel"),
                "Cancel",
                false,
                (!disabled).then(|| cx.listener(|view, _, _, cx| view.cancel_sign_in(cx))),
            ));
        } else if let Some(label) = panel.sign_in_label {
            controls = controls.child(
                self.button(
                    ax("sign-in"),
                    label,
                    false,
                    (!disabled && panel.sign_in_enabled)
                        .then(|| cx.listener(|view, _, _, cx| view.start_sign_in(cx))),
                ),
            );
        }
        if panel.offers_sign_out {
            if self.account.confirm_sign_out {
                controls = controls
                    .child(self.button(
                        ax("sign-out-confirm"),
                        "Confirm sign out",
                        true,
                        (!disabled).then(|| cx.listener(|view, _, _, cx| view.sign_out(cx))),
                    ))
                    .child(self.button(
                        ax("sign-out-keep"),
                        "Keep signed in",
                        false,
                        Some(cx.listener(|view, _, _, cx| {
                            view.account.confirm_sign_out = false;
                            cx.notify();
                        })),
                    ));
            } else {
                controls = controls.child(self.button(
                    ax("sign-out"),
                    "Sign out",
                    false,
                    (!disabled).then(|| {
                        cx.listener(|view, _, _, cx| {
                            view.account.confirm_sign_out = true;
                            cx.notify();
                        })
                    }),
                ));
            }
        }

        let description = if panel.signed_in && !panel.active {
            match &group.auth_email {
                Some(email) => format!("Signed in as {email}"),
                None => panel.description.clone(),
            }
        } else if self.account.confirm_sign_out {
            format!(
                "Sign out of {} on {}? This stops running threads that share this sign-in. Thread history is kept.",
                group.display_name, self.environment_label
            )
        } else {
            panel.description.clone()
        };
        rows.push(settings_row(
            "Account",
            Some(&description),
            controls.into_any_element(),
            &tokens,
            &self.geometry,
        ));
        if let Some(message) = &panel.status_message {
            rows.push(self.note_row(message.clone(), false, &ax("status")));
        }

        let interaction = self
            .account
            .flow
            .as_ref()
            .and_then(|f| f.interaction.clone());
        match interaction {
            Some(AuthInteraction::DeviceCode { user_code, .. }) => {
                rows.push(self.note_row(
                    format!("Enter code {user_code} in your browser."),
                    false,
                    &ax("device-code"),
                ));
            }
            Some(AuthInteraction::Terminal { output, .. }) => {
                let plain = plain_terminal_output(&output);
                rows.push(
                    div()
                        .id(SharedString::from(ax("terminal")))
                        .a11y_group(ax("terminal"), "Sign-in terminal")
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .px(px(14.0))
                        .py(px(12.0))
                        .child(
                            div()
                                .id(SharedString::from(ax("terminal.output")))
                                .max_h(px(180.0))
                                .overflow_y_scroll()
                                .p(px(8.0))
                                .rounded(px(6.0))
                                .bg(hsla_alpha(tokens.foreground, 0.05))
                                .font_family("Menlo")
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .text_color(hsla(tokens.foreground))
                                .child(plain),
                        )
                        .child(Input::new(&self.terminal_input))
                        .into_any_element(),
                );
            }
            Some(AuthInteraction::Credentials {
                id: interaction_id,
                fields,
            }) => {
                if self.credential_for.as_deref() != Some(interaction_id.as_str()) {
                    self.credential_for = Some(interaction_id);
                    self.credential_inputs = fields
                        .iter()
                        .map(|field| {
                            let secret = field.secret;
                            let input = cx.new(|cx| InputState::new(window, cx).masked(secret));
                            (field.name.clone(), input)
                        })
                        .collect();
                }
                let mut form = div()
                    .id(SharedString::from(ax("credentials")))
                    .a11y_group(ax("credentials"), "Credentials")
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .px(px(14.0))
                    .py(px(12.0));
                for (field, (_, input)) in fields.iter().zip(&self.credential_inputs) {
                    form = form.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(4.0))
                            .child(self.muted_line(field.label.clone()))
                            .child(Input::new(input)),
                    );
                }
                form = form.child(self.button(
                    ax("connect"),
                    "Connect",
                    false,
                    (!disabled).then(|| cx.listener(|view, _, _, cx| view.submit_credentials(cx))),
                ));
                rows.push(form.into_any_element());
            }
            Some(AuthInteraction::Browser {
                accepts_callback: true,
                ..
            }) => {
                rows.push(
                    div()
                        .id(SharedString::from(ax("callback")))
                        .a11y_group(ax("callback"), "Sign-in callback")
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .px(px(14.0))
                        .py(px(12.0))
                        .child(self.muted_line(
                            "If the final localhost page does not load, paste its full URL here.",
                        ))
                        .child(Input::new(&self.callback_input))
                        .child(
                            self.button(
                                ax("callback-continue"),
                                "Continue",
                                false,
                                (!disabled).then(|| {
                                    cx.listener(|view, _, _, cx| view.submit_callback(cx))
                                }),
                            ),
                        )
                        .into_any_element(),
                );
            }
            _ => {}
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

/// An outlined settings button. `on_click` is `None` while it is disabled.
pub(crate) fn settings_button(
    tokens: &Tokens,
    ax_id: String,
    label: &str,
    on_click: Option<impl Fn(&ClickEvent, &mut Window, &mut App) + 'static>,
) -> AnyElement {
    styled_button(tokens, ax_id, label, label, false, on_click)
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
                        (self.adding.is_none()
                            && config.settings().is_some()
                            && conn_state::provider_settings::can_add_provider(
                                config.managed_policy(),
                            ))
                        .then(|| cx.listener(|view, _, window, cx| view.open_add_form(window, cx))),
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
        if let Some((_, title)) = self.project_scope.clone() {
            rows.push(settings_row(
                &format!("Project: {title}"),
                Some("Switches here turn a provider on or off for this project only. The device setting applies everywhere else."),
                self.button(
                    "settings.providers.scope.clear".to_owned(),
                    "Show device settings",
                    false,
                    Some(cx.listener(|view, _, _, cx| view.set_project_scope(None, cx))),
                ),
                &tokens,
                &geometry,
            ));
        }
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
            for section in self.editor_sections(group, window, cx) {
                page = page.child(section);
            }
        }
        page
    }
}
