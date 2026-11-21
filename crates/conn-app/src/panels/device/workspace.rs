//! Active Device workspace: screen area (`DeviceStreamView`), right floating controls rail
//! (`DeviceControlsRail`), and collapsible `DeviceToolsPanel` drawer.

use std::rc::Rc;

use conn_client::device_hub::HardwareButton;
use conn_contract::support::JsNumber;
use conn_contract::{
    DeviceActionInput, DeviceActionInputClearLocation, DeviceActionInputLaunchApp,
    DeviceActionInputOpenUrl, DeviceActionInputSendPush, DeviceActionInputSendPushPayload,
    DeviceActionInputSetAppearance, DeviceActionInputSetColorFilter,
    DeviceActionInputSetLiquidGlass, DeviceActionInputSetLocation, DeviceActionInputSetOrientation,
    DeviceActionInputSetPermission, DeviceActionInputSetPermissionDecision,
    DeviceActionInputSetTextSize, DeviceActionInputSetToggle, DeviceActionInputSetToggleSetting,
    DeviceActionInputShake, DeviceActionInputTerminateApp, DeviceAppearance, DeviceDetail,
    DeviceOrientation, DevicePermission, DevicePlatform, DeviceSettingsLiquidGlass, DeviceSummary,
    lit,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Context, Div, Entity, FontWeight, ImageSource, InteractiveElement, IntoElement,
    KeyDownEvent, KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ObjectFit,
    ParentElement, SharedString, Styled, Subscription, Window, canvas, div, img, px,
};

use super::super::annotations::{
    AnnotationAction, PinComposerCallbacks, QueuePopoverAnchor, QueuePopoverCallbacks,
    render_pin_composer, render_pins_overlay, render_queue_popover, toggle_annotation_dictation,
};
use super::super::chrome::{
    self, ConnTooltipExt as _, MenuEntry, MenuRow, XS_LINE_HEIGHT_PX, XS_TEXT_PX,
};
use super::super::color::to_hsla;
use super::super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::DevicePanel;
use super::logic::{
    ANDROID_PERMISSIONS, COLOR_FILTERS, CONTROLS_RAIL_WIDTH_PX, HostKind, HostView,
    IOS_PERMISSIONS, LOCATION_PRESETS, ORIENTATIONS, TEXT_SIZES, color_filter_label,
    parse_coordinates, permission_label, text_size_label,
};
use super::stream::StreamStatus;
use super::ui::{
    DeviceMenuEntry, DeviceMenuRow, LoadingStage, MenuAnchor, PILL_RADIUS_PX, SM_LINE_HEIGHT_PX,
    SM_TEXT_PX, SwitchSize, XS_BUTTON_HEIGHT_PX, compact_input, conn_switch, device_dropdown_menu,
    device_loading_view, ghost_xs_button, outline_sm_button, outline_xs_button, rail_icon_button,
    select_trigger_xs, simple_select_menu,
};
use crate::theme::MONO_FONT;

/// Which popup menu is open inside the active Device workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceMenu {
    RailRotate,
    RailTextSize,
    RailMore,
    ToolsTextSize,
    ToolsColorFilter,
    ToolsOrientation,
    ToolsLocationPreset,
    ToolsPermission,
}

/// Inputs owned by [`DeviceToolsPanel`], kept alive on [`DevicePanel`].
pub(super) struct ToolsInputs {
    pub(super) url: Entity<InputState>,
    pub(super) launch_app: Entity<InputState>,
    pub(super) latitude: Entity<InputState>,
    pub(super) longitude: Entity<InputState>,
    pub(super) permission_app: Entity<InputState>,
    pub(super) push_alert: Entity<InputState>,
    pub(super) selected_permission: DevicePermission,
    pub(super) event_log_open: bool,
    pub(super) ax_overlay: bool,
    _subscriptions: Vec<Subscription>,
}

impl ToolsInputs {
    pub(super) fn new(window: &mut Window, cx: &mut Context<'_, DevicePanel>) -> Self {
        let url = cx.new(|cx| InputState::new(window, cx).placeholder("https://… or myapp://"));
        let launch_app =
            cx.new(|cx| InputState::new(window, cx).placeholder("Bundle ID to launch"));
        let latitude = cx.new(|cx| InputState::new(window, cx).placeholder("Latitude"));
        let longitude = cx.new(|cx| InputState::new(window, cx).placeholder("Longitude"));
        let permission_app = cx.new(|cx| InputState::new(window, cx).placeholder("App ID"));
        let push_alert = cx.new(|cx| InputState::new(window, cx).placeholder("Alert text"));

        let mut subscriptions = Vec::new();
        for input in [
            &url,
            &launch_app,
            &latitude,
            &longitude,
            &permission_app,
            &push_alert,
        ] {
            subscriptions.push(
                cx.subscribe(input, |_panel, _input, event: &InputEvent, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                }),
            );
        }

        Self {
            url,
            launch_app,
            latitude,
            longitude,
            permission_app,
            push_alert,
            selected_permission: DevicePermission::Camera,
            event_log_open: false,
            ax_overlay: false,
            _subscriptions: subscriptions,
        }
    }

    pub(super) fn sync_placeholders(
        &self,
        platform: DevicePlatform,
        foreground_app_id: Option<&str>,
        window: &mut Window,
        cx: &mut Context<'_, DevicePanel>,
    ) {
        let launch_ph = match platform {
            DevicePlatform::Ios => "Bundle ID to launch",
            DevicePlatform::Android => "Package name to launch",
        };
        self.launch_app
            .update(cx, |s, cx| s.set_placeholder(launch_ph, window, cx));
        let perm_ph = foreground_app_id.unwrap_or("App ID").to_owned();
        self.permission_app
            .update(cx, |s, cx| s.set_placeholder(perm_ph, window, cx));
    }
}

