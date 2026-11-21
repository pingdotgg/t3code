//! The Device surface (Conn `apps/web/src/components/device/`): live device state
//! subscription, 3-step onboarding wizard, iOS/Android device picker, host & account
//! configuration (local, SSH, Expo/EAS, Simlock), active device workspace with controls rail
//! and tools drawer, and live screen streaming.

mod h264;
mod hosts;
mod logic;
mod setup;
mod stream;
mod ui;
mod workspace;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use conn_client::device_hub::{
    DeviceEventLogEntry, DeviceForegroundInfo, DeviceInputCommand, HardwareButton, KeyPhase,
    TouchPhase, android_keycode_for_key, append_device_event_log, hid_usage_for_key,
};
use conn_client::{Connection, DEFAULT_DEVICE_HUB_BASE_PATH, StreamId};
use conn_contract::rpc::device::{
    action, close, configure, detail, eas_account, list, open, shutdown, simlock_identity,
    test_host,
};
use conn_contract::rpc::server::{get_config, update_settings};
use conn_contract::{
    ClientServerSettingsPatch, DeviceActionInput, DeviceCloseInput, DeviceConfigureInput,
    DeviceDetail, DeviceDetailInput, DeviceEasAccountInput, DeviceHostStatus, DeviceListInput,
    DeviceListInputUpdateTool, DeviceOpenInput, DeviceOrientation, DevicePlatform,
    DeviceServiceState, DeviceShutdownInput, DeviceSimlockIdentityInput, DeviceSummary,
    ServerProbePayload, ServerUpdateSettingsPayload,
};
use conn_state::{AnnotationPinPoint, AnnotationRecord, build_device_annotation_capture};
use conn_theme::Tokens;
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, Bounds, Context, EventEmitter, FocusHandle, FontWeight, IntoElement, KeyDownEvent,
    KeyUpEvent, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels,
    Render, RenderImage, SharedString, Styled, Window, div, px,
};

use super::annotations::{AnnotationAction, AnnotationSubject, AnnotationUiState, PendingPinDraft};

use self::hosts::{
    EasAccountCheckState, HostConfigScreen, SavedHostConfigs, SimlockIdentityCheckState,
    SshCheckState, render_host_config,
};
use self::logic::{
    DeviceKey, HostKind, all_hosts, device_hub_readiness, empty_device_state, find_host,
    format_client_error, group_devices, host_diagnostics, platform_group_title,
    show_missing_android_avd_hint,
};
use self::setup::{SetupPending, SetupStep, render_setup_wizard};
use self::stream::{
    EventLogHandle, EventLogKey, ScreenInfo, StreamSessionHandle, StreamStatus, StreamTargetKey,
    StreamUiEvent, capture_and_save_screenshot, map_window_point_to_screen, screen_aspect,
    start_event_log_stream, start_stream_session,
};
use self::ui::{
    LoadingStage, SM_LINE_HEIGHT_PX, SM_TEXT_PX, booting_banner, compact_outline_button,
    device_discovery_warning, device_host_updates, device_loading_view, device_notice,
    outline_sm_button,
};
use self::workspace::{ToolsInputs, WorkspaceMenu, render_workspace};
use super::chrome::{self, ConnTooltipExt as _, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use super::color::to_hsla;
use super::header::{CONTROL_RADIUS_PX, superhero_icon};

/// In-flight open/close/shutdown operation scoped to a single thread (`DevicePanel.tsx`).
#[derive(Clone, Debug)]
struct ScopedOperation {
    thread_id: Option<String>,
    nonce: u64,
    pending: Option<DeviceSummary>,
    error: Option<String>,
}

/// The Device panel entity.
pub(crate) struct DevicePanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_id: Option<String>,

    // Live server state from `subscribeDeviceState` / `device.list`.
    state: DeviceServiceState,
    loaded: bool,
    state_error: Option<String>,
    probed_once: bool,
    stream_id: Option<StreamId>,
    stream_generation: u64,
    list_pending: bool,
    retrying_host_id: Option<String>,

    // Discovery warnings state (`DeviceDiscoveryWarning`).
    dismissed_warnings: HashMap<String, String>,
    open_warning_details: Option<String>,

    // Thread-scoped open/power-off operation and active device selection.
    operation: Option<ScopedOperation>,
    operation_nonce: u64,
    active_target: Option<DeviceKey>,
    picker_forced: bool,

    // Active device detail and actions (`useDeviceControls`).
    device_detail: Option<DeviceDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    action_pending: bool,
    detail_key: Option<DeviceKey>,
    detail_generation: u64,
    synced_placeholders: Option<(DeviceKey, Option<String>)>,

    // Workspace controls & tools drawer (`DeviceWorkspace` + `DeviceToolsPanel`).
    tools_open: bool,
    workspace_menu: Option<WorkspaceMenu>,
    tools_inputs: ToolsInputs,
    last_ios_orientation: DeviceOrientation,

    // Setup wizard (`DeviceSetup.tsx`).
    setup_step: SetupStep,
    setup_pending: Option<SetupPending>,
    setup_error: Option<String>,
    setup_dismissed: bool,
    force_setup_open: bool,

    // Host & account configuration (`DeviceSourcesSettings.tsx`).
    host_config: Option<HostConfigScreen>,
    saved_hosts: SavedHostConfigs,
    host_config_loading: bool,
    host_saving: bool,
    host_error: Option<String>,

    // Live device screen stream, input socket, SSE, and screenshots (`DeviceStreamView.tsx`).
    visible: bool,
    focus_handle: FocusHandle,
    screen_viewport_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    stream_session: Option<StreamSessionHandle>,
    stream_session_gen: u64,
    stream_status: StreamStatus,
    stream_frame: Option<Arc<RenderImage>>,
    stream_frame_size: Option<(u32, u32)>,
    stream_screen: Option<ScreenInfo>,
    input_connected: bool,
    input_detail: Option<String>,
    active_touch: Option<(f64, f64)>,
    held_ios_modifiers: Vec<u16>,
    live_foreground_app: Option<Option<DeviceForegroundInfo>>,
    event_log_handle: Option<EventLogHandle>,
    event_log_gen: u64,
    event_log_entries: Vec<DeviceEventLogEntry>,
    screenshot_pending: bool,
    screenshot_error: Option<String>,
    screenshot_notice: Option<String>,

    // Shared project annotations queue & click-to-annotate state.
    pub(super) annotations: AnnotationUiState,
}

impl EventEmitter<AnnotationAction> for DevicePanel {}

impl std::fmt::Debug for DevicePanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevicePanel")
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .field("loaded", &self.loaded)
            .field("active_target", &self.active_target)
            .field("visible", &self.visible)
            .field("stream_status", &self.stream_status)
            .field("input_connected", &self.input_connected)
            .finish_non_exhaustive()
    }
}

impl Drop for DevicePanel {
    fn drop(&mut self) {
        if let Some(mut session) = self.stream_session.take() {
            session.stop();
        }
        if let Some(mut log) = self.event_log_handle.take() {
            log.stop();
        }
        if let (Some(conn), Some(stream_id)) = (&self.connection, self.stream_id.take()) {
            conn.cancel_stream(stream_id);
        }
    }
}

