//! Composer draft rules from Conn mobile's `use-thread-composer-state.ts` and
//! `use-composer-drafts.ts`.

/// The draft after a send fails. Mobile clears the draft when it sends, so typing during a slow
/// send is kept; a failed send puts the sent text back in front of it (`mergeComposerDraftText`).
#[uniffi::export]
#[must_use]
pub fn composer_restore_draft(current: String, sent: String) -> String {
    if sent.is_empty() {
        return current;
    }
    if current.is_empty() {
        return sent;
    }
    if current == sent || current.ends_with(&format!("\n\n{sent}")) {
        return current;
    }
    format!("{current}\n\n{sent}")
}

#[cfg(test)]
mod tests {
    use super::composer_restore_draft;

    fn restore(current: &str, sent: &str) -> String {
        composer_restore_draft(current.to_owned(), sent.to_owned())
    }

    #[test]
    fn a_failed_send_keeps_what_was_typed_meanwhile() {
        assert_eq!(
            restore("", "fix the bug"),
            "fix the bug",
            "an untouched draft gets its text back"
        );
        assert_eq!(
            restore("and add a test", "fix the bug"),
            "and add a test\n\nfix the bug",
            "newer typing stays, the sent text follows"
        );
        assert_eq!(
            restore("fix the bug", "fix the bug"),
            "fix the bug",
            "the same text is not doubled"
        );
        assert_eq!(
            restore("more\n\nfix the bug", "fix the bug"),
            "more\n\nfix the bug",
            "a text already restored is not added twice"
        );
        assert_eq!(
            restore("draft", ""),
            "draft",
            "nothing sent changes nothing"
        );
    }
}
