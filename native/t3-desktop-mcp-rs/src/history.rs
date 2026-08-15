//! Computer History daemon for Windows and Linux.
//!
//! Invoked as `t3-desktop-mcp computer-history --root <dir>`.
//! Samples the frontmost app / focused accessibility node on an interval and
//! writes Skysight-style segment JSONL under `<root>/segments/`.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::platform::{Desktop, DesktopError, unescape_app_field};

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
    // Firefox private windows can leave about:privatebrowsing while staying private.
    let mut sticky_private_windows: HashSet<String> = HashSet::new();

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
                let haystack = website_haystack(&sample);
                let session_key = private_session_key(&sample);
                if is_private_browsing_context(
                    haystack.as_deref(),
                    sample.window_title.as_deref(),
                    &sample.app_name,
                ) {
                    sticky_private_windows.insert(session_key.clone());
                } else if clears_private_sticky(
                    haystack.as_deref(),
                    sample.window_title.as_deref(),
                    &sample.app_name,
                ) {
                    // Only clear sticky private after an explicit public http(s) URL
                    // — marker-free AX samples must not re-enable recording.
                    sticky_private_windows.remove(&session_key);
                }
                let allowed = app_allowed(&sample.app_id, &sample.app_name, &control)
                    && !sticky_private_windows.contains(&private_session_key(&sample))
                    && website_allowed(
                        haystack.as_deref(),
                        sample.window_title.as_deref(),
                        &sample.app_name,
                        &control,
                    );
                if !allowed {
                    suppressed += 1;
                    // Clear so returning to the same allowed sample records again.
                    last_sample_key.clear();
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
    pid: u32,
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
        .find(|line| line.split_whitespace().last() == Some("FRONTMOST"))
        .ok_or_else(|| DesktopError::new("no frontmost app"))?;
    let (app_name, app_id, pid) = parse_app_line(front)
        .ok_or_else(|| DesktopError::new(format!("could not parse frontmost app line: {front}")))?;
    // Only report accessibility granted when AT-SPI actually answered.
    let (outline, accessibility_granted) = match desktop.get_app_state(&app_name, 4, 40) {
        Ok(text) => (text, true),
        Err(_) => (String::new(), false),
    };
    // get_app_state prefixes the outline with the application name; that is not
    // a window title and would make website filters never see URL-like text.
    let window_title = window_title_from_outline(&outline, &app_name);
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
        pid,
        window_title,
        ax,
        key,
        accessibility_granted,
    })
}

fn private_session_key(sample: &Sample) -> String {
    format!("{}:{}", sample.app_id, sample.pid)
}

fn is_browser_app(app_name: &str) -> bool {
    let app = app_name.to_lowercase();
    [
        "chrome",
        "chromium",
        "firefox",
        "safari",
        "edge",
        "brave",
        "opera",
        "arc",
        "vivaldi",
    ]
    .iter()
    .any(|needle| app.contains(needle))
}

fn clears_private_sticky(
    haystack: Option<&str>,
    window_title: Option<&str>,
    app_name: &str,
) -> bool {
    if !is_browser_app(app_name) {
        return true;
    }
    let mut parts = Vec::new();
    if let Some(title) = window_title {
        parts.push(title.to_lowercase());
    }
    if let Some(raw) = haystack {
        parts.push(raw.to_lowercase());
    }
    let combined = parts.join("\n");
    if combined.is_empty() || !combined.contains("://") {
        return false;
    }
    !is_private_browsing_context(Some(&combined), window_title, app_name)
}

