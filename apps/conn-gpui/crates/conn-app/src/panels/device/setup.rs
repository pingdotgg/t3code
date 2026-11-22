//! Three-step Device onboarding wizard matching Conn's `DeviceSetup.tsx` + `WizardPopup`.

use conn_contract::{DeviceHostStatus, DevicePlatform};
use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Div, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, Styled, div, px,
};

use super::super::chrome::{self, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use super::super::color::to_hsla;
use super::super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::DevicePanel;
use super::logic::{
    HostKind, PlatformSetupStatus, all_hosts, device_hub_readiness, host_diagnostics,
    platform_setup_status,
};
use super::ui::{
    PILL_RADIUS_PX, SM_LINE_HEIGHT_PX, SM_TEXT_PX, SwitchSize, compact_outline_button, conn_switch,
    device_host_updates, outline_sm_button, primary_sm_button,
};

/// Active step in the 3-step `DeviceSetup` wizard.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum SetupStep {
    #[default]
    Hub = 0,
    Simulators = 1,
    AgentAccess = 2,
}

impl SetupStep {
    const ALL: [(Self, &'static str); 3] = [
        (Self::Hub, "Device hub"),
        (Self::Simulators, "Simulators"),
        (Self::AgentAccess, "Agent access"),
    ];

    #[must_use]
    pub(super) const fn index(self) -> usize {
        self as usize
    }

    #[must_use]
    pub(super) const fn prev(self) -> Self {
        match self {
            Self::Hub | Self::Simulators => Self::Hub,
            Self::AgentAccess => Self::Simulators,
        }
    }

    #[must_use]
    pub(super) const fn next(self) -> Self {
        match self {
            Self::Hub => Self::Simulators,
            Self::Simulators | Self::AgentAccess => Self::AgentAccess,
        }
    }
}

/// Which setup action is currently in flight (`pending` in `DeviceSetup.tsx`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SetupPending {
    Hub,
    Check,
    Agent,
    Complete,
}

