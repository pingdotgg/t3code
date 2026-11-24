//! The `orchestration.*` reads beyond snapshots and streams: titles, families, archived and
//! older-settled shells, search, single turn items, worktree occupants.
//!
//! Each read runs one short query on the database thread and builds only its answer. Shell rows
//! come from the stored `threads.shell` column, so no read rebuilds a projection.

use std::collections::BTreeMap;

use rusqlite::params;
use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::store::{Store, StoreResult};
use crate::time::millis_from_iso;
use crate::transcript::RowSink;

/// `NEWEST_SETTLED_KEPT` in `ShellStream.ts`: the settled threads a bounded shell keeps.
const NEWEST_SETTLED_KEPT: usize = 25;
/// `searchThreads` scans at most this many newest messages, so one search cannot hold the
/// database thread for long.
const SEARCH_SCAN_LIMIT: i64 = 20_000;
/// `SNIPPET_LENGTH` in `ThreadSearch.ts`: a snippet's UTF-16 units, its ellipses included.
const SNIPPET_LENGTH: usize = 240;
/// `SNIPPET_LEAD`: the units a snippet may show before the match. A result row shows one line.
const SNIPPET_LEAD: usize = 24;
/// `MESSAGE_CANDIDATE_LIMIT` in `ThreadSearch.ts`: the newest index hits the filters may pass
/// over, so a common word does not read every hit.
const SEARCH_CANDIDATE_LIMIT: i64 = 10_000;
/// `MESSAGE_HIT_LIMIT`: rows read after the filters.
const SEARCH_HIT_LIMIT: i64 = 2_000;
/// `MESSAGE_TOKEN_MIN_LENGTH` in `paletteSearch.ts`: a shorter Latin word is noise.
const MESSAGE_TOKEN_MIN_LENGTH: usize = 3;
/// `MESSAGE_WORD_START_LENGTH`: a shorter word must start a word, so "fts" does not find "drafts".
const MESSAGE_WORD_START_LENGTH: usize = 4;

/// The filters every search shares, after `hits(rowid)` names the candidate messages, newest
/// first. `CROSS JOIN` keeps the hits first, so the planner never scans `entities` or
/// `threads`. Deleted, archived, subagent and side-chat threads drop out before the limit, and
/// so do threads outside the project scope (`?6`) and threads the caller already lists (`?7`),
/// as `searchMessages` in `ThreadSearch.ts` applies them.
macro_rules! search_sql {
    ($hits:literal) => {
        concat!(
            "WITH hits AS MATERIALIZED (",
            $hits,
            ")
             SELECT k.thread_id,
                    json_object('projectId', json_extract(t.shell, '$.projectId'),
                                'message', json(e.body))
             FROM hits h
             CROSS JOIN message_keys k ON k.id = h.rowid
             CROSS JOIN message_search folded ON folded.rowid = h.rowid
             CROSS JOIN threads t ON t.id = k.thread_id
             CROSS JOIN entities e
               ON e.thread_id = k.thread_id AND e.kind = 'messages' AND e.id = k.message_id
             WHERE t.deleted = 0 AND t.shell IS NOT NULL
               AND json_extract(t.shell, '$.archivedAt') IS NULL
               AND json_extract(t.shell, '$.lineage.relationshipToParent') IS NOT 'subagent'
               AND json_extract(t.shell, '$.lineage.sideChat') IS NOT 1
               AND k.message_id NOT LIKE 'async-answer:%'
               AND (?6 IS NULL OR json_extract(t.shell, '$.projectId') = ?6)
               AND k.thread_id NOT IN (SELECT value FROM json_each(?7))
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(?2) AS token
                 WHERE instr(folded.text, token.value) = 0
               )
             ORDER BY h.rowid DESC
             LIMIT ?5"
        )
    };
}

/// Long words that are all three characters or more: the trigram index answers `MATCH`.
const SEARCH_INDEXED_SQL: &str = search_sql!(
    "SELECT rowid FROM message_search WHERE message_search MATCH ?1
     ORDER BY rowid DESC LIMIT ?3"
);
/// A two-character CJK word is too short for trigrams: scan the newest indexed messages.
/// `?1` is unused here and bound as NULL.
const SEARCH_SCAN_SQL: &str =
    search_sql!("SELECT id AS rowid FROM message_keys WHERE ?1 IS NULL ORDER BY id DESC LIMIT ?4");

