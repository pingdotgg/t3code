use serde_json::Value;

use super::project_for_provider;

/// T3's own function on the same inputs (`tools/gen-composer-context-cases.mjs`), after the
/// contract's record decoding.
#[test]
fn projection_matches_t3s() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("composer-context-cases.json")).expect("T3 cases");
    assert!(cases.len() > 20);
    for case in cases {
        let records = case["records"].as_array().cloned().unwrap_or_default();
        let text = case["text"].as_str().expect("text");
        assert_eq!(
            project_for_provider(text, &records),
            case["expected"].as_str().expect("expected"),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn a_thread_chip_names_the_thread_to_read() {
    let record = serde_json::json!({
        "version": 1, "kind": "thread", "contextId": "thread_abc", "label": "Old",
        "environmentId": "env-1", "threadId": "abc", "title": "Fix login",
    });
    let projected = project_for_provider("See [Old](t3-context://v1/thread/thread_abc)", &[record]);
    assert!(projected.starts_with("See [Thread: Old; ref=thread_abc]\n\n<t3_context"));
    assert!(projected.contains(r#"conn_thread_read({"threadId":"abc","environmentId":"env-1"})"#));
}
