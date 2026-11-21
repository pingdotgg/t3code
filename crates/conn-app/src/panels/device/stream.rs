//! Live device video stream (H.264 VideoToolbox preferred with MJPEG fallback), binary/JSON
//! input WebSocket, foreground/event-log SSE, and screenshot capture running on `crate::live::RT`.
//!
//! Video frames are read and decoded off the GPUI main thread, converted to premultiplied 32-bit
//! BGRA for `gpui_kit::RenderImage`, and handed to `DevicePanel` via a single-slot bounded buffer
//! so stale frames are dropped and no repaints occur when no frame arrives.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use conn_client::device_hub::{
    AvccChunk, AvccStreamError, DeviceEventLogEntry, DeviceForegroundInfo, DeviceHubHttpError,
    DeviceInputCommand, DeviceInputEvent, InputWsError, MjpegStreamError, annex_b_to_avcc,
    capture_device_screenshot, normalize_avcc_to_4byte_lengths, parse_avcc_record,
    parse_semu_packet, prime_ios_helper, run_device_input_ws, stream_avcc_chunks,
    stream_device_event_log, stream_device_foreground, stream_mjpeg_frames,
};
use conn_client::{ClientError, Connection, DeviceHubAccess};
use conn_contract::{DeviceOrientation, DevicePlatform};
use gpui_kit::{Bounds, Pixels, Point};
use tokio::sync::{Notify, mpsc};
use tokio::task::AbortHandle;

use super::h264::{VideoToolboxDecoder, rotate_bgra};
use super::logic::{DeviceKey, HostKind, default_screen_aspect, fit_device_frame};

/// Retry delay after a transient stream disconnect (`RETRY_DELAY_MS` in Conn's `stream.ts`).
const RETRY_DELAY: Duration = Duration::from_secs(1);

/// Deadline before declaring no video received (`FIRST_FRAME_TIMEOUT_MS` in Conn's `stream.ts`).
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(15);

/// Capacity of the outgoing device input command channel.
const INPUT_COMMAND_CAPACITY: usize = 128;

/// Bounded H.264 decode queue depth (`SOFT_DECODE_QUEUE` in Conn's `stream.ts`).
const H264_DECODE_QUEUE_CAPACITY: usize = 8;

/// Connection/playback state of the live device screen (`DeviceStreamStatus`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum StreamStatus {
    Connecting(Option<String>),
    Streaming,
    Error(String),
}

/// Screen geometry reported by the device hub or inferred from decoded frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ScreenInfo {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) orientation: DeviceOrientation,
}

/// Decoded video frame in premultiplied 32-bit BGRA pixel order ready for `gpui_kit::RenderImage`.
#[derive(Debug)]
pub(super) struct DecodedFrame {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) bgra: Vec<u8>,
}

/// Key identifying which device stream session is running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StreamTargetKey {
    pub(super) device: DeviceKey,
    pub(super) platform: DevicePlatform,
    pub(super) host_kind: Option<HostKind>,
    pub(super) hub_base_path: String,
}

/// Key identifying which device's event log SSE is running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EventLogKey {
    pub(super) device: DeviceKey,
    pub(super) hub_base_path: String,
}

/// Non-frame events sent from Tokio device hub tasks to `DevicePanel`.
#[derive(Clone, Debug)]
pub(super) enum StreamUiEvent {
    Status(StreamStatus),
    InputConnected {
        connected: bool,
        detail: Option<String>,
    },
    ScreenConfig(ScreenInfo),
    ForegroundApp(Option<DeviceForegroundInfo>),
}

/// Shared latest-decoded-frame slot; overwriting drops stale frames without unbounded queues.
#[derive(Debug, Default)]
pub(super) struct DecodedFrameSlot {
    latest: Mutex<Option<DecodedFrame>>,
}

impl DecodedFrameSlot {
    pub(super) fn store(&self, frame: DecodedFrame) {
        if let Ok(mut guard) = self.latest.lock() {
            *guard = Some(frame);
        }
    }

    pub(super) fn take(&self) -> Option<DecodedFrame> {
        self.latest.lock().ok().and_then(|mut guard| guard.take())
    }
}

/// Latest raw JPEG frame slot feeding the background MJPEG decoder worker.
struct RawFrameSlot {
    latest: Mutex<Option<Vec<u8>>>,
    notify: Notify,
}

impl RawFrameSlot {
    fn new() -> Self {
        Self {
            latest: Mutex::new(None),
            notify: Notify::new(),
        }
    }

    fn push(&self, frame: Vec<u8>) {
        if let Ok(mut guard) = self.latest.lock() {
            *guard = Some(frame);
        }
        self.notify.notify_one();
    }

    fn take(&self) -> Option<Vec<u8>> {
        self.latest.lock().ok().and_then(|mut guard| guard.take())
    }
}

/// Messages sent from the Android `serve-emu` WebSocket to its dedicated H.264 decoder task.
enum AndroidVideoMsg {
    SessionReset,
    Packet(Vec<u8>),
}

/// Owns the running Tokio tasks for one active device stream + input socket + foreground SSE;
/// stops everything on [`Self::stop`] or [`Drop`].
pub(super) struct StreamSessionHandle {
    pub(super) key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    input_tx: mpsc::Sender<DeviceInputCommand>,
    abort_handles: Vec<AbortHandle>,
}

impl std::fmt::Debug for StreamSessionHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamSessionHandle")
            .field("key", &self.key)
            .field("cancelled", &self.cancel.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl StreamSessionHandle {
    /// Signals cooperative cancellation and aborts every spawned Tokio task.
    pub(super) fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.cancel_notify.notify_waiters();
        for handle in self.abort_handles.drain(..) {
            handle.abort();
        }
    }

    /// Queues an input command to the active input WebSocket without blocking the UI thread.
    pub(super) fn send_input(&self, command: DeviceInputCommand) {
        let _ = self.input_tx.try_send(command);
    }
}

impl Drop for StreamSessionHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Receivers consumed by `DevicePanel` on the GPUI executor.
pub(super) struct StreamSessionReceivers {
    pub(super) decoded_slot: Arc<DecodedFrameSlot>,
    pub(super) frame_wake_rx: mpsc::Receiver<()>,
    pub(super) events_rx: mpsc::Receiver<StreamUiEvent>,
}

