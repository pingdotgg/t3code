use conn_state::{ThreadState, ThreadStreamItem};

#[test]
fn revision_changes_on_every_apply_and_is_unique_per_state() {
    let Ok(synchronized) = serde_json::from_str::<ThreadStreamItem>(r#"{"kind":"synchronized"}"#)
    else {
        panic!("synchronized item must decode");
    };
    let mut a = ThreadState::new("a");
    let b = ThreadState::new("a");
    assert_ne!(
        a.revision, b.revision,
        "fresh states must not share a revision"
    );

    let before = a.revision;
    a.apply(synchronized);
    assert!(a.synchronized, "synchronized marker must mark the state");
    assert_ne!(a.revision, before, "apply must change the revision");
}

#[test]
fn cache_overlap_preserves_live_body_revision_and_server_cursor() {
    use conn_state::TimelineEntry;
    let notice = |id: &str, text: &str| TimelineEntry::Notice {
        id: id.to_owned(),
        text: text.to_owned(),
        is_error: false,
    };
    let mut state = ThreadState::new("thread");
    state.entries.push(notice("2", "live"));
    state.history_cursor = Some("server".into());
    let revision = state.revision;
    state.prepend_cached_messages(vec![notice("1", "older"), notice("2", "stale")]);
    assert_ne!(state.revision, revision);
    assert_eq!(state.entries.len(), 2);
    assert!(matches!(&state.entries[1],TimelineEntry::Notice{text,..} if text=="live"));
    assert_eq!(state.history_cursor.as_deref(), Some("server"));
    let revision = state.revision;
    state.prepend_cached_messages(vec![notice("1", "already present")]);
    assert_eq!(state.revision, revision);
    assert_eq!(state.history_prefix_len(), 1);
    state.replace_cached_prefix(vec![notice("0", "corrected"), notice("1", "older")]);
    assert_eq!(state.history_prefix_len(), 2);
    assert_eq!(state.entries[2].id(), "2");
    state.replace_cached_prefix(Vec::new());
    assert_eq!(state.history_prefix_len(), 0);
    assert_eq!(state.entries.len(), 1);
}
