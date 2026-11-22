//! Pure-Rust unified diff parser for `orchestration.getFullThreadDiff`.

/// Kind of a single line inside a unified diff hunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DiffLineKind {
    Context,
    Added,
    Removed,
}

/// One line inside a unified diff hunk, with optional old/new line numbers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffLine {
    pub(crate) kind: DiffLineKind,
    pub(crate) old_line: Option<u32>,
    pub(crate) new_line: Option<u32>,
    pub(crate) text: String,
}

/// One `@@ -old +new @@` hunk in a diffed file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffHunk {
    pub(crate) header: String,
    pub(crate) old_start: u32,
    pub(crate) old_count: u32,
    pub(crate) new_start: u32,
    pub(crate) new_count: u32,
    pub(crate) lines: Vec<DiffLine>,
}

/// Parsed diff for a single changed file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiffFile {
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: Option<String>,
    pub(crate) display_path: String,
    pub(crate) additions: usize,
    pub(crate) deletions: usize,
    pub(crate) is_binary: bool,
    pub(crate) hunks: Vec<DiffHunk>,
}

/// Parses a unified diff patch string into structured per-file diffs with hunks,
/// line numbers, and addition/deletion counts.
#[must_use]
pub(crate) fn parse_unified_diff(patch: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current_file: Option<DiffFile> = None;
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_cursor: u32 = 0;
    let mut new_cursor: u32 = 0;

    let flush_hunk = |file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>| {
        if let (Some(f), Some(h)) = (file.as_mut(), hunk.take()) {
            f.hunks.push(h);
        }
    };

    let flush_file =
        |files: &mut Vec<DiffFile>, file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>| {
            flush_hunk(file, hunk);
            if let Some(mut f) = file.take() {
                f.display_path = resolve_display_path(f.old_path.as_deref(), f.new_path.as_deref());
                files.push(f);
            }
        };

    for raw_line in patch.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        if let Some(rest) = line.strip_prefix("diff --git ") {
            flush_file(&mut files, &mut current_file, &mut current_hunk);
            let (old_p, new_p) = parse_git_header_paths(rest);
            current_file = Some(DiffFile {
                old_path: old_p,
                new_path: new_p,
                display_path: String::new(),
                additions: 0,
                deletions: 0,
                is_binary: false,
                hunks: Vec::new(),
            });
            continue;
        }

        if let Some(path) = line.strip_prefix("--- ") {
            if current_file.is_none() {
                current_file = Some(DiffFile {
                    old_path: None,
                    new_path: None,
                    display_path: String::new(),
                    additions: 0,
                    deletions: 0,
                    is_binary: false,
                    hunks: Vec::new(),
                });
            }
            if let Some(file) = current_file.as_mut() {
                file.old_path = clean_diff_path(path);
            }
            continue;
        }

        if let Some(path) = line.strip_prefix("+++ ") {
            if let Some(file) = current_file.as_mut() {
                file.new_path = clean_diff_path(path);
            }
            continue;
        }

        if let Some(renamed_from) = line.strip_prefix("rename from ") {
            if let Some(file) = current_file.as_mut() {
                file.old_path = Some(renamed_from.to_owned());
            }
            continue;
        }

        if let Some(renamed_to) = line.strip_prefix("rename to ") {
            if let Some(file) = current_file.as_mut() {
                file.new_path = Some(renamed_to.to_owned());
            }
            continue;
        }

        if line.starts_with("Binary files ") || line == "GIT binary patch" {
            if let Some(file) = current_file.as_mut() {
                file.is_binary = true;
            }
            continue;
        }

        if line.starts_with("@@ ")
            && let Some((old_start, old_count, new_start, new_count)) = parse_hunk_header(line)
        {
            flush_hunk(&mut current_file, &mut current_hunk);
            old_cursor = old_start;
            new_cursor = new_start;
            current_hunk = Some(DiffHunk {
                header: line.to_owned(),
                old_start,
                old_count,
                new_start,
                new_count,
                lines: Vec::new(),
            });
            continue;
        }

        let Some(hunk) = current_hunk.as_mut() else {
            continue;
        };

        if let Some(added) = line.strip_prefix('+') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Added,
                old_line: None,
                new_line: Some(new_cursor),
                text: added.to_owned(),
            });
            new_cursor = new_cursor.saturating_add(1);
            if let Some(file) = current_file.as_mut() {
                file.additions += 1;
            }
        } else if let Some(removed) = line.strip_prefix('-') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Removed,
                old_line: Some(old_cursor),
                new_line: None,
                text: removed.to_owned(),
            });
            old_cursor = old_cursor.saturating_add(1);
            if let Some(file) = current_file.as_mut() {
                file.deletions += 1;
            }
        } else if let Some(ctx) = line.strip_prefix(' ') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Context,
                old_line: Some(old_cursor),
                new_line: Some(new_cursor),
                text: ctx.to_owned(),
            });
            old_cursor = old_cursor.saturating_add(1);
            new_cursor = new_cursor.saturating_add(1);
        } else if line.starts_with("\\ No newline at end of file") {
            // Informational marker; does not advance line numbers.
        }
    }

    flush_file(&mut files, &mut current_file, &mut current_hunk);
    files
}