/// Handle for the on-demand iOS device event log SSE subscription.
pub(super) struct EventLogHandle {
    pub(super) key: EventLogKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    abort_handle: Option<AbortHandle>,
}

impl std::fmt::Debug for EventLogHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EventLogHandle")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

impl EventLogHandle {
    pub(super) fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.cancel_notify.notify_waiters();
        if let Some(handle) = self.abort_handle.take() {
            handle.abort();
        }
    }
}

impl Drop for EventLogHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Batch emitted by the device event log SSE reader.
#[derive(Clone, Debug)]
pub(super) struct EventLogBatch {
    pub(super) entries: Vec<DeviceEventLogEntry>,
    pub(super) reset: bool,
}

/// Starts a live device stream (VideoToolbox H.264 preferred with MJPEG fallback), input
/// WebSocket, and foreground SSE session on `crate::live::RT`.
pub(super) fn start_stream_session(
    conn: Connection,
    key: StreamTargetKey,
) -> (StreamSessionHandle, StreamSessionReceivers) {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_notify = Arc::new(Notify::new());
    let rotation_deg = Arc::new(AtomicI16::new(0));
    let decoded_slot = Arc::new(DecodedFrameSlot::default());
    // Capacity 1: multiple decoded frames coalesce into a single GPUI wakeup.
    let (frame_wake_tx, frame_wake_rx) = mpsc::channel::<()>(1);
    let (events_tx, events_rx) = mpsc::channel::<StreamUiEvent>(64);
    let (input_tx, input_rx) = mpsc::channel::<DeviceInputCommand>(INPUT_COMMAND_CAPACITY);

    let mut abort_handles = Vec::new();
    let rt = crate::live::RT.handle();

    let is_simlock = key.host_kind == Some(HostKind::Simlock);
    let runs_host_commands = key.host_kind.is_some_and(HostKind::runs_host_commands);
    let h264_supported = VideoToolboxDecoder::is_supported();
    let is_android_emu = key.platform == DevicePlatform::Android && !is_simlock;

    // Optional channel delivering Android H.264 SEMU packets from the shared `serve-emu` socket.
    let android_video_tx = if is_android_emu && h264_supported {
        let (tx, rx) = mpsc::channel::<AndroidVideoMsg>(H264_DECODE_QUEUE_CAPACITY);
        let decoder_task = {
            let cancel = Arc::clone(&cancel);
            let decoded_slot = Arc::clone(&decoded_slot);
            let frame_wake_tx = frame_wake_tx.clone();
            let events_tx = events_tx.clone();
            let input_tx = input_tx.clone();
            rt.spawn(async move {
                run_android_h264_decoder_loop(
                    cancel,
                    rx,
                    decoded_slot,
                    frame_wake_tx,
                    events_tx,
                    input_tx,
                )
                .await;
            })
        };
        abort_handles.push(decoder_task.abort_handle());
        Some(tx)
    } else {
        None
    };

    // 1. Input WebSocket loop (iOS `serve-sim` binary WS or Android `serve-emu` JSON+video WS).
    let input_task = {
        let conn = conn.clone();
        let key = key.clone();
        let cancel = Arc::clone(&cancel);
        let cancel_notify = Arc::clone(&cancel_notify);
        let rotation_deg = Arc::clone(&rotation_deg);
        let events_tx = events_tx.clone();
        let input_tx_for_reset = input_tx.clone();
        rt.spawn(async move {
            run_input_ws_loop(
                conn,
                key,
                cancel,
                cancel_notify,
                rotation_deg,
                input_rx,
                input_tx_for_reset,
                android_video_tx,
                events_tx,
            )
            .await;
        })
    };
    abort_handles.push(input_task.abort_handle());

    // 2. Foreground app SSE loop (iOS non-Simlock hosts running host commands).
    if key.platform == DevicePlatform::Ios && runs_host_commands {
        let fg_task = {
            let conn = conn.clone();
            let key = key.clone();
            let cancel = Arc::clone(&cancel);
            let cancel_notify = Arc::clone(&cancel_notify);
            let events_tx = events_tx.clone();
            rt.spawn(async move {
                run_foreground_sse_loop(conn, key, cancel, cancel_notify, events_tx).await;
            })
        };
        abort_handles.push(fg_task.abort_handle());
    }

    // 3. Video stream pipeline:
    // - Android (`serve-emu`): handled over the shared WebSocket above when H.264 is supported.
    // - iOS / Simlock (`serve-sim`): prefer AVCC H.264 via VideoToolbox, falling back to MJPEG on
    //   non-Simlock iOS if AVCC/VideoToolbox fails.
    if is_android_emu {
        if !h264_supported {
            let h = rt.spawn(async move {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Error(
                        "Android emulator video requires macOS VideoToolbox H.264 decoding."
                            .to_owned(),
                    )))
                    .await;
            });
            abort_handles.push(h.abort_handle());
        }
    } else if is_simlock && !h264_supported {
        let h = rt.spawn(async move {
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "Simlock hosts stream H.264 AVCC only (VideoToolbox unavailable).".to_owned(),
                )))
                .await;
        });
        abort_handles.push(h.abort_handle());
    } else {
        let video_task = {
            let cancel = Arc::clone(&cancel);
            let cancel_notify = Arc::clone(&cancel_notify);
            let decoded_slot = Arc::clone(&decoded_slot);
            let rotation_deg = Arc::clone(&rotation_deg);
            let key = key.clone();
            rt.spawn(async move {
                if h264_supported {
                    let fallback = run_serve_sim_avcc_loop(
                        &conn,
                        &key,
                        &cancel,
                        &cancel_notify,
                        &rotation_deg,
                        &decoded_slot,
                        &frame_wake_tx,
                        &events_tx,
                    )
                    .await;
                    if !fallback || is_simlock || cancel.load(Ordering::Relaxed) {
                        return;
                    }
                }
                // Fallback to MJPEG on non-Simlock iOS (Conn's `fallBackToMjpeg`).
                run_mjpeg_with_decoder(
                    conn,
                    key,
                    cancel,
                    cancel_notify,
                    rotation_deg,
                    decoded_slot,
                    frame_wake_tx,
                    events_tx,
                )
                .await;
            })
        };
        abort_handles.push(video_task.abort_handle());
    }

    let handle = StreamSessionHandle {
        key,
        cancel,
        cancel_notify,
        input_tx,
        abort_handles,
    };
    let receivers = StreamSessionReceivers {
        decoded_slot,
        frame_wake_rx,
        events_rx,
    };
    (handle, receivers)
}

