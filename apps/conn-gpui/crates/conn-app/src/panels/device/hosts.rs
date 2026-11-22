//! Host and account configuration view for the Device surface.
//!
//! Mirrors Conn's `DeviceSourcesSettings.tsx`, `DeviceHostEditor.tsx`, `EasDeviceHostEditor.tsx`,
//! `SimlockDeviceHostEditor.tsx`, `DeviceHostAvailability.tsx`, and `DeviceToolVersions.tsx`,
//! wired directly to `device.configure`, `device.list`, `device.testHost`, `device.easAccount`,
//! `device.simlockIdentity`, `server.getConfig`, and `server.updateSettings`.

use conn_contract::{
    DeviceEasAccount, DeviceHostStatus, DeviceHostSummary, DeviceListInputUpdateTool,
    DevicePlatformAvailability, DeviceSimlockIdentity, EasDeviceHostConfig,
    ServerSettingsEasDeviceHostsItem, ServerSettingsSimlockDeviceHostsItem, SettingsSecretValue,
    SimlockDeviceHostConfig, SshDeviceHostConfig, lit,
};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Div, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, Styled, Subscription, Window, div, px,
};

use super::super::chrome::{
    self, MenuEntry, MenuRow, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::header::superhero_icon;
use super::DevicePanel;
use super::logic::{
    HostKind, all_hosts, build_eas_host_config, build_simlock_host_config, build_ssh_host_config,
    device_hub_readiness, eas_account_message, simlock_identity_message,
};
use super::ui::{
    MenuAnchor, SM_LINE_HEIGHT_PX, SM_TEXT_PX, SwitchSize, XS_BUTTON_HEIGHT_PX, compact_input,
    compact_outline_button, conn_switch, device_host_availability, form_field, ghost_sm_button,
    outline_sm_button, outline_xs_button, primary_sm_button, select_trigger_xs, simple_select_menu,
    tool_versions_detail,
};

/// Active screen inside the Hosts & Configuration drawer/view.
#[derive(Debug)]
pub(super) enum HostConfigScreen {
    Overview,
    Ssh(SshHostForm),
    Eas(EasHostForm),
    Simlock(SimlockHostForm),
}

/// Saved host lists fetched via `server.getConfig`.
#[derive(Clone, Debug, Default)]
pub(super) struct SavedHostConfigs {
    pub(super) ssh_hosts: Vec<SshDeviceHostConfig>,
    pub(super) eas_hosts: Vec<EasDeviceHostConfig>,
    pub(super) simlock_hosts: Vec<SimlockDeviceHostConfig>,
    pub(super) simlock_enabled: bool,
}

impl SavedHostConfigs {
    pub(super) fn from_settings(settings: &conn_contract::ServerSettings) -> Self {
        let ssh_hosts = settings.device_hosts.clone().unwrap_or_default();
        let eas_hosts = settings
            .eas_device_hosts
            .as_ref()
            .map(|items| items.iter().map(eas_from_server_item).collect())
            .unwrap_or_default();
        let simlock_hosts = settings
            .simlock_device_hosts
            .as_ref()
            .map(|items| items.iter().map(simlock_from_server_item).collect())
            .unwrap_or_default();
        let simlock_enabled = settings.simlock_device_hosts_enabled.unwrap_or(false);
        Self {
            ssh_hosts,
            eas_hosts,
            simlock_hosts,
            simlock_enabled,
        }
    }
}

fn eas_from_server_item(item: &ServerSettingsEasDeviceHostsItem) -> EasDeviceHostConfig {
    EasDeviceHostConfig {
        kind: lit::Eas,
        id: item.id.clone(),
        label: item.label.clone(),
        app_id: item.app_id.clone(),
        access_token: item.access_token.clone(),
        max_session_minutes: item.max_session_minutes,
        idle_minutes: item.idle_minutes,
        max_concurrent_sessions: item.max_concurrent_sessions,
    }
}

fn simlock_from_server_item(
    item: &ServerSettingsSimlockDeviceHostsItem,
) -> SimlockDeviceHostConfig {
    SimlockDeviceHostConfig {
        kind: lit::Simlock,
        id: item.id.clone(),
        label: item.label.clone(),
        gateway_url: item.gateway_url.clone(),
        agent_token: item.agent_token.clone(),
        max_leases: item.max_leases,
        max_lease_minutes: item.max_lease_minutes,
    }
}

/// State of `device.testHost` check (`DeviceHostEditor.tsx`).
#[derive(Clone, Debug)]
pub(super) enum SshCheckState {
    Idle,
    Checking,
    Local,
    Connected(Vec<DevicePlatformAvailability>),
    Failed(String),
}

impl SshCheckState {
    pub(super) fn from_summary(summary: DeviceHostSummary) -> Self {
        match summary {
            DeviceHostSummary::Local(item) => {
                if item.kind == conn_contract::DeviceServiceStateHostsItemKind::Local {
                    Self::Local
                } else {
                    Self::Connected(item.platforms)
                }
            }
            DeviceHostSummary::Eas(item) => Self::Connected(item.platforms),
            DeviceHostSummary::Simlock(item) => Self::Connected(item.platforms),
        }
    }
}

/// SSH host form state (`DeviceHostEditor.tsx`).
pub(super) struct SshHostForm {
    pub(super) id: String,
    pub(super) is_new: bool,
    pub(super) label: Entity<InputState>,
    pub(super) target: Entity<InputState>,
    pub(super) identity_file: Entity<InputState>,
    pub(super) port: Entity<InputState>,
    pub(super) show_options: bool,
    pub(super) check: SshCheckState,
    pub(super) _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SshHostForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHostForm")
            .field("id", &self.id)
            .field("is_new", &self.is_new)
            .finish_non_exhaustive()
    }
}