/// Renders `DeviceWorkspace`: screen placeholder + right floating `DeviceControlsRail`
/// + collapsible `DeviceToolsPanel` drawer.
pub(super) fn render_workspace(
    panel: &DevicePanel,
    device: &DeviceSummary,
    host: Option<HostView<'_>>,
    host_diagnostics: Option<&str>,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let host_kind = host.map(|h| h.kind);
    let host_label = host.map_or("Device host", |h| h.label);
    let runs_host_commands = host_kind.is_some_and(HostKind::runs_host_commands);
    let detail = panel.device_detail.as_ref();
    let controls_disabled = panel.action_pending || detail.is_none() || !runs_host_commands;

    let mut stage = v_flex().relative().flex_1().min_w_0().min_h_0();

    // Inline error / screenshot status bar matching `DeviceWorkspace.tsx`.
    let top_error = panel.screenshot_error.as_deref().or_else(|| {
        (!panel.tools_open)
            .then_some(panel.detail_error.as_deref())
            .flatten()
    });
    if let Some(err) = top_error {
        stage = stage.child(
            div()
                .w_full()
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    } else if let Some(notice) = panel.screenshot_notice.as_deref() {
        stage = stage.child(
            div()
                .w_full()
                .px(px(12.0))
                .py(px(6.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(notice.to_owned()),
        );
    }

    // Main screen viewport + floating controls rail (`DeviceStreamView` + `DeviceControlsRail`).
    let screen_area = div()
        .relative()
        .flex()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .w_full()
        .child(render_device_stream(panel, device, host_label, cx))
        .child(render_controls_rail(
            panel,
            device,
            host_kind,
            detail,
            controls_disabled,
            cx,
        ));

    stage = stage.child(screen_area);

    let mut workspace = h_flex().relative().flex_1().min_h_0().w_full().child(stage);
    if panel.tools_open {
        workspace = workspace.child(render_tools_panel(
            panel,
            device,
            host_diagnostics,
            detail,
            controls_disabled,
            cx,
        ));
    }

    workspace.into_any_element()
}

/// Live device screen viewport (`DeviceStreamView.tsx`): aspect-fitted GPUI image (`RenderImage`)
/// with right-rail inset, viewport bounds tracking, and Conn's `DeviceLoadingView` overlay when
/// connecting or on stream error.
fn render_device_stream(
    panel: &DevicePanel,
    device: &DeviceSummary,
    host_label: &str,
    cx: &mut Context<'_, DevicePanel>,
) -> AnyElement {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let viewport_bounds = panel.screen_viewport_bounds.clone();

    // Captures the exact viewport bounds (excluding the right controls rail inset) at prepaint
    // without triggering any repaint.
    let bounds_tracker = canvas(
        move |bounds, _window, _cx| {
            viewport_bounds.set(Some(bounds));
        },
        |_bounds, (), _window, _cx| {},
    )
    .absolute()
    .inset_0()
    .size_full();

    let mut viewport = div()
        .id("device-screen-viewport")
        .relative()
        .flex()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .pr(px(CONTROLS_RAIL_WIDTH_PX))
        .track_focus(&panel.focus_handle)
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, event: &MouseDownEvent, window, cx| {
                this.handle_screen_mouse_down(event, window, cx);
                cx.stop_propagation();
            }),
        )
        .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, _cx| {
            this.handle_screen_mouse_move(event);
        }))
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|this, event: &MouseUpEvent, _window, _cx| {
                this.handle_screen_mouse_up(event);
            }),
        )
        .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
            this.handle_screen_key_down(event, window, cx);
        }))
        .on_key_up(cx.listener(|this, event: &KeyUpEvent, window, cx| {
            this.handle_screen_key_up(event, window, cx);
        }));

    let mut media_host = div()
        .relative()
        .flex()
        .size_full()
        .min_h_0()
        .min_w_0()
        .items_center()
        .justify_center()
        .child(bounds_tracker);

    if let Some(frame) = panel.stream_frame.as_ref() {
        media_host = media_host.child(
            img(ImageSource::Render(frame.clone()))
                .size_full()
                .object_fit(ObjectFit::Contain),
        );
    }

    let viewport_size = panel
        .screen_viewport_bounds
        .get()
        .map(|b| (f32::from(b.size.width), f32::from(b.size.height)));
    if let Some(overlay) = render_pins_overlay(&panel.annotations, tokens, viewport_size) {
        media_host = media_host.child(overlay);
    }
    if let Some(composer) = render_pin_composer(
        &panel.annotations,
        tokens,
        viewport_size,
        PinComposerCallbacks {
            on_submit: {
                let entity = entity.clone();
                Rc::new(move |window, cx| {
                    entity.update(cx, |p, cx| p.submit_pending_annotation(window, cx));
                })
            },
            on_cancel: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.cancel_pin();
                        cx.notify();
                    });
                })
            },
            on_toggle_dictation: {
                let entity = entity.clone();
                Rc::new(move |window, cx| {
                    entity.update(cx, |_, cx| {
                        toggle_annotation_dictation(window, cx, |p: &mut DevicePanel| {
                            &mut p.annotations
                        });
                    });
                })
            },
        },
    ) {
        media_host = media_host.child(composer);
    }

    viewport = viewport.child(media_host);

    // Input disconnected pill while video is streaming (`DeviceStreamView.tsx:539-547`).
    if panel.stream_status == StreamStatus::Streaming && !panel.input_connected {
        let banner = match panel.input_detail.as_deref() {
            Some(detail) if !detail.is_empty() => {
                format!("Input disconnected ({detail}), reconnecting…")
            }
            _ => "Input disconnected, reconnecting…".to_owned(),
        };
        viewport = viewport.child(
            div()
                .absolute()
                .left_0()
                .right(px(CONTROLS_RAIL_WIDTH_PX))
                .bottom_0()
                .flex()
                .justify_center()
                .p(px(8.0))
                .child(
                    div()
                        .rounded(px(CONTROL_RADIUS_PX))
                        .bg(chrome::alpha(tokens.background, 0.85))
                        .px(px(8.0))
                        .py(px(4.0))
                        .text_size(px(XS_TEXT_PX))
                        .line_height(px(XS_LINE_HEIGHT_PX))
                        .text_color(to_hsla(tokens.muted_foreground))
                        .child(banner),
                ),
        );
    }

    // Loading / error overlay matching `DeviceStreamView.tsx:556-582`.
    let show_overlay =
        panel.stream_status != StreamStatus::Streaming || panel.stream_frame.is_none();
    if show_overlay {
        let (message, is_error) = match &panel.stream_status {
            StreamStatus::Connecting(Some(detail)) => (detail.clone(), false),
            StreamStatus::Connecting(None) | StreamStatus::Streaming => {
                ("Connecting video…".to_owned(), false)
            }
            StreamStatus::Error(detail) => (detail.clone(), true),
        };
        let reconnect_action = is_error.then(|| {
            let entity = entity.clone();
            outline_sm_button(
                "device-stream-reconnect",
                None,
                "Reconnect",
                tokens,
                false,
                move |_, _, cx| {
                    entity.update(cx, |p, cx| p.reconnect_stream(cx));
                },
            )
            .into_any_element()
        });
        let description = SharedString::from(format!("{host_label} · {}", device.version));
        viewport = viewport.child(div().absolute().inset_0().child(device_loading_view(
            tokens,
            device.name.clone(),
            Some(description),
            LoadingStage::Stream,
            message,
            is_error,
            reconnect_action,
        )));
    }

    viewport.into_any_element()
}