fn is_private_browsing_context(
    haystack: Option<&str>,
    window_title: Option<&str>,
    app_name: &str,
) -> bool {
    if !is_browser_app(app_name) {
        return false;
    }
    let combined_title = window_title.map(|title| title.to_lowercase()).unwrap_or_default();
    let combined_haystack = haystack.map(|raw| raw.to_lowercase()).unwrap_or_default();
    // Bare "incognito"/"inprivate" tokens appear in ordinary page content and
    // accessibility outlines — only treat them as private-mode markers in the
    // window title (or explicit browser chrome phrases in either field).
    combined_title.contains("about:privatebrowsing")
        || combined_title.contains("private browsing")
        || combined_title.contains("(private)")
        || combined_title.contains("incognito")
        || combined_title.contains("inprivate")
        || combined_haystack.contains("about:privatebrowsing")
        || combined_haystack.contains("private browsing")
        || combined_haystack.contains("(private)")
}

/// Parse `Name  [id]  pid=…  windows=…  FRONTMOST` from `format_app_list`.
fn parse_app_line(line: &str) -> Option<(String, String, u32)> {
    // Use the trailing `  [` delimiter `format_app_list` emits so names that
    // contain `[` are not truncated at the first bracket.
    let marker = line.rfind("  [")?;
    let id_start = marker + 3;
    let id_end = line[id_start..].find(']')? + id_start;
    let name = unescape_app_field(line[..marker].trim());
    let id = unescape_app_field(line[id_start..id_end].trim());
    let tail = line[id_end + 1..].trim();
    let pid = tail
        .split_whitespace()
        .find_map(|token| token.strip_prefix("pid="))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if name.is_empty() {
        None
    } else {
        Some((name, id, pid))
    }
}

/// Prefer a document/address-bar URL from the outline; otherwise the frame title.
/// Ordinary link rows must not replace the current page URL for privacy filters.
fn window_title_from_outline(outline: &str, app_name: &str) -> Option<String> {
    let lines: Vec<&str> = outline
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let body: Vec<&str> = if lines[0].eq_ignore_ascii_case(app_name.trim()) {
        lines[1..].to_vec()
    } else {
        lines
    };
    if body.is_empty() {
        return None;
    }
    let document_url = body.iter().find_map(|line| {
        let lowered = line.to_lowercase();
        let is_documentish = lowered.contains("document")
            || lowered.contains("address")
            || lowered.contains("location")
            || lowered.contains("url bar")
            || lowered.contains("omnibox");
        let has_url = lowered.contains("://")
            || lowered.contains("about:")
            || lowered.contains("chrome:")
            || lowered.contains("edge:")
            || lowered.contains("brave:");
        if is_documentish && has_url {
            Some(outline_row_label(line))
        } else {
            None
        }
    });
    if document_url.is_some() {
        return document_url;
    }
    // Fall back to the first non-URL row (typically the frame title), not a link.
    body.iter()
        .find(|line| {
            let lowered = line.to_lowercase();
            !lowered.contains("://")
                && !lowered.contains("about:")
                && !lowered.starts_with("chrome:")
                && !lowered.starts_with("edge:")
                && !lowered.starts_with("brave:")
                && !lowered.contains(" link ")
        })
        .or(body.first())
        .map(|line| outline_row_label(line))
}

