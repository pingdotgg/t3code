//! Workspace rail, thread sidebar views, and shared project favicon/monogram helpers.

pub(crate) mod drafts;
pub(crate) mod hover_card;
pub(crate) mod hover_card_state;
pub(crate) mod rail;
pub(crate) mod thread_list;
pub(crate) mod thread_menu;
pub(crate) mod tree;

use conn_contract::{ProjectIconColor, ProjectProjectIcon};
use conn_state::ProjectShell;
use conn_theme::{Rgba, Tokens, color_mix_srgb};
use gpui_kit::{Div, ParentElement as _, Styled as _, div, px};

use crate::icons;
use crate::theme::{hsla, hsla_alpha};

/// Conn's canonical 18-color project identity palette order
/// (`packages/shared/src/projectIdentity.ts`: `ProjectIconColor.literals`).
const PROJECT_COLOR_ORDER: [ProjectIconColor; 18] = [
    ProjectIconColor::Gray,
    ProjectIconColor::Red,
    ProjectIconColor::Orange,
    ProjectIconColor::Amber,
    ProjectIconColor::Yellow,
    ProjectIconColor::Lime,
    ProjectIconColor::Green,
    ProjectIconColor::Emerald,
    ProjectIconColor::Teal,
    ProjectIconColor::Cyan,
    ProjectIconColor::Sky,
    ProjectIconColor::Blue,
    ProjectIconColor::Indigo,
    ProjectIconColor::Violet,
    ProjectIconColor::Purple,
    ProjectIconColor::Fuchsia,
    ProjectIconColor::Pink,
    ProjectIconColor::Rose,
];

/// Derives Conn's 2-character uppercase project monogram (`projectIdentity.ts`).
///
/// Mirrors `projectMonogram` in `packages/shared/src/projectIdentity.ts`:
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

/// Deterministically hashes `project_name` onto Conn's 18-color `ProjectIconColor`
/// palette (`packages/shared/src/projectIdentity.ts`).
#[must_use]
pub(crate) fn project_identity_color(project_name: &str) -> ProjectIconColor {
    let trimmed = project_name.trim().to_ascii_lowercase();
    let seed = if trimmed.is_empty() {
        "project"
    } else {
        trimmed.as_str()
    };

    let mut index: usize = 0;
    for ch in seed.chars() {
        index = (index.wrapping_mul(31).wrapping_add(ch as usize)) % PROJECT_COLOR_ORDER.len();
    }
    PROJECT_COLOR_ORDER[index]
}

/// Maps a [`ProjectIconColor`] to a theme-derived [`Rgba`] using only
/// `conn_theme::Tokens` (and sRGB mixes between them; zero hex literals).
#[must_use]
pub(crate) fn project_icon_color(color: ProjectIconColor, tokens: &Tokens) -> Rgba {
    match color {
        ProjectIconColor::Gray => tokens.sidebar_muted_foreground,
        ProjectIconColor::Red => tokens.destructive,
        ProjectIconColor::Rose => color_mix_srgb(tokens.destructive, 0.78, tokens.foreground),
        ProjectIconColor::Pink => color_mix_srgb(tokens.destructive, 0.70, tokens.info_foreground),
        ProjectIconColor::Orange => color_mix_srgb(tokens.warning, 0.65, tokens.destructive),
        ProjectIconColor::Amber => tokens.warning,
        ProjectIconColor::Yellow => tokens.warning_foreground,
        ProjectIconColor::Lime => {
            color_mix_srgb(tokens.success_foreground, 0.60, tokens.warning_foreground)
        }
        ProjectIconColor::Green | ProjectIconColor::Emerald => tokens.success_foreground,
        ProjectIconColor::Teal => {
            color_mix_srgb(tokens.success_foreground, 0.55, tokens.info_foreground)
        }
        ProjectIconColor::Cyan => {
            color_mix_srgb(tokens.info_foreground, 0.65, tokens.success_foreground)
        }
        ProjectIconColor::Sky | ProjectIconColor::Blue => tokens.info_foreground,
        ProjectIconColor::Indigo => {
            color_mix_srgb(tokens.info_foreground, 0.72, tokens.destructive)
        }
        ProjectIconColor::Violet | ProjectIconColor::Purple => {
            color_mix_srgb(tokens.info_foreground, 0.52, tokens.destructive)
        }
        ProjectIconColor::Fuchsia => {
            color_mix_srgb(tokens.destructive, 0.60, tokens.info_foreground)
        }
    }
}

