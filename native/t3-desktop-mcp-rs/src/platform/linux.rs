//! Linux backend: AT-SPI for the accessibility tree, XTEST for synthetic input.
//!
//! Two caveats shape this file, and both are reported to the model rather than
//! hidden:
//!
//! * AT-SPI is opt-in. Toolkits expose a tree only when accessibility is
//!   enabled, so an app can be running and still have nothing to read.
//! * Wayland refuses synthetic input by design. XTEST reaches X11 and XWayland
//!   clients; a native Wayland client will ignore it, so we say so instead of
//!   silently doing nothing.

use std::collections::HashMap;

use atspi::proxy::accessible::AccessibleProxy;
use atspi::{connection::AccessibilityConnection, Role};
use futures_lite::future::block_on;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, GetKeyboardMappingReply, Keycode};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

use super::{Desktop, DesktopError, Point, Result, ScrollDirection, format_app_list};
use crate::apps;

/// X11 button numbers.
const BUTTON_LEFT: u8 = 1;
const BUTTON_RIGHT: u8 = 3;
const BUTTON_SCROLL_UP: u8 = 4;
const BUTTON_SCROLL_DOWN: u8 = 5;
const BUTTON_SCROLL_LEFT: u8 = 6;
const BUTTON_SCROLL_RIGHT: u8 = 7;

/// Where an element lives on the AT-SPI bus. Proxies borrow their connection,
/// so the registry stores addresses and rebuilds a proxy on demand.
#[derive(Clone)]
struct ElementRef {
    bus: String,
    path: String,
}

pub struct LinuxDesktop {
    accessibility: Option<AccessibilityConnection>,
    x11: Option<(RustConnection, usize)>,
    registry: HashMap<u32, ElementRef>,
}

impl LinuxDesktop {
    pub fn new() -> Result<Self> {
        // Neither half is fatal on its own: a session with no a11y bus can still
        // click by coordinate, and a session with no X11 can still read a tree.
        let accessibility = block_on(AccessibilityConnection::new()).ok();
        let x11 = x11rb::connect(None).ok().map(|(conn, screen)| (conn, screen));
        Ok(Self {
            accessibility,
            x11,
            registry: HashMap::new(),
        })
    }

    fn bus(&self) -> Result<&AccessibilityConnection> {
        self.accessibility.as_ref().ok_or_else(|| {
            DesktopError::new(
                "no AT-SPI bus on this session — start at-spi2-core (and set \
                 GTK_MODULES=gail:atk-bridge for GTK apps) to read accessibility trees; \
                 screenshot and coordinate clicks still work",
            )
        })
    }

    fn x11(&self) -> Result<&(RustConnection, usize)> {
        self.x11.as_ref().ok_or_else(|| {
            DesktopError::new(
                "no X11 display — synthetic input needs X11 or XWayland (native Wayland \
                 refuses it by design). Set DISPLAY, or interact through the app's own UI",
            )
        })
    }

