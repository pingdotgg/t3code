//! The `orchestration.*` reads beyond snapshots and streams: titles, families, archived and
//! older-settled shells, search, single turn items, worktree occupants.
//!
//! Each read runs one short query on the database thread and builds only its answer. Shell rows
//! come from the stored `threads.shell` column, so no read rebuilds a projection.

use std::collections::BTreeMap;

use rusqlite::params;
use serde_json::{Value, json};

use crate::store::{Store, StoreResult};
use crate::time::millis_from_iso;

/// `NEWEST_SETTLED_KEPT` in `ShellStream.ts`: the settled threads a bounded shell keeps.
const NEWEST_SETTLED_KEPT: usize = 25;
/// `searchThreads` scans at most this many newest messages, so one search cannot hold the
/// database thread for long.
const SEARCH_SCAN_LIMIT: i64 = 20_000;
const SNIPPET_CHARS: usize = 240;

fn listed(row: &Value) -> bool {
    row["lineage"]["relationshipToParent"] != "subagent" && row["lineage"]["sideChat"] != true
}

fn settled_millis(row: &Value) -> Option<i64> {
    if row["settledOverride"] != "settled" {
        return None;
    }
    row["settledAt"].as_str().and_then(millis_from_iso)
}

/// `isOlderSettledThreadShell`: listed, settled before `before`.
fn older_settled(row: &Value, before: i64) -> bool {
    listed(row) && settled_millis(row).is_some_and(|at| at < before)
}

/// The settle time below which a thread is "older settled": the 25th newest settle time of
/// listed threads, or `None` with fewer than 25.
fn older_settled_cut(rows: &[Value]) -> Option<i64> {
    let mut times: Vec<i64> = rows
        .iter()
        .filter(|row| listed(row))
        .filter_map(settled_millis)
        .collect();
    if times.len() < NEWEST_SETTLED_KEPT {
        return None;
    }
    times.sort_unstable_by(|a, b| b.cmp(a));
    Some(times[NEWEST_SETTLED_KEPT - 1])
}

/// A live subagent row stays in a shell that omits idle subagents (`isLiveSubagentShell`).
fn live_subagent(row: &Value) -> bool {
    !row["activityRunStatus"].is_null()
        || matches!(
            row["status"].as_str(),
            Some("queued" | "preparing" | "starting" | "running" | "waiting")
        )
        || !row["pendingRuntimeRequest"].is_null()
        || row["pendingBackgroundTasks"]
            .as_array()
            .is_some_and(|tasks| !tasks.is_empty())
}

impl Store {
    /// The shell snapshot with the client's opt-ins (`omitIdleSubagents`, `omitOlderSettled`):
    /// idle subagent rows and older settled rows stay out, as `ShellStream.ts` trims them.
    pub(crate) fn shell_snapshot_trimmed(
        &self,
        omit_idle: bool,
        omit_older: bool,
    ) -> StoreResult<Value> {
        let mut snapshot = self.shell_snapshot()?;
        if !omit_idle && !omit_older {
            return Ok(snapshot);
        }
        let rows: Vec<Value> = snapshot["threads"].as_array().cloned().unwrap_or_default();
        let parent_of_subagent: Vec<Value> = rows
            .iter()
            .filter(|r| r["lineage"]["relationshipToParent"] == "subagent")
            .map(|r| r["lineage"]["parentThreadId"].clone())
            .collect();
        let mut keep: Vec<Value> = rows.clone();
        if omit_idle {
            keep.retain(|r| {
                r["lineage"]["relationshipToParent"] != "subagent"
                    || live_subagent(r)
                    || parent_of_subagent.contains(&r["id"])
            });
        }
        if omit_older {
            let now = millis_from_iso(&crate::time::now_iso()).unwrap_or(0);
            let before = older_settled_cut(&rows).unwrap_or(now);
            let ancestors: Vec<Value> = rows
                .iter()
                .filter(|r| !listed(r))
                .flat_map(|r| {
                    [
                        r["lineage"]["parentThreadId"].clone(),
                        r["lineage"]["rootThreadId"].clone(),
                    ]
                })
                .collect();
            let mut counts: BTreeMap<String, u64> = BTreeMap::new();
            for row in rows.iter().filter(|r| older_settled(r, before)) {
                *counts
                    .entry(row["projectId"].as_str().unwrap_or("").to_owned())
                    .or_default() += 1;
            }
            keep.retain(|r| {
                !older_settled(r, before)
                    || !r["pinnedAt"].is_null()
                    || r["snoozedUntil"]
                        .as_str()
                        .and_then(millis_from_iso)
                        .is_some_and(|until| until > now)
                    || live_subagent(r)
                    || ancestors.contains(&r["id"])
            });
            let counts: Vec<Value> = counts
                .into_iter()
                .map(|(project_id, count)| json!({"projectId": project_id, "count": count}))
                .collect();
            snapshot["olderSettled"] = json!({
                "before": crate::time::iso_from_millis(before),
                "asOfSequence": snapshot["snapshotSequence"],
                "counts": counts,
            });
        }
        snapshot["threads"] = json!(keep);
        Ok(snapshot)
    }

