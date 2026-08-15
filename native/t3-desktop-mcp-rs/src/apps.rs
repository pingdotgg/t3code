//! Running-application discovery, shared by the Windows and Linux backends.
//!
//! Both platforms can enumerate windows through `xcap`, and a window list is
//! exactly what `list_apps` reports: an app with no window is not something the
//! model can drive, so grouping windows by pid gives the right answer on both
//! without touching Win32 or X11 directly.

use std::collections::HashMap;

use xcap::Window;

use crate::platform::{AppInfo, DesktopError, Result};

struct Group {
    name: String,
    pid: u32,
    windows: usize,
    focused: bool,
}

fn grouped_windows() -> Result<Vec<Group>> {
    // xcap's `Window::all` enumerates via X11/`xcb` when `DISPLAY` is set — no
    // process-wide `WAYLAND_DISPLAY` mutation needed (that is UB with threads).
    // Same panic hazard as capture: xcap aborts on compositors it cannot read.
    let windows = std::panic::catch_unwind(Window::all)
        .map_err(|_| DesktopError::new("window enumeration is not supported by this display server"))?
        .map_err(|error| DesktopError::new(format!("failed to enumerate windows: {error}")))?;

    let mut groups: HashMap<u32, Group> = HashMap::new();
    for window in windows {
        let pid = window.pid().unwrap_or(0);
        if pid == 0 || window.is_minimized().unwrap_or(false) {
            continue;
        }
        // Some compositors report zero-sized shadow windows; they are not
        // something a model can act on and would inflate the window count.
        if window.width().unwrap_or(0) == 0 || window.height().unwrap_or(0) == 0 {
            continue;
        }

        let name = window
            .app_name()
            .ok()
            .filter(|name| !name.is_empty())
            .or_else(|| window.title().ok().filter(|title| !title.is_empty()))
            .unwrap_or_else(|| format!("pid {pid}"));
        let focused = window.is_focused().unwrap_or(false);

        groups
            .entry(pid)
            .and_modify(|group| {
                group.windows += 1;
                group.focused |= focused;
            })
            .or_insert(Group {
                name,
                pid,
                windows: 1,
                focused,
            });
    }

    Ok(groups.into_values().collect())
}

pub fn list_apps() -> Result<Vec<AppInfo>> {
    Ok(grouped_windows()
        .map(|groups| {
            groups
                .into_iter()
                .map(|group| AppInfo {
                    id: group.name.to_lowercase().replace(' ', "-"),
                    name: group.name,
                    pid: group.pid,
                    windows: group.windows,
                    frontmost: group.focused,
                })
                .collect()
        })?)
}

/// Resolve an app query to a pid.
///
/// Accepts a literal pid, an exact name, or a unique case-insensitive substring.
/// An ambiguous substring is an error listing the candidates rather than a guess,
/// because silently driving the wrong window is worse than asking again.
pub fn resolve_pid(query: &str) -> Result<u32> {
    let query = query.trim();
    if let Ok(pid) = query.parse::<u32>() {
        return Ok(pid);
    }

    // Minimal window managers (WSLg among them) do not publish the EWMH
    // properties window enumeration needs. Keep the guidance rather than
    // surfacing an X11 property name the model can do nothing with.
    let apps = list_apps().map_err(|error| {
        DesktopError::new(format!(
            "cannot enumerate windows on this session ({}) — call list_apps, or pass a numeric pid",
            error.0
        ))
    })?;
    let lowered = query.to_lowercase();

    let exact: Vec<&AppInfo> = apps
        .iter()
        .filter(|app| app.name.to_lowercase() == lowered || app.id == lowered)
        .collect();
    if !exact.is_empty() {
        return pick_from_matches(query, &exact);
    }

    let matches: Vec<&AppInfo> = apps
        .iter()
        .filter(|app| app.name.to_lowercase().contains(&lowered))
        .collect();
    pick_from_matches(query, &matches)
}

fn pick_from_matches(query: &str, matches: &[&AppInfo]) -> Result<u32> {
    match matches {
        [single] => Ok(single.pid),
        [] => Err(DesktopError::new(format!(
            "no running app matches '{query}' — call list_apps to see what is open"
        ))),
        several => {
            let names: Vec<String> = several
                .iter()
                .map(|app| format!("{} (pid {})", app.name, app.pid))
                .collect();
            Err(DesktopError::new(format!(
                "'{query}' matches several apps: {} — pass a pid to pick one",
                names.join(", ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_pid;

    #[test]
    fn a_numeric_query_is_taken_as_a_pid_without_enumerating() {
        // Must hold on a headless CI box where window enumeration returns nothing.
        assert_eq!(resolve_pid("4321").unwrap(), 4321);
        assert_eq!(resolve_pid("  4321  ").unwrap(), 4321);
    }

    #[test]
    fn an_unmatched_name_points_at_list_apps() {
        let error = resolve_pid("definitely-not-running-xyzzy").unwrap_err().0;
        assert!(error.contains("list_apps"), "unhelpful: {error}");
    }
}