/// Right-hand floating pill rail (`DeviceControlsRail.tsx`).
fn render_controls_rail(
    panel: &DevicePanel,
    device: &DeviceSummary,
    host_kind: Option<HostKind>,
    detail: Option<&DeviceDetail>,
    controls_disabled: bool,
    cx: &mut Context<'_, DevicePanel>,
) -> Div {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let settings = detail.map(|d| &d.settings);
    let runs_host_commands = host_kind.is_some_and(HostKind::runs_host_commands);
    let is_simlock = host_kind == Some(HostKind::Simlock);
    let is_android = device.platform == DevicePlatform::Android;
    let input_disabled = !panel.input_connected;

    let rail_divider = || {
        div()
            .my(px(4.0))
            .h(px(1.0))
            .w(px(20.0))
            .flex_shrink_0()
            .bg(chrome::alpha(tokens.border, 0.70))
    };

    let mut pill = v_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(4.0))
        .rounded(px(PILL_RADIUS_PX))
        .border_1()
        .border_color(chrome::alpha(tokens.border, 0.50))
        .bg(chrome::alpha(tokens.background, 0.80))
        .p(px(8.0));

    // Home button (`DeviceControlsRail.tsx:68-75`).
    pill = pill.child(
        rail_icon_button(
            "device-rail-home",
            "superhero/home.svg",
            tokens,
            false,
            input_disabled,
            {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, _| p.press_hardware_button(HardwareButton::Home));
                }
            },
        )
        .conn_tooltip("Home", tokens),
    );

    if is_android {
        pill = pill
            .child(
                rail_icon_button(
                    "device-rail-back",
                    "superhero/chevron-left.svg",
                    tokens,
                    false,
                    input_disabled,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, _| {
                                p.press_hardware_button(HardwareButton::Back);
                            });
                        }
                    },
                )
                .conn_tooltip("Back", tokens),
            )
            .child(
                rail_icon_button(
                    "device-rail-recents",
                    "superhero/stop.svg",
                    tokens,
                    false,
                    input_disabled,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, _| {
                                p.press_hardware_button(HardwareButton::Recents);
                            });
                        }
                    },
                )
                .conn_tooltip("Recents", tokens),
            );
        if runs_host_commands {
            let mut rotate_anchor = div().relative().child(
                rail_icon_button(
                    "device-rail-rotate",
                    "superhero/retry.svg",
                    tokens,
                    panel.workspace_menu == Some(WorkspaceMenu::RailRotate),
                    controls_disabled,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.toggle_workspace_menu(WorkspaceMenu::RailRotate, cx);
                            });
                        }
                    },
                )
                .conn_tooltip("Rotate device", tokens),
            );
            if panel.workspace_menu == Some(WorkspaceMenu::RailRotate) {
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                rotate_anchor = rotate_anchor.child(device_dropdown_menu(
                    "device-rail-rotate-menu",
                    tokens,
                    vec![
                        DeviceMenuEntry::Row(DeviceMenuRow {
                            id: "device-rotate-portrait".into(),
                            label: "Portrait".into(),
                            icon: None,
                            checked: false,
                            destructive: false,
                            on_select: Box::new({
                                let entity = entity.clone();
                                let host_id = host_id.clone();
                                let device_id = device_id.clone();
                                move |_, cx| {
                                    let action = DeviceActionInput::SetOrientation(
                                        DeviceActionInputSetOrientation {
                                            host_id: Some(host_id.clone()),
                                            device_id: device_id.clone(),
                                            r#type: lit::SetOrientation,
                                            value: DeviceOrientation::Portrait,
                                        },
                                    );
                                    entity.update(cx, |p, cx| {
                                        p.workspace_menu = None;
                                        p.run_device_action(action, cx);
                                    });
                                }
                            }),
                        }),
                        DeviceMenuEntry::Row(DeviceMenuRow {
                            id: "device-rotate-landscape".into(),
                            label: "Landscape".into(),
                            icon: None,
                            checked: false,
                            destructive: false,
                            on_select: Box::new({
                                let entity = entity.clone();
                                move |_, cx| {
                                    let action = DeviceActionInput::SetOrientation(
                                        DeviceActionInputSetOrientation {
                                            host_id: Some(host_id.clone()),
                                            device_id: device_id.clone(),
                                            r#type: lit::SetOrientation,
                                            value: DeviceOrientation::LandscapeLeft,
                                        },
                                    );
                                    entity.update(cx, |p, cx| {
                                        p.workspace_menu = None;
                                        p.run_device_action(action, cx);
                                    });
                                }
                            }),
                        }),
                    ],
                    MenuAnchor::LeftOfRail,
                ));
            }
            pill = pill.child(rotate_anchor);
        }
    } else if !is_simlock {
        // iOS Rotate button: uses input WS `0x07` like Conn when connected, else host RPC fallback.
        let rotate_disabled = input_disabled && controls_disabled;
        pill = pill.child(
            rail_icon_button(
                "device-rail-rotate-ios",
                "superhero/retry.svg",
                tokens,
                false,
                rotate_disabled,
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| {
                            if p.input_connected {
                                p.rotate_ios_device();
                                return;
                            }
                            let next = match p.last_ios_orientation {
                                DeviceOrientation::Portrait => DeviceOrientation::LandscapeLeft,
                                DeviceOrientation::LandscapeLeft => {
                                    DeviceOrientation::PortraitUpsideDown
                                }
                                DeviceOrientation::PortraitUpsideDown => {
                                    DeviceOrientation::LandscapeRight
                                }
                                DeviceOrientation::LandscapeRight => DeviceOrientation::Portrait,
                            };
                            p.last_ios_orientation = next;
                            p.run_device_action(
                                DeviceActionInput::SetOrientation(
                                    DeviceActionInputSetOrientation {
                                        host_id: Some(host_id.clone()),
                                        device_id: device_id.clone(),
                                        r#type: lit::SetOrientation,
                                        value: next,
                                    },
                                ),
                                cx,
                            );
                        });
                    }
                },
            )
            .conn_tooltip("Rotate device", tokens),
        );
    }

    if runs_host_commands {
        let appearance = settings.and_then(|s| s.appearance);
        let next_appearance = match appearance {
            Some(DeviceAppearance::Dark) => DeviceAppearance::Light,
            _ => DeviceAppearance::Dark,
        };
        let appearance_icon = match appearance {
            Some(DeviceAppearance::Dark) => "superhero/theme-light.svg",
            _ => "superhero/theme-dark.svg",
        };
        let appearance_tooltip = match appearance {
            Some(DeviceAppearance::Dark) => "Switch device to light mode",
            _ => "Switch device to dark mode",
        };
        pill = pill.child(rail_divider()).child(
            rail_icon_button(
                "device-rail-appearance",
                appearance_icon,
                tokens,
                false,
                controls_disabled || appearance.is_none(),
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, _, cx| {
                        let action =
                            DeviceActionInput::SetAppearance(DeviceActionInputSetAppearance {
                                host_id: Some(host_id.clone()),
                                device_id: device_id.clone(),
                                r#type: lit::SetAppearance,
                                value: next_appearance,
                            });
                        entity.update(cx, |p, cx| p.run_device_action(action, cx));
                    }
                },
            )
            .conn_tooltip(appearance_tooltip, tokens),
        );

        // Text size menu (`Type`).
        let current_text_size = settings.and_then(|s| s.text_size);
        let mut text_size_anchor = div().relative().child(
            rail_icon_button(
                "device-rail-text-size",
                "superhero/type.svg",
                tokens,
                panel.workspace_menu == Some(WorkspaceMenu::RailTextSize),
                controls_disabled || current_text_size.is_none(),
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.toggle_workspace_menu(WorkspaceMenu::RailTextSize, cx);
                        });
                    }
                },
            )
            .conn_tooltip("Device text size", tokens),
        );
        if panel.workspace_menu == Some(WorkspaceMenu::RailTextSize) {
            let entries = TEXT_SIZES
                .iter()
                .map(|&(size, label)| {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    DeviceMenuEntry::Row(DeviceMenuRow {
                        id: SharedString::from(format!("device-rail-ts-{label}")),
                        label: label.into(),
                        icon: None,
                        checked: current_text_size == Some(size),
                        destructive: false,
                        on_select: Box::new(move |_, cx| {
                            let action =
                                DeviceActionInput::SetTextSize(DeviceActionInputSetTextSize {
                                    host_id: Some(host_id.clone()),
                                    device_id: device_id.clone(),
                                    r#type: lit::SetTextSize,
                                    value: size,
                                });
                            entity.update(cx, |p, cx| {
                                p.workspace_menu = None;
                                p.run_device_action(action, cx);
                            });
                        }),
                    })
                })
                .collect();
            text_size_anchor = text_size_anchor.child(device_dropdown_menu(
                "device-rail-text-size-menu",
                tokens,
                entries,
                MenuAnchor::LeftOfRail,
            ));
        }
        pill = pill.child(text_size_anchor).child(
            rail_icon_button(
                "device-rail-tools",
                "superhero/adjust.svg",
                tokens,
                panel.tools_open,
                false,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.tools_open = !p.tools_open;
                            p.workspace_menu = None;
                            cx.notify();
                        });
                    }
                },
            )
            .conn_tooltip("Device tools", tokens),
        );
    }

    if !is_simlock {
        let streaming = panel.stream_status == StreamStatus::Streaming;
        let shot_tooltip = if panel.screenshot_pending {
            "Capturing screenshot"
        } else {
            "Save screenshot"
        };
        pill = pill.child(
            rail_icon_button(
                "device-rail-screenshot",
                "superhero/camera.svg",
                tokens,
                false,
                !streaming || panel.screenshot_pending,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| p.capture_screenshot(cx));
                    }
                },
            )
            .conn_tooltip(shot_tooltip, tokens),
        );
    }

    // More actions menu (`MoreHorizontal`).
    let mut more_anchor = div().relative().child(
        rail_icon_button(
            "device-rail-more",
            "superhero/more-horizontal.svg",
            tokens,
            panel.workspace_menu == Some(WorkspaceMenu::RailMore),
            false,
            {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.toggle_workspace_menu(WorkspaceMenu::RailMore, cx);
                    });
                }
            },
        )
        .conn_tooltip("More device actions", tokens),
    );
    if panel.workspace_menu == Some(WorkspaceMenu::RailMore) {
        let power_off_label = if is_simlock {
            "Return device to the pool"
        } else {
            "Power off device"
        };
        let entries = vec![
            DeviceMenuEntry::Row(DeviceMenuRow {
                id: "device-more-switch".into(),
                label: "Switch device".into(),
                icon: Some("superhero/phone.svg"),
                checked: false,
                destructive: false,
                on_select: Box::new({
                    let entity = entity.clone();
                    move |_, cx| {
                        entity.update(cx, |p, cx| p.return_to_picker(cx));
                    }
                }),
            }),
            DeviceMenuEntry::Row(DeviceMenuRow {
                id: "device-more-close".into(),
                label: "Close device panel".into(),
                icon: Some("superhero/close.svg"),
                checked: false,
                destructive: false,
                on_select: Box::new({
                    let entity = entity.clone();
                    move |_, cx| {
                        entity.update(cx, |p, cx| p.close_active_device(false, cx));
                    }
                }),
            }),
            DeviceMenuEntry::Separator,
            DeviceMenuEntry::Row(DeviceMenuRow {
                id: "device-more-power-off".into(),
                label: power_off_label.into(),
                icon: Some("superhero/power.svg"),
                checked: false,
                destructive: true,
                on_select: Box::new({
                    let entity = entity.clone();
                    move |_, cx| {
                        entity.update(cx, |p, cx| p.close_active_device(true, cx));
                    }
                }),
            }),
        ];
        more_anchor = more_anchor.child(device_dropdown_menu(
            "device-rail-more-menu",
            tokens,
            entries,
            MenuAnchor::LeftOfRail,
        ));
    }
    pill = pill.child(more_anchor);

    // Annotations controls (`Annotate screen` + `Annotation queue` popover).
    let ann_counts = panel.annotations.counts();
    let ann_annotating = panel.annotations.annotating;
    let ann_ready = panel.annotations.project_ready;
    let mut queue_anchor = div().relative().child(
        rail_icon_button(
            "device-rail-annotations-queue",
            "superhero/checklist.svg",
            tokens,
            panel.annotations.queue_open,
            false,
            {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.workspace_menu = None;
                        p.annotations.toggle_queue();
                        cx.notify();
                    });
                }
            },
        )
        .conn_tooltip(
            if ann_counts.waiting > 0 {
                format!("Annotations queue ({} waiting)", ann_counts.waiting)
            } else {
                "Annotations queue".to_owned()
            },
            tokens,
        ),
    );
    if ann_counts.waiting > 0 {
        queue_anchor = queue_anchor.child(
            div()
                .absolute()
                .top(px(-3.0))
                .right(px(-3.0))
                .min_w(px(15.0))
                .h(px(15.0))
                .px(px(3.0))
                .rounded(px(9999.0))
                .bg(to_hsla(tokens.primary))
                .text_color(to_hsla(tokens.primary_foreground))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(9.0))
                .font_weight(FontWeight::SEMIBOLD)
                .child(ann_counts.waiting.to_string()),
        );
    }
    if panel.annotations.queue_open {
        let callbacks = QueuePopoverCallbacks {
            on_toggle_annotating: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.toggle_annotating();
                        cx.notify();
                    });
                })
            },
            on_send_waiting: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.queue_open = false;
                        cx.emit(AnnotationAction::SendWaiting);
                        cx.notify();
                    });
                })
            },
            on_toggle_watch: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |_, cx| {
                        cx.emit(AnnotationAction::ToggleWatch);
                    });
                })
            },
            on_remove_ids: {
                let entity = entity.clone();
                Rc::new(move |ids, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.confirming_remove = false;
                        cx.emit(AnnotationAction::Remove { ids });
                        cx.notify();
                    });
                })
            },
            on_set_confirming_remove: {
                let entity = entity.clone();
                Rc::new(move |confirming, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.confirming_remove = confirming;
                        cx.notify();
                    });
                })
            },
            on_close: {
                let entity = entity.clone();
                Rc::new(move |_, cx| {
                    entity.update(cx, |p, cx| {
                        p.annotations.queue_open = false;
                        p.annotations.confirming_remove = false;
                        cx.notify();
                    });
                })
            },
        };
        queue_anchor = queue_anchor.child(render_queue_popover(
            &panel.annotations,
            tokens,
            QueuePopoverAnchor::LeftOfRail,
            callbacks,
        ));
    }

    pill = pill
        .child(rail_divider())
        .child(
            rail_icon_button(
                "device-rail-annotate",
                "superhero/comment-text.svg",
                tokens,
                ann_annotating,
                !ann_ready,
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.workspace_menu = None;
                        p.annotations.toggle_annotating();
                        cx.notify();
                    });
                },
            )
            .conn_tooltip(
                if ann_annotating {
                    "Stop annotating screen"
                } else {
                    "Annotate screen"
                },
                tokens,
            ),
        )
        .child(queue_anchor);

    // 3D view / Flat view divider + toggles (3D disabled in GPUI because Three.js WebGL is browser-only).
    pill = pill
        .child(rail_divider())
        .child(
            rail_icon_button(
                "device-rail-view-3d",
                "superhero/package.svg",
                tokens,
                false,
                true,
                |_, _, _| {},
            )
            .conn_tooltip("3D view", tokens),
        )
        .child(
            rail_icon_button(
                "device-rail-view-flat",
                "superhero/phone.svg",
                tokens,
                true,
                false,
                |_, _, _| {},
            )
            .conn_tooltip("Flat view", tokens),
        );

    div()
        .absolute()
        .top_0()
        .bottom_0()
        .right_0()
        .w(px(CONTROLS_RAIL_WIDTH_PX))
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .py(px(12.0))
        .pr(px(8.0))
        .child(pill)
}