    /// Shell rows of every thread that is not deleted, archived ones included.
    pub(crate) fn shell_rows(&self) -> StoreResult<Vec<Value>> {
        self.query_json(
            "SELECT shell FROM threads WHERE deleted = 0 AND shell IS NOT NULL ORDER BY rowid",
            [],
        )
    }

    fn thread_records(&self, ids: &[String]) -> StoreResult<Vec<Value>> {
        let mut out = Vec::new();
        for id in ids {
            out.extend(self.query_json(
                "SELECT thread FROM threads WHERE id = ?1 AND deleted = 0",
                [id],
            )?);
        }
        Ok(out)
    }

    pub(crate) fn thread_titles(&self, ids: &[String]) -> StoreResult<Value> {
        let mut out = serde_json::Map::new();
        for thread in self.thread_records(ids)? {
            if let Some(id) = thread["id"].as_str() {
                out.insert(id.to_owned(), thread["title"].clone());
            }
        }
        Ok(Value::Object(out))
    }

    pub(crate) fn thread_link_metadata(&self, ids: &[String]) -> StoreResult<Value> {
        let mut out = serde_json::Map::new();
        for thread in self.thread_records(ids)? {
            if let Some(id) = thread["id"].as_str() {
                out.insert(
                    id.to_owned(),
                    json!({"title": thread["title"], "projectId": thread["projectId"]}),
                );
            }
        }
        Ok(Value::Object(out))
    }

    /// Active (not archived) threads sharing the root of `thread_id`'s family.
    pub(crate) fn thread_family(&self, thread_id: &str) -> StoreResult<Value> {
        let root: Option<String> = self
            .query_json("SELECT thread FROM threads WHERE id = ?1", [thread_id])?
            .first()
            .and_then(|t| t["lineage"]["rootThreadId"].as_str().map(str::to_owned));
        let threads: Vec<Value> = match root {
            Some(root) => self
                .shell_rows()?
                .into_iter()
                .filter(|row| row["lineage"]["rootThreadId"] == root.as_str())
                .filter(|row| row["archivedAt"].is_null())
                .collect(),
            None => vec![],
        };
        Ok(json!({"snapshotSequence": self.high_water(), "threads": threads}))
    }

