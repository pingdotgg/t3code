//! `Undo` for discarded drafts, thread input and settled threads (Conn
//! `hooks/showThreadUndoNotice.ts`, `lib/discardComposerDraft.ts`, `hooks/useThreadActions.ts`
//! `settleThread`): the notice in the sidebar footer, how long it lasts, what `⌘Z` undoes and
//! where it leaves a text field alone. Plain data in and out, so the iPhone app can share it.

use crate::sidebar_nav::KeyMods;

/// How long the notice stays after the last discard (`showThreadUndoNotice` `5_000`).
pub const DISCARD_UNDO_SECS: u64 = 5;

/// The shortcut the notice names (`thread.undo`).
pub const UNDO_SHORTCUT_LABEL: &str = "⌘Z";

/// What the actions behind a notice did (`UndoOptions["action"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UndoAction {
    /// A draft or a thread's unsent input was discarded.
    Discarded,
    /// A thread was moved to the Settled shelf.
    Settled,
}

impl UndoAction {
    /// The word in the notice (`Discarded`, `Settled`).
    fn past(self) -> &'static str {
        match self {
            Self::Discarded => "Discarded",
            Self::Settled => "Settled",
        }
    }

    /// The thing there are several of.
    fn noun(self, count: usize) -> &'static str {
        match (self, count == 1) {
            (Self::Discarded, true) => "draft",
            (Self::Discarded, false) => "drafts",
            (Self::Settled, true) => "thread",
            (Self::Settled, false) => "threads",
        }
    }

    /// The verb after `Undid` (`Undid settle of 2 threads`).
    fn undone(self) -> &'static str {
        match self {
            Self::Discarded => "discard",
            Self::Settled => "settle",
        }
    }
}

/// The notice: what it says and how many actions one `Undo` brings back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiscardNotice {
    pub action: UndoAction,
    pub count: usize,
}

/// The actions `Undo` can bring back, newest last. One notice covers the newest run of actions
/// of one kind, and one `Undo` restores that run (`refreshNotice` groups consecutive actions of
/// the same kind); the actions before it stay for the next `Undo` until the notice expires.
#[derive(Debug)]
pub struct DiscardUndo<T> {
    entries: Vec<(UndoAction, T)>,
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
    /// Adds a discard. See [`Self::push_action`].
    pub fn push(&mut self, entry: T) -> u64 {
        self.push_action(UndoAction::Discarded, entry)
    }

