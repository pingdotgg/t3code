//! The T3 text a Codex turn carries in `additionalContext` when the thread has T3's MCP
//! server: `buildCodexAdditionalContext` (`CodexDeveloperInstructions.ts`) and
//! `buildRuntimeInstructions` (`runtimeInstructions.ts`). The fixed texts are generated from
//! the monorepo into [`crate::instructions`]; `tests` compares the built values with what the
//! TS functions return (`testdata/instructions.json`).

use serde_json::{Map, Value, json};

use crate::instructions::{
    BROWSER_TOOLS, DEVICE_TOOLS, ORCHESTRATION_SECTIONS, PULL_REQUEST_LINKING,
};

/// `T3CodeToolAvailability`: which T3 tool families the thread can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolAvailability {
    pub browser: bool,
    pub device: bool,
}

impl Default for ToolAvailability {
    /// What TS assumes without an MCP session's own answer: browser tools on, devices off.
    fn default() -> Self {
        Self {
            browser: true,
            device: false,
        }
    }
}

/// `toSingleLine`: runs of whitespace become one space; the ends are trimmed.
fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `buildRuntimeInstructions({ harness, model, reasoningEffort })` with the pull request
/// linking block.
pub fn runtime_instructions(harness: &str, model: &str, effort: Option<&str>) -> String {
    let harness = single_line(harness);
    let model = single_line(model);
    let effort = single_line(effort.unwrap_or(""));
    let model_info = if !model.is_empty() && model != "auto" && model != "default" {
        format!(", as {model}")
    } else {
        String::new()
    };
    let effort_info = if effort.is_empty() {
        String::new()
    } else {
        format!(" with {effort} reasoning effort")
    };
    format!(
        "<runtime_info>In case you're asked: you are running in T3 Code through the {harness} harness{model_info}{effort_info}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in T3 Code's files viewer.</runtime_info>\n\n{PULL_REQUEST_LINKING}"
    )
}

/// `buildCodexAdditionalContext`: numbered orchestration sections, the runtime line, and the
/// tool texts for the available tools. Keys sort in the order Codex must emit them.
pub fn additional_context(model: &str, effort: Option<&str>, tools: ToolAvailability) -> Value {
    let entry = |value: &str| json!({ "kind": "application", "value": value });
    let mut context = Map::new();
    for (index, section) in ORCHESTRATION_SECTIONS.iter().enumerate() {
        context.insert(
            format!("t3_code_orchestration_{:02}", index + 1),
            entry(section),
        );
    }
    context.insert(
        "t3_code_runtime".into(),
        entry(&runtime_instructions("Codex", model, effort)),
    );
    let tool_text = [
        tools.browser.then_some(BROWSER_TOOLS),
        tools.device.then_some(DEVICE_TOOLS),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    if !tool_text.is_empty() {
        context.insert("t3_code_tools".into(), entry(&tool_text));
    }
    Value::Object(context)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every case `tools/gen-instructions.mjs` ran through the TS function.
    #[test]
    fn matches_the_ts_builder_byte_for_byte() {
        let samples: Vec<Value> =
            serde_json::from_str(include_str!("../testdata/instructions.json")).unwrap();
        assert!(!samples.is_empty());
        for sample in samples {
            let runtime = &sample["runtime"];
            let tools = match &sample["tools"] {
                Value::Bool(b) => ToolAvailability {
                    browser: *b,
                    device: false,
                },
                t => ToolAvailability {
                    browser: t["browser"] == true,
                    device: t["device"] == true,
                },
            };
            let built = additional_context(
                runtime["model"].as_str().unwrap(),
                runtime["reasoningEffort"].as_str(),
                tools,
            );
            assert_eq!(built, sample["context"], "case {runtime}");
        }
    }
}