fn outline_row_label(line: &str) -> String {
    // Outline rows are often "  [e12] role  Name" — strip the leading id marker.
    let trimmed = line.trim();
    let after_marker = if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(idx) = rest.find(']') {
            rest[idx + 1..].trim()
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    // AT-SPI often prefixes URLs with a role token, e.g. "document  about:…".
    after_marker
        .split_whitespace()
        .find(|token| {
            let lowered = token.to_lowercase();
            lowered.contains("://")
                || lowered.contains("about:")
                || lowered.starts_with("chrome:")
                || lowered.starts_with("edge:")
                || lowered.starts_with("brave:")
        })
        .map(str::to_string)
        .unwrap_or_else(|| after_marker.to_string())
}

fn website_haystack(sample: &Sample) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(title) = &sample.window_title {
        parts.push(title.clone());
    }
    if let Some(ax) = &sample.ax
        && let Some(description) = ax.get("description").and_then(|value| value.as_str())
    {
        parts.push(description.to_string());
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
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

fn website_allowed(
    url_or_title: Option<&str>,
    window_title: Option<&str>,
    app_name: &str,
    control: &Control,
) -> bool {
    if control.website_filter_mode == "includeOnly" && control.websites.is_empty() {
        return false;
    }
    let include_only = control.website_filter_mode == "includeOnly";
    let mut haystack_parts = Vec::new();
    if let Some(title) = window_title {
        haystack_parts.push(title.to_lowercase());
    }
    if let Some(raw) = url_or_title {
        haystack_parts.push(raw.to_lowercase());
    }
    let Some(combined) = (!haystack_parts.is_empty()).then(|| haystack_parts.join("\n")) else {
        return !include_only;
    };
    if is_private_browsing_context(Some(&combined), window_title, app_name) {
        return false;
    }
    let lowered = combined;
    let looks_url = lowered.contains("://")
        || lowered.starts_with("about:")
        || lowered.starts_with("chrome:")
        || lowered.starts_with("edge:")
        || lowered.starts_with("brave:");
    // Site include/exclude lists only apply to URL-like haystacks.
    if !looks_url {
        return !include_only;
    }
    let needles: Vec<String> = control.websites.iter().map(|s| s.to_lowercase()).collect();
    if needles.is_empty() {
        return control.website_filter_mode == "exclude";
    }
    let hit = needles.iter().any(|needle| host_matches(&lowered, needle));
    if control.website_filter_mode == "exclude" {
        !hit
    } else {
        hit
    }
}

fn host_matches(haystack: &str, needle: &str) -> bool {
    let raw_needle = needle.trim().to_lowercase();
    if raw_needle.is_empty() {
        return false;
    }
    let is_path_needle = raw_needle.contains('/');
    let needle = raw_needle.trim_matches('/').to_lowercase();
    if needle.is_empty() && !is_path_needle {
        return false;
    }
    // Match against URL tokens only. Never strip ?/# from the whole title+outline
    // haystack — titles like "Issue #123" or "What is life?" would cut off the
    // real page URL before host extraction.
    let candidates = url_candidates(haystack);
    // Only the first URL token — outline/link URLs must not drive include/exclude
    // (macOS already ignores link AXURLs for the same reason).
    let Some(raw_url) = candidates.into_iter().next() else {
        return false;
    };
    let page = strip_query_and_fragment(&raw_url).to_lowercase();
    if is_path_needle {
        return path_needle_matches(&page, &raw_needle);
    }
    if let Some(host) = extract_hosts(&page).into_iter().next() {
        return host == needle || host.ends_with(&format!(".{needle}"));
    }
    false
}

fn path_needle_matches(page: &str, raw_needle: &str) -> bool {
    let needle = raw_needle.trim().to_lowercase();
    // Full URL needles: https://example.com/private  or origin https://example.com
    if needle.contains("://") {
        let filter_page = strip_query_and_fragment(&needle).to_lowercase();
        let Some(want_host) = extract_hosts(&filter_page).into_iter().next() else {
            return false;
        };
        let Some(have_host) = extract_hosts(page).into_iter().next() else {
            return false;
        };
        if !(have_host == want_host || have_host.ends_with(&format!(".{want_host}"))) {
            return false;
        }
        let want_path = normalize_path(&page_path(&filter_page));
        // Origin-only filters (no meaningful path) match every page on the host.
        if want_path == "/" {
            return true;
        }
        return path_prefix_match(&normalize_path(&page_path(page)), &want_path);
    }
    // Absolute path needles: /private
    if needle.starts_with('/') {
        let want = normalize_path(&needle);
        return path_prefix_match(&normalize_path(&page_path(page)), &want);
    }
    // Host-qualified: localhost/admin, trusted.example/path, example.com/
    if let Some((host_part, path_part)) = needle.split_once('/') {
        if !host_part.is_empty() {
            let Some(host) = extract_hosts(page).into_iter().next() else {
                return false;
            };
            let host_ok = host == host_part || host.ends_with(&format!(".{host_part}"));
            if !host_ok {
                return false;
            }
            let path_part = path_part.trim_matches('/');
            // `example.com/` → whole host.
            if path_part.is_empty() {
                return true;
            }
            let want = format!("/{path_part}");
            return path_prefix_match(&normalize_path(&page_path(page)), &want);
        }
    }
    false
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn path_prefix_match(path: &str, want: &str) -> bool {
    let path = normalize_path(path);
    let want = normalize_path(want);
    // Segment boundary only — `/account` must not match `/accounting`.
    path == want || path.starts_with(&format!("{want}/"))
}

fn page_path(page: &str) -> String {
    if let Some(idx) = page.find("://") {
        let after = &page[idx + 3..];
        if let Some(slash) = after.find('/') {
            return after[slash..].to_string();
        }
        return "/".to_string();
    }
    if let Some(slash) = page.find('/') {
        return page[slash..].to_string();
    }
    "/".to_string()
}

fn strip_query_and_fragment(raw: &str) -> &str {
    let q = raw.find('?').unwrap_or(raw.len());
    let h = raw.find('#').unwrap_or(raw.len());
    &raw[..q.min(h)]
}

/// Pull discrete URL tokens out of a title/outline haystack.
fn url_candidates(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(idx) = rest.find("://") {
        let prefix = &rest[..idx];
        let scheme_start = prefix
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.'))
            .map(|i| i + 1)
            .unwrap_or(0);
        let after = &rest[idx + 3..];
        let end = if after.starts_with('[') {
            // IPv6 literals: consume through `]` and optional `:port`.
            match after.find(']') {
                Some(br) => {
                    let after_br = &after[br + 1..];
                    let more = after_br
                        .find(|c: char| {
                            c.is_whitespace()
                                || matches!(c, '/' | '?' | '#' | ')' | ']' | '>' | '<' | '"' | '\'')
                        })
                        .unwrap_or(after_br.len());
                    br + 1 + more
                }
                None => after.len(),
            }
        } else {
            after
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, ')' | ']' | '>' | '<' | '"' | '\'')
                })
                .unwrap_or(after.len())
        };
        let mut cand = rest[scheme_start..idx + 3 + end].to_string();
        while cand.ends_with('>') || cand.ends_with('<') {
            cand.pop();
        }
        if cand.contains("://") {
            out.push(cand);
        }
        rest = &after[end.min(after.len())..];
    }
    out
}