impl SshHostForm {
    pub(super) fn new(
        host: Option<&SshDeviceHostConfig>,
        window: &mut Window,
        cx: &mut Context<'_, DevicePanel>,
    ) -> Self {
        let is_new = host.is_none();
        let id = host.map_or_else(new_host_id, |h| h.id.clone());
        let label = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("Mac mini");
            if let Some(h) = host {
                s.set_value(h.label.clone(), window, cx);
            }
            s
        });
        let target = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("user@host or SSH alias");
            if let Some(h) = host {
                s.set_value(h.target.clone(), window, cx);
            }
            s
        });
        let identity_file = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("SSH config default");
            if let Some(path) = host.and_then(|h| h.identity_file.as_ref()) {
                s.set_value(path.clone(), window, cx);
            }
            s
        });
        let port = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("Default");
            if let Some(p) = host.and_then(|h| h.port) {
                s.set_value(p.to_string(), window, cx);
            }
            s
        });
        let show_options = host.is_some_and(|h| h.port.is_some() || h.identity_file.is_some());
        let subscriptions = subscribe_notify([&label, &target, &identity_file, &port], cx);
        Self {
            id,
            is_new,
            label,
            target,
            identity_file,
            port,
            show_options,
            check: SshCheckState::Idle,
            _subscriptions: subscriptions,
        }
    }

    pub(super) fn validate(
        &self,
        cx: &Context<'_, DevicePanel>,
    ) -> Result<SshDeviceHostConfig, &'static str> {
        build_ssh_host_config(
            self.id.clone(),
            self.label.read(cx).value().as_ref(),
            self.target.read(cx).value().as_ref(),
            self.identity_file.read(cx).value().as_ref(),
            self.port.read(cx).value().as_ref(),
        )
    }
}

/// State of `device.easAccount` check (`EasDeviceHostEditor.tsx`).
#[derive(Clone, Debug)]
pub(super) enum EasAccountCheckState {
    Idle,
    Checking,
    SignedIn(DeviceEasAccount),
    Failed(String),
}

/// Expo (EAS) host form state (`EasDeviceHostEditor.tsx`).
pub(super) struct EasHostForm {
    pub(super) id: String,
    pub(super) is_new: bool,
    pub(super) saved_token: Option<SettingsSecretValue>,
    pub(super) token_cleared: bool,
    pub(super) label: Entity<InputState>,
    pub(super) token: Entity<InputState>,
    pub(super) app_id: Option<String>,
    pub(super) app_menu_open: bool,
    pub(super) max_concurrent: Entity<InputState>,
    pub(super) max_session: Entity<InputState>,
    pub(super) idle_minutes: Entity<InputState>,
    pub(super) check: EasAccountCheckState,
    pub(super) _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for EasHostForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EasHostForm")
            .field("id", &self.id)
            .field("is_new", &self.is_new)
            .finish_non_exhaustive()
    }
}

impl EasHostForm {
    pub(super) fn new(
        host: Option<&EasDeviceHostConfig>,
        window: &mut Window,
        cx: &mut Context<'_, DevicePanel>,
    ) -> Self {
        let is_new = host.is_none();
        let id = host.map_or_else(new_host_id, |h| h.id.clone());
        let label = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("Expo Simulators");
            s.set_value(
                host.map_or_else(|| "Expo Simulators".to_owned(), |h| h.label.clone()),
                window,
                cx,
            );
            s
        });
        let has_saved = host.is_some_and(|h| h.access_token.is_some());
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(if has_saved {
                    "Saved token (enter to replace)"
                } else {
                    "Optional"
                })
        });
        let max_concurrent = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("2");
            s.set_value(
                host.and_then(|h| h.max_concurrent_sessions)
                    .unwrap_or(2)
                    .to_string(),
                window,
                cx,
            );
            s
        });
        let max_session = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("30");
            s.set_value(
                host.and_then(|h| h.max_session_minutes)
                    .unwrap_or(30)
                    .to_string(),
                window,
                cx,
            );
            s
        });
        let idle_minutes = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("10");
            s.set_value(
                host.and_then(|h| h.idle_minutes).unwrap_or(10).to_string(),
                window,
                cx,
            );
            s
        });
        let subscriptions = subscribe_notify(
            [&label, &token, &max_concurrent, &max_session, &idle_minutes],
            cx,
        );
        Self {
            id,
            is_new,
            saved_token: host.and_then(|h| h.access_token.clone()),
            token_cleared: !has_saved,
            label,
            token,
            app_id: host.and_then(|h| h.app_id.clone()),
            app_menu_open: false,
            max_concurrent,
            max_session,
            idle_minutes,
            check: EasAccountCheckState::Idle,
            _subscriptions: subscriptions,
        }
    }

    pub(super) fn resolved_token(
        &self,
        cx: &Context<'_, DevicePanel>,
    ) -> Option<SettingsSecretValue> {
        let entered = self.token.read(cx).value().trim().to_owned();
        if !entered.is_empty() {
            Some(SettingsSecretValue::String(entered))
        } else if self.token_cleared {
            Some(SettingsSecretValue::String(String::new()))
        } else {
            self.saved_token.clone()
        }
    }

    pub(super) fn validate(
        &self,
        cx: &Context<'_, DevicePanel>,
    ) -> Result<EasDeviceHostConfig, &'static str> {
        build_eas_host_config(
            self.id.clone(),
            self.label.read(cx).value().as_ref(),
            self.resolved_token(cx),
            self.app_id.clone(),
            self.max_concurrent.read(cx).value().as_ref(),
            self.max_session.read(cx).value().as_ref(),
            self.idle_minutes.read(cx).value().as_ref(),
        )
    }
}

/// State of `device.simlockIdentity` check (`SimlockDeviceHostEditor.tsx`).
#[derive(Clone, Debug)]
pub(super) enum SimlockIdentityCheckState {
    Idle,
    Checking,
    Accepted(DeviceSimlockIdentity),
    Failed(String),
}