/// Renders Conn's `DeviceSetup` wizard centered inside the Device panel.
pub(super) fn render_setup_wizard(
    panel: &DevicePanel,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let state = &panel.state;
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);

    let step = panel.setup_step;
    let pending = panel.setup_pending;
    let enabled = state.host_status != DeviceHostStatus::Disabled;
    let readiness = device_hub_readiness(state);
    let hosts = all_hosts(state);
    let local_platforms_unavailable = hosts.iter().any(|host| {
        host.kind == HostKind::Local && !host.platforms.iter().any(|platform| platform.available)
    });

    // `WizardSteps` 3-column pill step indicator.
    let mut steps_bar = h_flex()
        .w_full()
        .gap(px(4.0))
        .rounded(px(12.0))
        .bg(chrome::alpha(tokens.foreground, 0.04))
        .border_1()
        .border_color(chrome::alpha(tokens.foreground, 0.06))
        .p(px(4.0));

    for (candidate, label) in SetupStep::ALL {
        let idx = candidate.index();
        let current = candidate == step;
        let completed = idx < step.index();
        let disabled = readiness.busy || pending.is_some() || idx > step.index();
        let badge_bg = if completed {
            to_hsla(tokens.primary)
        } else if current {
            chrome::alpha(tokens.primary, 0.12)
        } else {
            chrome::alpha(tokens.foreground, 0.05)
        };
        let badge_fg = if completed {
            to_hsla(tokens.primary_foreground)
        } else if current {
            to_hsla(tokens.primary)
        } else {
            muted
        };

        let badge = div()
            .flex()
            .flex_shrink_0()
            .size(px(20.0))
            .items_center()
            .justify_center()
            .rounded(px(PILL_RADIUS_PX))
            .bg(badge_bg)
            .text_size(px(XS_TEXT_PX))
            .font_weight(FontWeight::MEDIUM)
            .text_color(badge_fg)
            .child(if completed {
                superhero_icon("superhero/check.svg", 12.0, badge_fg).into_any_element()
            } else {
                (idx + 1).to_string().into_any_element()
            });

        let mut step_btn = h_flex()
            .id(SharedString::from(format!("device-setup-step-{idx}")))
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(8.0))
            .rounded(px(8.0))
            .px(px(10.0))
            .py(px(8.0))
            .when(current, |el| {
                el.bg(to_hsla(tokens.shell_card))
                    .border_1()
                    .border_color(chrome::alpha(tokens.foreground, 0.06))
            })
            .child(badge)
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if current { fg } else { muted })
                    .child(label),
            );
        if !disabled {
            let entity = entity.clone();
            let hover_bg = to_hsla(tokens.shell_card);
            step_btn = step_btn
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.setup_step = candidate;
                        cx.notify();
                    });
                });
        }
        steps_bar = steps_bar.child(step_btn);
    }

    // `WizardHeader`.
    let header = v_flex()
        .w_full()
        .gap(px(8.0))
        .px(px(24.0))
        .pt(px(20.0))
        .pb(px(16.0))
        .child(
            div()
                .text_size(px(16.0))
                .line_height(px(24.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(fg)
                .child("Set up devices"),
        )
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(
                    "Review what runs on this environment before using simulators and emulators.",
                ),
        )
        .child(div().pt(px(4.0)).child(steps_bar));

    // `WizardPanel`.
    let mut panel_body = v_flex()
        .w_full()
        .gap(px(16.0))
        .bg(chrome::alpha(tokens.foreground, 0.02))
        .border_t_1()
        .border_b_1()
        .border_color(divider)
        .px(px(24.0))
        .py(px(20.0));

    if let Some(updates) = device_host_updates(
        tokens,
        &hosts,
        &state.host_statuses,
        state.supports_host_retry.unwrap_or(false),
        panel.retrying_host_id.as_deref(),
        {
            let entity = entity.clone();
            move |host_id, _, cx| {
                entity.update(cx, |p, cx| p.retry_host(host_id, cx));
            }
        },
    ) {
        panel_body = panel_body.child(updates);
    }

    if step == SetupStep::Hub {
        let entity_toggle = entity.clone();
        let hub_pending = pending == Some(SetupPending::Hub)
            || (readiness.busy && pending != Some(SetupPending::Agent));
        let mut hub_section = v_flex()
            .w_full()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("Enable the device hub"),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(SM_TEXT_PX))
                            .line_height(px(SM_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Enable this environment to open simulators and emulators, whether they run here or on a remote device host."),
                    )
                    .child(conn_switch(
                        "device-setup-enable-hub",
                        enabled,
                        readiness.busy || pending.is_some(),
                        SwitchSize::Default,
                        tokens,
                        move |_, _, cx| {
                            let next = !enabled;
                            entity_toggle.update(cx, |p, cx| {
                                p.configure_device(
                                    Some(SetupPending::Hub),
                                    Some(next),
                                    if next { None } else { Some(false) },
                                    None,
                                    cx,
                                );
                            });
                        },
                    )),
            );

        if let Some(status_el) =
            render_hub_setup_status(tokens, state.host_status, readiness.ready, hub_pending)
        {
            hub_section = hub_section.child(status_el);
        }
        panel_body = panel_body.child(hub_section);
    }

    if step == SetupStep::Simulators
        || (step == SetupStep::Hub && enabled && local_platforms_unavailable)
    {
        let entity_check = entity.clone();
        let checking = pending == Some(SetupPending::Check);
        let diagnostics = host_diagnostics(state);
        let mut sim_section = v_flex()
            .w_full()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("Check simulator support"),
            )
            .child(render_platform_status_card(
                tokens,
                "iOS",
                &platform_setup_status(state, DevicePlatform::Ios),
            ))
            .child(render_platform_status_card(
                tokens,
                "Android",
                &platform_setup_status(state, DevicePlatform::Android),
            ));

        if !diagnostics.is_empty() {
            let mut diag_box = v_flex()
                .w_full()
                .gap(px(4.0))
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(muted);
            for diag in diagnostics {
                diag_box = diag_box.child(format!("{}: {}", diag.label, diag.detail));
            }
            sim_section = sim_section.child(diag_box);
        }

        sim_section = sim_section
            .child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("You can use either platform. Fixing a missing platform does not block the other one."),
            )
            .child(h_flex().child(compact_outline_button(
                "device-setup-check-again",
                checking.then_some("superhero/spinner.svg"),
                if checking { "Checking…" } else { "Check again" },
                tokens,
                !enabled || readiness.busy || pending.is_some(),
                move |_, _, cx| {
                    entity_check.update(cx, |p, cx| {
                        p.setup_pending = Some(SetupPending::Check);
                        p.refresh_devices_for_setup(cx);
                    });
                },
            )));
        panel_body = panel_body.child(sim_section);
    }

    if step == SetupStep::AgentAccess {
        let entity_agent = entity.clone();
        let agent_enabled = state.agent_access_enabled;
        let agent_pending = pending == Some(SetupPending::Agent);
        let agent_ready = agent_enabled
            && readiness.ready
            && hosts.iter().any(|host| host.agent_device_installed);

        let mut agent_section = v_flex()
            .w_full()
            .gap(px(12.0))
            .child(
                div()
                    .text_size(px(SM_TEXT_PX))
                    .line_height(px(SM_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("Allow agent control"),
            )
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .justify_between()
                    .gap(px(16.0))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(SM_TEXT_PX))
                            .line_height(px(SM_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Allow new agent sessions in this environment to start and control local and remote devices, with required tools set up automatically."),
                    )
                    .child(conn_switch(
                        "device-setup-agent-access",
                        agent_enabled,
                        !enabled || readiness.busy || pending.is_some(),
                        SwitchSize::Default,
                        tokens,
                        move |_, _, cx| {
                            entity_agent.update(cx, |p, cx| {
                                p.configure_device(
                                    Some(SetupPending::Agent),
                                    None,
                                    Some(!agent_enabled),
                                    None,
                                    cx,
                                );
                            });
                        },
                    )),
            );

        if agent_pending {
            let label = match state.host_status {
                DeviceHostStatus::Installing => "Installing agent tools…",
                DeviceHostStatus::Starting => "Starting agent tools…",
                _ => "Updating agent access…",
            };
            agent_section = agent_section.child(
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(superhero_icon("superhero/spinner.svg", 12.0, muted))
                    .child(label),
            );
        } else if agent_ready {
            agent_section = agent_section.child(
                h_flex()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(superhero_icon(
                        "superhero/check.svg",
                        12.0,
                        to_hsla(tokens.success),
                    ))
                    .child("Agent tools are ready."),
            );
        }

        agent_section = agent_section.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(
                    "Leave this off to keep manual device controls without giving agents access.",
                ),
        );
        panel_body = panel_body.child(agent_section);
    }

    if state.host_status == DeviceHostStatus::Failed
        && let Some(detail) = state.host_status_detail.as_deref()
    {
        panel_body = panel_body.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(detail.to_owned()),
        );
    }
    if let Some(err) = panel.setup_error.as_deref() {
        panel_body = panel_body.child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    }

    // `WizardFooter`.
    let left_button = if step == SetupStep::Hub {
        let entity = entity.clone();
        outline_sm_button(
            "device-setup-cancel",
            None,
            "Cancel",
            tokens,
            pending.is_some(),
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.setup_dismissed = true;
                    p.force_setup_open = false;
                    cx.notify();
                });
            },
        )
    } else {
        let entity = entity.clone();
        outline_sm_button(
            "device-setup-back",
            None,
            "Back",
            tokens,
            readiness.busy || pending.is_some(),
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.setup_step = p.setup_step.prev();
                    cx.notify();
                });
            },
        )
    };

    let right_button = if step != SetupStep::AgentAccess {
        primary_sm_button(
            "device-setup-continue",
            None,
            "Continue",
            tokens,
            !readiness.ready || pending.is_some(),
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.setup_step = p.setup_step.next();
                    cx.notify();
                });
            },
        )
    } else {
        let saving = pending == Some(SetupPending::Complete);
        primary_sm_button(
            "device-setup-done",
            None,
            if saving { "Saving…" } else { "Done" },
            tokens,
            !readiness.ready || pending.is_some(),
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.configure_device(Some(SetupPending::Complete), None, None, Some(true), cx);
                });
            },
        )
    };

    let footer = h_flex()
        .w_full()
        .items_center()
        .justify_end()
        .gap(px(8.0))
        .px(px(24.0))
        .py(px(16.0))
        .child(left_button)
        .child(right_button);

    let card = v_flex()
        .w_full()
        .max_w(px(576.0))
        .rounded(px(14.0))
        .bg(to_hsla(tokens.popover))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider))
        .overflow_hidden()
        .child(header)
        .child(panel_body)
        .child(footer);

    div()
        .id("device-setup-scroll")
        .flex()
        .flex_1()
        .min_h_0()
        .size_full()
        .overflow_y_scroll()
        .items_center()
        .justify_center()
        .px(px(20.0))
        .py(px(24.0))
        .child(card)
        .into_any_element()
}

