//! Windows backend, built on UI Automation.
//!
//! UI Automation is the direct counterpart to the macOS Accessibility API: the
//! same tree of roles, names and values, and the same patterns (Invoke, Value,
//! Text) that let us press a button properly instead of guessing at pixels.
//! Coordinates remain available as a fallback for canvas-style UIs that expose
//! nothing useful.

use std::collections::HashMap;

use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::inputs::{Keyboard, Mouse, MouseButton};
use uiautomation::patterns::{UIInvokePattern, UITextPattern, UIValuePattern};
use uiautomation::types::{Handle, Point as UIPoint};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::core::BOOL;
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, EnumWindows,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SW_RESTORE, SetForegroundWindow,
    ShowWindow, WindowFromPoint, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN,
    WM_RBUTTONUP,
};

use super::{Desktop, DesktopError, Point, Result, ScrollDirection, format_app_list};
use crate::apps;

/// One wheel notch, as Windows defines it.
const WHEEL_DELTA: i32 = 120;

pub struct WindowsDesktop {
    automation: UIAutomation,
    /// Element handles from the most recent `get_app_state`, keyed by the
    /// numeric part of the `e12` ids handed to the model.
    registry: HashMap<u32, UIElement>,
}

impl WindowsDesktop {
    pub fn new() -> Result<Self> {
        let automation = UIAutomation::new().map_err(|error| {
            DesktopError::new(format!("failed to initialise UI Automation: {error}"))
        })?;
        Ok(Self {
            automation,
            registry: HashMap::new(),
        })
    }

    fn element(&self, id: u32) -> Result<&UIElement> {
        self.registry.get(&id).ok_or_else(|| {
            DesktopError::new(format!(
                "element e{id} is not in the current snapshot — call get_app_state again, ids are per-snapshot"
            ))
        })
    }

    /// Centre of an element in screen coordinates.
    fn center(element: &UIElement) -> Result<(f64, f64)> {
        let rect = element.get_bounding_rectangle().map_err(|error| {
            DesktopError::new(format!("element has no on-screen bounds: {error}"))
        })?;
        let width = rect.get_right() - rect.get_left();
        let height = rect.get_bottom() - rect.get_top();
        if width <= 0 || height <= 0 {
            return Err(DesktopError::new(
                "element is not visible on screen — scroll it into view first",
            ));
        }
        Ok((
            f64::from(rect.get_left()) + f64::from(width) / 2.0,
            f64::from(rect.get_top()) + f64::from(height) / 2.0,
        ))
    }

    fn point_coordinates(&self, target: Point) -> Result<(f64, f64)> {
        match target {
            Point::Screen(x, y) => Ok((x, y)),
            Point::Element(id) => Self::center(self.element(id)?),
        }
    }

    /// Top-level visible windows belonging to `pid`.
    fn top_level_windows(pid: u32) -> Vec<HWND> {
        struct Search {
            pid: u32,
            found: Vec<HWND>,
        }

        unsafe extern "system" fn visit(window: HWND, param: LPARAM) -> BOOL {
            // SAFETY: `param` is the `&mut Search` handed to EnumWindows below,
            // which outlives the enumeration.
            let search = unsafe { &mut *(param.0 as *mut Search) };
            let mut owner = 0u32;
            unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
            if owner == search.pid && unsafe { IsWindowVisible(window) }.as_bool() {
                search.found.push(window);
            }
            // Non-zero keeps the enumeration going.
            BOOL(1)
        }

        let mut search = Search {
            pid,
            found: Vec::new(),
        };
        let _ = unsafe {
            EnumWindows(
                Some(visit),
                LPARAM(&mut search as *mut Search as isize),
            )
        };
        search.found
    }

    /// Pack client coordinates into an `lParam` for mouse window messages.
    fn pack_client_lparam(x: i32, y: i32) -> LPARAM {
        let lo = (x as u16) as u32;
        let hi = (y as u16) as u32;
        LPARAM(((hi << 16) | lo) as isize)
    }

