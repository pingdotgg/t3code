//! `Undo` for discarded drafts and thread input (Conn `hooks/showThreadUndoNotice.ts`,
//! `lib/discardComposerDraft.ts`): the notice in the sidebar footer, how long it lasts, what
//! `⌘Z` undoes and where it leaves a text field alone. Plain data in and out, so the iPhone app
//! can share it.

use crate::sidebar_nav::KeyMods;

/// How long the notice stays after the last discard (`showThreadUndoNotice` `5_000`).
pub const DISCARD_UNDO_SECS: u64 = 5;

/// The shortcut the notice names (`thread.undo`).
pub const UNDO_SHORTCUT_LABEL: &str = "⌘Z";

/// The notice: what it says and how many discards one `Undo` brings back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiscardNotice {
    pub count: usize,
}

/// The discards `Undo` can bring back, newest last. One notice covers them all, and one `Undo`
/// restores them all (`refreshNotice` groups consecutive actions of the same kind).
#[derive(Debug)]
pub struct DiscardUndo<T> {
    entries: Vec<T>,
    /// A new notice owns `⌘Z` even inside a text field, until another key is pressed.
    claimed: bool,
    generation: u64,
}

impl<T> Default for DiscardUndo<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            claimed: false,
            generation: 0,
        }
    }
}

impl<T> DiscardUndo<T> {
    /// Adds a discard. The notice shows, `⌘Z` is claimed, and the expiry starts over. Returns
    /// the generation to hand to [`Self::expire`] when [`DISCARD_UNDO_SECS`] have passed.
    pub fn push(&mut self, entry: T) -> u64 {
        self.entries.push(entry);
        self.claimed = true;
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    /// The notice to show, none when nothing can be undone.
    #[must_use]
    pub fn notice(&self) -> Option<DiscardNotice> {
        (!self.entries.is_empty()).then_some(DiscardNotice {
            count: self.entries.len(),
        })
    }

    /// Takes every discard to restore, newest first. The notice goes.
    pub fn undo(&mut self) -> Vec<T> {
        self.claimed = false;
        let mut entries = std::mem::take(&mut self.entries);
        entries.reverse();
        entries
    }

    /// Ends the notice when `generation` is still the newest discard; a later discard keeps it.
    /// Returns whether the notice went.
    pub fn expire(&mut self, generation: u64) -> bool {
        if generation != self.generation || self.entries.is_empty() {
            return false;
        }
        self.entries.clear();
        self.claimed = false;
        true
    }

    /// Whether `⌘Z` undoes the notice even while a text field has the keyboard.
    #[must_use]
    pub fn claims_shortcut(&self) -> bool {
        self.claimed && !self.entries.is_empty()
    }

    /// Hands `⌘Z` back to text fields (`releaseThreadUndoShortcut`).
    pub fn release_claim(&mut self) {
        self.claimed = false;
    }
}

/// `Discarded 2 drafts`, the sentence a screen reader hears.
#[must_use]
pub fn discard_summary(count: usize) -> String {
    format!("Discarded {count} {}", draft_noun(count))
}

/// `Discarded,` or `Discarded 2,`: the words before the `Undo` button, which is too narrow for
/// the sentence (`SHORT_SUMMARY`).
#[must_use]
pub fn discard_short_summary(count: usize) -> String {
    if count == 1 {
        "Discarded,".to_owned()
    } else {
        format!("Discarded {count},")
    }
}

/// `Undid discard of 2 drafts`, what a screen reader hears once the drafts are back.
#[must_use]
pub fn undone_summary(count: usize) -> String {
    format!("Undid discard of {count} {}", draft_noun(count))
}

fn draft_noun(count: usize) -> &'static str {
    if count == 1 { "draft" } else { "drafts" }
}

/// The `Undo` button's text: `⌘Z to undo` (`threadUndoLabel`).
#[must_use]
pub fn undo_label() -> String {
    format!("{UNDO_SHORTCUT_LABEL} to undo")
}

/// Shown instead of the notice when an undo cannot put the input back.
pub const UNDO_FAILED_NEW_CONTENT: &str = "The draft has new content.";

/// Whether `key` with `mods` is `⌘Z` (`mod+z`); `⌘⇧Z` is redo and belongs to the text field.
#[must_use]
pub fn is_undo_key(key: &str, mods: KeyMods) -> bool {
    key == "z" && mods.platform && !mods.shift && !mods.alt && !mods.control
}

/// A bare modifier press; it neither undoes nor hands `⌘Z` back to text fields.
#[must_use]
pub fn is_modifier_key(key: &str) -> bool {
    matches!(key, "shift" | "control" | "alt" | "platform" | "function")
}

