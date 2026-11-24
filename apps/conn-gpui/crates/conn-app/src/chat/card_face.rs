//! The boxed face the timeline's info cards share, ported from the lab's `FeedCards.css`,
//! `GalleryCard.css` and `CodeBlock.css` (`apps/lab-gpui`'s card feed):
//!
//! - a 14px card around a 3px inset, with a compact metadata header above a lighter body;
//! - 14px header glyphs, 13px text on a 1.625 line height, 8px between glyph and text;
//! - a down/up chevron inside the body of a card that opens and closes;
//! - a two-line, ellipsized preview of what the open card shows in full.

use conn_theme::{Appearance, Rgba, Tokens, color_mix_srgb};
use gpui_kit::{AnyElement, Div, Hsla, ParentElement as _, Styled as _, div, px};

use super::color::{chat_page, hsla};
use super::icons;

/// The padding between a card's edge and its body.
pub(super) const CARD_INSET_PX: f32 = 3.0;
/// A card's corner radius; its body's is this less the inset.
pub(super) const CARD_RADIUS_PX: f32 = 14.0;
pub(super) const CARD_BODY_RADIUS_PX: f32 = CARD_RADIUS_PX - CARD_INSET_PX;
pub(super) const CARD_HEADER_HEIGHT_PX: f32 = 30.0;
/// A header's side padding; the side that holds actions takes [`CARD_ACTIONS_PAD_PX`].
pub(super) const CARD_HEADER_PAD_PX: f32 = 11.0;
pub(super) const CARD_ACTIONS_PAD_PX: f32 = 5.0;
pub(super) const CARD_BODY_PAD_X_PX: f32 = 11.0;
pub(super) const CARD_BODY_PAD_Y_PX: f32 = 10.0;
/// A header glyph, and the gap from it to the text.
pub(super) const CARD_ICON_PX: f32 = 14.0;
pub(super) const CARD_ICON_GAP_PX: f32 = 8.0;
/// Card text: 13px on a 1.625 line height, as the lab sets `.m-feed-card-title` and its preview.
pub(super) const CARD_TEXT_PX: f32 = 13.0;
pub(super) const CARD_LINE_PX: f32 = CARD_TEXT_PX * 1.625;
/// A header's metadata line.
pub(super) const CARD_META_LINE_PX: f32 = 16.0;
/// An icon button in a header, and the glyph inside it.
pub(super) const CARD_ACTION_BOX_PX: f32 = 24.0;
pub(super) const CARD_ACTION_ICON_PX: f32 = 14.0;
/// Where a collapsed card's text stops.
pub(super) const CARD_PREVIEW_LINES: usize = 2;
/// The room a title keeps for its chevron.
pub(super) const CARD_CHEVRON_ROOM_PX: f32 = 22.0;

/// `chevron-up`, which the shared icon list has no constant for.
pub(super) const CHEVRON_UP: &str = "superhero/chevron-up.svg";
pub(super) const CHECKLIST: &str = "superhero/checklist.svg";
pub(super) const DOWNLOAD: &str = "superhero/download.svg";
pub(super) const BRANCH: &str = "superhero/branch.svg";
pub(super) const PULL_REQUEST: &str = "superhero/pull-request.svg";
pub(super) const MERGE: &str = "superhero/merge.svg";

/// Which surface a card wears in the light theme. Dark cards share one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CardFace {
    /// Agent, subagent, task and code cards: the page with 6% of the foreground in light.
    Tinted,
    /// Plan and worktree cards: the page itself in light.
    Plain,
}

/// The two surfaces of a card: its frame, and the lighter body inside it.
#[derive(Clone, Copy, Debug)]
pub(super) struct CardColors {
    pub(super) surface: Rgba,
    pub(super) body: Rgba,
}

impl CardColors {
    pub(super) fn surface(self) -> Hsla {
        hsla(self.surface)
    }

    pub(super) fn body(self) -> Hsla {
        hsla(self.body)
    }
}