/// Simlock host form state (`SimlockDeviceHostEditor.tsx`).
pub(super) struct SimlockHostForm {
    pub(super) id: String,
    pub(super) is_new: bool,
    pub(super) saved_token: Option<SettingsSecretValue>,
    pub(super) token_cleared: bool,
    pub(super) label: Entity<InputState>,
    pub(super) gateway_url: Entity<InputState>,
    pub(super) agent_token: Entity<InputState>,
    pub(super) max_leases: Entity<InputState>,
    pub(super) max_lease_minutes: Entity<InputState>,
    pub(super) check: SimlockIdentityCheckState,
    pub(super) _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SimlockHostForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SimlockHostForm")
            .field("id", &self.id)
            .field("is_new", &self.is_new)
            .finish_non_exhaustive()
    }
}

impl SimlockHostForm {
    pub(super) fn new(
        host: Option<&SimlockDeviceHostConfig>,
        window: &mut Window,
        cx: &mut Context<'_, DevicePanel>,
    ) -> Self {
        let is_new = host.is_none();
        let id = host.map_or_else(new_host_id, |h| h.id.clone());
        let label = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("Simlock");
            s.set_value(
                host.map_or_else(|| "Simlock".to_owned(), |h| h.label.clone()),
                window,
                cx,
            );
            s
        });
        let gateway_url = cx.new(|cx| {
            let mut s =
                InputState::new(window, cx).placeholder("https://gateway.example.ts.net:4700");
            if let Some(h) = host {
                s.set_value(h.gateway_url.clone(), window, cx);
            }
            s
        });
        let has_saved = host.is_some_and(|h| h.agent_token.is_some());
        let agent_token = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder(if has_saved {
                    "Saved token (enter to replace)"
                } else {
                    "Optional"
                })
        });
        let max_leases = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("2");
            s.set_value(
                host.and_then(|h| h.max_leases).unwrap_or(2).to_string(),
                window,
                cx,
            );
            s
        });
        let max_lease_minutes = cx.new(|cx| {
            let mut s = InputState::new(window, cx).placeholder("60");
            s.set_value(
                host.and_then(|h| h.max_lease_minutes)
                    .unwrap_or(60)
                    .to_string(),
                window,
                cx,
            );
            s
        });
        let subscriptions = subscribe_notify(
            [
                &label,
                &gateway_url,
                &agent_token,
                &max_leases,
                &max_lease_minutes,
            ],
            cx,
        );
        Self {
            id,
            is_new,
            saved_token: host.and_then(|h| h.agent_token.clone()),
            token_cleared: !has_saved,
            label,
            gateway_url,
            agent_token,
            max_leases,
            max_lease_minutes,
            check: SimlockIdentityCheckState::Idle,
            _subscriptions: subscriptions,
        }
    }

    pub(super) fn resolved_token(
        &self,
        cx: &Context<'_, DevicePanel>,
    ) -> Option<SettingsSecretValue> {
        let entered = self.agent_token.read(cx).value().trim().to_owned();
        if !entered.is_empty() {
            Some(SettingsSecretValue::String(entered))
        } else if self.token_cleared {
            Some(SettingsSecretValue::String(String::new()))
        } else {
            self.saved_token.clone()
        }
    }

    pub(super) fn validate(
        &self,
        cx: &Context<'_, DevicePanel>,
    ) -> Result<SimlockDeviceHostConfig, &'static str> {
        build_simlock_host_config(
            self.id.clone(),
            self.label.read(cx).value().as_ref(),
            self.gateway_url.read(cx).value().as_ref(),
            self.resolved_token(cx),
            self.max_leases.read(cx).value().as_ref(),
            self.max_lease_minutes.read(cx).value().as_ref(),
        )
    }
}

fn subscribe_notify<const N: usize>(
    inputs: [&Entity<InputState>; N],
    cx: &mut Context<'_, DevicePanel>,
) -> Vec<Subscription> {
    inputs
        .into_iter()
        .map(|input| {
            cx.subscribe(input, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            })
        })
        .collect()
}

fn new_host_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("host-{nanos:x}")
}

/// Renders the Hosts & Configuration view (Overview or one of the 3 host editors).
pub(super) fn render_host_config(
    panel: &DevicePanel,
    screen: &HostConfigScreen,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    let title = match screen {
        HostConfigScreen::Overview => "Device hosts & setup",
        HostConfigScreen::Ssh(form) if form.is_new => "Add device host",
        HostConfigScreen::Ssh(_) => "Edit device host",
        HostConfigScreen::Eas(form) if form.is_new => "Add Expo host",
        HostConfigScreen::Eas(_) => "Edit Expo host",
        HostConfigScreen::Simlock(form) if form.is_new => "Add Simlock host",
        HostConfigScreen::Simlock(_) => "Edit Simlock host",
    };

    let is_overview = matches!(screen, HostConfigScreen::Overview);
    let back_label = if is_overview { "Devices" } else { "Hosts" };

    let header = h_flex()
        .w_full()
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .border_b_1()
        .border_color(divider)
        .px(px(12.0))
        .py(px(8.0))
        .child(compact_outline_button(
            "device-hosts-back",
            Some("superhero/chevron-left.svg"),
            back_label,
            tokens,
            panel.host_saving,
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.host_error = None;
                    if is_overview {
                        p.host_config = None;
                    } else {
                        p.host_config = Some(HostConfigScreen::Overview);
                    }
                    cx.notify();
                });
            },
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(title),
        );

    let body: AnyElement = match screen {
        HostConfigScreen::Overview => render_hosts_overview(panel, cx),
        HostConfigScreen::Ssh(form) => render_ssh_form(panel, form, cx),
        HostConfigScreen::Eas(form) => render_eas_form(panel, form, cx),
        HostConfigScreen::Simlock(form) => render_simlock_form(panel, form, cx),
    };

    let mut column = v_flex().flex_1().min_h_0().size_full().child(header);
    if let Some(err) = panel.host_error.as_deref() {
        column = column.child(
            div()
                .w_full()
                .border_b_1()
                .border_color(divider)
                .bg(chrome::alpha(tokens.destructive, 0.08))
                .px(px(16.0))
                .py(px(8.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    } else if panel.host_config_loading {
        column = column.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.0))
                .border_b_1()
                .border_color(divider)
                .px(px(16.0))
                .py(px(8.0))
                .text_size(px(XS_TEXT_PX))
                .text_color(muted)
                .child(superhero_icon("superhero/spinner.svg", 12.0, muted))
                .child("Loading host settings…"),
        );
    }

    column
        .child(
            div()
                .id("device-hosts-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .px(px(20.0))
                .py(px(20.0))
                .child(div().mx_auto().w_full().max_w(px(576.0)).child(body)),
        )
        .into_any_element()
}