/// Starts the on-demand iOS device event log SSE stream on `crate::live::RT`.
pub(super) fn start_event_log_stream(
    conn: Connection,
    key: EventLogKey,
) -> (EventLogHandle, mpsc::Receiver<EventLogBatch>) {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_notify = Arc::new(Notify::new());
    let (tx, rx) = mpsc::channel::<EventLogBatch>(32);

    let task = {
        let cancel = Arc::clone(&cancel);
        let cancel_notify = Arc::clone(&cancel_notify);
        let key = key.clone();
        crate::live::RT.spawn(async move {
            run_event_log_sse_loop(conn, key, cancel, cancel_notify, tx).await;
        })
    };

    let handle = EventLogHandle {
        key,
        cancel,
        cancel_notify,
        abort_handle: Some(task.abort_handle()),
    };
    (handle, rx)
}

/// Captures a PNG screenshot from the device hub on `crate::live::RT` (renewing the ticket once
/// on 401) and writes it to `~/Downloads/<device>-<timestamp>.png`.
pub(super) async fn capture_and_save_screenshot(
    conn: Connection,
    hub_base_path: String,
    host_id: String,
    platform: DevicePlatform,
    device_id: String,
    device_name: String,
) -> Result<PathBuf, String> {
    crate::live::RT
        .spawn(async move {
            let bytes =
                fetch_screenshot_with_retry(&conn, &hub_base_path, &host_id, platform, &device_id)
                    .await?;
            tokio::task::spawn_blocking(move || save_screenshot_bytes(&device_name, &bytes))
                .await
                .map_err(|err| format!("screenshot save task failed: {err}"))?
        })
        .await
        .map_err(|err| format!("screenshot task failed: {err}"))?
}

async fn fetch_screenshot_with_retry(
    conn: &Connection,
    hub_base_path: &str,
    host_id: &str,
    platform: DevicePlatform,
    device_id: &str,
) -> Result<Vec<u8>, String> {
    for attempt in 0..2 {
        let access = conn
            .mint_device_hub_access(hub_base_path, Some(host_id))
            .await
            .map_err(|err| format!("Screenshot capture failed: {err}"))?;
        match capture_device_screenshot(conn.http_client(), &access, platform, device_id).await {
            Ok(bytes) => return Ok(bytes),
            Err(DeviceHubHttpError::Unauthorized) if attempt == 0 => continue,
            Err(err) => return Err(format!("{err}. Try again.")),
        }
    }
    Err("Screenshot capture failed (unauthorized). Try again.".to_owned())
}

fn save_screenshot_bytes(device_name: &str, png_bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = screenshot_output_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Could not prepare screenshot folder: {err}"))?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let path = dir.join(screenshot_filename(device_name, now_ms));
    std::fs::write(&path, png_bytes)
        .map_err(|err| format!("Could not write screenshot file: {err}"))?;
    Ok(path)
}

fn screenshot_output_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        let downloads = PathBuf::from(home).join("Downloads");
        if downloads.is_dir() {
            return downloads;
        }
    }
    std::env::temp_dir()
}

/// Formats a screenshot filename matching Conn's `DeviceWorkspace.tsx:73`.
#[must_use]
pub(super) fn screenshot_filename(device_name: &str, timestamp_ms: u128) -> String {
    let sanitized: String = device_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let prefix = if sanitized.is_empty() {
        "device"
    } else {
        sanitized.as_str()
    };
    format!("{prefix}-{timestamp_ms}.png")
}

