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