fn render_hosts_overview(panel: &DevicePanel, cx: &mut Context<'_, DevicePanel>) -> AnyElement {
    let tokens = &panel.tokens;
    let state = &panel.state;
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let enabled = state.host_status != DeviceHostStatus::Disabled;
    let readiness = device_hub_readiness(state);
    let hosts = all_hosts(state);

    // 1. Hub & agent controls card (`device.configure`).
    let config_card = v_flex()
        .w_full()
        .rounded(px(12.0))
        .border_1()
        .border_color(divider)
        .bg(to_hsla(tokens.shell_settings_card))
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .px(px(14.0))
                .py(px(12.0))
                .border_b_1()
                .border_color(divider)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child("Enable the device hub"),
                        )
                        .child(
                            div()
                                .text_size(px(XS_TEXT_PX))
                                .line_height(px(XS_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child("Start and inspect simulators and emulators on this environment."),
                        ),
                )
                .child(conn_switch(
                    "device-hosts-enable-hub",
                    enabled,
                    readiness.busy || panel.host_saving,
                    SwitchSize::Default,
                    tokens,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            let next = !enabled;
                            entity.update(cx, |p, cx| {
                                p.configure_device(
                                    None,
                                    Some(next),
                                    if next { None } else { Some(false) },
                                    None,
                                    cx,
                                );
                            });
                        }
                    },
                )),
        )
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .px(px(14.0))
                .py(px(12.0))
                .border_b_1()
                .border_color(divider)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(2.0))
                        .child(
                            div()
                                .text_size(px(UI_TEXT_PX))
                                .line_height(px(UI_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child("Allow agent control"),
                        )
                        .child(
                            div()
                                .text_size(px(XS_TEXT_PX))
                                .line_height(px(XS_LINE_HEIGHT_PX))
                                .text_color(muted)
                                .child("Let agent sessions open and drive local and remote devices."),
                        ),
                )
                .child(conn_switch(
                    "device-hosts-agent-access",
                    state.agent_access_enabled,
                    !enabled || readiness.busy || panel.host_saving,
                    SwitchSize::Default,
                    tokens,
                    {
                        let entity = entity.clone();
                        let next = !state.agent_access_enabled;
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.configure_device(None, None, Some(next), None, cx);
                            });
                        }
                    },
                )),
        )
        .child(
            h_flex()
                .w_full()
                .flex_wrap()
                .items_center()
                .gap(px(8.0))
                .px(px(14.0))
                .py(px(10.0))
                .child(compact_outline_button(
                    "device-hosts-run-wizard",
                    None,
                    "Setup wizard",
                    tokens,
                    false,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.host_config = None;
                                p.setup_dismissed = false;
                                p.force_setup_open = true;
                                p.setup_step = super::setup::SetupStep::Hub;
                                cx.notify();
                            });
                        }
                    },
                ))
                .when(state.supports_tool_inspection.unwrap_or(false), |row| {
                    let entity = entity.clone();
                    row.child(compact_outline_button(
                        "device-hosts-inspect-tools",
                        Some("superhero/refresh.svg"),
                        "Check tool versions",
                        tokens,
                        panel.list_pending,
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.inspect_tool_versions(cx));
                        },
                    ))
                })
                .when(state.supports_tool_update.unwrap_or(false), |row| {
                    let entity_hub = entity.clone();
                    let entity_agent = entity.clone();
                    row.child(compact_outline_button(
                        "device-hosts-update-hub",
                        None,
                        "Update hub",
                        tokens,
                        panel.list_pending,
                        move |_, _, cx| {
                            entity_hub.update(cx, |p, cx| {
                                p.update_device_tool(DeviceListInputUpdateTool::Hub, cx);
                            });
                        },
                    ))
                    .child(compact_outline_button(
                        "device-hosts-update-agent",
                        None,
                        "Update agent",
                        tokens,
                        panel.list_pending,
                        move |_, _, cx| {
                            entity_agent.update(cx, |p, cx| {
                                p.update_device_tool(DeviceListInputUpdateTool::Agent, cx);
                            });
                        },
                    ))
                }),
        );

    // 2. Device sources list + add source buttons (`DeviceSourcesSettings.tsx`).
    let mut add_buttons =
        h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(6.0))
            .child(compact_outline_button(
                "device-add-ssh-host",
                Some("superhero/add.svg"),
                "Machine over SSH",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, window, cx| {
                        entity.update(cx, |p, cx| {
                            p.host_error = None;
                            let form = SshHostForm::new(None, window, cx);
                            p.host_config = Some(HostConfigScreen::Ssh(form));
                            cx.notify();
                        });
                    }
                },
            ));
    if state.supports_eas_hosts.unwrap_or(true) {
        add_buttons = add_buttons.child(compact_outline_button(
            "device-add-eas-host",
            Some("superhero/add.svg"),
            "Expo Simulators",
            tokens,
            panel.host_saving,
            {
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |p, cx| {
                        p.host_error = None;
                        let form = EasHostForm::new(None, window, cx);
                        p.host_config = Some(HostConfigScreen::Eas(form));
                        cx.notify();
                    });
                }
            },
        ));
    }
    if state.supports_simlock_hosts.unwrap_or(false) || panel.saved_hosts.simlock_enabled {
        add_buttons = add_buttons.child(compact_outline_button(
            "device-add-simlock-host",
            Some("superhero/add.svg"),
            "Simlock pool",
            tokens,
            panel.host_saving,
            {
                let entity = entity.clone();
                move |_, window, cx| {
                    entity.update(cx, |p, cx| {
                        p.host_error = None;
                        let form = SimlockHostForm::new(None, window, cx);
                        p.host_config = Some(HostConfigScreen::Simlock(form));
                        cx.notify();
                    });
                }
            },
        ));
    }

    let mut sources_list = v_flex()
        .w_full()
        .rounded(px(12.0))
        .border_1()
        .border_color(divider)
        .bg(to_hsla(tokens.shell_settings_card));

    // Local simulators row + configured SSH / Expo / Simlock rows.
    let local_host = hosts.iter().find(|h| h.kind == HostKind::Local);
    sources_list = sources_list.child(render_host_row(
        tokens,
        "local",
        "Local simulators",
        None,
        "Simulators and emulators installed on this environment's machine.",
        local_host.map(|h| h.platforms),
        local_host.and_then(|h| state.host_statuses.get(h.id)),
        false,
        None,
    ));

    for host in &panel.saved_hosts.ssh_hosts {
        let live = hosts.iter().find(|h| h.id == host.id);
        let status = state.host_statuses.get(&host.id);
        let host_for_edit = host.clone();
        let host_id_remove = host.id.clone();
        let actions = h_flex()
            .gap(px(6.0))
            .child(outline_xs_button(
                SharedString::from(format!("device-edit-ssh-{}", host.id)),
                "Edit",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, window, cx| {
                        let cfg = host_for_edit.clone();
                        entity.update(cx, |p, cx| {
                            p.host_error = None;
                            let form = SshHostForm::new(Some(&cfg), window, cx);
                            p.host_config = Some(HostConfigScreen::Ssh(form));
                            cx.notify();
                        });
                    }
                },
            ))
            .child(outline_xs_button(
                SharedString::from(format!("device-remove-ssh-{}", host.id)),
                "Remove",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        let id = host_id_remove.clone();
                        entity.update(cx, |p, cx| p.remove_ssh_host(&id, cx));
                    }
                },
            ))
            .into_any_element();
        sources_list = sources_list.child(render_host_row(
            tokens,
            &host.id,
            &host.label,
            HostKind::Ssh.badge_label(),
            &host.target,
            live.map(|h| h.platforms),
            status,
            true,
            Some(actions),
        ));
    }

    for host in &panel.saved_hosts.eas_hosts {
        let live = hosts.iter().find(|h| h.id == host.id);
        let status = state.host_statuses.get(&host.id);
        let desc = format!(
            "Up to {} sessions at once, each stopped after {} min or {} idle min",
            host.max_concurrent_sessions.unwrap_or(2),
            host.max_session_minutes.unwrap_or(30),
            host.idle_minutes.unwrap_or(10),
        );
        let host_for_edit = host.clone();
        let host_id_remove = host.id.clone();
        let actions = h_flex()
            .gap(px(6.0))
            .child(outline_xs_button(
                SharedString::from(format!("device-edit-eas-{}", host.id)),
                "Edit",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, window, cx| {
                        let cfg = host_for_edit.clone();
                        entity.update(cx, |p, cx| {
                            p.host_error = None;
                            let form = EasHostForm::new(Some(&cfg), window, cx);
                            p.host_config = Some(HostConfigScreen::Eas(form));
                            cx.notify();
                        });
                    }
                },
            ))
            .child(outline_xs_button(
                SharedString::from(format!("device-remove-eas-{}", host.id)),
                "Remove",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        let id = host_id_remove.clone();
                        entity.update(cx, |p, cx| p.remove_eas_host(&id, cx));
                    }
                },
            ))
            .into_any_element();
        sources_list = sources_list.child(render_host_row(
            tokens,
            &host.id,
            &host.label,
            HostKind::Eas.badge_label(),
            &desc,
            live.map(|h| h.platforms),
            status,
            true,
            Some(actions),
        ));
    }

    for host in &panel.saved_hosts.simlock_hosts {
        let live = hosts.iter().find(|h| h.id == host.id);
        let status = state.host_statuses.get(&host.id);
        let origin = host
            .gateway_url
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        let desc = format!(
            "{origin} · Up to {} devices at once, each released after {} min",
            host.max_leases.unwrap_or(2),
            host.max_lease_minutes.unwrap_or(60),
        );
        let host_for_edit = host.clone();
        let host_id_remove = host.id.clone();
        let actions = h_flex()
            .gap(px(6.0))
            .child(outline_xs_button(
                SharedString::from(format!("device-edit-simlock-{}", host.id)),
                "Edit",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, window, cx| {
                        let cfg = host_for_edit.clone();
                        entity.update(cx, |p, cx| {
                            p.host_error = None;
                            let form = SimlockHostForm::new(Some(&cfg), window, cx);
                            p.host_config = Some(HostConfigScreen::Simlock(form));
                            cx.notify();
                        });
                    }
                },
            ))
            .child(outline_xs_button(
                SharedString::from(format!("device-remove-simlock-{}", host.id)),
                "Remove",
                tokens,
                panel.host_saving,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        let id = host_id_remove.clone();
                        entity.update(cx, |p, cx| p.remove_simlock_host(&id, cx));
                    }
                },
            ))
            .into_any_element();
        sources_list = sources_list.child(render_host_row(
            tokens,
            &host.id,
            &host.label,
            HostKind::Simlock.badge_label(),
            &desc,
            live.map(|h| h.platforms),
            status,
            true,
            Some(actions),
        ));
    }

    let mut stack = v_flex().w_full().gap(px(20.0)).child(config_card).child(
        v_flex()
            .w_full()
            .gap(px(10.0))
            .child(
                h_flex()
                    .w_full()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .child(
                        div()
                            .text_size(px(SM_TEXT_PX))
                            .line_height(px(SM_LINE_HEIGHT_PX))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child("Device sources"),
                    )
                    .child(add_buttons),
            )
            .child(sources_list),
    );

    if let Some(local) = local_host
        && (local.tools.is_some() || local.tool_inspection_error.is_some())
    {
        stack = stack.child(
            v_flex()
                .w_full()
                .gap(px(8.0))
                .child(
                    div()
                        .text_size(px(SM_TEXT_PX))
                        .line_height(px(SM_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child("Device tools"),
                )
                .child(tool_versions_detail(
                    tokens,
                    local.tools,
                    local.tool_inspection_error,
                )),
        );
    }

    stack.into_any_element()
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders one DeviceSourceRow with title, badge, status, platforms, and actions"
)]
fn render_host_row(
    tokens: &conn_theme::Tokens,
    _id: &str,
    title: &str,
    badge: Option<&'static str>,
    description: &str,
    platforms: Option<&[DevicePlatformAvailability]>,
    status: Option<&conn_contract::DeviceHostStatusesValue>,
    border_top: bool,
    actions: Option<AnyElement>,
) -> Div {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let mut title_row = h_flex().items_center().gap(px(8.0)).child(
        div()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(title.to_owned()),
    );
    if let Some(badge) = badge {
        title_row = title_row.child(
            div()
                .rounded(px(4.0))
                .bg(chrome::alpha(tokens.foreground, 0.07))
                .px(px(6.0))
                .py(px(1.0))
                .text_size(px(11.0))
                .line_height(px(14.0))
                .text_color(muted)
                .child(badge),
        );
    }
    if let Some(st) = status {
        let (label, color) = match st.status {
            DeviceHostStatus::Ready => ("Ready", to_hsla(tokens.success)),
            DeviceHostStatus::Installing | DeviceHostStatus::Starting => ("Starting", muted),
            DeviceHostStatus::Failed => ("Failed", to_hsla(tokens.destructive)),
            DeviceHostStatus::Disabled => ("Disabled", muted),
            DeviceHostStatus::Idle => ("Idle", muted),
        };
        title_row = title_row.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(color)
                .child(label),
        );
    }

    let mut left = v_flex()
        .flex_1()
        .min_w_0()
        .gap(px(4.0))
        .child(title_row)
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(description.to_owned()),
        );
    if let Some(platforms) = platforms
        && !platforms.is_empty()
    {
        left = left.child(device_host_availability(tokens, platforms));
    }
    if let Some(detail) = status.and_then(|s| s.detail.as_deref()) {
        left = left.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(
                    if status.is_some_and(|s| s.status == DeviceHostStatus::Failed) {
                        to_hsla(tokens.destructive)
                    } else {
                        muted
                    },
                )
                .child(detail.to_owned()),
        );
    }

    let mut row = h_flex()
        .w_full()
        .items_start()
        .justify_between()
        .gap(px(12.0))
        .px(px(14.0))
        .py(px(12.0))
        .when(border_top, |el| {
            el.border_t_1().border_color(to_hsla(tokens.shell_divider))
        })
        .child(left);
    if let Some(actions) = actions {
        row = row.child(actions);
    }
    row
}

