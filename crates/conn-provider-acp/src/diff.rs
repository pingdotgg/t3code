//! The unified diff T3 shows for an ACP `diff` tool content (`acpToolCallDiffPatch` in
//! `adapter.ts`, which uses jsdiff's `structuredPatch` with 3 lines of context and
//! `formatPatch(…, FILE_HEADERS_ONLY)`).
//!
//! The line diff is Myers' algorithm, bounded like T3's call: at most 1,000 edits when both
//! sides have text (no preview past that); when one side is empty, the other side is the one
//! hunk. The search keeps only the diagonals each step reads, so its memory grows with the
//! square of the edits, never of the line count. Where several
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

/// The `v` arrays of Myers' forward search, one per edit count `d`, each holding only the
/// diagonals `-(d+1)..=d+1` that step `d` reads. Memory grows with the square of the edits,
/// not of the line count: at most about 8 MB at [`MAX_EDITS`].
struct Trace {
    steps: Vec<Box<[usize]>>,
}

impl Trace {
    /// `v[k]` as step `d` saw it before it ran.
    fn get(&self, d: usize, k: isize) -> usize {
        let at = k + d as isize + 1;
        usize::try_from(at)
            .ok()
            .and_then(|at| self.steps.get(d)?.get(at).copied())
            .unwrap_or(0)
    }

    /// The forward search: the trace and the edit count of the shortest script, `None` past
    /// `limit`.
    fn search(a: &[&str], b: &[&str], limit: usize) -> (Self, Option<usize>) {
        let n = a.len();
        let m = b.len();
        let max = n + m;
        let offset = max + 1;
        let mut v = vec![0usize; 2 * max + 3];
        let mut trace = Self { steps: Vec::new() };
        for d in 0..=limit {
            let low = offset - d - 1;
            trace.steps.push(
                v.get(low..=offset + d + 1)
                    .unwrap_or_default()
                    .to_vec()
                    .into_boxed_slice(),
            );
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
                    return (trace, Some(d));
                }
                k += 2;
            }
        }
        (trace, None)
    }

    /// The number of `v` entries kept.
    #[cfg(test)]
    fn entries(&self) -> usize {
        self.steps.iter().map(|step| step.len()).sum()
    }
}

