//! Conn-styled floating `/` command menu and `@` file mention menu (`ComposerCommandMenu` parity).
//!
//! Styled as a floating `dropdown-glass` surface (`12px` radius, `shell_overlay` fill,
//! `glass_divider` 1px border, `8px` row radius, `shell_highlight` hover).

use conn_contract::{ProjectEntry, ProjectEntryKind};
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
}

/// Active completion trigger detected at the end of the composer draft.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ComposerTrigger {
    pub(crate) kind: ComposerTriggerKind,
    /// Byte offset of the leading `/` or `@` in the draft string.
    pub(crate) start_byte: usize,
    /// Text typed after `/` or `@`.
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

/// Detects a `/` or `@` trigger at the end of `text`.
///
/// The trigger character must appear at the start of the text or immediately after whitespace,
/// and the query following it must not contain whitespace.
#[must_use]
pub(crate) fn detect_trigger(text: &str) -> Option<ComposerTrigger> {
    if text.is_empty() || text.ends_with(char::is_whitespace) {
        return None;
    }

    let token_start = text.rfind(char::is_whitespace).map_or(0, |idx| {
        idx + text[idx..].chars().next().map_or(1, char::len_utf8)
    });
    let token = &text[token_start..];

    let (kind, rest) = if let Some(rest) = token.strip_prefix('/') {
        (ComposerTriggerKind::Command, rest)
    } else {
        (ComposerTriggerKind::FileMention, token.strip_prefix('@')?)
    };

    Some(ComposerTrigger {
        kind,
        start_byte: token_start,
        query: rest.to_owned(),
    })
}

/// Replaces the detected trigger token in `text` with `replacement`.
#[must_use]
pub(crate) fn replace_trigger(text: &str, trigger: &ComposerTrigger, replacement: &str) -> String {
    let prefix = text.get(..trigger.start_byte).unwrap_or("");
    format!("{prefix}{replacement}")
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
#[expect(
    dead_code,
    reason = "used by Composer entity; wired into ChatView by orchestrator"
)]
pub(super) fn render_command_menu(
    trigger: &ComposerTrigger,
    file_mentions: &[FileMentionEntry],
    file_mentions_loading: bool,
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

    #[test]
    fn detect_trigger_matches_slash_and_at_tokens() {
        assert_eq!(detect_trigger(""), None, "empty text has no trigger");
        assert_eq!(
            detect_trigger("hello "),
            None,
            "trailing space clears trigger"
        );
        assert_eq!(
            detect_trigger("email@example.com"),
            None,
            "mid-word @ is not a mention trigger"
        );

        assert_eq!(
            detect_trigger("/mod"),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::Command,
                start_byte: 0,
                query: "mod".to_owned(),
            }),
            "leading slash triggers command menu"
        );

        assert_eq!(
            detect_trigger("check @src/main"),
            Some(ComposerTrigger {
                kind: ComposerTriggerKind::FileMention,
                start_byte: 6,
                query: "src/main".to_owned(),
            }),
            "@ after space triggers file mention menu"
        );
    }

    #[test]
    fn replace_trigger_substitutes_only_the_active_token() {
        let text = "open @src/ma";
        let trigger = detect_trigger(text).expect("trigger should be detected");
        assert_eq!(
            replace_trigger(text, &trigger, "@src/main.rs "),
            "open @src/main.rs ",
            "replaces only the @ token"
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