    /// Resolve the deepest visible child HWND under a screen point.
    fn hwnd_at_screen(x: i32, y: i32) -> Option<HWND> {
        let point = POINT { x, y };
        let top = unsafe { WindowFromPoint(point) };
        if top.0.is_null() {
            return None;
        }
        let mut client = point;
        if !unsafe { ScreenToClient(top, &mut client) }.as_bool() {
            return Some(top);
        }
        let child = unsafe {
            ChildWindowFromPointEx(top, client, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED)
        };
        if child.0.is_null() {
            Some(top)
        } else {
            Some(child)
        }
    }

    /// Deliver a left/right click via posted mouse messages so the system
    /// cursor does not move. Many Win32 apps honor this; Chromium and
    /// DirectInput often do not — callers fall back to the cursor path.
    fn background_click(x: f64, y: f64, right: bool) -> bool {
        let sx = x.round() as i32;
        let sy = y.round() as i32;
        let Some(hwnd) = Self::hwnd_at_screen(sx, sy) else {
            return false;
        };
        let mut client = POINT { x: sx, y: sy };
        if !unsafe { ScreenToClient(hwnd, &mut client) }.as_bool() {
            return false;
        }
        let lp = Self::pack_client_lparam(client.x, client.y);
        // MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002
        let (down, up, mk) = if right {
            (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002usize)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001usize)
        };
        // Prime hover state; some controls ignore down without a prior move.
        let _ = unsafe { PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), lp) };
        let down_ok = unsafe { PostMessageW(Some(hwnd), down, WPARAM(mk), lp) }.is_ok();
        let up_ok = unsafe { PostMessageW(Some(hwnd), up, WPARAM(0), lp) }.is_ok();
        down_ok && up_ok
    }

    fn scroll_wheel(horizontal: bool, notches: i32) -> Result<()> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: (notches * WHEEL_DELTA) as u32,
                    dwFlags: if horizontal {
                        MOUSEEVENTF_HWHEEL
                    } else {
                        MOUSEEVENTF_WHEEL
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err(DesktopError::new(
                "the system rejected synthetic scrolling — another app may be holding an input grab",
            ));
        }
        Ok(())
    }

    /// Render one element as an outline row, registering it when it is
    /// interactive enough to be worth an id.
    fn describe(&mut self, element: &UIElement, depth: usize, next_id: &mut u32) -> Option<String> {
        let control_type = element
            .get_control_type()
            .map(|kind| format!("{kind:?}"))
            .unwrap_or_else(|_| "Unknown".to_string());
        let name = element.get_name().unwrap_or_default();
        let value = element
            .get_pattern::<UIValuePattern>()
            .ok()
            .and_then(|pattern| pattern.get_value().ok())
            .filter(|value| !value.is_empty());

        // Rows with nothing to say are noise in an already large tree.
        if name.is_empty() && value.is_none() && control_type == "Pane" {
            return None;
        }

        let interactive = element.is_enabled().unwrap_or(false)
            && matches!(
                control_type.as_str(),
                "Button"
                    | "CheckBox"
                    | "ComboBox"
                    | "Edit"
                    | "Document"
                    | "Hyperlink"
                    | "ListItem"
                    | "MenuItem"
                    | "RadioButton"
                    | "Slider"
                    | "SplitButton"
                    | "Tab"
                    | "TabItem"
                    | "Text"
                    | "Tree"
                    | "TreeItem"
            );

        let mut row = "  ".repeat(depth);
        if interactive {
            *next_id += 1;
            row.push_str(&format!("[e{next_id}] "));
            self.registry.insert(*next_id, element.clone());
        }
        row.push_str(&control_type);
        if !name.is_empty() {
            row.push_str(&format!(" \"{}\"", truncate(&name, 120)));
        }
        if let Some(value) = value {
            row.push_str(&format!(" = \"{}\"", truncate(&value, 120)));
        }
        if !element.is_enabled().unwrap_or(true) {
            row.push_str(" (disabled)");
        }
        Some(row)
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        element: &UIElement,
        depth: usize,
        max_depth: usize,
        max_elements: usize,
        next_id: &mut u32,
        lines: &mut Vec<String>,
    ) {
        if depth > max_depth || lines.len() >= max_elements {
            return;
        }
        if let Some(row) = self.describe(element, depth, next_id) {
            lines.push(row);
        }

        let walker = match self.automation.create_tree_walker() {
            Ok(walker) => walker,
            Err(_) => return,
        };
        let mut child = walker.get_first_child(element).ok();
        while let Some(current) = child {
            if lines.len() >= max_elements {
                lines.push(format!(
                    "{}… truncated at {max_elements} elements — raise max_elements or target a child",
                    "  ".repeat(depth + 1)
                ));
                return;
            }
            self.walk(&current, depth + 1, max_depth, max_elements, next_id, lines);
            child = walker.get_next_sibling(&current).ok();
        }
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let cleaned = value.replace(['\n', '\r'], " ");
    if cleaned.chars().count() <= limit {
        return cleaned;
    }
    cleaned.chars().take(limit).collect::<String>() + "…"
}

