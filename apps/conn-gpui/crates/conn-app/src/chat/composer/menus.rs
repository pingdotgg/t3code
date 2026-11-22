//! Conn-styled floating `/` command menu and `@` file mention menu (`ComposerCommandMenu` parity).
//!
//! Styled as a floating `dropdown-glass` surface (`12px` radius, `shell_overlay` fill,
//! `glass_divider` 1px border, `8px` row radius, `shell_highlight` hover).

use conn_contract::{ProjectEntry, ProjectEntryKind, ServerProvidersItemItemSkillsItem};
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, Context, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::super::color::hsla;
use super::super::icons;
use super::Composer;

/// Floating menu corner radius matching `dropdown-glass` (`12px`).
const MENU_RADIUS_PX: f32 = 12.0;
/// Row corner radius matching `rounded-lg` (`8px`).
const MENU_ROW_RADIUS_PX: f32 = 8.0;
/// Maximum list height matching `max-h-72` (`288px`).
const MENU_MAX_HEIGHT_PX: f32 = 288.0;

/// Superheroicons 16/solid paths used by command and file mention menus.
const ICON_FILE: &str = "superhero/file.svg";
const ICON_FOLDER: &str = "superhero/folder.svg";
const ICON_CLEAR: &str = "superhero/clean.svg";
const ICON_COMPACT: &str = "superhero/minimize.svg";
const ICON_MODEL: &str = "superhero/ai.svg";
const ICON_PLAN: &str = "superhero/idea.svg";
const ICON_REVIEW: &str = "superhero/checklist.svg";
const ICON_STATUS: &str = "superhero/diagnostics.svg";
const ICON_USAGE: &str = "superhero/usage.svg";

/// Which composer completion menu is triggered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ComposerTriggerKind {
    /// `/` slash commands.
    Command,
    /// `@` workspace file mentions (`projects.searchEntries`).
    FileMention,
    /// `$` (any currency symbol) provider skills.
    Skill,
}

/// Active completion trigger detected at the caret (`detectComposerTrigger`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComposerTrigger {
    pub(crate) kind: ComposerTriggerKind,
    /// Byte offset of the leading `/`, `@`, or currency symbol in the draft string.
    pub(crate) start_byte: usize,
    /// Byte offset of the caret (end of the replaced range).
    pub(crate) end_byte: usize,
    /// Text typed after the trigger character, up to the caret.
    pub(crate) query: String,
}

/// A built-in `/` slash command entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SlashCommand {
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) icon: &'static str,
}

/// Short static `/` command catalog matching Conn's built-in commands.
pub(crate) const BUILTIN_SLASH_COMMANDS: &[SlashCommand] = &[
    SlashCommand {
        name: "clear",
        description: "Start a fresh session on the next message",
        icon: ICON_CLEAR,
    },
    SlashCommand {
        name: "compact",
        description: "Summarize conversation history to free context",
        icon: ICON_COMPACT,
    },
    SlashCommand {
        name: "model",
        description: "Switch provider or model for this thread",
        icon: ICON_MODEL,
    },
    SlashCommand {
        name: "plan",
        description: "Toggle plan mode before making edits",
        icon: ICON_PLAN,
    },
    SlashCommand {
        name: "review",
        description: "Review current workspace changes",
        icon: ICON_REVIEW,
    },
    SlashCommand {
        name: "status",
        description: "Show current session and provider status",
        icon: ICON_STATUS,
    },
    SlashCommand {
        name: "usage",
        description: "Inspect provider usage limits",
        icon: ICON_USAGE,
    },
];

/// A workspace file or directory returned by `projects.searchEntries`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FileMentionEntry {
    pub(crate) path: String,
    pub(crate) is_dir: bool,
}

impl FileMentionEntry {
    /// Converts a typed `conn_contract::ProjectEntry` into a [`FileMentionEntry`].
    #[must_use]
    pub(crate) fn from_contract(entry: ProjectEntry) -> Self {
        Self {
            path: entry.path,
            is_dir: matches!(entry.kind, ProjectEntryKind::Directory),
        }
    }

