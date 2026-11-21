//! Device hub input WebSocket protocol (iOS `serve-sim` binary frames and Android `serve-emu`
//! JSON messages) and coordinate/key mapping matching Conn's `device/stream.ts`.

use std::time::Duration;

use conn_contract::{DeviceOrientation, DevicePlatform};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use url::Url;

use crate::ClientError;
use crate::device_hub::{DeviceHubAccess, DeviceHubVendor, mjpeg_stream_url};

/// Outgoing `serve-sim` binary packet tag: touch event (`{ type, x, y }`).
pub const IOS_MSG_TOUCH: u8 = 0x03;
/// Outgoing `serve-sim` binary packet tag: hardware button (`{ button }`).
pub const IOS_MSG_BUTTON: u8 = 0x04;
/// Outgoing `serve-sim` binary packet tag: USB HID key event (`{ type, usage }`).
pub const IOS_MSG_KEY: u8 = 0x06;
/// Outgoing `serve-sim` binary packet tag: orientation change (`{ orientation }`).
pub const IOS_MSG_ORIENTATION: u8 = 0x07;
/// Outgoing `serve-sim` binary packet tag: hinge / Duo control (`0x10`).
pub const IOS_MSG_HINGE: u8 = 0x10;

/// Incoming `serve-sim` binary packet tag: screen config JSON.
pub const IOS_TAG_SCREEN_CONFIG: u8 = 0x82;
/// Incoming `serve-sim` binary packet tag: helper admitted HID input.
pub const IOS_TAG_INPUT_ADMITTED: u8 = 0x83;
/// Incoming `serve-sim` binary packet tag: Duo control reply JSON.
pub const IOS_TAG_CONTROL_REPLY: u8 = 0x90;

/// `expo-device-hub` `serve-emu` `MAX_TEXT_BYTES` per packet (Conn `ANDROID_MAX_TEXT_BYTES`).
const ANDROID_MAX_TEXT_BYTES: usize = 300;
/// Maximum number of text chunks per paste (`ANDROID_MAX_TEXT_CHUNKS`).
const ANDROID_MAX_TEXT_CHUNKS: usize = 64;
/// Timeout for priming `serve-sim`'s helper via MJPEG before opening the input socket.
const PRIME_TIMEOUT: Duration = Duration::from_secs(2);

/// Touch gesture phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchPhase {
    Begin,
    Move,
    End,
}

impl TouchPhase {
    #[must_use]
    const fn ios_wire_name(self) -> &'static str {
        match self {
            Self::Begin => "begin",
            Self::Move => "move",
            Self::End => "end",
        }
    }

    #[must_use]
    const fn android_wire_name(self) -> &'static str {
        match self {
            Self::Begin => "down",
            Self::Move => "move",
            Self::End => "up",
        }
    }
}

/// Key press/release phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyPhase {
    Down,
    Up,
}

impl KeyPhase {
    #[must_use]
    const fn ios_wire_name(self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Up => "up",
        }
    }
}

/// Device hardware buttons (`DeviceHardwareButton` in Conn's `stream.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HardwareButton {
    Home,
    Back,
    Recents,
    Power,
    AppSwitcher,
}

