//! Decodes contract payloads into the generated types, encodes them again and compares the JSON.
//!
//! - `fixtures/sampled.jsonl`: values sampled from every root schema with Effect's `Arbitrary` and
//!   encoded with the real JSON codec (`tools/gen-contract.mjs` writes it).
//! - `CONN_CONTRACT_REAL_PAYLOADS=<file>`: real payloads in the same `[{key, value}]` form, from
//!   `tools/real-payloads.mjs`. They hold user data, so they are never committed.

mod registry;

use serde_json::Value;

#[derive(serde::Deserialize)]
struct Fixture {
    key: String,
    value: Value,
}

/// JSON equality where `1` equals `1.0`: JavaScript has one number type, serde has three.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn check(fixtures: Vec<Fixture>) -> (usize, Vec<String>) {
    let mut failures = Vec::new();
    let mut passed = 0;
    for Fixture { key, value } in fixtures {
        match registry::round_trip(&key, value.clone()) {
            None => failures.push(format!("{key}: no generated type")),
            Some(Err(e)) => failures.push(format!("{key}: decode failed: {e}\n  input: {value}")),
            Some(Ok(out)) if !same(&out, &value) => {
                failures.push(format!("{key}: JSON changed\n  in:  {value}\n  out: {out}"))
            }
            Some(Ok(_)) => passed += 1,
        }
    }
    (passed, failures)
}

fn report(name: &str, (passed, failures): (usize, Vec<String>)) {
    eprintln!("{name}: {passed} round-tripped, {} failed", failures.len());
    if !failures.is_empty() {
        let shown: Vec<_> = failures
            .iter()
            .take(20)
            .map(|f| f.chars().take(2000).collect::<String>())
            .collect();
        panic!(
            "{} of {} failed:\n{}",
            failures.len(),
            passed + failures.len(),
            shown.join("\n")
        );
    }
}

fn sampled() -> Vec<Fixture> {
    include_str!("fixtures/sampled.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).expect("valid fixture"))
        .collect()
}

#[test]
fn sampled_payloads_round_trip() {
    let fixtures = sampled();
    assert!(fixtures.len() > 2000, "fixtures shrank: {}", fixtures.len());
    report("sampled", check(fixtures));
}

#[test]
fn every_stream_item_kind_and_command_has_a_fixture() {
    let fixtures = sampled();
    let tags = |key: &str, field: &str| -> std::collections::BTreeSet<String> {
        fixtures
            .iter()
            .filter(|f| f.key == key)
            .filter_map(|f| f.value.get(field)?.as_str().map(str::to_owned))
            .collect()
    };
    assert_eq!(tags("OrchestrationV2ShellStreamItem", "kind").len(), 7);
    // `event` covers both the typed event and the forward-compatible unknown event.
    assert_eq!(tags("OrchestrationV2ThreadStreamItem", "kind").len(), 3);
    assert!(tags("OrchestrationV2Command", "type").len() >= 56);
    // 26 members; several members carry many `type` literals, so this counts members, not types.
    assert!(tags("OrchestrationV2DomainEvent", "type").len() >= 26);
}

#[test]
fn real_payloads_round_trip() {
    let Ok(path) = std::env::var("CONN_CONTRACT_REAL_PAYLOADS") else {
        eprintln!("CONN_CONTRACT_REAL_PAYLOADS not set; skipped");
        return;
    };
    let text = std::fs::read_to_string(&path).expect("readable payload file");
    let fixtures: Vec<Fixture> = serde_json::from_str(&text).expect("valid payload file");
    report("real", check(fixtures));
}

#[test]
fn unknown_tag_is_an_error_not_a_guess() {
    let bad = serde_json::json!({"type": "thread.nope", "commandId": "c1", "threadId": "t1"});
    assert!(conn_contract::from_json::<conn_contract::Command>(bad).is_err());
    let missing_field = serde_json::json!({"type": "thread.stop", "threadId": "t1"});
    assert!(conn_contract::from_json::<conn_contract::Command>(missing_field).is_err());
}

#[test]
fn optional_nullable_project_cleanup_preserves_missing_null_and_value() {
    use conn_contract::ServerSettingsProjectSettingsOverridesValue as Overrides;
    for value in [
        serde_json::json!({}),
        serde_json::json!({"worktreeCleanup": null}),
        serde_json::json!({"worktreeCleanup": {"mode": "off"}}),
    ] {
        let decoded: Overrides = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    }
}
