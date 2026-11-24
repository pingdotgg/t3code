//! The right-click menu, as the host shows it.
//!
//! The view is windowless (offscreen), so Chromium never draws a menu itself. It hands the host
//! the finished menu and waits for one answer: a command id, or "cancelled". This module holds
//! the parts that need no browser: the plain menu rows ([`menu_entries`]) and the reply handle
//! that guarantees every menu is answered exactly once ([`ContextMenuReply`]).

use std::sync::Mutex;

/// What kind of row a Chromium menu item is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RawKind {
    Command,
    Check,
    Radio,
    Separator,
    Submenu,
}

/// One item of Chromium's menu model, read as it is (before any cleanup).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawMenuItem {
    pub(crate) kind: RawKind,
    pub(crate) command_id: i32,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) visible: bool,
    pub(crate) checked: bool,
    /// The items of a submenu.
    pub(crate) children: Vec<RawMenuItem>,
}

/// One row of the menu the host shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    /// A command. `checked` is `Some` for check and radio items.
    Item {
        command_id: i32,
        label: String,
        enabled: bool,
        checked: Option<bool>,
        /// Nesting level: 0 at the top, 1 inside a submenu.
        depth: u8,
    },
    /// The name of a submenu, shown above its items.
    Heading {
        label: String,
        depth: u8,
    },
    Separator,
}

impl MenuEntry {
    /// Whether choosing this row runs a command.
    #[must_use]
    pub fn is_actionable(&self) -> bool {
        matches!(self, Self::Item { enabled: true, .. })
    }
}

/// How deep submenus are flattened; deeper ones are dropped.
const MAX_DEPTH: u8 = 2;

/// Removes Chromium's `&` mnemonic markers from a label (`Cu&t` is `Cut`, `&&` is `&`).
#[must_use]
pub(crate) fn strip_mnemonic(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_owned()
}

/// The rows to show for Chromium's menu: hidden and unlabelled items dropped, mnemonics removed,
/// submenus flattened under a heading, and no separator at the start, at the end, or twice in a
/// row.
#[must_use]
pub(crate) fn menu_entries(items: &[RawMenuItem]) -> Vec<MenuEntry> {
    let mut entries = Vec::new();
    flatten(items, 0, &mut entries);

    let mut tidy: Vec<MenuEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry == MenuEntry::Separator && matches!(tidy.last(), None | Some(MenuEntry::Separator))
        {
            continue;
        }
        tidy.push(entry);
    }
    while tidy.last() == Some(&MenuEntry::Separator) {
        tidy.pop();
    }
    tidy
}

fn flatten(items: &[RawMenuItem], depth: u8, out: &mut Vec<MenuEntry>) {
    for item in items.iter().filter(|i| i.visible) {
        match item.kind {
            RawKind::Separator => out.push(MenuEntry::Separator),
            RawKind::Submenu => {
                let label = strip_mnemonic(&item.label);
                if depth >= MAX_DEPTH || label.is_empty() {
                    continue;
                }
                let before = out.len();
                out.push(MenuEntry::Heading { label, depth });
                flatten(&item.children, depth + 1, out);
                if !out[before + 1..]
                    .iter()
                    .any(|e| matches!(e, MenuEntry::Item { .. }))
                {
                    out.truncate(before);
                }
            }
            RawKind::Command | RawKind::Check | RawKind::Radio => {
                let label = strip_mnemonic(&item.label);
                if label.is_empty() {
                    continue;
                }
                out.push(MenuEntry::Item {
                    command_id: item.command_id,
                    label,
                    enabled: item.enabled,
                    checked: matches!(item.kind, RawKind::Check | RawKind::Radio)
                        .then_some(item.checked),
                    depth,
                });
            }
        }
    }
}

/// The one answer to a menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Run this command.
    Choose(i32),
    /// Close the menu and run nothing.
    Cancel,
}

type Responder = Box<dyn FnOnce(Answer) + Send>;

/// The answer slot of one open menu. Chromium waits for exactly one answer and stalls further
/// menus until it comes, so this sends [`Answer::Cancel`] when it is dropped unanswered, and
/// ignores every answer after the first.
pub struct ContextMenuReply {
    responder: Mutex<Option<Responder>>,
}

impl ContextMenuReply {
    /// A reply that runs `responder` with the first answer. The view makes these for Chromium's
    /// menus; hosts make them to test their menu logic.
    pub fn new(responder: impl FnOnce(Answer) + Send + 'static) -> Self {
        Self {
            responder: Mutex::new(Some(Box::new(responder))),
        }
    }

    /// Runs `command_id` (a Chromium command or one of Conn's) and closes the menu.
    pub fn choose(&self, command_id: i32) {
        self.answer(Answer::Choose(command_id));
    }

    /// Closes the menu without running anything.
    pub fn cancel(&self) {
        self.answer(Answer::Cancel);
    }

    /// Whether an answer has gone out.
    #[must_use]
    pub fn is_answered(&self) -> bool {
        self.responder.lock().map_or(true, |slot| slot.is_none())
    }

    fn answer(&self, answer: Answer) {
        let responder = self.responder.lock().ok().and_then(|mut slot| slot.take());
        if let Some(responder) = responder {
            responder(answer);
        }
    }
}

impl Drop for ContextMenuReply {
    fn drop(&mut self) {
        self.answer(Answer::Cancel);
    }
}

