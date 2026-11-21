//! ANSI 16/256-color palette derivation from [`conn_theme::Tokens`] and terminal key encoding.
//!
//! Pure Rust (no GPUI window required) so palette mapping and key encoding can be unit-tested.

use alacritty_terminal::term::color::Colors as TermColors;
use alacritty_terminal::vte::ansi::{Color, NamedColor};
use conn_theme::{Appearance, Tokens};

use super::color::{Rgb8, mix_rgb8, to_rgb8};

const ESC: u8 = 0x1b;

/// Conn's dark ANSI palette (`TERMINAL_PALETTES.dark`), slots 0..=15.
const CONN_ANSI_DARK: [u32; 16] = [
    0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
    0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xe5e5e5,
];

/// Conn's light ANSI palette (`TERMINAL_PALETTES.light`), slots 0..=15.
const CONN_ANSI_LIGHT: [u32; 16] = [
    0x000000, 0xcd3131, 0x107c10, 0x949800, 0x0451a5, 0xbc05bc, 0x0598bc, 0x555555, 0x666666,
    0xcd3131, 0x14ce14, 0xb5ba00, 0x0451a5, 0xbc05bc, 0x0598bc, 0xa5a5a5,
];

fn rgb_from_hex(hex: u32) -> Rgb8 {
    let [_, r, g, b] = hex.to_be_bytes();
    (r, g, b)
}

/// Resolved terminal palette derived purely from [`conn_theme::Tokens`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalPalette {
    pub(crate) background: Rgb8,
    pub(crate) foreground: Rgb8,
    pub(crate) cursor: Rgb8,
    pub(crate) selection: Rgb8,
    pub(crate) ansi: [Rgb8; 256],
}

impl TerminalPalette {
    /// Builds a 256-color terminal palette for the active Conn theme.
    ///
    /// Background, foreground, cursor and selection come from the theme's tokens. The 16 ANSI
    /// colors are Conn's fixed light/dark palettes (`TERMINAL_PALETTES` in
    /// `apps/web/src/components/ThreadTerminalDrawer.tsx`), so prompts and `ls` colors match.
    #[must_use]
    pub(crate) fn from_tokens(tokens: &Tokens) -> Self {
        let bg = to_rgb8(tokens.shell_card);
        let fg = to_rgb8(tokens.terminal_foreground);
        let cursor = to_rgb8(tokens.terminal_cursor);
        let selection = to_rgb8(tokens.terminal_selection);

        let base = match tokens.appearance {
            Appearance::Dark => &CONN_ANSI_DARK,
            Appearance::Light => &CONN_ANSI_LIGHT,
        };
        let mut ansi = [(0u8, 0u8, 0u8); 256];
        for (slot, &hex) in ansi.iter_mut().zip(base.iter()) {
            *slot = rgb_from_hex(hex);
        }

        // Standard xterm 6x6x6 color cube (indices 16..=231).
        const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
        for (r, &rv) in LEVELS.iter().enumerate() {
            for (g, &gv) in LEVELS.iter().enumerate() {
                for (b, &bv) in LEVELS.iter().enumerate() {
                    let idx = 16 + r * 36 + g * 6 + b;
                    ansi[idx] = (rv, gv, bv);
                }
            }
        }

        // Standard xterm 24-step grayscale ramp (indices 232..=255).
        for step in 0..24usize {
            let level = (8 + step * 10) as u8;
            ansi[232 + step] = (level, level, level);
        }

        Self {
            background: bg,
            foreground: fg,
            cursor,
            selection,
            ansi,
        }
    }

    /// Resolves a terminal cell color, honoring OSC 4 overrides in `overrides`.
    #[must_use]
    pub(crate) fn resolve(&self, color: Color, overrides: &TermColors) -> Rgb8 {
        let from_override = |idx: usize| overrides[idx].map(|c| (c.r, c.g, c.b));
        match color {
            Color::Spec(c) => (c.r, c.g, c.b),
            Color::Indexed(i) => from_override(usize::from(i)).unwrap_or(self.ansi[usize::from(i)]),
            Color::Named(name) => {
                from_override(name as usize).unwrap_or_else(|| self.resolve_named(name))
            }
        }
    }

    /// Resolves a foreground cell color, brightening standard ANSI 0..8 colors when bold.
    #[must_use]
    pub(crate) fn resolve_fg(&self, color: Color, bold: bool, overrides: &TermColors) -> Rgb8 {
        let adjusted = match color {
            Color::Named(name) if bold && (name as usize) < 8 => Color::Indexed(name as u8 + 8),
            Color::Indexed(i) if bold && i < 8 => Color::Indexed(i + 8),
            other => other,
        };
        self.resolve(adjusted, overrides)
    }

