//! Live device video stream session (MJPEG decode pipeline on `crate::live::RT` + GPUI frame
//! handoff).
//!
//! Frames are read and decoded off the GPUI main thread, converted to premultiplied 32-bit BGRA
//! for `gpui_kit::RenderImage`, and handed to `DevicePanel` via a single-slot bounded buffer so
//! stale frames are dropped and no repaints occur when no frame arrives.

use std::sync::atomic::{AtomicBool, AtomicI16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conn_client::device_hub::{MjpegStreamError, stream_mjpeg_frames};
use conn_client::{ClientError, Connection, DeviceHubAccess};
use conn_contract::{DeviceOrientation, DevicePlatform};
use gpui_kit::{Bounds, Pixels};
use tokio::sync::{Notify, mpsc};
use tokio::task::AbortHandle;

use super::logic::{DeviceKey, HostKind, default_screen_aspect, fit_device_frame};

/// Retry delay after a transient stream disconnect (`RETRY_DELAY_MS` in Conn's `stream.ts`).
const RETRY_DELAY: Duration = Duration::from_secs(1);

/// Deadline before declaring no video received (`FIRST_FRAME_TIMEOUT_MS` in Conn's `stream.ts`).
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Non-frame events sent from the Tokio stream task to `DevicePanel`.
#[derive(Clone, Debug)]
pub(super) enum StreamUiEvent {
    Status(StreamStatus),
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

/// Latest raw JPEG frame slot feeding the background decoder worker.
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

/// Owns the running Tokio tasks for one active device stream; stops everything on [`Self::stop`]
/// or [`Drop`].
pub(super) struct StreamSessionHandle {
    pub(super) key: StreamTargetKey,
    cancel: Arc<AtomicBool>,
    cancel_notify: Arc<Notify>,
    rotation_deg: Arc<AtomicI16>,
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

    /// Updates the display rotation (degrees: 0, 90, -90, 180) applied during frame decode.
    #[expect(
        dead_code,
        reason = "wired when input socket reports iOS screen orientation"
    )]
    pub(super) fn set_rotation_degrees(&self, deg: i16) {
        self.rotation_deg.store(deg, Ordering::Relaxed);
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

/// Starts a live device stream on `crate::live::RT`.
pub(super) fn start_stream_session(
    conn: Connection,
    key: StreamTargetKey,
) -> (StreamSessionHandle, StreamSessionReceivers) {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_notify = Arc::new(Notify::new());
    let rotation_deg = Arc::new(AtomicI16::new(0));
    let raw_slot = Arc::new(RawFrameSlot::new());
    let decoded_slot = Arc::new(DecodedFrameSlot::default());
    // Capacity 1: multiple decoded frames coalesce into a single GPUI wakeup.
    let (frame_wake_tx, frame_wake_rx) = mpsc::channel::<()>(1);
    let (events_tx, events_rx) = mpsc::channel::<StreamUiEvent>(32);

    let mut abort_handles = Vec::new();
    let rt = crate::live::RT.handle();

    let is_simlock = key.host_kind == Some(HostKind::Simlock);
    if key.platform == DevicePlatform::Android && !is_simlock {
        // Android (`serve-emu`) serves H.264 over WebSocket rather than MJPEG; report cleanly
        // until the VideoToolbox H.264 decoder is attached.
        let h = rt.spawn(async move {
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "Android emulator streaming requires H.264 video decoding.".to_owned(),
                )))
                .await;
        });
        abort_handles.push(h.abort_handle());
    } else if is_simlock {
        // Simlock hosts expose AVCC H.264 only (`serveSimOnly` has no MJPEG).
        let h = rt.spawn(async move {
            let _ = events_tx
                .send(StreamUiEvent::Status(StreamStatus::Error(
                    "Simlock hosts stream H.264 AVCC only (no MJPEG fallback).".to_owned(),
                )))
                .await;
        });
        abort_handles.push(h.abort_handle());
    } else {
        // 1. Background JPEG decode worker (offloads CPU decode to spawn_blocking).
        let decode_task = {
            let cancel = Arc::clone(&cancel);
            let cancel_notify = Arc::clone(&cancel_notify);
            let raw_slot = Arc::clone(&raw_slot);
            let decoded_slot = Arc::clone(&decoded_slot);
            let rotation_deg = Arc::clone(&rotation_deg);
            rt.spawn(async move {
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
        abort_handles.push(decode_task.abort_handle());

        // 2. Network MJPEG reader loop with ticket minting, 401 renewal, and first-frame timeout.
        let reader_task = {
            let cancel = Arc::clone(&cancel);
            let cancel_notify = Arc::clone(&cancel_notify);
            let raw_slot = Arc::clone(&raw_slot);
            let key = key.clone();
            rt.spawn(async move {
                run_mjpeg_reader_loop(conn, key, cancel, cancel_notify, raw_slot, events_tx).await;
            })
        };
        abort_handles.push(reader_task.abort_handle());
    }

    let handle = StreamSessionHandle {
        key,
        cancel,
        cancel_notify,
        rotation_deg,
        abort_handles,
    };
    let receivers = StreamSessionReceivers {
        decoded_slot,
        frame_wake_rx,
        events_rx,
    };
    (handle, receivers)
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
            // Bounded try_send coalesces wakeups when GPUI has not drained the previous frame yet.
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
                // Clean EOF on an MJPEG stream: reconnect after short delay.
                if got_frame_this_pass {
                    connecting_since = tokio::time::Instant::now();
                }
                let _ = events_tx
                    .send(StreamUiEvent::Status(StreamStatus::Connecting(None)))
                    .await;
            }
            Err(MjpegStreamError::Unauthorized) => {
                // Ticket expired or rejected: clear cached access and re-mint immediately.
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "wired when input socket reports iOS screen orientation"
    )
)]
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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "used by pointer coordinate mapping in Step 3")
)]
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

/// Fitted device screen rectangle (in window CSS pixels) inside `viewport` (which already
/// excludes the right controls rail inset), matching `ObjectFit::Contain` / `fitDeviceFrame`.
#[must_use]
#[expect(dead_code, reason = "used by Step 3 pointer coordinate mapping")]
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

#[cfg(test)]
mod tests {
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
        // Pure red JPEG (255, 0, 0) -> in BGRA should have B≈0, G≈0, R≈255, A=255.
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
        // Check first pixel has R in byte 2 and B in byte 0 (BGRA).
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
    fn computes_screen_aspect_and_rotation_like_conn() {
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
    }
}