/// Screen configuration pushed by `serve-sim` (`IOS_TAG_SCREEN_CONFIG = 0x82`).
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceScreenConfig {
    pub width: u32,
    pub height: u32,
    pub orientation: DeviceOrientation,
    pub input_unavailable: bool,
    pub screen_id: Option<i64>,
    pub supports_hinge_angle: bool,
    pub supports_physical_orientation: bool,
    pub hinge_angle: Option<f64>,
    pub hinge_pose: Option<String>,
    pub table_mode: Option<bool>,
    pub table_mode_available: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScreenConfig {
    width: f64,
    height: f64,
    orientation: DeviceOrientation,
    #[serde(default)]
    input_unavailable: Option<bool>,
    #[serde(default)]
    screen_id: Option<i64>,
    #[serde(default)]
    supports_hinge_angle: Option<bool>,
    #[serde(default)]
    supports_physical_orientation: Option<bool>,
    #[serde(default)]
    hinge_angle: Option<f64>,
    #[serde(default)]
    hinge_pose: Option<String>,
    #[serde(default)]
    table_mode: Option<bool>,
    #[serde(default)]
    table_mode_available: Option<bool>,
}

/// Decoded server packet received over the iOS `serve-sim` binary input WebSocket.
#[derive(Clone, Debug, PartialEq)]
pub enum IosServerPacket {
    InputAdmitted,
    ScreenConfig(DeviceScreenConfig),
    ControlReply {
        request_id: i64,
        ok: bool,
        error: Option<String>,
    },
}

/// Outgoing input command sent over the active device input WebSocket.
#[derive(Clone, Debug, PartialEq)]
pub enum DeviceInputCommand {
    /// Touch at normalized `[0.0, 1.0]` coordinates in the displayed frame.
    Touch { phase: TouchPhase, x: f64, y: f64 },
    /// Press a hardware button (Home, Back, Recents, Power, AppSwitcher).
    Button(HardwareButton),
    /// iOS USB HID key press/release (`0x06`).
    IosKey { phase: KeyPhase, usage: u16 },
    /// Android keycode event (`{"type":"key","keycode":...}`).
    AndroidKey { keycode: u32 },
    /// Android Escape / Back (`{"type":"back"}`).
    AndroidBack,
    /// Android text input / paste (chunked to 300 UTF-8 bytes per packet).
    AndroidText(String),
    /// iOS orientation update (`0x07`).
    IosOrientation(DeviceOrientation),
    /// iOS hinge / Duo control JSON (`0x10`).
    IosHinge(Value),
    /// Android `reset-video` keyframe request (`{"type":"reset-video","ack":false}`).
    AndroidResetVideo,
}

/// Incoming events emitted by [`run_device_input_ws`].
#[derive(Clone, Debug, PartialEq)]
pub enum DeviceInputEvent {
    /// Input socket admission / availability changed.
    Connected {
        connected: bool,
        detail: Option<String>,
    },
    /// Updated screen geometry/orientation from `serve-sim` (`0x82`).
    ScreenConfig(DeviceScreenConfig),
    /// Android `serve-emu` signaled an encoder restart (`{"type":"video-session"}`).
    AndroidVideoSession,
    /// Raw binary video frame received on the Android `serve-emu` WebSocket (SEMU + Annex-B).
    AndroidVideoPacket(Vec<u8>),
}

/// Errors returned by [`run_device_input_ws`] or [`prime_ios_helper`].
#[derive(Debug, Error)]
pub enum InputWsError {
    #[error("invalid input websocket url: {0}")]
    InvalidUrl(#[from] ClientError),
    #[error("device hub input unauthorized")]
    Unauthorized,
    #[error("input websocket error: {0}")]
    Connection(String),
}

/// Encodes a `serve-sim` tagged JSON binary packet: `[tag, ...utf8(json)]`.
#[must_use]
pub fn encode_tagged_json(tag: u8, payload: &Value) -> Vec<u8> {
    let json_bytes = payload.to_string();
    let mut out = Vec::with_capacity(1 + json_bytes.len());
    out.push(tag);
    out.extend_from_slice(json_bytes.as_bytes());
    out
}

/// Maps normalized displayed coordinates `[0, 1]` into raw framebuffer coordinates for `serve-sim`
/// (which streams raw portrait framebuffers even when iOS reports landscape).
#[must_use]
pub fn raw_ios_point(
    platform: DevicePlatform,
    screen: Option<&DeviceScreenConfig>,
    x: f64,
    y: f64,
) -> (f64, f64) {
    let x = x.clamp(0.0, 1.0);
    let y = y.clamp(0.0, 1.0);
    let Some(screen) = screen else {
        return (x, y);
    };
    if !matches!(platform, DevicePlatform::Ios) || screen.width > screen.height {
        return (x, y);
    }
    match screen.orientation {
        DeviceOrientation::LandscapeLeft => (y, 1.0 - x),
        DeviceOrientation::LandscapeRight => (1.0 - y, x),
        DeviceOrientation::PortraitUpsideDown => (1.0 - x, 1.0 - y),
        DeviceOrientation::Portrait => (x, y),
    }
}

/// Encodes an iOS `serve-sim` touch packet (`0x03`).
#[must_use]
pub fn encode_ios_touch(phase: TouchPhase, raw_x: f64, raw_y: f64) -> Vec<u8> {
    encode_tagged_json(
        IOS_MSG_TOUCH,
        &json!({
            "type": phase.ios_wire_name(),
            "x": raw_x.clamp(0.0, 1.0),
            "y": raw_y.clamp(0.0, 1.0),
        }),
    )
}

/// Encodes an iOS / Simlock `serve-sim` button packet (`0x04`), returning `None` if unsupported on
/// `platform`.
#[must_use]
pub fn encode_ios_button(platform: DevicePlatform, button: HardwareButton) -> Option<Vec<u8>> {
    let name = match button {
        HardwareButton::Home => "home",
        HardwareButton::AppSwitcher | HardwareButton::Recents => "app_switcher",
        HardwareButton::Power => "lock",
        HardwareButton::Back if matches!(platform, DevicePlatform::Android) => "back",
        HardwareButton::Back => return None,
    };
    Some(encode_tagged_json(
        IOS_MSG_BUTTON,
        &json!({ "button": name }),
    ))
}

/// Encodes an iOS `serve-sim` USB HID key packet (`0x06`).
#[must_use]
pub fn encode_ios_key(phase: KeyPhase, usage: u16) -> Vec<u8> {
    encode_tagged_json(
        IOS_MSG_KEY,
        &json!({
            "type": phase.ios_wire_name(),
            "usage": usage,
        }),
    )
}

/// Encodes an iOS `serve-sim` orientation packet (`0x07`).
#[must_use]
pub fn encode_ios_orientation(orientation: DeviceOrientation) -> Vec<u8> {
    let value = match orientation {
        DeviceOrientation::Portrait => "portrait",
        DeviceOrientation::LandscapeLeft => "landscape_left",
        DeviceOrientation::PortraitUpsideDown => "portrait_upside_down",
        DeviceOrientation::LandscapeRight => "landscape_right",
    };
    encode_tagged_json(IOS_MSG_ORIENTATION, &json!({ "orientation": value }))
}

/// Encodes an iOS `serve-sim` hinge/Duo control packet (`0x10`).
#[must_use]
pub fn encode_ios_hinge(payload: &Value) -> Vec<u8> {
    encode_tagged_json(IOS_MSG_HINGE, payload)
}

/// Decodes a binary server packet from `serve-sim`'s `/helper/ws`.
#[must_use]
pub fn decode_ios_server_packet(bytes: &[u8]) -> Option<IosServerPacket> {
    let (&tag, rest) = bytes.split_first()?;
    match tag {
        IOS_TAG_INPUT_ADMITTED => Some(IosServerPacket::InputAdmitted),
        IOS_TAG_SCREEN_CONFIG => {
            let raw: RawScreenConfig = serde_json::from_slice(rest).ok()?;
            if !raw.width.is_finite()
                || !raw.height.is_finite()
                || raw.width <= 0.0
                || raw.height <= 0.0
            {
                return None;
            }
            Some(IosServerPacket::ScreenConfig(DeviceScreenConfig {
                width: raw.width.round() as u32,
                height: raw.height.round() as u32,
                orientation: raw.orientation,
                input_unavailable: raw.input_unavailable.unwrap_or(false),
                screen_id: raw.screen_id,
                supports_hinge_angle: raw.supports_hinge_angle.unwrap_or(false),
                supports_physical_orientation: raw.supports_physical_orientation.unwrap_or(false),
                hinge_angle: raw.hinge_angle.filter(|a| (0.0..=180.0).contains(a)),
                hinge_pose: raw.hinge_pose,
                table_mode: raw.table_mode,
                table_mode_available: raw.table_mode_available,
            }))
        }
        IOS_TAG_CONTROL_REPLY => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct RawReply {
                request_id: i64,
                ok: bool,
                #[serde(default)]
                error: Option<String>,
            }
            let raw: RawReply = serde_json::from_slice(rest).ok()?;
            Some(IosServerPacket::ControlReply {
                request_id: raw.request_id,
                ok: raw.ok,
                error: raw.error,
            })
        }
        _ => None,
    }
}

/// Encodes one [`DeviceInputCommand`] into zero or more Android `serve-emu` JSON text frames.
#[must_use]
pub fn encode_android_command(command: &DeviceInputCommand) -> Vec<String> {
    match command {
        DeviceInputCommand::Touch { phase, x, y } => vec![
            json!({
                "type": "touch",
                "action": phase.android_wire_name(),
                "x": x.clamp(0.0, 1.0),
                "y": y.clamp(0.0, 1.0),
            })
            .to_string(),
        ],
        DeviceInputCommand::Button(button) => {
            let kind = match button {
                HardwareButton::Home => "home",
                HardwareButton::Back => "back",
                HardwareButton::Recents | HardwareButton::AppSwitcher => "recents",
                HardwareButton::Power => "power",
            };
            vec![json!({ "type": kind }).to_string()]
        }
        DeviceInputCommand::AndroidKey { keycode } => {
            vec![json!({ "type": "key", "keycode": keycode }).to_string()]
        }
        DeviceInputCommand::AndroidBack => vec![json!({ "type": "back" }).to_string()],
        DeviceInputCommand::AndroidText(text) => chunk_android_text(text)
            .into_iter()
            .map(|chunk| json!({ "type": "text", "text": chunk }).to_string())
            .collect(),
        DeviceInputCommand::AndroidResetVideo => {
            vec![json!({ "type": "reset-video", "ack": false }).to_string()]
        }
        DeviceInputCommand::IosKey { .. }
        | DeviceInputCommand::IosOrientation(_)
        | DeviceInputCommand::IosHinge(_) => Vec::new(),
    }
}

/// Splits `text` into UTF-8 chunks of at most 300 bytes, capped at 64 chunks, matching Conn's
/// `stream.ts` `sendText`.
#[must_use]
pub fn chunk_android_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        let ch_bytes = ch.len_utf8();
        if current.len() + ch_bytes > ANDROID_MAX_TEXT_BYTES && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            if chunks.len() >= ANDROID_MAX_TEXT_CHUNKS {
                return chunks;
            }
        }
        current.push(ch);
    }
    if !current.is_empty() && chunks.len() < ANDROID_MAX_TEXT_CHUNKS {
        chunks.push(current);
    }
    chunks
}

