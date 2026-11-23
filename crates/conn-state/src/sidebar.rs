//! Sidebar rows for unsent new-thread drafts (Conn `SidebarDraftBlock`): which drafts get a
//! row, their order, and their label; which started threads show an unsent-input mark
//! (`useThreadHasUnsentDraft`); and what a key does on a draft row. Plain data in and out, so
//! the iPhone app can share it.

use std::collections::HashSet;

/// Status the row's accessibility label carries (`gt("Unsent draft")`).
pub const DRAFT_STATUS_LABEL: &str = "Unsent draft";

/// One draft as the sidebar sees it.
#[derive(Clone, Copy, Debug)]
pub struct SidebarDraft<'a> {
    pub draft_id: &'a str,
    pub project_id: &'a str,
    pub created_at_ms: u64,
    /// The draft is being sent; the thread replaces it (`promotedTo`).
    pub launching: bool,
    pub prompt: &'a str,
    pub attachment_count: usize,
}

/// One draft row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SidebarDraftRow {
    pub draft_id: String,
    pub project_id: String,
    pub created_at_ms: u64,
    pub preview: String,
    /// The draft is open in the chat card.
    pub active: bool,
}

/// `composerDraftHasUserContent` for a prompt and an attachment count.
#[must_use]
pub fn draft_has_content(prompt: &str, attachment_count: usize) -> bool {
    !prompt.trim().is_empty() || attachment_count > 0
}

/// First line of the prompt, else the attachment count.
#[must_use]
pub fn draft_preview(prompt: &str, attachment_count: usize) -> String {
    let first_line = prompt.trim().lines().next().unwrap_or("");
    if !first_line.is_empty() {
        return first_line.to_owned();
    }
    match attachment_count {
        1 => "1 attachment".to_owned(),
        count => format!("{count} attachments"),
    }
}

/// The row for `draft`: none while it is launching or empty.
#[must_use]
pub fn sidebar_draft_row(draft: &SidebarDraft<'_>) -> Option<SidebarDraftRow> {
    if draft.launching || !draft_has_content(draft.prompt, draft.attachment_count) {
        return None;
    }
    Some(SidebarDraftRow {
        draft_id: draft.draft_id.to_owned(),
        project_id: draft.project_id.to_owned(),
        created_at_ms: draft.created_at_ms,
        preview: draft_preview(draft.prompt, draft.attachment_count),
        active: false,
    })
}

/// The open draft's row, taken once when the draft opens. The row stays as it was while the
/// user types, so the list does not move or change under them; a draft that was empty when
/// it opened has no row until the user leaves it.
#[must_use]
pub fn freeze_active_draft_row(draft: &SidebarDraft<'_>) -> Option<SidebarDraftRow> {
    sidebar_draft_row(draft).map(|row| SidebarDraftRow {
        active: true,
        ..row
    })
}

/// Orders draft rows for the sidebar, newest draft first, and drops rows of projects outside
/// the sidebar's project filter (`in_scope`). `rows` are the parked drafts' rows
/// ([`sidebar_draft_row`]) and the open draft's frozen row ([`freeze_active_draft_row`]).
#[must_use]
pub fn sidebar_draft_rows(
    rows: impl IntoIterator<Item = SidebarDraftRow>,
    in_scope: impl Fn(&str) -> bool,
) -> Vec<SidebarDraftRow> {
    let mut rows: Vec<SidebarDraftRow> = rows
        .into_iter()
        .filter(|row| in_scope(&row.project_id))
        .collect();
    rows.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| left.draft_id.cmp(&right.draft_id))
    });
    rows
}

/// Accessibility label of a draft row: `<preview>, Unsent draft, <project>`.
#[must_use]
pub fn draft_row_label(preview: &str, project_title: Option<&str>) -> String {
    [Some(preview), Some(DRAFT_STATUS_LABEL), project_title]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Ids of the started threads whose composer holds unsent text or attachments, so their rows
/// carry the pen mark (`useThreadHasUnsentDraft`). `drafts` is `(thread id, prompt, attachment
/// count)`. The open thread is left out: its composer is on screen (`!isRouteThread`).
#[must_use]
pub fn threads_with_unsent_input<'a>(
    drafts: impl IntoIterator<Item = (&'a str, &'a str, usize)>,
    open_thread_id: Option<&str>,
) -> HashSet<String> {
    drafts
        .into_iter()
        .filter(|(thread_id, prompt, count)| {
            Some(*thread_id) != open_thread_id && draft_has_content(prompt, *count)
        })
        .map(|(thread_id, _, _)| thread_id.to_owned())
        .collect()
}

/// What a key press does on a focused draft row (`SidebarDraftRow` `handleKeyDown`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DraftRowKey {
    /// Reopen the draft.
    Open,
    /// Open the row's menu below the row.
    Menu,
}

/// `Enter` and `Space` activate a row or button (`is_activation_key`).
#[must_use]
pub fn is_activation_key(key: &str) -> bool {
    matches!(key, "enter" | "space")
}

