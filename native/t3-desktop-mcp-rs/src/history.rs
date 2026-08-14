//! Computer History daemon for Windows and Linux.
//!
//! Invoked as `t3-desktop-mcp computer-history --root <dir>`.
//! Samples the frontmost app / focused accessibility node on an interval and
//! writes Skysight-style segment JSONL under `<root>/segments/`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::platform::{Desktop, DesktopError};

#[derive(Clone)]
struct Control {
    enabled: bool,
    paused: bool,
    app_filter_mode: String,
    apps: Vec<String>,
    website_filter_mode: String,
    websites: Vec<String>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            enabled: true,
            paused: false,
            app_filter_mode: "exclude".into(),
            apps: Vec::new(),
            website_filter_mode: "exclude".into(),
            websites: Vec::new(),
        }
    }
}

pub fn run(root: PathBuf) -> Result<(), String> {
    fs::create_dir_all(root.join("segments")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("memories").join("resources")).map_err(|e| e.to_string())?;

    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };

    let mut desktop = crate::platform::backend().map_err(|e| e.to_string())?;
    let session_id = uuid_like();
    let mut segment_started = now_secs();
    let mut segment_id = segment_name(segment_started);
    let mut event_count: u64 = 0;
    let mut suppressed: u64 = 0;
    let mut last_sample_key = String::new();
    let mut events_file = open_segment(&root, &segment_id, &session_id, platform, segment_started)?;
    // Retain the last successfully parsed control so a truncated mid-write
    // control.json cannot reopen capture with default (enabled, no filters).
    let mut last_good_control: Option<Control> = None;

    write_status(
        &root,
        "running",
        true,
        Some(&segment_id),
        event_count,
        None,
        platform,
    )?;

    append_event(
        &mut events_file,
        &mut event_count,
        json!({
            "id": uuid_like(),
            "timestamp": iso_now(),
            "kind": "session.started",
            "detail": "computer-history daemon",
        }),
    )?;
    write_metadata(
        &root,
        &segment_id,
        &session_id,
        platform,
        segment_started,
        event_count,
        suppressed,
        None,
        None,
    )?;

    eprintln!(
        "t3-desktop-mcp: computer-history daemon started root={}",
        root.display()
    );

    loop {
        let control = match try_read_control(&root) {
            Ok(next) => {
                last_good_control = Some(next.clone());
                next
            }
            Err(_) => last_good_control.clone().unwrap_or_else(|| Control {
                // Fail closed when we have never seen a valid control file.
                enabled: false,
                ..Control::default()
            }),
        };
        if !control.enabled {
            write_status(
                &root,
                "stopped",
                true,
                Some(&segment_id),
                event_count,
                None,
                platform,
            )?;
            thread::sleep(Duration::from_secs(2));
            continue;
        }
        if control.paused {
            write_status(
                &root,
                "paused",
                true,
                Some(&segment_id),
                event_count,
                None,
                platform,
            )?;
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        if now_secs().saturating_sub(segment_started) >= 600 {
            write_metadata(
                &root,
                &segment_id,
                &session_id,
                platform,
                segment_started,
                event_count,
                suppressed,
                Some(iso_now()),
                Some("max_duration"),
            )?;
            segment_started = now_secs();
            segment_id = segment_name(segment_started);
            event_count = 0;
            suppressed = 0;
            last_sample_key.clear();
            events_file = open_segment(&root, &segment_id, &session_id, platform, segment_started)?;
        }

        match sample_frontmost(&mut *desktop) {
            Ok(sample) => {
                let allowed = app_allowed(&sample.app_id, &sample.app_name, &control)
                    && website_allowed(
                        sample.window_title.as_deref(),
                        &sample.app_name,
                        &control,
                    );
                if !allowed {
                    suppressed += 1;
                } else if sample.key != last_sample_key {
                    last_sample_key = sample.key.clone();
                    let mut app = json!({ "name": sample.app_name });
                    if !sample.app_id.is_empty() {
                        app["bundleIdentifier"] = json!(sample.app_id);
                    }
                    let mut record = json!({
                        "id": uuid_like(),
                        "timestamp": iso_now(),
                        "kind": "sample.frontmost",
                        "app": app,
                    });
                    if let Some(title) = sample.window_title {
                        record["window"] = json!({ "title": title });
                    }
                    if let Some(ax) = sample.ax {
                        record["ax"] = ax;
                    }
                    append_event(&mut events_file, &mut event_count, record)?;
                    write_metadata(
                        &root,
                        &segment_id,
                        &session_id,
                        platform,
                        segment_started,
                        event_count,
                        suppressed,
                        None,
                        None,
                    )?;
                }
                write_status(
                    &root,
                    "running",
                    sample.accessibility_granted,
                    Some(&segment_id),
                    event_count,
                    None,
                    platform,
                )?;
            }
            Err(error) => {
                write_status(
                    &root,
                    "error",
                    false,
                    Some(&segment_id),
                    event_count,
                    Some(&error.to_string()),
                    platform,
                )?;
            }
        }

        thread::sleep(Duration::from_secs(2));
    }
}