/// Translate the tool's modifier names into the `uiautomation` key syntax.
///
/// `cmd` maps to Win rather than failing: models trained on macOS reach for it
/// constantly, and Win is the closest analogue.
fn key_sequence(key: &str, modifiers: &[String]) -> String {
    let mut sequence = String::new();
    for modifier in modifiers {
        sequence.push_str(match modifier.to_lowercase().as_str() {
            "cmd" | "command" | "win" | "super" | "meta" => "{win}",
            "ctrl" | "control" => "{ctrl}",
            "alt" | "option" => "{alt}",
            "shift" => "{shift}",
            // `fn` has no synthetic equivalent on Windows; dropping it is better
            // than refusing an otherwise valid chord.
            _ => "",
        });
    }
    sequence.push_str(&match key.to_lowercase().as_str() {
        "return" | "enter" => "{enter}".to_string(),
        "tab" => "{tab}".to_string(),
        "escape" | "esc" => "{esc}".to_string(),
        "space" => " ".to_string(),
        "backspace" | "delete" => "{backspace}".to_string(),
        "up" => "{up}".to_string(),
        "down" => "{down}".to_string(),
        "left" => "{left}".to_string(),
        "right" => "{right}".to_string(),
        "home" => "{home}".to_string(),
        "end" => "{end}".to_string(),
        other => other.to_string(),
    });
    sequence
}

impl Desktop for WindowsDesktop {
    fn list_apps(&mut self) -> Result<String> {
        Ok(format_app_list(apps::list_apps()?))
    }

    fn resolve_pid(&mut self, app: &str) -> Result<u32> {
        apps::resolve_pid(app)
    }

    fn get_app_state(&mut self, app: &str, max_depth: usize, max_elements: usize) -> Result<String> {
        let pid = apps::resolve_pid(app)?;
        let windows = Self::top_level_windows(pid);
        if windows.is_empty() {
            return Err(DesktopError::new(format!(
                "{app} (pid {pid}) has no visible window"
            )));
        }

        // Ids are per-snapshot, so previous handles must not resolve.
        self.registry.clear();
        let mut next_id = 0u32;
        let mut lines = vec![format!("{app} (pid {pid}), {} window(s)", windows.len())];

        for (index, window) in windows.iter().enumerate() {
            let element = match self
                .automation
                .element_from_handle(Handle::from(window.0 as isize))
            {
                Ok(element) => element,
                Err(_) => continue,
            };
            let title = element.get_name().unwrap_or_default();
            lines.push(String::new());
            lines.push(format!("── window {index}: \"{title}\""));
            let mut window_lines = Vec::new();
            self.walk(
                &element,
                0,
                max_depth,
                max_elements,
                &mut next_id,
                &mut window_lines,
            );
            lines.extend(window_lines);
        }

        if next_id == 0 {
            lines.push(String::new());
            lines.push(
                "no interactive elements found — the app may render its own UI, so use screenshot \
                 and click with coordinates"
                    .to_string(),
            );
        }
        Ok(lines.join("\n"))
    }

