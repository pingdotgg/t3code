//! HTML attachment references released by thread deletion, including deleted fork sources.

use std::collections::HashSet;

use serde_json::Value;

use crate::store::{StoreResult, Tx};

pub(crate) fn plan(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Vec<(String, String)>> {
    let mut retained = HashSet::new();
    let mut candidates = HashSet::new();
    tx.html_cleanup_items(thread_id, |owner, item, shown| {
        if let Some(id) = attachment_id(&item) {
            let key = (owner, id);
            if shown {
                retained.insert(key);
            } else {
                candidates.insert(key);
            }
        }
    })?;
    let mut ids: Vec<_> = candidates.difference(&retained).cloned().collect();
    ids.sort();
    Ok(ids)
}

#[derive(Default)]
struct Budget {
    bytes: usize,
    nodes: usize,
    exceeded: bool,
}

struct Envelope {
    data: Option<Value>,
    failed: bool,
}

fn read(value: &Value, budget: &mut Budget, depth: usize) -> Envelope {
    let empty = || Envelope {
        data: None,
        failed: false,
    };
    if depth > 4 || budget.nodes >= 128 {
        budget.exceeded = true;
        return empty();
    }
    budget.nodes += 1;
    match value {
        Value::String(text) => {
            budget.bytes = budget.bytes.saturating_add(text.len());
            if budget.bytes > 16_384 {
                budget.exceeded = true;
                return empty();
            }
            serde_json::from_str(text)
                .ok()
                .map_or_else(empty, |value| read(&value, budget, depth + 1))
        }
        Value::Array(blocks) => {
            if blocks.len() > 32 {
                budget.exceeded = true;
                return empty();
            }
            let mut result = empty();
            for block in blocks {
                let text = block.get("text").unwrap_or(&Value::Null);
                let next = read(text.get("text").unwrap_or(text), budget, depth + 1);
                result.data = result.data.or(next.data);
                result.failed |= next.failed;
                if budget.exceeded {
                    break;
                }
            }
            result
        }
        Value::Object(object) => {
            let failed = object.get("isError") == Some(&Value::Bool(true))
                || object.get("is_error") == Some(&Value::Bool(true))
                || object.get("_tag").and_then(Value::as_str) == Some("OrchestratorMcpFailure")
                || object.get("error").is_some_and(|value| !value.is_null());
            let content = object
                .get("structuredContent")
                .filter(|v| !v.is_null())
                .or_else(|| object.get("content"));
            if let Some(content) = content {
                let next = read(content, budget, depth + 1);
                Envelope {
                    data: next.data,
                    failed: failed || next.failed,
                }
            } else {
                Envelope {
                    data: Some(value.clone()),
                    failed,
                }
            }
        }
        _ => empty(),
    }
}

fn is_html_tool(name: &str) -> bool {
    if name == "execute" {
        return true;
    }
    let name = name.trim();
    let name = name
        .rsplit_once(char::is_whitespace)
        .filter(|(_, suffix)| {
            suffix.eq_ignore_ascii_case("complete") || suffix.eq_ignore_ascii_case("completed")
        })
        .map_or(name, |(head, _)| head.trim_end());
    if name == "html_render" {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    if let Some(rest) = name.get(5..).filter(|_| lower.starts_with("mcp__"))
        && let Some((server, tool)) = rest.split_once("__")
    {
        return [
            "t3-code",
            "t3_code",
            "t3code",
            "t3-code-direct",
            "t3_code_direct",
        ]
        .contains(&server.to_ascii_lowercase().as_str())
            && tool == "html_render";
    }
    for prefix in [
        "t3-code-direct",
        "t3_code_direct",
        "t3_code-direct",
        "t3-code_direct",
        "t3-code",
        "t3_code",
        "t3code",
    ] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let suffix = name.get(name.len() - rest.len()..).unwrap_or_default();
            if suffix
                .strip_prefix(['.', ':', '/'])
                .is_some_and(|s| s == "html_render")
                || suffix.split_once('·').is_some_and(|(before, after)| {
                    before.trim().is_empty() && after.trim_start() == "html_render"
                })
            {
                return true;
            }
        }
    }
    let rest = lower
        .strip_prefix("mcp")
        .and_then(|s| {
            let count = s
                .bytes()
                .take(2)
                .take_while(|c| matches!(c, b'-' | b'_'))
                .count();
            (count > 0).then(|| s.get(count..)).flatten()
        })
        .unwrap_or(&lower);
    for prefix in ["t3-code", "t3_code", "t3 code", "t3code"] {
        if let Some(suffix) = rest.strip_prefix(prefix) {
            let original = name.get(name.len() - suffix.len()..).unwrap_or_default();
            if original.strip_prefix("__") == Some("html_render")
                || original.strip_prefix(['-', '_', '.', ':', '/', ' ']) == Some("html_render")
            {
                return true;
            }
        }
    }
    lower.starts_with("t3-code-") && name.ends_with("_html_render")
}