/// Maps a GPUI key name (e.g. `"a"`, `"enter"`, `"!"`, `"left"`) to `(usb_hid_usage, implied_shift)`
/// matching Conn's `HID_USAGE_BY_CODE` / `hidUsageForCode`.
#[must_use]
pub fn hid_usage_for_key(key: &str) -> Option<(u16, bool)> {
    if key.len() == 1 {
        let b = key.as_bytes()[0];
        if b.is_ascii_lowercase() {
            return Some((0x04 + u16::from(b - b'a'), false));
        }
        if b.is_ascii_uppercase() {
            return Some((0x04 + u16::from(b - b'A'), true));
        }
        if (b'1'..=b'9').contains(&b) {
            return Some((0x1e + u16::from(b - b'1'), false));
        }
        if b == b'0' {
            return Some((0x27, false));
        }
    }
    let mapped = match key {
        "enter" | "return" => (0x28, false),
        "escape" => (0x29, false),
        "backspace" => (0x2a, false),
        "tab" => (0x2b, false),
        "space" | " " => (0x2c, false),
        "-" => (0x2d, false),
        "_" => (0x2d, true),
        "=" => (0x2e, false),
        "+" => (0x2e, true),
        "[" => (0x2f, false),
        "{" => (0x2f, true),
        "]" => (0x30, false),
        "}" => (0x30, true),
        "\\" => (0x31, false),
        "|" => (0x31, true),
        ";" => (0x33, false),
        ":" => (0x33, true),
        "'" => (0x34, false),
        "\"" => (0x34, true),
        "`" => (0x35, false),
        "~" => (0x35, true),
        "," => (0x36, false),
        "<" => (0x36, true),
        "." => (0x37, false),
        ">" => (0x37, true),
        "/" => (0x38, false),
        "?" => (0x38, true),
        "!" => (0x1e, true),
        "@" => (0x1f, true),
        "#" => (0x20, true),
        "$" => (0x21, true),
        "%" => (0x22, true),
        "^" => (0x23, true),
        "&" => (0x24, true),
        "*" => (0x25, true),
        "(" => (0x26, true),
        ")" => (0x27, true),
        "delete" => (0x4c, false),
        "right" => (0x4f, false),
        "left" => (0x50, false),
        "down" => (0x51, false),
        "up" => (0x52, false),
        _ => return None,
    };
    Some(mapped)
}