fn render_ssh_form(
    panel: &DevicePanel,
    form: &SshHostForm,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let validation = form.validate(cx);
    let checking = matches!(form.check, SshCheckState::Checking);
    let busy = panel.host_saving;

    let mut options = v_flex().w_full().gap(px(8.0)).child(
        div()
            .id("device-ssh-options-toggle")
            .cursor_pointer()
            .text_size(px(UI_TEXT_PX))
            .line_height(px(UI_LINE_HEIGHT_PX))
            .text_color(muted)
            .on_click({
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        if let Some(HostConfigScreen::Ssh(f)) = &mut p.host_config {
                            f.show_options = !f.show_options;
                            cx.notify();
                        }
                    });
                }
            })
            .child(if form.show_options {
                "▾ SSH options"
            } else {
                "▸ SSH options"
            }),
    );
    if form.show_options {
        options = options
            .child(
                h_flex()
                    .w_full()
                    .gap(px(12.0))
                    .child(div().flex_1().min_w_0().child(form_field(
                        "Identity file",
                        tokens,
                        compact_input(&form.identity_file, true, tokens, busy),
                    )))
                    .child(div().w(px(108.0)).flex_shrink_0().child(form_field(
                        "Port",
                        tokens,
                        compact_input(&form.port, true, tokens, busy),
                    ))),
            )
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Optional. Resolved separately on each environment."),
            );
    }

    let check_summary = match &form.check {
        SshCheckState::Idle => "Check access before saving",
        SshCheckState::Checking => "Checking environments…",
        SshCheckState::Local => "Already available locally",
        SshCheckState::Connected(_) => "Connection checks passed",
        SshCheckState::Failed(_) => "Connection check failed",
    };

    let mut check_box = v_flex()
        .w_full()
        .rounded(px(8.0))
        .border_1()
        .border_color(divider)
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .px(px(12.0))
                .py(px(10.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(if matches!(form.check, SshCheckState::Failed(_)) {
                            to_hsla(tokens.destructive)
                        } else {
                            muted
                        })
                        .child(check_summary),
                )
                .child(outline_sm_button(
                    "device-ssh-test-connection",
                    checking.then_some("superhero/spinner.svg"),
                    "Test connection",
                    tokens,
                    busy || checking || validation.is_err(),
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.test_ssh_host(cx));
                        }
                    },
                )),
        );

    match &form.check {
        SshCheckState::Connected(platforms) => {
            check_box = check_box.child(
                div()
                    .w_full()
                    .border_t_1()
                    .border_color(divider)
                    .px(px(12.0))
                    .py(px(10.0))
                    .child(device_host_availability(tokens, platforms)),
            );
        }
        SshCheckState::Local => {
            check_box = check_box.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(6.0))
                    .border_t_1()
                    .border_color(divider)
                    .px(px(12.0))
                    .py(px(10.0))
                    .text_size(px(XS_TEXT_PX))
                    .text_color(muted)
                    .child(superhero_icon("superhero/desktop.svg", 12.0, muted))
                    .child("Already available locally"),
            );
        }
        SshCheckState::Failed(err) => {
            check_box = check_box.child(
                div()
                    .w_full()
                    .border_t_1()
                    .border_color(divider)
                    .px(px(12.0))
                    .py(px(10.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(to_hsla(tokens.destructive))
                    .child(err.clone()),
            );
        }
        SshCheckState::Idle | SshCheckState::Checking => {}
    }

    v_flex()
        .w_full()
        .gap(px(14.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("Connect to a Mac or Linux host over SSH. Hosts on the same machine are skipped."),
        )
        .child(form_field(
            "Name",
            tokens,
            compact_input(&form.label, false, tokens, busy),
        ))
        .child(form_field(
            "SSH target",
            tokens,
            compact_input(&form.target, true, tokens, busy),
        ))
        .child(options)
        .child(check_box)
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .pt(px(4.0))
                .child(ghost_sm_button(
                    "device-ssh-cancel",
                    "Cancel",
                    tokens,
                    busy,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.host_config = Some(HostConfigScreen::Overview);
                                cx.notify();
                            });
                        }
                    },
                ))
                .child(primary_sm_button(
                    "device-ssh-save",
                    busy.then_some("superhero/spinner.svg"),
                    "Save host",
                    tokens,
                    busy || checking || validation.is_err(),
                    {
                        let entity = entity;
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.save_ssh_host(cx));
                        }
                    },
                )),
        )
        .into_any_element()
}