    fn activate_app(&mut self, app: &str) -> Result<String> {
        let pid = apps::resolve_pid(app)?;
        let windows = Self::top_level_windows(pid);
        let window = windows.first().ok_or_else(|| {
            DesktopError::new(format!("{app} (pid {pid}) has no window to activate"))
        })?;
        unsafe {
            let _ = ShowWindow(*window, SW_RESTORE);
        }
        let raised = unsafe { SetForegroundWindow(*window) };
        if !raised.as_bool() {
            // Windows refuses foreground changes from background processes in
            // some states; say so rather than claim a success the model can see
            // is false in the next screenshot.
            return Err(DesktopError::new(format!(
                "Windows refused to bring {app} forward — click its taskbar button, or try again \
                 after interacting with the desktop"
            )));
        }
        Ok(format!("activated {app} (pid {pid})"))
    }

    fn click(&mut self, target: Point, click_count: u32) -> Result<String> {
        // An element press goes through the control's own Invoke handler, which
        // is far more reliable than a synthetic click landing on the right pixel.
        if let Point::Element(id) = target
            && click_count == 1
            && let Ok(element) = self.element(id)
            && let Ok(invoke) = element.get_pattern::<UIInvokePattern>()
            && invoke.invoke().is_ok()
        {
            return Ok(format!("pressed e{id}"));
        }

        let (x, y) = self.point_coordinates(target)?;
        // Prefer window-message delivery so the user's cursor stays put.
        if click_count <= 1 && Self::background_click(x, y, false) {
            return Ok(format!("clicked at ({x:.0}, {y:.0}) in background"));
        }

        let mouse = Mouse::default();
        let point = UIPoint::new(x as i32, y as i32);
        for _ in 0..click_count.max(1) {
            mouse
                .click(&point)
                .map_err(|error| DesktopError::new(format!("click failed: {error}")))?;
        }
        Ok(format!(
            "clicked at ({:.0}, {:.0}) via cursor{}",
            x,
            y,
            if click_count > 1 {
                format!(" x{click_count}")
            } else {
                String::new()
            }
        ))
    }

    fn right_click(&mut self, target: Point) -> Result<String> {
        let (x, y) = self.point_coordinates(target)?;
        if Self::background_click(x, y, true) {
            return Ok(format!("right-clicked at ({x:.0}, {y:.0}) in background"));
        }
        Mouse::default()
            .right_click(&UIPoint::new(x as i32, y as i32))
            .map_err(|error| DesktopError::new(format!("right click failed: {error}")))?;
        Ok(format!("right-clicked at ({x:.0}, {y:.0}) via cursor"))
    }

    fn drag(&mut self, from: Point, to: Point) -> Result<String> {
        let (from_x, from_y) = self.point_coordinates(from)?;
        let (to_x, to_y) = self.point_coordinates(to)?;
        let mouse = Mouse::default();
        mouse
            .move_to(&UIPoint::new(from_x as i32, from_y as i32))
            .map_err(|error| DesktopError::new(format!("could not reach the drag origin: {error}")))?;
        mouse
            .drag_to(MouseButton::LEFT, &UIPoint::new(to_x as i32, to_y as i32))
            .map_err(|error| DesktopError::new(format!("drag failed: {error}")))?;
        Ok(format!(
            "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0})"
        ))
    }

    fn type_text(&mut self, text: &str, element: Option<u32>) -> Result<String> {
        if let Some(id) = element {
            self.element(id)?
                .set_focus()
                .map_err(|error| DesktopError::new(format!("could not focus e{id}: {error}")))?;
        }
        Keyboard::default()
            .send_text(text)
            .map_err(|error| DesktopError::new(format!("typing failed: {error}")))?;
        Ok(format!("typed {} characters", text.chars().count()))
    }

    fn press_key(&mut self, key: &str, modifiers: &[String]) -> Result<String> {
        let sequence = key_sequence(key, modifiers);
        Keyboard::default()
            .send_keys(&sequence)
            .map_err(|error| DesktopError::new(format!("key press failed: {error}")))?;
        Ok(if modifiers.is_empty() {
            format!("pressed {key}")
        } else {
            format!("pressed {}+{key}", modifiers.join("+"))
        })
    }

