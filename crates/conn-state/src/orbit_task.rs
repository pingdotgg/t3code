//! The task an Orbit task-create tool call made, for the timeline's task card
//! (`packages/client-runtime/src/orbitGateway/taskReceipt.ts`).
//!
//! The gate is the tool's own name, never its title or its output text: a friendly title, or a
//! result that quotes a task, makes no card. Another tool's `orbitTask` (a task-show result keeps
//! its row the same way) makes none either.

use serde_json::{Map, Value};

/// The fields of a task row the card reads (`ORBIT_TASK_CARD_FIELDS`).
const CARD_FIELDS: [&str; 11] = [
    "id",
    "title",
    "status",
    "attention",
    "project",
    "workspace",
    "pull_request",
    "subtask_counts",
    "created_at",
    "updated_at",
    "last_activity_at",
];

/// How deep a result may wrap its row (a JSON string in a content block in a structured result).
const MAX_WRAPS: usize = 4;

/// Whether a tool is Orbit's task-create. Claude Code names it `mcp__orbit__task-create`; other
/// providers say `orbit.task-create` or `orbit:task_create`.
#[must_use]
pub fn is_orbit_task_create_tool(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix("mcp__").unwrap_or(&lower);
    let Some(rest) = rest.strip_prefix("orbit") else {
        return false;
    };
    let rest = match rest.strip_prefix("__") {
        Some(rest) => rest,
        None => {
            let trimmed = rest
                .trim_start_matches(|c: char| matches!(c, '.' | '/' | ':') || c.is_whitespace());
            if trimmed.len() == rest.len() {
                return false;
            }
            trimmed
        }
    };
    matches!(rest, "task-create" | "task_create")
}

/// The row of a task-create result, as a result may wrap it: the wire's compact `{ orbitTask }`,
/// the Gateway's `{ data }`, JSON text, or MCP content blocks.
fn unwrap_row(output: &Value, wraps: usize) -> Option<&Value> {
    if wraps > MAX_WRAPS {
        return None;
    }
    match output {
        Value::Object(record) => {
            if let Some(data) = record.get("data") {
                return Some(data);
            }
            if let Some(row) = record.get("orbitTask") {
                return Some(row);
            }
            let inner = record
                .get("structuredContent")
                .or_else(|| record.get("content"))?;
            unwrap_row(inner, wraps + 1)
        }
        _ => None,
    }
}

/// Parses JSON text a result carries, whole or inside its first content block. `unwrap_row` cannot
/// lend a row out of text it parses, so the caller reads that case through here.
fn parse_text(output: &Value, wraps: usize) -> Option<Value> {
    if wraps > MAX_WRAPS {
        return None;
    }
    match output {
        Value::String(text) => serde_json::from_str(text).ok(),
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .find_map(|block| block.get("text").and_then(Value::as_str))?;
            serde_json::from_str(text).ok()
        }
        Value::Object(record) => {
            let inner = record
                .get("structuredContent")
                .or_else(|| record.get("content"))?;
            parse_text(inner, wraps + 1)
        }
        _ => None,
    }
}