    /// Resolves a named color against this palette.
    #[must_use]
    pub(crate) fn resolve_named(&self, name: NamedColor) -> Rgb8 {
        match name {
            NamedColor::Foreground | NamedColor::BrightForeground => self.foreground,
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimForeground => dim_rgb8(self.foreground, self.background),
            NamedColor::DimBlack
            | NamedColor::DimRed
            | NamedColor::DimGreen
            | NamedColor::DimYellow
            | NamedColor::DimBlue
            | NamedColor::DimMagenta
            | NamedColor::DimCyan
            | NamedColor::DimWhite => {
                let base = (name as usize).saturating_sub(NamedColor::DimBlack as usize);
                dim_rgb8(self.ansi[base.min(7)], self.background)
            }
            other => self.ansi[(other as usize).min(15)],
        }
    }
}

/// Dims a color two-thirds of the way toward the terminal background (SGR 2).
#[must_use]
pub(crate) fn dim_rgb8(color: Rgb8, background: Rgb8) -> Rgb8 {
    mix_rgb8(color, 2.0 / 3.0, background)
}

/// Action to take for a keydown event in the terminal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TerminalKeyAction {
    /// Send these bytes to the PTY.
    Send(Vec<u8>),
    /// Scroll the terminal display by one page (`-1` up, `+1` down).
    ScrollPage(i32),
    /// Swallow without sending.
    Nothing,
    /// Let GPUI's text input handler (`EntityInputHandler`) handle printable text.
    Pass,
}

/// Modifiers and terminal modes needed to encode a keydown into xterm escape sequences.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct KeyInput {
    pub(crate) shift: bool,
    pub(crate) control: bool,
    pub(crate) alt: bool,
    pub(crate) platform: bool,
    pub(crate) app_cursor: bool,
    pub(crate) alt_screen: bool,
}

/// Encodes a GPUI keystroke name + modifiers into xterm bytes.
#[must_use]
pub(crate) fn encode_terminal_key(key: &str, input: KeyInput) -> TerminalKeyAction {
    if input.platform {
        return TerminalKeyAction::Pass;
    }
    let meta = input.alt;
    let param = 1 + u8::from(input.shift) + 2 * u8::from(meta) + 4 * u8::from(input.control);
    let csi = |rest: &str| -> Vec<u8> { [&[ESC, b'['][..], rest.as_bytes()].concat() };
    let with_meta = |bytes: Vec<u8>| -> Vec<u8> {
        if meta {
            [vec![ESC], bytes].concat()
        } else {
            bytes
        }
    };
    let cursor = |letter: char| -> Vec<u8> {
        if param == 1 {
            let lead = if input.app_cursor { 'O' } else { '[' };
            format!("\x1b{lead}{letter}").into_bytes()
        } else {
            csi(&format!("1;{param}{letter}"))
        }
    };
    let tilde = |n: u8| -> Vec<u8> {
        if param == 1 {
            csi(&format!("{n}~"))
        } else {
            csi(&format!("{n};{param}~"))
        }
    };

    let bytes = match key {
        "enter" => with_meta(b"\r".to_vec()),
        "tab" if input.shift => csi("Z"),
        "tab" => with_meta(b"\t".to_vec()),
        "backspace" => with_meta(vec![0x7f]),
        "escape" => with_meta(vec![ESC]),
        "space" if input.control => with_meta(vec![0]),
        "space" if meta => vec![ESC, b' '],
        "space" => return TerminalKeyAction::Pass,
        "left" if meta && !input.shift && !input.control => vec![ESC, b'b'],
        "right" if meta && !input.shift && !input.control => vec![ESC, b'f'],
        "up" => cursor('A'),
        "down" => cursor('B'),
        "right" => cursor('C'),
        "left" => cursor('D'),
        "home" => cursor('H'),
        "end" => cursor('F'),
        "pageup" | "pagedown" if param == 1 && !input.app_cursor && !input.alt_screen => {
            return TerminalKeyAction::ScrollPage(if key == "pageup" { -1 } else { 1 });
        }
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "insert" => tilde(2),
        "delete" => tilde(3),
        other => {
            let mut chars = other.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return TerminalKeyAction::Nothing;
            };
            if input.control {
                return match control_code(c) {
                    Some(code) => TerminalKeyAction::Send(with_meta(vec![code])),
                    None => TerminalKeyAction::Nothing,
                };
            }
            if meta {
                let c = if input.shift && c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c
                };
                let mut out = vec![ESC];
                out.extend(c.to_string().into_bytes());
                return TerminalKeyAction::Send(out);
            }
            return TerminalKeyAction::Pass;
        }
    };
    TerminalKeyAction::Send(bytes)
}