impl DevicePanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let tools_inputs = ToolsInputs::new(window, cx);
        let focus_handle = cx.focus_handle();
        let annotations =
            AnnotationUiState::new(AnnotationSubject::Device, window, cx, |this, window, cx| {
                this.submit_pending_annotation(window, cx);
            });
        let mut panel = Self {
            tokens,
            connection,
            workspace_root: None,
            thread_id: None,
            state: empty_device_state(),
            loaded: false,
            state_error: None,
            probed_once: false,
            stream_id: None,
            stream_generation: 0,
            list_pending: false,
            retrying_host_id: None,
            dismissed_warnings: HashMap::new(),
            open_warning_details: None,
            operation: None,
            operation_nonce: 0,
            active_target: None,
            picker_forced: false,
            device_detail: None,
            detail_loading: false,
            detail_error: None,
            action_pending: false,
            detail_key: None,
            detail_generation: 0,
            synced_placeholders: None,
            tools_open: false,
            workspace_menu: None,
            tools_inputs,
            last_ios_orientation: DeviceOrientation::Portrait,
            setup_step: SetupStep::Hub,
            setup_pending: None,
            setup_error: None,
            setup_dismissed: false,
            force_setup_open: false,
            host_config: None,
            saved_hosts: SavedHostConfigs::default(),
            host_config_loading: false,
            host_saving: false,
            host_error: None,
            visible: false,
            focus_handle,
            screen_viewport_bounds: Rc::new(Cell::new(None)),
            stream_session: None,
            stream_session_gen: 0,
            stream_status: StreamStatus::Connecting(None),
            stream_frame: None,
            stream_frame_size: None,
            stream_screen: None,
            input_connected: false,
            input_detail: None,
            active_touch: None,
            held_ios_modifiers: Vec::new(),
            live_foreground_app: None,
            event_log_handle: None,
            event_log_gen: 0,
            event_log_entries: Vec::new(),
            screenshot_pending: false,
            screenshot_error: None,
            screenshot_notice: None,
            annotations,
        };
        panel.start_state_subscription(cx);
        panel
    }

    pub(crate) fn sync_annotations(
        &mut self,
        annotations: Vec<AnnotationRecord>,
        watching: bool,
        project_ready: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.annotations.sync(annotations, watching, project_ready);
        cx.notify();
    }

    pub(super) fn submit_pending_annotation(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(point) = self.annotations.pending_pin.as_ref().map(|d| d.point) else {
            return;
        };
        let comment = self
            .annotations
            .comment_input
            .read(cx)
            .value()
            .trim()
            .to_owned();
        if comment.is_empty() {
            return;
        }
        let device_label = self
            .active_device()
            .map_or_else(|| "Device screen".to_owned(), |d| d.name.clone());
        let device_pathname = self
            .effective_foreground_app_id()
            .map(str::to_owned)
            .unwrap_or_else(|| device_label.clone());
        let id = self.annotations.next_annotation_id();
        let capture =
            build_device_annotation_capture(id, comment, device_label, device_pathname, point);
        self.annotations.cancel_pin();
        self.annotations.comment_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        cx.emit(AnnotationAction::Create(capture));
        cx.notify();
    }

    /// Shows or hides the device panel. When hidden, the live stream tears down immediately so
    /// nothing decodes in the background; when shown again, the active device reconnects.
    pub(crate) fn set_visible(&mut self, visible: bool, cx: &mut Context<'_, Self>) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        self.sync_stream_session(cx);
        self.sync_event_log_stream(cx);
        cx.notify();
    }

    fn is_showing_setup(&self) -> bool {
        let host_disabled = self.state.host_status == DeviceHostStatus::Disabled;
        self.force_setup_open
            || (self.loaded
                && !self.setup_dismissed
                && (!self.state.onboarding_completed || host_disabled))
    }

    fn resolved_hub_base_path(&self) -> String {
        if self.state.hub_base_path.trim().is_empty() {
            DEFAULT_DEVICE_HUB_BASE_PATH.to_owned()
        } else {
            self.state.hub_base_path.clone()
        }
    }

    fn desired_stream_target(&self) -> Option<StreamTargetKey> {
        if !self.visible || self.is_showing_setup() || self.host_config.is_some() {
            return None;
        }
        let device = self.active_device()?;
        let host_kind = find_host(&self.state, &device.host_id).map(|h| h.kind);
        Some(StreamTargetKey {
            device: DeviceKey::from_summary(device),
            platform: device.platform,
            host_kind,
            hub_base_path: self.resolved_hub_base_path(),
        })
    }

    fn desired_event_log_target(&self) -> Option<EventLogKey> {
        if !self.visible
            || !self.tools_open
            || !self.tools_inputs.event_log_open
            || self.is_showing_setup()
            || self.host_config.is_some()
        {
            return None;
        }
        let device = self.active_device()?;
        if device.platform != DevicePlatform::Ios {
            return None;
        }
        Some(EventLogKey {
            device: DeviceKey::from_summary(device),
            hub_base_path: self.resolved_hub_base_path(),
        })
    }

    fn stop_stream_session(&mut self, cx: &mut Context<'_, Self>) {
        self.stream_session_gen = self.stream_session_gen.wrapping_add(1);
        if let Some(mut session) = self.stream_session.take() {
            session.stop();
        }
        if let Some(old_image) = self.stream_frame.take() {
            cx.defer(move |cx| cx.drop_image(old_image, None));
        }
        self.stream_frame_size = None;
        self.stream_screen = None;
        self.stream_status = StreamStatus::Connecting(None);
        self.input_connected = false;
        self.input_detail = None;
        self.active_touch = None;
        self.held_ios_modifiers.clear();
        self.live_foreground_app = None;
    }

    fn stop_event_log_stream(&mut self) {
        self.event_log_gen = self.event_log_gen.wrapping_add(1);
        if let Some(mut handle) = self.event_log_handle.take() {
            handle.stop();
        }
        self.event_log_entries.clear();
    }

    fn sync_event_log_stream(&mut self, cx: &mut Context<'_, Self>) {
        let desired = self.desired_event_log_target();
        if self.event_log_handle.as_ref().map(|h| &h.key) == desired.as_ref() {
            return;
        }
        self.stop_event_log_stream();

        let (Some(target), Some(conn)) = (desired, self.connection.clone()) else {
            return;
        };
        self.event_log_gen = self.event_log_gen.wrapping_add(1);
        let generation = self.event_log_gen;
        let (handle, mut rx) = start_event_log_stream(conn, target);
        self.event_log_handle = Some(handle);

        cx.spawn(async move |this, cx| {
            while let Some(batch) = rx.recv().await {
                let keep_going = this
                    .update(cx, |panel, cx| {
                        if panel.event_log_gen != generation {
                            return false;
                        }
                        append_device_event_log(
                            &mut panel.event_log_entries,
                            batch.entries,
                            batch.reset,
                        );
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }

    fn sync_stream_session(&mut self, cx: &mut Context<'_, Self>) {
        let desired = self.desired_stream_target();
        if self.stream_session.as_ref().map(|s| &s.key) == desired.as_ref() {
            return;
        }
        self.stop_stream_session(cx);

        let Some(target) = desired else {
            return;
        };
        let Some(conn) = self.connection.clone() else {
            self.stream_status = StreamStatus::Error("Not connected to server.".to_owned());
            return;
        };

        self.stream_session_gen = self.stream_session_gen.wrapping_add(1);
        let generation = self.stream_session_gen;
        self.stream_status = StreamStatus::Connecting(None);

        let (handle, receivers) = start_stream_session(conn, target);
        self.stream_session = Some(handle);

        let decoded_slot = receivers.decoded_slot;
        let mut frame_wake_rx = receivers.frame_wake_rx;
        cx.spawn(async move |this, cx| {
            while frame_wake_rx.recv().await.is_some() {
                let Some(frame) = decoded_slot.take() else {
                    continue;
                };
                let Some(rgba) = image::RgbaImage::from_raw(frame.width, frame.height, frame.bgra)
                else {
                    continue;
                };
                let new_image = Arc::new(RenderImage::new(vec![image::Frame::new(rgba)]));
                let dims = (frame.width, frame.height);
                let keep_going = this
                    .update(cx, |panel, cx| {
                        if panel.stream_session_gen != generation {
                            cx.defer(move |cx| cx.drop_image(new_image, None));
                            return false;
                        }
                        if let Some(old) = panel.stream_frame.replace(new_image) {
                            cx.defer(move |cx| cx.drop_image(old, None));
                        }
                        panel.stream_frame_size = Some(dims);
                        panel.stream_status = StreamStatus::Streaming;
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();

        let mut events_rx = receivers.events_rx;
        cx.spawn(async move |this, cx| {
            while let Some(event) = events_rx.recv().await {
                let keep_going = this
                    .update(cx, |panel, cx| {
                        if panel.stream_session_gen != generation {
                            return false;
                        }
                        match event {
                            StreamUiEvent::Status(status) => {
                                panel.stream_status = status;
                            }
                            StreamUiEvent::InputConnected { connected, detail } => {
                                panel.input_connected = connected;
                                panel.input_detail = detail;
                                if !connected {
                                    panel.active_touch = None;
                                    panel.held_ios_modifiers.clear();
                                }
                            }
                            StreamUiEvent::ScreenConfig(info) => {
                                panel.last_ios_orientation = info.orientation;
                                panel.stream_screen = Some(info);
                            }
                            StreamUiEvent::ForegroundApp(app) => {
                                panel.live_foreground_app = Some(app);
                            }
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn reconnect_stream(&mut self, cx: &mut Context<'_, Self>) {
        self.stop_stream_session(cx);
        self.sync_stream_session(cx);
        cx.notify();
    }

    /// Foreground app ID preferring live `/appstate` SSE over the last `device.detail` snapshot.
    pub(super) fn effective_foreground_app_id(&self) -> Option<&str> {
        match &self.live_foreground_app {
            Some(Some(live)) => Some(live.id.as_str()),
            Some(None) => None,
            None => self
                .device_detail
                .as_ref()
                .and_then(|d| d.foreground_app.as_ref())
                .map(|a| a.id.as_str()),
        }
    }

    fn current_screen_aspect(&self) -> f32 {
        let platform = self
            .active_device()
            .map_or(DevicePlatform::Ios, |d| d.platform);
        screen_aspect(platform, self.stream_screen, self.stream_frame_size)
    }

    fn active_uses_avcc(&self) -> bool {
        let Some(device) = self.active_device() else {
            return true;
        };
        let is_simlock =
            find_host(&self.state, &device.host_id).is_some_and(|h| h.kind == HostKind::Simlock);
        is_simlock || device.platform == DevicePlatform::Ios
    }

    pub(super) fn handle_screen_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        if self.workspace_menu.take().is_some() {
            cx.notify();
        }
        if self.annotations.queue_open {
            self.annotations.queue_open = false;
            self.annotations.confirming_remove = false;
            cx.notify();
        }
        if self.annotations.annotating && event.button == MouseButton::Left {
            if let Some(viewport) = self.screen_viewport_bounds.get() {
                let vw = f32::from(viewport.size.width);
                let vh = f32::from(viewport.size.height);
                if vw > 1.0 && vh > 1.0 {
                    let local_x =
                        (f32::from(event.position.x) - f32::from(viewport.origin.x)).clamp(0.0, vw);
                    let local_y =
                        (f32::from(event.position.y) - f32::from(viewport.origin.y)).clamp(0.0, vh);
                    let x_pct = (f64::from(local_x) / f64::from(vw) * 100.0).clamp(0.0, 100.0);
                    let y_pct = (f64::from(local_y) / f64::from(vh) * 100.0).clamp(0.0, 100.0);
                    self.annotations.begin_pin(
                        PendingPinDraft {
                            point: AnnotationPinPoint {
                                x_pct,
                                y_pct,
                                viewport_w: f64::from(vw),
                                viewport_h: f64::from(vh),
                            },
                            local_x,
                            local_y,
                            detected: None,
                        },
                        window,
                        cx,
                    );
                    cx.notify();
                }
            }
            return;
        }
        if event.button != MouseButton::Left || !self.input_connected || self.active_touch.is_some()
        {
            return;
        }
        let Some(viewport) = self.screen_viewport_bounds.get() else {
            return;
        };
        let aspect = self.current_screen_aspect();
        let Some((x, y)) = map_window_point_to_screen(event.position, viewport, aspect, false)
        else {
            return;
        };
        self.active_touch = Some((x, y));
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::Touch {
                phase: TouchPhase::Begin,
                x,
                y,
            });
        }
    }

    pub(super) fn handle_screen_mouse_move(&mut self, event: &MouseMoveEvent) {
        let Some((last_x, last_y)) = self.active_touch else {
            return;
        };
        if event.pressed_button != Some(MouseButton::Left) {
            self.active_touch = None;
            if let Some(session) = &self.stream_session {
                session.send_input(DeviceInputCommand::Touch {
                    phase: TouchPhase::End,
                    x: last_x,
                    y: last_y,
                });
            }
            return;
        }
        let Some(viewport) = self.screen_viewport_bounds.get() else {
            return;
        };
        let aspect = self.current_screen_aspect();
        let Some((x, y)) = map_window_point_to_screen(event.position, viewport, aspect, true)
        else {
            return;
        };
        self.active_touch = Some((x, y));
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::Touch {
                phase: TouchPhase::Move,
                x,
                y,
            });
        }
    }

    pub(super) fn handle_screen_mouse_up(&mut self, event: &MouseUpEvent) {
        if event.button != MouseButton::Left {
            return;
        }
        let Some((last_x, last_y)) = self.active_touch.take() else {
            return;
        };
        let (x, y) = self
            .screen_viewport_bounds
            .get()
            .and_then(|vp| {
                map_window_point_to_screen(event.position, vp, self.current_screen_aspect(), true)
            })
            .unwrap_or((last_x, last_y));
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::Touch {
                phase: TouchPhase::End,
                x,
                y,
            });
        }
    }

    fn release_held_ios_modifiers(&mut self) {
        let held = std::mem::take(&mut self.held_ios_modifiers);
        if let Some(session) = &self.stream_session {
            for usage in held.into_iter().rev() {
                session.send_input(DeviceInputCommand::IosKey {
                    phase: KeyPhase::Up,
                    usage,
                });
            }
        }
    }

    pub(super) fn handle_screen_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if event.keystroke.key == "escape" {
            if self.annotations.pending_pin.is_some() {
                self.annotations.cancel_pin();
                cx.notify();
                cx.stop_propagation();
                return;
            }
            if self.annotations.annotating {
                self.annotations.toggle_annotating();
                cx.notify();
                cx.stop_propagation();
                return;
            }
        }
        if !self.focus_handle.is_focused(window) || !self.input_connected {
            return;
        }
        let ks = &event.keystroke;
        let avcc = self.active_uses_avcc();

        // Android paste (Cmd+V / Ctrl+V) forwards clipboard text via `serve-emu` text packets.
        if !avcc
            && (ks.modifiers.platform || ks.modifiers.control)
            && !ks.modifiers.alt
            && ks.key.eq_ignore_ascii_case("v")
        {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text())
                && !text.is_empty()
                && let Some(session) = &self.stream_session
            {
                session.send_input(DeviceInputCommand::AndroidText(text));
            }
            cx.stop_propagation();
            return;
        }

        // Preserve host app Cmd shortcuts except Cmd+R (React Native reload in Conn).
        if ks.modifiers.platform && !ks.key.eq_ignore_ascii_case("r") {
            return;
        }

        if avcc {
            let Some((usage, implied_shift)) = hid_usage_for_key(&ks.key) else {
                return;
            };
            self.release_held_ios_modifiers();
            let mut mods = Vec::new();
            if ks.modifiers.control {
                mods.push(0xe0u16);
            }
            if ks.modifiers.shift || implied_shift {
                mods.push(0xe1u16);
            }
            if ks.modifiers.alt {
                mods.push(0xe2u16);
            }
            if ks.modifiers.platform {
                mods.push(0xe3u16);
            }
            if let Some(session) = &self.stream_session {
                for &m in &mods {
                    session.send_input(DeviceInputCommand::IosKey {
                        phase: KeyPhase::Down,
                        usage: m,
                    });
                }
                session.send_input(DeviceInputCommand::IosKey {
                    phase: KeyPhase::Down,
                    usage,
                });
            }
            self.held_ios_modifiers = mods;
            cx.stop_propagation();
            return;
        }

        // Android (`serve-emu`): Escape -> back, special keys -> keycode, printable -> text.
        if let Some(session) = &self.stream_session {
            if ks.key == "escape" {
                session.send_input(DeviceInputCommand::AndroidBack);
                cx.stop_propagation();
            } else if let Some(keycode) = android_keycode_for_key(&ks.key) {
                session.send_input(DeviceInputCommand::AndroidKey { keycode });
                cx.stop_propagation();
            } else if !ks.modifiers.platform && !ks.modifiers.control {
                let text = ks
                    .key_char
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .or_else(|| (ks.key.chars().count() == 1).then_some(ks.key.as_str()));
                if let Some(text) = text {
                    session.send_input(DeviceInputCommand::AndroidText(text.to_owned()));
                    cx.stop_propagation();
                }
            }
        }
    }

    pub(super) fn handle_screen_key_up(
        &mut self,
        event: &KeyUpEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.focus_handle.is_focused(window) || !self.input_connected {
            return;
        }
        if !self.active_uses_avcc() {
            return;
        }
        let Some((usage, _)) = hid_usage_for_key(&event.keystroke.key) else {
            return;
        };
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::IosKey {
                phase: KeyPhase::Up,
                usage,
            });
        }
        self.release_held_ios_modifiers();
        cx.stop_propagation();
    }

    pub(super) fn press_hardware_button(&mut self, button: HardwareButton) {
        if !self.input_connected {
            return;
        }
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::Button(button));
        }
    }

    pub(super) fn rotate_ios_device(&mut self) {
        let current = self
            .stream_screen
            .map_or(self.last_ios_orientation, |s| s.orientation);
        let next = match current {
            DeviceOrientation::Portrait => DeviceOrientation::LandscapeLeft,
            DeviceOrientation::LandscapeLeft => DeviceOrientation::PortraitUpsideDown,
            DeviceOrientation::PortraitUpsideDown => DeviceOrientation::LandscapeRight,
            DeviceOrientation::LandscapeRight => DeviceOrientation::Portrait,
        };
        self.last_ios_orientation = next;
        if let Some(session) = &self.stream_session {
            session.send_input(DeviceInputCommand::IosOrientation(next));
        }
    }

    pub(super) fn capture_screenshot(&mut self, cx: &mut Context<'_, Self>) {
        if self.screenshot_pending || !self.visible {
            return;
        }
        let (Some(conn), Some(device)) = (self.connection.clone(), self.active_device().cloned())
        else {
            return;
        };
        let hub_base_path = self.resolved_hub_base_path();
        self.screenshot_pending = true;
        self.screenshot_error = None;
        self.screenshot_notice = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let result = capture_and_save_screenshot(
                conn,
                hub_base_path,
                device.host_id,
                device.platform,
                device.id,
                device.name,
            )
            .await;
            let _ = this.update(cx, |panel, cx| {
                panel.screenshot_pending = false;
                match result {
                    Ok(path) => {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("screenshot.png");
                        panel.screenshot_notice = Some(format!("Saved screenshot to {name}"));
                        panel.screenshot_error = None;
                    }
                    Err(err) => {
                        panel.screenshot_error = Some(err);
                        panel.screenshot_notice = None;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        self.workspace_root = None;
        self.thread_id = None;
        self.loaded = false;
        self.state = empty_device_state();
        self.state_error = None;
        self.stream_generation = self.stream_generation.wrapping_add(1);
        cx.notify();
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread and its project folder.
    pub(crate) fn set_thread(
        &mut self,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        let thread_changed = self.thread_id != thread_id;
        self.workspace_root = workspace_root;
        self.thread_id = thread_id;
        if thread_changed {
            self.active_target = None;
            self.picker_forced = false;
            self.workspace_menu = None;
            self.tools_open = false;
            self.clear_detail();
            self.sync_active_from_sessions(cx);
        }
        cx.notify();
    }

    fn start_state_subscription(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            self.loaded = false;
            self.state_error = Some("Not connected to server.".to_owned());
            return;
        };
        if let Some(old_id) = self.stream_id.take() {
            conn.cancel_stream(old_id);
        }
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let generation = self.stream_generation;
        self.state_error = None;

        let (stream_id, mut rx) = conn.stream_json("subscribeDeviceState", serde_json::json!({}));
        self.stream_id = Some(stream_id);

        // Also issue an initial `device.list` call as a fast snapshot fallback in case the
        // server does not push immediately or closes the stream before emitting.
        self.fetch_device_list(
            DeviceListInput {
                update_tool: None,
                inspect_only: None,
                retry_host_id: None,
            },
            cx,
        );

        cx.spawn(async move |this, cx| {
            while let Some(raw) = rx.recv().await {
                let parsed = serde_json::from_value::<DeviceServiceState>(raw);
                let keep_going = this
                    .update(cx, |panel, cx| {
                        if panel.stream_generation != generation {
                            return false;
                        }
                        if let Ok(next_state) = parsed {
                            panel.apply_device_state(next_state, cx);
                        }
                        true
                    })
                    .unwrap_or(false);
                if !keep_going {
                    break;
                }
            }
        })
        .detach();
    }

    fn apply_device_state(&mut self, next: DeviceServiceState, cx: &mut Context<'_, Self>) {
        let should_probe = !self.probed_once && next.host_status != DeviceHostStatus::Disabled;
        self.state = next;
        self.loaded = true;
        self.state_error = None;
        if should_probe {
            self.probed_once = true;
            self.fetch_device_list(
                DeviceListInput {
                    update_tool: None,
                    inspect_only: None,
                    retry_host_id: None,
                },
                cx,
            );
        }
        self.sync_active_from_sessions(cx);
        cx.notify();
    }

    fn sync_active_from_sessions(&mut self, cx: &mut Context<'_, Self>) {
        let Some(thread_id) = self.thread_id.clone() else {
            self.active_target = None;
            self.clear_detail();
            self.sync_stream_session(cx);
            return;
        };

        // Keep explicit active_target if its session still exists on this thread; otherwise
        // auto-select the thread's open session unless the user explicitly clicked "Devices".
        if let Some(target) = &self.active_target {
            let still_open = self.state.sessions.iter().any(|s| {
                s.thread_id == thread_id
                    && s.host_id == target.host_id
                    && s.device_id == target.device_id
            });
            if !still_open {
                self.active_target = None;
                self.clear_detail();
            }
        }
        if self.active_target.is_none()
            && !self.picker_forced
            && let Some(session) = self
                .state
                .sessions
                .iter()
                .find(|s| s.thread_id == thread_id)
        {
            self.active_target = Some(DeviceKey::new(
                session.host_id.clone(),
                session.device_id.clone(),
            ));
        }

        self.ensure_active_detail(cx);
        self.sync_stream_session(cx);
    }

    fn active_device(&self) -> Option<&DeviceSummary> {
        let thread_id = self.thread_id.as_deref()?;
        let target = self.active_target.as_ref()?;
        let has_session = self.state.sessions.iter().any(|s| {
            s.thread_id == thread_id
                && s.host_id == target.host_id
                && s.device_id == target.device_id
        });
        if !has_session {
            return None;
        }
        self.state
            .devices
            .iter()
            .find(|d| d.host_id == target.host_id && d.id == target.device_id)
    }

    fn clear_detail(&mut self) {
        self.detail_generation = self.detail_generation.wrapping_add(1);
        self.detail_key = None;
        self.device_detail = None;
        self.detail_loading = false;
        self.detail_error = None;
        self.action_pending = false;
        self.synced_placeholders = None;
    }

    fn ensure_active_detail(&mut self, cx: &mut Context<'_, Self>) {
        let Some(device) = self.active_device().cloned() else {
            return;
        };
        let key = DeviceKey::from_summary(&device);
        let runs_host_commands =
            find_host(&self.state, &device.host_id).is_some_and(|h| h.kind.runs_host_commands());
        if !runs_host_commands {
            return;
        }
        if self.detail_key.as_ref() == Some(&key) {
            return;
        }
        self.detail_key = Some(key);
        self.fetch_active_detail(cx);
    }

    pub(super) fn fetch_active_detail(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(device)) = (self.connection.clone(), self.active_device().cloned())
        else {
            return;
        };
        let key = DeviceKey::from_summary(&device);
        self.detail_generation = self.detail_generation.wrapping_add(1);
        let generation = self.detail_generation;
        self.detail_loading = true;
        self.detail_error = None;
        cx.notify();

        let payload = DeviceDetailInput {
            host_id: Some(device.host_id),
            device_id: device.id,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<detail::Payload, detail::Success>("device.detail", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.detail_generation != generation || panel.detail_key.as_ref() != Some(&key)
                {
                    return;
                }
                panel.detail_loading = false;
                match res {
                    Ok(detail_value) => {
                        panel.device_detail = Some(detail_value);
                        panel.detail_error = None;
                    }
                    Err(err) => {
                        panel.detail_error = Some(format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn run_device_action(
        &mut self,
        payload: DeviceActionInput,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        if self.action_pending {
            return;
        }
        let generation = self.detail_generation;
        self.action_pending = true;
        self.detail_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<action::Payload, action::Success>("device.action", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.action_pending = false;
                if panel.detail_generation != generation {
                    cx.notify();
                    return;
                }
                match res {
                    Ok(detail_value) => {
                        panel.device_detail = Some(detail_value);
                        panel.detail_error = None;
                    }
                    Err(err) => {
                        panel.detail_error = Some(format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn fetch_device_list(&mut self, payload: DeviceListInput, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            self.state_error = Some("Not connected to server.".to_owned());
            cx.notify();
            return;
        };
        self.list_pending = true;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<list::Payload, list::Success>("device.list", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.list_pending = false;
                if panel.setup_pending == Some(SetupPending::Check) {
                    panel.setup_pending = None;
                }
                if payload.retry_host_id.is_some() {
                    panel.retrying_host_id = None;
                }
                match res {
                    Ok(next) => {
                        panel.apply_device_state(next, cx);
                    }
                    Err(err) => {
                        if !panel.loaded {
                            panel.state_error = Some(format_client_error(&err));
                        } else {
                            panel.set_operation_error(format_client_error(&err));
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn refresh_devices_for_setup(&mut self, cx: &mut Context<'_, Self>) {
        self.fetch_device_list(
            DeviceListInput {
                update_tool: None,
                inspect_only: None,
                retry_host_id: None,
            },
            cx,
        );
    }

    pub(super) fn retry_host(&mut self, host_id: String, cx: &mut Context<'_, Self>) {
        self.retrying_host_id = Some(host_id.clone());
        self.fetch_device_list(
            DeviceListInput {
                update_tool: None,
                inspect_only: None,
                retry_host_id: Some(host_id),
            },
            cx,
        );
    }

    pub(super) fn inspect_tool_versions(&mut self, cx: &mut Context<'_, Self>) {
        self.fetch_device_list(
            DeviceListInput {
                update_tool: None,
                inspect_only: Some(true),
                retry_host_id: None,
            },
            cx,
        );
    }

    pub(super) fn update_device_tool(
        &mut self,
        tool: DeviceListInputUpdateTool,
        cx: &mut Context<'_, Self>,
    ) {
        self.fetch_device_list(
            DeviceListInput {
                update_tool: Some(tool),
                inspect_only: None,
                retry_host_id: None,
            },
            cx,
        );
    }

    fn configure_device(
        &mut self,
        setup_pending: Option<SetupPending>,
        enabled: Option<bool>,
        agent_access_enabled: Option<bool>,
        onboarding_completed: Option<bool>,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(conn) = self.connection.clone() else {
            self.setup_error = Some("Not connected to server.".to_owned());
            cx.notify();
            return;
        };
        self.setup_pending = setup_pending;
        self.setup_error = None;
        self.host_error = None;
        cx.notify();

        let payload = DeviceConfigureInput {
            enabled,
            agent_access_enabled,
            onboarding_completed,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<configure::Payload, configure::Success>("device.configure", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.setup_pending = None;
                match res {
                    Ok(next) => {
                        if setup_pending == Some(SetupPending::Complete) {
                            panel.force_setup_open = false;
                            panel.setup_dismissed = false;
                        }
                        panel.apply_device_state(next, cx);
                    }
                    Err(err) => {
                        let msg = format_client_error(&err);
                        panel.setup_error = Some(msg.clone());
                        panel.host_error = Some(msg);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start_operation(&mut self, pending: Option<DeviceSummary>) -> u64 {
        self.operation_nonce = self.operation_nonce.wrapping_add(1);
        let nonce = self.operation_nonce;
        self.operation = Some(ScopedOperation {
            thread_id: self.thread_id.clone(),
            nonce,
            pending,
            error: None,
        });
        nonce
    }

    fn settle_operation(&mut self, nonce: u64, error: Option<String>) {
        if let Some(op) = &mut self.operation
            && op.nonce == nonce
        {
            op.pending = None;
            op.error = error;
        }
    }

    fn set_operation_error(&mut self, error: String) {
        let nonce = self.start_operation(None);
        self.settle_operation(nonce, Some(error));
    }

    fn current_operation(&self) -> Option<&ScopedOperation> {
        self.operation
            .as_ref()
            .filter(|op| op.thread_id == self.thread_id)
    }

    fn select_device(&mut self, device: DeviceSummary, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            self.set_operation_error("Not connected to server.".to_owned());
            cx.notify();
            return;
        };
        let Some(thread_id) = self.thread_id.clone() else {
            self.set_operation_error("Select a thread before opening a device.".to_owned());
            cx.notify();
            return;
        };
        let nonce = self.start_operation(Some(device.clone()));
        self.picker_forced = false;
        cx.notify();

        let payload = DeviceOpenInput {
            thread_id,
            host_id: Some(device.host_id.clone()),
            device_id: device.id.clone(),
            platform: device.platform,
            boot: None,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<open::Payload, open::Success>("device.open", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(session) => {
                        let key =
                            DeviceKey::new(session.host_id.clone(), session.device_id.clone());
                        if !panel.state.sessions.iter().any(|s| {
                            s.thread_id == session.thread_id
                                && s.host_id == session.host_id
                                && s.device_id == session.device_id
                        }) {
                            panel.state.sessions.push(session);
                        }
                        if panel.thread_id.as_deref() == Some(payload.thread_id.as_str()) {
                            panel.active_target = Some(key);
                            panel.clear_detail();
                            panel.ensure_active_detail(cx);
                            panel.sync_stream_session(cx);
                        }
                        panel.settle_operation(nonce, None);
                    }
                    Err(err) => {
                        panel.settle_operation(nonce, Some(format_client_error(&err)));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn shutdown_device_from_picker(&mut self, device: DeviceSummary, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let nonce = self.start_operation(None);
        cx.notify();
        let payload = DeviceShutdownInput {
            host_id: Some(device.host_id),
            device_id: device.id,
            platform: device.platform,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<shutdown::Payload, shutdown::Success>("device.shutdown", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(()) => {
                        panel.settle_operation(nonce, None);
                        panel.fetch_device_list(
                            DeviceListInput {
                                update_tool: None,
                                inspect_only: None,
                                retry_host_id: None,
                            },
                            cx,
                        );
                    }
                    Err(err) => {
                        panel.settle_operation(nonce, Some(format_client_error(&err)));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn return_to_picker(&mut self, cx: &mut Context<'_, Self>) {
        self.active_target = None;
        self.picker_forced = true;
        self.workspace_menu = None;
        self.tools_open = false;
        self.clear_detail();
        self.sync_stream_session(cx);
        cx.notify();
    }

    pub(super) fn close_active_device(&mut self, power_off: bool, cx: &mut Context<'_, Self>) {
        self.workspace_menu = None;
        let (Some(conn), Some(thread_id), Some(target)) = (
            self.connection.clone(),
            self.thread_id.clone(),
            self.active_target.clone(),
        ) else {
            self.return_to_picker(cx);
            return;
        };
        let nonce = self.start_operation(None);
        cx.notify();

        let payload = DeviceCloseInput {
            host_id: Some(target.host_id.clone()),
            thread_id: thread_id.clone(),
            device_id: Some(target.device_id.clone()),
            shutdown: Some(power_off),
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<close::Payload, close::Success>("device.close", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(()) => {
                        panel.state.sessions.retain(|s| {
                            !(s.thread_id == thread_id
                                && s.host_id == target.host_id
                                && s.device_id == target.device_id)
                        });
                        panel.settle_operation(nonce, None);
                        panel.return_to_picker(cx);
                    }
                    Err(err) => {
                        panel.settle_operation(nonce, Some(format_client_error(&err)));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn toggle_workspace_menu(&mut self, menu: WorkspaceMenu, cx: &mut Context<'_, Self>) {
        self.workspace_menu = if self.workspace_menu == Some(menu) {
            None
        } else {
            Some(menu)
        };
        cx.notify();
    }

    // --- Host & account configuration RPCs ---

    fn open_host_config(&mut self, cx: &mut Context<'_, Self>) {
        self.host_error = None;
        self.host_config = Some(HostConfigScreen::Overview);
        self.sync_stream_session(cx);
        self.load_saved_hosts(cx);
        cx.notify();
    }

    fn load_saved_hosts(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.host_config_loading = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<get_config::Payload, get_config::Success>(
                    "server.getConfig",
                    &ServerProbePayload {},
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.host_config_loading = false;
                match res {
                    Ok(config) => {
                        panel.saved_hosts = SavedHostConfigs::from_settings(&config.settings);
                    }
                    Err(err) => {
                        panel.host_error = Some(format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn test_ssh_host(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let Ok(payload) = (match &self.host_config {
            Some(HostConfigScreen::Ssh(form)) => form.validate(cx),
            _ => return,
        }) else {
            return;
        };
        let host_id = payload.id.clone();
        if let Some(HostConfigScreen::Ssh(form)) = &mut self.host_config {
            form.check = SshCheckState::Checking;
        }
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<test_host::Payload, test_host::Success>("device.testHost", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Some(HostConfigScreen::Ssh(form)) = &mut panel.host_config
                    && form.id == host_id
                {
                    form.check = match res {
                        Ok(summary) => SshCheckState::from_summary(summary),
                        Err(err) => SshCheckState::Failed(format_client_error(&err)),
                    };
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn check_eas_account(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let (host_id, payload) = match &self.host_config {
            Some(HostConfigScreen::Eas(form)) => {
                let entered = form.token.read(cx).value().trim().to_owned();
                let input = DeviceEasAccountInput {
                    host_id: (!form.is_new && entered.is_empty() && !form.token_cleared)
                        .then(|| form.id.clone()),
                    access_token: if !entered.is_empty() {
                        Some(conn_contract::SettingsSecretValue::String(entered))
                    } else if form.token_cleared {
                        Some(conn_contract::SettingsSecretValue::String(String::new()))
                    } else {
                        None
                    },
                };
                (form.id.clone(), input)
            }
            _ => return,
        };
        if let Some(HostConfigScreen::Eas(form)) = &mut self.host_config {
            form.check = EasAccountCheckState::Checking;
        }
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<eas_account::Payload, eas_account::Success>("device.easAccount", &payload)
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Some(HostConfigScreen::Eas(form)) = &mut panel.host_config
                    && form.id == host_id
                {
                    form.check = match res {
                        Ok(account) => EasAccountCheckState::SignedIn(account),
                        Err(err) => EasAccountCheckState::Failed(format_client_error(&err)),
                    };
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn check_simlock_identity(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let (host_id, payload) = match &self.host_config {
            Some(HostConfigScreen::Simlock(form)) => {
                let gw = form.gateway_url.read(cx).value().trim().to_owned();
                let entered = form.agent_token.read(cx).value().trim().to_owned();
                let input = DeviceSimlockIdentityInput {
                    gateway_url: (!gw.is_empty()).then_some(gw),
                    host_id: (!form.is_new && entered.is_empty() && !form.token_cleared)
                        .then(|| form.id.clone()),
                    agent_token: (!entered.is_empty())
                        .then_some(conn_contract::SettingsSecretValue::String(entered)),
                };
                (form.id.clone(), input)
            }
            _ => return,
        };
        if let Some(HostConfigScreen::Simlock(form)) = &mut self.host_config {
            form.check = SimlockIdentityCheckState::Checking;
        }
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<simlock_identity::Payload, simlock_identity::Success>(
                    "device.simlockIdentity",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if let Some(HostConfigScreen::Simlock(form)) = &mut panel.host_config
                    && form.id == host_id
                {
                    form.check = match res {
                        Ok(identity) => SimlockIdentityCheckState::Accepted(identity),
                        Err(err) => SimlockIdentityCheckState::Failed(format_client_error(&err)),
                    };
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn save_ssh_host(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(host) = (match &self.host_config {
            Some(HostConfigScreen::Ssh(form)) => form.validate(cx),
            _ => return,
        }) else {
            return;
        };
        let mut next = self.saved_hosts.ssh_hosts.clone();
        if let Some(slot) = next.iter_mut().find(|h| h.id == host.id) {
            *slot = host;
        } else {
            next.push(host);
        }
        self.save_settings_patch(serde_json::json!({ "deviceHosts": next }), cx);
    }

    pub(super) fn remove_ssh_host(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        let next: Vec<_> = self
            .saved_hosts
            .ssh_hosts
            .iter()
            .filter(|h| h.id != id)
            .cloned()
            .collect();
        self.save_settings_patch(serde_json::json!({ "deviceHosts": next }), cx);
    }

    pub(super) fn save_eas_host(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(host) = (match &self.host_config {
            Some(HostConfigScreen::Eas(form)) => form.validate(cx),
            _ => return,
        }) else {
            return;
        };
        let mut next = self.saved_hosts.eas_hosts.clone();
        if let Some(slot) = next.iter_mut().find(|h| h.id == host.id) {
            *slot = host;
        } else {
            next.push(host);
        }
        self.save_settings_patch(serde_json::json!({ "easDeviceHosts": next }), cx);
    }

    pub(super) fn remove_eas_host(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        let next: Vec<_> = self
            .saved_hosts
            .eas_hosts
            .iter()
            .filter(|h| h.id != id)
            .cloned()
            .collect();
        self.save_settings_patch(serde_json::json!({ "easDeviceHosts": next }), cx);
    }

    pub(super) fn save_simlock_host(&mut self, cx: &mut Context<'_, Self>) {
        let Ok(host) = (match &self.host_config {
            Some(HostConfigScreen::Simlock(form)) => form.validate(cx),
            _ => return,
        }) else {
            return;
        };
        let mut next = self.saved_hosts.simlock_hosts.clone();
        if let Some(slot) = next.iter_mut().find(|h| h.id == host.id) {
            *slot = host;
        } else {
            next.push(host);
        }
        self.save_settings_patch(serde_json::json!({ "simlockDeviceHosts": next }), cx);
    }

    pub(super) fn remove_simlock_host(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        let next: Vec<_> = self
            .saved_hosts
            .simlock_hosts
            .iter()
            .filter(|h| h.id != id)
            .cloned()
            .collect();
        self.save_settings_patch(serde_json::json!({ "simlockDeviceHosts": next }), cx);
    }

    fn save_settings_patch(&mut self, patch_json: serde_json::Value, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let Ok(patch) = serde_json::from_value::<ClientServerSettingsPatch>(patch_json) else {
            self.host_error = Some("Invalid host configuration patch.".to_owned());
            cx.notify();
            return;
        };
        self.host_saving = true;
        self.host_error = None;
        cx.notify();

        let payload = ServerUpdateSettingsPayload {
            patch,
            provider_instance_mutation: None,
        };
        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<update_settings::Payload, update_settings::Success>(
                    "server.updateSettings",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                panel.host_saving = false;
                match res {
                    Ok(settings) => {
                        panel.saved_hosts = SavedHostConfigs::from_settings(&settings);
                        panel.host_config = Some(HostConfigScreen::Overview);
                        panel.host_error = None;
                        panel.fetch_device_list(
                            DeviceListInput {
                                update_tool: None,
                                inspect_only: None,
                                retry_host_id: None,
                            },
                            cx,
                        );
                    }
                    Err(err) => {
                        panel.host_error = Some(format_client_error(&err));
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn render_picker(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = &self.tokens;
        let state = &self.state;
        let entity = cx.entity();
        let fg = to_hsla(tokens.foreground);
        let muted = to_hsla(tokens.muted_foreground);
        let divider = to_hsla(tokens.shell_divider);

        let grouped = group_devices(state);
        let readiness = device_hub_readiness(state);
        let pending_device = self.current_operation().and_then(|op| op.pending.as_ref());
        let pending_key = pending_device.map(DeviceKey::from_summary);

        let mut container = v_flex()
            .mx_auto()
            .w_full()
            .max_w(px(576.0))
            .gap(px(24.0))
            .when(grouped.is_empty(), |el| el.my_auto().items_center());

        if grouped.is_empty() {
            let empty_msg = if state.host_status == DeviceHostStatus::Failed {
                state
                    .host_status_detail
                    .as_deref()
                    .unwrap_or("The device hub failed to start.")
            } else if state.host_status == DeviceHostStatus::Disabled {
                "Device support is turned off on this environment."
            } else {
                "No simulators or emulators were found on this environment."
            };
            container = container
                .child(superhero_icon(
                    "superhero/phone.svg",
                    24.0,
                    muted.opacity(0.60),
                ))
                .child(
                    div()
                        .max_w(px(384.0))
                        .text_size(px(SM_TEXT_PX))
                        .line_height(px(SM_LINE_HEIGHT_PX))
                        .text_color(muted)
                        .child(empty_msg.to_owned()),
                );
        } else if readiness.ready {
            let mut groups_col = v_flex().w_full().gap(px(24.0));
            for group in &grouped {
                let mut list_card = v_flex()
                    .w_full()
                    .overflow_hidden()
                    .rounded(px(12.0))
                    .border_1()
                    .border_color(chrome::alpha(tokens.border, 0.70))
                    .bg(to_hsla(tokens.shell_card));

                for (idx, device) in group.devices.iter().enumerate() {
                    let key = DeviceKey::from_summary(device);
                    let is_this_pending = pending_key.as_ref() == Some(&key);
                    let host_label =
                        find_host(state, &device.host_id).map_or("Device host", |h| h.label);
                    let state_label = if device.booted { "Running" } else { "Stopped" };
                    let subtitle = format!("{host_label} · {} · {state_label}", device.version);
                    let icon = if is_this_pending {
                        "superhero/spinner.svg"
                    } else if device.booted {
                        "superhero/arrow-up-right.svg"
                    } else {
                        "superhero/play.svg"
                    };
                    let action_label = if device.booted { "Open" } else { "Start" };

                    let mut actions = h_flex().flex_shrink_0().items_center().gap(px(6.0));
                    if device.booted
                        && find_host(state, &device.host_id)
                            .is_some_and(|h| h.kind != HostKind::Simlock)
                    {
                        let entity_shut = entity.clone();
                        let device_shut = device.clone();
                        actions = actions.child(
                            chrome::icon_button(
                                SharedString::from(format!(
                                    "device-shutdown-{}-{}",
                                    device.host_id, device.id
                                )),
                                "superhero/power.svg",
                                tokens,
                                pending_key.is_some(),
                                move |_, _, cx| {
                                    let d = device_shut.clone();
                                    entity_shut
                                        .update(cx, |p, cx| p.shutdown_device_from_picker(d, cx));
                                },
                            )
                            .conn_tooltip("Power off device", tokens),
                        );
                    }
                    let entity_open = entity.clone();
                    let device_open = device.clone();
                    actions = actions.child(outline_sm_button(
                        SharedString::from(format!("device-open-{}-{}", device.host_id, device.id)),
                        Some(icon),
                        action_label,
                        tokens,
                        pending_key.is_some(),
                        move |_, _, cx| {
                            let d = device_open.clone();
                            entity_open.update(cx, |p, cx| p.select_device(d, cx));
                        },
                    ));

                    list_card = list_card.child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap(px(12.0))
                            .px(px(12.0))
                            .py(px(12.0))
                            .when(idx > 0, |el| el.border_t_1().border_color(divider))
                            .child(
                                div()
                                    .flex()
                                    .flex_shrink_0()
                                    .size(px(32.0))
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(CONTROL_RADIUS_PX))
                                    .border_1()
                                    .border_color(chrome::alpha(tokens.border, 0.60))
                                    .child(superhero_icon("superhero/phone.svg", 16.0, muted)),
                            )
                            .child(
                                v_flex()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(SM_TEXT_PX))
                                            .line_height(px(SM_LINE_HEIGHT_PX))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(fg)
                                            .child(device.name.clone()),
                                    )
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(XS_TEXT_PX))
                                            .line_height(px(XS_LINE_HEIGHT_PX))
                                            .text_color(muted)
                                            .child(subtitle),
                                    ),
                            )
                            .child(actions),
                    );
                }

                groups_col = groups_col.child(
                    v_flex()
                        .w_full()
                        .gap(px(12.0))
                        .child(
                            h_flex()
                                .items_center()
                                .gap(px(8.0))
                                .text_size(px(SM_TEXT_PX))
                                .line_height(px(SM_LINE_HEIGHT_PX))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(muted)
                                .child(superhero_icon("superhero/phone.svg", 16.0, muted))
                                .child(platform_group_title(group.platform)),
                        )
                        .child(list_card),
                );
            }
            container = container.child(groups_col);
        }

        if show_missing_android_avd_hint(state) {
            container = container.child(
                div()
                    .max_w(px(384.0))
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .text_color(muted)
                    .child("No Android virtual devices found. Create one in Android Studio's Device Manager, then refresh."),
            );
        }

        if self.loaded && !readiness.busy {
            let mut footer_actions = h_flex().items_center().gap(px(8.0));
            if state.host_status == DeviceHostStatus::Disabled {
                let entity_setup = entity.clone();
                footer_actions = footer_actions.child(outline_sm_button(
                    "device-open-setup",
                    Some("superhero/settings.svg"),
                    "Set up devices",
                    tokens,
                    false,
                    move |_, _, cx| {
                        entity_setup.update(cx, |p, cx| {
                            p.setup_dismissed = false;
                            p.force_setup_open = true;
                            cx.notify();
                        });
                    },
                ));
            }
            footer_actions = footer_actions
                .child(outline_sm_button(
                    "device-refresh-list",
                    self.list_pending.then_some("superhero/spinner.svg"),
                    "Refresh devices",
                    tokens,
                    self.list_pending,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.fetch_device_list(
                                    DeviceListInput {
                                        update_tool: None,
                                        inspect_only: None,
                                        retry_host_id: None,
                                    },
                                    cx,
                                );
                            });
                        }
                    },
                ))
                .child(compact_outline_button(
                    "device-manage-hosts",
                    Some("superhero/server.svg"),
                    "Hosts & setup",
                    tokens,
                    false,
                    {
                        let entity = entity;
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| p.open_host_config(cx));
                        }
                    },
                ));
            container = container.child(footer_actions);
        }

        div()
            .id("device-picker-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .overflow_y_scroll()
            .px(px(20.0))
            .py(px(32.0))
            .child(container)
            .into_any_element()
    }
}

impl Render for DevicePanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        self.sync_stream_session(cx);
        self.sync_event_log_stream(cx);
        // Keep tools placeholders synced with active device & foreground app.
        if let Some(device) = self.active_device().cloned() {
            let fg_id = self.effective_foreground_app_id().map(str::to_owned);
            let sync_key = (DeviceKey::from_summary(&device), fg_id.clone());
            if self.synced_placeholders.as_ref() != Some(&sync_key) {
                self.synced_placeholders = Some(sync_key);
                self.tools_inputs
                    .sync_placeholders(device.platform, fg_id.as_deref(), window, cx);
            }
        }

        if self.is_showing_setup() {
            return render_setup_wizard(self, cx);
        }

        if let Some(screen) = &self.host_config {
            return render_host_config(self, screen, cx);
        }

        let tokens = &self.tokens;
        let entity = cx.entity();
        let active_device = self.active_device().cloned();
        let diagnostics = host_diagnostics(&self.state);
        let hosts = all_hosts(&self.state);
        let readiness = device_hub_readiness(&self.state);
        let pending_device = self.current_operation().and_then(|op| op.pending.clone());
        let operation_error = self.current_operation().and_then(|op| op.error.clone());
        let loading =
            active_device.is_none() && (pending_device.is_some() || readiness.busy || !self.loaded);
        let load_error = if self.loaded {
            None
        } else {
            self.state_error.clone()
        };

        let booting_names: Vec<&str> = self
            .state
            .booting_devices
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|d| self.thread_id.as_deref() == Some(d.thread_id.as_str()))
            .map(|d| d.name.as_str())
            .collect();

        // Top banners stack (`DeviceDiscoveryWarning`, `DeviceHostUpdates`, booting, `DeviceNotice`).
        let mut banners = v_flex().w_full().flex_shrink_0();
        if active_device.is_none() {
            for diag in &diagnostics {
                let cause = diag.cause_key();
                if self.dismissed_warnings.get(&diag.host_id) == Some(&cause) {
                    continue;
                }
                let host_id_details = diag.host_id.clone();
                let host_id_dismiss = diag.host_id.clone();
                let cause_dismiss = cause;
                let details_open =
                    self.open_warning_details.as_deref() == Some(diag.host_id.as_str());
                banners = banners.child(device_discovery_warning(
                    tokens,
                    diag,
                    self.list_pending,
                    details_open,
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |p, cx| {
                                p.fetch_device_list(
                                    DeviceListInput {
                                        update_tool: None,
                                        inspect_only: None,
                                        retry_host_id: None,
                                    },
                                    cx,
                                );
                            });
                        }
                    },
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            let id = host_id_details.clone();
                            entity.update(cx, |p, cx| {
                                p.open_warning_details =
                                    if p.open_warning_details.as_deref() == Some(id.as_str()) {
                                        None
                                    } else {
                                        Some(id)
                                    };
                                cx.notify();
                            });
                        }
                    },
                    {
                        let entity = entity.clone();
                        move |_, _, cx| {
                            let id = host_id_dismiss.clone();
                            let cause = cause_dismiss.clone();
                            entity.update(cx, |p, cx| {
                                p.open_warning_details = None;
                                p.dismissed_warnings.insert(id, cause);
                                cx.notify();
                            });
                        }
                    },
                ));
            }
        }

        if let Some(updates) = device_host_updates(
            tokens,
            &hosts,
            &self.state.host_statuses,
            self.state.supports_host_retry.unwrap_or(false),
            self.retrying_host_id.as_deref(),
            {
                let entity = entity.clone();
                move |host_id, _, cx| {
                    entity.update(cx, |p, cx| p.retry_host(host_id, cx));
                }
            },
        ) {
            banners = banners.child(updates);
        }

        if !booting_names.is_empty() {
            banners = banners.child(booting_banner(tokens, &booting_names.join(", ")));
        }

        if let Some(err) = operation_error {
            let entity_dismiss = entity.clone();
            banners = banners.child(device_notice(tokens, err, move |_, _, cx| {
                entity_dismiss.update(cx, |p, cx| {
                    p.operation = None;
                    cx.notify();
                });
            }));
        }

        let body: AnyElement = if let Some(device) = active_device {
            let host = find_host(&self.state, &device.host_id);
            let diag_detail = diagnostics
                .iter()
                .find(|d| d.host_id == device.host_id)
                .map(|d| d.detail.as_str());
            render_workspace(self, &device, host, diag_detail, cx)
        } else if loading {
            let title = pending_device
                .as_ref()
                .map_or_else(|| "Devices".to_owned(), |d| d.name.clone());
            let desc = pending_device.as_ref().map(|d| {
                let host_label =
                    find_host(&self.state, &d.host_id).map_or("Device host", |h| h.label);
                SharedString::from(format!("{host_label} · {}", d.version))
            });
            let message = if let Some(err) = &load_error {
                err.clone()
            } else if let Some(pending) = &pending_device {
                if pending.booted {
                    "Opening device…".to_owned()
                } else {
                    "Starting device…".to_owned()
                }
            } else if self.state.host_status == DeviceHostStatus::Installing {
                self.state
                    .host_status_detail
                    .clone()
                    .unwrap_or_else(|| "Installing device support…".to_owned())
            } else {
                "Finding devices…".to_owned()
            };
            let retry_action = load_error.as_ref().map(|_| {
                let entity = entity.clone();
                outline_sm_button(
                    "device-load-retry",
                    None,
                    "Retry",
                    tokens,
                    false,
                    move |_, _, cx| {
                        entity.update(cx, |p, cx| p.start_state_subscription(cx));
                    },
                )
                .into_any_element()
            });
            device_loading_view(
                tokens,
                title,
                desc,
                LoadingStage::Opening,
                message,
                load_error.is_some(),
                retry_action,
            )
            .into_any_element()
        } else {
            self.render_picker(cx)
        };

        v_flex()
            .relative()
            .flex_1()
            .min_h_0()
            .size_full()
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                entity.update(cx, |p, cx| {
                    let mut changed = false;
                    if p.workspace_menu.take().is_some() {
                        changed = true;
                    }
                    if p.open_warning_details.take().is_some() {
                        changed = true;
                    }
                    if p.annotations.queue_open {
                        p.annotations.queue_open = false;
                        p.annotations.confirming_remove = false;
                        changed = true;
                    }
                    if changed {
                        cx.notify();
                    }
                });
            })
            .child(banners)
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .child(body),
            )
            .into_any_element()
    }
}
