//! The unified diff T3 shows for an ACP `diff` tool content (`acpToolCallDiffPatch` in
//! `adapter.ts`, which uses jsdiff's `structuredPatch` with 3 lines of context and
//! `formatPatch(…, FILE_HEADERS_ONLY)`).
//!
//! The line diff is Myers' algorithm, bounded like T3's call: at most 1,000 edits when both
//! sides have text (no preview past that), unbounded when one side is empty. Where several
//! shortest diffs exist, jsdiff may pick another one; the hunks then differ in placement, not
//! in what they change.

use serde_json::Value;

const MAX_EDITS: usize = 1_000;
const CONTEXT: usize = 3;

fn diffs(content: &Value) -> Vec<&Value> {
    content
        .as_array()
        .map(|items| items.iter().filter(|e| e["type"] == "diff").collect())
        .unwrap_or_default()
}

/// `acpToolCallDiffUnpreviewable`.
pub(crate) fn unpreviewable(content: &Value) -> bool {
    content.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|e| matches!(e["patch"]["format"].as_str(), Some("omitted" | "snippet")))
    })
}

/// `acpToolCallSnippetEdit`: (old, new) of the one `snippet` diff.
pub(crate) fn snippet_edit(content: &Value) -> Option<(String, String)> {
    let all = diffs(content);
    let [diff] = all.as_slice() else { return None };
    if diff["patch"]["format"] != "snippet" {
        return None;
    }
    Some((
        diff["oldText"].as_str()?.to_owned(),
        diff["newText"].as_str()?.to_owned(),
    ))
}