/// What `⌘Z` finds around the keyboard (`registerThreadUndoCommands` and the `thread.undo`
/// binding, `!terminalFocus && !editableFocus`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UndoShortcutScene {
    /// A terminal has the keyboard.
    pub terminal_focus: bool,
    /// A text field has the keyboard.
    pub editable_focus: bool,
    /// The command palette, Settings or a picker is open and owns `⌘Z`.
    pub overlay_open: bool,
    /// The sidebar is open; a collapsed one hides the notice, so text fields keep their undo.
    pub sidebar_visible: bool,
    /// A notice is showing.
    pub has_notice: bool,
    /// The notice still owns `⌘Z` inside text fields ([`DiscardUndo::claims_shortcut`]).
    pub claimed: bool,
}

/// Whether `⌘Z` undoes the notice rather than the text field or terminal that has the keyboard.
#[must_use]
pub fn undo_shortcut_applies(scene: UndoShortcutScene) -> bool {
    let editable = scene.editable_focus && !(scene.sidebar_visible && scene.claimed);
    scene.has_notice && !scene.overlay_open && !scene.terminal_focus && !editable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_discard_shows_the_notice_and_one_undo_restores_every_discard_newest_first() {
        let mut undo = DiscardUndo::default();
        assert_eq!(undo.notice(), None);
        undo.push("first");
        undo.push("second");
        assert_eq!(undo.notice(), Some(DiscardNotice { count: 2 }));
        assert_eq!(undo.undo(), vec!["second", "first"]);
        assert_eq!(undo.notice(), None);
        assert!(undo.undo().is_empty(), "a second undo finds nothing");
    }

    #[test]
    fn only_the_newest_discard_ends_the_notice() {
        let mut undo = DiscardUndo::default();
        let first = undo.push(1);
        let second = undo.push(2);
        assert!(!undo.expire(first), "a later discard restarted the clock");
        assert_eq!(undo.notice(), Some(DiscardNotice { count: 2 }));
        assert!(undo.expire(second));
        assert_eq!(undo.notice(), None);
        assert!(!undo.expire(second), "an ended notice ends once");
    }

    #[test]
    fn a_discard_claims_the_shortcut_until_another_key_or_the_undo() {
        let mut undo = DiscardUndo::default();
        assert!(!undo.claims_shortcut());
        undo.push(1);
        assert!(undo.claims_shortcut());
        undo.release_claim();
        assert!(!undo.claims_shortcut());
        undo.push(2);
        assert!(undo.claims_shortcut(), "a new discard claims it again");
        undo.undo();
        assert!(!undo.claims_shortcut());
    }

    #[test]
    fn the_notice_reads_like_conns() {
        assert_eq!(discard_summary(1), "Discarded 1 draft");
        assert_eq!(discard_summary(3), "Discarded 3 drafts");
        assert_eq!(discard_short_summary(1), "Discarded,");
        assert_eq!(discard_short_summary(2), "Discarded 2,");
        assert_eq!(undone_summary(2), "Undid discard of 2 drafts");
        assert_eq!(undo_label(), "⌘Z to undo");
    }

    #[test]
    fn only_plain_command_z_is_undo() {
        let command = KeyMods {
            platform: true,
            ..KeyMods::default()
        };
        assert!(is_undo_key("z", command));
        assert!(!is_undo_key("z", KeyMods::default()));
        assert!(
            !is_undo_key(
                "z",
                KeyMods {
                    shift: true,
                    ..command
                }
            ),
            "command shift z is redo"
        );
        assert!(!is_undo_key("y", command));
        assert!(is_modifier_key("shift") && !is_modifier_key("z"));
    }

    #[test]
    fn the_shortcut_leaves_terminals_overlays_and_unclaimed_text_fields_alone() {
        let scene = UndoShortcutScene {
            sidebar_visible: true,
            has_notice: true,
            claimed: true,
            ..UndoShortcutScene::default()
        };
        assert!(undo_shortcut_applies(scene), "nothing in the way");
        assert!(
            undo_shortcut_applies(UndoShortcutScene {
                editable_focus: true,
                ..scene
            }),
            "a new notice owns the shortcut inside a text field"
        );
        assert!(
            !undo_shortcut_applies(UndoShortcutScene {
                editable_focus: true,
                claimed: false,
                ..scene
            }),
            "after another key the text field keeps its own undo"
        );
        assert!(
            !undo_shortcut_applies(UndoShortcutScene {
                editable_focus: true,
                sidebar_visible: false,
                ..scene
            }),
            "a collapsed sidebar hides the notice"
        );
        assert!(!undo_shortcut_applies(UndoShortcutScene {
            terminal_focus: true,
            ..scene
        }));
        assert!(!undo_shortcut_applies(UndoShortcutScene {
            overlay_open: true,
            ..scene
        }));
        assert!(!undo_shortcut_applies(UndoShortcutScene {
            has_notice: false,
            ..scene
        }));
    }
}