    /// Adds an action. The notice shows, `⌘Z` is claimed, and the expiry starts over. Returns
    /// the generation to hand to [`Self::expire`] when [`DISCARD_UNDO_SECS`] have passed.
    pub fn push_action(&mut self, action: UndoAction, entry: T) -> u64 {
        self.entries.push((action, entry));
        self.claimed = true;
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    /// The notice to show, none when nothing can be undone.
    #[must_use]
    pub fn notice(&self) -> Option<DiscardNotice> {
        let action = self.entries.last()?.0;
        let count = self
            .entries
            .iter()
            .rev()
            .take_while(|(kind, _)| *kind == action)
            .count();
        Some(DiscardNotice { action, count })
    }

    /// Takes the actions the notice covers, newest first. The notice shows the run before them,
    /// if any.
    pub fn undo(&mut self) -> Vec<T> {
        let Some(notice) = self.notice() else {
            self.claimed = false;
            return Vec::new();
        };
        let from = self.entries.len() - notice.count;
        let mut run: Vec<T> = self
            .entries
            .split_off(from)
            .into_iter()
            .map(|(_, entry)| entry)
            .collect();
        run.reverse();
        run
    }

    /// Drops the actions `keep` refuses, because something else made them undo the wrong thing
    /// (`ThreadUndo.invalidate`). Returns whether any went.
    pub fn retain(&mut self, mut keep: impl FnMut(&T) -> bool) -> bool {
        let before = self.entries.len();
        self.entries.retain(|(_, entry)| keep(entry));
        self.entries.len() != before
    }

    /// Ends the notice when `generation` is still the newest action; a later one keeps it.
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

/// `Settled 2 threads`, the sentence a screen reader hears (`SUMMARY`).
#[must_use]
pub fn notice_summary(notice: DiscardNotice) -> String {
    format!(
        "{} {} {}",
        notice.action.past(),
        notice.count,
        notice.action.noun(notice.count)
    )
}

/// `Settled,` or `Settled 2,`: the words before the `Undo` button, which is too narrow for the
/// sentence (`SHORT_SUMMARY`).
#[must_use]
pub fn notice_short_summary(notice: DiscardNotice) -> String {
    if notice.count == 1 {
        format!("{},", notice.action.past())
    } else {
        format!("{} {},", notice.action.past(), notice.count)
    }
}

/// `Undid settle of 2 threads`, what a screen reader hears once the actions are undone
/// (`UNDONE`).
#[must_use]
pub fn notice_undone_summary(notice: DiscardNotice) -> String {
    format!(
        "Undid {} of {} {}",
        notice.action.undone(),
        notice.count,
        notice.action.noun(notice.count)
    )
}

/// The `Undo` button's name for a screen reader.
#[must_use]
pub fn undo_button_label(action: UndoAction) -> String {
    format!("Undo {}", action.undone())
}

/// `Discarded 2 drafts`.
#[must_use]
pub fn discard_summary(count: usize) -> String {
    notice_summary(DiscardNotice {
        action: UndoAction::Discarded,
        count,
    })
}

/// `Discarded,` or `Discarded 2,`.
#[must_use]
pub fn discard_short_summary(count: usize) -> String {
    notice_short_summary(DiscardNotice {
        action: UndoAction::Discarded,
        count,
    })
}

/// `Undid discard of 2 drafts`.
#[must_use]
pub fn undone_summary(count: usize) -> String {
    notice_undone_summary(DiscardNotice {
        action: UndoAction::Discarded,
        count,
    })
}

/// The `Undo` button's text: `⌘Z to undo` (`threadUndoLabel`).
#[must_use]
pub fn undo_label() -> String {
    format!("{UNDO_SHORTCUT_LABEL} to undo")
}

/// Shown instead of the notice when an undo cannot put the input back.
pub const UNDO_FAILED_NEW_CONTENT: &str = "The draft has new content.";

/// Shown instead of the notice when the server refused to bring a settled thread back
/// (`failureTitle` of `settleThread`).
pub const UNDO_FAILED_SETTLE: &str = "Failed to undo settle.";

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

/// What a thread looked like before it was settled (`planThreadUndo("settle", thread)`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SettledThreadFacts<'a> {
    /// The thread was pinned. Settling unpins it.
    pub pinned: bool,
    pub pin_order_key: Option<&'a str>,
    /// Its manual place among the active threads, which settling clears.
    pub active_order_key: Option<&'a str>,
    /// The Active anchor settling clears.
    pub unsettled_at: Option<&'a str>,
    /// Settling ends a snooze.
    pub snoozed_until: Option<&'a str>,
}

/// One command of an undone settle, run in order, each only when the one before succeeded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettleUndoStep {
    /// `thread.unsettle`. `restore_unsettled_at` puts the Active anchor back instead of moving
    /// the thread to the top: `None` leaves it to the server, `Some(None)` clears it.
    Unsettle {
        restore_unsettled_at: Option<Option<String>>,
    },
    /// `thread.pin`, in the place it had.
    Pin { order_key: Option<String> },
    /// `thread.active.reorder`, to the manual place it had.
    ReorderActive { order_key: String },
    /// `thread.snooze`, until the time it had. The caller skips it once that time has passed:
    /// the server refuses a wake time in the past.
    Snooze { snoozed_until: String },
}