/// Collapsible right-hand `DeviceToolsPanel` (`w-72` = 288px, `border-l`).
fn render_tools_panel(
    panel: &DevicePanel,
    device: &DeviceSummary,
    host_diagnostics: Option<&str>,
    detail: Option<&DeviceDetail>,
    disabled: bool,
    cx: &mut Context<'_, DevicePanel>,
) -> Div {
    let tokens = &panel.tokens;
    let entity = cx.entity();
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let divider = to_hsla(tokens.shell_divider);
    let mono: SharedString = MONO_FONT.into();
    let is_ios = device.platform == DevicePlatform::Ios;
    let settings = detail.map(|d| &d.settings);
    let foreground_app_id = panel.effective_foreground_app_id().map(str::to_owned);

    // Header: `h-9 shrink-0 items-center gap-2 border-b px-3`.
    let mut header = h_flex()
        .w_full()
        .h(px(36.0))
        .flex_shrink_0()
        .items_center()
        .gap(px(8.0))
        .border_b_1()
        .border_color(divider)
        .px(px(12.0))
        .child(
            div()
                .text_size(px(SM_TEXT_PX))
                .line_height(px(SM_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child("Tools"),
        );
    if panel.action_pending || panel.detail_loading {
        header = header.child(superhero_icon("superhero/spinner.svg", 14.0, muted));
    }
    header = header.child(
        div().ml_auto().child(
            chrome::icon_button(
                "device-tools-close",
                "superhero/close.svg",
                tokens,
                false,
                {
                    let entity = entity.clone();
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.tools_open = false;
                            p.workspace_menu = None;
                            cx.notify();
                        });
                    }
                },
            )
            .conn_tooltip("Close tools", tokens),
        ),
    );

    let mut content = v_flex().w_full();

    if let Some(err) = panel.detail_error.as_deref() {
        content = content.child(
            div()
                .w_full()
                .border_b_1()
                .border_color(divider)
                .bg(chrome::alpha(tokens.destructive, 0.10))
                .px(px(12.0))
                .py(px(8.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.destructive))
                .child(err.to_owned()),
        );
    }

    if detail.is_none() && panel.detail_error.is_none() {
        content = content.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(8.0))
                .px(px(12.0))
                .py(px(12.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(muted)
                .child(superhero_icon("superhero/spinner.svg", 14.0, muted))
                .child("Reading device settings…"),
        );
    }

    if let Some(diag) = host_diagnostics {
        content = content.child(
            tools_section(tokens, "Host diagnostics", true).child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child(diag.to_owned()),
            ),
        );
    }

    // 1. App section
    let mut app_section = tools_section(tokens, "App", true).child(tools_row(
        tokens,
        "Foreground",
        div()
            .max_w(px(150.0))
            .truncate()
            .font_family(mono.clone())
            .text_size(px(XS_TEXT_PX))
            .line_height(px(XS_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(foreground_app_id.clone().unwrap_or_else(|| "-".to_owned())),
    ));

    if let Some(app_id) = foreground_app_id.as_ref() {
        let host_id = device.host_id.clone();
        let device_id = device.id.clone();
        let app_id_term = app_id.clone();
        let app_id_relaunch = app_id.clone();
        app_section = app_section.child(
            h_flex()
                .gap(px(6.0))
                .child(outline_xs_button(
                    "device-tools-terminate-app",
                    "Terminate",
                    tokens,
                    disabled,
                    {
                        let entity = entity.clone();
                        let host_id = host_id.clone();
                        let device_id = device_id.clone();
                        move |_, _, cx| {
                            let action =
                                DeviceActionInput::TerminateApp(DeviceActionInputTerminateApp {
                                    host_id: Some(host_id.clone()),
                                    device_id: device_id.clone(),
                                    r#type: lit::TerminateApp,
                                    app_id: app_id_term.clone(),
                                });
                            entity.update(cx, |p, cx| p.run_device_action(action, cx));
                        }
                    },
                ))
                .child(outline_xs_button(
                    "device-tools-relaunch-app",
                    "Relaunch",
                    tokens,
                    disabled,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            let action = DeviceActionInput::LaunchApp(DeviceActionInputLaunchApp {
                                host_id: Some(host_id.clone()),
                                device_id: device_id.clone(),
                                r#type: lit::LaunchApp,
                                app_id: app_id_relaunch.clone(),
                            });
                            entity.update(cx, |p, cx| p.run_device_action(action, cx));
                        }
                    },
                )),
        );
    }

    let url_value = panel.tools_inputs.url.read(cx).value().trim().to_owned();
    app_section = app_section.child(
        h_flex()
            .w_full()
            .items_center()
            .gap(px(6.0))
            .child(compact_input(
                &panel.tools_inputs.url,
                true,
                tokens,
                disabled,
            ))
            .child(outline_xs_button(
                "device-tools-open-url",
                "Open",
                tokens,
                disabled || url_value.is_empty(),
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, window, cx| {
                        let url = url_value.clone();
                        let action = DeviceActionInput::OpenUrl(DeviceActionInputOpenUrl {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::OpenUrl,
                            url,
                        });
                        entity.update(cx, |p, cx| {
                            p.tools_inputs
                                .url
                                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                            p.run_device_action(action, cx);
                        });
                    }
                },
            )),
    );

    let launch_value = panel
        .tools_inputs
        .launch_app
        .read(cx)
        .value()
        .trim()
        .to_owned();
    app_section = app_section.child(
        h_flex()
            .w_full()
            .items_center()
            .gap(px(6.0))
            .child(compact_input(
                &panel.tools_inputs.launch_app,
                true,
                tokens,
                disabled,
            ))
            .child(outline_xs_button(
                "device-tools-launch-app",
                "Launch",
                tokens,
                disabled || launch_value.is_empty(),
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, window, cx| {
                        let app_id = launch_value.clone();
                        let action = DeviceActionInput::LaunchApp(DeviceActionInputLaunchApp {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::LaunchApp,
                            app_id,
                        });
                        entity.update(cx, |p, cx| {
                            p.tools_inputs
                                .launch_app
                                .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                            p.run_device_action(action, cx);
                        });
                    }
                },
            )),
    );
    content = content.child(app_section);

    // 2. Simulator / Emulator section
    let mut sim_section =
        tools_section(tokens, if is_ios { "Simulator" } else { "Emulator" }, true);

    // Appearance toggle group (Light / Dark).
    let appearance = settings.and_then(|s| s.appearance);
    sim_section = sim_section.child(tools_row(
        tokens,
        "Appearance",
        segmented_two_toggle(
            tokens,
            "device-appearance",
            ("Light", appearance == Some(DeviceAppearance::Light)),
            ("Dark", appearance == Some(DeviceAppearance::Dark)),
            disabled,
            {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                move |_, _, cx| {
                    let action = DeviceActionInput::SetAppearance(DeviceActionInputSetAppearance {
                        host_id: Some(host_id.clone()),
                        device_id: device_id.clone(),
                        r#type: lit::SetAppearance,
                        value: DeviceAppearance::Light,
                    });
                    entity.update(cx, |p, cx| p.run_device_action(action, cx));
                }
            },
            {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                move |_, _, cx| {
                    let action = DeviceActionInput::SetAppearance(DeviceActionInputSetAppearance {
                        host_id: Some(host_id.clone()),
                        device_id: device_id.clone(),
                        r#type: lit::SetAppearance,
                        value: DeviceAppearance::Dark,
                    });
                    entity.update(cx, |p, cx| p.run_device_action(action, cx));
                }
            },
        ),
    ));

    // Text size select (`w-40` = 160px).
    let current_ts = settings.and_then(|s| s.text_size);
    let mut ts_anchor = div().relative().child(select_trigger_xs(
        "device-tools-text-size",
        current_ts.map_or("Unknown", text_size_label).into(),
        current_ts.is_none(),
        144.0,
        tokens,
        disabled,
        {
            let entity = entity.clone();
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.toggle_workspace_menu(WorkspaceMenu::ToolsTextSize, cx);
                });
            }
        },
    ));
    if panel.workspace_menu == Some(WorkspaceMenu::ToolsTextSize) {
        let entries = TEXT_SIZES
            .iter()
            .map(|&(size, label)| {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                MenuEntry::Row(MenuRow {
                    id: SharedString::from(format!("device-tools-ts-{label}")),
                    label: label.into(),
                    mono: false,
                    checked: current_ts == Some(size),
                    on_select: Box::new(move |_, cx| {
                        let action = DeviceActionInput::SetTextSize(DeviceActionInputSetTextSize {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::SetTextSize,
                            value: size,
                        });
                        entity.update(cx, |p, cx| {
                            p.workspace_menu = None;
                            p.run_device_action(action, cx);
                        });
                    }),
                })
            })
            .collect();
        ts_anchor = ts_anchor.child(simple_select_menu(
            "device-tools-ts-menu",
            tokens,
            entries,
            MenuAnchor::BelowEnd(XS_BUTTON_HEIGHT_PX),
        ));
    }
    sim_section = sim_section.child(tools_row(tokens, "Text size", ts_anchor));

    if is_ios {
        let lg = settings.and_then(|s| s.liquid_glass);
        sim_section = sim_section.child(tools_row(
            tokens,
            "Liquid Glass",
            segmented_two_toggle(
                tokens,
                "device-liquid-glass",
                ("Clear", lg == Some(DeviceSettingsLiquidGlass::Clear)),
                ("Tinted", lg == Some(DeviceSettingsLiquidGlass::Tinted)),
                disabled || lg.is_none(),
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, _, cx| {
                        let action =
                            DeviceActionInput::SetLiquidGlass(DeviceActionInputSetLiquidGlass {
                                host_id: Some(host_id.clone()),
                                device_id: device_id.clone(),
                                r#type: lit::SetLiquidGlass,
                                value: DeviceSettingsLiquidGlass::Clear,
                            });
                        entity.update(cx, |p, cx| p.run_device_action(action, cx));
                    }
                },
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, _, cx| {
                        let action =
                            DeviceActionInput::SetLiquidGlass(DeviceActionInputSetLiquidGlass {
                                host_id: Some(host_id.clone()),
                                device_id: device_id.clone(),
                                r#type: lit::SetLiquidGlass,
                                value: DeviceSettingsLiquidGlass::Tinted,
                            });
                        entity.update(cx, |p, cx| p.run_device_action(action, cx));
                    }
                },
            ),
        ));

        let current_cf = settings.and_then(|s| s.color_filter);
        let mut cf_anchor = div().relative().child(select_trigger_xs(
            "device-tools-color-filter",
            current_cf.map_or("Unknown", color_filter_label).into(),
            current_cf.is_none(),
            144.0,
            tokens,
            disabled,
            {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.toggle_workspace_menu(WorkspaceMenu::ToolsColorFilter, cx);
                    });
                }
            },
        ));
        if panel.workspace_menu == Some(WorkspaceMenu::ToolsColorFilter) {
            let entries = COLOR_FILTERS
                .iter()
                .map(|&(filter, label)| {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    MenuEntry::Row(MenuRow {
                        id: SharedString::from(format!("device-tools-cf-{label}")),
                        label: label.into(),
                        mono: false,
                        checked: current_cf == Some(filter),
                        on_select: Box::new(move |_, cx| {
                            let action = DeviceActionInput::SetColorFilter(
                                DeviceActionInputSetColorFilter {
                                    host_id: Some(host_id.clone()),
                                    device_id: device_id.clone(),
                                    r#type: lit::SetColorFilter,
                                    value: filter,
                                },
                            );
                            entity.update(cx, |p, cx| {
                                p.workspace_menu = None;
                                p.run_device_action(action, cx);
                            });
                        }),
                    })
                })
                .collect();
            cf_anchor = cf_anchor.child(simple_select_menu(
                "device-tools-cf-menu",
                tokens,
                entries,
                MenuAnchor::BelowEnd(XS_BUTTON_HEIGHT_PX),
            ));
        }
        sim_section = sim_section.child(tools_row(tokens, "Color filter", cf_anchor));
    } else {
        let mut orient_anchor = div().relative().child(select_trigger_xs(
            "device-tools-orientation",
            "Rotate to…".into(),
            true,
            144.0,
            tokens,
            disabled,
            {
                let entity = entity.clone();
                move |_, _, cx| {
                    entity.update(cx, |p, cx| {
                        p.toggle_workspace_menu(WorkspaceMenu::ToolsOrientation, cx);
                    });
                }
            },
        ));
        if panel.workspace_menu == Some(WorkspaceMenu::ToolsOrientation) {
            let entries = ORIENTATIONS
                .iter()
                .map(|&(orientation, label)| {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    MenuEntry::Row(MenuRow {
                        id: SharedString::from(format!("device-tools-orient-{label}")),
                        label: label.into(),
                        mono: false,
                        checked: false,
                        on_select: Box::new(move |_, cx| {
                            let action = DeviceActionInput::SetOrientation(
                                DeviceActionInputSetOrientation {
                                    host_id: Some(host_id.clone()),
                                    device_id: device_id.clone(),
                                    r#type: lit::SetOrientation,
                                    value: orientation,
                                },
                            );
                            entity.update(cx, |p, cx| {
                                p.workspace_menu = None;
                                p.run_device_action(action, cx);
                            });
                        }),
                    })
                })
                .collect();
            orient_anchor = orient_anchor.child(simple_select_menu(
                "device-tools-orient-menu",
                tokens,
                entries,
                MenuAnchor::BelowEnd(XS_BUTTON_HEIGHT_PX),
            ));
        }
        sim_section = sim_section.child(tools_row(tokens, "Orientation", orient_anchor));
    }

    // Setting switches.
    sim_section = sim_section.child(toggle_setting_row(
        tokens,
        device,
        "Reduce Motion",
        DeviceActionInputSetToggleSetting::ReduceMotion,
        settings.and_then(|s| s.reduce_motion),
        disabled,
        entity.clone(),
    ));

    if is_ios {
        sim_section = sim_section
            .child(toggle_setting_row(
                tokens,
                device,
                "Increase Contrast",
                DeviceActionInputSetToggleSetting::IncreaseContrast,
                settings.and_then(|s| s.increase_contrast),
                disabled,
                entity.clone(),
            ))
            .child(toggle_setting_row(
                tokens,
                device,
                "Reduce Transparency",
                DeviceActionInputSetToggleSetting::ReduceTransparency,
                settings.and_then(|s| s.reduce_transparency),
                disabled,
                entity.clone(),
            ))
            .child(toggle_setting_row(
                tokens,
                device,
                "Show Borders",
                DeviceActionInputSetToggleSetting::ShowBorders,
                settings.and_then(|s| s.show_borders),
                disabled,
                entity.clone(),
            ))
            .child(toggle_setting_row(
                tokens,
                device,
                "VoiceOver",
                DeviceActionInputSetToggleSetting::VoiceOver,
                settings.and_then(|s| s.voice_over),
                disabled,
                entity.clone(),
            ))
            .child(h_flex().pt(px(2.0)).child(outline_xs_button(
                "device-tools-shake",
                "Shake gesture",
                tokens,
                disabled,
                {
                    let entity = entity.clone();
                    let host_id = device.host_id.clone();
                    let device_id = device.id.clone();
                    move |_, _, cx| {
                        let action = DeviceActionInput::Shake(DeviceActionInputShake {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::Shake,
                        });
                        entity.update(cx, |p, cx| p.run_device_action(action, cx));
                    }
                },
            )));
    } else {
        sim_section = sim_section.child(toggle_setting_row(
            tokens,
            device,
            "Network",
            DeviceActionInputSetToggleSetting::NetworkEnabled,
            settings.and_then(|s| s.network_enabled),
            disabled,
            entity.clone(),
        ));
    }
    content = content.child(sim_section);

    // 3. Accessibility section
    content = content.child(
        tools_section(tokens, "Accessibility", true).child(tools_row(
            tokens,
            "Overlay element frames",
            conn_switch(
                "device-tools-ax-overlay",
                panel.tools_inputs.ax_overlay,
                true, // Requires live hub HTTP ticket + screen overlay stream
                SwitchSize::Small,
                tokens,
                |_, _, _| {},
            ),
        )),
    );

    // 4. Location section
    let lat_text = panel.tools_inputs.latitude.read(cx).value().to_string();
    let lon_text = panel.tools_inputs.longitude.read(cx).value().to_string();
    let parsed_coords = parse_coordinates(&lat_text, &lon_text);
    let mut preset_anchor = div().relative().child(select_trigger_xs(
        "device-tools-location-preset",
        "Preset…".into(),
        true,
        118.0,
        tokens,
        disabled,
        {
            let entity = entity.clone();
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.toggle_workspace_menu(WorkspaceMenu::ToolsLocationPreset, cx);
                });
            }
        },
    ));
    if panel.workspace_menu == Some(WorkspaceMenu::ToolsLocationPreset) {
        let entries = LOCATION_PRESETS
            .iter()
            .map(|&(label, lat, lon)| {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                MenuEntry::Row(MenuRow {
                    id: SharedString::from(format!("device-tools-loc-{label}")),
                    label: label.into(),
                    mono: false,
                    checked: false,
                    on_select: Box::new(move |window, cx| {
                        let action = DeviceActionInput::SetLocation(DeviceActionInputSetLocation {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::SetLocation,
                            latitude: JsNumber(lat),
                            longitude: JsNumber(lon),
                        });
                        entity.update(cx, |p, cx| {
                            p.workspace_menu = None;
                            p.tools_inputs
                                .latitude
                                .update(cx, |s, cx| s.set_value(lat.to_string(), window, cx));
                            p.tools_inputs
                                .longitude
                                .update(cx, |s, cx| s.set_value(lon.to_string(), window, cx));
                            p.run_device_action(action, cx);
                        });
                    }),
                })
            })
            .collect();
        preset_anchor = preset_anchor.child(simple_select_menu(
            "device-tools-loc-menu",
            tokens,
            entries,
            MenuAnchor::BelowStart(XS_BUTTON_HEIGHT_PX),
        ));
    }

    let mut loc_buttons = h_flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .child(preset_anchor)
        .child(outline_xs_button(
            "device-tools-loc-set",
            "Set",
            tokens,
            disabled || parsed_coords.is_none(),
            {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                move |_, _, cx| {
                    if let Some((lat, lon)) = parsed_coords {
                        let action = DeviceActionInput::SetLocation(DeviceActionInputSetLocation {
                            host_id: Some(host_id.clone()),
                            device_id: device_id.clone(),
                            r#type: lit::SetLocation,
                            latitude: JsNumber(lat),
                            longitude: JsNumber(lon),
                        });
                        entity.update(cx, |p, cx| p.run_device_action(action, cx));
                    }
                }
            },
        ));
    if is_ios {
        loc_buttons = loc_buttons.child(ghost_xs_button(
            "device-tools-loc-clear",
            "Clear",
            tokens,
            disabled,
            {
                let entity = entity.clone();
                let host_id = device.host_id.clone();
                let device_id = device.id.clone();
                move |_, window, cx| {
                    let action = DeviceActionInput::ClearLocation(DeviceActionInputClearLocation {
                        host_id: Some(host_id.clone()),
                        device_id: device_id.clone(),
                        r#type: lit::ClearLocation,
                    });
                    entity.update(cx, |p, cx| {
                        p.tools_inputs
                            .latitude
                            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                        p.tools_inputs
                            .longitude
                            .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                        p.run_device_action(action, cx);
                    });
                }
            },
        ));
    }

    content = content.child(
        tools_section(tokens, "Location", true)
            .child(
                h_flex()
                    .w_full()
                    .gap(px(6.0))
                    .child(compact_input(
                        &panel.tools_inputs.latitude,
                        true,
                        tokens,
                        disabled,
                    ))
                    .child(compact_input(
                        &panel.tools_inputs.longitude,
                        true,
                        tokens,
                        disabled,
                    )),
            )
            .child(loc_buttons),
    );

    // 5. Permissions section
    let perm_list = if is_ios {
        IOS_PERMISSIONS
    } else {
        ANDROID_PERMISSIONS
    };
    let selected_perm = if perm_list
        .iter()
        .any(|(p, _)| *p == panel.tools_inputs.selected_permission)
    {
        panel.tools_inputs.selected_permission
    } else {
        DevicePermission::Camera
    };
    let perm_app_input = panel
        .tools_inputs
        .permission_app
        .read(cx)
        .value()
        .trim()
        .to_owned();
    let resolved_app_id = if !perm_app_input.is_empty() {
        perm_app_input
    } else {
        foreground_app_id.clone().unwrap_or_default()
    };

    let mut perm_anchor = div().relative().child(select_trigger_xs(
        "device-tools-perm-select",
        permission_label(selected_perm, device.platform).into(),
        false,
        136.0,
        tokens,
        disabled,
        {
            let entity = entity.clone();
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    p.toggle_workspace_menu(WorkspaceMenu::ToolsPermission, cx);
                });
            }
        },
    ));
    if panel.workspace_menu == Some(WorkspaceMenu::ToolsPermission) {
        let entries = perm_list
            .iter()
            .map(|&(perm, label)| {
                let entity = entity.clone();
                MenuEntry::Row(MenuRow {
                    id: SharedString::from(format!("device-tools-perm-{label}")),
                    label: label.into(),
                    mono: false,
                    checked: selected_perm == perm,
                    on_select: Box::new(move |_, cx| {
                        entity.update(cx, |p, cx| {
                            p.tools_inputs.selected_permission = perm;
                            p.workspace_menu = None;
                            cx.notify();
                        });
                    }),
                })
            })
            .collect();
        perm_anchor = perm_anchor.child(simple_select_menu(
            "device-tools-perm-menu",
            tokens,
            entries,
            MenuAnchor::BelowStart(XS_BUTTON_HEIGHT_PX),
        ));
    }

    let make_perm_btn = |id: &'static str,
                         label: &'static str,
                         decision: DeviceActionInputSetPermissionDecision,
                         ghost: bool| {
        let entity = entity.clone();
        let host_id = device.host_id.clone();
        let device_id = device.id.clone();
        let app_id = resolved_app_id.clone();
        let btn_disabled = disabled || resolved_app_id.is_empty();
        let handler = move |_: &gpui_kit::ClickEvent, _: &mut Window, cx: &mut gpui_kit::App| {
            let action = DeviceActionInput::SetPermission(DeviceActionInputSetPermission {
                host_id: Some(host_id.clone()),
                device_id: device_id.clone(),
                r#type: lit::SetPermission,
                app_id: app_id.clone(),
                permission: selected_perm,
                decision,
            });
            entity.update(cx, |p, cx| p.run_device_action(action, cx));
        };
        if ghost {
            ghost_xs_button(id, label, tokens, btn_disabled, handler)
        } else {
            outline_xs_button(id, label, tokens, btn_disabled, handler)
        }
    };

    let mut perm_controls = h_flex()
        .flex_wrap()
        .items_center()
        .gap(px(6.0))
        .child(perm_anchor)
        .child(make_perm_btn(
            "device-tools-perm-grant",
            "Grant",
            DeviceActionInputSetPermissionDecision::Grant,
            false,
        ))
        .child(make_perm_btn(
            "device-tools-perm-revoke",
            "Revoke",
            DeviceActionInputSetPermissionDecision::Revoke,
            false,
        ));
    if is_ios {
        perm_controls = perm_controls.child(make_perm_btn(
            "device-tools-perm-reset",
            "Reset",
            DeviceActionInputSetPermissionDecision::Reset,
            true,
        ));
    }
    content = content.child(
        tools_section(tokens, "Permissions", is_ios)
            .child(compact_input(
                &panel.tools_inputs.permission_app,
                true,
                tokens,
                disabled,
            ))
            .child(perm_controls),
    );

    // 6. Push notification (iOS)
    if is_ios {
        let push_text = panel
            .tools_inputs
            .push_alert
            .read(cx)
            .value()
            .trim()
            .to_owned();
        let fg_app_id = foreground_app_id.clone();
        let mut push_section = tools_section(tokens, "Push notification", true).child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(6.0))
                .child(compact_input(
                    &panel.tools_inputs.push_alert,
                    true,
                    tokens,
                    disabled || fg_app_id.is_none(),
                ))
                .child(outline_xs_button(
                    "device-tools-send-push",
                    "Send",
                    tokens,
                    disabled || fg_app_id.is_none() || push_text.is_empty(),
                    {
                        let entity = entity.clone();
                        let host_id = device.host_id.clone();
                        let device_id = device.id.clone();
                        move |_, window, cx| {
                            if let Some(app_id) = fg_app_id.clone() {
                                let action =
                                    DeviceActionInput::SendPush(DeviceActionInputSendPush {
                                        host_id: Some(host_id.clone()),
                                        device_id: device_id.clone(),
                                        r#type: lit::SendPush,
                                        app_id,
                                        payload: DeviceActionInputSendPushPayload::String(
                                            push_text.clone(),
                                        ),
                                    });
                                entity.update(cx, |p, cx| {
                                    p.tools_inputs
                                        .push_alert
                                        .update(cx, |s, cx| s.set_value(String::new(), window, cx));
                                    p.run_device_action(action, cx);
                                });
                            }
                        }
                    },
                )),
        );
        if foreground_app_id.is_none() {
            push_section = push_section.child(
                div()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("Open an app first."),
            );
        }
        content = content.child(push_section);

        // 7. Event log collapsible (iOS SSE: streams only while open).
        let log_open = panel.tools_inputs.event_log_open;
        let entity_log = entity.clone();
        let mut log_block = v_flex().w_full().child(
            h_flex()
                .id("device-tools-event-log-toggle")
                .w_full()
                .items_center()
                .gap(px(6.0))
                .border_b_1()
                .border_color(divider)
                .px(px(12.0))
                .py(px(10.0))
                .cursor_pointer()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .on_click(move |_, _, cx| {
                    entity_log.update(cx, |p, cx| {
                        p.tools_inputs.event_log_open = !p.tools_inputs.event_log_open;
                        p.sync_event_log_stream(cx);
                        cx.notify();
                    });
                })
                .child("Event log")
                .child(div().ml_auto().child(superhero_icon(
                    if log_open {
                        "superhero/chevron-down.svg"
                    } else {
                        "superhero/chevron-left.svg"
                    },
                    14.0,
                    muted,
                ))),
        );
        if log_open {
            let mut list = v_flex()
                .id("device-tools-event-log-list")
                .max_h(px(256.0))
                .overflow_y_scroll()
                .px(px(12.0))
                .py(px(8.0))
                .gap(px(2.0))
                .font_family(mono)
                .text_size(px(11.0))
                .line_height(px(16.0));
            if panel.event_log_entries.is_empty() {
                list = list.child(div().text_color(muted).child("No events yet."));
            } else {
                for entry in &panel.event_log_entries {
                    let time = entry
                        .timestamp
                        .get(11..19)
                        .unwrap_or(entry.timestamp.as_str())
                        .to_owned();
                    list = list.child(
                        h_flex()
                            .w_full()
                            .gap(px(8.0))
                            .child(div().flex_shrink_0().text_color(muted).child(time))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .truncate()
                                    .text_color(fg)
                                    .child(entry.summary.clone()),
                            ),
                    );
                }
            }
            log_block = log_block.child(list);
        }
        content = content.child(log_block);
    }

    v_flex()
        .w(px(288.0))
        .flex_shrink_0()
        .h_full()
        .min_h_0()
        .border_l_1()
        .border_color(divider)
        .bg(to_hsla(tokens.shell_card))
        .on_mouse_down(MouseButton::Left, {
            let entity = entity;
            move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    if p.workspace_menu.take().is_some() {
                        cx.notify();
                    }
                });
            }
        })
        .child(header)
        .child(
            div()
                .id("device-tools-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(content),
        )
}

