//! HTML attachment references released by thread deletion, including deleted fork sources.

use std::collections::HashSet;

use crate::{
    store::{StoreResult, Tx},
    tool_output::html_render_from_tool_item,
};

pub(crate) fn plan(tx: &Tx<'_>, thread_id: &str) -> StoreResult<Vec<(String, String)>> {
    let mut retained = HashSet::new();
    let mut candidates = HashSet::new();
    tx.html_cleanup_items(thread_id, |owner, item, shown| {
        if let Some(reference) = html_render_from_tool_item(&item)
            && let Some(id) = reference.get("attachmentId").and_then(|id| id.as_str())
        {
            let key = (owner, id.to_owned());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Draft, Store};
    use serde_json::{Value, json};

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