fn control_code(c: char) -> Option<u8> {
    Some(match c.to_ascii_lowercase() {
        c @ 'a'..='z' => c as u8 - b'a' + 1,
        '@' | '2' | ' ' => 0,
        '[' | '3' => ESC,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' | '~' => 0x1e,
        '_' | '-' | '7' | '/' => 0x1f,
        '?' | '8' => 0x7f,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use conn_theme::theme_by_id;

    use super::*;

    #[test]
    fn ansi_palette_matches_conn_for_dark_and_light_themes() {
        let Some(dark) = theme_by_id("dark-ocean") else {
            panic!("dark-ocean theme must exist");
        };
        let dark_tokens = Tokens::derive(&dark);
        let dark_palette = TerminalPalette::from_tokens(&dark_tokens);

        assert_eq!(
            dark_palette.background,
            to_rgb8(dark_tokens.shell_card),
            "terminal background re-roots to shell_card"
        );
        assert_eq!(
            dark_palette.foreground,
            to_rgb8(dark_tokens.terminal_foreground),
            "terminal foreground matches token"
        );
        assert_eq!(dark_palette.ansi[1], (0xcd, 0x31, 0x31), "Conn dark red");
        assert_eq!(dark_palette.ansi[2], (0x0d, 0xbc, 0x79), "Conn dark green");
        assert_eq!(
            dark_palette.ansi[12],
            (0x3b, 0x8e, 0xea),
            "Conn dark bright blue"
        );
        assert_ne!(
            dark_palette.ansi[1], dark_palette.ansi[9],
            "bright red differs from normal red"
        );

        // 256-color cube corners and grayscale endpoints.
        assert_eq!(dark_palette.ansi[16], (0, 0, 0), "cube origin is black");
        assert_eq!(dark_palette.ansi[231], (255, 255, 255), "cube max is white");
        assert_eq!(dark_palette.ansi[232], (8, 8, 8), "grayscale start");
        assert_eq!(dark_palette.ansi[255], (238, 238, 238), "grayscale end");

        // Bold on ANSI 0..8 resolves to bright variant.
        let overrides = TermColors::default();
        assert_eq!(
            dark_palette.resolve_fg(Color::Named(NamedColor::Red), true, &overrides),
            dark_palette.ansi[9],
            "bold red uses bright red"
        );

        let Some(light) = theme_by_id("t3-code-light") else {
            panic!("t3-code-light theme must exist");
        };
        let light_palette = TerminalPalette::from_tokens(&Tokens::derive(&light));
        assert_ne!(
            dark_palette.background, light_palette.background,
            "dark and light palettes must differ"
        );
        assert_eq!(
            light_palette.ansi[2],
            (0x10, 0x7c, 0x10),
            "Conn light green"
        );
    }

    #[test]
    fn encodes_core_terminal_keys() {
        let plain = KeyInput::default();
        assert_eq!(
            encode_terminal_key("enter", plain),
            TerminalKeyAction::Send(b"\r".to_vec()),
            "Enter sends CR"
        );
        assert_eq!(
            encode_terminal_key("backspace", plain),
            TerminalKeyAction::Send(vec![0x7f]),
            "Backspace sends DEL"
        );
        assert_eq!(
            encode_terminal_key("tab", plain),
            TerminalKeyAction::Send(b"\t".to_vec()),
            "Tab sends HT"
        );
        assert_eq!(
            encode_terminal_key(
                "c",
                KeyInput {
                    control: true,
                    ..plain
                }
            ),
            TerminalKeyAction::Send(vec![0x03]),
            "Ctrl-C sends ETX"
        );
        assert_eq!(
            encode_terminal_key("up", plain),
            TerminalKeyAction::Send(b"\x1b[A".to_vec()),
            "Up arrow sends CSI A"
        );
        assert_eq!(
            encode_terminal_key(
                "up",
                KeyInput {
                    app_cursor: true,
                    ..plain
                }
            ),
            TerminalKeyAction::Send(b"\x1bOA".to_vec()),
            "Up arrow in app cursor mode sends SS3 A"
        );
        assert_eq!(
            encode_terminal_key("a", plain),
            TerminalKeyAction::Pass,
            "Plain printable keys defer to EntityInputHandler"
        );
    }
}
