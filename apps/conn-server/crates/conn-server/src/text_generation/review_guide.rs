//! The review guide's pure parts, as the T3 server has them: the settled review summary
//! (`pullRequestReviewGuideInput.ts`), the changed files and hunks read from git
//! (`parseReviewGuideChange`, `headerPath`, `unquoteGitPatchPath`), the model's answer
//! (the `buildReviewGuidePrompt` output schema) and `normalizeReviewGuide`.
//!
//! Lengths are UTF-16 units, as in JavaScript. `crates/conn-server/tools/textgen-diff.mjs`
//! runs the T3 functions and these on the same cases and fails when they differ.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::js::{len16, slice16};
use super::prompts::{is_js_space, js_trim};

/// `SETTLED_REMARK_CHARS`.
const SETTLED_REMARK_CHARS: usize = 200;
/// `MAX_EXCERPT_LINES`.
const MAX_EXCERPT_LINES: i64 = 25;

/// `oneLine`: no HTML comments, whitespace runs as one space, at most 200 units.
fn one_line(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        let Some(end) = rest.get(start + 4..).and_then(|after| after.find("-->")) else {
            break;
        };
        stripped.push_str(rest.get(..start).unwrap_or_default());
        rest = rest.get(start + 4 + end + 3..).unwrap_or_default();
    }
    stripped.push_str(rest);
    let mut flat = String::with_capacity(stripped.len());
    let mut space = false;
    for c in stripped.chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space {
                flat.push(' ');
            }
            space = false;
            flat.push(c);
        }
    }
    if space {
        flat.push(' ');
    }
    let flat = js_trim(&flat);
    if len16(flat) > SETTLED_REMARK_CHARS {
        format!("{}…", slice16(flat, 0, SETTLED_REMARK_CHARS))
    } else {
        flat.to_owned()
    }
}