/// `acpToolCallDiffPatch`.
pub(crate) fn tool_call_diff_patch(content: &Value) -> Option<String> {
    if !content.is_array() || unpreviewable(content) {
        return None;
    }
    let mut patches: Vec<(String, Option<String>)> = Vec::new();
    for diff in diffs(content) {
        if let Some(text) = diff["patch"]["text"].as_str() {
            let change = diff["changes"]
                .as_array()
                .filter(|c| c.len() == 1)
                .and_then(|c| c.first());
            let path = change.and_then(|c| c["path"].as_str());
            if diff["patch"]["format"] == "git_patch"
                && text.trim_start().starts_with("@@ ")
                && let (Some(change), Some(path)) = (change, path)
            {
                let old_path = change["oldPath"].as_str().unwrap_or(path);
                let quoted = |s: String| serde_json::to_string(&s).unwrap_or_default();
                let before = if change["operation"] == "add" {
                    "/dev/null".to_owned()
                } else {
                    quoted(format!("a/{old_path}"))
                };
                let after = if change["operation"] == "delete" {
                    "/dev/null".to_owned()
                } else {
                    quoted(format!("b/{path}"))
                };
                patches.push((
                    format!(
                        "diff --git {} {}\n--- {before}\n+++ {after}\n{}",
                        quoted(format!("a/{old_path}")),
                        quoted(format!("b/{path}")),
                        text.trim_start()
                    ),
                    None,
                ));
            } else {
                patches.push((text.to_owned(), None));
            }
            continue;
        }
        let (Some(path), Some(new_text)) = (diff["path"].as_str(), diff["newText"].as_str()) else {
            continue;
        };
        let old_text = diff["oldText"].as_str();
        let old_name = if old_text.is_some() {
            path
        } else {
            "/dev/null"
        };
        let old = old_text.unwrap_or("");
        let bounded = !old.is_empty() && !new_text.is_empty();
        if let Some(patch) = unified(old_name, path, old, new_text, bounded)
            && !patch.is_empty()
        {
            patches.push((patch, Some(path.to_owned())));
        }
    }
    if patches.is_empty() {
        return None;
    }
    let has_git = patches
        .iter()
        .any(|(text, _)| text.starts_with("diff --git ") || text.contains("\ndiff --git "));
    let quoted = |s: String| serde_json::to_string(&s).unwrap_or_default();
    Some(
        patches
            .into_iter()
            .map(|(text, path)| match path {
                Some(path) if has_git => format!(
                    "diff --git {} {}\n{text}",
                    quoted(format!("a/{path}")),
                    quoted(format!("b/{path}"))
                ),
                _ => text,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// jsdiff's line tokens: each line keeps its newline.
fn lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(at) => {
                let (line, tail) = rest.split_at(at + 1);
                out.push(line);
                rest = tail;
            }
            None => {
                out.push(rest);
                rest = "";
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Same,
    Del,
    Add,
}

/// Myers' shortest edit script, deletions before insertions. `None` past the bound.
fn edit_script(a: &[&str], b: &[&str], bounded: bool) -> Option<Vec<Op>> {
    let n = a.len();
    let m = b.len();
    let max = n + m;
    let limit = if bounded { MAX_EDITS.min(max) } else { max };
    let offset = max + 1;
    let mut v = vec![0usize; 2 * max + 3];
    let mut trace: Vec<Vec<usize>> = Vec::new();
    let mut found = None;
    for d in 0..=limit {
        trace.push(v.clone());
        let mut k = -(d as isize);
        while k <= d as isize {
            let idx = (k + offset as isize) as usize;
            let down = k == -(d as isize)
                || (k != d as isize && v.get(idx - 1).copied() < v.get(idx + 1).copied());
            let mut x = if down {
                v.get(idx + 1).copied().unwrap_or(0)
            } else {
                v.get(idx - 1).copied().unwrap_or(0) + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a.get(x) == b.get(y) {
                x += 1;
                y += 1;
            }
            if let Some(slot) = v.get_mut(idx) {
                *slot = x;
            }
            if x >= n && y >= m {
                found = Some(d);
                break;
            }
            k += 2;
        }
        if found.is_some() {
            break;
        }
    }
    let d_final = found?;
    // Backtrack.
    let mut ops = Vec::new();
    let (mut x, mut y) = (n as isize, m as isize);
    for d in (0..=d_final).rev() {
        let v = trace.get(d)?;
        let k = x - y;
        let idx = |k: isize| (k + offset as isize) as usize;
        let down = k == -(d as isize)
            || (k != d as isize && v.get(idx(k - 1)).copied() < v.get(idx(k + 1)).copied());
        let prev_k = if down { k + 1 } else { k - 1 };
        let prev_x = v.get(idx(prev_k)).copied().unwrap_or(0) as isize;
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            ops.push(Op::Same);
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            ops.push(if down { Op::Add } else { Op::Del });
        }
        x = prev_x;
        y = prev_y;
    }
    ops.reverse();
    Some(ops)
}

fn push_line(out: &mut String, sign: char, line: &str) {
    out.push(sign);
    match line.strip_suffix('\n') {
        Some(body) => {
            out.push_str(body);
            out.push('\n');
        }
        None => {
            out.push_str(line);
            out.push_str("\n\\ No newline at end of file\n");
        }
    }
}

/// `structuredPatch` + `formatPatch(…, FILE_HEADERS_ONLY)`. `None` past the edit bound;
/// an empty string when nothing changed.
fn unified(old_name: &str, new_name: &str, old: &str, new: &str, bounded: bool) -> Option<String> {
    let a = lines(old);
    let b = lines(new);
    let ops = edit_script(&a, &b, bounded)?;
    // Each op with its old and new line index.
    let mut rows = Vec::with_capacity(ops.len());
    let (mut i, mut j) = (0usize, 0usize);
    for op in ops {
        rows.push((op, i, j));
        match op {
            Op::Same => {
                i += 1;
                j += 1;
            }
            Op::Del => i += 1,
            Op::Add => j += 1,
        }
    }
    let changed: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.0 != Op::Same)
        .map(|(at, _)| at)
        .collect();
    if changed.is_empty() {
        return Some(String::new());
    }
    // Group changes whose gap of unchanged rows is at most 2 * CONTEXT.
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for at in changed {
        match groups.last_mut() {
            Some((_, end)) if at - *end <= 2 * CONTEXT + 1 => *end = at,
            _ => groups.push((at, at)),
        }
    }
    let mut out = format!("--- {old_name}\n+++ {new_name}\n");
    for (first, last) in groups {
        let start = first.saturating_sub(CONTEXT);
        let end = (last + CONTEXT + 1).min(rows.len());
        let slice = rows.get(start..end)?;
        let old_lines = slice.iter().filter(|r| r.0 != Op::Add).count();
        let new_lines = slice.iter().filter(|r| r.0 != Op::Del).count();
        let (_, first_old, first_new) = *slice.first()?;
        let old_start = if old_lines == 0 {
            first_old
        } else {
            first_old + 1
        };
        let new_start = if new_lines == 0 {
            first_new
        } else {
            first_new + 1
        };
        out.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        for (op, oi, nj) in slice {
            match op {
                Op::Same => push_line(&mut out, ' ', a.get(*oi).copied().unwrap_or("")),
                Op::Del => push_line(&mut out, '-', a.get(*oi).copied().unwrap_or("")),
                Op::Add => push_line(&mut out, '+', b.get(*nj).copied().unwrap_or("")),
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_new_file_matches_jsdiff() {
        let content = json!([{"type": "diff", "path": "/w/a.txt", "oldText": "", "newText": "codex app-server approval fixture"}]);
        assert_eq!(
            tool_call_diff_patch(&content).unwrap(),
            "--- /w/a.txt\n+++ /w/a.txt\n@@ -0,0 +1,1 @@\n+codex app-server approval fixture\n\\ No newline at end of file\n"
        );
    }

    #[test]
    fn a_change_in_the_middle_keeps_three_lines_of_context() {
        let old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
        let new = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
        assert_eq!(
            unified("a", "a", old, new, true).unwrap(),
            "--- a\n+++ a\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n"
        );
    }
}