fn clean_diff_path(raw: &str) -> Option<String> {
    let trimmed = raw.split('\t').next().unwrap_or(raw).trim();
    if trimmed == "/dev/null" || trimmed.is_empty() {
        return None;
    }
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    let stripped = unquoted
        .strip_prefix("a/")
        .or_else(|| unquoted.strip_prefix("b/"))
        .unwrap_or(unquoted);
    Some(stripped.to_owned())
}

fn parse_git_header_paths(rest: &str) -> (Option<String>, Option<String>) {
    let mut parts = rest.split_whitespace();
    let old_p = parts.next().and_then(clean_diff_path);
    let new_p = parts.next().and_then(clean_diff_path);
    (old_p, new_p)
}

fn resolve_display_path(old_path: Option<&str>, new_path: Option<&str>) -> String {
    match (old_path, new_path) {
        (Some(old), Some(new)) if old != new => format!("{old} -> {new}"),
        (_, Some(new)) => new.to_owned(),
        (Some(old), None) => old.to_owned(),
        (None, None) => "(unknown)".to_owned(),
    }
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let after_open = line.strip_prefix("@@ ")?;
    let end_idx = after_open.find(" @@")?;
    let range_spec = &after_open[..end_idx];
    let mut parts = range_spec.split_whitespace();
    let old_spec = parts.next()?.strip_prefix('-')?;
    let new_spec = parts.next()?.strip_prefix('+')?;
    let (old_start, old_count) = parse_range(old_spec)?;
    let (new_start, new_count) = parse_range(new_spec)?;
    Some((old_start, old_count, new_start, new_count))
}

fn parse_range(spec: &str) -> Option<(u32, u32)> {
    match spec.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((spec.parse().ok()?, 1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multi_file_unified_diff_with_counts_and_line_numbers() {
        let patch = "\
diff --git a/src/lib.rs b/src/lib.rs
index 1234567..89abcdef 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,4 +10,5 @@ fn demo() {
 let a = 1;
-let b = 2;
+let b = 20;
+let c = 30;
 let d = 4;
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello world
\\ No newline at end of file
";
        let files = parse_unified_diff(patch);
        assert_eq!(files.len(), 2, "expected 2 files in patch");

        let first = &files[0];
        assert_eq!(first.display_path, "src/lib.rs", "first file path");
        assert_eq!(first.additions, 2, "first file additions");
        assert_eq!(first.deletions, 1, "first file deletions");
        assert_eq!(first.hunks.len(), 1, "first file hunk count");

        let hunk = &first.hunks[0];
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_count,
                hunk.new_start,
                hunk.new_count
            ),
            (10, 4, 10, 5),
            "parsed hunk range"
        );
        assert_eq!(hunk.lines.len(), 5, "hunk line count");
        assert_eq!(
            (
                hunk.lines[0].kind,
                hunk.lines[0].old_line,
                hunk.lines[0].new_line
            ),
            (DiffLineKind::Context, Some(10), Some(10)),
            "context line numbers"
        );
        assert_eq!(
            (
                hunk.lines[1].kind,
                hunk.lines[1].old_line,
                hunk.lines[1].new_line
            ),
            (DiffLineKind::Removed, Some(11), None),
            "removed line number"
        );
        assert_eq!(
            (
                hunk.lines[2].kind,
                hunk.lines[2].old_line,
                hunk.lines[2].new_line
            ),
            (DiffLineKind::Added, None, Some(11)),
            "first added line number"
        );
        assert_eq!(
            (
                hunk.lines[3].kind,
                hunk.lines[3].old_line,
                hunk.lines[3].new_line
            ),
            (DiffLineKind::Added, None, Some(12)),
            "second added line number"
        );
        assert_eq!(
            (
                hunk.lines[4].kind,
                hunk.lines[4].old_line,
                hunk.lines[4].new_line
            ),
            (DiffLineKind::Context, Some(12), Some(13)),
            "trailing context line numbers"
        );

        let second = &files[1];
        assert_eq!(second.old_path, None, "new file has no old_path");
        assert_eq!(
            second.new_path.as_deref(),
            Some("new.txt"),
            "new file has new_path"
        );
        assert_eq!(second.additions, 1, "new file additions");
        assert_eq!(second.deletions, 0, "new file deletions");
        assert_eq!(
            second.hunks[0].new_count, 1,
            "single-line hunk omits comma count"
        );
    }

    #[test]
    fn parses_rename_and_binary_and_empty_patch() {
        assert!(
            parse_unified_diff("").is_empty(),
            "empty patch yields no files"
        );

        let patch = "\
diff --git a/old.png b/new.png
similarity index 100%
rename from old.png
rename to new.png
Binary files a/old.png and b/new.png differ
";
        let files = parse_unified_diff(patch);
        assert_eq!(files.len(), 1, "expected 1 binary renamed file");
        assert_eq!(
            files[0].display_path, "old.png -> new.png",
            "renamed file display path"
        );
        assert!(files[0].is_binary, "binary flag should be set");
    }
}
