//! Settings → Secrets: the 1Password providers an environment reads provider variables from
//! (`SecretsSettings.tsx`, `SecretProviderDialog.tsx`, `RedactedSensitiveText.tsx`).
//!
//! `Add provider` opens a form, `Edit` reopens it on a provider, and `Remove` asks first,
//! naming every setting that reads from the provider and will be unset. A provider's account
//! stays masked until `Show account`.
//!
//! Drift from Conn: the Add and Edit form is a section of the page, not a dialog, so a dialog
//! never stacks on the Settings modal. The masked account shows its stand-in text, not a blur,
//! since GPUI cannot blur text.

use std::collections::HashSet;
use std::sync::Arc;

use conn_client::Connection;
use conn_state::providers::ServerConfigState;
use conn_state::secret_providers::{
    ClassifiedProvider, Draft, Entry, Issues, Target, classify, entry_from_draft,
    redacted_placeholder, remove_request, secret_provider_uses, set_request,
};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, SharedString, Styled as _, Subscription, TestSupportExt as _,
    Window, div, px,
};
use serde_json::Value;

use super::controls::{settings_row, settings_section};
use super::providers::styled_button;
use crate::a11y::ConnA11yExt as _;
use crate::theme::hsla;

/// What [`SecretsView::new`] starts from.
pub(crate) struct SecretsInit {
    pub(crate) tokens: Tokens,
    pub(crate) geometry: ShellGeometry,
    pub(crate) connection: Option<Connection>,
    pub(crate) environment_label: String,
}

/// The Add and Edit form while it is open.
struct Form {
    target: Target,
    name: Entity<InputState>,
    account: Entity<InputState>,
    /// Errors show once a save was tried.
    submitted: bool,
    _subscriptions: Vec<Subscription>,
}

/// What a finished write changes on the page.
#[derive(Clone, Copy)]
enum Then {
    CloseForm,
    CloseRemove,
}

/// The Secrets settings page.
pub(crate) struct SecretsView {
    tokens: Tokens,
    geometry: ShellGeometry,
    connection: Option<Connection>,
    environment_label: String,
    config: Arc<ServerConfigState>,
    form: Option<Form>,
    /// The provider whose removal waits for a second click.
    confirm_remove: Option<String>,
    revealed: HashSet<String>,
    pending: bool,
    error: Option<String>,
}

impl SecretsView {
    pub(crate) fn new(init: SecretsInit) -> Self {
        Self {
            tokens: init.tokens,
            geometry: init.geometry,
            connection: init.connection,
            environment_label: init.environment_label,
            config: Arc::default(),
            form: None,
            confirm_remove: None,
            revealed: HashSet::new(),
            pending: false,
            error: None,
        }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// A new connection: nothing half-edited carries over.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        environment_label: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.environment_label = environment_label;
        self.form = None;
        self.confirm_remove = None;
        self.error = None;
        cx.notify();
    }

    pub(crate) fn set_server_config(
        &mut self,
        config: Arc<ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.config = config;
        cx.notify();
    }