/// Streams `serve-sim` AVCC H.264 frames and decodes them with macOS VideoToolbox.
///
/// Returns `true` if the caller should fall back to MJPEG (e.g. decoder unsupported or AVCC
/// endpoint missing on non-Simlock iOS), or `false` if cancelled or terminal.
#[expect(
    clippy::too_many_arguments,
    reason = "internal async driver loop wiring shared stream channels and atomics"
)]
async fn run_serve_sim_avcc_loop(
    conn: &Connection,
    key: &StreamTargetKey,
    cancel: &Arc<AtomicBool>,
    cancel_notify: &Arc<Notify>,
    rotation_deg: &Arc<AtomicI16>,
    decoded_slot: &Arc<DecodedFrameSlot>,
    frame_wake_tx: &mpsc::Sender<()>,
    events_tx: &mpsc::Sender<StreamUiEvent>,
) -> bool {
    let is_simlock = key.host_kind == Some(HostKind::Simlock);
    let mut cached_access: Option<DeviceHubAccess> = None;
    let mut saw_any_frame = false;
    let mut connecting_since = tokio::time::Instant::now();

    let _ = events_tx
        .send(StreamUiEvent::Status(StreamStatus::Connecting(None)))
        .await;

    while !cancel.load(Ordering::Relaxed) {
        if !saw_any_frame && connecting_since.elapsed() >= FIRST_FRAME_TIMEOUT {
            if !is_simlock {
                return true;
            }
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "No video received from the device. Reconnect to try again.".to_owned(),
                )))
                .await;
            return false;
        }

        let access = match cached_access.clone() {
            Some(existing) => existing,
            None => match conn
                .mint_device_hub_access(&key.hub_base_path, Some(&key.device.host_id))
                .await
            {
                Ok(fresh) => {
                    cached_access = Some(fresh.clone());
                    fresh
                }
                Err(ClientError::Auth(msg)) => {
                    let _ = events_tx
                        .send(StreamUiEvent::Status(StreamStatus::Error(msg)))
                        .await;
                    return false;
                }
                Err(err) => {
                    let _ = events_tx
                        .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(
                            err.to_string(),
                        ))))
                        .await;
                    if !sleep_or_cancel(RETRY_DELAY, cancel, cancel_notify).await {
                        return false;
                    }
                    continue;
                }
            },
        };

        // Dedicated blocking worker owns the `VideoToolboxDecoder` for this AVCC stream pass.
        let (chunk_tx, mut chunk_rx) = mpsc::channel::<AvccChunk>(H264_DECODE_QUEUE_CAPACITY);
        let fallback_flag = Arc::new(AtomicBool::new(false));
        let got_frame_flag = Arc::new(AtomicBool::new(false));
        let decode_worker = {
            let cancel = Arc::clone(cancel);
            let rotation_deg = Arc::clone(rotation_deg);
            let decoded_slot = Arc::clone(decoded_slot);
            let frame_wake_tx = frame_wake_tx.clone();
            let fallback_flag = Arc::clone(&fallback_flag);
            let got_frame_flag = Arc::clone(&got_frame_flag);
            tokio::task::spawn_blocking(move || {
                let mut decoder: Option<VideoToolboxDecoder> = None;
                let mut nal_length_size: u8 = 4;
                let mut awaiting_keyframe = true;
                let mut decoded_h264 = false;

                while let Some(chunk) = chunk_rx.blocking_recv() {
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    match chunk {
                        AvccChunk::Seed(jpeg) => {
                            if !decoded_h264 {
                                let rot = rotation_deg.load(Ordering::Relaxed);
                                if let Some(frame) = decode_jpeg_to_bgra(&jpeg, rot) {
                                    got_frame_flag.store(true, Ordering::Relaxed);
                                    decoded_slot.store(frame);
                                    let _ = frame_wake_tx.try_send(());
                                }
                            }
                        }
                        AvccChunk::Description(avcc) => {
                            awaiting_keyframe = true;
                            match parse_avcc_record(&avcc).and_then(|cfg| {
                                nal_length_size = cfg.nal_length_size;
                                VideoToolboxDecoder::new(&cfg.sps, &cfg.pps).ok()
                            }) {
                                Some(dec) => decoder = Some(dec),
                                None => {
                                    fallback_flag.store(true, Ordering::Relaxed);
                                    break;
                                }
                            }
                        }
                        AvccChunk::Keyframe(ref data) | AvccChunk::Delta(ref data) => {
                            let is_key = matches!(chunk, AvccChunk::Keyframe(_));
                            if awaiting_keyframe {
                                if !is_key {
                                    continue;
                                }
                                awaiting_keyframe = false;
                            }
                            let Some(dec) = decoder.as_mut() else {
                                continue;
                            };
                            let Some(normalized) =
                                normalize_avcc_to_4byte_lengths(data, nal_length_size)
                            else {
                                continue;
                            };
                            match dec.decode_avcc(&normalized) {
                                Ok(Some(frame)) => {
                                    decoded_h264 = true;
                                    got_frame_flag.store(true, Ordering::Relaxed);
                                    let rot = rotation_deg.load(Ordering::Relaxed);
                                    decoded_slot.store(rotate_bgra(frame, rot));
                                    let _ = frame_wake_tx.try_send(());
                                }
                                Ok(None) => {}
                                Err(_) => {
                                    fallback_flag.store(true, Ordering::Relaxed);
                                    break;
                                }
                            }
                        }
                    }
                }
            })
        };

        let mut fell_behind = false;
        let stream_fut = stream_avcc_chunks(
            conn.http_client(),
            &access,
            &key.device.device_id,
            |chunk| {
                if cancel.load(Ordering::Relaxed) || fallback_flag.load(Ordering::Relaxed) {
                    return false;
                }
                match chunk_tx.try_send(chunk) {
                    Ok(()) => true,
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        // Queue exceeded SOFT_DECODE_QUEUE: reconnect AVCC to acquire a fresh IDR.
                        fell_behind = true;
                        false
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => false,
                }
            },
        );

        let outcome = tokio::select! {
            res = stream_fut => res,
            () = cancel_notify.notified() => {
                drop(chunk_tx);
                let _ = decode_worker.await;
                return false;
            }
        };
        drop(chunk_tx);
        let _ = decode_worker.await;

        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        if got_frame_flag.load(Ordering::Relaxed) {
            saw_any_frame = true;
            connecting_since = tokio::time::Instant::now();
        }
        if fallback_flag.load(Ordering::Relaxed) {
            if !is_simlock {
                return true;
            }
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "VideoToolbox could not decode this device's H.264 stream.".to_owned(),
                )))
                .await;
            return false;
        }

        match outcome {
            Ok(()) => {
                let detail =
                    fell_behind.then(|| "Video decoder fell behind. Reconnecting…".to_owned());
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(detail)))
                    .await;
            }
            Err(AvccStreamError::Unauthorized) => {
                cached_access = None;
                continue;
            }
            Err(AvccStreamError::TransportLockedWebRtc) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Error(
                        "This device streams WebRTC only, which conn-gpui does not yet support."
                            .to_owned(),
                    )))
                    .await;
                return false;
            }
            Err(AvccStreamError::HttpStatus(404 | 405 | 501)) if !is_simlock => {
                // Older hub without `stream.avcc`: fall back to MJPEG cleanly.
                return true;
            }
            Err(AvccStreamError::InvalidUrl(err)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Error(err.to_string())))
                    .await;
                return false;
            }
            Err(AvccStreamError::HttpStatus(code)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(
                        format!("Stream returned HTTP {code}. Reconnecting…"),
                    ))))
                    .await;
            }
            Err(AvccStreamError::Network(msg)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(msg))))
                    .await;
            }
        }

        if !sleep_or_cancel(RETRY_DELAY, cancel, cancel_notify).await {
            return false;
        }
    }
    false
}

