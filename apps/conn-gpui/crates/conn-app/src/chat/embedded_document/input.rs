//! GPUI → CEF input mapping for the isolated surface.
//!
//! These mirror the private helpers in `panels/browser.rs`, which is not reachable from `chat`.

use conn_web::{CursorKind, Modifiers as WebModifiers, MouseButton as WebMouseButton};
use gpui_kit::{CursorStyle, Modifiers as GpuiModifiers, MouseButton};

pub(super) fn map_mouse_button(button: MouseButton) -> Option<WebMouseButton> {
    match button {
        MouseButton::Left => Some(WebMouseButton::Left),
        MouseButton::Middle => Some(WebMouseButton::Middle),
        MouseButton::Right => Some(WebMouseButton::Right),
        MouseButton::Navigate(_) => None,
    }
}

pub(super) fn map_modifiers(
    modifiers: GpuiModifiers,
    pressed_button: Option<MouseButton>,
    is_repeat: bool,
) -> WebModifiers {
    WebModifiers {
        shift: modifiers.shift,
        control: modifiers.control,
        alt: modifiers.alt,
        command: modifiers.platform,
        left_button: pressed_button == Some(MouseButton::Left),
        middle_button: pressed_button == Some(MouseButton::Middle),
        right_button: pressed_button == Some(MouseButton::Right),
        is_repeat,
    }
}

pub(super) fn map_cursor_style(kind: CursorKind) -> CursorStyle {
    match kind {
        CursorKind::Default | CursorKind::Wait => CursorStyle::Arrow,
        CursorKind::Pointer => CursorStyle::PointingHand,
        CursorKind::Text => CursorStyle::IBeam,
        CursorKind::Crosshair => CursorStyle::Crosshair,
        CursorKind::Move | CursorKind::Grab => CursorStyle::OpenHand,
        CursorKind::Grabbing => CursorStyle::ClosedHand,
        CursorKind::NotAllowed => CursorStyle::OperationNotAllowed,
        CursorKind::ResizeEW => CursorStyle::ResizeLeftRight,
        CursorKind::ResizeNS => CursorStyle::ResizeUpDown,
        CursorKind::ResizeNESW => CursorStyle::ResizeUpLeftDownRight,
        CursorKind::ResizeNWSE => CursorStyle::ResizeUpRightDownLeft,
        CursorKind::ResizeCol => CursorStyle::ResizeColumn,
        CursorKind::ResizeRow => CursorStyle::ResizeRow,
        CursorKind::VerticalText => CursorStyle::IBeamCursorForVerticalLayout,
        CursorKind::ContextMenu => CursorStyle::ContextualMenu,
        CursorKind::Alias => CursorStyle::DragLink,
        CursorKind::Copy => CursorStyle::DragCopy,
    }
}

pub(super) fn gpui_key_to_windows_vk(key: &str) -> i32 {
    match key {
        "backspace" => 0x08,
        "tab" => 0x09,
        "enter" => 0x0D,
        "escape" => 0x1B,
        "space" | " " => 0x20,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "end" => 0x23,
        "home" => 0x24,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        ";" => 0xBA,
        "=" => 0xBB,
        "," => 0xBC,
        "-" => 0xBD,
        "." => 0xBE,
        "/" => 0xBF,
        "`" => 0xC0,
        "[" => 0xDB,
        "\\" => 0xDC,
        "]" => 0xDD,
        "'" => 0xDE,
        other => {
            let mut chars = other.chars();
            match (chars.next(), chars.next()) {
                (Some(ch), None) if ch.is_ascii_alphabetic() => {
                    i32::from(ch.to_ascii_uppercase() as u8)
                }
                (Some(ch), None) if ch.is_ascii_digit() => i32::from(ch as u8),
                _ => 0,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_map_to_windows_codes() {
        assert_eq!(gpui_key_to_windows_vk("enter"), 0x0D, "enter");
        assert_eq!(
            gpui_key_to_windows_vk("a"),
            i32::from(b'A'),
            "letters are upper case"
        );
        assert_eq!(gpui_key_to_windows_vk("7"), i32::from(b'7'), "digits");
        assert_eq!(
            gpui_key_to_windows_vk("unknown-key"),
            0,
            "unknown keys are 0"
        );
    }
}