    /// Returns the basename (last path segment) for the primary label.
    #[must_use]
    pub(crate) fn label(&self) -> &str {
        self.path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&self.path)
    }

    /// Returns the parent directory path (empty if at workspace root).
    #[must_use]
    pub(crate) fn parent_path(&self) -> &str {
        let trimmed = self.path.trim_end_matches('/');
        trimmed.rsplit_once('/').map_or("", |(parent, _)| parent)
    }
}

/// Conn's whitespace set for trigger tokens (`isWhitespace`).
fn is_trigger_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\n' | '\t' | '\r')
}

/// Unicode currency symbols (`\p{Sc}`) that open the `$` skills menu.
fn is_currency_symbol(ch: char) -> bool {
    matches!(
        ch,
        '$' | '\u{a2}'..='\u{a5}'
            | '\u{58f}'
            | '\u{60b}'
            | '\u{7fe}'..='\u{7ff}'
            | '\u{9f2}'..='\u{9f3}'
            | '\u{9fb}'
            | '\u{af1}'
            | '\u{bf9}'
            | '\u{e3f}'
            | '\u{17db}'
            | '\u{20a0}'..='\u{20c0}'
            | '\u{a838}'
            | '\u{fdfc}'
            | '\u{fe69}'
            | '\u{ff04}'
            | '\u{ffe0}'..='\u{ffe1}'
            | '\u{ffe5}'..='\u{ffe6}'
    )
}

/// `isPathWord`: a second slash makes the whole word a path, even when the caret precedes it.
fn is_path_word(text: &str, word_start: usize, cursor: usize) -> bool {
    let word_end = text[cursor..]
        .find(is_trigger_whitespace)
        .map_or(text.len(), |offset| cursor + offset);
    let after_slash = word_start + 1;
    text.get(after_slash..word_end)
        .is_some_and(|word| word.contains('/'))
}

/// `isCurrencyAmountQuery`: `$5`, `€9.99`, and `$10k.` are money, not skills.
///
/// Mirrors `^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$`.
#[must_use]
pub(crate) fn is_currency_amount_query(query: &str) -> bool {
    let mut rest = query.strip_prefix('.').unwrap_or(query);
    let mut chars = rest.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    rest = chars.as_str();
    rest = rest.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, ',' | '.' | '_'));
    // The digit run may have swallowed trailing punctuation (`.`/`,`); the suffix class below
    // accepts those too, so only the remainder matters.
    if let Some(after) = rest.strip_prefix(|c: char| "kKmMbBtT".contains(c)) {
        rest = after;
    } else if let Some(after) = rest.strip_prefix(['e', 'E'])
        && after.starts_with(|c: char| c.is_ascii_digit())
    {
        rest = after.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    rest.chars()
        .all(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')'))
}

/// Detects a `/`, `@`, or `$` trigger in the whitespace-delimited token that ends at `cursor`
/// (`detectComposerTrigger(text, cursor)`).
///
/// `cursor` is a UTF-8 byte offset; it is clamped to the text and snapped to a char boundary.
#[must_use]
pub(crate) fn detect_trigger(text: &str, cursor: usize) -> Option<ComposerTrigger> {
    let mut cursor = cursor.min(text.len());
    while !text.is_char_boundary(cursor) {
        cursor -= 1;
    }
    let before = &text[..cursor];
    let token_start = before
        .char_indices()
        .rev()
        .find(|(_, c)| is_trigger_whitespace(*c))
        .map_or(0, |(idx, c)| idx + c.len_utf8());
    let token = &text[token_start..cursor];
    let mut chars = token.chars();
    let first = chars.next()?;
    let rest = chars.as_str();

    let kind = match first {
        '/' => {
            if is_path_word(text, token_start, cursor) {
                return None;
            }
            ComposerTriggerKind::Command
        }
        c if is_currency_symbol(c) => {
            if is_currency_amount_query(rest) {
                return None;
            }
            ComposerTriggerKind::Skill
        }
        '@' => ComposerTriggerKind::FileMention,
        _ => return None,
    };
    Some(ComposerTrigger {
        kind,
        start_byte: token_start,
        end_byte: cursor,
        query: rest.to_owned(),
    })
}

