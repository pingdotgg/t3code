//! Read prompt markers and jump windows from the same visible rows as the timeline.
//! Both consume the compact covering index. Only the jump materializes message bodies.
use std::collections::{HashSet, VecDeque};

use conn_contract::ThreadOutlineMarker;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::{history, transcript::RowSink};

pub(crate) const CREATE_INDEX: &str = concat!(
    "CREATE INDEX IF NOT EXISTS thread_outline_rows ON entities(thread_id, ordinal, id, ",
    include_str!("outline_row.sql"),
    ") WHERE kind = 'turnItems'"
);
const ROWS: &str = concat!(
    "SELECT ",
    include_str!("outline_row.sql"),
    " FROM entities INDEXED BY thread_outline_rows WHERE thread_id = ?1 AND kind = 'turnItems' ORDER BY ordinal, id"
);

// The 24 closest rows on the left and at most 76 rows starting at the target.
// The rank uses only integer keys, keeping a history cursor valid after deletion.
pub(crate) const LOCAL_WINDOW: &str = concat!(
    "WITH target AS (SELECT ordinal,id FROM entities WHERE thread_id=?1 AND kind='turnItems' AND id=?2),
     before_target AS (SELECT ordinal,id FROM entities WHERE thread_id=?1 AND kind='turnItems'
       AND (ordinal,id) < (SELECT ordinal,id FROM target) ORDER BY ordinal DESC,id DESC LIMIT 24),
     from_target AS (SELECT ordinal,id FROM entities WHERE thread_id=?1 AND kind='turnItems'
       AND (ordinal,id) >= (SELECT ordinal,id FROM target) ORDER BY ordinal,id LIMIT 76),
     keys AS (SELECT * FROM before_target UNION ALL SELECT * FROM from_target)
     SELECT ", include_str!("outline_row.sql"), ",
       (SELECT count(*) FROM entities WHERE thread_id=?1 AND kind='turnItems' AND
        (ordinal,id) < (SELECT ordinal,id FROM keys ORDER BY ordinal,id LIMIT 1))
     FROM entities INDEXED BY thread_outline_rows WHERE thread_id=?1 AND kind='turnItems'
       AND (ordinal,id) IN (SELECT ordinal,id FROM keys) ORDER BY ordinal,id"
);

// Seek from the same stable turn-item key used by the timeline. Read one extra
// descriptor to determine whether another page exists, without reading its body.
pub(crate) const MESSAGE_PAGE: &str = concat!(
    "SELECT id, ordinal, descriptor ->> '$.bytes' FROM (SELECT id,ordinal,",
    include_str!("outline_row.sql"),
    " AS descriptor FROM entities INDEXED BY thread_outline_rows
     WHERE thread_id=?1 AND kind='turnItems' AND (ordinal,id) <= (?2,?3))
     WHERE (?4 OR id != ?3) AND descriptor ->> '$.type' IN ('assistant_message','user_message')
     ORDER BY ordinal DESC, id DESC LIMIT 101"
);

/// Fast path for local timelines that need no visibility filtering. A missing anchor
/// falls back to the normal cursor's position rule.
pub(crate) fn local_message_page(
    conn: &Connection,
    thread: &str,
    sequence: u64,
    cursor: &history::Cursor,
) -> rusqlite::Result<Option<history::Page>> {
    let ordinal: Option<i64> = conn
        .query_row(
            "SELECT ordinal FROM entities WHERE thread_id=? AND kind='turnItems' AND id=?",
            params![thread, cursor.source_item],
            |r| r.get(0),
        )
        .optional()?;
    let Some(ordinal) = ordinal else {
        return Ok(None);
    };
    let mut stmt = conn.prepare(MESSAGE_PAGE)?;
    let mut candidates = stmt.query(params![
        thread,
        ordinal,
        cursor.source_item,
        cursor.inclusive
    ])?;
    let mut rows = VecDeque::new();
    let mut bytes = 0_usize;
    let mut oldest_ordinal = ordinal;
    let mut has_more_history = false;
    while let Some(candidate) = candidates.next()? {
        let id: String = candidate.get(0)?;
        let row = json!({"visibility":"local","sourceThreadId":thread,"sourceItemId":id,"position":0,"item":null});
        let size = candidate
            .get::<_, usize>(2)?
            .saturating_add(row.to_string().len());
        if rows.len() == 100
            || (!rows.is_empty()
                && bytes.saturating_add(size) > history::PAGE_POLICY.max_encoded_bytes)
        {
            has_more_history = true;
            break;
        }
        bytes = bytes.saturating_add(size);
        oldest_ordinal = candidate.get(1)?;
        rows.push_front(row);
    }
    let mut next_cursor = None;
    if has_more_history && let Some(first) = rows.front_mut() {
        // Retain the absolute position for the normal cursor fallback if this item is deleted.
        let rank: u64 = conn.query_row(
            "SELECT count(*) FROM entities WHERE thread_id=? AND kind='turnItems' AND (ordinal,id) < (?,?)",
            params![thread,oldest_ordinal,first["sourceItemId"].as_str()], |r| r.get(0),
        )?;
        first["position"] = json!(rank);
        next_cursor = Some(history::encode_cursor(sequence, first));
    }
    Ok(Some(history::Page {
        rows: rows.into(),
        next_cursor,
        has_more_history,
    }))
}