/// Myers' shortest edit script, deletions before insertions. `None` past the bound. When one
/// side is empty the script is that side, written directly.
fn edit_script(a: &[&str], b: &[&str], bounded: bool) -> Option<Vec<Op>> {
    let n = a.len();
    let m = b.len();
    if n == 0 || m == 0 {
        let mut ops = vec![Op::Del; n];
        ops.extend(std::iter::repeat_n(Op::Add, m));
        return Some(ops);
    }
    let max = n + m;
    let limit = if bounded { MAX_EDITS.min(max) } else { max };
    let (trace, found) = Trace::search(a, b, limit);
    let d_final = found?;
    // Backtrack.
    let mut ops = Vec::new();
    let (mut x, mut y) = (n as isize, m as isize);
    for d in (0..=d_final).rev() {
        let k = x - y;
        let down =
            k == -(d as isize) || (k != d as isize && trace.get(d, k - 1) < trace.get(d, k + 1));
        let prev_k = if down { k + 1 } else { k - 1 };
        let prev_x = trace.get(d, prev_k) as isize;
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

#[cfg(test)]
mod cost_tests {
    use super::*;

    /// The search as it was before it kept only the live diagonals: a full copy of `v` per
    /// step. The oracle for byte-equal output.
    fn full_trace_script(a: &[&str], b: &[&str], bounded: bool) -> Option<Vec<Op>> {
        let n = a.len();
        let m = b.len();
        let max = n + m;
        let limit = if bounded { MAX_EDITS.min(max) } else { max };
        let offset = max + 1;
        let mut v = vec![0usize; 2 * max + 3];
        let mut trace: Vec<Vec<usize>> = Vec::new();
        let mut found = None;
        'outer: for d in 0..=limit {
            trace.push(v.clone());
            let mut k = -(d as isize);
            while k <= d as isize {
                let idx = (k + offset as isize) as usize;
                let down = k == -(d as isize) || (k != d as isize && v[idx - 1] < v[idx + 1]);
                let mut x = if down { v[idx + 1] } else { v[idx - 1] + 1 };
                let mut y = (x as isize - k) as usize;
                while x < n && y < m && a[x] == b[y] {
                    x += 1;
                    y += 1;
                }
                v[idx] = x;
                if x >= n && y >= m {
                    found = Some(d);
                    break 'outer;
                }
                k += 2;
            }
        }
        let d_final = found?;
        let mut ops = Vec::new();
        let (mut x, mut y) = (n as isize, m as isize);
        for d in (0..=d_final).rev() {
            let v = &trace[d];
            let k = x - y;
            let idx = |k: isize| (k + offset as isize) as usize;
            let down = k == -(d as isize) || (k != d as isize && v[idx(k - 1)] < v[idx(k + 1)]);
            let prev_k = if down { k + 1 } else { k - 1 };
            let prev_x = v[idx(prev_k)] as isize;
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

    /// A small deterministic generator (xorshift), so a failure repeats.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self, below: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % below
        }
    }

    fn text(rng: &mut Rng, lines: u64, alphabet: u64) -> String {
        let mut out: String = (0..lines)
            .map(|_| format!("{}\n", rng.next(alphabet)))
            .collect();
        if rng.next(3) == 0 {
            out.pop();
        }
        out
    }

    /// The script, and so the patch, is the one the full trace gives, for every input shape:
    /// empty sides, no final newline, repeats, and over the bound.
    #[test]
    fn the_script_is_the_full_trace_script() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for case in 0..3_000 {
            let (lines_old, alphabet) = (rng.next(40), 1 + rng.next(6));
            let old = text(&mut rng, lines_old, alphabet);
            let lines_new = rng.next(40);
            let new = text(&mut rng, lines_new, alphabet);
            let (a, b) = (lines(&old), lines(&new));
            for bounded in [true, false] {
                assert_eq!(
                    edit_script(&a, &b, bounded),
                    full_trace_script(&a, &b, bounded),
                    "case {case}: {old:?} -> {new:?}"
                );
            }
        }
        let wide: Vec<String> = (0..1_200).map(|i| format!("{i}\n")).collect();
        let a: Vec<&str> = wide.iter().map(String::as_str).collect();
        let b: Vec<&str> = a.iter().rev().copied().collect();
        assert_eq!(edit_script(&a, &b, true), None, "past the bound");
        assert_eq!(full_trace_script(&a, &b, true), None);
    }

    /// Finding 2: a 50,000-line new file, and a 50,000-line file with 1,500 changed lines
    /// (past the bound, so no preview), each keep under 10 MB of trace and end in under 5 s
    /// in a debug build. Before, the new file alone needed about 160 GB of trace.
    #[test]
    fn large_files_stay_small_and_quick() {
        const LINES: usize = 50_000;
        const MAX_TRACE_BYTES: usize = 10 << 20;
        let started = std::time::Instant::now();
        let new_text: String = (0..LINES).map(|i| format!("line {i}\n")).collect();
        let content =
            serde_json::json!([{"type": "diff", "path": "/w/a.txt", "newText": new_text}]);
        let patch = tool_call_diff_patch(&content).expect("patch");
        assert!(patch.starts_with("--- /dev/null\n+++ /w/a.txt\n@@ -0,0 +1,50000 @@\n+line 0\n"));
        assert_eq!(patch.lines().count(), LINES + 3);

        let old: Vec<String> = (0..LINES).map(|i| format!("line {i}\n")).collect();
        let mut new = old.clone();
        for i in 0..1_500 {
            if let Some(line) = new.get_mut(i * 33) {
                *line = format!("changed {i}\n");
            }
        }
        let (a, b): (Vec<&str>, Vec<&str>) = (
            old.iter().map(String::as_str).collect(),
            new.iter().map(String::as_str).collect(),
        );
        let (trace, found) = Trace::search(&a, &b, MAX_EDITS);
        assert_eq!(found, None, "1,500 changes are 3,000 edits, past the bound");
        let bytes = trace.entries() * std::mem::size_of::<usize>();
        assert!(bytes < MAX_TRACE_BYTES, "trace {bytes} bytes");
        let content = serde_json::json!([{"type": "diff", "path": "/w/a.txt",
            "oldText": old.concat(), "newText": new.concat()}]);
        assert_eq!(
            tool_call_diff_patch(&content),
            None,
            "no preview past the bound"
        );
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(5),
            "took {elapsed:?}"
        );
    }
}