fn render_hub_setup_status(
    tokens: &Tokens,
    status: DeviceHostStatus,
    ready: bool,
    pending: bool,
) -> Option<Div> {
    if !pending && !ready {
        return None;
    }
    let muted = to_hsla(tokens.muted_foreground);
    let (icon, color, label) = if pending {
        let text = match status {
            DeviceHostStatus::Installing => "Installing device hub…",
            DeviceHostStatus::Starting => "Starting device hub…",
            _ => "Updating device hub…",
        };
        ("superhero/spinner.svg", muted, text)
    } else {
        (
            "superhero/check.svg",
            to_hsla(tokens.success),
            "Device hub is ready.",
        )
    };
    Some(
        h_flex()
            .items_center()
            .gap(px(8.0))
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(muted)
            .child(superhero_icon(icon, 12.0, color))
            .child(label),
    )
}

fn render_platform_status_card(
    tokens: &Tokens,
    platform: &'static str,
    status: &PlatformSetupStatus,
) -> Div {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let (icon, icon_color) = if status.ready {
        ("superhero/check.svg", to_hsla(tokens.success))
    } else {
        ("superhero/error-circle.svg", muted)
    };
    h_flex()
        .w_full()
        .items_start()
        .gap(px(8.0))
        .rounded(px(CONTROL_RADIUS_PX))
        .border_1()
        .border_color(chrome::alpha(tokens.border, 0.60))
        .px(px(12.0))
        .py(px(8.0))
        .child(
            div()
                .mt(px(2.0))
                .child(superhero_icon(icon, 16.0, icon_color)),
        )
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.0))
                .child(
                    div()
                        .text_size(px(SM_TEXT_PX))
                        .line_height(px(SM_LINE_HEIGHT_PX))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(fg)
                        .child(platform),
                )
                .child(
                    div()
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(status.message.clone()),
                ),
        )
}