/// Runs the dedicated Android `serve-emu` H.264 Annex-B decoder on a blocking thread.
async fn run_android_h264_decoder_loop(
    cancel: Arc<AtomicBool>,
    mut rx: mpsc::Receiver<AndroidVideoMsg>,
    decoded_slot: Arc<DecodedFrameSlot>,
    frame_wake_tx: mpsc::Sender<()>,
    events_tx: mpsc::Sender<StreamUiEvent>,
    input_tx: mpsc::Sender<DeviceInputCommand>,
) {
    let _ = tokio::task::spawn_blocking(move || {
        let mut decoder: Option<VideoToolboxDecoder> = None;
        let mut last_sps: Vec<Vec<u8>> = Vec::new();
        let mut last_pps: Vec<Vec<u8>> = Vec::new();
        let mut awaiting_keyframe = true;
        let mut last_dims: Option<(u32, u32)> = None;
        let mut last_keyframe_req = std::time::Instant::now()
            .checked_sub(Duration::from_secs(5))
            .unwrap_or_else(std::time::Instant::now);

        while let Some(msg) = rx.blocking_recv() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            match msg {
                AndroidVideoMsg::SessionReset => {
                    decoder = None;
                    last_sps.clear();
                    last_pps.clear();
                    awaiting_keyframe = true;
                    let _ =
                        events_tx.try_send(StreamUiEvent::Status(StreamStatus::Connecting(None)));
                    let _ = input_tx.try_send(DeviceInputCommand::AndroidResetVideo);
                }
                AndroidVideoMsg::Packet(raw) => {
                    let semu = parse_semu_packet(&raw);
                    let parsed = annex_b_to_avcc(semu.data);
                    let is_key = semu.is_key.unwrap_or(parsed.is_key);

                    let mut params_changed = false;
                    if !parsed.sps.is_empty() && parsed.sps != last_sps {
                        last_sps = parsed.sps;
                        params_changed = true;
                    }
                    if !parsed.pps.is_empty() && parsed.pps != last_pps {
                        last_pps = parsed.pps;
                        params_changed = true;
                    }

                    if (decoder.is_none() || params_changed)
                        && !last_sps.is_empty()
                        && !last_pps.is_empty()
                    {
                        match VideoToolboxDecoder::new(&last_sps, &last_pps) {
                            Ok(dec) => {
                                decoder = Some(dec);
                                awaiting_keyframe = true;
                            }
                            Err(err) => {
                                let _ = events_tx.try_send(StreamUiEvent::Status(
                                    StreamStatus::Error(format!("Video decoder: {err}")),
                                ));
                                decoder = None;
                                continue;
                            }
                        }
                    }

                    let Some(dec) = decoder.as_mut() else {
                        if !is_key && last_keyframe_req.elapsed() >= Duration::from_millis(500) {
                            last_keyframe_req = std::time::Instant::now();
                            let _ = input_tx.try_send(DeviceInputCommand::AndroidResetVideo);
                        }
                        continue;
                    };

                    if parsed.avcc_sample.is_empty() {
                        continue;
                    }
                    if awaiting_keyframe {
                        if !is_key {
                            if last_keyframe_req.elapsed() >= Duration::from_millis(500) {
                                last_keyframe_req = std::time::Instant::now();
                                let _ = input_tx.try_send(DeviceInputCommand::AndroidResetVideo);
                            }
                            continue;
                        }
                        awaiting_keyframe = false;
                    }

                    match dec.decode_avcc(&parsed.avcc_sample) {
                        Ok(Some(frame)) => {
                            let dims = (frame.width, frame.height);
                            if last_dims != Some(dims) {
                                last_dims = Some(dims);
                                let orientation = if frame.width > frame.height {
                                    DeviceOrientation::LandscapeLeft
                                } else {
                                    DeviceOrientation::Portrait
                                };
                                let _ =
                                    events_tx.try_send(StreamUiEvent::ScreenConfig(ScreenInfo {
                                        width: frame.width,
                                        height: frame.height,
                                        orientation,
                                    }));
                            }
                            decoded_slot.store(frame);
                            let _ = frame_wake_tx.try_send(());
                        }
                        Ok(None) => {}
                        Err(_) => {
                            decoder = None;
                            awaiting_keyframe = true;
                            let _ = events_tx.try_send(StreamUiEvent::Status(
                                StreamStatus::Connecting(Some(
                                    "Video decoder restarted.".to_owned(),
                                )),
                            ));
                            let _ = input_tx.try_send(DeviceInputCommand::AndroidResetVideo);
                        }
                    }
                }
            }
        }
    })
    .await;
}

#[expect(
    clippy::too_many_arguments,
    reason = "internal async driver wiring shared input/video channels"
)]
async fn run_input_ws_loop(
    conn: Connection,
    key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    rotation_deg: Arc<AtomicI16>,
    mut cmd_rx: mpsc::Receiver<DeviceInputCommand>,
    input_tx_for_reset: mpsc::Sender<DeviceInputCommand>,
    android_video_tx: Option<mpsc::Sender<AndroidVideoMsg>>,
    events_tx: mpsc::Sender<StreamUiEvent>,
) {
    let serve_sim_only = key.host_kind == Some(HostKind::Simlock);
    let enable_android_video = android_video_tx.is_some();

    while !cancel.load(Ordering::Relaxed) {
        let access = match conn
            .mint_device_hub_access(&key.hub_base_path, Some(&key.device.host_id))
            .await
        {
            Ok(fresh) => fresh,
            Err(ClientError::Auth(msg)) => {
                let _ = events_tx
                    .send(StreamUiEvent::InputConnected {
                        connected: false,
                        detail: Some(msg),
                    })
                    .await;
                return;
            }
            Err(_) => {
                if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
                    return;
                }
                continue;
            }
        };

        if key.platform == DevicePlatform::Ios && !serve_sim_only {
            let prime_outcome = tokio::select! {
                res = prime_ios_helper(conn.http_client(), &access, &key.device.device_id) => res,
                () = cancel_notify.notified() => return,
            };
            if matches!(prime_outcome, Err(InputWsError::Unauthorized)) {
                continue;
            }
        }

        let (ws_ev_tx, mut ws_ev_rx) = mpsc::channel::<DeviceInputEvent>(32);
        let forwarder = {
            let events_tx = events_tx.clone();
            let rotation_deg = Arc::clone(&rotation_deg);
            let platform = key.platform;
            let android_video_tx = android_video_tx.clone();
            let input_tx_for_reset = input_tx_for_reset.clone();
            tokio::spawn(async move {
                while let Some(ev) = ws_ev_rx.recv().await {
                    match ev {
                        DeviceInputEvent::Connected { connected, detail } => {
                            let _ = events_tx
                                .send(StreamUiEvent::InputConnected { connected, detail })
                                .await;
                        }
                        DeviceInputEvent::ScreenConfig(cfg) => {
                            let info = ScreenInfo {
                                width: cfg.width,
                                height: cfg.height,
                                orientation: cfg.orientation,
                            };
                            rotation_deg.store(
                                screen_rotation_degrees(platform, Some(info)),
                                Ordering::Relaxed,
                            );
                            let _ = events_tx.send(StreamUiEvent::ScreenConfig(info)).await;
                        }
                        DeviceInputEvent::AndroidVideoSession => {
                            if let Some(vtx) = &android_video_tx {
                                let _ = vtx.try_send(AndroidVideoMsg::SessionReset);
                            }
                        }
                        DeviceInputEvent::AndroidVideoPacket(raw) => {
                            if let Some(vtx) = &android_video_tx
                                && let Err(mpsc::error::TrySendError::Full(_)) =
                                    vtx.try_send(AndroidVideoMsg::Packet(raw))
                            {
                                // Drop stale queued packets and request a fresh keyframe.
                                let _ = input_tx_for_reset
                                    .try_send(DeviceInputCommand::AndroidResetVideo);
                            }
                        }
                    }
                }
            })
        };

        let ws_fut = run_device_input_ws(
            &access,
            key.platform,
            serve_sim_only,
            &key.device.device_id,
            enable_android_video,
            &mut cmd_rx,
            &ws_ev_tx,
        );
        let outcome = tokio::select! {
            res = ws_fut => res,
            () = cancel_notify.notified() => {
                forwarder.abort();
                return;
            }
        };
        drop(ws_ev_tx);
        let _ = forwarder.await;

        if cancel.load(Ordering::Relaxed) {
            return;
        }

        if let Some(vtx) = &android_video_tx {
            let _ = vtx.try_send(AndroidVideoMsg::SessionReset);
        }

        match outcome {
            Ok(()) => return,
            Err(InputWsError::Unauthorized) => {
                continue;
            }
            Err(InputWsError::InvalidUrl(err)) => {
                let _ = events_tx
                    .send(StreamUiEvent::InputConnected {
                        connected: false,
                        detail: Some(err.to_string()),
                    })
                    .await;
                return;
            }
            Err(InputWsError::Connection(detail)) => {
                let _ = events_tx
                    .send(StreamUiEvent::InputConnected {
                        connected: false,
                        detail: Some(detail),
                    })
                    .await;
            }
        }

        if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
            return;
        }
    }
}