/// A row Orbit could have made: a whole-number id, a title, a project slug and subtask counts
/// (`readOrbitTaskRow`), cut to the fields the card reads.
fn card_row(row: &Value) -> Option<Value> {
    let object = row.as_object()?;
    let whole_id = object.get("id").is_some_and(|id| {
        id.is_i64()
            || id.is_u64()
            || id
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
    });
    let has_slug = object
        .get("project")
        .and_then(|project| project.get("slug"))
        .is_some_and(Value::is_string);
    let has_counts = object
        .get("subtask_counts")
        .is_some_and(|counts| counts.is_object() || counts.is_array());
    if !whole_id || !object.get("title").is_some_and(Value::is_string) || !has_slug || !has_counts {
        return None;
    }
    let card: Map<String, Value> = CARD_FIELDS
        .iter()
        .filter_map(|key| {
            object
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect();
    Some(Value::Object(card))
}

/// The task row a task-create tool call made, or `None` for any other tool, a failed call, or a
/// result that holds no task. `output` is the tool item's output as the server wrote it.
#[must_use]
pub fn orbit_task_create_row(tool_name: &str, output: &Value) -> Option<Value> {
    if !is_orbit_task_create_tool(tool_name) {
        return None;
    }
    if output.get("isError").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if let Some(row) = unwrap_row(output, 0) {
        return card_row(row);
    }
    let parsed = parse_text(output, 0)?;
    card_row(unwrap_row(&parsed, 0)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> Value {
        json!({
            "id": 5753,
            "title": "Executor slice 4",
            "status": "todo",
            "attention": null,
            "project": { "id": 78, "slug": "orbit", "name": "Orbit", "code": "ORB" },
            "workspace": null,
            "pull_request": null,
            "subtask_counts": { "total": 3, "todo": 3, "running": 0, "completed": 0, "failed": 0, "cancelled": 0 },
            "created_at": "2026-11-17T11:30:00+00:00",
            "updated_at": "2026-11-17T11:30:00+00:00",
            "last_activity_at": null,
        })
    }

    #[test]
    fn every_provider_spelling_of_the_create_tool_reads() {
        let compact = json!({ "orbitTask": row() });
        for name in [
            "mcp__orbit__task-create",
            "orbit.task-create",
            " orbit:task_create ",
        ] {
            assert_eq!(
                orbit_task_create_row(name, &compact).and_then(|r| r["id"].as_i64()),
                Some(5753),
                "{name}"
            );
        }
    }

    #[test]
    fn the_result_unwraps_from_every_shape_the_wire_has() {
        let body = json!({ "data": row() });
        let text = body.to_string();
        let shapes = [
            body.clone(),
            Value::String(text.clone()),
            json!([{ "type": "text", "text": text }]),
            json!({ "structuredContent": body }),
            json!({ "orbitTask": row() }),
            json!({ "content": [{ "type": "text", "text": text }] }),
        ];
        for shape in shapes {
            let found = orbit_task_create_row("mcp__orbit__task-create", &shape)
                .unwrap_or_else(|| panic!("{shape}"));
            assert_eq!(found["title"], "Executor slice 4");
            assert_eq!(found["subtask_counts"]["total"], 3);
        }
    }

    #[test]
    fn only_task_create_makes_a_card() {
        let compact = json!({ "orbitTask": row() });
        for name in [
            "mcp__orbit__task-show",
            "mcp__orbit__task-list",
            "Create a task",
            "orbit",
            "",
        ] {
            assert!(orbit_task_create_row(name, &compact).is_none(), "{name:?}");
        }
    }

    #[test]
    fn a_failed_or_empty_result_makes_no_card() {
        let name = "mcp__orbit__task-create";
        let mut failed = json!({ "orbitTask": row() });
        failed["isError"] = json!(true);
        assert!(orbit_task_create_row(name, &failed).is_none());
        assert!(orbit_task_create_row(name, &json!("not json")).is_none());
        assert!(orbit_task_create_row(name, &json!({ "data": {} })).is_none());
        assert!(orbit_task_create_row(name, &json!({ "sentMessage": "hi" })).is_none());
    }

    #[test]
    fn text_that_merely_quotes_a_task_makes_no_card() {
        let quoted =
            json!({ "content": [{ "type": "text", "text": "Created {\"orbitTask\": 1}" }] });
        assert!(orbit_task_create_row("mcp__orbit__task-create", &quoted).is_none());
    }

    #[test]
    fn the_row_is_cut_to_the_card_fields() {
        let mut wide = row();
        wide["brief"] = json!("a long brief the card never shows");
        let found = orbit_task_create_row("orbit.task-create", &json!({ "data": wide }));
        assert_eq!(found, Some(row()));
    }
}