fn tools_section(tokens: &Tokens, title: &'static str, border_bottom: bool) -> Div {
    let mut section = v_flex()
        .w_full()
        .gap(px(8.0))
        .px(px(12.0))
        .py(px(10.0))
        .child(
            div()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(to_hsla(tokens.muted_foreground))
                .child(title),
        );
    if border_bottom {
        section = section
            .border_b_1()
            .border_color(to_hsla(tokens.shell_divider));
    }
    section
}

fn tools_row(tokens: &Tokens, label: &'static str, control: impl IntoElement) -> Div {
    h_flex()
        .w_full()
        .min_h(px(28.0))
        .items_center()
        .justify_between()
        .gap(px(12.0))
        .child(
            div()
                .flex_shrink_0()
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(label),
        )
        .child(
            h_flex()
                .min_w_0()
                .items_center()
                .justify_end()
                .child(control),
        )
}

fn toggle_setting_row(
    tokens: &Tokens,
    device: &DeviceSummary,
    label: &'static str,
    setting: DeviceActionInputSetToggleSetting,
    checked: Option<bool>,
    disabled: bool,
    entity: Entity<DevicePanel>,
) -> Div {
    let host_id = device.host_id.clone();
    let device_id = device.id.clone();
    let current = checked.unwrap_or(false);
    tools_row(
        tokens,
        label,
        conn_switch(
            SharedString::from(format!("device-tools-switch-{label}")),
            current,
            disabled || checked.is_none(),
            SwitchSize::Small,
            tokens,
            move |_, _, cx| {
                let action = DeviceActionInput::SetToggle(DeviceActionInputSetToggle {
                    host_id: Some(host_id.clone()),
                    device_id: device_id.clone(),
                    r#type: lit::SetToggle,
                    setting,
                    value: !current,
                });
                entity.update(cx, |p, cx| p.run_device_action(action, cx));
            },
        ),
    )
}