async fn run_foreground_sse_loop(
    conn: Connection,
    key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    events_tx: mpsc::Sender<StreamUiEvent>,
) {
    let mut cached_access: Option<DeviceHubAccess> = None;
    while !cancel.load(Ordering::Relaxed) {
        let access = match cached_access.clone() {
            Some(existing) => existing,
            None => match conn
                .mint_device_hub_access(&key.hub_base_path, Some(&key.device.host_id))
                .await
            {
                Ok(fresh) => {
                    cached_access = Some(fresh.clone());
                    fresh
                }
                Err(ClientError::Auth(_)) => return,
                Err(_) => {
                    if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
                        return;
                    }
                    continue;
                }
            },
        };

        let fut =
            stream_device_foreground(conn.http_client(), &access, &key.device.device_id, |app| {
                if cancel.load(Ordering::Relaxed) {
                    return false;
                }
                let _ = events_tx.try_send(StreamUiEvent::ForegroundApp(app));
                true
            });
        let outcome = tokio::select! {
            res = fut => res,
            () = cancel_notify.notified() => return,
        };
        if matches!(outcome, Err(DeviceHubHttpError::Unauthorized)) {
            cached_access = None;
            continue;
        }
        if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
            return;
        }
    }
}

async fn run_event_log_sse_loop(
    conn: Connection,
    key: EventLogKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    tx: mpsc::Sender<EventLogBatch>,
) {
    let mut cached_access: Option<DeviceHubAccess> = None;
    while !cancel.load(Ordering::Relaxed) {
        let access = match cached_access.clone() {
            Some(existing) => existing,
            None => match conn
                .mint_device_hub_access(&key.hub_base_path, Some(&key.device.host_id))
                .await
            {
                Ok(fresh) => {
                    cached_access = Some(fresh.clone());
                    fresh
                }
                Err(ClientError::Auth(_)) => return,
                Err(_) => {
                    if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
                        return;
                    }
                    continue;
                }
            },
        };

        let fut = stream_device_event_log(
            conn.http_client(),
            &access,
            &key.device.device_id,
            |entries, reset| {
                if cancel.load(Ordering::Relaxed) {
                    return false;
                }
                tx.try_send(EventLogBatch { entries, reset }).is_ok()
            },
        );
        let outcome = tokio::select! {
            res = fut => res,
            () = cancel_notify.notified() => return,
        };
        if matches!(outcome, Err(DeviceHubHttpError::Unauthorized)) {
            cached_access = None;
            continue;
        }
        if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
            return;
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "internal async fallback driver coordinating reader and decode worker"
)]
async fn run_mjpeg_with_decoder(
    conn: Connection,
    key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    rotation_deg: Arc<AtomicI16>,
    decoded_slot: Arc<DecodedFrameSlot>,
    frame_wake_tx: mpsc::Sender<()>,
    events_tx: mpsc::Sender<StreamUiEvent>,
) {
    let raw_slot = Arc::new(RawFrameSlot::new());
    let decode_handle = {
        let cancel = Arc::clone(&cancel);
        let cancel_notify = Arc::clone(&cancel_notify);
        let raw_slot = Arc::clone(&raw_slot);
        let decoded_slot = Arc::clone(&decoded_slot);
        let rotation_deg = Arc::clone(&rotation_deg);
        tokio::spawn(async move {
            run_jpeg_decoder_loop(
                cancel,
                cancel_notify,
                raw_slot,
                decoded_slot,
                rotation_deg,
                frame_wake_tx,
            )
            .await;
        })
    };

    run_mjpeg_reader_loop(conn, key, cancel, cancel_notify, raw_slot, events_tx).await;
    decode_handle.abort();
}

async fn run_jpeg_decoder_loop(
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    raw_slot: Arc<RawFrameSlot>,
    decoded_slot: Arc<DecodedFrameSlot>,
    rotation_deg: Arc<AtomicI16>,
    frame_wake_tx: mpsc::Sender<()>,
) {
    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let next_raw = match raw_slot.take() {
            Some(bytes) => bytes,
            None => {
                tokio::select! {
                    () = raw_slot.notify.notified() => continue,
                    () = cancel_notify.notified() => break,
                }
            }
        };
        let rot = rotation_deg.load(Ordering::Relaxed);
        let decoded = tokio::task::spawn_blocking(move || decode_jpeg_to_bgra(&next_raw, rot))
            .await
            .ok()
            .flatten();
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if let Some(frame) = decoded {
            decoded_slot.store(frame);
            let _ = frame_wake_tx.try_send(());
        }
    }
}