struct Sample {
    app_id: String,
    app_name: String,
    window_title: Option<String>,
    ax: Option<Value>,
    key: String,
    accessibility_granted: bool,
}

fn sample_frontmost(desktop: &mut dyn Desktop) -> Result<Sample, DesktopError> {
    let listing = desktop.list_apps()?;
    // Require an explicit FRONTMOST marker. Guessing the first listed app when
    // focus is unknown would attribute activity to an arbitrary process.
    let front = listing
        .lines()
        .find(|line| line.contains("FRONTMOST"))
        .ok_or_else(|| DesktopError::new("no frontmost app"))?;
    let (app_name, app_id) = parse_app_line(front)
        .ok_or_else(|| DesktopError::new(format!("could not parse frontmost app line: {front}")))?;
    // Only report accessibility granted when AT-SPI actually answered.
    let (outline, accessibility_granted) = match desktop.get_app_state(&app_name, 4, 40) {
        Ok(text) => (text, true),
        Err(_) => (String::new(), false),
    };
    let window_title = outline
        .lines()
        .find(|line| !line.is_empty())
        .map(str::to_string);
    let ax = if outline.is_empty() {
        None
    } else {
        Some(json!({
            "description": outline.chars().take(240).collect::<String>(),
        }))
    };
    // Deduplicate on the full outline so tab/focus changes inside one app still
    // emit events (a short prefix of get_app_state is often stable).
    let key = format!(
        "{}|{}|{}",
        app_name,
        window_title.clone().unwrap_or_default(),
        outline
    );
    Ok(Sample {
        app_id,
        app_name,
        window_title,
        ax,
        key,
        accessibility_granted,
    })
}

/// Parse `Name  [id]  pid=…  windows=…  FRONTMOST` from `format_app_list`.
fn parse_app_line(line: &str) -> Option<(String, String)> {
    let id_start = line.find('[')?;
    let id_end = line[id_start..].find(']')? + id_start;
    let name = line[..id_start].trim().to_string();
    let id = line[id_start + 1..id_end].trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some((name, id))
    }
}

fn app_allowed(app_id: &str, app_name: &str, control: &Control) -> bool {
    let needles: Vec<String> = control.apps.iter().map(|s| s.to_lowercase()).collect();
    let hay: Vec<String> = [app_id.to_lowercase(), app_name.to_lowercase()]
        .into_iter()
        .filter(|h| !h.is_empty())
        .collect();
    let hit = needles.iter().any(|needle| {
        hay.iter()
            .any(|h| h.contains(needle) || needle.contains(h.as_str()))
    });
    if needles.is_empty() {
        return control.app_filter_mode == "exclude";
    }
    if control.app_filter_mode == "exclude" {
        !hit
    } else {
        hit
    }
}

fn website_allowed(url_or_title: Option<&str>, app_name: &str, control: &Control) -> bool {
    let Some(raw) = url_or_title else {
        return true;
    };
    let lowered = raw.to_lowercase();
    let app = app_name.to_lowercase();
    let is_browser = ["chrome", "chromium", "firefox", "safari", "edge", "brave", "opera"]
        .iter()
        .any(|needle| app.contains(needle));
    let looks_url = lowered.contains("://")
        || lowered.starts_with("about:")
        || lowered.starts_with("chrome:")
        || lowered.starts_with("edge:")
        || lowered.starts_with("brave:");
    // Private-browsing markers only apply to browser contexts — never to every
    // desktop window title that happens to contain "private".
    if is_browser
        && (lowered.contains("chrome://newtab")
            || lowered.contains("about:privatebrowsing")
            || lowered.contains("edge://newtab")
            || lowered.contains("(private)")
            || lowered.contains("incognito")
            || lowered.contains("inprivate"))
    {
        return false;
    }
    // Site include/exclude lists only apply to URL-like haystacks.
    if !looks_url {
        return true;
    }
    let needles: Vec<String> = control.websites.iter().map(|s| s.to_lowercase()).collect();
    if needles.is_empty() {
        return control.website_filter_mode == "exclude";
    }
    let hit = needles.iter().any(|needle| lowered.contains(needle));
    if control.website_filter_mode == "exclude" {
        !hit
    } else {
        hit
    }
}