/// Maps a GPUI non-printable key name to an Android `KeyEvent` keycode matching Conn's
/// `ANDROID_KEYCODE_BY_KEY`.
#[must_use]
pub fn android_keycode_for_key(key: &str) -> Option<u32> {
    match key {
        "up" => Some(19),
        "down" => Some(20),
        "left" => Some(21),
        "right" => Some(22),
        "tab" => Some(61),
        "enter" | "return" => Some(66),
        "backspace" => Some(67),
        "delete" => Some(112),
        "home" => Some(122),
        "end" => Some(123),
        "pageup" => Some(92),
        "pagedown" => Some(93),
        _ => None,
    }
}

/// Builds the authenticated WebSocket URL for device input (and optional Android video).
///
/// # Errors
///
/// Returns [`ClientError::InvalidUrl`] if URL construction fails.
pub fn device_input_ws_url(
    access: &DeviceHubAccess,
    platform: DevicePlatform,
    serve_sim_only: bool,
    device_id: &str,
    enable_android_video: bool,
) -> Result<Url, ClientError> {
    let vendor = DeviceHubVendor::for_device(platform, serve_sim_only);
    match vendor {
        DeviceHubVendor::ServeSim => {
            access.vendor_ws_url(vendor, "/helper/ws", &[("device", device_id)])
        }
        DeviceHubVendor::ServeEmu => {
            let mode = if enable_android_video {
                ("frame-meta", "1")
            } else {
                ("video", "0")
            };
            access.vendor_ws_url(vendor, "/ws", &[("device", device_id), mode])
        }
    }
}