/// The action of `key` on a focused draft row: `Enter` / `Space` open it, `ContextMenu` and
/// `Shift+F10` open its menu.
#[must_use]
pub fn draft_row_key(key: &str, shift: bool) -> Option<DraftRowKey> {
    match key {
        k if is_activation_key(k) => Some(DraftRowKey::Open),
        "menu" => Some(DraftRowKey::Menu),
        "f10" if shift => Some(DraftRowKey::Menu),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft<'a>(id: &'a str, project: &'a str, at: u64, prompt: &'a str) -> SidebarDraft<'a> {
        SidebarDraft {
            draft_id: id,
            project_id: project,
            created_at_ms: at,
            launching: false,
            prompt,
            attachment_count: 0,
        }
    }

    fn ids(rows: &[SidebarDraftRow]) -> Vec<&str> {
        rows.iter().map(|r| r.draft_id.as_str()).collect()
    }

    #[test]
    fn preview_is_the_first_line_or_the_attachment_count() {
        assert_eq!(
            draft_preview("  fix the bug\nsecond line", 0),
            "fix the bug"
        );
        assert_eq!(draft_preview("   ", 1), "1 attachment");
        assert_eq!(draft_preview("", 3), "3 attachments");
        assert_eq!(draft_preview("text", 3), "text");
    }

    #[test]
    fn empty_and_launching_drafts_have_no_row() {
        assert!(sidebar_draft_row(&draft("d", "p", 1, "  ")).is_none());
        let launching = SidebarDraft {
            launching: true,
            ..draft("d", "p", 1, "text")
        };
        assert!(sidebar_draft_row(&launching).is_none());
        let attached = SidebarDraft {
            attachment_count: 1,
            ..draft("d", "p", 1, "")
        };
        assert_eq!(
            sidebar_draft_row(&attached).map(|r| r.preview),
            Some("1 attachment".to_owned())
        );
    }

    #[test]
    fn rows_list_newest_first_with_the_frozen_open_draft_among_them() {
        let open = draft("open", "p", 20, "was typed before it opened");
        let rows = sidebar_draft_rows(
            [
                sidebar_draft_row(&draft("old", "p", 10, "a")),
                sidebar_draft_row(&draft("new", "q", 30, "b")),
                freeze_active_draft_row(&open),
            ]
            .into_iter()
            .flatten(),
            |_| true,
        );
        assert_eq!(ids(&rows), vec!["new", "open", "old"]);
        assert_eq!(
            rows.iter().map(|r| r.active).collect::<Vec<_>>(),
            vec![false, true, false]
        );
    }

    #[test]
    fn a_draft_that_was_empty_when_it_opened_has_no_row_while_open() {
        let open = draft("open", "p", 20, "");
        assert!(freeze_active_draft_row(&open).is_none());
        let rows = sidebar_draft_rows(sidebar_draft_row(&draft("old", "p", 10, "a")), |_| true);
        assert_eq!(ids(&rows), vec!["old"]);
    }

    #[test]
    fn project_filter_hides_other_projects_drafts() {
        let rows = sidebar_draft_rows(
            [draft("a", "p", 1, "x"), draft("b", "q", 2, "y")]
                .iter()
                .filter_map(sidebar_draft_row),
            |project| project == "q",
        );
        assert_eq!(ids(&rows), vec!["b"]);
    }

    #[test]
    fn equal_timestamps_keep_a_stable_order() {
        let rows = sidebar_draft_rows(
            [draft("b", "p", 5, "x"), draft("a", "p", 5, "y")]
                .iter()
                .filter_map(sidebar_draft_row),
            |_| true,
        );
        assert_eq!(ids(&rows), vec!["a", "b"]);
    }

    #[test]
    fn label_joins_preview_status_and_project() {
        assert_eq!(
            draft_row_label("fix it", Some("conn")),
            "fix it, Unsent draft, conn"
        );
        assert_eq!(draft_row_label("fix it", None), "fix it, Unsent draft");
    }

    #[test]
    fn unsent_threads_are_those_with_content_other_than_the_open_one() {
        let unsent = threads_with_unsent_input(
            [
                ("a", "half a prompt", 0),
                ("b", "   ", 0),
                ("c", "", 2),
                ("open", "typing", 0),
            ],
            Some("open"),
        );
        let mut ids: Vec<&str> = unsent.iter().map(String::as_str).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["a", "c"]);
        assert!(threads_with_unsent_input([("a", "x", 0)], None).contains("a"));
    }

    #[test]
    fn draft_rows_answer_enter_space_and_the_menu_keys() {
        assert_eq!(draft_row_key("enter", false), Some(DraftRowKey::Open));
        assert_eq!(draft_row_key("space", false), Some(DraftRowKey::Open));
        assert_eq!(draft_row_key("menu", false), Some(DraftRowKey::Menu));
        assert_eq!(draft_row_key("f10", true), Some(DraftRowKey::Menu));
        assert_eq!(draft_row_key("f10", false), None);
        assert_eq!(draft_row_key("a", false), None);
        assert!(is_activation_key("enter") && !is_activation_key("tab"));
    }
}
