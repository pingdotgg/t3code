//! Screen and window capture, shared by every non-macOS backend.
//!
//! `xcap` already abstracts Windows' DXGI/GDI path and Linux's X11 path, so the
//! only platform-aware part left is which window belongs to which pid.
//!
//! On Linux hybrid sessions (Wayland + X11), we never mutate `WAYLAND_DISPLAY`:
//! that is UB with concurrent threads. Window enumeration already goes through
//! X11/`xcb` when `DISPLAY` is set. Display capture uses `xcap` first; if its
//! Wayland path fails, we fall back to `grim` without touching the environment.

use image::{ImageEncoder, RgbaImage, codecs::png::PngEncoder, imageops::FilterType};
use xcap::{Monitor, Window};

use crate::platform::{DesktopError, Result};

/// Run a capture call that may panic inside `xcap`.
///
/// `xcap` panics rather than erroring on unsupported compositors and protocol
/// versions. Those are ordinary conditions for us — a headless box, an old
/// Wayland — so they become tool errors instead of killing the process.
fn guarded<T>(what: &str, call: impl FnOnce() -> Result<T>) -> Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) {
        Ok(result) => result,
        Err(_) => Err(DesktopError::new(format!(
            "{what} is not supported by this display server — the Wayland screenshot protocols \
             vary by compositor. Use get_app_state to read the UI instead; it does not need a \
             screen capture"
        ))),
    }
}

/// Matches the macOS server's default, which keeps a full-screen capture around
/// 200-400 KB of base64 — large enough to read UI text, small enough to not
/// dominate a model's context window.
pub const DEFAULT_MAX_WIDTH: u32 = 1400;

fn encode_png(image: RgbaImage, max_width: u32) -> Result<Vec<u8>> {
    let image = if max_width > 0 && image.width() > max_width {
        let height = ((image.height() as f64) * (max_width as f64) / (image.width() as f64))
            .round()
            .max(1.0) as u32;
        image::imageops::resize(&image, max_width, height, FilterType::Triangle)
    } else {
        image
    };

    let mut buffer = Vec::new();
    PngEncoder::new(&mut buffer)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| DesktopError::new(format!("failed to encode PNG: {error}")))?;
    Ok(buffer)
}

/// Whether the session is Wayland, matching how `xcap` decides.
pub(crate) fn on_wayland() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland")
            || std::env::var("WAYLAND_DISPLAY").is_ok_and(|value| !value.is_empty()))
}