/// Replaces the trigger range in `text` with `replacement`, returning the new text and caret.
///
/// Ports `replaceTextRange` + `extendReplacementRangeForTrailingSpace`: a replacement ending in a
/// space swallows one space already after the caret.
#[must_use]
pub(crate) fn replace_trigger(
    text: &str,
    trigger: &ComposerTrigger,
    replacement: &str,
) -> (String, usize) {
    let start = trigger.start_byte.min(text.len());
    let mut end = trigger.end_byte.clamp(start, text.len());
    if replacement.ends_with(' ') && text[end..].starts_with(' ') {
        end += 1;
    }
    let prefix = text.get(..start).unwrap_or("");
    let suffix = text.get(end..).unwrap_or("");
    (
        format!("{prefix}{replacement}{suffix}"),
        start + replacement.len(),
    )
}

/// A provider skill offered by the `$` menu (`ServerProviderSkill`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SkillEntry {
    pub(crate) name: String,
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) short_description: Option<String>,
    pub(crate) scope: Option<String>,
    pub(crate) path: String,
}

impl SkillEntry {
    /// Builds a skill entry when the skill is user invocable (`isProviderSkillUserInvocable`).
    #[must_use]
    pub(crate) fn from_contract(skill: &ServerProvidersItemItemSkillsItem) -> Option<Self> {
        if !skill.enabled || skill.user_invocable == Some(false) {
            return None;
        }
        Some(Self {
            name: skill.name.clone(),
            display_name: skill.display_name.clone(),
            description: skill.description.clone(),
            short_description: skill.short_description.clone(),
            scope: skill.scope.clone(),
            path: skill.path.clone(),
        })
    }

    /// `formatProviderSkillDisplayName`.
    #[must_use]
    pub(crate) fn label(&self) -> &str {
        self.display_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.name)
    }

    /// Row description: short description, description, `<scope> skill`, or `Run provider skill`.
    #[must_use]
    pub(crate) fn row_description(&self) -> String {
        self.short_description
            .clone()
            .or_else(|| self.description.clone())
            .or_else(|| self.scope.as_ref().map(|scope| format!("{scope} skill")))
            .unwrap_or_else(|| "Run provider skill".to_owned())
    }

    /// `resolveProviderSkillSourceKind` badge label.
    #[must_use]
    pub(crate) fn source_label(&self) -> &'static str {
        let path = self.path.replace('\\', "/");
        if path.contains("/.codex/plugins/") || path.contains("/.agents/plugins/") {
            return "App";
        }
        match self
            .scope
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("repo" | "repository") => "Repo",
            Some("project" | "workspace" | "local") => "Project",
            Some("user" | "personal") => "Personal",
            Some("system") => "System",
            _ => "Provider",
        }
    }

    /// `resolveProviderSkillSourceKind` badge icon.
    fn source_icon(&self) -> &'static str {
        match self.source_label() {
            "App" => "superhero/apps.svg",
            "Repo" | "Project" => ICON_FOLDER,
            "Personal" => "superhero/user.svg",
            "System" => "superhero/settings.svg",
            _ => "superhero/package.svg",
        }
    }
}

/// `scoreQueryMatch` without the fuzzy tier: exact, prefix, word boundary, then substring.
fn score_match(value: &str, query: &str, base: [u32; 4]) -> Option<u32> {
    if value.is_empty() {
        return None;
    }
    if value == query {
        return Some(base[0]);
    }
    if value.starts_with(query) {
        return Some(base[1]);
    }
    if value
        .match_indices(query)
        .any(|(idx, _)| value[..idx].ends_with(['-', '_', '/', ' ', '.', ':']))
    {
        return Some(base[2]);
    }
    value.contains(query).then_some(base[3])
}

/// `searchProviderSkills`: ranked by name, label, short description, description, then scope.
#[must_use]
pub(crate) fn filter_skills<'a>(skills: &'a [SkillEntry], query: &str) -> Vec<&'a SkillEntry> {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<&SkillEntry> = skills
        .iter()
        .filter(|skill| seen.insert(skill.name.as_str()))
        .collect();
    let needle = query
        .trim()
        .trim_start_matches(is_currency_symbol)
        .to_lowercase();
    if needle.is_empty() {
        return unique;
    }
    let mut ranked: Vec<(u32, &SkillEntry)> = unique
        .into_iter()
        .filter_map(|skill| {
            let lower = |s: Option<&String>| s.map(|v| v.to_lowercase()).unwrap_or_default();
            [
                score_match(&skill.name.to_lowercase(), &needle, [0, 2, 4, 6]),
                score_match(&skill.label().to_lowercase(), &needle, [1, 3, 5, 7]),
                score_match(
                    &lower(skill.short_description.as_ref()),
                    &needle,
                    [20, 22, 24, 26],
                ),
                score_match(
                    &lower(skill.description.as_ref()),
                    &needle,
                    [30, 32, 34, 36],
                ),
                score_match(&lower(skill.scope.as_ref()), &needle, [40, 42, 44, 44]),
            ]
            .into_iter()
            .flatten()
            .min()
            .map(|score| (score, skill))
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name)));
    ranked.into_iter().map(|(_, skill)| skill).collect()
}