async fn run_mjpeg_reader_loop(
    conn: Connection,
    key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    raw_slot: Arc<RawFrameSlot>,
    events_tx: mpsc::Sender<StreamUiEvent>,
) {
    let mut cached_access: Option<DeviceHubAccess> = None;
    let mut saw_any_frame = false;
    let mut connecting_since = tokio::time::Instant::now();

    let _ = events_tx
        .send(StreamUiEvent::Status(StreamStatus::Connecting(None)))
        .await;

    while !cancel.load(Ordering::Relaxed) {
        if !saw_any_frame && connecting_since.elapsed() >= FIRST_FRAME_TIMEOUT {
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "No video received from the device. Reconnect to try again.".to_owned(),
                )))
                .await;
            return;
        }

        let access = match cached_access.clone() {
            Some(existing) => existing,
            None => match conn
                .mint_device_hub_access(&key.hub_base_path, Some(&key.device.host_id))
                .await
            {
                Ok(fresh) => {
                    cached_access = Some(fresh.clone());
                    fresh
                }
                Err(ClientError::Auth(msg)) => {
                    let _ = events_tx
                        .send(StreamUiEvent::Status(StreamStatus::Error(msg)))
                        .await;
                    return;
                }
                Err(err) => {
                    let _ = events_tx
                        .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(
                            err.to_string(),
                        ))))
                        .await;
                    if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
                        return;
                    }
                    continue;
                }
            },
        };

        let mut got_frame_this_pass = false;
        let stream_fut =
            stream_mjpeg_frames(conn.http_client(), &access, &key.device.device_id, |jpeg| {
                if cancel.load(Ordering::Relaxed) {
                    return false;
                }
                got_frame_this_pass = true;
                saw_any_frame = true;
                raw_slot.push(jpeg);
                true
            });

        let outcome = tokio::select! {
            res = stream_fut => res,
            () = cancel_notify.notified() => return,
        };

        if cancel.load(Ordering::Relaxed) {
            return;
        }

        match outcome {
            Ok(()) => {
                if got_frame_this_pass {
                    connecting_since = tokio::time::Instant::now();
                }
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(None)))
                    .await;
            }
            Err(MjpegStreamError::Unauthorized) => {
                cached_access = None;
                continue;
            }
            Err(MjpegStreamError::TransportLockedWebRtc) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Error(
                        "This device streams WebRTC only, which conn-gpui does not yet support."
                            .to_owned(),
                    )))
                    .await;
                return;
            }
            Err(MjpegStreamError::InvalidUrl(err)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Error(err.to_string())))
                    .await;
                return;
            }
            Err(MjpegStreamError::HttpStatus(code)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(
                        format!("Stream returned HTTP {code}. Reconnecting…"),
                    ))))
                    .await;
            }
            Err(MjpegStreamError::Network(msg)) => {
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(Some(msg))))
                    .await;
            }
        }

        if !saw_any_frame && connecting_since.elapsed() >= FIRST_FRAME_TIMEOUT {
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "No video received from the device. Reconnect to try again.".to_owned(),
                )))
                .await;
            return;
        }

        if !sleep_or_cancel(RETRY_DELAY, &cancel, &cancel_notify).await {
            return;
        }
    }
}

async fn sleep_or_cancel(delay: Duration, cancel: &AtomicBool, notify: &Notify) -> bool {
    if cancel.load(Ordering::Relaxed) {
        return false;
    }
    tokio::select! {
        () = tokio::time::sleep(delay) => !cancel.load(Ordering::Relaxed),
        () = notify.notified() => false,
    }
}

/// Decodes a JPEG payload into a premultiplied BGRA [`DecodedFrame`], optionally rotating
/// 90° CW (`90`), 90° CCW (`-90`), or 180° (`180`) to match `DeviceStreamView`'s iOS rotation.
#[must_use]
pub(super) fn decode_jpeg_to_bgra(jpeg: &[u8], rotation_deg: i16) -> Option<DecodedFrame> {
    let decoded = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
        .or_else(|_| image::load_from_memory(jpeg))
        .ok()?;
    let oriented = match rotation_deg {
        90 => decoded.rotate90(),
        -90 | 270 => decoded.rotate270(),
        180 | -180 => decoded.rotate180(),
        _ => decoded,
    };
    let mut rgba = oriented.to_rgba8();
    // GPUI `RenderImage` stores premultiplied 32-bit BGRA pixels inside `image::RgbaImage`.
    for pixel in rgba.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let width = rgba.width();
    let height = rgba.height();
    Some(DecodedFrame {
        width,
        height,
        bgra: rgba.into_raw(),
    })
}

/// Display rotation in degrees for raw portrait `serve-sim` framebuffers (`screenRotation` in
/// `DeviceStreamView.tsx`).
#[must_use]
pub(super) const fn screen_rotation_degrees(
    platform: DevicePlatform,
    screen: Option<ScreenInfo>,
) -> i16 {
    let Some(screen) = screen else {
        return 0;
    };
    if !matches!(platform, DevicePlatform::Ios) || screen.width > screen.height {
        return 0;
    }
    match screen.orientation {
        DeviceOrientation::LandscapeLeft => 90,
        DeviceOrientation::LandscapeRight => -90,
        DeviceOrientation::PortraitUpsideDown => 180,
        DeviceOrientation::Portrait => 0,
    }
}

/// Displayed aspect ratio (`width / height`) matching `screenAspect` in `DeviceStreamView.tsx`.
#[must_use]
pub(super) fn screen_aspect(
    platform: DevicePlatform,
    screen: Option<ScreenInfo>,
    frame_size: Option<(u32, u32)>,
) -> f32 {
    if let Some(screen) = screen
        && screen.width > 0
        && screen.height > 0
    {
        let landscape = matches!(
            screen.orientation,
            DeviceOrientation::LandscapeLeft | DeviceOrientation::LandscapeRight
        );
        let (w, h) = if landscape {
            (
                screen.width.max(screen.height) as f32,
                screen.width.min(screen.height) as f32,
            )
        } else {
            (
                screen.width.min(screen.height) as f32,
                screen.width.max(screen.height) as f32,
            )
        };
        return w / h;
    }
    if let Some((w, h)) = frame_size
        && w > 0
        && h > 0
    {
        return w as f32 / h as f32;
    }
    default_screen_aspect(platform)
}