/// Lab `--thread-card-surface` and the body's `color-mix(surface 94%, white)`: dark paints 5.6% of
/// the foreground over the page and lightens the body a little; light paints the body white.
pub(super) fn card_colors(tokens: &Tokens, face: CardFace) -> CardColors {
    let page = chat_page(tokens);
    let white = Rgba::new(1.0, 1.0, 1.0, 1.0);
    match (tokens.appearance, face) {
        (Appearance::Dark, _) => {
            let surface = color_mix_srgb(page, 0.944, tokens.foreground);
            CardColors {
                surface,
                body: color_mix_srgb(surface, 0.94, white),
            }
        }
        (Appearance::Light, CardFace::Tinted) => CardColors {
            surface: color_mix_srgb(page, 0.94, tokens.foreground),
            body: white,
        },
        (Appearance::Light, CardFace::Plain) => CardColors {
            surface: page,
            body: white,
        },
    }
}

/// The colour of a card's frame, or of a header on it, under the pointer: 6% of the foreground.
pub(super) fn card_hover_surface(colors: CardColors, tokens: &Tokens) -> Hsla {
    hsla(color_mix_srgb(colors.surface, 0.94, tokens.foreground))
}

/// The card's frame: the surface, the radius, and the inset the body sits in.
pub(super) fn card_shell(colors: CardColors) -> Div {
    div()
        .relative()
        .flex()
        .flex_col()
        .gap(px(CARD_INSET_PX))
        .w_full()
        .min_w_0()
        .p(px(CARD_INSET_PX))
        .rounded(px(CARD_RADIUS_PX))
        .bg(colors.surface())
}

/// A header row above the body. `actions` takes the narrower padding on the side of the buttons.
pub(super) fn card_header(actions: bool) -> Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(CARD_ICON_GAP_PX))
        .min_h(px(CARD_HEADER_HEIGHT_PX))
        .min_w_0()
        .pl(px(CARD_HEADER_PAD_PX))
        .pr(px(if actions {
            CARD_ACTIONS_PAD_PX
        } else {
            CARD_HEADER_PAD_PX
        }))
}

/// The lighter panel inside a card that holds its text.
pub(super) fn card_body(colors: CardColors) -> Div {
    div()
        .relative()
        .min_w_0()
        .px(px(CARD_BODY_PAD_X_PX))
        .py(px(CARD_BODY_PAD_Y_PX))
        .rounded(px(CARD_BODY_RADIUS_PX))
        .bg(colors.body())
}

/// The status dot over a header glyph's top right corner: a 5px dot in a 9px ring that takes the
/// card's surface colour, so it cuts into the glyph.
pub(super) fn status_dot(core: Hsla, ring: Hsla) -> Div {
    div()
        .absolute()
        .top(px(-4.0))
        .right(px(-4.0))
        .size(px(9.0))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(ring)
        .child(div().size(px(5.0)).rounded_full().bg(core))
}

/// A header glyph with an optional `(dot, ring)` status dot on its corner.
pub(super) fn icon_with_dot(icon: AnyElement, dot: Option<(Hsla, Hsla)>) -> Div {
    let mut host = div()
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(CARD_ICON_PX))
        .child(icon);
    if let Some((core, ring)) = dot {
        host = host.child(status_dot(core, ring));
    }
    host
}

/// The down/up chevron at a title's right end, as tall as one line of the title.
pub(super) fn disclosure_chevron(expanded: bool, color: Hsla) -> Div {
    div()
        .absolute()
        .top_0()
        .right_0()
        .h(px(CARD_LINE_PX))
        .flex()
        .items_center()
        .child(icons::icon(
            if expanded {
                CHEVRON_UP
            } else {
                icons::CARET_DOWN
            },
            CARD_ICON_PX,
            color,
        ))
}