fn render_eas_form(
    panel: &DevicePanel,
    form: &EasHostForm,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let validation = form.validate(cx);
    let checking = matches!(form.check, EasAccountCheckState::Checking);
    let busy = panel.host_saving;

    let account_status_text = match &form.check {
        EasAccountCheckState::Idle => {
            "Check the Expo account before choosing a project.".to_owned()
        }
        EasAccountCheckState::Checking => "Checking the Expo account…".to_owned(),
        EasAccountCheckState::SignedIn(account) => eas_account_message(account),
        EasAccountCheckState::Failed(err) => err.clone(),
    };
    let apps = match &form.check {
        EasAccountCheckState::SignedIn(account) => account.apps.as_slice(),
        _ => &[],
    };
    let selected_app_label = match form.app_id.as_deref() {
        None => "From the thread's project".to_owned(),
        Some(id) => apps
            .iter()
            .find(|app| app.id == id)
            .map_or_else(|| id.to_owned(), |app| app.full_name.clone()),
    };

    let mut app_anchor = div().relative().child(select_trigger_xs(
        "device-eas-app-select",
        selected_app_label.into(),
        form.app_id.is_none(),
        260.0,
        tokens,
        busy,
        {
            let entity = entity.clone();
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    if let Some(HostConfigScreen::Eas(f)) = &mut p.host_config {
                        f.app_menu_open = !f.app_menu_open;
                        cx.notify();
                    }
                });
            }
        },
    ));
    if form.app_menu_open {
        let mut entries = vec![MenuEntry::Row(MenuRow {
            id: "device-eas-app-thread".into(),
            label: "From the thread's project".into(),
            mono: false,
            checked: form.app_id.is_none(),
            on_select: Box::new({
                let entity = entity.clone();
                move |_, cx| {
                    entity.update(cx, |p, cx| {
                        if let Some(HostConfigScreen::Eas(f)) = &mut p.host_config {
                            f.app_id = None;
                            f.app_menu_open = false;
                            cx.notify();
                        }
                    });
                }
            }),
        })];
        for app in apps {
            let id = app.id.clone();
            let entity = entity.clone();
            entries.push(MenuEntry::Row(MenuRow {
                id: SharedString::from(format!("device-eas-app-{id}")),
                label: app.full_name.clone().into(),
                mono: false,
                checked: form.app_id.as_deref() == Some(id.as_str()),
                on_select: Box::new(move |_, cx| {
                    let id = id.clone();
                    entity.update(cx, |p, cx| {
                        if let Some(HostConfigScreen::Eas(f)) = &mut p.host_config {
                            f.app_id = Some(id);
                            f.app_menu_open = false;
                            cx.notify();
                        }
                    });
                }),
            }));
        }
        app_anchor = app_anchor.child(simple_select_menu(
            "device-eas-app-menu",
            tokens,
            entries,
            MenuAnchor::BelowStart(XS_BUTTON_HEIGHT_PX),
        ));
    }

    let mut form_col = v_flex()
        .w_full()
        .gap(px(14.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("The environment's server signs in to Expo and starts the sessions. Without a token here it uses EXPO_TOKEN, then its eas login."),
        )
        .child(form_field(
            "Name",
            tokens,
            compact_input(&form.label, false, tokens, busy),
        ))
        .child(form_field(
            "Expo access token",
            tokens,
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.0))
                .child(compact_input(&form.token, true, tokens, busy))
                .when(!form.token_cleared || !form.token.read(cx).value().is_empty(), |row| {
                    let entity = entity.clone();
                    row.child(chrome::icon_button(
                        "device-eas-clear-token",
                        "superhero/close.svg",
                        tokens,
                        busy,
                        move |_, window, cx| {
                            entity.update(cx, |p, cx| {
                                if let Some(HostConfigScreen::Eas(f)) = &mut p.host_config {
                                    f.token_cleared = true;
                                    f.check = EasAccountCheckState::Idle;
                                    f.token.update(cx, |s, cx| {
                                        s.set_value(String::new(), window, cx);
                                        s.set_placeholder("Optional", window, cx);
                                    });
                                    cx.notify();
                                }
                            });
                        },
                    ))
                }),
        ))
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(divider)
                .px(px(12.0))
                .py(px(10.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(if matches!(form.check, EasAccountCheckState::Failed(_)) {
                            to_hsla(tokens.destructive)
                        } else {
                            muted
                        })
                        .child(account_status_text),
                )
                .child(outline_sm_button(
                    "device-eas-check-account",
                    checking.then_some("superhero/spinner.svg"),
                    "Check account",
                    tokens,
                    busy || checking,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.check_eas_account(cx));
                        }
                    },
                )),
        )
        .child(
            v_flex()
                .w_full()
                .gap(px(6.0))
                .child(form_field("Expo project", tokens, app_anchor))
                .child(
                    div()
                        .text_size(px(UI_TEXT_PX))
                        .line_height(px(UI_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child("Sessions bill the project's Expo account. \"From the thread's project\" reads extra.eas.projectId from the project's app config."),
                ),
        )
        .child(
            h_flex()
                .w_full()
                .gap(px(12.0))
                .child(div().flex_1().min_w_0().child(form_field(
                    "Sessions at once",
                    tokens,
                    compact_input(&form.max_concurrent, true, tokens, busy),
                )))
                .child(div().flex_1().min_w_0().child(form_field(
                    "Session minutes",
                    tokens,
                    compact_input(&form.max_session, true, tokens, busy),
                )))
                .child(div().flex_1().min_w_0().child(form_field(
                    "Idle minutes",
                    tokens,
                    compact_input(&form.idle_minutes, true, tokens, busy),
                ))),
        )
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(if form.is_new {
                    "Expo Simulators needs a paid Expo account. A session runs for up to 115 minutes and stops early when it is idle for the idle minutes, so idle minutes must be less than session minutes."
                } else {
                    "Expo Simulators needs a paid Expo account. A session runs for up to 115 minutes and stops early when it is idle for the idle minutes, so idle minutes must be less than session minutes. Saving restarts this host and stops its running sessions."
                }),
        );

    if let Err(problem) = &validation {
        form_col = form_col.child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(*problem),
        );
    }

    form_col
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .pt(px(4.0))
                .child(ghost_sm_button(
                    "device-eas-cancel",
                    "Cancel",
                    tokens,
                    busy,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.host_config = Some(HostConfigScreen::Overview);
                                cx.notify();
                            });
                        }
                    },
                ))
                .child(primary_sm_button(
                    "device-eas-save",
                    busy.then_some("superhero/spinner.svg"),
                    "Save host",
                    tokens,
                    busy || validation.is_err(),
                    {
                        let entity = entity;
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.save_eas_host(cx));
                        }
                    },
                )),
        )
        .into_any_element()
}