impl std::fmt::Debug for ContextMenuReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContextMenuReply")
            .field("answered", &self.is_answered())
            .finish()
    }
}

/// A menu to show.
#[derive(Debug)]
pub struct ContextMenuRequest {
    /// Where the right-click landed, in the view's own coordinates (logical points).
    pub x: i32,
    pub y: i32,
    pub entries: Vec<MenuEntry>,
    /// Answer it, or drop it to cancel.
    pub reply: ContextMenuReply,
}

/// What the view tells the host about its menu.
#[derive(Debug)]
pub enum ContextMenuEvent {
    /// Show this menu.
    Open(ContextMenuRequest),
    /// Chromium closed the menu (an answer went out, or a newer menu or a navigation took over).
    Dismissed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as StdMutex};

    fn raw(kind: RawKind, id: i32, label: &str) -> RawMenuItem {
        RawMenuItem {
            kind,
            command_id: id,
            label: label.to_owned(),
            enabled: true,
            visible: true,
            checked: false,
            children: Vec::new(),
        }
    }

    fn item(id: i32, label: &str) -> RawMenuItem {
        raw(RawKind::Command, id, label)
    }

    fn sep() -> RawMenuItem {
        raw(RawKind::Separator, -1, "")
    }

    fn labels(entries: &[MenuEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| match e {
                MenuEntry::Item { label, .. } => label.clone(),
                MenuEntry::Heading { label, .. } => format!("# {label}"),
                MenuEntry::Separator => "---".to_owned(),
            })
            .collect()
    }

    #[test]
    fn mnemonics_are_removed() {
        assert_eq!(strip_mnemonic("Cu&t"), "Cut");
        assert_eq!(strip_mnemonic("Save && Close"), "Save & Close");
        assert_eq!(strip_mnemonic("  Copy "), "Copy");
        assert_eq!(strip_mnemonic("&"), "");
    }

    #[test]
    fn model_becomes_rows_with_clean_separators() {
        let mut hidden = item(3, "Hidden");
        hidden.visible = false;
        let mut disabled = item(4, "&Back");
        disabled.enabled = false;
        let model = vec![
            sep(),
            disabled,
            hidden,
            sep(),
            sep(),
            item(5, "Cu&t"),
            item(6, ""),
            sep(),
        ];
        let entries = menu_entries(&model);
        assert_eq!(labels(&entries), vec!["Back", "---", "Cut"]);
        assert!(!entries[0].is_actionable());
        assert!(entries[2].is_actionable());
    }

    #[test]
    fn check_and_radio_items_carry_their_state() {
        let mut check = raw(RawKind::Check, 7, "Spell check");
        check.checked = true;
        let radio = raw(RawKind::Radio, 8, "Other");
        let entries = menu_entries(&[check, radio]);
        assert!(matches!(
            entries[0],
            MenuEntry::Item {
                checked: Some(true),
                ..
            }
        ));
        assert!(matches!(
            entries[1],
            MenuEntry::Item {
                checked: Some(false),
                ..
            }
        ));
        assert!(matches!(
            menu_entries(&[item(1, "Copy")])[0],
            MenuEntry::Item { checked: None, .. }
        ));
    }

    #[test]
    fn submenus_are_flattened_under_a_heading_and_empty_ones_dropped() {
        let mut languages = raw(RawKind::Submenu, -1, "&Languages");
        languages.children = vec![item(10, "English"), item(11, "Dutch")];
        let empty = raw(RawKind::Submenu, -1, "Nothing");
        let mut all_hidden = raw(RawKind::Submenu, -1, "Hidden kids");
        let mut kid = item(12, "Kid");
        kid.visible = false;
        all_hidden.children = vec![kid];

        let entries = menu_entries(&[item(1, "Copy"), languages, empty, all_hidden]);
        assert_eq!(
            labels(&entries),
            vec!["Copy", "# Languages", "English", "Dutch"]
        );
        assert!(matches!(entries[2], MenuEntry::Item { depth: 1, .. }));
    }

    fn recording_reply() -> (ContextMenuReply, Arc<StdMutex<Vec<Answer>>>) {
        let answers = Arc::new(StdMutex::new(Vec::new()));
        let sink = answers.clone();
        let reply = ContextMenuReply::new(move |answer| {
            sink.lock().expect("lock").push(answer);
        });
        (reply, answers)
    }

    #[test]
    fn choosing_answers_once_and_later_answers_do_nothing() {
        let (reply, answers) = recording_reply();
        reply.choose(26_500);
        reply.cancel();
        reply.choose(1);
        assert!(reply.is_answered());
        drop(reply);
        assert_eq!(*answers.lock().expect("lock"), vec![Answer::Choose(26_500)]);
    }

    #[test]
    fn dropping_an_unanswered_menu_cancels_it() {
        let (reply, answers) = recording_reply();
        assert!(!reply.is_answered());
        drop(reply);
        assert_eq!(*answers.lock().expect("lock"), vec![Answer::Cancel]);
    }

    #[test]
    fn a_dismissed_request_cancels_when_its_event_is_dropped() {
        let (reply, answers) = recording_reply();
        let event = ContextMenuEvent::Open(ContextMenuRequest {
            x: 1,
            y: 2,
            entries: Vec::new(),
            reply,
        });
        drop(event);
        assert_eq!(*answers.lock().expect("lock"), vec![Answer::Cancel]);
    }
}