/// The SQL inputs of one message search (`buildMessageSearch` in `ThreadSearch.ts`), and the
/// words its matcher checks in each hit (`messageMatcher` in `paletteSearch.ts`).
struct MessageSearch {
    /// Quoted long words for FTS5 `MATCH`, or `None` when the index cannot serve them.
    fts_match: Option<String>,
    /// Folded words each hit's folded text must contain as a substring.
    substrings: Vec<String>,
    /// Every word, long ones first.
    tokens: Vec<MatchToken>,
    /// Two or more words, as typed and lowercased, that a hit may hold side by side.
    phrase: Option<Vec<String>>,
    /// The same words with accents folded.
    folded_phrase: Option<Vec<String>>,
    /// Whether the query, as typed, has a character outside ASCII (`NON_ASCII`).
    non_ascii: bool,
}

/// One query word as the matcher reads it.
struct MatchToken {
    /// The word lowercased, as `messageSearchTokens` gives it.
    word: String,
    /// The word folded as `foldInPlace` folds it, marks dropped, for the accent-blind pass.
    folded: String,
    non_ascii: bool,
    /// Shorter than `MESSAGE_WORD_START_LENGTH`: it must start a word, so "fts" does not find
    /// "drafts".
    must_start_word: bool,
}

impl MessageSearch {
    /// `None` when the query has no word long enough to search (`messageSearchTokens`).
    fn new(query: &str) -> Option<Self> {
        let lowered = query
            .trim()
            .trim_matches(crate::fold::WRAPPING_QUOTES)
            .chars()
            .map(crate::fold::straight)
            .nfc()
            .collect::<String>()
            .to_lowercase();
        // Each word with its index fold. A word the index folds away is not searched.
        let words: Vec<(&str, String)> = lowered
            .split(crate::fold::is_js_space)
            .map(|word| (word, crate::fold::fold(word)))
            .filter(|(_, folded)| !folded.is_empty())
            .collect();
        let (long, short): (Vec<_>, Vec<_>) = words
            .iter()
            .partition(|(word, _)| searchable(word.chars().count(), word));
        if long.is_empty() {
            return None;
        }
        let indexed = long
            .iter()
            .all(|(word, _)| word.chars().count() >= MESSAGE_TOKEN_MIN_LENGTH);
        let fts_match = indexed.then(|| {
            long.iter()
                .map(|(_, token)| format!("\"{}\"", token.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ")
        });
        let mut substrings: Vec<String> = if indexed {
            vec![]
        } else {
            long.iter().map(|(_, token)| token.clone()).collect()
        };
        substrings.extend(short.iter().map(|(_, token)| token.clone()));
        let without_marks = |word: &str| -> String {
            crate::fold::fold_field(word)
                .chars()
                .filter(|&c| !unicode_normalization::char::is_combining_mark(c))
                .collect()
        };
        let tokens = long
            .iter()
            .chain(&short)
            .map(|(word, _)| MatchToken {
                word: (*word).to_owned(),
                folded: without_marks(word),
                non_ascii: !word.is_ascii(),
                must_start_word: word.chars().count() < MESSAGE_WORD_START_LENGTH,
            })
            .collect();
        let phrase = |words: Vec<String>| (words.len() > 1).then_some(words);
        Some(Self {
            fts_match,
            substrings,
            tokens,
            phrase: phrase(words.iter().map(|(word, _)| (*word).to_owned()).collect()),
            folded_phrase: phrase(
                words
                    .iter()
                    .map(|(word, _)| without_marks(word))
                    .filter(|word| !word.is_empty())
                    .collect(),
            ),
            non_ascii: !query.is_ascii(),
        })
    }

    /// `messageMatcher`: where the snippet of a hit starts, in UTF-16 units, or `None` when a
    /// word sits only inside a hex id, or a short word only inside words. Each word is looked
    /// for lowercased, then with accents folded when that finds no whole word. The snippet
    /// starts where the words sit side by side as typed, else at the shortest stretch that
    /// holds one best place of every word.
    fn accept(&self, text: &str) -> Option<usize> {
        use crate::fold::{Folded, Placement, push_field};
        let text_non_ascii = !text.is_ascii();
        let plain =
            Folded::message_lowercase(text).unwrap_or_else(|| Folded::message(text, push_field));
        let mut folded: Option<Folded> = None;
        let first_only = self.tokens.len() == 1;
        let mut places: Vec<Vec<usize>> = Vec::with_capacity(self.tokens.len());
        for token in &self.tokens {
            let mut found = plain.find_token(&token.word, first_only);
            let whole = matches!(found, Some((Placement::Whole, _)));
            if !whole && !token.folded.is_empty() && (token.non_ascii || text_non_ascii) {
                found = folded
                    .get_or_insert_with(|| Folded::message(text, push_field))
                    .find_token(&token.folded, first_only);
            }
            let (placement, at) = found?;
            if placement == Placement::Inside && token.must_start_word {
                return None;
            }
            places.push(at.into_iter().map(|i| plain.utf16_offset(i)).collect());
        }
        let mut together = self
            .phrase
            .as_ref()
            .and_then(|words| plain.find_phrase(words));
        if together.is_none()
            && (self.non_ascii || text_non_ascii)
            && let Some(words) = &self.folded_phrase
        {
            together = folded
                .get_or_insert_with(|| Folded::message(text, push_field))
                .find_phrase(words);
        }
        Some(together.map_or_else(|| shortest_span(&places), |at| plain.utf16_offset(at)))
    }
}

/// `shortestSpan` in `paletteSearch.ts`: where the shortest stretch of text starts that holds
/// one place of each word, from each word's places in order, in UTF-16 units.
fn shortest_span(places: &[Vec<usize>]) -> usize {
    let mut hits: Vec<(usize, usize)> = places
        .iter()
        .enumerate()
        .flat_map(|(word, at)| at.iter().map(move |&index| (index, word)))
        .collect();
    hits.sort_by_key(|&(index, _)| index);
    let mut counts = vec![0_usize; places.len()];
    let mut covered = 0;
    let mut best = (hits.first().map_or(0, |&(index, _)| index), usize::MAX);
    let mut left = 0;
    for &(index, word) in &hits {
        if let Some(count) = counts.get_mut(word) {
            *count += 1;
            if *count == 1 {
                covered += 1;
            }
        }
        while covered == places.len() {
            let Some(&(first, first_word)) = hits.get(left) else {
                break;
            };
            if index - first < best.1 {
                best = (first, index - first);
            }
            if let Some(count) = counts.get_mut(first_word) {
                *count -= 1;
                if *count == 0 {
                    covered -= 1;
                }
            }
            left += 1;
        }
    }
    best.0
}

/// Three characters or more, or two when one is a CJK word character.
fn searchable(length: usize, token: &str) -> bool {
    length >= MESSAGE_TOKEN_MIN_LENGTH || (length == 2 && token.chars().any(is_cjk_word))
}

/// `hasCjkWord` in `paletteSearch.ts`: kana, CJK ideographs and Hangul syllables.
fn is_cjk_word(c: char) -> bool {
    matches!(
        u32::from(c),
        0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0xac00..=0xd7af
    )
}

fn listed(row: &Value) -> bool {
    row["lineage"]["relationshipToParent"] != "subagent" && row["lineage"]["sideChat"] != true
}

fn settled_millis(row: &Value) -> Option<i64> {
    if row["settledOverride"] != "settled" {
        return None;
    }
    row["settledAt"].as_str().and_then(millis_from_iso)
}

/// `OLDER_SETTLED_TITLE_ROWS` and `OLDER_SETTLED_MESSAGE_ROWS` in `ThreadSearch.ts`.
const OLDER_SETTLED_TITLE_ROWS: usize = 15;
const OLDER_SETTLED_MESSAGE_ROWS: usize = 5;

/// `foldSearchQuery`, as far as a candidate filter needs: lowercase words, straight
/// apostrophes, no wrapping quotes.
fn fold_search_words(query: &str) -> Vec<String> {
    let quotes: &[char] = &['"', '`', '\u{201c}', '\u{201d}'];
    query
        .trim()
        .trim_matches(quotes)
        .replace(['\u{2018}', '\u{2019}'], "'")
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Every word appears in the title, the branch or a pull request's number or title.
fn title_matches(row: &Value, words: &[String]) -> bool {
    let mut text = String::new();
    for field in [&row["title"], &row["branch"]] {
        text.push_str(field.as_str().unwrap_or_default());
        text.push('\n');
    }
    for pull_request in row["pullRequests"].as_array().into_iter().flatten() {
        if let Some(number) = pull_request["number"].as_u64() {
            text.push_str(&format!("#{number}\n"));
        }
        text.push_str(pull_request["title"].as_str().unwrap_or_default());
        text.push('\n');
    }
    let text = text.to_lowercase().replace(['\u{2018}', '\u{2019}'], "'");
    words.iter().all(|word| text.contains(word.as_str()))
}

/// `isOlderSettledThreadShell`: listed, settled before `before`.
fn older_settled(row: &Value, before: i64) -> bool {
    listed(row) && settled_millis(row).is_some_and(|at| at < before)
}

/// The settle time below which a thread is "older settled": the 25th newest settle time of
/// listed threads, the oldest with fewer (so none is older), or `None` when none is settled.
fn older_settled_cut(rows: &[Value]) -> Option<i64> {
    let mut times: Vec<i64> = rows
        .iter()
        .filter(|row| listed(row))
        .filter_map(settled_millis)
        .collect();
    times.sort_unstable_by(|a, b| b.cmp(a));
    times.get(NEWEST_SETTLED_KEPT - 1).or(times.last()).copied()
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
        let remote_task_owners = self.remote_task_owners()?;
        let owns_remote_task = |r: &Value| {
            r["id"]
                .as_str()
                .is_some_and(|id| remote_task_owners.contains(id))
        };
        let mut keep: Vec<Value> = rows.clone();
        if omit_idle {
            keep.retain(|r| {
                r["lineage"]["relationshipToParent"] != "subagent"
                    || live_subagent(r)
                    || parent_of_subagent.contains(&r["id"])
                    || owns_remote_task(r)
            });
        }
        if omit_older {
            let now = i64::try_from(self.now_millis()).unwrap_or(i64::MAX);
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
            let mut filed = BTreeMap::new();
            for row in rows.iter().filter(|r| older_settled(r, before)) {
                if let (Some(id), Some(slug), Some(owner)) = (
                    row["orbitProject"]["id"].as_i64(),
                    row["orbitProject"]["slug"].as_str(),
                    row["projectId"].as_str(),
                ) {
                    *filed.entry((owner, id, slug)).or_insert(0_u64) += 1;
                }
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
                    || owns_remote_task(r)
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
            if !filed.is_empty() {
                snapshot["olderSettled"]["filedCounts"] = Value::Array(filed.into_iter().map(|((project, id, slug), count)| {
                    json!({"projectId": project, "orbitProject": {"id":id, "slug":slug}, "count":count})
                }).collect());
            }
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
                if let (Some(ids), Some(id)) = (
                    input["orbitProjectIds"].as_array(),
                    row["orbitProject"].get("id"),
                ) {
                    return ids.contains(id);
                }
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

    /// `searchThreadsWithOlderSettledRows`: message matches, and with `olderSettledBefore` the
    /// rows of the best older settled matches, which a shell that omits them does not hold.
    pub(crate) fn search_threads(&self, input: &Value) -> StoreResult<Value> {
        let mut result = self.search_messages(input)?;
        let Some(before) = input["olderSettledBefore"]
            .as_str()
            .and_then(millis_from_iso)
        else {
            return Ok(result);
        };
        let message_threads: Vec<String> = result["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["threadId"].as_str().map(str::to_owned))
            .collect();
        let threads = self.older_settled_search(input, before, &message_threads)?;
        result["snapshotSequence"] = json!(self.high_water());
        result["threads"] = json!(threads);
        Ok(result)
    }

    /// `searchOlderSettled`: up to 15 older settled threads whose title, branch or pull
    /// request matches every query word, by recent use, then up to 5 of the message matches.
    /// Rows only; the client ranks them with its own palette scorer.
    fn older_settled_search(
        &self,
        input: &Value,
        before: i64,
        message_threads: &[String],
    ) -> StoreResult<Vec<Value>> {
        let projects: Option<Vec<&str>> = input["projectIds"]
            .as_array()
            .map(|ids| ids.iter().filter_map(Value::as_str).collect());
        let words = fold_search_words(input["query"].as_str().unwrap_or_default());
        let mut candidates: Vec<Value> = self
            .shell_rows()?
            .into_iter()
            .filter(|row| row["archivedAt"].is_null() && older_settled(row, before))
            .filter(|row| {
                projects
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&row["projectId"].as_str().unwrap_or("")))
            })
            .collect();
        let recent_use = |row: &Value| -> i64 {
            row["latestUserMessageAt"]
                .as_str()
                .or_else(|| row["createdAt"].as_str())
                .and_then(millis_from_iso)
                .unwrap_or(0)
        };
        let mut titled: Vec<Value> = candidates
            .iter()
            .filter(|row| !words.is_empty() && title_matches(row, &words))
            .cloned()
            .collect();
        titled.sort_by_key(|row| std::cmp::Reverse(recent_use(row)));
        titled.truncate(OLDER_SETTLED_TITLE_ROWS);
        let mut seen: Vec<String> = Vec::new();
        for id in message_threads {
            if seen.len() >= OLDER_SETTLED_MESSAGE_ROWS {
                break;
            }
            if seen.contains(id)
                || titled.iter().any(|row| row["id"] == id.as_str())
                || !candidates.iter().any(|row| row["id"] == id.as_str())
            {
                continue;
            }
            seen.push(id.clone());
        }
        candidates.retain(|row| seen.iter().any(|id| row["id"] == id.as_str()));
        candidates.sort_by_key(|row| {
            seen.iter()
                .position(|id| row["id"] == id.as_str())
                .unwrap_or(usize::MAX)
        });
        titled.extend(candidates);
        Ok(titled)
    }

    /// `searchThreads`: the newest message of each thread that holds every search word, newest
    /// first, as `ThreadSearch.ts`.
    fn search_messages(&self, input: &Value) -> StoreResult<Value> {
        let limit = input["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
        let mut matches: Vec<Value> = Vec::new();
        // `titlesOnly` asks for no message search at all. A query with no long word searches no
        // messages (`buildMessageSearch`).
        let Some(search) = (input["titlesOnly"] != true)
            .then(|| MessageSearch::new(input["query"].as_str().unwrap_or_default()))
            .flatten()
        else {
            return Ok(json!({"matches": matches}));
        };
        let sql = match search.fts_match {
            Some(_) => SEARCH_INDEXED_SQL,
            None => SEARCH_SCAN_SQL,
        };
        let substrings = json!(search.substrings).to_string();
        // `projectId` and `excludedThreadIds` are the server's own options (`/mcp` search);
        // client calls carry neither.
        let project_id = input["projectId"].as_str();
        let excluded = match &input["excludedThreadIds"] {
            Value::Array(ids) => Value::Array(ids.clone()).to_string(),
            _ => "[]".to_owned(),
        };
        let rows = self.query_rows(
            sql,
            params![
                search.fts_match,
                substrings,
                SEARCH_CANDIDATE_LIMIT,
                SEARCH_SCAN_LIMIT,
                SEARCH_HIT_LIMIT,
                project_id,
                excluded
            ],
        )?;
        let mut seen: Vec<String> = Vec::new();
        for (thread_id, hit) in rows {
            if matches.len() >= limit {
                break;
            }
            if seen.contains(&thread_id) {
                continue;
            }
            let message = &hit["message"];
            let stored = message["text"].as_str().unwrap_or_default();
            let readable = crate::store::readable_search_text(stored);
            let text = link_labels(readable.as_deref().unwrap_or(stored));
            let Some(at) = search.accept(&text) else {
                continue;
            };
            matches.push(json!({
                "threadId": thread_id,
                "projectId": hit["projectId"],
                "source": if message["role"] == "user" { "user" } else { "assistant" },
                "snippet": snippet(&text, at),
                "messageCreatedAt": message["createdAt"],
                "messageId": message["id"],
            }));
            seen.push(thread_id);
        }
        Ok(json!({"matches": matches}))
    }

    /// In-thread find (`ThreadFind.ts`): occurrences of the query in the shown text of the
    /// user and assistant messages and plans of the thread's visible timeline, a run fork's
    /// inherited rows first. Each row is counted as it is read.
    pub(crate) fn search_thread(&self, input: &Value) -> StoreResult<Value> {
        let thread_id = input["threadId"].as_str().unwrap_or_default();
        let needle = input["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let mut found = FindCounts {
            needle,
            documents: Vec::new(),
        };
        if let Some((thread, _)) = self.live_thread(thread_id)? {
            self.visible_rows(&thread, &mut found)?;
        }
        let documents = found.documents;
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
            // The offset comes from the client: add in i128, where no `i64` can overflow.
            let offset = input["offset"].as_i64().unwrap_or(0);
            let moved = (i128::from(requested) + i128::from(offset)).rem_euclid(i128::from(total));
            // `rem_euclid` by a `u64` total leaves a value in `0..total`.
            u64::try_from(moved).unwrap_or(0)
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

/// The Find documents of a visible timeline, `(entry id, run id, occurrences)` in order.
struct FindCounts {
    needle: String,
    documents: Vec<(Value, Value, u64)>,
}

impl RowSink for FindCounts {
    fn has_room(&self, _bytes: u64) -> bool {
        true
    }

    fn push(&mut self, _: &str, _: Value, _: Value, item: Value) -> Result<bool, String> {
        let entry = match item["type"].as_str() {
            Some("user_message" | "assistant_message") => &item["messageId"],
            Some("proposed_plan") => &item["id"],
            _ => return Ok(true),
        };
        if item["status"] != "pending" {
            let count = crate::thread_find::segments(&item)
                .iter()
                .map(|segment| count_occurrences(segment, &self.needle))
                .sum();
            self.documents
                .push((entry.clone(), item["runId"].clone(), count));
        }
        Ok(true)
    }
}

fn count_occurrences(text: &str, needle: &str) -> u64 {
    if needle.is_empty() {
        return 0;
    }
    text.to_lowercase().matches(needle).count() as u64
}

/// `buildSearchSnippet` in `ThreadSearch.ts`: up to 240 UTF-16 units of `text` from a few words
/// before the match that starts `at` units in, emphasis and code marks dropped, whitespace
/// collapsed, with ellipses where the text was cut. A lone surrogate, where T3 would leave one,
/// reads as U+FFFD.
fn snippet(text: &str, at: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let is_space =
        |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(crate::fold::is_js_space);
    let is_low_surrogate = |unit: Option<&u16>| unit.is_some_and(|u| (0xdc00..=0xdfff).contains(u));
    let at = at.min(units.len());
    let mut start = at.saturating_sub(SNIPPET_LEAD);
    if start > 0
        && let Some(space) = units
            .get(start..at)
            .and_then(|lead| lead.iter().position(is_space))
    {
        start += space + 1;
    }
    if is_low_surrogate(units.get(start)) {
        start += 1;
    }
    let raw_end = units.len().min(start + SNIPPET_LENGTH * 2);
    let raw = units.get(start..raw_end).unwrap_or_default();
    // `/\*\*|`+/g` goes first, so whitespace on both sides of a mark collapses into one space
    // (`/\s+/g`), and `trim` drops it at the ends.
    let mut shown: Vec<u16> = Vec::with_capacity(raw.len());
    let mut rest = raw.iter().peekable();
    while let Some(&unit) = rest.next() {
        match unit {
            0x2a if rest.next_if_eq(&&0x2a).is_some() => {}
            0x60 => while rest.next_if_eq(&&0x60).is_some() {},
            _ if is_space(&unit) => {
                if shown.last().is_some_and(|&last| last != 0x20) {
                    shown.push(0x20);
                }
            }
            _ => shown.push(unit),
        }
    }
    if shown.last() == Some(&0x20) {
        shown.pop();
    }
    let mut end = shown.len().min(SNIPPET_LENGTH - 2);
    if is_low_surrogate(shown.get(end)) {
        end -= 1;
    }
    let cut = end < shown.len() || raw_end < units.len();
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        String::from_utf16_lossy(shown.get(..end).unwrap_or_default()),
        if cut { "…" } else { "" }
    )
}

/// `MARKDOWN_LINK` in `ThreadSearch.ts`: a thread shows a link (or image) as its label, so search
/// reads `[label](address)` as `label`.
fn link_labels(text: &str) -> std::borrow::Cow<'_, str> {
    fn link_at(rest: &str) -> Option<(&str, usize)> {
        let body = rest.strip_prefix('!').unwrap_or(rest).strip_prefix('[')?;
        let close = body.find([']', '\n'])?;
        let address = body[close..].strip_prefix("](")?;
        let end = address.find(|c: char| c == ')' || c.is_whitespace())?;
        address[end..].starts_with(')').then(|| {
            let used = rest.len() - address.len() + end + 1;
            (&body[..close], used)
        })
    }
    if !text.contains("](") {
        return text.into();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(next) = rest.find(['!', '[']) {
        out.push_str(&rest[..next]);
        rest = &rest[next..];
        match link_at(rest) {
            Some((label, used)) => {
                out.push_str(label);
                rest = &rest[used..];
            }
            None => {
                out.push(rest.as_bytes()[0] as char);
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(text: &str, needle: &str) -> String {
        let folded = crate::fold::Folded::new(text, crate::fold::push_indexed);
        snippet(text, folded.find(needle).unwrap_or(0))
    }

    /// `buildSearchSnippet` in `ThreadSearch.ts`, each row's snippet from T3's own function: 24
    /// UTF-16 units before the match, from the next word start, emphasis and code marks gone,
    /// whitespace collapsed, ellipses where the text was cut. `İ` (U+0130) lowercases to two
    /// characters, so a lowercase index is not an index into the original text: before the fix
    /// that panicked (`range start index 320 out of range`).
    #[test]
    fn snippet_survives_lowercase_expansion() {
        let text = format!("{}abc tail", "İ".repeat(200));
        assert_eq!(snip(&text, "abc"), format!("…{}abc tail", "İ".repeat(24)));
        let long = format!("needle {}", "word ".repeat(100));
        let emoji = format!("x{}yneedle", "😀".repeat(30));
        for (text, at, expected) in [
            (
                "alpha bravo charlie delta echo foxtrot golf needle hotel",
                44,
                "…echo foxtrot golf needle hotel".to_owned(),
            ),
            (
                "intro **bold** and `code`\n\n  needle",
                0,
                "intro bold and code needle".to_owned(),
            ),
            ("a ** b *`c` ***d", 0, "a b *c *d".to_owned()),
            (&long, 0, format!("needle {}w…", "word ".repeat(46))),
            // The lead starts on the second half of an emoji: the snippet starts after it.
            (&emoji, 62, format!("…{}yneedle", "😀".repeat(11))),
        ] {
            assert_eq!(snippet(text, at), expected, "{text}");
        }
    }

    fn plan(sql: &str, fts: Option<&str>) -> Vec<String> {
        let dir = std::env::temp_dir().join(format!(
            "conn-engine-{}-plan-{}",
            std::process::id(),
            fts.is_some()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let store = Store::open(&dir.join("engine.sqlite")).unwrap();
        let plan = store.query_plan(
            sql,
            params![
                fts,
                "[]",
                SEARCH_CANDIDATE_LIMIT,
                SEARCH_SCAN_LIMIT,
                SEARCH_HIT_LIMIT,
                Some("project"),
                "[\"t\"]"
            ],
        );
        let _ = std::fs::remove_dir_all(&dir);
        plan
    }

    /// The bundled SQLite reads the trigram index through `MATCH` (an `M` plan, not the full
    /// `INDEX 0:` scan that `LIKE ... ESCAPE` gave), and every join after it is a key lookup.
    #[test]
    fn search_reads_the_index_first_and_never_scans_the_store() {
        let indexed = plan(SEARCH_INDEXED_SQL, Some("\"abc\""));
        println!(
            "indexed plan ({}):\n{}",
            rusqlite::version(),
            indexed.join("\n")
        );
        assert!(
            indexed.iter().any(
                |step| step.starts_with("SCAN message_search VIRTUAL TABLE INDEX")
                    && step.contains(":M")
            ),
            "{indexed:?}"
        );
        let scan = plan(SEARCH_SCAN_SQL, None);
        println!("scan plan:\n{}", scan.join("\n"));
        for steps in [&indexed, &scan] {
            assert!(
                steps.iter().any(|s| s == "SCAN h"),
                "hits come first: {steps:?}"
            );
            assert!(
                !steps
                    .iter()
                    .any(|s| ["SCAN e", "SCAN t", "SCAN k", "SCAN entities"]
                        .iter()
                        .any(|table| s == table || s.starts_with(&format!("{table} ")))),
                "{steps:?}"
            );
        }
    }

    #[test]
    fn short_words_follow_message_search_tokens() {
        assert!(MessageSearch::new("ch").is_none());
        assert!(MessageSearch::new("  ").is_none());
        // Quotes around the whole query go, as `WRAPPING_QUOTES`.
        let s = MessageSearch::new("“Snake_case is”").unwrap();
        assert_eq!(s.fts_match.as_deref(), Some("\"snake_case\""));
        assert_eq!(s.substrings, ["is"]);
        let s = MessageSearch::new("東京 say\"x").unwrap();
        assert_eq!(
            s.fts_match, None,
            "two CJK characters are too short for trigrams"
        );
        assert_eq!(s.substrings, ["東京", "say\"x"]);
        let s = MessageSearch::new("a\"bc").unwrap();
        assert_eq!(s.fts_match.as_deref(), Some("\"a\"\"bc\""));
    }

    fn accept(query: &str, text: &str) -> Option<usize> {
        MessageSearch::new(query).and_then(|search| search.accept(text))
    }

    /// `messageMatcher` gives the snippet's offset in UTF-16 units, as T3 does: an emoji is two.
    /// Words written together as typed come before the shortest stretch that holds them.
    #[test]
    fn the_snippet_offset_counts_utf16_units_and_prefers_the_phrase() {
        // By characters the emoji stretch is shorter (47 against 67); by UTF-16 units it is
        // longer (87), so T3 shows the later pair.
        let emoji = format!(
            "alpha {} beta {} alpha {} beta",
            "😀".repeat(40),
            "z".repeat(225),
            "x".repeat(60)
        );
        assert_eq!(accept("alpha beta", &emoji), Some(318));
        let phrase = format!("bar foo {} foo bar", "y".repeat(100));
        assert_eq!(accept("foo bar", &phrase), Some(109));
        // The snippet reads the offset back in UTF-16 units.
        let text = format!("{}needle tail", "😀".repeat(200));
        assert_eq!(
            snippet(&text, 400),
            format!("…{}needle tail", "😀".repeat(12))
        );
    }

    /// `messageMatcher` looks for the word as typed, lowercased, first, and folds accents only
    /// when that finds no whole word: "cafe" shows the later "cafe", not "Café".
    #[test]
    fn the_exact_spelling_comes_before_the_folded_one() {
        let text = format!("Café {} cafe", "z".repeat(300));
        assert_eq!(accept("cafe", &text), Some(306));
        assert_eq!(accept("café", &text), Some(0));
        assert_eq!(accept("cafe", "Café ouvert"), Some(0));
    }

    #[test]
    fn snippet_handles_every_expanding_position() {
        for before in 0..300 {
            let text = format!("{}needle{}", "İ".repeat(before), "İ".repeat(before));
            assert!(snip(&text, "needle").contains("needle"));
            assert!(snip(&text, "absent").chars().count() <= SNIPPET_LENGTH);
            assert_eq!(count_occurrences(&text, "needle"), 1);
        }
    }
}
