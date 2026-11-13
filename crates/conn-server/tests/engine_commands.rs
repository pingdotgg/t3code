//! Every command type the engine handles still exists in the contract.
//!
//! The engine dispatches commands on their `type` string (`conn-engine/src/commands.rs`,
//! `fn handler`), so a command that upstream renames or removes would stay handled under a
//! dead name without a compile error. This test reads the handled types from that match and
//! asks the generated contract union about each one. The match stays non-exhaustive on
//! purpose: a new upstream command is refused until the engine serves it, and
//! `tools/bump-report.mjs` lists it.

use conn_contract::OrchestrationV2Command;
use serde_json::json;

const COMMANDS_RS: &str = include_str!("../../conn-engine/src/commands.rs");

/// The string patterns of the `match command_type` in `fn handler`.
fn handled_types() -> Vec<String> {
    let start = COMMANDS_RS
        .find("fn handler(command_type: &str)")
        .expect("fn handler in conn-engine/src/commands.rs");
    let body = &COMMANDS_RS[start..];
    let end = body
        .find("_ => return None")
        .expect("the fallback arm of fn handler");
    let mut types = Vec::new();
    for line in body[..end].lines() {
        let Some((patterns, _)) = line.split_once("=>") else {
            // A pattern that wraps onto the next line keeps its `|` at the start.
            if line.trim_start().starts_with('"') || line.trim_start().starts_with('|') {
                types.extend(literals(line));
            }
            continue;
        };
        types.extend(literals(patterns));
    }
    types
}

fn literals(text: &str) -> Vec<String> {
    text.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

#[test]
fn every_handled_command_type_is_in_the_contract() {
    let handled = handled_types();
    assert!(handled.len() > 30, "parsed only {handled:?}");
    let mut gone = Vec::new();
    for command_type in &handled {
        // A known type fails on its missing fields; an unknown one fails on the tag.
        let error =
            serde_json::from_value::<OrchestrationV2Command>(json!({ "type": command_type }))
                .expect_err("an empty command never decodes")
                .to_string();
        if error.contains("unknown `type`") {
            gone.push(command_type.as_str());
        }
    }
    assert!(
        gone.is_empty(),
        "the engine handles command types the contract no longer has: {gone:?}"
    );
}

#[test]
fn an_unknown_command_type_is_told_apart() {
    let error = serde_json::from_value::<OrchestrationV2Command>(json!({ "type": "no.such" }))
        .expect_err("unknown")
        .to_string();
    assert!(error.contains("unknown `type`"), "{error}");
}