fn try_read_control(root: &Path) -> Result<Control, ()> {
    let path = root.join("control.json");
    let raw = fs::read_to_string(path).map_err(|_| ())?;
    if raw.trim().is_empty() {
        return Err(());
    }
    let value = serde_json::from_str::<Value>(&raw).map_err(|_| ())?;
    Ok(Control {
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        paused: value
            .get("paused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        app_filter_mode: value
            .get("appFilterMode")
            .and_then(Value::as_str)
            .unwrap_or("exclude")
            .to_string(),
        apps: value
            .get("apps")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        website_filter_mode: value
            .get("websiteFilterMode")
            .and_then(Value::as_str)
            .unwrap_or("exclude")
            .to_string(),
        websites: value
            .get("websites")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn open_segment(
    root: &Path,
    segment_id: &str,
    session_id: &str,
    platform: &str,
    started: u64,
) -> Result<File, String> {
    let dir = root.join("segments").join(segment_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("events.jsonl");
    if !path.exists() {
        File::create(&path).map_err(|e| e.to_string())?;
    }
    write_metadata(
        root, segment_id, session_id, platform, started, 0, 0, None, None,
    )?;
    OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())
}

fn append_event(file: &mut File, event_count: &mut u64, record: Value) -> Result<(), String> {
    writeln!(file, "{record}").map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    *event_count += 1;
    Ok(())
}

fn write_metadata(
    root: &Path,
    segment_id: &str,
    session_id: &str,
    platform: &str,
    started: u64,
    event_count: u64,
    suppressed: u64,
    ended_at: Option<String>,
    end_reason: Option<&str>,
) -> Result<(), String> {
    let mut payload = json!({
        "sessionID": session_id,
        "segmentID": segment_id,
        "startedAt": secs_to_iso(started),
        "eventCount": event_count,
        "suppressedEventCount": suppressed,
        "platform": platform,
    });
    if let Some(ended_at) = ended_at {
        payload["endedAt"] = json!(ended_at);
    }
    if let Some(end_reason) = end_reason {
        payload["endReason"] = json!(end_reason);
    }
    let path = root
        .join("segments")
        .join(segment_id)
        .join("metadata.json");
    fs::write(path, serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn write_status(
    root: &Path,
    phase: &str,
    accessibility_granted: bool,
    active_segment_id: Option<&str>,
    event_count: u64,
    last_error: Option<&str>,
    platform: &str,
) -> Result<(), String> {
    let mut payload = json!({
        "phase": phase,
        "accessibilityGranted": accessibility_granted,
        "eventCount": event_count,
        "platform": platform,
        "updatedAt": iso_now(),
        "pid": std::process::id(),
    });
    if let Some(id) = active_segment_id {
        payload["activeSegmentId"] = json!(id);
    }
    if let Some(err) = last_error {
        payload["lastError"] = json!(err);
    }
    fs::write(
        root.join("status.json"),
        serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn secs_to_iso(secs: u64) -> String {
    // Keep it simple and stable for filenames/metadata.
    let datetime = chrono_lite(secs);
    datetime
}

fn iso_now() -> String {
    secs_to_iso(now_secs())
}

fn segment_name(secs: u64) -> String {
    // Unique suffix so concurrent/restarted daemons never share a segment dir.
    format!("{}-{}", secs_to_iso(secs).replace(':', "-"), uuid_like())
}

fn chrono_lite(secs: u64) -> String {
    // Manual UTC formatting without pulling chrono — good enough for segment ids.
    let days = secs / 86_400;
    let time = secs % 86_400;
    let hours = time / 3600;
    let minutes = (time % 3600) / 60;
    let seconds = time % 60;
    // Civil date from days since Unix epoch (Howard Hinnant algorithm).
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn uuid_like() -> String {
    format!(
        "{:x}-{:x}",
        now_secs(),
        std::process::id().wrapping_mul(2654435761)
    )
}

#[cfg(test)]
mod tests {
    use super::parse_app_line;

    #[test]
    fn parses_frontmost_app_line() {
        let (name, id) = parse_app_line(
            "Windows Explorer  [explorer.exe]  pid=1234  windows=2  FRONTMOST",
        )
        .expect("parse");
        assert_eq!(name, "Windows Explorer");
        assert_eq!(id, "explorer.exe");
    }
}
