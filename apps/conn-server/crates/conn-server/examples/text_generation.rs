//! Runs this server's text generation code on cases for `tools/textgen-diff.mjs`, which runs
//! the T3 server's own functions on the same cases and compares. One JSON case per stdin line,
//! one JSON answer per stdout line (`{"ok": …}` or `{"err": "…"}`). Model APIs are the tool's
//! loopback stub; the state folder is a temp folder.
//!
//! Cases: `listModels` (settings, input), `title` (settings, request), `prompt` (input),
//! `context` (messages), `sanitize` (raw), `sort` (ids).

use std::{
    io::{BufRead, Write},
    sync::Arc,
};

use conn_engine::{TitleKind, TitleMessage, TitleRequest};
use conn_server::text_generation::{
    TextGenerators, js,
    prompts::{self, Attachment, Message, TitlePromptInput},
    review_guide,
    title::Titles,
};
use serde_json::{Map, Value, json};

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn attachment(value: &Value) -> Attachment {
    Attachment {
        id: text(value, "id"),
        name: text(value, "name"),
        mime_type: text(value, "mimeType"),
        size_bytes: value.get("sizeBytes").cloned().unwrap_or(Value::Null),
    }
}

fn attachments(value: &Value) -> Vec<Attachment> {
    value
        .as_array()
        .map(|list| list.iter().map(attachment).collect())
        .unwrap_or_default()
}

fn attachment_json(a: &Attachment) -> Value {
    json!({"id": a.id, "name": a.name, "mimeType": a.mime_type, "sizeBytes": a.size_bytes})
}

fn title_message(value: &Value) -> TitleMessage {
    TitleMessage {
        role: text(value, "role"),
        text: text(value, "text"),
        attachments: value
            .get("attachments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    }
}

fn generators(settings: &Value, state_dir: &std::path::Path) -> Arc<TextGenerators> {
    let settings: Map<String, Value> = settings.as_object().cloned().unwrap_or_default();
    let _ = state_dir;
    Arc::new(TextGenerators::new(move || settings.clone()))
}

async fn answer(case: &Value, state_dir: &std::path::Path) -> Result<Value, String> {
    let op = text(case, "op");
    match op.as_str() {
        "listModels" => {
            let input =
                conn_contract::from_json(case["input"].clone()).map_err(|e| e.to_string())?;
            let result = generators(&case["settings"], state_dir)
                .list_models(input)
                .await?;
            Ok(conn_contract::to_json(&result))
        }
        "title" => {
            let request = &case["request"];
            let kind = match request.get("previousTitle").and_then(Value::as_str) {
                Some(previous) => TitleKind::Regenerate {
                    previous_title: previous.to_owned(),
                    messages: request["messages"]
                        .as_array()
                        .map(|m| m.iter().map(title_message).collect())
                        .unwrap_or_default(),
                },
                None => TitleKind::Initial {
                    message: title_message(&request["message"]),
                },
            };
            let titles = Titles::new(generators(&case["settings"], state_dir));
            let title = titles
                .title(TitleRequest {
                    thread_id: "thread".into(),
                    project_id: request
                        .get("projectId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    cwd: None,
                    project_title: request
                        .get("projectTitle")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    kind,
                })
                .await?;
            Ok(json!(title))
        }
        "commitPrompt" => {
            let input = &case["input"];
            Ok(json!(prompts::commit_message_prompt(
                input.get("branch").and_then(Value::as_str),
                &text(input, "stagedSummary"),
                &text(input, "stagedPatch"),
                &text(input, "policy"),
                input.get("includeBranch") == Some(&Value::Bool(true))
            )))
        }
        "prompt" => {
            let input = &case["input"];
            let prompt = prompts::thread_title_prompt(&TitlePromptInput {
                message: text(input, "message"),
                project_title: input
                    .get("projectTitle")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                previous_title: input
                    .get("previousTitle")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                attachments: attachments(&input["attachments"]),
                instructions: input
                    .get("instructions")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
            Ok(json!(prompt))
        }
        "context" => {
            let messages: Vec<Message> = case["messages"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|m| Message {
                            role: text(m, "role"),
                            text: text(m, "text"),
                            attachments: attachments(&m["attachments"]),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let (message, chosen) = prompts::format_thread_title_context(&messages);
            Ok(
                json!({"message": message, "attachments": chosen.iter().map(attachment_json).collect::<Vec<_>>()}),
            )
        }
        "sanitize" => Ok(json!(prompts::sanitize_thread_title(&text(case, "raw")))),
        "reviewGuidePrompt" => {
            let input = &case["input"];
            let stack = input["stack"]
                .as_array()
                .map(|layers| {
                    layers
                        .iter()
                        .map(|l| prompts::StackLayer {
                            number: l["number"].as_u64().unwrap_or(0),
                            title: l["title"].as_str().map(str::to_owned),
                            head_sha: l["headSha"].as_str().map(str::to_owned),
                            state: text(l, "state"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(json!(prompts::review_guide_prompt(
                &prompts::ReviewGuidePromptInput {
                    number: input["number"].as_u64().unwrap_or(0),
                    title: text(input, "title"),
                    description: text(input, "description"),
                    base_branch: text(input, "baseBranch"),
                    base_commit: text(input, "baseCommit"),
                    settled_review: text(input, "settledReview"),
                    instructions: input["instructions"].as_str().map(str::to_owned),
                    stack,
                }
            )))
        }
        "reviewGuideNormalize" => {
            let Some(guide) = review_guide::decode_generated(&case["guide"]) else {
                return Err("invalid structured output".into());
            };
            let change = review_guide::parse_change(&text(case, "nameOnly"), &text(case, "patch"));
            serde_json::to_value(review_guide::normalize(guide, &change)).map_err(|e| e.to_string())
        }
        "settledReview" => Ok(json!(review_guide::settled_review(&case["activity"]))),
        "sort" => {
            let mut ids: Vec<String> = case["ids"]
                .as_array()
                .map(|l| {
                    l.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            ids.sort_by(|a, b| js::locale_compare(a, b));
            Ok(json!(ids))
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let state_dir = std::env::temp_dir().join(format!("conn-textgen-probe-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&state_dir);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let out = match serde_json::from_str::<Value>(&line) {
            Ok(case) => match runtime.block_on(answer(&case, &state_dir)) {
                Ok(value) => json!({"ok": value}),
                Err(error) => json!({"err": error}),
            },
            Err(error) => json!({"err": format!("bad case: {error}")}),
        };
        let _ = writeln!(stdout, "{out}");
        let _ = stdout.flush();
    }
    let _ = std::fs::remove_dir_all(&state_dir);
}