pub(crate) struct Markers {
    pub(crate) markers: Vec<ThreadOutlineMarker>,
    previous_human: bool,
    checkpoint_runs: HashSet<String>,
}

impl Markers {
    pub(crate) fn new(checkpoint_runs: HashSet<String>) -> Self {
        Self {
            markers: Vec::new(),
            previous_human: false,
            checkpoint_runs,
        }
    }
}

impl RowSink for Markers {
    const ITEMS_SQL: &'static str = ROWS;

    fn has_room(&self, _: u64) -> bool {
        true
    }

    fn push(&mut self, visibility: &str, _: Value, _: Value, item: Value) -> Result<bool, String> {
        let kind = item["type"].as_str().unwrap_or_default();
        let status = item["status"].as_str().unwrap_or_default();
        if kind == "checkpoint"
            || item["hiddenPreparation"] == 1
            || (kind == "user_message"
                && item["inputIntent"] == "queued_turn"
                && status == "cancelled")
        {
            return Ok(true);
        }
        let queued =
            kind == "user_message" && item["inputIntent"] == "queued_turn" && status == "pending";
        let prompt = kind == "user_message" && !queued;
        let human = prompt && item["createdBy"] == "user";
        let text = item["text"].as_str().unwrap_or_default();
        if prompt && !(human && self.previous_human) {
            let preview = text
                .lines()
                .map(str::trim)
                .find(|s| !s.is_empty())
                .unwrap_or("Message");
            self.markers.push(ThreadOutlineMarker {
                entry_id: item["id"].as_str().ok_or("prompt missing id")?.to_owned(),
                preview: truncate(preview, 96),
                assistant_preview: None,
                is_agent_prompt: !human,
                has_checkpoint: false,
                has_error: false,
            });
        } else if !prompt
            && !queued
            && let Some(marker) = self.markers.last_mut()
        {
            if kind == "assistant_message" {
                let clean = text
                    .lines()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && !s.starts_with("```"))
                    .map(|s| {
                        s.trim_start_matches('#')
                            .trim_start_matches('-')
                            .trim_start_matches('*')
                            .trim()
                            .replace("**", "")
                            .replace('`', "")
                    })
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                if !clean.is_empty() {
                    marker.assistant_preview = Some(truncate(&clean, 160));
                }
            }
            let failed = matches!(status, "failed" | "cancelled" | "interrupted");
            marker.has_error |= match kind {
                "error" => true,
                "subagent" => status == "failed",
                "command_execution" => {
                    failed || (status == "completed" && item["commandFailed"] == 1)
                }
                "file_change" | "file_search" | "web_search" | "dynamic_tool" | "todo_list"
                | "approval_request" | "link_request" | "thread_created" => failed,
                _ => false,
            };
            marker.has_checkpoint |= visibility == "local"
                && item["runId"]
                    .as_str()
                    .is_some_and(|run| self.checkpoint_runs.contains(run));
        }
        self.previous_human = human;
        Ok(true)
    }
}

fn truncate(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

/// Keep at most 24 predecessors and 75 successors. Drop predecessors first when a
/// large target needs the byte budget. As with history paging, the target always fits alone.
pub(crate) struct JumpWindow<'a> {
    target: &'a str,
    found: bool,
    position: usize,
    bytes: usize,
    after: usize,
    rows: VecDeque<(Value, usize)>,
}

impl<'a> JumpWindow<'a> {
    pub(crate) fn new(target: &'a str, position: usize) -> Self {
        Self {
            target,
            found: false,
            position,
            after: 0,
            bytes: 0,
            rows: VecDeque::new(),
        }
    }