/// Filters [`BUILTIN_SLASH_COMMANDS`] by a case-insensitive substring match.
#[must_use]
pub(crate) fn filter_slash_commands(query: &str) -> Vec<&'static SlashCommand> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return BUILTIN_SLASH_COMMANDS.iter().collect();
    }
    let needle = trimmed.to_ascii_lowercase();
    BUILTIN_SLASH_COMMANDS
        .iter()
        .filter(|cmd| {
            cmd.name.contains(&needle) || cmd.description.to_ascii_lowercase().contains(&needle)
        })
        .collect()
}

/// Renders the floating `/` command menu or `@` file mention menu above the composer.
pub(super) fn render_command_menu(
    trigger: &ComposerTrigger,
    file_mentions: &[FileMentionEntry],
    file_mentions_loading: bool,
    skills: &[SkillEntry],
    highlighted_index: usize,
    tokens: &Tokens,
    cx: &mut Context<'_, Composer>,
) -> AnyElement {
    let glass_bg = hsla(tokens.shell_overlay);
    let glass_divider = hsla(tokens.glass_divider);
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);

    let mut list = div()
        .id("composer-command-menu-list")
        .flex()
        .flex_col()
        .gap(px(2.0))
        .p(px(6.0))
        .max_h(px(MENU_MAX_HEIGHT_PX))
        .overflow_y_scroll();

    match trigger.kind {
        ComposerTriggerKind::Command => {
            let commands = filter_slash_commands(&trigger.query);
            if commands.is_empty() {
                list = list.child(empty_row("No matching command.", muted));
            } else {
                for (idx, cmd) in commands.iter().enumerate() {
                    let is_highlighted = idx == highlighted_index;
                    let name = cmd.name;
                    let mut row = div()
                        .id(SharedString::from(format!("composer-slash-cmd-{name}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .w_full()
                        .min_w_0()
                        .px(px(8.0))
                        .py(px(6.0))
                        .rounded(px(MENU_ROW_RADIUS_PX))
                        .cursor_pointer()
                        .hover(move |s| s.bg(highlight_bg))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |composer, _, window, cx| {
                            composer.apply_slash_command(name, window, cx);
                        }))
                        .child(icons::icon(cmd.icon, 15.0, muted))
                        .child(
                            div()
                                .flex_none()
                                .text_size(px(13.0))
                                .line_height(px(20.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(format!("/{name}")),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .text_color(muted)
                                .child(cmd.description),
                        );

                    if is_highlighted {
                        row = row.bg(highlight_bg);
                    }
                    list = list.child(row);
                }
            }
        }
        ComposerTriggerKind::Skill => {
            let matches = filter_skills(skills, &trigger.query);
            if matches.is_empty() {
                list = list.child(empty_row(
                    "No skills found. Try / to browse provider commands.",
                    muted,
                ));
            } else {
                let badge_bg = hsla(tokens.secondary);
                let badge_fg = hsla(tokens.secondary_foreground);
                for (idx, skill) in matches.iter().enumerate() {
                    let is_highlighted = idx == highlighted_index;
                    let name = skill.name.clone();
                    let mut row = div()
                        .id(SharedString::from(format!("composer-skill-{idx}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .w_full()
                        .min_w_0()
                        .px(px(8.0))
                        .py(px(6.0))
                        .rounded(px(MENU_ROW_RADIUS_PX))
                        .cursor_pointer()
                        .hover(move |s| s.bg(highlight_bg))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |composer, _, window, cx| {
                            composer.apply_skill(&name, window, cx);
                        }))
                        .child(
                            div()
                                .flex_none()
                                .max_w(px(220.0))
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(skill.label().to_owned()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .text_color(muted)
                                .child(skill.row_description()),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_none()
                                .flex_row()
                                .items_center()
                                .gap(px(4.0))
                                .px(px(6.0))
                                .h(px(18.0))
                                .rounded(px(4.0))
                                .bg(badge_bg)
                                .text_size(px(11.0))
                                .line_height(px(14.0))
                                .text_color(badge_fg)
                                .child(icons::icon(skill.source_icon(), 12.0, badge_fg))
                                .child(format!("{} Skill", skill.source_label())),
                        );
                    if is_highlighted {
                        row = row.bg(highlight_bg);
                    }
                    list = list.child(row);
                }
            }
        }
        ComposerTriggerKind::FileMention => {
            if file_mentions_loading && file_mentions.is_empty() {
                list = list.child(empty_row("Searching workspace files...", muted));
            } else if file_mentions.is_empty() {
                list = list.child(empty_row("No matching files or folders.", muted));
            } else {
                for (idx, entry) in file_mentions.iter().enumerate() {
                    let is_highlighted = idx == highlighted_index;
                    let path = entry.path.clone();
                    let label = entry.label().to_owned();
                    let parent = entry.parent_path().to_owned();
                    let icon_path = if entry.is_dir { ICON_FOLDER } else { ICON_FILE };

                    let mut row = div()
                        .id(SharedString::from(format!("composer-file-mention-{idx}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .w_full()
                        .min_w_0()
                        .px(px(8.0))
                        .py(px(6.0))
                        .rounded(px(MENU_ROW_RADIUS_PX))
                        .cursor_pointer()
                        .hover(move |s| s.bg(highlight_bg))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(move |composer, _, window, cx| {
                            composer.apply_file_mention(&path, window, cx);
                        }))
                        .child(icons::icon(icon_path, 15.0, muted))
                        .child(
                            div()
                                .min_w_0()
                                .max_w(px(260.0))
                                .truncate()
                                .text_size(px(13.0))
                                .line_height(px(20.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(label),
                        );

                    if !parent.is_empty() {
                        row = row.child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(18.0))
                                .text_color(muted)
                                .child(parent),
                        );
                    }

                    if is_highlighted {
                        row = row.bg(highlight_bg);
                    }
                    list = list.child(row);
                }
            }
        }
    }

    div()
        .id("composer-command-menu-popup")
        .flex()
        .flex_col()
        .w_full()
        .rounded(px(MENU_RADIUS_PX))
        .overflow_hidden()
        .bg(glass_bg)
        .border_1()
        .border_color(glass_divider)
        .shadow_lg()
        .occlude()
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
        .child(list)
        .into_any_element()
}

fn empty_row(message: &'static str, color: gpui_kit::Hsla) -> gpui_kit::Div {
    div()
        .px(px(10.0))
        .py(px(10.0))
        .text_size(px(12.0))
        .line_height(px(18.0))
        .text_color(color)
        .child(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_end(text: &str) -> Option<ComposerTrigger> {
        detect_trigger(text, text.len())
    }

    #[test]
    fn detect_trigger_matches_slash_and_at_tokens() {
        assert_eq!(at_end(""), None, "empty text has no trigger");
        assert_eq!(at_end("hello "), None, "trailing space clears trigger");
        assert_eq!(
            at_end("email@example.com"),
            None,
            "mid-word @ is not a mention trigger"
        );
        assert_eq!(
            at_end("/mod"),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::Command,
                start_byte: 0,
                end_byte: 4,
                query: "mod".to_owned(),
            }),
            "leading slash triggers command menu"
        );
        assert_eq!(
            at_end("check @src/main"),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::FileMention,
                start_byte: 6,
                end_byte: 15,
                query: "src/main".to_owned(),
            }),
            "@ after space triggers file mention menu"
        );
    }

    #[test]
    fn detect_trigger_uses_the_cursor_not_the_end() {
        let text = "see @src and more";
        let trigger = detect_trigger(text, 8).expect("trigger at caret");
        assert_eq!(trigger.kind, ComposerTriggerKind::FileMention);
        assert_eq!(trigger.query, "src");
        assert_eq!((trigger.start_byte, trigger.end_byte), (4, 8));
        assert_eq!(detect_trigger(text, text.len()), None, "caret after `more`");
        let mid = detect_trigger(text, 6).expect("query up to the caret");
        assert_eq!(mid.query, "s");
        assert_eq!(detect_trigger(text, 999), None, "clamps past the end");
    }

    #[test]
    fn slash_path_words_are_not_commands() {
        assert_eq!(at_end("open /usr/bin"), None, "second slash makes a path");
        let text = "/usr/bin";
        assert_eq!(
            detect_trigger(text, 2),
            None,
            "caret before the second slash still sees a path word"
        );
        assert_eq!(
            at_end("run /plan").map(|t| t.kind),
            Some(ComposerTriggerKind::Command)
        );
    }

    #[test]
    fn dollar_triggers_skills_but_not_money() {
        let skill = at_end("use $rev").expect("skill trigger");
        assert_eq!(skill.kind, ComposerTriggerKind::Skill);
        assert_eq!(skill.query, "rev");
        assert_eq!(skill.start_byte, 4);
        assert_eq!(
            at_end("$").map(|t| t.kind),
            Some(ComposerTriggerKind::Skill)
        );
        let euro = at_end("€deploy").expect("any currency symbol");
        assert_eq!(euro.kind, ComposerTriggerKind::Skill);
        assert_eq!(euro.query, "deploy");
        for money in ["$5", "costs $3.50", "$10k.", "($5)", "€9.99", "$1e6", "$.5"] {
            assert_eq!(at_end(money), None, "{money} is money");
        }
        assert!(!is_currency_amount_query("5abc"));
        assert!(is_currency_amount_query("1,000"));
    }

    #[test]
    fn replace_trigger_keeps_suffix_and_dedupes_trailing_space() {
        let text = "open @src/ma";
        let trigger = at_end(text).expect("trigger should be detected");
        assert_eq!(
            replace_trigger(text, &trigger, "@src/main.rs "),
            ("open @src/main.rs ".to_owned(), 18),
            "replaces only the @ token"
        );

        let text = "a $re b";
        let trigger = detect_trigger(text, 5).expect("skill at caret");
        let (next, caret) = replace_trigger(text, &trigger, "$review ");
        assert_eq!(next, "a $review b", "swallows the existing space");
        assert_eq!(caret, 10);
    }

    fn skill(name: &str, scope: Option<&str>, description: Option<&str>) -> SkillEntry {
        SkillEntry {
            name: name.to_owned(),
            display_name: None,
            description: description.map(str::to_owned),
            short_description: None,
            scope: scope.map(str::to_owned),
            path: format!("/skills/{name}/SKILL.md"),
        }
    }

    #[test]
    fn filter_skills_ranks_and_dedupes() {
        let skills = vec![
            skill("code-review", Some("repo"), Some("Review the diff")),
            skill("review", Some("user"), None),
            skill("deploy", None, Some("Ship a review build")),
            skill("review", Some("system"), None),
        ];
        assert_eq!(filter_skills(&skills, "").len(), 3, "dedupes by name");
        let names: Vec<_> = filter_skills(&skills, "$review")
            .iter()
            .map(|s| s.name.as_str())
            .collect();
        assert_eq!(names, vec!["review", "code-review", "deploy"]);
        assert!(filter_skills(&skills, "zzz").is_empty());
    }

    #[test]
    fn skill_source_labels_match_conn() {
        assert_eq!(skill("a", Some("repo"), None).source_label(), "Repo");
        assert_eq!(
            skill("a", Some("workspace"), None).source_label(),
            "Project"
        );
        assert_eq!(skill("a", Some("user"), None).source_label(), "Personal");
        assert_eq!(skill("a", None, None).source_label(), "Provider");
        let mut app = skill("a", Some("user"), None);
        app.path = "/Users/x/.codex/plugins/a/SKILL.md".to_owned();
        assert_eq!(app.source_label(), "App");
        assert_eq!(
            skill("a", Some("repo"), None).row_description(),
            "repo skill"
        );
    }

    #[test]
    fn filter_slash_commands_matches_name_and_description() {
        let all = filter_slash_commands("");
        assert_eq!(
            all.len(),
            BUILTIN_SLASH_COMMANDS.len(),
            "empty query returns all commands"
        );

        let model = filter_slash_commands("MODEL");
        assert_eq!(model.len(), 1, "case-insensitive name match");
        assert_eq!(model[0].name, "model", "finds /model command");
    }
}