/// Touches `serve-sim`'s MJPEG endpoint briefly so its helper starts screen capture and admits
/// HID input (`primeIosHelper` in Conn's `stream.ts`).
///
/// # Errors
///
/// Returns [`InputWsError::Unauthorized`] on HTTP 401/403 so callers refresh their ticket.
pub async fn prime_ios_helper(
    http: &reqwest::Client,
    access: &DeviceHubAccess,
    device_id: &str,
) -> Result<(), InputWsError> {
    let url = mjpeg_stream_url(access, device_id)?;
    let mut request = http.get(url).timeout(PRIME_TIMEOUT);
    for (name, value) in access.http_headers() {
        request = request.header(name, value);
    }
    let Ok(mut response) = request.send().await else {
        return Ok(());
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(InputWsError::Unauthorized);
    }
    let _ = tokio::time::timeout(PRIME_TIMEOUT, response.chunk()).await;
    Ok(())
}

/// Runs one device input WebSocket session (iOS `serve-sim` or Android `serve-emu`), forwarding
/// outgoing [`DeviceInputCommand`]s and emitting [`DeviceInputEvent`]s until closed or cancelled.
///
/// # Errors
///
/// Returns [`InputWsError::Unauthorized`] when the handshake returns HTTP 401/403 or the socket
/// closes with an auth error code (`1008`, `4401`, or abnormal close while using a `wsTicket`),
/// or [`InputWsError::Connection`] on transport failure.
pub async fn run_device_input_ws(
    access: &DeviceHubAccess,
    platform: DevicePlatform,
    serve_sim_only: bool,
    device_id: &str,
    enable_android_video: bool,
    cmd_rx: &mut mpsc::Receiver<DeviceInputCommand>,
    events_tx: &mpsc::Sender<DeviceInputEvent>,
) -> Result<(), InputWsError> {
    let avcc = serve_sim_only || matches!(platform, DevicePlatform::Ios);
    let url = device_input_ws_url(
        access,
        platform,
        serve_sim_only,
        device_id,
        enable_android_video,
    )?;

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|err| InputWsError::Connection(format!("invalid input ws request: {err}")))?;
    for (name, value) in access.http_headers() {
        if let Ok(header_val) = HeaderValue::from_str(&value)
            && let Ok(header_name) =
                tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(
                    name.as_bytes(),
                )
        {
            request.headers_mut().insert(header_name, header_val);
        }
    }

    let (ws_stream, _resp) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(tokio_tungstenite::tungstenite::Error::Http(resp))
            if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 =>
        {
            return Err(InputWsError::Unauthorized);
        }
        Err(err) => {
            return Err(InputWsError::Connection(err.to_string()));
        }
    };

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let mut ios_admitted = false;
    let mut ios_unavailable = false;
    let mut current_screen: Option<DeviceScreenConfig> = None;

    if !avcc {
        let _ = events_tx
            .send(DeviceInputEvent::Connected {
                connected: true,
                detail: None,
            })
            .await;
    }

    loop {
        tokio::select! {
            maybe_msg = ws_read.next() => {
                match maybe_msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        if avcc {
                            if let Some(packet) = decode_ios_server_packet(&bytes) {
                                match packet {
                                    IosServerPacket::InputAdmitted => {
                                        ios_admitted = true;
                                        let _ = events_tx
                                            .send(DeviceInputEvent::Connected {
                                                connected: !ios_unavailable,
                                                detail: ios_unavailable
                                                    .then(|| "Simulator input is unavailable".to_owned()),
                                            })
                                            .await;
                                    }
                                    IosServerPacket::ScreenConfig(config) => {
                                        ios_unavailable = config.input_unavailable;
                                        current_screen = Some(config.clone());
                                        let _ = events_tx
                                            .send(DeviceInputEvent::Connected {
                                                connected: ios_admitted && !ios_unavailable,
                                                detail: ios_unavailable
                                                    .then(|| "Simulator input is unavailable".to_owned()),
                                            })
                                            .await;
                                        let _ = events_tx
                                            .send(DeviceInputEvent::ScreenConfig(config))
                                            .await;
                                    }
                                    IosServerPacket::ControlReply { .. } => {}
                                }
                            }
                        } else if enable_android_video {
                            let _ = events_tx
                                .send(DeviceInputEvent::AndroidVideoPacket(bytes.to_vec()))
                                .await;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if !avcc && enable_android_video && is_video_session_message(&text) {
                            let _ = events_tx.send(DeviceInputEvent::AndroidVideoSession).await;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(err) = ws_write.send(Message::Pong(payload)).await {
                            return Err(InputWsError::Connection(err.to_string()));
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        let reason = frame
                            .as_ref()
                            .map(|f| f.reason.to_string())
                            .filter(|s| !s.is_empty());
                        let _ = events_tx
                            .send(DeviceInputEvent::Connected {
                                connected: false,
                                detail: reason.clone(),
                            })
                            .await;
                        if matches!(code, Some(1008 | 4401)) {
                            return Err(InputWsError::Unauthorized);
                        }
                        return Err(InputWsError::Connection(
                            reason.unwrap_or_else(|| {
                                code.map_or_else(
                                    || "input socket closed".to_owned(),
                                    |c| format!("closed {c}"),
                                )
                            }),
                        ));
                    }
                    None => {
                        let _ = events_tx
                            .send(DeviceInputEvent::Connected {
                                connected: false,
                                detail: Some("input socket closed".to_owned()),
                            })
                            .await;
                        return Err(InputWsError::Connection("input socket closed".to_owned()));
                    }
                    Some(Err(err)) => {
                        let _ = events_tx
                            .send(DeviceInputEvent::Connected {
                                connected: false,
                                detail: Some(err.to_string()),
                            })
                            .await;
                        return Err(InputWsError::Connection(err.to_string()));
                    }
                    Some(Ok(Message::Pong(_) | Message::Frame(_))) => {}
                }
            }
            maybe_cmd = cmd_rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    let _ = ws_write.send(Message::Close(None)).await;
                    return Ok(());
                };
                if avcc {
                    if !ios_admitted || ios_unavailable {
                        continue;
                    }
                    let packet = match cmd {
                        DeviceInputCommand::Touch { phase, x, y } => {
                            let (rx, ry) =
                                raw_ios_point(platform, current_screen.as_ref(), x, y);
                            Some(encode_ios_touch(phase, rx, ry))
                        }
                        DeviceInputCommand::Button(button) => encode_ios_button(platform, button),
                        DeviceInputCommand::IosKey { phase, usage } => {
                            Some(encode_ios_key(phase, usage))
                        }
                        DeviceInputCommand::IosOrientation(orientation) => {
                            Some(encode_ios_orientation(orientation))
                        }
                        DeviceInputCommand::IosHinge(payload) => Some(encode_ios_hinge(&payload)),
                        DeviceInputCommand::AndroidKey { .. }
                        | DeviceInputCommand::AndroidBack
                        | DeviceInputCommand::AndroidText(_)
                        | DeviceInputCommand::AndroidResetVideo => None,
                    };
                    if let Some(bytes) = packet
                        && let Err(err) = ws_write.send(Message::Binary(bytes.into())).await
                    {
                        return Err(InputWsError::Connection(err.to_string()));
                    }
                } else {
                    for text in encode_android_command(&cmd) {
                        if let Err(err) = ws_write.send(Message::Text(text.into())).await {
                            return Err(InputWsError::Connection(err.to_string()));
                        }
                    }
                }
            }
        }
    }
}