    fn provider_ids(&self) -> Vec<String> {
        self.config
            .settings()
            .and_then(|s| s.secret_providers.as_ref())
            .map(|providers| providers.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn open_form(&mut self, target: Target, window: &mut Window, cx: &mut Context<'_, Self>) {
        let draft = match &target {
            Target::Add => Draft::default(),
            Target::Edit(id) => self
                .config
                .settings()
                .and_then(|s| s.secret_providers.as_ref())
                .and_then(|providers| providers.get(id))
                .map(Draft::of)
                .unwrap_or_default(),
        };
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Personal")
                .default_value(draft.name)
        });
        let account = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("my.1password.com")
                .default_value(draft.account)
        });
        let mut subscriptions = Vec::new();
        for input in [&name, &account] {
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                |view, _, event: &InputEvent, _, cx| match event {
                    InputEvent::PressEnter { .. } => view.submit(cx),
                    InputEvent::Change => cx.notify(),
                    _ => {}
                },
            ));
        }
        self.confirm_remove = None;
        self.error = None;
        self.form = Some(Form {
            target,
            name,
            account,
            submitted: false,
            _subscriptions: subscriptions,
        });
        cx.notify();
    }

    fn draft(&self, form: &Form, cx: &gpui_kit::App) -> Draft {
        Draft {
            name: form.name.read(cx).value().to_string(),
            account: form.account.read(cx).value().to_string(),
        }
    }

    fn entry(&self, form: &Form, cx: &gpui_kit::App) -> Result<Entry, Issues> {
        entry_from_draft(&self.draft(form, cx), &self.provider_ids(), &form.target)
    }

    fn submit(&mut self, cx: &mut Context<'_, Self>) {
        let Some(form) = &self.form else {
            return;
        };
        match self.entry(form, cx) {
            Ok(entry) => self.write(set_request(&entry), Then::CloseForm, cx),
            Err(_) => {
                if let Some(form) = &mut self.form {
                    form.submitted = true;
                }
                cx.notify();
            }
        }
    }

    /// One `server.updateSettings` call. The settings stream brings the result back.
    fn write(&mut self, request: Value, then: Then, cx: &mut Context<'_, Self>) {
        let Some(connection) = self.connection.clone() else {
            return;
        };
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = connection.call_json("server.updateSettings", request).await;
            let _ = this.update(cx, |view, cx| {
                view.pending = false;
                match result {
                    Ok(_) => match then {
                        Then::CloseForm => view.form = None,
                        Then::CloseRemove => view.confirm_remove = None,
                    },
                    Err(err) => {
                        view.error = Some(format!(
                            "Could not update secret providers. {}",
                            conn_client::commands::format_client_error(&err)
                        ));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn button(
        &self,
        ax_id: String,
        label: &str,
        ax_label: &str,
        primary: bool,
        on_click: Option<impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static>,
    ) -> AnyElement {
        styled_button(&self.tokens, ax_id, label, ax_label, primary, on_click)
    }

    fn note(&self, ax_id: &str, text: String, error: bool) -> AnyElement {
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

    /// A labelled input of the form, with its error under it.
    fn field(
        &self,
        ax_id: &str,
        title: &str,
        help: Option<&str>,
        input: &Entity<InputState>,
        error: Option<&str>,
    ) -> AnyElement {
        let mut column = div()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(4.0))
            .w(px(260.0));
        column = column.child(
            div()
                .id(SharedString::from(ax_id.to_owned()))
                .a11y_group(ax_id.to_owned(), title.to_owned())
                .w_full()
                .child(Input::new(input))
                .test_support(),
        );
        if let Some(error) = error {
            column = column.child(
                div()
                    .id(SharedString::from(format!("{ax_id}.error")))
                    .a11y_group(format!("{ax_id}.error"), error.to_owned())
                    .w_full()
                    .text_size(px(12.0))
                    .text_color(hsla(self.tokens.destructive))
                    .child(error.to_owned())
                    .test_support(),
            );
        }
        settings_row(
            title,
            help,
            column.into_any_element(),
            &self.tokens,
            &self.geometry,
        )
    }

    fn form_section(&self, form: &Form, cx: &mut Context<'_, Self>) -> AnyElement {
        let issues = if form.submitted {
            self.entry(form, cx).err().unwrap_or_default()
        } else {
            Issues::default()
        };
        let (title, save_label) = match &form.target {
            Target::Add => ("Add a 1Password provider".to_owned(), "Add provider"),
            Target::Edit(id) => {
                let label = self
                    .config
                    .settings()
                    .and_then(|s| s.secret_providers.as_ref())
                    .and_then(|providers| providers.get(id))
                    .map_or(id.as_str(), |config| config.label.as_str());
                (format!("Edit {label}"), "Save changes")
            }
        };
        let rows = vec![
            self.note(
                "settings.secrets.form.about",
                format!(
                    "Provider variables on {} can read values from it by name. Values are read with the op CLI on that server when a provider starts.",
                    self.environment_label
                ),
                false,
            ),
            self.field(
                "settings.secrets.form.name",
                "Name",
                None,
                &form.name,
                issues.name.as_deref(),
            ),
            self.field(
                "settings.secrets.form.account",
                "Account",
                Some("The account shorthand, sign-in address without https://, or ID that op account list shows."),
                &form.account,
                issues.account.as_deref(),
            ),
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap(px(8.0))
                .px(px(14.0))
                .py(px(10.0))
                .child(self.button(
                    "settings.secrets.form.cancel".to_owned(),
                    "Cancel",
                    "Cancel",
                    false,
                    Some(cx.listener(|view, _, _, cx| {
                        view.form = None;
                        cx.notify();
                    })),
                ))
                .child(self.button(
                    "settings.secrets.form.save".to_owned(),
                    save_label,
                    save_label,
                    true,
                    (!self.pending).then(|| cx.listener(|view, _, _, cx| view.submit(cx))),
                ))
                .into_any_element(),
        ];
        settings_section(&title, rows, &self.tokens, &self.geometry).into_any_element()
    }

    /// The question under a provider whose removal was asked for.
    fn remove_row(&self, id: &str, label: &str, cx: &mut Context<'_, Self>) -> AnyElement {
        let uses = self
            .config
            .settings()
            .map(|settings| secret_provider_uses(settings, id))
            .unwrap_or_default();
        let summary = if uses.is_empty() {
            format!("Nothing reads from {label}. The secrets themselves are untouched.")
        } else {
            format!(
                "These read from {label} and will be unset. The secrets themselves are untouched."
            )
        };
        let mut column = div()
            .flex()
            .flex_col()
            .gap(px(4.0))
            .px(px(14.0))
            .py(px(10.0));
        column = column.child(
            div()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(hsla(self.tokens.foreground))
                .child(format!("Remove {label}?")),
        );
        column = column.child(
            div()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(hsla(self.tokens.muted_foreground_raised))
                .child(summary),
        );
        for (index, used) in uses.iter().enumerate() {
            column = column.child(
                div()
                    .id(SharedString::from(format!(
                        "settings.secrets.{id}.use.{index}"
                    )))
                    .a11y_group(
                        format!("settings.secrets.{id}.use.{index}"),
                        used.label.clone(),
                    )
                    .pl(px(12.0))
                    .text_size(px(self.geometry.ui_font_size_px))
                    .text_color(hsla(self.tokens.foreground))
                    .child(format!("\u{2022} {}", used.label))
                    .test_support(),
            );
        }
        let remove_id = id.to_owned();
        column = column.child(
            div()
                .flex()
                .flex_row()
                .justify_end()
                .gap(px(8.0))
                .pt(px(6.0))
                .child(self.button(
                    format!("settings.secrets.{id}.remove.cancel"),
                    "Cancel",
                    "Cancel",
                    false,
                    Some(cx.listener(|view, _, _, cx| {
                        view.confirm_remove = None;
                        cx.notify();
                    })),
                ))
                .child(self.button(
                    format!("settings.secrets.{id}.remove.confirm"),
                    "Remove provider",
                    &format!("Remove provider {label}"),
                    true,
                    (!self.pending).then(|| {
                        cx.listener(move |view, _, _, cx| {
                            view.write(remove_request(&remove_id), Then::CloseRemove, cx);
                        })
                    }),
                )),
        );
        column.into_any_element()
    }
}

impl Render for SecretsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let tokens = self.tokens.clone();
        let geometry = self.geometry;
        let mut page = div()
            .id("settings-secrets-page")
            .flex()
            .flex_col()
            .gap(px(20.0))
            .w_full();

        if !self.config.is_loaded() {
            return page.child(settings_section(
                "Secret providers",
                vec![self.note(
                    "settings.secrets.waiting",
                    "Connect an environment to manage the secret providers its provider variables read from."
                        .to_owned(),
                    false,
                )],
                &tokens,
                &geometry,
            ));
        }
        if !self.config.supports_secret_provider_settings() {
            return page.child(settings_section(
                "Secret providers",
                vec![self.note(
                    "settings.secrets.update",
                    format!(
                        "Update Conn on {} to manage its secret providers.",
                        self.environment_label
                    ),
                    false,
                )],
                &tokens,
                &geometry,
            ));
        }

        let entries: Vec<(String, conn_contract::ServerSettingsSecretProvidersValue)> = self
            .config
            .settings()
            .and_then(|s| s.secret_providers.as_ref())
            .map(|providers| {
                providers
                    .iter()
                    .map(|(id, config)| (id.clone(), config.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let mut rows = vec![settings_row(
            "Secret providers",
            Some("Add a 1Password account, then pick it as the source of a provider variable."),
            self.button(
                "settings.secrets.add".to_owned(),
                "Add provider",
                "Add provider",
                false,
                (self.form.is_none()).then(|| {
                    cx.listener(|view, _, window, cx| view.open_form(Target::Add, window, cx))
                }),
            ),
            &tokens,
            &geometry,
        )];
        if entries.is_empty() {
            rows.push(self.note(
                "settings.secrets.empty",
                "No secret providers configured.".to_owned(),
                false,
            ));
        }
        for (id, config) in &entries {
            let classified = classify(config);
            let revealed = self.revealed.contains(id);
            let description = match &classified {
                ClassifiedProvider::OnePassword { account } => format!(
                    "1Password \u{b7} {}",
                    if revealed {
                        account.clone()
                    } else {
                        redacted_placeholder(account)
                    }
                ),
                ClassifiedProvider::Unsupported => {
                    format!("Unsupported provider ({})", config.kind)
                }
            };
            let mut controls = div().flex().flex_row().items_center().gap(px(6.0));
            if matches!(classified, ClassifiedProvider::OnePassword { .. }) {
                let reveal_id = id.clone();
                controls = controls
                    .child(self.button(
                        format!("settings.secrets.{id}.reveal"),
                        if revealed {
                            "Hide account"
                        } else {
                            "Show account"
                        },
                        &format!(
                            "{} account of {}",
                            if revealed { "Hide" } else { "Show" },
                            config.label
                        ),
                        false,
                        Some(cx.listener(move |view, _, _, cx| {
                            if !view.revealed.remove(&reveal_id) {
                                view.revealed.insert(reveal_id.clone());
                            }
                            cx.notify();
                        })),
                    ))
                    .child({
                        let edit_id = id.clone();
                        self.button(
                            format!("settings.secrets.{id}.edit"),
                            "Edit",
                            &format!("Edit {}", config.label),
                            false,
                            Some(cx.listener(move |view, _, window, cx| {
                                view.open_form(Target::Edit(edit_id.clone()), window, cx);
                            })),
                        )
                    });
            }
            let remove_id = id.clone();
            controls = controls.child(self.button(
                format!("settings.secrets.{id}.remove"),
                "Remove",
                &format!("Remove {}", config.label),
                false,
                Some(cx.listener(move |view, _, _, cx| {
                    view.form = None;
                    view.confirm_remove = Some(remove_id.clone());
                    cx.notify();
                })),
            ));
            rows.push(settings_row(
                &config.label,
                Some(&description),
                controls.into_any_element(),
                &tokens,
                &geometry,
            ));
            if self.confirm_remove.as_deref() == Some(id.as_str()) {
                rows.push(self.remove_row(id, &config.label, cx));
            }
        }
        if let Some(error) = self.error.clone() {
            rows.push(self.note("settings.secrets.error", error, true));
        }
        if let Some(form) = &self.form {
            page = page.child(self.form_section(form, cx));
        }
        page.child(settings_section(
            "Secret providers",
            rows,
            &tokens,
            &geometry,
        ))
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::test::{TestQueryExt as _, TestWindowExt as _};
    use gpui_kit::{
        AnyWindowHandle, Bounds, Point, TestAppContext, WindowBounds, WindowOptions, size,
    };
    use serde_json::json;

    use super::*;
    use crate::theme::apply_kit_theme;

    fn config(flag: bool) -> Arc<ServerConfigState> {
        let mut snapshot: Value = serde_json::from_str(include_str!(
            "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
        ))
        .expect("fixture is JSON");
        snapshot["config"]["secretProviderSettings"] = json!(flag);
        snapshot["config"]["settings"]["secretProviders"] = json!({
            "work": { "kind": "one_password", "label": "Work", "config": { "account": "my.1password.com" } },
            "odd": { "kind": "vault", "label": "Odd" },
        });
        snapshot["config"]["settings"]["providerInstances"] = json!({
            "codex": {
                "driver": "codex",
                "environment": [{ "name": "TOKEN", "value": "", "sensitive": true,
                    "secret": { "provider": "work", "reference": "op://v/i/f" } }],
            },
        });
        let mut state = ServerConfigState::new();
        state.apply(serde_json::from_value(snapshot).expect("snapshot event"));
        Arc::new(state)
    }

    fn mount(cx: &mut TestAppContext) -> (AnyWindowHandle, Entity<SecretsView>) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            let theme = conn_theme::theme_by_id("dark-ocean").expect("built-in theme");
            let tokens = Tokens::derive(&theme);
            apply_kit_theme(&tokens, cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Point::default(),
                    size(px(1200.0), px(2400.0)),
                ))),
                ..Default::default()
            };
            gpui_kit::open_window(options, cx, |window, cx| {
                window.activate_window();
                cx.new(|_| {
                    SecretsView::new(SecretsInit {
                        tokens,
                        geometry: ShellGeometry::default(),
                        connection: None,
                        environment_label: "Mini".to_owned(),
                    })
                })
            })
            .expect("window opens")
        })
    }

    fn has(cx: &mut TestAppContext, window: AnyWindowHandle, label: &str) -> bool {
        cx.update_window(window, |_, window, cx| {
            window.render_frame(cx);
            window.try_find_by_label(label).is_some()
        })
        .unwrap_or(false)
    }

    #[gpui_kit::test]
    fn the_page_waits_for_an_environment_and_a_server_that_takes_secret_providers(
        cx: &mut TestAppContext,
    ) {
        let (window, view) = mount(cx);
        assert!(has(
            cx,
            window,
            "Connect an environment to manage the secret providers its provider variables read from."
        ));
        cx.update(|cx| view.update(cx, |view, cx| view.set_server_config(config(false), cx)));
        assert!(!has(cx, window, "Add provider"));
        assert!(has(
            cx,
            window,
            "Update Conn on Mini to manage its secret providers."
        ));
    }

    #[gpui_kit::test]
    fn providers_list_with_masked_accounts_a_form_and_a_removal_that_names_its_uses(
        cx: &mut TestAppContext,
    ) {
        let (window, view) = mount(cx);
        cx.update(|cx| {
            view.update(cx, |view, cx| {
                view.set_server_config(config(true), cx);
            });
        });
        assert!(has(cx, window, "Add provider"));
        assert!(has(cx, window, "Show account of Work"));
        assert!(has(cx, window, "Edit Work"));
        assert!(
            has(cx, window, "Remove Odd"),
            "unsupported kinds stay removable"
        );
        assert!(!has(cx, window, "Edit Odd"), "but cannot be edited");

        cx.update_window(window, |_, window, cx| {
            view.update(cx, |view, cx| {
                view.open_form(Target::Edit("work".to_owned()), window, cx);
                view.submit(cx);
            });
        })
        .expect("window");
        assert!(has(cx, window, "Edit Work"));
        assert!(has(cx, window, "Save changes"));
        assert!(has(cx, window, "Account"));

        cx.update(|cx| {
            view.update(cx, |view, cx| {
                view.form = None;
                view.confirm_remove = Some("work".to_owned());
                cx.notify();
            });
        });
        assert!(has(cx, window, "Remove Work?") || has(cx, window, "Remove provider Work"));
        assert!(
            has(cx, window, "Work Provider \u{b7} TOKEN") || has(cx, window, "Codex \u{b7} TOKEN"),
            "the removal names the variable that will be unset"
        );
    }
}