    pub(crate) fn archived_shell_snapshot(&self) -> StoreResult<Value> {
        let mut snapshot = self.shell_snapshot()?;
        let threads: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| !row["archivedAt"].is_null())
            .collect();
        snapshot["threads"] = json!(threads);
        if let Some(map) = snapshot.as_object_mut() {
            map.remove("archivedThreads");
        }
        Ok(snapshot)
    }

    pub(crate) fn worktree_thread_ids(&self, path: &str) -> StoreResult<Value> {
        let ids: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["worktreePath"] == path && row["archivedAt"].is_null())
            .map(|row| row["id"].clone())
            .collect();
        Ok(json!({"threadIds": ids}))
    }

    pub(crate) fn older_settled_threads(&self, input: &Value) -> StoreResult<Value> {
        let before = input["before"]["settledAt"]
            .as_str()
            .and_then(millis_from_iso)
            .unwrap_or(i64::MAX);
        let after_id = input["before"]["threadId"].as_str();
        let projects: Option<Vec<&str>> = input["projectIds"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect());
        let limit = input["limit"].as_u64().unwrap_or(0) as usize;
        let mut rows: Vec<(i64, Value)> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["archivedAt"].is_null() && listed(row))
            .filter(|row| {
                projects
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&row["projectId"].as_str().unwrap_or("")))
            })
            .filter_map(|row| settled_millis(&row).map(|at| (at, row)))
            .filter(|(at, row)| {
                *at < before
                    || (*at == before
                        && after_id.is_some_and(|id| row["id"].as_str().unwrap_or("") > id))
            })
            .collect();
        rows.sort_by(|(a, ra), (b, rb)| {
            b.cmp(a)
                .then_with(|| ra["id"].as_str().cmp(&rb["id"].as_str()))
        });
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        if limit == 0 {
            for (_, row) in &rows {
                *counts
                    .entry(row["projectId"].as_str().unwrap_or("").to_owned())
                    .or_default() += 1;
            }
        }
        let threads: Vec<Value> = rows.into_iter().take(limit).map(|(_, row)| row).collect();
        let counts: Vec<Value> = counts
            .into_iter()
            .map(|(project_id, count)| json!({"projectId": project_id, "count": count}))
            .collect();
        Ok(json!({"snapshotSequence": self.high_water(), "threads": threads, "counts": counts}))
    }

    pub(crate) fn turn_item(&self, thread_id: &str, item_id: &str) -> StoreResult<Option<Value>> {
        Ok(self
            .query_json(
                "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems' AND id = ?2",
                params![thread_id, item_id],
            )?
            .into_iter()
            .next())
    }

    /// `searchThreads`: newest messages whose text contains the query (case-insensitive), one
    /// match per thread, newest first. Titles are the client's to match.
    pub(crate) fn search_threads(&self, input: &Value) -> StoreResult<Value> {
        let query = input["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let limit = input["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
        let needle = query.to_lowercase();
        let shells: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["archivedAt"].is_null() && listed(row))
            .collect();
        let project_of = |thread_id: &str| {
            shells
                .iter()
                .find(|row| row["id"] == thread_id)
                .map(|row| row["projectId"].clone())
        };
        let mut matches: Vec<Value> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        // Messages only, as `ThreadSearch.ts`: the client matches titles itself, and
        // `titlesOnly` asks for no message search at all.
        if input["titlesOnly"] != true {
            let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
            // Trigram FTS answers LIKE for three or more characters; shorter queries scan the
            // newest messages only.
            let sql = if query.chars().count() >= 3 {
                "SELECT k.thread_id, e.body FROM message_search s
                 JOIN message_keys k ON k.id = s.rowid
                 JOIN entities e ON e.thread_id = k.thread_id AND e.kind = 'messages' AND e.id = k.message_id
                 WHERE s.text LIKE ?1 ESCAPE '\\' ORDER BY e.seq DESC LIMIT ?2"
            } else {
                "SELECT thread_id, body FROM (
                   SELECT thread_id, body, seq FROM entities WHERE kind = 'messages'
                   ORDER BY seq DESC LIMIT ?2)
                 WHERE json_extract(body, '$.text') LIKE ?1 ESCAPE '\\' ORDER BY seq DESC"
            };
            let rows = self.query_rows(sql, params![pattern, SEARCH_SCAN_LIMIT])?;
            for (thread_id, message) in rows {
                if matches.len() >= limit {
                    break;
                }
                if seen.contains(&thread_id) {
                    continue;
                }
                let Some(project_id) = project_of(&thread_id) else {
                    continue;
                };
                let text = message["text"].as_str().unwrap_or_default();
                matches.push(json!({
                    "threadId": thread_id,
                    "projectId": project_id,
                    "source": if message["role"] == "user" { "user" } else { "assistant" },
                    "snippet": snippet(text, &needle),
                    "messageCreatedAt": message["createdAt"],
                    "messageId": message["id"],
                }));
                seen.push(thread_id);
            }
        }
        Ok(json!({"matches": matches}))
    }

    /// In-thread find (`ThreadFind.ts`): occurrences of the query in the thread's user and
    /// assistant messages and plans, in transcript order.
    pub(crate) fn search_thread(&self, input: &Value) -> StoreResult<Value> {
        let thread_id = input["threadId"].as_str().unwrap_or_default();
        let needle = input["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let mut items = self.query_json(
            "SELECT body FROM entities WHERE thread_id = ?1 AND kind = 'turnItems'
             AND json_extract(body, '$.type') IN ('user_message', 'assistant_message', 'proposed_plan')
             ORDER BY ordinal",
            [thread_id],
        )?;
        items.retain(|item| item["status"] != "pending");
        let documents: Vec<(Value, Value, u64)> = items
            .iter()
            .map(|item| {
                let text = item["text"]
                    .as_str()
                    .or(item["markdown"].as_str())
                    .unwrap_or("");
                let entry = if item["type"] == "proposed_plan" {
                    item["id"].clone()
                } else {
                    item["messageId"].clone()
                };
                (
                    entry,
                    item["runId"].clone(),
                    count_occurrences(text, &needle),
                )
            })
            .collect();
        let total: u64 = documents.iter().map(|d| d.2).sum();
        let mut requested = input["index"].as_u64().unwrap_or(0);
        if input.get("index").is_none()
            && let Some(start) = input.get("start")
            && let Some(pos) = documents.iter().position(|d| d.0 == start["entryId"])
        {
            requested = documents[..pos].iter().map(|d| d.2).sum::<u64>()
                + start["occurrence"]
                    .as_u64()
                    .unwrap_or(0)
                    .min(documents[pos].2);
            if requested >= total {
                requested = 0;
            }
        }
        let active = if input.get("index").is_none() && total > 0 {
            let offset = input["offset"].as_i64().unwrap_or(0);
            (requested as i64 + offset).rem_euclid(total as i64) as u64
        } else {
            requested.min(total.saturating_sub(1))
        };
        let mut occurrence = active;
        let mut selected = None;
        for document in &documents {
            if occurrence < document.2 {
                selected = Some(document);
                break;
            }
            occurrence -= document.2;
        }
        let mut start_index = 0;
        let entries: Vec<Value> = documents
            .iter()
            .filter_map(|(entry, run, count)| {
                let row = json!({"entryId": entry, "runId": run, "startIndex": start_index, "count": count});
                start_index += count;
                (*count > 0).then_some(row)
            })
            .collect();
        let navigation: Vec<Value> = if entries.len() <= 17 {
            entries
        } else {
            let at = selected
                .and_then(|s| entries.iter().position(|e| e["entryId"] == s.0))
                .map_or(-1, |p| p as i64);
            let n = entries.len() as i64;
            (0..17)
                .map(|i| entries[(at + i - 8).rem_euclid(n) as usize].clone())
                .collect()
        };
        Ok(json!({
            "complete": true,
            "snapshotSequence": self.high_water(),
            "totalMatches": total,
            "activeIndex": active,
            "navigation": navigation,
            "match": selected.map(|(entry, run, _)| json!({"entryId": entry, "runId": run, "occurrence": occurrence})),
        }))
    }
}

