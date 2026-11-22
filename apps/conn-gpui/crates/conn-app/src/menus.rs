//! Native macOS application menu bar (`Conn`, `File`, `Edit`, `View`, `Window`).
//!
//! Mirrors Threadbear's `window_menu.rs` / `shell.rs` pattern so standard macOS shortcuts
//! (`⌘Q`, `⌘W`, `⌘M`, Cut/Copy/Paste/Undo/Redo/Select All) and Conn shell actions appear in
//! the native menu bar and route cleanly to GPUI actions and AppKit text services.

use gpui_kit::component::input;
use gpui_kit::{App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, Window, actions};

use crate::app::{NewThread, ToggleRightPanel, ToggleSidebar};
use crate::palette::OpenCommandPalette;
use crate::settings::OpenSettings;

actions!(conn_menu, [Quit, CloseWindow, MinimizeWindow, ZoomWindow]);

/// Registers native application menu bar entries and global window/app keybindings.
pub(crate) fn install(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", MinimizeWindow, None),
    ]);

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &CloseWindow, cx| {
        if let Some(handle) = cx.active_window() {
            let _ = handle.update(cx, |_, window, cx| {
                window.remove_window();
                if cx.windows().is_empty() {
                    cx.quit();
                }
            });
        }
    });
    cx.on_action(|_: &MinimizeWindow, cx| {
        if let Some(handle) = cx.active_window() {
            let _ = handle.update(cx, |_, window, _| window.minimize_window());
        }
    });
    cx.on_action(|_: &ZoomWindow, cx| {
        if let Some(handle) = cx.active_window() {
            let _ = handle.update(cx, |_, window, _| window.zoom_window());
        }
    });

    cx.set_menus(build_menus());
}

/// Hooks the main window so clicking the red close button quits the app cleanly on macOS.
pub(crate) fn install_main_window(window: &mut Window, cx: &mut App) {
    window.on_window_should_close(cx, |_, cx| {
        cx.defer(|cx| cx.quit());
        false
    });
}

fn build_menus() -> Vec<Menu> {
    vec![
        Menu::new("Conn").items([
            MenuItem::action("Settings…", OpenSettings),
            MenuItem::Separator,
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::Separator,
            MenuItem::action("Quit Conn", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Thread", NewThread),
            MenuItem::action("Command Palette…", OpenCommandPalette),
            MenuItem::Separator,
            MenuItem::action("Close Window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", input::Undo, OsAction::Undo),
            MenuItem::os_action("Redo", input::Redo, OsAction::Redo),
            MenuItem::Separator,
            MenuItem::os_action("Cut", input::Cut, OsAction::Cut),
            MenuItem::os_action("Copy", input::Copy, OsAction::Copy),
            MenuItem::os_action("Paste", input::Paste, OsAction::Paste),
            MenuItem::os_action("Select All", input::SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::action("Toggle Right Panel", ToggleRightPanel),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", MinimizeWindow),
            MenuItem::action("Zoom", ZoomWindow),
        ]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menus_include_standard_macos_top_level_groups() {
        let menus = build_menus();
        let names: Vec<&str> = menus.iter().map(|m| m.name.as_ref()).collect();
        assert_eq!(names, vec!["Conn", "File", "Edit", "View", "Window"]);
    }
}