fn attachment_id(item: &Value) -> Option<String> {
    if !is_html_tool(item.get("toolName")?.as_str()?) {
        return None;
    }
    let mut budget = Budget::default();
    let result = read(item.get("output")?, &mut budget, 0);
    if result.failed || budget.exceeded {
        return None;
    }
    let data = result.data?;
    let reference = data.get("htmlRender")?;
    let id = reference.get("attachmentId")?.as_str()?;
    if id.is_empty()
        || id.encode_utf16().count() > 256
        || !reference.get("title")?.is_string()
        || !reference.get("height")?.as_f64()?.is_finite()
    {
        return None;
    }
    Some(id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Draft, Store};
    use serde_json::json;

    #[test]
    fn reads_the_same_html_references_as_t3() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("html-cleanup-cases.json")).unwrap();
        for case in cases {
            assert_eq!(
                attachment_id(&case["item"]),
                case["id"].as_str().map(str::to_owned),
                "{}",
                case["item"]
            );
        }
    }

    #[test]
    fn deletion_preserves_visible_source_runs_until_the_last_fork_leaves() {
        let dir = std::env::temp_dir().join(format!("conn-html-forks-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let mut tx = store.tx().unwrap();
        let thread = |id: &str, parent: Option<&str>, deleted: bool, side: bool| {
            let forked =
                parent.map(|p| json!({"type":"run", "threadId":p, "runId":format!("{p}-run1")}));
            Draft::new(
                id,
                if deleted {
                    "thread.deleted"
                } else {
                    "thread.updated"
                },
                json!({"id":id, "projectId":"p", "createdAt":"2026-01-01T00:00:00.000Z", "updatedAt":"2026-01-01T00:00:00.000Z", "deletedAt": if deleted {json!("2026-01-02T00:00:00.000Z")} else {Value::Null}, "forkedFrom":forked, "lineage":{"sideChat":side}}),
            )
        };
        for (owner, parent) in [
            ("source", None),
            ("fork", Some("source")),
            ("sibling", Some("source")),
            ("nested", Some("fork")),
        ] {
            tx.append(thread(owner, parent, false, false)).unwrap();
            if let Some(source) = parent {
                tx.append(Draft::new(owner, "context-transfer.created", json!({"id":format!("transfer-{owner}"), "type":"fork", "sourceThreadId":source, "targetThreadId":owner}))).unwrap();
            }
            for ordinal in [1, 2] {
                tx.append(Draft::new(owner, "run.created", json!({"id":format!("{owner}-run{ordinal}"), "ordinal":ordinal, "status":"completed"}))).unwrap();
            }
        }
        let item = |owner: &str, name: &str, run: Option<i64>, id: &str| {
            Draft::new(
                owner,
                "turn-item.updated",
                json!({"id":name, "runId":run.map(|r| format!("{owner}-run{r}")), "type":"dynamic_tool", "toolName":"html_render", "output":{"htmlRender":{"attachmentId":id, "title":"Page", "height":100}}}),
            )
        };
        for (name, run, id) in [
            ("early", None, "early"),
            ("shown", Some(1), "shown"),
            ("late", Some(2), "late"),
            ("duplicate", Some(2), "shown"),
        ] {
            tx.append(item("source", name, run, id)).unwrap();
        }
        tx.append(item("fork", "own", Some(1), "fork-page"))
            .unwrap();
        assert!(
            plan(&tx, "source").unwrap().is_empty(),
            "archiving keeps pages"
        );
        tx.append(thread("source", None, true, false)).unwrap();
        assert_eq!(
            plan(&tx, "source").unwrap(),
            [("source".into(), "late".into())]
        );
        tx.append(thread("fork", Some("source"), true, false))
            .unwrap();
        assert!(
            plan(&tx, "fork")
                .unwrap()
                .iter()
                .all(|(_, id)| id != "shown" && id != "fork-page"),
            "a nested fork keeps deleted ancestors visible"
        );
        tx.append(thread("nested", Some("fork"), true, false))
            .unwrap();
        assert_eq!(
            plan(&tx, "nested").unwrap(),
            [
                ("fork".into(), "fork-page".into()),
                ("source".into(), "late".into())
            ]
        );
        tx.append(thread("sibling", Some("source"), true, false))
            .unwrap();
        assert_eq!(
            plan(&tx, "sibling").unwrap(),
            [
                ("source".into(), "early".into()),
                ("source".into(), "late".into()),
                ("source".into(), "shown".into())
            ]
        );
        tx.append(thread("side", Some("source"), false, true))
            .unwrap();
        assert_eq!(
            plan(&tx, "source").unwrap().len(),
            3,
            "side chats do not retain history"
        );
        drop(tx);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