fn extract_hosts(raw: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut rest = raw;
    while let Some(idx) = rest.find("://") {
        let after = &rest[idx + 3..];
        let end = if after.starts_with('[') {
            match after.find(']') {
                Some(br) => {
                    let after_br = &after[br + 1..];
                    let more = after_br
                        .find(['/', '?', '#', ' ', '\n', '\t'])
                        .unwrap_or(after_br.len());
                    br + 1 + more
                }
                None => after.find(['/', '?', '#', ' ', '\n', '\t']).unwrap_or(after.len()),
            }
        } else {
            after.find(['/', '?', '#', ' ', '\n', '\t']).unwrap_or(after.len())
        };
        let authority = &after[..end];
        if let Some(host) = authority_host(authority) {
            hosts.push(host);
        }
        rest = &after[end.min(after.len())..];
    }
    hosts
}

fn authority_host(authority: &str) -> Option<String> {
    let authority = authority.rsplit('@').next()?.trim();
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']')?;
        return Some(format!("[{}]", rest[..end].to_lowercase()));
    }
    let host = authority.split(':').next()?.trim().to_lowercase();
    (!host.is_empty()).then_some(host)
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
            .unwrap_or(false),
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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!(
        "{:x}-{:x}-{:x}-{:x}",
        now_secs(),
        std::process::id().wrapping_mul(2654435761),
        COUNTER.fetch_add(1, Ordering::Relaxed),
        nanos ^ (std::process::id() as u32)
    )
}