/// Lab `markdownPreviewText(markdown).replace(/\s+/g, " ").trim()`: the Markdown as one line.
pub(super) fn one_line_preview(markdown: &str) -> String {
    conn_state::markdown_preview_text(markdown)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Full names of the fence languages the lab's code header spells out (`FENCE_DISPLAY_NAMES`).
const FENCE_NAMES: &[(&str, &str)] = &[
    ("css", "CSS"),
    ("html", "HTML"),
    ("js", "JavaScript"),
    ("json", "JSON"),
    ("jsx", "JSX"),
    ("md", "Markdown"),
    ("py", "Python"),
    ("rs", "Rust"),
    ("sh", "Shell"),
    ("ts", "TypeScript"),
    ("tsx", "TSX"),
    ("typescript", "TypeScript"),
    ("javascript", "JavaScript"),
    ("yaml", "YAML"),
    ("yml", "YAML"),
    ("cc", "C++"),
    ("cpp", "C++"),
    ("cxx", "C++"),
    ("cs", "C#"),
    ("csharp", "C#"),
    ("graphql", "GraphQL"),
    ("objc", "Objective-C"),
    ("objectivec", "Objective-C"),
    ("php", "PHP"),
    ("rb", "Ruby"),
    ("scss", "SCSS"),
    ("sql", "SQL"),
    ("toml", "TOML"),
    ("xml", "XML"),
];

/// The language a fenced code header names: the full name where there is one, else the tag with a
/// capital, and `Text` for no tag or a plain one.
pub(super) fn fence_display_name(language: Option<&str>) -> String {
    let Some(lang) = language
        .map(|tag| tag.trim().to_ascii_lowercase())
        .filter(|tag| !tag.is_empty())
    else {
        return "Text".to_owned();
    };
    if matches!(lang.as_str(), "text" | "txt" | "plain" | "plaintext") {
        return "Text".to_owned();
    }
    if let Some((_, name)) = FENCE_NAMES.iter().find(|(tag, _)| *tag == lang) {
        return (*name).to_owned();
    }
    let mut chars = lang.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => lang,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_theme::{Tokens, builtin_themes};

    #[test]
    fn fence_headers_spell_the_language_out() {
        assert_eq!(fence_display_name(Some("ts")), "TypeScript");
        assert_eq!(fence_display_name(Some("TSX")), "TSX");
        assert_eq!(fence_display_name(Some(" rs ")), "Rust");
        assert_eq!(fence_display_name(Some("c++")), "C++");
        assert_eq!(fence_display_name(Some("diff")), "Diff");
        assert_eq!(fence_display_name(Some("bash")), "Bash");
        assert_eq!(fence_display_name(Some("plaintext")), "Text");
        assert_eq!(fence_display_name(Some("")), "Text");
        assert_eq!(fence_display_name(None), "Text");
    }

    #[test]
    fn a_collapsed_card_previews_one_line() {
        // The lab's `markdownPreviewText`: syntax goes, list bullets stay as `•`, code lines stay.
        for (markdown, expected) in [
            (
                "**Three** pull requests:\n\n- one\n- two\n\n```ts\nlet x = 1;\n```",
                "Three pull requests: • one • two let x = 1;",
            ),
            ("- one\n* two\n+ three", "• one • two • three"),
            ("1. first\n2. second", "1. first 2. second"),
            (
                "# Title\n> quoted [link](https://x.y) and `code`",
                "Title quoted link and code",
            ),
            ("a\n\n\n  b  \r\nc", "a b c"),
            ("", ""),
        ] {
            assert_eq!(one_line_preview(markdown), expected, "{markdown:?}");
        }
    }

    #[test]
    fn the_body_is_lighter_than_the_frame_in_every_theme() {
        for theme in builtin_themes() {
            let tokens = Tokens::derive(&theme);
            for face in [CardFace::Tinted, CardFace::Plain] {
                let colors = card_colors(&tokens, face);
                let luma = |c: Rgba| 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
                assert!(
                    luma(colors.body) >= luma(colors.surface),
                    "{} {face:?}: the body is not lighter",
                    theme.id
                );
                assert_eq!(colors.surface.a, 1.0, "{} frame is opaque", theme.id);
            }
        }
    }

    #[test]
    fn the_title_line_is_one_and_five_eighths_of_its_size() {
        assert!((CARD_LINE_PX - 21.125).abs() < 1e-4);
    }
}
