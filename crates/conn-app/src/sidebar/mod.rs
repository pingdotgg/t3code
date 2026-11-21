//! Workspace rail, thread sidebar views, and shared project monogram helpers.

pub(crate) mod rail;
pub(crate) mod thread_list;

use conn_theme::{Appearance, Rgba, Tokens};
use gpui_kit::{Div, ParentElement as _, Styled as _, div, px};

use crate::theme::{hsla, hsla_alpha};

/// Derives Conn's 2-character uppercase project monogram (`projectIdentity.ts`).
///
/// Mirrors `projectMonogram` in `../conn/packages/shared/src/projectIdentity.ts`:
/// - Splits into alphanumeric words; returns `"PR"` if none.
/// - Takes the first character of the first word, plus:
///   1. the first digit in the rest of the first word (e.g. `"t3code"` -> `"T3"`), or
///   2. the first character of the last word when there are multiple words
///      (e.g. `"conn-gpui"` -> `"CG"`), or
///   3. the last character of the single word (e.g. `"render"` -> `"RR"`).
#[must_use]
pub(crate) fn project_monogram(project_name: &str) -> String {
    let words: Vec<&str> = project_name
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();

    let Some(first_word) = words.first() else {
        return "PR".to_owned();
    };

    let mut glyphs = first_word.chars();
    let Some(first) = glyphs.next() else {
        return "PR".to_owned();
    };

    let rest: Vec<char> = glyphs.collect();
    let second = rest
        .iter()
        .copied()
        .find(|c| c.is_numeric())
        .or_else(|| {
            if words.len() > 1 {
                words.last().and_then(|w| w.chars().next())
            } else {
                rest.last().copied()
            }
        })
        .unwrap_or(first);

    let mut out = String::with_capacity(2);
    for ch in first.to_uppercase().chain(second.to_uppercase()).take(2) {
        out.push(ch);
    }
    out
}

/// Deterministically picks a muted semantic accent color from `tokens` for a
/// project's monogram badge (no hardcoded hex literals).
#[must_use]
pub(crate) fn project_monogram_color(project_name: &str, tokens: &Tokens) -> Rgba {
    let palette = [
        tokens.info_foreground,
        tokens.success_foreground,
        tokens.warning_foreground,
        tokens.primary,
        tokens.sidebar_muted_foreground,
    ];

    let trimmed = project_name.trim().to_ascii_lowercase();
    let seed = if trimmed.is_empty() {
        "project"
    } else {
        trimmed.as_str()
    };

    let mut hash: usize = 0;
    for ch in seed.chars() {
        hash = (hash.wrapping_mul(31).wrapping_add(ch as usize)) % palette.len();
    }
    palette[hash]
}

/// Renders Conn's muted tinted project monogram badge (`ProjectMonogram.tsx`).
///
/// Uses `currentColor` at 14% alpha (18% in dark mode for legibility over dark
/// frosted surfaces) with `rounded-[25%]` corners.
#[must_use]
pub(crate) fn render_project_monogram(project_name: &str, size_px: f32, tokens: &Tokens) -> Div {
    let text = project_monogram(project_name);
    let accent = project_monogram_color(project_name, tokens);
    let bg_alpha = match tokens.appearance {
        Appearance::Light => 0.14,
        Appearance::Dark => 0.18,
    };
    let radius_px = (size_px * 0.25).round().max(3.0);
    let font_size_px = (size_px * 0.52).round().max(8.0);

    div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(size_px))
        .flex_shrink_0()
        .rounded(px(radius_px))
        .bg(hsla_alpha(accent, bg_alpha))
        .text_color(hsla(accent))
        .text_size(px(font_size_px))
        .line_height(px(size_px))
        .font_weight(gpui_kit::FontWeight::BOLD)
        .child(text)
}

#[cfg(test)]
mod tests {
    use super::project_monogram;

    #[test]
    fn project_monogram_matches_conn_identity_rules() {
        assert_eq!(project_monogram("render"), "RR");
        assert_eq!(project_monogram("conn-gpui"), "CG");
        assert_eq!(project_monogram("conn-server"), "CS");
        assert_eq!(project_monogram("hello-rust"), "HR");
        assert_eq!(project_monogram("orbit"), "OT");
        assert_eq!(project_monogram("t3code"), "T3");
        assert_eq!(project_monogram("a"), "AA");
        assert_eq!(project_monogram("   "), "PR");
    }
}