fn render_simlock_form(
    panel: &DevicePanel,
    form: &SimlockHostForm,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let validation = form.validate(cx);
    let checking = matches!(form.check, SimlockIdentityCheckState::Checking);
    let busy = panel.host_saving;

    let identity_status = match &form.check {
        SimlockIdentityCheckState::Idle => "Check gateway identity before saving.".to_owned(),
        SimlockIdentityCheckState::Checking => "Checking…".to_owned(),
        SimlockIdentityCheckState::Accepted(identity) => simlock_identity_message(identity),
        SimlockIdentityCheckState::Failed(err) => err.clone(),
    };

    let mut form_col = v_flex()
        .w_full()
        .gap(px(14.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child("The environment's server leases devices from your Simlock gateway and releases them when they close."),
        )
        .child(form_field(
            "Name",
            tokens,
            compact_input(&form.label, false, tokens, busy),
        ))
        .child(form_field(
            "Gateway URL",
            tokens,
            compact_input(&form.gateway_url, true, tokens, busy),
        ))
        .child(form_field(
            "Agent token",
            tokens,
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.0))
                .child(compact_input(&form.agent_token, true, tokens, busy))
                .when(
                    !form.token_cleared || !form.agent_token.read(cx).value().is_empty(),
                    |row| {
                        let entity = entity.clone();
                        row.child(chrome::icon_button(
                            "device-simlock-clear-token",
                            "superhero/close.svg",
                            tokens,
                            busy,
                            move |_, window, cx| {
                                entity.update(cx, |p, cx| {
                                    if let Some(HostConfigScreen::Simlock(f)) = &mut p.host_config {
                                        f.token_cleared = true;
                                        f.check = SimlockIdentityCheckState::Idle;
                                        f.agent_token.update(cx, |s, cx| {
                                            s.set_value(String::new(), window, cx);
                                            s.set_placeholder("Optional", window, cx);
                                        });
                                        cx.notify();
                                    }
                                });
                            },
                        ))
                    },
                ),
        ))
        .child(
            h_flex()
                .w_full()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .rounded(px(8.0))
                .border_1()
                .border_color(divider)
                .px(px(12.0))
                .py(px(10.0))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(if matches!(form.check, SimlockIdentityCheckState::Failed(_)) {
                            to_hsla(tokens.destructive)
                        } else {
                            muted
                        })
                        .child(identity_status),
                )
                .child(outline_sm_button(
                    "device-simlock-check-identity",
                    checking.then_some("superhero/spinner.svg"),
                    "Check identity",
                    tokens,
                    busy || checking,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.check_simlock_identity(cx));
                        }
                    },
                )),
        )
        .child(
            h_flex()
                .w_full()
                .gap(px(12.0))
                .child(div().flex_1().min_w_0().child(form_field(
                    "Devices at once",
                    tokens,
                    compact_input(&form.max_leases, true, tokens, busy),
                )))
                .child(div().flex_1().min_w_0().child(form_field(
                    "Lease minutes",
                    tokens,
                    compact_input(&form.max_lease_minutes, true, tokens, busy),
                ))),
        )
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(if form.is_new {
                    "A lease ends after the lease minutes even while in use."
                } else {
                    "A lease ends after the lease minutes even while in use. Saving restarts this host, which releases its devices."
                }),
        );

    if let Err(problem) = &validation
        && !form.gateway_url.read(cx).value().trim().is_empty()
    {
        form_col = form_col.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(*problem),
        );
    }

    form_col
        .child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .pt(px(4.0))
                .child(ghost_sm_button(
                    "device-simlock-cancel",
                    "Cancel",
                    tokens,
                    busy,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.host_config = Some(HostConfigScreen::Overview);
                                cx.notify();
                            });
                        }
                    },
                ))
                .child(primary_sm_button(
                    "device-simlock-save",
                    busy.then_some("superhero/spinner.svg"),
                    "Save host",
                    tokens,
                    busy || validation.is_err(),
                    {
                        let entity = entity;
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.save_simlock_host(cx));
                        }
                    },
                )),
        )
        .into_any_element()
}