fn segmented_two_toggle(
    tokens: &Tokens,
    id_prefix: &'static str,
    first: (&'static str, bool),
    second: (&'static str, bool),
    disabled: bool,
    on_first: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    on_second: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
) -> Div {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let active_bg = to_hsla(tokens.shell_highlight);
    let hover = chrome::alpha(tokens.foreground, 0.05);

    let make_btn =
        |suffix: &'static str,
         label: &'static str,
         active: bool,
         handler: Box<dyn Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App)>| {
            let btn = h_flex()
                .id(SharedString::from(format!("{id_prefix}-{suffix}")))
                .h(px(22.0))
                .px(px(8.0))
                .items_center()
                .justify_center()
                .rounded(px(4.0))
                .text_size(px(XS_TEXT_PX))
                .line_height(px(XS_LINE_HEIGHT_PX))
                .font_weight(FontWeight::MEDIUM)
                .text_color(if active { fg } else { muted })
                .when(active, |el| el.bg(active_bg))
                .child(label);
            if disabled {
                btn.opacity(0.64)
            } else {
                btn.cursor_pointer()
                    .hover(move |s| s.bg(if active { active_bg } else { hover }))
                    .on_click(move |ev, window, cx| handler(ev, window, cx))
            }
        };

    h_flex()
        .items_center()
        .gap(px(2.0))
        .p(px(2.0))
        .rounded(px(CONTROL_RADIUS_PX))
        .border_1()
        .border_color(to_hsla(tokens.input))
        .bg(to_hsla(tokens.shell_field))
        .child(make_btn("a", first.0, first.1, Box::new(on_first)))
        .child(make_btn("b", second.0, second.1, Box::new(on_second)))
}
