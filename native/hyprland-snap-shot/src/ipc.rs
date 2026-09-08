use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite() && n.abs() < 100_000.0)
            && self.width > 0.0
            && self.height > 0.0
    }
    pub fn intersects(&self, other: Self) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Window {
    pub address: String,
    pub pid: u32,
    pub title: String,
    pub class: String,
    pub at: [i32; 2],
    pub size: [i32; 2],
    pub mapped: bool,
    pub hidden: bool,
}
impl Window {
    pub fn address(&self) -> Result<u64> {
        let address = self
            .address
            .strip_prefix("0x")
            .ok_or("Invalid Hyprland window address")?;
        Ok(u64::from_str_radix(address, 16)?)
    }
    pub fn bounds(&self) -> Rect {
        Rect {
            x: self.at[0].into(),
            y: self.at[1].into(),
            width: self.size[0].into(),
            height: self.size[1].into(),
        }
    }
    pub fn metadata(&self) -> serde_json::Value {
        serde_json::json!({"title": self.title, "appName": self.class, "appIdentifier": self.class,
            "processId": self.pid, "bounds": self.bounds(), "clientBounds": self.bounds()})
    }
}

pub fn session_directory() -> Result<PathBuf> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    if !desktop
        .split(':')
        .any(|name| name.eq_ignore_ascii_case("hyprland"))
        || std::env::var_os("FLATPAK_ID").is_some()
        || std::env::var_os("SNAP").is_some()
    {
        return Err("Window capture requires a native Hyprland session.".into());
    }
    let runtime = PathBuf::from(std::env::var("XDG_RUNTIME_DIR")?);
    let instance = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")?;
    if !runtime.is_absolute()
        || instance.is_empty()
        || !instance
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid Hyprland session environment.".into());
    }
    Ok(runtime.join("hypr").join(instance))
}

pub fn request(command: &str) -> Result<String> {
    let mut socket = UnixStream::connect(session_directory()?.join(".socket.sock"))?;
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    socket.write_all(command.as_bytes())?;
    let mut reply = String::new();
    socket
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut reply)?;
    if reply.len() > 4 * 1024 * 1024 {
        return Err("Oversized Hyprland reply.".into());
    }
    Ok(reply)
}

pub fn ensure_unlocked() -> Result<()> {
    // Fail closed on unsupported/unknown replies too; never capture through a lock screen.
    #[derive(Deserialize)]
    struct LockState {
        locked: bool,
    }
    if serde_json::from_str::<LockState>(&request("j/locked")?)?.locked {
        return Err("Unlock your Hyprland session before capturing a window.".into());
    }
    Ok(())
}

pub fn animations_enabled() -> bool {
    // Electron handles the standard reduced-motion setting; also honor Hyprland's own switch.
    request("j/getoption animations:enabled")
        .ok()
        .and_then(|reply| serde_json::from_str::<serde_json::Value>(&reply).ok())
        .and_then(|value| value.get("int").and_then(serde_json::Value::as_i64))
        != Some(0)
}
pub fn windows() -> Result<Vec<Window>> {
    Ok(serde_json::from_str(&request("j/clients")?)?)
}
pub fn active_window() -> Result<Window> {
    let window: Window = serde_json::from_str(&request("j/activewindow")?)
        .map_err(|_| "Hyprland has no active window to capture.")?;
    if !window.mapped || window.hidden || !window.bounds().valid() || window.pid == 0 {
        return Err("Hyprland has no visible active window to capture.".into());
    }
    Ok(window)
}
pub fn destination(windows: Vec<Window>, pid: u32, title: &str) -> Result<Option<Window>> {
    let mut matches = windows
        .into_iter()
        .filter(|w| w.pid == pid && w.title == title && w.mapped && !w.hidden);
    let found = matches.next();
    if matches.next().is_some() {
        return Err("More than one T3 Code window matches the capture destination.".into());
    }
    Ok(found)
}

pub fn activate(pid: u32, title: &str) -> Result<()> {
    // Subscribe before looking up a newly mapped T3 window, so no map/title event is missed.
    let socket = UnixStream::connect(session_directory()?.join(".socket2.sock"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut events = BufReader::new(socket);
    loop {
        ensure_unlocked()?;
        if let Some(window) = destination(windows()?, pid, title)? {
            let address = window.address()?;
            let lua = format!("/dispatch hl.dsp.focus({{ window = \"address:0x{address:x}\" }})");
            if request(&lua)?.trim() != "ok"
                && request(&format!("/dispatch focuswindow address:0x{address:x}"))?.trim() != "ok"
            {
                return Err("Hyprland could not focus T3 Code.".into());
            }
            return Ok(());
        }
        events.get_ref().set_read_timeout(Some(
            deadline
                .checked_duration_since(Instant::now())
                .ok_or("T3 Code did not become visible.")?,
        ))?;
        let mut event = Vec::new();
        if events.by_ref().take(8193).read_until(b'\n', &mut event)? == 0 || event.len() > 8192 {
            return Err("Hyprland's event stream closed or returned an invalid event.".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window(pid: u32, title: &str) -> Window {
        Window {
            address: "0x123456789abcdef".into(),
            pid,
            title: title.into(),
            class: "t3".into(),
            at: [-1920, 20],
            size: [1000, 800],
            mapped: true,
            hidden: false,
        }
    }
    #[test]
    fn address_preserves_upper_bits() {
        assert_eq!(window(1, "t").address().unwrap(), 0x123456789abcdef);
    }
    #[test]
    fn destination_requires_unique_process_and_title() {
        assert!(
            destination(vec![window(2, "T3")], 1, "T3")
                .unwrap()
                .is_none()
        );
        assert!(
            destination(vec![window(1, "other")], 1, "T3")
                .unwrap()
                .is_none()
        );
        assert!(destination(vec![window(1, "T3"), window(1, "T3")], 1, "T3").is_err());
        assert!(
            destination(vec![window(2, "T3"), window(1, "T3")], 1, "T3")
                .unwrap()
                .is_some()
        );
    }
    #[test]
    fn rectangles_accept_negative_origins_not_invalid_sizes() {
        assert!(window(1, "t").bounds().valid());
        assert!(
            !Rect {
                x: 0.,
                y: 0.,
                width: f64::NAN,
                height: 10.
            }
            .valid()
        );
        assert!(
            !Rect {
                x: 0.,
                y: 0.,
                width: 0.,
                height: 10.
            }
            .valid()
        );
    }
}