/// Capture through `grim`, the reference wlr-screencopy client.
///
/// `xcap`'s Wayland path fails to connect on wlroots compositors where the
/// protocol demonstrably works — `grim` captures the same session fine — so this
/// is the fallback rather than reporting a capture we cannot do. Absent on
/// GNOME and KDE, which do not implement wlr-screencopy at all; there the error
/// stands and the accessibility tools remain the answer.
fn grim_capture(output: Option<&str>) -> Result<Vec<u8>> {
    let mut command = std::process::Command::new("grim");
    if let Some(name) = output {
        command.arg("-o").arg(name);
    }
    // `-` writes the PNG to stdout, so nothing touches the filesystem.
    let result = command
        .arg("-")
        .output()
        .map_err(|error| DesktopError::new(format!("grim is not available: {error}")))?;
    if !result.status.success() {
        return Err(DesktopError::new(format!(
            "grim could not capture this session: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        )));
    }
    Ok(result.stdout)
}

/// How many displays `grim_capture(None)` may stand in for when xcap fails.
///
/// All-outputs grim is a single image — only display index 0 is valid unless
/// xcap can still enumerate monitors (in which case the index must be in range,
/// and we only use grim for index 0 to avoid returning the wrong screen).
fn wayland_grim_index_ok(index: usize) -> Result<()> {
    let monitor_len = std::panic::catch_unwind(|| Monitor::all().map(|m| m.len()).unwrap_or(0))
        .unwrap_or(0);
    if monitor_len == 0 {
        // Synthetic single Wayland output advertised by `list_displays`.
        if index != 0 {
            return Err(DesktopError::new(format!(
                "display {index} does not exist — call list_displays (1 attached via wlr-screencopy)"
            )));
        }
        return Ok(());
    }
    if index >= monitor_len {
        return Err(DesktopError::new(format!(
            "display {index} does not exist — call list_displays ({monitor_len} attached)"
        )));
    }
    if index != 0 {
        return Err(DesktopError::new(format!(
            "display {index} capture failed on Wayland — grim all-outputs fallback only covers display 0"
        )));
    }
    Ok(())
}

pub fn list_displays() -> Result<String> {
    match guarded("display enumeration", list_displays_inner) {
        Ok(text) => Ok(text),
        Err(error) if on_wayland() => {
            // Confirm the fallback actually works before advertising a display
            // the model would then fail to capture.
            if grim_capture(None).is_ok() {
                Ok("[0] wayland output (via wlr-screencopy)".to_string())
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn list_displays_inner() -> Result<String> {
    let monitors = Monitor::all()
        .map_err(|error| DesktopError::new(format!("failed to enumerate displays: {error}")))?;
    if monitors.is_empty() {
        return Ok("no displays detected".to_string());
    }

    let mut lines = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let name = monitor.name().unwrap_or_else(|_| format!("display {index}"));
        let width = monitor.width().unwrap_or(0);
        let height = monitor.height().unwrap_or(0);
        let x = monitor.x().unwrap_or(0);
        let y = monitor.y().unwrap_or(0);
        let primary = monitor.is_primary().unwrap_or(false);
        lines.push(format!(
            "[{index}] {name}  {width}x{height}  at ({x},{y}){}",
            if primary { "  PRIMARY" } else { "" }
        ));
    }
    Ok(lines.join("\n"))
}

pub fn capture_display(index: usize, max_width: u32) -> Result<Vec<u8>> {
    match guarded("display capture", || capture_display_inner(index, max_width)) {
        Ok(png) => Ok(png),
        Err(error) if on_wayland() => {
            // An out-of-range index must not fall back to grim's all-outputs capture.
            if error.0.contains("does not exist") {
                return Err(error);
            }
            wayland_grim_index_ok(index)?;
            let png = grim_capture(None).map_err(|_| error)?;
            // Re-encode so max_width applies to this path too.
            let image = image::load_from_memory(&png)
                .map_err(|error| DesktopError::new(format!("grim returned an unreadable PNG: {error}")))?;
            encode_png(image.to_rgba8(), max_width)
        }
        Err(error) => Err(error),
    }
}

fn capture_display_inner(index: usize, max_width: u32) -> Result<Vec<u8>> {
    let monitors = Monitor::all()
        .map_err(|error| DesktopError::new(format!("failed to enumerate displays: {error}")))?;
    let monitor = monitors.get(index).ok_or_else(|| {
        DesktopError::new(format!(
            "display {index} does not exist — call list_displays ({} attached)",
            monitors.len()
        ))
    })?;
    let image = monitor
        .capture_image()
        .map_err(|error| DesktopError::new(format!("failed to capture display: {error}")))?;
    encode_png(image, max_width)
}

/// Capture the largest window owned by `pid`.
///
/// Largest rather than frontmost: a foreground app often also owns tooltips and
/// tiny helper windows, and the biggest one is reliably the document window the
/// model means. Returns the window title alongside the PNG so the tool text can
/// name what it captured.
pub fn capture_app_window(pid: u32, max_width: u32) -> Result<(Vec<u8>, String)> {
    guarded("window capture", || capture_app_window_inner(pid, max_width))
}

fn capture_app_window_inner(pid: u32, max_width: u32) -> Result<(Vec<u8>, String)> {
    let windows = Window::all()
        .map_err(|error| DesktopError::new(format!("failed to enumerate windows: {error}")))?;

    let mut best: Option<(u32, &Window)> = None;
    for window in &windows {
        if window.pid().unwrap_or(0) != pid || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let area = window.width().unwrap_or(0).saturating_mul(window.height().unwrap_or(0));
        if area == 0 {
            continue;
        }
        if best.as_ref().is_none_or(|(best_area, _)| area > *best_area) {
            best = Some((area, window));
        }
    }

    let (_, window) = best.ok_or_else(|| {
        DesktopError::new(format!(
            "pid {pid} has no capturable window — it may be minimized or have no UI"
        ))
    })?;
    let title = window.title().unwrap_or_default();
    let image = window
        .capture_image()
        .map_err(|error| DesktopError::new(format!("failed to capture window: {error}")))?;
    Ok((encode_png(image, max_width)?, title))
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_MAX_WIDTH, encode_png};
    use image::RgbaImage;

    #[test]
    fn encodes_a_png_signature() {
        let png = encode_png(RgbaImage::new(4, 4), DEFAULT_MAX_WIDTH).expect("encodes");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[test]
    fn downscales_only_when_wider_than_the_limit() {
        // Narrower than the cap: dimensions must survive untouched, since
        // upscaling would waste tokens without adding detail.
        let small = encode_png(RgbaImage::new(100, 50), 400).expect("encodes");
        let decoded = image::load_from_memory(&small).expect("decodes");
        assert_eq!((decoded.width(), decoded.height()), (100, 50));

        // Wider than the cap: scaled down, aspect ratio preserved.
        let large = encode_png(RgbaImage::new(1000, 500), 400).expect("encodes");
        let decoded = image::load_from_memory(&large).expect("decodes");
        assert_eq!((decoded.width(), decoded.height()), (400, 200));
    }

    #[test]
    fn a_zero_max_width_disables_downscaling() {
        let png = encode_png(RgbaImage::new(80, 20), 0).expect("encodes");
        let decoded = image::load_from_memory(&png).expect("decodes");
        assert_eq!((decoded.width(), decoded.height()), (80, 20));
    }
}
