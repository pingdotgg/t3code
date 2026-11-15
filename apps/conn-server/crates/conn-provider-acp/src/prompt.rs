//! The text T3 sends with an ACP prompt: `t3AcpPromptWithInstructions` around the user's
//! message and the runtime notes of `buildRuntimeInstructions`, from the generated texts in
//! [`crate::instructions`].

use crate::instructions::{
    PROMPT_PREFIXES, PROMPT_SUFFIX, RUNTIME_AFTER_HARNESS, RUNTIME_AFTER_MODEL,
    RUNTIME_BEFORE_HARNESS,
};

/// `T3AcpInstructionState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InstructionState {
    pub plan_mode: bool,
    pub has_t3_mcp: bool,
    pub has_device_tools: bool,
}

/// `t3AcpPromptWithInstructions`.
pub(crate) fn wrap(
    prompt: &str,
    state: InstructionState,
    previous: Option<InstructionState>,
) -> String {
    if prompt.trim_start().starts_with('/') || previous == Some(state) {
        return prompt.to_owned();
    }
    // Device tools only count with the MCP server, as in the TS list.
    let device = state.has_t3_mcp && state.has_device_tools;
    let prefix = PROMPT_PREFIXES
        .iter()
        .find(|(plan, mcp, dev, _)| {
            *plan == state.plan_mode && *mcp == state.has_t3_mcp && *dev == device
        })
        .map_or("", |entry| entry.3);
    format!("{prefix}{prompt}{PROMPT_SUFFIX}")
}

fn single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `buildRuntimeInstructions({ harness, model })` with pull request linking.
pub(crate) fn runtime_instructions(harness: &str, model: &str) -> String {
    let harness = single_line(harness);
    let model = single_line(model);
    let model_info = if !model.is_empty() && model != "auto" && model != "default" {
        format!(", as {model}")
    } else {
        String::new()
    };
    format!(
        "{RUNTIME_BEFORE_HARNESS}{harness}{RUNTIME_AFTER_HARNESS}{model_info}{RUNTIME_AFTER_MODEL}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn samples() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/instructions.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn state(value: &Value) -> InstructionState {
        InstructionState {
            plan_mode: value["interactionMode"] == "plan",
            has_t3_mcp: value["hasT3Mcp"] == true,
            has_device_tools: value["hasDeviceTools"] == true,
        }
    }

    #[test]
    fn matches_the_ts_functions() {
        let samples = samples();
        for case in samples["prompts"].as_array().unwrap() {
            let previous = case.get("previousState").map(state);
            assert_eq!(
                wrap(
                    case["prompt"].as_str().unwrap(),
                    state(&case["state"]),
                    previous
                ),
                case["text"].as_str().unwrap(),
                "prompt {case}"
            );
        }
        for case in samples["runtime"].as_array().unwrap() {
            assert_eq!(
                runtime_instructions(
                    case["harness"].as_str().unwrap(),
                    case["model"].as_str().unwrap()
                ),
                case["text"].as_str().unwrap(),
                "runtime {}",
                case["model"]
            );
        }
    }
}