/// The commands that bring a settled thread back. `thread` is what it was before the settle,
/// none when it was not known (`planThreadUndo`).
#[must_use]
pub fn plan_settle_undo(thread: Option<SettledThreadFacts<'_>>) -> Vec<SettleUndoStep> {
    let Some(thread) = thread else {
        return vec![SettleUndoStep::Unsettle {
            restore_unsettled_at: None,
        }];
    };
    let mut steps = vec![SettleUndoStep::Unsettle {
        restore_unsettled_at: Some(thread.unsettled_at.map(str::to_owned)),
    }];
    // Pinned threads are placed by their pin; the rest by their manual active place.
    if thread.pinned {
        steps.push(SettleUndoStep::Pin {
            order_key: thread.pin_order_key.map(str::to_owned),
        });
    } else if let Some(order_key) = thread.active_order_key {
        steps.push(SettleUndoStep::ReorderActive {
            order_key: order_key.to_owned(),
        });
    }
    if let Some(snoozed_until) = thread.snoozed_until {
        steps.push(SettleUndoStep::Snooze {
            snoozed_until: snoozed_until.to_owned(),
        });
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discarded(count: usize) -> DiscardNotice {
        DiscardNotice {
            action: UndoAction::Discarded,
            count,
        }
    }

    fn settled(count: usize) -> DiscardNotice {
        DiscardNotice {
            action: UndoAction::Settled,
            count,
        }
    }

    #[test]
    fn a_discard_shows_the_notice_and_one_undo_restores_every_discard_newest_first() {
        let mut undo = DiscardUndo::default();
        assert_eq!(undo.notice(), None);
        undo.push("first");
        undo.push("second");
        assert_eq!(undo.notice(), Some(discarded(2)));
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
        assert_eq!(undo.notice(), Some(discarded(2)));
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
    fn the_notice_covers_the_newest_run_of_one_kind_and_undo_leaves_the_runs_before_it() {
        let mut undo = DiscardUndo::default();
        undo.push("draft");
        undo.push_action(UndoAction::Settled, "a");
        undo.push_action(UndoAction::Settled, "b");
        assert_eq!(undo.notice(), Some(settled(2)));
        assert_eq!(undo.undo(), vec!["b", "a"], "newest first");
        assert_eq!(undo.notice(), Some(discarded(1)), "the discard is next");
        assert!(undo.claims_shortcut(), "the notice still owns the shortcut");
        assert_eq!(undo.undo(), vec!["draft"]);
        assert_eq!(undo.notice(), None);
        assert!(!undo.claims_shortcut());
    }

    #[test]
    fn an_action_that_went_stale_leaves_the_notice() {
        let mut undo = DiscardUndo::default();
        undo.push_action(UndoAction::Settled, "a");
        undo.push_action(UndoAction::Settled, "b");
        assert!(undo.retain(|entry| *entry != "a"));
        assert_eq!(undo.notice(), Some(settled(1)));
        assert!(!undo.retain(|_| true), "nothing went");
        assert!(undo.retain(|_| false));
        assert_eq!(undo.notice(), None);
    }

    #[test]
    fn an_undone_run_does_not_restart_the_expiry() {
        let mut undo = DiscardUndo::default();
        undo.push("draft");
        let settle = undo.push_action(UndoAction::Settled, "a");
        undo.undo();
        assert!(
            undo.expire(settle),
            "the clock of the last action still runs"
        );
        assert_eq!(undo.notice(), None);
    }

    #[test]
    fn the_notice_reads_like_conns() {
        assert_eq!(discard_summary(1), "Discarded 1 draft");
        assert_eq!(discard_summary(3), "Discarded 3 drafts");
        assert_eq!(discard_short_summary(1), "Discarded,");
        assert_eq!(discard_short_summary(2), "Discarded 2,");
        assert_eq!(undone_summary(2), "Undid discard of 2 drafts");
        assert_eq!(undo_label(), "⌘Z to undo");
        assert_eq!(notice_summary(settled(1)), "Settled 1 thread");
        assert_eq!(notice_summary(settled(2)), "Settled 2 threads");
        assert_eq!(notice_short_summary(settled(1)), "Settled,");
        assert_eq!(notice_short_summary(settled(3)), "Settled 3,");
        assert_eq!(
            notice_undone_summary(settled(2)),
            "Undid settle of 2 threads"
        );
        assert_eq!(undo_button_label(UndoAction::Settled), "Undo settle");
        assert_eq!(undo_button_label(UndoAction::Discarded), "Undo discard");
    }

    #[test]
    fn a_settled_thread_comes_back_where_it_was() {
        assert_eq!(
            plan_settle_undo(None),
            vec![SettleUndoStep::Unsettle {
                restore_unsettled_at: None
            }],
            "a thread the client lost sight of is only unsettled"
        );
        let plain = SettledThreadFacts::default();
        assert_eq!(
            plan_settle_undo(Some(plain)),
            vec![SettleUndoStep::Unsettle {
                restore_unsettled_at: Some(None)
            }],
            "the Active anchor it had none of is cleared"
        );
        let pinned = SettledThreadFacts {
            pinned: true,
            pin_order_key: Some("a0"),
            active_order_key: Some("ignored"),
            unsettled_at: Some("2026-01-02T00:00:00Z"),
            snoozed_until: Some("2026-01-03T00:00:00Z"),
        };
        assert_eq!(
            plan_settle_undo(Some(pinned)),
            vec![
                SettleUndoStep::Unsettle {
                    restore_unsettled_at: Some(Some("2026-01-02T00:00:00Z".to_owned()))
                },
                SettleUndoStep::Pin {
                    order_key: Some("a0".to_owned())
                },
                SettleUndoStep::Snooze {
                    snoozed_until: "2026-01-03T00:00:00Z".to_owned()
                },
            ],
            "a pinned thread is pinned again, and its snooze comes back last"
        );
        let placed = SettledThreadFacts {
            active_order_key: Some("m1"),
            ..plain
        };
        assert_eq!(
            plan_settle_undo(Some(placed)).get(1),
            Some(&SettleUndoStep::ReorderActive {
                order_key: "m1".to_owned()
            })
        );
        let pinned_without_key = SettledThreadFacts {
            pinned: true,
            ..plain
        };
        assert_eq!(
            plan_settle_undo(Some(pinned_without_key)).get(1),
            Some(&SettleUndoStep::Pin { order_key: None })
        );
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