    pub(crate) fn finish(self, sequence: u64) -> Option<history::Page> {
        if !self.found {
            return None;
        }
        let first = &self.rows.front()?.0;
        let has_more_history = first["position"].as_u64().unwrap_or(0) > 0;
        Some(history::Page {
            next_cursor: has_more_history.then(|| history::encode_cursor(sequence, first)),
            has_more_history,
            rows: self.rows.into_iter().map(|(row, _)| row).collect(),
        })
    }
}

impl RowSink for JumpWindow<'_> {
    const ITEMS_SQL: &'static str = ROWS;

    fn has_room(&self, _: u64) -> bool {
        true
    }

    fn push(
        &mut self,
        visibility: &str,
        source: Value,
        id: Value,
        item: Value,
    ) -> Result<bool, String> {
        let is_target = !self.found && item["id"] == self.target && item["type"] == "user_message";
        let body_bytes = item["bytes"].as_u64().unwrap_or(0);
        let generated = history::is_generated(&item) && item.get("bytes").is_none();
        let row = json!({
            "position": self.position, "sourceThreadId": source, "sourceItemId": id,
            "visibility": visibility,
            "item": if generated { Some(item) } else { None }
        });
        self.position += 1;
        let size = usize::try_from(body_bytes)
            .unwrap_or(usize::MAX)
            .saturating_add(row.to_string().len());
        let budget = history::PAGE_POLICY.max_encoded_bytes;
        if self.found {
            if self.bytes.saturating_add(size) > budget {
                return Ok(false);
            }
            self.after += 1;
        }
        self.rows.push_back((row, size));
        self.bytes = self.bytes.saturating_add(size);
        self.found |= is_target;
        while (!self.found && self.rows.len() > 24) || (self.rows.len() > 1 && self.bytes > budget)
        {
            if let Some((_, size)) = self.rows.pop_front() {
                self.bytes = self.bytes.saturating_sub(size);
            }
        }
        Ok(self.after < 75)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_materializes_only_the_neighborhood_and_keeps_an_oversized_target() {
        let window = |target: &str| {
            let mut window = JumpWindow::new(target, 0);
            for pos in 0..1200 {
                let id = format!("prompt-{pos}");
                let item = json!({"id": id, "type": "user_message", "bytes": if pos == 1100 { 2_000_000 } else { 256 }});
                if !window.push("local", json!("t"), json!(id), item).unwrap() {
                    break;
                }
            }
            window.finish(12)
        };
        let page = window("prompt-500").unwrap();
        assert_eq!(page.rows.len(), 100);
        assert_eq!(page.rows[0]["sourceItemId"], "prompt-476");
        assert_eq!(page.rows[24]["sourceItemId"], "prompt-500");
        assert_eq!(page.rows[99]["sourceItemId"], "prompt-575");
        assert!(page.has_more_history && page.next_cursor.is_some());
        let oversized = window("prompt-1100").unwrap();
        assert_eq!(oversized.rows.len(), 1);
        assert_eq!(oversized.rows[0]["sourceItemId"], "prompt-1100");
        assert!(window("other").is_none());
    }

    #[test]
    fn prompt_groups_skip_hidden_items_but_keep_distinct_agent_prompts() {
        let mut result = Markers::new(["r".to_owned()].into());
        for item in [
            json!({"type":"user_message","id":"first","createdBy":"user","text":"  😊 first\nsecond"}),
            json!({"type":"checkpoint"}),
            json!({"type":"user_message","id":"second","createdBy":"user"}),
            json!({"type":"assistant_message","text":"# Done **well**","runId":"r"}),
            json!({"type":"command_execution","commandFailed":1,"status":"completed"}),
            json!({"type":"user_message","id":"agent","createdBy":"agent"}),
            json!({"type":"user_message","id":"queued","inputIntent":"queued_turn","status":"pending"}),
            json!({"type":"user_message","id":"last","createdBy":"user"}),
        ] {
            result
                .push("local", json!("t"), item["id"].clone(), item)
                .unwrap();
        }
        let markers = result.markers;
        assert_eq!(
            markers
                .iter()
                .map(|m| m.entry_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "agent", "last"]
        );
        assert_eq!(markers[0].preview, "😊 first");
        assert_eq!(markers[0].assistant_preview.as_deref(), Some("Done well"));
        assert!(markers[0].has_checkpoint && markers[0].has_error);
        assert!(markers[1].is_agent_prompt);
    }
}