    fn scroll(
        &mut self,
        direction: ScrollDirection,
        amount: i32,
        element: Option<u32>,
    ) -> Result<String> {
        // The wheel goes to whatever is under the cursor, so move there first.
        if let Some(id) = element {
            let (x, y) = Self::center(self.element(id)?)?;
            Mouse::default()
                .move_to(&UIPoint::new(x as i32, y as i32))
                .map_err(|error| DesktopError::new(format!("could not move cursor: {error}")))?;
        }
        let (horizontal, vertical) = direction.deltas(amount);
        if horizontal != 0 {
            Self::scroll_wheel(true, horizontal)?;
        }
        if vertical != 0 {
            Self::scroll_wheel(false, vertical)?;
        }
        Ok(format!("scrolled {direction:?} by {amount}").to_lowercase())
    }

    fn set_value(&mut self, element: u32, value: &str) -> Result<String> {
        let target = self.element(element)?;
        let pattern = target.get_pattern::<UIValuePattern>().map_err(|_| {
            DesktopError::new(format!(
                "e{element} does not accept a value directly — click it and use type_text"
            ))
        })?;
        pattern
            .set_value(value)
            .map_err(|error| DesktopError::new(format!("could not set e{element}: {error}")))?;
        Ok(format!("set e{element} to \"{}\"", truncate(value, 80)))
    }

    fn select_text(&mut self, element: u32, start: usize, length: Option<usize>) -> Result<String> {
        let target = self.element(element)?;
        let pattern = target.get_pattern::<UITextPattern>().map_err(|_| {
            DesktopError::new(format!("e{element} does not expose selectable text"))
        })?;
        let document = pattern
            .get_document_range()
            .map_err(|error| DesktopError::new(format!("could not read e{element}: {error}")))?;
        let text = document.get_text(-1).unwrap_or_default();
        let total = text.chars().count();
        let start = start.min(total);
        let end = length.map_or(total, |count| (start + count).min(total));

        let range = document.clone();
        range
            .move_endpoint_by_unit(
                uiautomation::types::TextPatternRangeEndpoint::Start,
                uiautomation::types::TextUnit::Character,
                start as i32,
            )
            .and_then(|_| {
                range.move_endpoint_by_unit(
                    uiautomation::types::TextPatternRangeEndpoint::End,
                    uiautomation::types::TextUnit::Character,
                    -((total - end) as i32),
                )
            })
            .and_then(|_| range.select())
            .map_err(|error| DesktopError::new(format!("could not select in e{element}: {error}")))?;
        Ok(format!("selected {} characters in e{element}", end - start))
    }
}

#[cfg(test)]
mod tests {
    use super::{key_sequence, truncate};

    #[test]
    fn cmd_is_translated_to_the_windows_key() {
        // Models trained on macOS send cmd constantly; refusing it would make
        // every save and copy fail on Windows.
        assert_eq!(key_sequence("s", &["cmd".to_string()]), "{win}s");
        assert_eq!(key_sequence("s", &["ctrl".to_string()]), "{ctrl}s");
    }

    #[test]
    fn named_keys_become_uiautomation_tokens() {
        assert_eq!(key_sequence("return", &[]), "{enter}");
        assert_eq!(key_sequence("Escape", &[]), "{esc}");
        assert_eq!(
            key_sequence("a", &["ctrl".to_string(), "shift".to_string()]),
            "{ctrl}{shift}a"
        );
    }

    #[test]
    fn an_unknown_modifier_is_dropped_rather_than_breaking_the_chord() {
        assert_eq!(key_sequence("c", &["fn".to_string(), "ctrl".to_string()]), "{ctrl}c");
    }

    #[test]
    fn truncation_collapses_newlines_and_marks_elision() {
        assert_eq!(truncate("one\ntwo", 40), "one two");
        let long = truncate(&"x".repeat(200), 10);
        assert_eq!(long.chars().count(), 11, "10 chars plus the ellipsis");
        assert!(long.ends_with('…'));
    }
}
