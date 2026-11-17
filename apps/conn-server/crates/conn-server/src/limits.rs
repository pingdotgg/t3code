//! RPC payload limits generated from `packages/contracts/src/rpc.ts`.
//! Type errors stay with contract decode; invalid record keys are dropped before entry checks.

use std::sync::OnceLock;

use conn_support::input::{Problem, Rules};
use serde_json::Value;

use crate::table::Failure;

mod generated;

fn table() -> Result<&'static Rules, &'static str> {
    static TABLE: OnceLock<Result<Rules, String>> = OnceLock::new();
    TABLE
        .get_or_init(|| Rules::parse(generated::LIMITS))
        .as_ref()
        .map_err(|error| {
            eprintln!("conn-server: the generated payload limits do not parse: {error}");
            "invalid generated payload limits"
        })
}

fn problem(problem: Problem) -> String {
    let mut text = format!("expected {}", problem.expected.unwrap_or_default());
    if !problem.path.is_empty() {
        text.push_str(&format!(" at {}", problem.path));
    }
    text
}

/// Checks and normalizes payload limits before the method table decodes the contract type.
pub fn check(tag: &str, payload: &mut Value) -> Result<(), Failure> {
    let Ok(rules) = table() else {
        return Ok(());
    };
    rules
        .check(tag, payload)
        .map_err(|error| Failure::die(format!("invalid payload for `{tag}`: {}", problem(error))))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    #[test]
    fn every_generated_pattern_compiles() {
        assert!(Rules::parse(generated::LIMITS).is_ok());
        let raw: Value = serde_json::from_str(generated::LIMITS).expect("generated limits parse");
        assert!(raw.get("terminal.open").is_some() && raw.get("assets.createUrl").is_some());
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        tag: String,
        payload: Value,
        ok: bool,
        #[serde(default)]
        after: Option<serde_json::Map<String, Value>>,
    }

    /// The cases `tools/limits-diff.mjs` decodes with the T3 contract's own schemas.
    #[test]
    fn cases_agree_with_the_contract() {
        #[derive(Deserialize)]
        struct Cases {
            cases: Vec<Case>,
        }
        let Cases { cases } =
            serde_json::from_str(include_str!("../tools/limits-cases.json")).expect("cases parse");
        assert!(cases.len() > 30);
        for mut case in cases {
            let result = check(&case.tag, &mut case.payload);
            assert_eq!(result.is_ok(), case.ok, "{}: {result:?}", case.name);
            for (key, expected) in case.after.iter().flatten() {
                assert_eq!(
                    &case.payload[key], expected,
                    "{}: `{key}` after the check",
                    case.name
                );
            }
        }
    }

    #[test]
    fn the_failure_names_the_limit_and_the_path() {
        let problem = |tag: &str, mut payload: Value| {
            table().ok()?.check(tag, &mut payload).err().map(problem)
        };
        let long = json!({ "resource": { "_tag": "workspace-file", "threadId": "t", "path": "a".repeat(1025) } });
        let text = problem("assets.createUrl", long).expect("over the limit");
        assert_eq!(
            text,
            r#"expected a value with a length of at most 1024, got 1025 at ["resource"]["path"]"#
        );
        let text = problem(
            "git.resolvePullRequest",
            json!({"cwd":"/repo","reference":"  "}),
        )
        .expect("blank reference");
        assert_eq!(text, r#"expected a non-blank string at ["reference"]"#);
        let env = json!({ "threadId": "t", "terminalId": "d", "cwd": "/", "env": { "A": "v".repeat(8193) } });
        let text = problem("terminal.open", env).expect("over the limit");
        assert!(text.ends_with(r#"at ["env"]["A"]"#), "{text}");
        let mut over =
            json!({ "resource": { "_tag": "attachment", "attachmentId": "a".repeat(257) } });
        assert!(matches!(
            check("assets.createUrl", &mut over),
            Err(Failure::Die(_))
        ));
        let blank = problem("pullRequests.update", json!({"title":"\u{feff} \u{feff}"}))
            .expect("blank after trimming");
        assert_eq!(blank, r#"expected a non-blank string at ["title"]"#);
    }

    #[test]
    fn a_method_without_limits_passes_and_wrong_types_are_left_to_decode() {
        assert!(check("server.probe", &mut json!({ "x": "y".repeat(100_000) })).is_ok());
        assert!(check("terminal.open", &mut json!({ "cols": "wide", "env": 3 })).is_ok());
    }
}