#[cfg(test)]
mod tests {
    use super::{host_matches, parse_app_line, window_title_from_outline};

    #[test]
    fn parses_frontmost_app_line() {
        let (name, id, pid) = parse_app_line(
            "Windows Explorer  [explorer.exe]  pid=1234  windows=2  FRONTMOST",
        )
        .expect("parse");
        assert_eq!(name, "Windows Explorer");
        assert_eq!(id, "explorer.exe");
        assert_eq!(pid, 1234);
    }

    #[test]
    fn parses_app_name_that_contains_brackets() {
        let (name, id, pid) = parse_app_line("Foo [bar] App  [com.foo]  pid=1  windows=1")
            .expect("parse");
        assert_eq!(name, "Foo [bar] App");
        assert_eq!(id, "com.foo");
        assert_eq!(pid, 1);
    }

    #[test]
    fn ignores_pid_token_inside_app_name() {
        let (name, _, pid) =
            parse_app_line("pid=999 App  [com.foo]  pid=42  windows=1").expect("parse");
        assert_eq!(name, "pid=999 App");
        assert_eq!(pid, 42);
    }

    #[test]
    fn window_title_skips_app_header_and_prefers_url() {
        let outline = "Firefox\n[e1] frame  Example - Mozilla Firefox\n[e2] link  https://blocked.example/path";
        let title = window_title_from_outline(outline, "Firefox").expect("title");
        assert!(title.contains("https://blocked.example/path"));
    }

    #[test]
    fn window_title_falls_back_to_first_non_header_line() {
        let outline = "Firefox\n[e1] frame  Example - Mozilla Firefox";
        let title = window_title_from_outline(outline, "Firefox").expect("title");
        assert_eq!(title, "frame  Example - Mozilla Firefox");
    }

    #[test]
    fn window_title_extracts_about_url_from_document_row() {
        let outline = "Firefox\n[e40] document  about:privatebrowsing";
        let title = window_title_from_outline(outline, "Firefox").expect("title");
        assert_eq!(title, "about:privatebrowsing");
    }

    #[test]
    fn title_question_mark_does_not_hide_url() {
        let hay = "What is life? https://trusted.example/path";
        assert!(host_matches(hay, "trusted.example"));
        assert!(!host_matches(
            "Issue #123 https://untrusted.example/?next=https://trusted.example",
            "trusted.example"
        ));
        // Later outline/link URLs must not admit an untrusted page.
        assert!(!host_matches(
            "https://untrusted.example/page https://trusted.example/link",
            "trusted.example"
        ));
    }

    #[test]
    fn angle_bracket_and_ipv6_hosts_match() {
        assert!(host_matches("<https://blocked.example>", "blocked.example"));
        assert!(host_matches("http://[::1]:8080/x", "[::1]"));
    }

    #[test]
    fn path_needle_requires_matching_host() {
        assert!(host_matches(
            "https://trusted.example/path/more",
            "trusted.example/path"
        ));
        assert!(!host_matches(
            "https://evil.example/trusted.example/path",
            "trusted.example/path"
        ));
        assert!(!host_matches(
            "https://trusted.example/accounting",
            "trusted.example/account"
        ));
        assert!(host_matches("https://example.com/private", "/private"));
        assert!(host_matches(
            "https://example.com/private",
            "https://example.com/private"
        ));
        assert!(host_matches("http://localhost/admin", "localhost/admin"));
        assert!(host_matches("https://example.com/private/x", "https://example.com"));
        assert!(host_matches("https://example.com/private", "https://example.com/private/"));
        assert!(host_matches("https://example.com/other", "example.com/"));
    }

    #[test]
    fn origin_filter_matches_whole_host() {
        assert!(host_matches("https://example.com/deep/page", "https://example.com/"));
    }
}