/// Deterministically picks a theme-derived accent color for a project's monogram badge.
#[must_use]
pub(crate) fn project_monogram_color(project_name: &str, tokens: &Tokens) -> Rgba {
    project_icon_color(project_identity_color(project_name), tokens)
}

/// Renders Conn's tinted project monogram tile (`ProjectMonogram.tsx`).
///
/// Mirrors `ProjectMonogram.tsx`:
/// - `rounded-[25%]` corners
/// - `color-mix(in srgb, currentColor 14%, transparent)` background
/// - bold monospace 2-char uppercase text (`fontSize: 8.25` at `16px`)
#[must_use]
pub(crate) fn render_project_monogram_badge(text: &str, accent: Rgba, size_px: f32) -> Div {
    let radius_px = (size_px * 0.25).round().max(3.0);
    let font_size_px = (size_px * 0.52).max(7.5);

    div()
        .flex()
        .items_center()
        .justify_center()
        .size(px(size_px))
        .flex_shrink_0()
        .rounded(px(radius_px))
        .bg(hsla_alpha(accent, 0.14))
        .text_color(hsla(accent))
        .font_family("SF Mono")
        .text_size(px(font_size_px))
        .line_height(px(size_px))
        .font_weight(gpui_kit::FontWeight::BOLD)
        .child(text.to_owned())
}

/// Renders Conn's automatic project monogram for a project name (`ProjectMonogram.tsx`).
#[must_use]
pub(crate) fn render_project_monogram(project_name: &str, size_px: f32, tokens: &Tokens) -> Div {
    let text = project_monogram(project_name);
    let accent = project_monogram_color(project_name, tokens);
    render_project_monogram_badge(&text, accent, size_px)
}

/// Renders Conn's `ProjectFavicon` (`ProjectFavicon.tsx`): respects explicit
/// `project_icon` overrides (monogram, Lucide/superhero icon, emoji) and falls
/// back to the automatic monogram derived from `project.title`.
#[must_use]
pub(crate) fn render_project_favicon(project: &ProjectShell, size_px: f32, tokens: &Tokens) -> Div {
    if let Some(Some(icon)) = &project.project_icon {
        match icon {
            ProjectProjectIcon::Monogram(m) => {
                let accent = project_icon_color(m.color, tokens);
                return render_project_monogram_badge(&m.text, accent, size_px);
            }
            ProjectProjectIcon::Lucide(l) => {
                let accent = project_icon_color(l.color, tokens);
                let path = icons::project_lucide_concept(&l.name);
                return div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(size_px))
                    .flex_shrink_0()
                    .child(icons::concept(path, size_px, hsla(accent)));
            }
            ProjectProjectIcon::Emoji(e) => {
                let font_size_px = (size_px * 0.80).max(10.0);
                return div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(size_px))
                    .flex_shrink_0()
                    .text_size(px(font_size_px))
                    .line_height(px(size_px))
                    .child(e.emoji.clone());
            }
            ProjectProjectIcon::Unknown(_) => {}
        }
    }
    render_project_monogram(&project.title, size_px, tokens)
}

#[cfg(test)]
mod tests {
    use conn_contract::ProjectIconColor;

    use super::{project_identity_color, project_monogram};

    #[test]
    fn project_monogram_matches_conn_identity_rules() {
        assert_eq!(project_monogram("render"), "RR");
        assert_eq!(project_monogram("conn"), "CN");
        assert_eq!(project_monogram("conn-gpui"), "CG");
        assert_eq!(project_monogram("conn-server"), "CS");
        assert_eq!(project_monogram("hello-rust"), "HR");
        assert_eq!(project_monogram("orbit"), "OT");
        assert_eq!(project_monogram("t3code"), "T3");
        assert_eq!(project_monogram("a"), "AA");
        assert_eq!(project_monogram("   "), "PR");
    }

    #[test]
    fn project_identity_color_matches_conn_hash() {
        assert_eq!(project_identity_color("conn"), ProjectIconColor::Yellow);
    }
}