fn is_video_session_message(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_owned))
        .as_deref()
        == Some("video-session")
}

#[cfg(test)]
mod tests {
    use futures::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    use super::*;

    #[test]
    fn encodes_ios_binary_packets_matching_conn() {
        let touch = encode_ios_touch(TouchPhase::Begin, 0.25, 0.75);
        assert_eq!(touch[0], IOS_MSG_TOUCH, "touch tag must be 0x03");
        let parsed: Value = serde_json::from_slice(&touch[1..]).expect("valid touch json");
        assert_eq!(
            parsed,
            json!({ "type": "begin", "x": 0.25, "y": 0.75 }),
            "touch JSON must match serve-sim format"
        );

        let home =
            encode_ios_button(DevicePlatform::Ios, HardwareButton::Home).expect("iOS home button");
        assert_eq!(home[0], IOS_MSG_BUTTON, "button tag must be 0x04");
        assert_eq!(
            serde_json::from_slice::<Value>(&home[1..]).expect("button json"),
            json!({ "button": "home" }),
            "home button payload"
        );
        assert!(
            encode_ios_button(DevicePlatform::Ios, HardwareButton::Back).is_none(),
            "iOS has no Back hardware button"
        );
        let simlock_back = encode_ios_button(DevicePlatform::Android, HardwareButton::Back)
            .expect("Simlock Android back button");
        assert_eq!(
            serde_json::from_slice::<Value>(&simlock_back[1..]).expect("back json"),
            json!({ "button": "back" }),
            "Simlock Android back button payload"
        );

        let key = encode_ios_key(KeyPhase::Down, 0x28);
        assert_eq!(key[0], IOS_MSG_KEY, "key tag must be 0x06");
        assert_eq!(
            serde_json::from_slice::<Value>(&key[1..]).expect("key json"),
            json!({ "type": "down", "usage": 0x28 }),
            "key payload must carry type and HID usage"
        );

        let orient = encode_ios_orientation(DeviceOrientation::LandscapeLeft);
        assert_eq!(
            orient[0], IOS_MSG_ORIENTATION,
            "orientation tag must be 0x07"
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&orient[1..]).expect("orient json"),
            json!({ "orientation": "landscape_left" }),
            "orientation payload"
        );
    }

    #[test]
    fn remaps_ios_coordinates_for_rotated_portrait_framebuffers() {
        let landscape_left = DeviceScreenConfig {
            width: 390,
            height: 844,
            orientation: DeviceOrientation::LandscapeLeft,
            input_unavailable: false,
            screen_id: None,
            supports_hinge_angle: false,
            supports_physical_orientation: false,
            hinge_angle: None,
            hinge_pose: None,
            table_mode: None,
            table_mode_available: None,
        };
        let (rx, ry) = raw_ios_point(DevicePlatform::Ios, Some(&landscape_left), 0.2, 0.8);
        assert!(
            (rx - 0.8).abs() < 1e-9 && (ry - 0.8).abs() < 1e-9,
            "landscape_left maps (x,y) -> (y, 1-x), got ({rx}, {ry})"
        );

        let mut landscape_right = landscape_left.clone();
        landscape_right.orientation = DeviceOrientation::LandscapeRight;
        let (rx, ry) = raw_ios_point(DevicePlatform::Ios, Some(&landscape_right), 0.2, 0.8);
        assert!(
            (rx - 0.2).abs() < 1e-9 && (ry - 0.2).abs() < 1e-9,
            "landscape_right maps (x,y) -> (1-y, x), got ({rx}, {ry})"
        );

        let mut upside_down = landscape_left;
        upside_down.orientation = DeviceOrientation::PortraitUpsideDown;
        let (rx, ry) = raw_ios_point(DevicePlatform::Ios, Some(&upside_down), 0.2, 0.8);
        assert!(
            (rx - 0.8).abs() < 1e-9 && (ry - 0.2).abs() < 1e-9,
            "portrait_upside_down maps (x,y) -> (1-x, 1-y), got ({rx}, {ry})"
        );
    }

    #[test]
    fn maps_hid_and_android_keys_and_chunks_utf8_text() {
        assert_eq!(hid_usage_for_key("a"), Some((0x04, false)), "a -> 0x04");
        assert_eq!(hid_usage_for_key("z"), Some((0x1d, false)), "z -> 0x1d");
        assert_eq!(
            hid_usage_for_key("A"),
            Some((0x04, true)),
            "A -> shifted 0x04"
        );
        assert_eq!(hid_usage_for_key("1"), Some((0x1e, false)), "1 -> 0x1e");
        assert_eq!(hid_usage_for_key("0"), Some((0x27, false)), "0 -> 0x27");
        assert_eq!(
            hid_usage_for_key("enter"),
            Some((0x28, false)),
            "enter -> 0x28"
        );
        assert_eq!(
            hid_usage_for_key("backspace"),
            Some((0x2a, false)),
            "backspace -> 0x2a"
        );
        assert_eq!(hid_usage_for_key("!"), Some((0x1e, true)), "! -> shifted 1");

        assert_eq!(android_keycode_for_key("enter"), Some(66), "enter -> 66");
        assert_eq!(
            android_keycode_for_key("backspace"),
            Some(67),
            "backspace -> 67"
        );
        assert_eq!(android_keycode_for_key("up"), Some(19), "up -> 19");

        // 100 4-byte emoji = 400 bytes -> splits into two <=300 byte chunks without breaking UTF-8.
        let emojis = "🚀".repeat(100);
        let chunks = chunk_android_text(&emojis);
        assert_eq!(
            chunks.len(),
            2,
            "400 bytes of emojis must split into 2 chunks"
        );
        assert!(
            chunks.iter().all(|c| c.len() <= ANDROID_MAX_TEXT_BYTES),
            "every chunk must fit in 300 UTF-8 bytes"
        );
        assert_eq!(
            chunks.concat(),
            emojis,
            "chunks must reconstruct exact string"
        );
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn exchanges_ios_input_packets_with_fake_websocket_server()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let server = tokio::spawn(async move {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                return;
            };
            // Send 0x82 screen config (landscape_left) + 0x83 input admitted.
            let cfg = encode_tagged_json(
                IOS_TAG_SCREEN_CONFIG,
                &json!({ "width": 390, "height": 844, "orientation": "landscape_left" }),
            );
            let _ = ws.send(Message::Binary(cfg.into())).await;
            let _ = ws
                .send(Message::Binary(vec![IOS_TAG_INPUT_ADMITTED].into()))
                .await;

            while let Some(Ok(Message::Binary(data))) = ws.next().await {
                let _ = seen_tx.send(data.to_vec());
            }
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-ws".to_owned(),
            None,
            Some("local".to_owned()),
            None,
        )?;

        let (cmd_tx, mut cmd_rx) = mpsc::channel(16);
        let (ev_tx, mut ev_rx) = mpsc::channel(16);

        let client_task = tokio::spawn(async move {
            run_device_input_ws(
                &access,
                DevicePlatform::Ios,
                false,
                "UDID-1",
                false,
                &mut cmd_rx,
                &ev_tx,
            )
            .await
        });

        // Wait for ScreenConfig + Connected(true).
        let mut saw_connected = false;
        let mut saw_screen = false;
        while !(saw_connected && saw_screen) {
            let ev = tokio::time::timeout(Duration::from_secs(2), ev_rx.recv())
                .await?
                .ok_or("events closed early")?;
            match ev {
                DeviceInputEvent::Connected {
                    connected: true, ..
                } => saw_connected = true,
                DeviceInputEvent::ScreenConfig(cfg) => {
                    assert_eq!(
                        cfg.orientation,
                        DeviceOrientation::LandscapeLeft,
                        "screen config orientation must decode"
                    );
                    saw_screen = true;
                }
                _ => {}
            }
        }

        // Send a touch (must remap via landscape_left), a key, and Home button.
        cmd_tx
            .send(DeviceInputCommand::Touch {
                phase: TouchPhase::Begin,
                x: 0.25,
                y: 0.5,
            })
            .await?;
        cmd_tx
            .send(DeviceInputCommand::IosKey {
                phase: KeyPhase::Down,
                usage: 0x28,
            })
            .await?;
        cmd_tx
            .send(DeviceInputCommand::Button(HardwareButton::Home))
            .await?;

        let p1 = tokio::time::timeout(Duration::from_secs(2), seen_rx.recv())
            .await?
            .ok_or("missing touch packet")?;
        assert_eq!(p1[0], IOS_MSG_TOUCH, "first packet must be touch");
        let p1_json: Value = serde_json::from_slice(&p1[1..])?;
        assert_eq!(
            p1_json,
            json!({ "type": "begin", "x": 0.5, "y": 0.75 }),
            "touch must be rotated from landscape_left to raw portrait"
        );

        let p2 = tokio::time::timeout(Duration::from_secs(2), seen_rx.recv())
            .await?
            .ok_or("missing key packet")?;
        assert_eq!(p2[0], IOS_MSG_KEY, "second packet must be key");

        let p3 = tokio::time::timeout(Duration::from_secs(2), seen_rx.recv())
            .await?
            .ok_or("missing button packet")?;
        assert_eq!(p3[0], IOS_MSG_BUTTON, "third packet must be button");

        drop(cmd_tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), client_task).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
        Ok(())
    }

    #[tokio::test]
    #[expect(
        clippy::panic_in_result_fn,
        reason = "test uses assert! for diffs while propagating setup errors with ?"
    )]
    async fn exchanges_android_input_and_buttons_with_fake_websocket_server()
    -> Result<(), Box<dyn std::error::Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<String>();

        let server = tokio::spawn(async move {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else {
                return;
            };
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let _ = seen_tx.send(text.to_string());
            }
        });

        let access = DeviceHubAccess::from_ticket(
            &Url::parse(&format!("http://{addr}"))?,
            "/api/device-hub",
            "t-emu".to_owned(),
            None,
            Some("local".to_owned()),
            None,
        )?;

        let (cmd_tx, mut cmd_rx) = mpsc::channel(16);
        let (ev_tx, mut ev_rx) = mpsc::channel(16);

        let client_task = tokio::spawn(async move {
            run_device_input_ws(
                &access,
                DevicePlatform::Android,
                false,
                "emulator-5554",
                false,
                &mut cmd_rx,
                &ev_tx,
            )
            .await
        });

        let ev = tokio::time::timeout(Duration::from_secs(2), ev_rx.recv())
            .await?
            .ok_or("missing connected event")?;
        assert!(
            matches!(
                ev,
                DeviceInputEvent::Connected {
                    connected: true,
                    ..
                }
            ),
            "Android socket must emit Connected(true) on open"
        );

        cmd_tx
            .send(DeviceInputCommand::Touch {
                phase: TouchPhase::Begin,
                x: 0.4,
                y: 0.6,
            })
            .await?;
        cmd_tx
            .send(DeviceInputCommand::Button(HardwareButton::Back))
            .await?;
        cmd_tx
            .send(DeviceInputCommand::Button(HardwareButton::Recents))
            .await?;
        cmd_tx
            .send(DeviceInputCommand::AndroidText("hi".to_owned()))
            .await?;

        let mut got = Vec::new();
        for _ in 0..4 {
            let raw = tokio::time::timeout(Duration::from_secs(2), seen_rx.recv())
                .await?
                .ok_or("missing android message")?;
            got.push(serde_json::from_str::<Value>(&raw)?);
        }
        assert_eq!(
            got,
            vec![
                json!({ "type": "touch", "action": "down", "x": 0.4, "y": 0.6 }),
                json!({ "type": "back" }),
                json!({ "type": "recents" }),
                json!({ "type": "text", "text": "hi" }),
            ],
            "Android serve-emu messages must match Conn wire format"
        );

        drop(cmd_tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), client_task).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), server).await;
        Ok(())
    }
}