/// Fitted device screen rectangle `(x, y, width, height)` in window pixels inside `viewport`
/// (which already excludes the right controls rail inset), matching `ObjectFit::Contain`.
#[must_use]
pub(super) fn fitted_frame_rect(viewport: Bounds<Pixels>, aspect: f32) -> (f32, f32, f32, f32) {
    let vx = f32::from(viewport.origin.x);
    let vy = f32::from(viewport.origin.y);
    let vw = f32::from(viewport.size.width);
    let vh = f32::from(viewport.size.height);
    let fitted = fit_device_frame(aspect, vw, vh, 0.0);
    let x = vx + (vw - fitted.width) * 0.5;
    let y = vy + (vh - fitted.height) * 0.5;
    (x, y, fitted.width, fitted.height)
}

/// Maps a GPUI window pointer coordinate into normalized `[0.0, 1.0]` coordinates inside the
/// aspect-fitted device frame. When `clamp_outside` is `false`, returns `None` for clicks in the
/// letterbox/pillarbox margins.
#[must_use]
pub(super) fn map_window_point_to_screen(
    pos: Point<Pixels>,
    viewport: Bounds<Pixels>,
    aspect: f32,
    clamp_outside: bool,
) -> Option<(f64, f64)> {
    let (fx, fy, fw, fh) = fitted_frame_rect(viewport, aspect);
    if fw <= 0.0 || fh <= 0.0 {
        return None;
    }
    let nx = f64::from((f32::from(pos.x) - fx) / fw);
    let ny = f64::from((f32::from(pos.y) - fy) / fh);
    if !clamp_outside && (!(0.0..=1.0).contains(&nx) || !(0.0..=1.0).contains(&ny)) {
        return None;
    }
    Some((nx.clamp(0.0, 1.0), ny.clamp(0.0, 1.0)))
}

#[cfg(test)]
mod tests {
    use gpui_kit::{point, px, size};
    use image::codecs::jpeg::JpegEncoder;
    use image::{Rgb, RgbImage};

    use super::*;

    fn encode_test_jpeg(width: u32, height: u32, r: u8, g: u8, b: u8) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb([r, g, b]));
        let mut out = Vec::new();
        let mut enc = JpegEncoder::new_with_quality(&mut out, 100);
        let _ = enc.encode_image(&img);
        out
    }

    #[test]
    fn decodes_jpeg_to_bgra_and_rotates_landscape() {
        let jpeg = encode_test_jpeg(16, 32, 250, 10, 20);
        let Some(frame) = decode_jpeg_to_bgra(&jpeg, 0) else {
            panic!("synthetic JPEG must decode");
        };
        assert_eq!(
            (frame.width, frame.height),
            (16, 32),
            "unrotated dimensions must match input JPEG"
        );
        assert_eq!(
            frame.bgra.len(),
            16 * 32 * 4,
            "BGRA buffer must hold 4 bytes per pixel"
        );
        assert!(
            frame.bgra[2] > 200 && frame.bgra[0] < 60 && frame.bgra[3] == 255,
            "expected BGRA with high R at index 2, got {:?}",
            &frame.bgra[..4]
        );

        let Some(rotated) = decode_jpeg_to_bgra(&jpeg, 90) else {
            panic!("90-degree rotated JPEG must decode");
        };
        assert_eq!(
            (rotated.width, rotated.height),
            (32, 16),
            "90-degree rotation must transpose portrait dimensions to landscape"
        );
    }

    #[test]
    fn decoded_frame_slot_drops_stale_frames() {
        let slot = DecodedFrameSlot::default();
        slot.store(DecodedFrame {
            width: 10,
            height: 20,
            bgra: vec![1; 10 * 20 * 4],
        });
        slot.store(DecodedFrame {
            width: 30,
            height: 40,
            bgra: vec![2; 30 * 40 * 4],
        });
        let Some(latest) = slot.take() else {
            panic!("slot must return latest frame");
        };
        assert_eq!(
            (latest.width, latest.height),
            (30, 40),
            "slot must overwrite stale frame with newest"
        );
        assert!(
            slot.take().is_none(),
            "second take without new frame must be empty"
        );
    }

    #[test]
    fn computes_screen_aspect_rotation_and_pointer_mapping() {
        let portrait = ScreenInfo {
            width: 390,
            height: 844,
            orientation: DeviceOrientation::Portrait,
        };
        assert_eq!(
            screen_rotation_degrees(DevicePlatform::Ios, Some(portrait)),
            0,
            "portrait iOS needs no rotation"
        );
        let landscape = ScreenInfo {
            width: 390,
            height: 844,
            orientation: DeviceOrientation::LandscapeLeft,
        };
        assert_eq!(
            screen_rotation_degrees(DevicePlatform::Ios, Some(landscape)),
            90,
            "raw portrait serve-sim buffer in landscape_left must rotate 90deg"
        );
        let aspect = screen_aspect(DevicePlatform::Ios, Some(landscape), None);
        assert!(
            aspect > 2.0,
            "landscape aspect must be width/height > 1, got {aspect}"
        );

        let viewport = Bounds {
            origin: point(px(100.0), px(50.0)),
            size: size(px(400.0), px(400.0)),
        };
        assert!(
            map_window_point_to_screen(point(px(150.0), px(250.0)), viewport, 0.5, false).is_none(),
            "click in left pillarbox margin must be ignored when not clamping"
        );
        let center = map_window_point_to_screen(point(px(300.0), px(250.0)), viewport, 0.5, false)
            .expect("center click inside fitted frame");
        assert!(
            (center.0 - 0.5).abs() < 1e-6 && (center.1 - 0.5).abs() < 1e-6,
            "center of fitted frame must map to (0.5, 0.5), got {center:?}"
        );
        let clamped = map_window_point_to_screen(point(px(120.0), px(500.0)), viewport, 0.5, true)
            .expect("clamped drag outside frame");
        assert_eq!(
            clamped,
            (0.0, 1.0),
            "drag outside frame must clamp to [0, 1]"
        );
    }

    #[test]
    fn sanitizes_screenshot_filename_like_conn() {
        assert_eq!(
            screenshot_filename("iPhone 16 Pro (iOS 18)", 1_700_000_000_000),
            "iPhone-16-Pro--iOS-18--1700000000000.png",
            "screenshot filename must sanitize non-alphanumeric characters to hyphens"
        );
    }
}