/// `settledReviewSummary`: one line per resolved or outdated review thread.
pub fn settled_review(activity: &Value) -> String {
    let threads = activity
        .get("reviewThreads")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    threads
        .iter()
        .filter(|t| t["isResolved"] == true || t["isOutdated"] == true)
        .filter_map(|thread| {
            let opener = thread["comments"].as_array()?.first()?;
            let who = opener
                .pointer("/author/login")
                .and_then(Value::as_str)
                .unwrap_or("ghost");
            let state = if thread["isResolved"] == true {
                "resolved"
            } else {
                "outdated"
            };
            let path = thread["path"].as_str().unwrap_or_default();
            let body = opener["body"].as_str().unwrap_or_default();
            Some(format!("- {path} ({state}, {who}): {}", one_line(body)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `unescapeBody` and `unquoteGitPatchPath`: octal escapes are bytes, decoded as UTF-8.
pub fn unquote_git_patch_path(token: &str) -> String {
    let body = if token.len() >= 2 && token.starts_with('"') && token.ends_with('"') {
        token.get(1..token.len() - 1).unwrap_or_default()
    } else {
        token
    };
    if !body.contains('\\') {
        return body.to_owned();
    }
    let mut bytes = Vec::with_capacity(body.len());
    let mut chars = body.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        let Some(&(_, escaped)) = chars.peek() else {
            bytes.push(b'\\');
            break;
        };
        let named = match escaped {
            '"' => Some(0x22),
            '\\' => Some(0x5c),
            'a' => Some(0x07),
            'b' => Some(0x08),
            'f' => Some(0x0c),
            'n' => Some(0x0a),
            'r' => Some(0x0d),
            't' => Some(0x09),
            'v' => Some(0x0b),
            _ => None,
        };
        if let Some(byte) = named {
            bytes.push(byte);
            chars.next();
            continue;
        }
        let octal = body
            .get(at + 1..at + 4)
            .filter(|o| o.len() == 3 && o.bytes().all(|b| (b'0'..=b'7').contains(&b)));
        if let Some(octal) = octal
            && let Ok(value) = u16::from_str_radix(octal, 8)
        {
            // JavaScript keeps the low byte of `Number.parseInt(...)` in a `Uint8Array`.
            bytes.push(u8::try_from(value & 0xff).unwrap_or_default());
            chars.next();
            chars.next();
            chars.next();
            continue;
        }
        // An unknown escape keeps the character without its backslash.
        let mut buf = [0u8; 4];
        bytes.extend_from_slice(escaped.encode_utf8(&mut buf).as_bytes());
        chars.next();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `headerPath`: the path of a `--- ` or `+++ ` line without its prefix.
fn header_path(line: &str, prefix: &str) -> Option<String> {
    let rest = line.get(4..).unwrap_or_default();
    let token = rest.split('\t').next().unwrap_or_default();
    let path = if token.starts_with('"') {
        unquote_git_patch_path(token)
    } else {
        token.to_owned()
    };
    path.strip_prefix(prefix).map(str::to_owned)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LineRange {
    start: i64,
    end: i64,
}

#[derive(Clone, Debug, Default)]
struct FileHunks {
    new: Vec<LineRange>,
    old: Vec<LineRange>,
}

/// `ReviewGuideChange`: the changed files and each file's hunks.
#[derive(Clone, Debug, Default)]
pub struct Change {
    files: Vec<String>,
    hunks: BTreeMap<String, FileHunks>,
}

/// `HUNK_HEADER`: `@@ -a[,b] +c[,d] @@`.
fn hunk_header(line: &str) -> Option<(LineRange, LineRange, bool, bool)> {
    fn number(rest: &str) -> Option<(i64, &str)> {
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        let digits = rest.get(..end).filter(|d| !d.is_empty())?;
        Some((digits.parse().ok()?, rest.get(end..).unwrap_or_default()))
    }
    fn range(rest: &str) -> Option<(i64, Option<i64>, &str)> {
        let (start, rest) = number(rest)?;
        if let Some(after) = rest.strip_prefix(',') {
            let (count, rest) = number(after)?;
            Some((start, Some(count), rest))
        } else {
            Some((start, None, rest))
        }
    }
    let rest = line.strip_prefix("@@ -")?;
    let (old_start, old_count, rest) = range(rest)?;
    let rest = rest.strip_prefix(" +")?;
    let (new_start, new_count, rest) = range(rest)?;
    rest.strip_prefix(" @@")?;
    let make = |start: i64, count: Option<i64>| {
        let lines = count.unwrap_or(1);
        (
            LineRange {
                start,
                end: start + lines - 1,
            },
            lines != 0,
        )
    };
    let (old, has_old) = make(old_start, old_count);
    let (new, has_new) = make(new_start, new_count);
    Some((old, new, has_old, has_new))
}

/// `parseReviewGuideChange`: `nameOnly` from `git diff --name-only -z`, `patch` from
/// `git diff --unified=0`.
pub fn parse_change(name_only: &str, patch: &str) -> Change {
    let mut hunks: BTreeMap<String, FileHunks> = BTreeMap::new();
    let mut old_path: Option<String> = None;
    let mut current: Option<String> = None;
    let mut in_hunks = false;
    for line in patch.split('\n') {
        if line.starts_with("diff --git ") {
            old_path = None;
            current = None;
            in_hunks = false;
        } else if !in_hunks && line.starts_with("--- ") {
            old_path = header_path(line, "a/");
        } else if !in_hunks && line.starts_with("+++ ") {
            let Some(path) = header_path(line, "b/").or_else(|| old_path.clone()) else {
                continue;
            };
            hunks.entry(path.clone()).or_default();
            current = Some(path);
        } else if let Some(path) = &current {
            let Some((old, new, has_old, has_new)) = hunk_header(line) else {
                continue;
            };
            in_hunks = true;
            let entry = hunks.entry(path.clone()).or_default();
            if has_old {
                entry.old.push(old);
            }
            if has_new {
                entry.new.push(new);
            }
        }
    }
    Change {
        files: name_only
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect(),
        hunks,
    }
}

/// A JSON number that is an integer (`Schema.Int`): `3` and `3.0` pass, `3.5` does not.
fn int<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = serde_json::Number::deserialize(deserializer)?;
    if let Some(n) = value.as_i64() {
        return Ok(n);
    }
    let float = value
        .as_f64()
        .filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0)
        .ok_or_else(|| serde::de::Error::custom("expected an integer"))?;
    #[expect(
        clippy::cast_possible_truncation,
        reason = "an integral value within 2^53"
    )]
    Ok(float as i64)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Attention {
    pub kind: AttentionKind,
    pub note: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AttentionKind {
    Tradeoff,
    Contract,
    Product,
    Risk,
    Accessibility,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    New,
    Old,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Excerpt {
    pub path: String,
    pub side: Side,
    #[serde(deserialize_with = "int")]
    pub start: i64,
    #[serde(deserialize_with = "int")]
    pub end: i64,
    pub caption: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct File {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Note {
    pub path: String,
    #[serde(deserialize_with = "int")]
    pub line: i64,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Stop {
    pub title: String,
    pub summary: String,
    pub attention: Option<Attention>,
    pub excerpts: Vec<Excerpt>,
    pub files: Vec<File>,
    pub notes: Vec<Note>,
    pub questions: Vec<String>,
}

/// The model's answer (`ReviewGuideGenerationResult`).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Generated {
    pub stops: Vec<Stop>,
}

/// The model's answer decoded as the output schema: `attention` must be present (null or an
/// object) and every `files` entry has a `note`.
pub fn decode_generated(value: &Value) -> Option<Generated> {
    let stops = value.get("stops")?.as_array()?;
    for stop in stops {
        stop.get("attention")?;
        for file in stop.get("files")?.as_array()? {
            file.get("note")?.as_str()?;
        }
    }
    serde_json::from_value(value.clone()).ok()
}

/// `clampExcerpt`.
fn clamp_excerpt(excerpt: &Excerpt, change: &Change) -> Option<Excerpt> {
    let start = excerpt.start.min(excerpt.end);
    let end = excerpt.start.max(excerpt.end);
    let hunks = change.hunks.get(&excerpt.path)?;
    let side = match excerpt.side {
        Side::New => &hunks.new,
        Side::Old => &hunks.old,
    };
    let mut overlapping = side.iter().filter(|h| h.start <= end && start <= h.end);
    let first = overlapping.next()?;
    let last = overlapping.next_back().unwrap_or(first);
    Some(Excerpt {
        start: start.max(first.start),
        end: end.min(last.end),
        ..excerpt.clone()
    })
}

/// `mergeExcerpts`: touching ranges of one file side become one, then each is cut to 25
/// lines.
fn merge_excerpts(excerpts: Vec<Excerpt>) -> Vec<Excerpt> {
    let mut merged: Vec<Excerpt> = Vec::new();
    for excerpt in excerpts {
        let touches = |other: &Excerpt| {
            other.path == excerpt.path
                && other.side == excerpt.side
                && other.start <= excerpt.end + 1
                && excerpt.start <= other.end + 1
        };
        let group: Vec<usize> = (0..merged.len())
            .filter(|&i| merged.get(i).is_some_and(touches))
            .collect();
        let Some(&first) = group.first() else {
            merged.push(excerpt);
            continue;
        };
        let members: Vec<&Excerpt> = group.iter().filter_map(|&i| merged.get(i)).collect();
        let start = members
            .iter()
            .map(|o| o.start)
            .fold(excerpt.start, i64::min);
        let end = members.iter().map(|o| o.end).fold(excerpt.end, i64::max);
        let caption = members
            .iter()
            .find(|o| !o.caption.is_empty())
            .map_or_else(|| excerpt.caption.clone(), |o| o.caption.clone());
        let Some(head) = merged.get(first) else {
            continue;
        };
        let combined = Excerpt {
            start,
            end,
            caption,
            ..head.clone()
        };
        merged = merged
            .into_iter()
            .enumerate()
            .filter_map(|(i, other)| {
                if i == first {
                    Some(combined.clone())
                } else if touches(&other) {
                    None
                } else {
                    Some(other)
                }
            })
            .collect();
    }
    for excerpt in &mut merged {
        excerpt.end = excerpt.end.min(excerpt.start + MAX_EXCERPT_LINES - 1);
    }
    merged
}

fn non_empty(value: &str) -> bool {
    !js_trim(value).is_empty()
}

/// `normalizeReviewGuide`: excerpts clamped to the change and merged, paths outside the change
/// dropped, notes kept only inside an excerpt, each file placed once, and an "Other files"
/// stop for the rest.
pub fn normalize(guide: Generated, change: &Change) -> Generated {
    let changed: HashSet<&str> = change.files.iter().map(String::as_str).collect();
    let shaped: Vec<Stop> = guide
        .stops
        .into_iter()
        .filter(|stop| non_empty(&stop.title))
        .map(|stop| {
            let excerpts = merge_excerpts(
                stop.excerpts
                    .iter()
                    .filter(|e| changed.contains(e.path.as_str()))
                    .filter_map(|e| clamp_excerpt(e, change))
                    .collect(),
            );
            let attention = stop.attention.filter(|a| non_empty(&a.note));
            let files = stop
                .files
                .into_iter()
                .filter(|f| changed.contains(f.path.as_str()))
                .map(|File { path, note }| File {
                    path,
                    note: note.filter(|n| non_empty(n)),
                })
                .collect();
            let notes = stop
                .notes
                .into_iter()
                .filter(|note| {
                    non_empty(&note.title)
                        && excerpts.iter().any(|e| {
                            e.path == note.path && e.start <= note.line && note.line <= e.end
                        })
                })
                .collect();
            Stop {
                title: stop.title,
                summary: stop.summary,
                attention,
                excerpts,
                files,
                notes,
                questions: stop
                    .questions
                    .into_iter()
                    .filter(|q| non_empty(q))
                    .collect(),
            }
        })
        .collect();
    let mut placed: HashSet<String> = shaped
        .iter()
        .flat_map(|s| s.excerpts.iter().map(|e| e.path.clone()))
        .collect();
    let mut stops: Vec<Stop> = shaped
        .into_iter()
        .map(|mut stop| {
            stop.files.retain(|f| !placed.contains(&f.path));
            for file in &stop.files {
                placed.insert(file.path.clone());
            }
            stop
        })
        .collect();
    let unplaced: Vec<File> = change
        .files
        .iter()
        .filter(|p| !placed.contains(*p))
        .map(|path| File {
            path: path.clone(),
            note: None,
        })
        .collect();
    if !unplaced.is_empty() {
        stops.push(Stop {
            title: "Other files".into(),
            summary: "Changed files the tour does not otherwise cover.".into(),
            attention: None,
            excerpts: Vec::new(),
            files: unplaced,
            notes: Vec::new(),
            questions: Vec::new(),
        });
    }
    Generated { stops }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hunks_and_quoted_paths_are_read_as_git_writes_them() {
        let patch = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,2 +1,3 @@\n--- not a header\n@@ -9 +10,0 @@\ndiff --git \"a/t\\tb\" \"b/t\\tb\"\n--- /dev/null\n+++ \"b/t\\tb\"\n@@ -0,0 +1 @@\n";
        let change = parse_change("a.rs\0t\tb\0", patch);
        let a = change.hunks.get("a.rs").expect("a.rs");
        assert_eq!(a.new, [LineRange { start: 1, end: 3 }]);
        assert_eq!(
            a.old,
            [
                LineRange { start: 1, end: 2 },
                LineRange { start: 9, end: 9 }
            ]
        );
        assert_eq!(
            change.hunks.get("t\tb").map(|h| h.new.clone()),
            Some(vec![LineRange { start: 1, end: 1 }])
        );
        assert_eq!(unquote_git_patch_path("\"b/\\303\\251\""), "b/é");
    }

    #[test]
    fn normalize_places_every_file_once() {
        let change = parse_change(
            "a.rs\0b.rs\0c.rs\0",
            "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1,40 @@\n",
        );
        let guide: Generated = serde_json::from_value(json!({"stops": [
            {"title": "One", "summary": "s", "attention": {"kind": "risk", "note": " "},
             "excerpts": [{"path": "a.rs", "side": "new", "start": 5, "end": 2, "caption": ""},
                          {"path": "a.rs", "side": "new", "start": 6, "end": 39, "caption": "c"},
                          {"path": "zz.rs", "side": "new", "start": 1, "end": 2, "caption": ""}],
             "files": [{"path": "b.rs", "note": " "}, {"path": "a.rs", "note": "x"}],
             "notes": [{"path": "a.rs", "line": 3, "title": "n", "body": ""},
                       {"path": "a.rs", "line": 40, "title": "far", "body": ""}],
             "questions": ["", "Why?"]},
            {"title": " ", "summary": "", "attention": null, "excerpts": [], "files": [],
             "notes": [], "questions": []}
        ]}))
        .expect("decoded");
        let normalized = normalize(guide, &change);
        assert_eq!(
            serde_json::to_value(&normalized).expect("json"),
            json!({"stops": [
                {"title": "One", "summary": "s", "attention": null,
                 "excerpts": [{"path": "a.rs", "side": "new", "start": 2, "end": 26, "caption": "c"}],
                 "files": [{"path": "b.rs"}],
                 "notes": [{"path": "a.rs", "line": 3, "title": "n", "body": ""}],
                 "questions": ["Why?"]},
                {"title": "Other files", "summary": "Changed files the tour does not otherwise cover.",
                 "attention": null, "excerpts": [], "files": [{"path": "c.rs"}], "notes": [], "questions": []}
            ]})
        );
    }

    #[test]
    fn settled_review_lists_resolved_and_outdated_threads() {
        let activity = json!({"reviewThreads": [
            {"path": "a.rs", "isResolved": true, "isOutdated": false,
             "comments": [{"author": {"login": "ann"}, "body": "x <!-- hidden --> \n y"}]},
            {"path": "b.rs", "isResolved": false, "isOutdated": true,
             "comments": [{"author": null, "body": "z".repeat(210)}]},
            {"path": "c.rs", "isResolved": false, "isOutdated": false,
             "comments": [{"author": {"login": "c"}, "body": "open"}]}
        ]});
        assert_eq!(
            settled_review(&activity),
            format!(
                "- a.rs (resolved, ann): x y\n- b.rs (outdated, ghost): {}…",
                "z".repeat(200)
            )
        );
    }
}