    fn proxy<'a>(
        &'a self,
        element: &ElementRef,
    ) -> Result<AccessibleProxy<'a>> {
        let connection = self.bus()?;
        block_on(
            AccessibleProxy::builder(connection.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element is gone: {error}")))
    }

    fn element(&self, id: u32) -> Result<ElementRef> {
        self.registry.get(&id).cloned().ok_or_else(|| {
            DesktopError::new(format!(
                "element e{id} is not in the current snapshot — call get_app_state again, ids are per-snapshot"
            ))
        })
    }

    /// Screen rectangle centre of an element, via the Component interface.
    fn center(&self, element: &ElementRef) -> Result<(f64, f64)> {
        let proxy = self.proxy(element)?;
        let component = block_on(
            atspi::proxy::component::ComponentProxy::builder(self.bus()?.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element has no geometry: {error}")))?;
        drop(proxy);

        let extents = block_on(component.get_extents(atspi::CoordType::Screen))
            .map_err(|error| DesktopError::new(format!("could not read bounds: {error}")))?;
        if extents.2 <= 0 || extents.3 <= 0 {
            return Err(DesktopError::new(
                "element is not visible on screen — scroll it into view first",
            ));
        }
        Ok((
            f64::from(extents.0) + f64::from(extents.2) / 2.0,
            f64::from(extents.1) + f64::from(extents.3) / 2.0,
        ))
    }

    /// Write text straight into an element through AT-SPI.
    ///
    /// Preferred over XTEST wherever it works: synthetic keys go to whatever
    /// currently holds X11 focus, which under a compositor is not reliably the
    /// element we were asked to type into. This addresses the element directly.
    fn insert_text(&self, element: &ElementRef, text: &str, replace: bool) -> Result<()> {
        let editable = block_on(
            atspi::proxy::editable_text::EditableTextProxy::builder(self.bus()?.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element is not editable: {error}")))?;

        if replace {
            return match block_on(editable.set_text_contents(text)) {
                Ok(true) => Ok(()),
                Ok(false) => Err(DesktopError::new("the element refused the new contents")),
                Err(error) => Err(DesktopError::new(format!("write failed: {error}"))),
            };
        }

        // Append at the caret rather than the start, so repeated calls read the
        // way a person typing would expect.
        let caret = self.caret_offset(element).unwrap_or(0);
        match block_on(editable.insert_text(caret, text, text.chars().count() as i32)) {
            Ok(true) => Ok(()),
            Ok(false) => Err(DesktopError::new("the element refused the text")),
            Err(error) => Err(DesktopError::new(format!("write failed: {error}"))),
        }
    }

    fn text_proxy<'a>(
        &'a self,
        element: &ElementRef,
    ) -> Result<atspi::proxy::text::TextProxy<'a>> {
        block_on(
            atspi::proxy::text::TextProxy::builder(self.bus()?.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element exposes no text: {error}")))
    }

    fn caret_offset(&self, element: &ElementRef) -> Result<i32> {
        let text = self.text_proxy(element)?;
        block_on(text.caret_offset())
            .map_err(|error| DesktopError::new(format!("could not read the caret: {error}")))
    }

    /// Ask the toolkit to focus an element, which also raises its window on most
    /// desktops — the closest portable equivalent to activating an app.
    fn grab_focus(&self, element: &ElementRef) -> Result<bool> {
        let component = block_on(
            atspi::proxy::component::ComponentProxy::builder(self.bus()?.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element cannot take focus: {error}")))?;
        block_on(component.grab_focus())
            .map_err(|error| DesktopError::new(format!("focus refused: {error}")))
    }

    /// Run an element's first accessible action, which toolkits map to "press"
    /// for buttons, links and menu items.
    fn invoke(&self, element: &ElementRef) -> Result<()> {
        let action = block_on(
            atspi::proxy::action::ActionProxy::builder(self.bus()?.connection())
                .destination(element.bus.clone())
                .and_then(|builder| builder.path(element.path.clone()))
                .map_err(|error| DesktopError::new(format!("bad element address: {error}")))?
                .build(),
        )
        .map_err(|error| DesktopError::new(format!("element exposes no actions: {error}")))?;

        match block_on(action.do_action(0)) {
            Ok(true) => Ok(()),
            Ok(false) => Err(DesktopError::new("the element refused its press action")),
            Err(error) => Err(DesktopError::new(format!("press failed: {error}"))),
        }
    }

    fn point_coordinates(&self, target: Point) -> Result<(f64, f64)> {
        match target {
            Point::Screen(x, y) => Ok((x, y)),
            Point::Element(id) => self.center(&self.element(id)?),
        }
    }

    fn move_pointer(&self, x: f64, y: f64) -> Result<()> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[*screen].root;
        connection
            .xtest_fake_input(6 /* MotionNotify */, 0, 0, root, x as i16, y as i16, 0)
            .map_err(|error| DesktopError::new(format!("could not move pointer: {error}")))?;
        connection
            .flush()
            .map_err(|error| DesktopError::new(format!("X11 flush failed: {error}")))?;
        Ok(())
    }

    fn button(&self, button: u8, press: bool) -> Result<()> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[*screen].root;
        // 4 = ButtonPress, 5 = ButtonRelease
        connection
            .xtest_fake_input(if press { 4 } else { 5 }, button, 0, root, 0, 0, 0)
            .map_err(|error| DesktopError::new(format!("could not send button event: {error}")))?;
        connection
            .flush()
            .map_err(|error| DesktopError::new(format!("X11 flush failed: {error}")))?;
        Ok(())
    }

    fn tap_button(&self, button: u8) -> Result<()> {
        self.button(button, true)?;
        self.button(button, false)
    }

    fn keyboard_mapping(&self) -> Result<(GetKeyboardMappingReply, u8)> {
        let (connection, _) = self.x11()?;
        let setup = connection.setup();
        let first = setup.min_keycode;
        let count = setup.max_keycode - setup.min_keycode + 1;
        let mapping = connection
            .get_keyboard_mapping(first, count)
            .map_err(|error| DesktopError::new(format!("could not read keymap: {error}")))?
            .reply()
            .map_err(|error| DesktopError::new(format!("could not read keymap: {error}")))?;
        Ok((mapping, first))
    }

    /// Find a keycode (and whether shift is needed) producing `keysym`.
    fn keycode_for(&self, keysym: u32) -> Result<Option<(Keycode, bool)>> {
        let (mapping, first) = self.keyboard_mapping()?;
        let per = mapping.keysyms_per_keycode as usize;
        for (index, chunk) in mapping.keysyms.chunks(per).enumerate() {
            if chunk.first().copied() == Some(keysym) {
                return Ok(Some((first + index as u8, false)));
            }
            if per > 1 && chunk.get(1).copied() == Some(keysym) {
                return Ok(Some((first + index as u8, true)));
            }
        }
        Ok(None)
    }

    fn tap_keycode(&self, keycode: Keycode, shift: bool) -> Result<()> {
        let shift_code = self
            .keycode_for(0xffe1 /* Shift_L */)?
            .map(|(code, _)| code);
        if shift && let Some(code) = shift_code {
            self.key(code, true)?;
        }
        self.key(keycode, true)?;
        self.key(keycode, false)?;
        if shift && let Some(code) = shift_code {
            self.key(code, false)?;
        }
        Ok(())
    }

    fn key(&self, keycode: Keycode, press: bool) -> Result<()> {
        let (connection, screen) = self.x11()?;
        let root = connection.setup().roots[*screen].root;
        // 2 = KeyPress, 3 = KeyRelease
        connection
            .xtest_fake_input(if press { 2 } else { 3 }, keycode, 0, root, 0, 0, 0)
            .map_err(|error| DesktopError::new(format!("could not send key event: {error}")))?;
        connection
            .flush()
            .map_err(|error| DesktopError::new(format!("X11 flush failed: {error}")))?;
        Ok(())
    }

    /// Type one character, remapping a scratch keycode when the current layout
    /// cannot produce it. This is how xdotool handles accented and non-Latin
    /// text, and without it typing would silently drop characters.
    fn type_char(&self, character: char) -> Result<()> {
        let keysym = char_to_keysym(character);
        if let Some((keycode, shift)) = self.keycode_for(keysym)? {
            return self.tap_keycode(keycode, shift);
        }

        let (connection, _) = self.x11()?;
        let (mapping, first) = self.keyboard_mapping()?;
        let per = mapping.keysyms_per_keycode as usize;
        // A keycode whose every slot is NoSymbol is free to borrow.
        let scratch = mapping
            .keysyms
            .chunks(per)
            .position(|chunk| chunk.iter().all(|symbol| *symbol == 0))
            .map(|index| first + index as u8)
            .ok_or_else(|| {
                DesktopError::new(format!(
                    "'{character}' is not on the current keyboard layout and no spare keycode is free"
                ))
            })?;

        let replacement = vec![keysym; per];
        connection
            .change_keyboard_mapping(1, scratch, per as u8, &replacement)
            .map_err(|error| DesktopError::new(format!("could not remap keycode: {error}")))?
            .check()
            .map_err(|error| DesktopError::new(format!("could not remap keycode: {error}")))?;
        connection
            .flush()
            .map_err(|error| DesktopError::new(format!("X11 flush failed: {error}")))?;

        let result = self.tap_keycode(scratch, false);

        // Always hand the keycode back, even if the tap failed, or the user's
        // keyboard keeps our borrowed mapping.
        let cleared = vec![0u32; per];
        let _ = connection
            .change_keyboard_mapping(1, scratch, per as u8, &cleared)
            .map(|cookie| cookie.check());
        let _ = connection.flush();
        result
    }

    fn walk(
        &mut self,
        element: &ElementRef,
        depth: usize,
        max_depth: usize,
        max_elements: usize,
        next_id: &mut u32,
        lines: &mut Vec<String>,
    ) {
        if depth > max_depth || lines.len() >= max_elements {
            return;
        }
        // Read everything the proxy can tell us, then drop it: it borrows
        // `self`, and the registry below needs that borrow released.
        let Some((name, role, children)) = ({
            match self.proxy(element) {
                Ok(proxy) => {
                    let name = block_on(proxy.name()).unwrap_or_default();
                    let role = block_on(proxy.get_role()).unwrap_or(Role::Invalid);
                    let children = block_on(proxy.get_children()).unwrap_or_default();
                    Some((name, role, children))
                }
                Err(_) => None,
            }
        }) else {
            return;
        };

        let interactive = matches!(
            role,
            Role::Button
                | Role::CheckBox
                | Role::ComboBox
                | Role::Entry
                | Role::Link
                | Role::ListItem
                | Role::MenuItem
                | Role::PasswordText
                | Role::RadioButton
                | Role::Slider
                | Role::Text
                | Role::ToggleButton
                | Role::TreeItem
        );

        if !name.is_empty() || interactive {
            let mut row = "  ".repeat(depth);
            if interactive {
                *next_id += 1;
                row.push_str(&format!("[e{next_id}] "));
                self.registry.insert(*next_id, element.clone());
            }
            row.push_str(&format!("{role:?}"));
            if !name.is_empty() {
                row.push_str(&format!(" \"{}\"", truncate(&name, 120)));
            }
            // Screen bounds let a model fall back to coordinates when an element
            // has no usable action, and make a wrong-looking click diagnosable.
            if interactive && let Ok((x, y)) = self.center(element) {
                row.push_str(&format!(" @({x:.0},{y:.0})"));
            }
            lines.push(row);
        }

        for child in children {
            if lines.len() >= max_elements {
                lines.push(format!(
                    "{}… truncated at {max_elements} elements — raise max_elements or target a child",
                    "  ".repeat(depth + 1)
                ));
                return;
            }
            let reference = ElementRef {
                bus: child.name().map(|name| name.to_string()).unwrap_or_default(),
                path: child.path().to_string(),
            };
            self.walk(&reference, depth + 1, max_depth, max_elements, next_id, lines);
        }
    }

    /// Top-level application objects on the a11y bus, with their pids.
    fn applications(&self) -> Result<Vec<(ElementRef, String, u32)>> {
        let connection = self.bus()?;
        let root = AccessibleProxy::builder(connection.connection())
            .destination("org.a11y.atspi.Registry")
            .and_then(|builder| builder.path("/org/a11y/atspi/accessible/root"))
            .map_err(|error| DesktopError::new(format!("bad registry address: {error}")))?;
        let root = block_on(root.build())
            .map_err(|error| DesktopError::new(format!("no a11y registry: {error}")))?;

        let children = block_on(root.get_children())
            .map_err(|error| DesktopError::new(format!("could not list applications: {error}")))?;

        let mut applications = Vec::new();
        for child in children {
            let reference = ElementRef {
                bus: child.name().map(|name| name.to_string()).unwrap_or_default(),
                path: child.path().to_string(),
            };
            let Ok(proxy) = self.proxy(&reference) else {
                continue;
            };
            let name = block_on(proxy.name()).unwrap_or_default();
            // AT-SPI exposes the owning pid through the application interface;
            // fall back to zero so a nameless app is still listed.
            let pid = block_on(proxy.get_application())
                .ok()
                .and_then(|_| None::<u32>)
                .unwrap_or(0);
            applications.push((reference, name, pid));
        }
        Ok(applications)
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let cleaned = value.replace(['\n', '\r'], " ");
    if cleaned.chars().count() <= limit {
        return cleaned;
    }
    cleaned.chars().take(limit).collect::<String>() + "…"
}

/// Map a character to an X11 keysym.
///
/// Latin-1 is its own keysym range; everything else uses the Unicode range
/// X11 reserves for exactly this purpose.
fn char_to_keysym(character: char) -> u32 {
    let code = character as u32;
    if (0x20..=0xff).contains(&code) {
        code
    } else {
        0x0100_0000 + code
    }
}

/// Named keys the model can send, in X11 keysym terms.
fn named_keysym(key: &str) -> Option<u32> {
    Some(match key.to_lowercase().as_str() {
        "return" | "enter" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "space" => 0x0020,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "up" => 0xff52,
        "down" => 0xff54,
        "left" => 0xff51,
        "right" => 0xff53,
        "home" => 0xff50,
        "end" => 0xff57,
        "page_up" | "pageup" => 0xff55,
        "page_down" | "pagedown" => 0xff56,
        _ => return None,
    })
}

/// Modifier names to keysyms. `cmd` becomes Super, matching the Windows path.
fn modifier_keysym(modifier: &str) -> Option<u32> {
    Some(match modifier.to_lowercase().as_str() {
        "ctrl" | "control" => 0xffe3,
        "shift" => 0xffe1,
        "alt" | "option" => 0xffe9,
        "cmd" | "command" | "super" | "meta" | "win" => 0xffeb,
        _ => return None,
    })
}

impl Desktop for LinuxDesktop {
    fn list_apps(&mut self) -> Result<String> {
        // Window enumeration needs EWMH properties that minimal window managers
        // (WSLg included) do not publish, and the accessibility bus is the more
        // relevant view here anyway: an app absent from it cannot be driven.
        let focused = apps::list_apps()
            .ok()
            .and_then(|apps| {
                apps.into_iter()
                    .find(|app| app.frontmost)
                    .map(|app| app.name.to_lowercase())
            })
            .unwrap_or_default();
        if let Ok(applications) = self.applications()
            && !applications.is_empty()
        {
            let mut lines: Vec<String> = applications
                .into_iter()
                .filter(|(_, name, _)| !name.is_empty())
                .map(|(_, name, pid)| {
                    let is_frontmost = !focused.is_empty()
                        && (name.to_lowercase() == focused
                            || name.to_lowercase().contains(&focused)
                            || focused.contains(&name.to_lowercase()));
                    let marker = if is_frontmost { "  FRONTMOST" } else { "" };
                    if pid == 0 {
                        format!("{name}  [a11y]{marker}")
                    } else {
                        format!("{name}  [a11y]  pid={pid}{marker}")
                    }
                })
                .collect();
            if !lines.is_empty() {
                // If nothing matched the compositor focus, mark the first app so
                // Computer History still has a frontmost sample target.
                if !lines.iter().any(|line| line.contains("FRONTMOST")) {
                    if let Some(first) = lines.first_mut() {
                        first.push_str("  FRONTMOST");
                    }
                }
                lines.sort_by_key(|line| (!line.contains("FRONTMOST"), line.to_lowercase()));
                return Ok(lines.join("\n"));
            }
        }
        Ok(format_app_list(apps::list_apps()?))
    }

    fn resolve_pid(&mut self, app: &str) -> Result<u32> {
        apps::resolve_pid(app)
    }

    fn get_app_state(&mut self, app: &str, max_depth: usize, max_elements: usize) -> Result<String> {
        let applications = self.applications()?;
        let lowered = app.to_lowercase();
        let (reference, name, _) = applications
            .into_iter()
            .find(|(_, name, _)| name.to_lowercase().contains(&lowered))
            .ok_or_else(|| {
                DesktopError::new(format!(
                    "no app on the accessibility bus matches '{app}'. Toolkits only publish a tree \
                     when accessibility is enabled — try screenshot plus coordinate clicks instead"
                ))
            })?;

        self.registry.clear();
        let mut next_id = 0u32;
        let mut lines = vec![format!("{name}")];
        self.walk(
            &reference,
            0,
            max_depth,
            max_elements,
            &mut next_id,
            &mut lines,
        );
        if next_id == 0 {
            lines.push(
                "no interactive elements exposed — use screenshot and click with coordinates"
                    .to_string(),
            );
        }
        Ok(lines.join("\n"))
    }

    fn activate_app(&mut self, app: &str) -> Result<String> {
        // There is no portable "raise this window" verb on Linux, but focusing
        // the app's frame gets there on most desktops.
        let applications = self.applications()?;
        let lowered = app.to_lowercase();
        let (reference, name, _) = applications
            .into_iter()
            .find(|(_, name, _)| name.to_lowercase().contains(&lowered))
            .ok_or_else(|| {
                DesktopError::new(format!("no app on the accessibility bus matches '{app}'"))
            })?;

        // The application object itself cannot take focus; its first frame can.
        let frames = {
            match self.proxy(&reference) {
                Ok(proxy) => block_on(proxy.get_children()).unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };
        for frame in frames {
            let child = ElementRef {
                bus: frame.name().map(|name| name.to_string()).unwrap_or_default(),
                path: frame.path().to_string(),
            };
            if self.grab_focus(&child).unwrap_or(false) {
                return Ok(format!("activated {name}"));
            }
        }
        Err(DesktopError::new(format!(
            "{name} refused focus — window managers vary here. The other tools do not need it \
             focused, so carry on without activating it"
        )))
    }

    fn click(&mut self, target: Point, click_count: u32) -> Result<String> {
        // Prefer the element's own action. Wayland clients cannot learn their
        // absolute screen position, so AT-SPI reports geometry relative to the
        // window and synthetic clicks would land in the wrong place. Invoking
        // the action sidesteps coordinates entirely, and matches what the
        // Windows backend does with the Invoke pattern.
        if let Point::Element(id) = target
            && click_count == 1
        {
            let reference = self.element(id)?;
            if self.invoke(&reference).is_ok() {
                return Ok(format!("pressed e{id}"));
            }
        }

        let (x, y) = self.point_coordinates(target)?;
        self.move_pointer(x, y)?;
        for _ in 0..click_count.max(1) {
            self.tap_button(BUTTON_LEFT)?;
        }
        Ok(format!(
            "clicked at ({x:.0}, {y:.0}){}",
            if click_count > 1 {
                format!(" x{click_count}")
            } else {
                String::new()
            }
        ))
    }

    fn right_click(&mut self, target: Point) -> Result<String> {
        let (x, y) = self.point_coordinates(target)?;
        self.move_pointer(x, y)?;
        self.tap_button(BUTTON_RIGHT)?;
        Ok(format!("right-clicked at ({x:.0}, {y:.0})"))
    }

    fn drag(&mut self, from: Point, to: Point) -> Result<String> {
        let (from_x, from_y) = self.point_coordinates(from)?;
        let (to_x, to_y) = self.point_coordinates(to)?;
        self.move_pointer(from_x, from_y)?;
        self.button(BUTTON_LEFT, true)?;
        // A single jump can read as a click to apps that track motion, so step.
        for step in 1..=10 {
            let progress = f64::from(step) / 10.0;
            self.move_pointer(
                from_x + (to_x - from_x) * progress,
                from_y + (to_y - from_y) * progress,
            )?;
        }
        self.button(BUTTON_LEFT, false)?;
        Ok(format!(
            "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0})"
        ))
    }

    fn type_text(&mut self, text: &str, element: Option<u32>) -> Result<String> {
        // With a target element, write through AT-SPI: it does not depend on
        // which window the compositor considers focused, so it is reliable where
        // synthetic keys are not.
        if let Some(id) = element {
            let reference = self.element(id)?;
            if self.insert_text(&reference, text, false).is_ok() {
                return Ok(format!("typed {} characters into e{id}", text.chars().count()));
            }
            // Fall back to focusing and using the keyboard.
            let _ = self.grab_focus(&reference);
            if let Ok((x, y)) = self.center(&reference) {
                let _ = self.move_pointer(x, y);
                let _ = self.tap_button(BUTTON_LEFT);
            }
        }
        // Force a round trip so the server has drained anything queued, then let
        // the target settle. Some toolkits still swallow the opening character
        // under XWayland; if the first keystroke goes missing, type it twice or
        // click the field first.
        if let Ok((connection, _)) = self.x11() {
            let _ = connection.get_input_focus().and_then(|cookie| Ok(cookie.reply()));
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
        for character in text.chars() {
            self.type_char(character)?;
            // xdotool uses the same default gap; typing flat out makes some
            // toolkits coalesce or drop events.
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        Ok(format!("typed {} characters", text.chars().count()))
    }

    fn press_key(&mut self, key: &str, modifiers: &[String]) -> Result<String> {
        let keysym = named_keysym(key).unwrap_or_else(|| {
            // Single characters are the common case: ctrl+a, ctrl+shift+t.
            char_to_keysym(key.chars().next().unwrap_or('\0'))
        });
        let (keycode, needs_shift) = self.keycode_for(keysym)?.ok_or_else(|| {
            DesktopError::new(format!("'{key}' is not on the current keyboard layout"))
        })?;

        let mut held = Vec::new();
        for modifier in modifiers {
            let Some(symbol) = modifier_keysym(modifier) else {
                // `fn` has no X11 equivalent; dropping it beats refusing the chord.
                continue;
            };
            if let Some((code, _)) = self.keycode_for(symbol)? {
                held.push(code);
            }
        }
        if needs_shift && let Some((shift, _)) = self.keycode_for(0xffe1)? {
            held.push(shift);
        }

        for code in &held {
            self.key(*code, true)?;
        }
        let tapped = self.key(keycode, true).and_then(|()| self.key(keycode, false));
        // Release modifiers even if the tap failed, or the session is left with
        // ctrl stuck down.
        for code in held.iter().rev() {
            let _ = self.key(*code, false);
        }
        tapped?;

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
        if let Some(id) = element {
            let (x, y) = self.center(&self.element(id)?)?;
            self.move_pointer(x, y)?;
        }
        let button = match direction {
            ScrollDirection::Up => BUTTON_SCROLL_UP,
            ScrollDirection::Down => BUTTON_SCROLL_DOWN,
            ScrollDirection::Left => BUTTON_SCROLL_LEFT,
            ScrollDirection::Right => BUTTON_SCROLL_RIGHT,
        };
        for _ in 0..amount.max(1) {
            self.tap_button(button)?;
        }
        Ok(format!("scrolled {direction:?} by {amount}").to_lowercase())
    }

    fn set_value(&mut self, element: u32, value: &str) -> Result<String> {
        let reference = self.element(element)?;
        self.insert_text(&reference, value, true).map_err(|error| {
            DesktopError::new(format!(
                "{error} — not every toolkit allows a direct write; click e{element}, select all \
                 with press_key('a', ['ctrl']), then type_text"
            ))
        })?;
        Ok(format!("set e{element} to \"{}\"", truncate(value, 80)))
    }

    fn select_text(&mut self, element: u32, start: usize, length: Option<usize>) -> Result<String> {
        let reference = self.element(element)?;
        let text = self.text_proxy(&reference)?;
        let total = block_on(text.character_count()).unwrap_or(0).max(0);
        let start = i32::try_from(start).unwrap_or(i32::MAX).min(total);
        let end = length
            .and_then(|count| i32::try_from(count).ok())
            .map_or(total, |count| start.saturating_add(count).min(total));

        // Replace selection 0 when one exists; otherwise create it.
        let applied = block_on(text.set_selection(0, start, end))
            .unwrap_or(false)
            || block_on(text.add_selection(start, end))
                .map_err(|error| DesktopError::new(format!("selection failed: {error}")))?;
        if !applied {
            return Err(DesktopError::new(format!(
                "e{element} refused the selection — click it then use press_key('a', ['ctrl'])"
            )));
        }
        Ok(format!("selected {} characters in e{element}", end - start))
    }
}

#[cfg(test)]
mod tests {
    use super::{char_to_keysym, modifier_keysym, named_keysym, truncate};

    #[test]
    fn latin1_characters_map_to_themselves() {
        assert_eq!(char_to_keysym('a'), 0x61);
        assert_eq!(char_to_keysym(' '), 0x20);
        assert_eq!(char_to_keysym('ÿ'), 0xff);
    }

    #[test]
    fn other_characters_use_the_unicode_keysym_range() {
        // Without this, emoji and CJK would silently fail to type.
        assert_eq!(char_to_keysym('€'), 0x0100_0000 + 0x20ac);
        assert_eq!(char_to_keysym('日'), 0x0100_0000 + 0x65e5);
    }

    #[test]
    fn named_keys_cover_what_the_tool_advertises() {
        assert_eq!(named_keysym("return"), Some(0xff0d));
        assert_eq!(named_keysym("Escape"), Some(0xff1b));
        assert_eq!(named_keysym("nonsense"), None);
    }

    #[test]
    fn cmd_maps_to_super_like_the_windows_backend() {
        assert_eq!(modifier_keysym("cmd"), modifier_keysym("super"));
        assert_eq!(modifier_keysym("ctrl"), Some(0xffe3));
        assert_eq!(modifier_keysym("fn"), None);
    }

    #[test]
    fn truncation_collapses_newlines() {
        assert_eq!(truncate("a\nb", 10), "a b");
    }
}