fn count_occurrences(text: &str, needle: &str) -> u64 {
    if needle.is_empty() {
        return 0;
    }
    text.to_lowercase().matches(needle).count() as u64
}

/// Up to 240 characters around the first match.
///
/// Lowercasing can make a character longer (`İ` becomes two characters), so the match is found
/// in a lowercase copy that records, for each of its bytes, the original character it came from.
fn snippet(text: &str, needle: &str) -> String {
    let mut lower = String::with_capacity(text.len());
    let mut origin: Vec<usize> = Vec::with_capacity(text.len());
    for (index, c) in text.chars().enumerate() {
        let before = lower.len();
        lower.extend(c.to_lowercase());
        origin.resize(origin.len() + (lower.len() - before), index);
    }
    let at = lower
        .find(needle)
        .and_then(|byte| origin.get(byte).copied())
        .unwrap_or(0);
    let start = at.saturating_sub(SNIPPET_CHARS / 3);
    text.chars()
        .skip(start)
        .take(SNIPPET_CHARS)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `İ` (U+0130) lowercases to two characters, so a lowercase index is not an index into
    /// the original text. Before the fix this panicked (`range start index 320 out of range`).
    #[test]
    fn snippet_survives_lowercase_expansion() {
        let text = format!("{}abc tail", "İ".repeat(200));
        let got = snippet(&text, "abc");
        assert!(got.contains("abc tail"), "{got}");
        assert!(got.starts_with('İ'), "{got}");
        // The match sits 80 characters into the snippet, as for plain text.
        assert_eq!(got.chars().position(|c| c == 'a'), Some(SNIPPET_CHARS / 3));
    }

    #[test]
    fn snippet_handles_every_expanding_position() {
        for before in 0..300 {
            let text = format!("{}needle{}", "İ".repeat(before), "İ".repeat(before));
            assert!(snippet(&text, "needle").contains("needle"));
            assert!(snippet(&text, "absent").chars().count() <= SNIPPET_CHARS);
            assert_eq!(count_occurrences(&text, "needle"), 1);
        }
    }
}
