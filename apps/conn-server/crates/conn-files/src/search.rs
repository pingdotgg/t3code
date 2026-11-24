//! `projects.searchEntries` (fuzzy path search) and `projects.searchContents` (grep). Both
//! stream the walk in [`crate::entries::walk_files`] and keep only the best `limit` results, so
//! memory stays bounded by the limit, not the workspace.

use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant},
};

use conn_contract::{
    ProjectContentMatch, ProjectContentMatchRange, ProjectEntry, ProjectEntryKind,
    ProjectListEntriesResult as ProjectSearchEntriesResult, ProjectSearchContentsInput,
    ProjectSearchContentsResult, ProjectSearchEntriesInput,
};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

use nucleo_matcher::{
    Utf32Str,
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
};

use crate::{
    entries::{FileLinks, WalkEnd, walk_files},
    mime,
    paths::InternalPaths,
};

/// `CONTENT_SEARCH_MAX_MATCHES_PER_FILE`.
const MAX_MATCHES_PER_FILE: usize = 100;
/// fff caps `lineContent` at 512 characters.
const MAX_LINE_CHARS: usize = 512;
/// The TypeScript server spends 250 ms in a warm index. A cold walk needs longer for the same
/// answer, so the budget is larger; the result says `truncated` when it runs out.
const CONTENT_TIME_BUDGET: Duration = Duration::from_millis(1500);
/// The longest line content search holds; a file with a longer one is searched up to it and
/// the result says `truncated`. Files of any size stream through a buffer this size at most.
const CONTENT_MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// `normalizeSearchQuery(query, { trimLeadingPattern: /^[@./]+/ })`, then fff's quirk: `[`
/// starts a glob it cannot escape, so it is dropped.
fn normalize_query(query: &str) -> String {
    query
        .trim()
        .trim_start_matches(['@', '.', '/'])
        .to_lowercase()
        .replace('[', "")
}

/// Fuzzy path scoring with nucleo (the matcher helix uses), set up for paths: a match in
/// the file name and at segment starts ranks higher. Higher is better; `None` is no match.
struct Scorer {
    matcher: nucleo_matcher::Matcher,
    pattern: Option<Pattern>,
    glob: Option<String>,
    buffer: Vec<char>,
}

impl Scorer {
    fn new(query: &str) -> Self {
        let glob = query.contains(['*', '?']).then(|| query.to_owned());
        let pattern = (!query.is_empty() && glob.is_none()).then(|| {
            Pattern::new(
                query,
                CaseMatching::Ignore,
                Normalization::Smart,
                AtomKind::Fuzzy,
            )
        });
        Self {
            matcher: nucleo_matcher::Matcher::new(nucleo_matcher::Config::DEFAULT.match_paths()),
            pattern,
            glob,
            buffer: Vec::new(),
        }
    }

    fn score(&mut self, path: &str) -> Option<i64> {
        let length_penalty = path.len() as i64 + path.matches('/').count() as i64 * 4;
        if let Some(glob) = &self.glob {
            let lower = path.to_lowercase();
            return glob_match(glob.as_bytes(), lower.as_bytes()).then_some(-length_penalty);
        }
        let Some(pattern) = &self.pattern else {
            return Some(-length_penalty);
        };
        let haystack = Utf32Str::new(path, &mut self.buffer);
        let score = i64::from(pattern.score(haystack, &mut self.matcher)?);
        Some(score * 64 - length_penalty)
    }
}

/// `*` and `?` over the whole path.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

/// Keeps the best `limit` scored entries seen so far.
struct TopK {
    limit: usize,
    items: Vec<(i64, ProjectEntry)>,
    matched: usize,
}

impl TopK {
    fn push(&mut self, score: i64, entry: ProjectEntry) {
        self.matched += 1;
        self.items.push((score, entry));
        if self.items.len() >= self.limit * 4 + 16 {
            self.trim();
        }
    }

    fn trim(&mut self) {
        self.items.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.path.len().cmp(&b.1.path.len()))
                .then_with(|| a.1.path.cmp(&b.1.path))
        });
        self.items.truncate(self.limit);
    }
}

/// `projects.searchEntries` under the normalized `root`.
pub fn search_entries(
    root: &Path,
    input: &ProjectSearchEntriesInput,
    internal: &InternalPaths,
) -> ProjectSearchEntriesResult {
    let limit = input.limit.clamp(1, 200) as usize;
    let image_only = input.image_only == Some(true);
    let want_files = input.kind != Some(ProjectEntryKind::Directory);
    let want_dirs = input.kind != Some(ProjectEntryKind::File) && !image_only;
    let mut query = normalize_query(&input.query);
    let run = |query: &str| {
        let mut scorer = Scorer::new(query);
        let mut top = TopK {
            limit,
            items: Vec::new(),
            matched: 0,
        };
        let mut seen_dirs: HashSet<String> = HashSet::new();
        let end = walk_files(root, internal, FileLinks::Listed, None, &mut |path| {
            if want_dirs {
                let mut rest = path;
                while let Some(i) = rest.rfind('/') {
                    rest = &rest[..i];
                    if seen_dirs.contains(rest) {
                        break;
                    }
                    seen_dirs.insert(rest.to_owned());
                    if let Some(s) = scorer.score(rest) {
                        top.push(s, entry(rest, ProjectEntryKind::Directory));
                    }
                }
            }
            if want_files
                && (!image_only || mime::is_favicon_path(path))
                && let Some(s) = scorer.score(path)
            {
                top.push(s, entry(path, ProjectEntryKind::File));
            }
            true
        });
        top.trim();
        (top, end)
    };
    let (mut top, mut end) = run(&query);
    // fff reads `{` as a glob too; "*.{ts,tsx}" keeps working, a stray `{` is retried without.
    if top.items.is_empty() && query.contains('{') {
        query = query.replace('{', "");
        (top, end) = run(&query);
    }
    ProjectSearchEntriesResult {
        truncated: top.matched > limit || end == WalkEnd::Bounded,
        entries: top.items.into_iter().map(|(_, e)| e).collect(),
    }
}

fn entry(path: &str, kind: ProjectEntryKind) -> ProjectEntry {
    ProjectEntry {
        path: path.to_owned(),
        kind,
        ignored: None,
    }
}

/// Builds the content matcher. An invalid regex falls back to a literal search and reports why.
/// `None` when even the literal does not compile (a query past the regex size limit).
fn content_matcher(input: &ProjectSearchContentsInput) -> Option<(RegexMatcher, Option<String>)> {
    let build = |pattern: &str| {
        RegexMatcherBuilder::new()
            .case_insensitive(!input.case_sensitive)
            .build(pattern)
    };
    let literal = || build(&regex_syntax::escape(&input.query)).ok();
    if !input.use_regex {
        return Some((literal()?, None));
    }
    match build(&input.query) {
        Ok(matcher) => Some((matcher, None)),
        Err(error) => Some((literal()?, Some(error.to_string()))),
    }
}

/// Byte ranges of the matches in `line` that end by `until`, the shown preview's end: a long
/// line's later matches are never shown, so they are not collected.
fn find_all(matcher: &RegexMatcher, line: &str, until: usize) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let _ = matcher.find_iter(line.as_bytes(), |m| {
        if m.end() > until {
            return false;
        }
        found.push((m.start(), m.end()));
        true
    });
    found
}

/// A file read that fails with `TimedOut` once `expired` says so, so a long file stops
/// between buffered reads, not only at a matching line.
struct Budgeted<'a, R> {
    inner: R,
    expired: &'a dyn Fn() -> bool,
}

impl<R: std::io::Read> std::io::Read for Budgeted<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if (self.expired)() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "the content search time budget ran out",
            ));
        }
        self.inner.read(buf)
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `isWholeWordRange`, on byte offsets.
fn whole_word(line: &str, start: usize, end: usize) -> bool {
    if end <= start {
        return false;
    }
    let before = line[..start].chars().next_back();
    let first = line[start..].chars().next();
    let last = line[..end].chars().next_back();
    let after = line[end..].chars().next();
    let left = start == 0 || !before.is_some_and(is_word) || !first.is_some_and(is_word);
    let right = end >= line.len() || !after.is_some_and(is_word) || !last.is_some_and(is_word);
    left && right
}

fn utf16_index(line: &str, byte: usize) -> i64 {
    line[..byte].encode_utf16().count() as i64
}

/// `projects.searchContents` under the normalized `root`: matching lines of non-binary files,
/// at most `limit`, within a time budget.
pub fn search_contents(
    root: &Path,
    input: &ProjectSearchContentsInput,
    internal: &InternalPaths,
) -> ProjectSearchContentsResult {
    let deadline = Instant::now() + CONTENT_TIME_BUDGET;
    search_contents_until(root, input, internal, deadline, &|| {
        Instant::now() >= deadline
    })
}

/// [`search_contents`] with its budget: the walk stops at `deadline`, a file read once
/// `expired` says so.
fn search_contents_until(
    root: &Path,
    input: &ProjectSearchContentsInput,
    internal: &InternalPaths,
    deadline: Instant,
    expired: &dyn Fn() -> bool,
) -> ProjectSearchContentsResult {
    let limit = input.limit.clamp(1, 500) as usize;
    let Some((matcher, regex_fallback_error)) = content_matcher(input) else {
        return ProjectSearchContentsResult {
            matches: Vec::new(),
            truncated: false,
            regex_fallback_error: Some("The query is too long to search.".into()),
        };
    };
    let mut matches: Vec<ProjectContentMatch> = Vec::new();
    // ripgrep's searcher reads line by line in a bounded buffer and skips binary files.
    let mut searcher = grep_searcher::SearcherBuilder::new()
        .binary_detection(grep_searcher::BinaryDetection::quit(0))
        .line_number(true)
        .heap_limit(Some(CONTENT_MAX_LINE_BYTES))
        .build();
    // A file left part-read by the line limit or the time budget.
    let mut cut = false;
    let end = walk_files(
        root,
        internal,
        FileLinks::Skipped,
        Some(deadline),
        &mut |path| {
            let full = root.join(path);
            let mut in_file = 0;
            let mut late = false;
            let sink = grep_searcher::sinks::Lossy(|line_number, line: &str| {
                if expired() {
                    late = true;
                    return Ok(false);
                }
                let line = line.trim_end_matches(['\n', '\r']);
                let shown_end = line
                    .char_indices()
                    .nth(MAX_LINE_CHARS)
                    .map_or(line.len(), |(i, _)| i);
                let ranges: Vec<ProjectContentMatchRange> = find_all(&matcher, line, shown_end)
                    .into_iter()
                    .filter(|&(start, end)| {
                        line.is_char_boundary(start) && line.is_char_boundary(end)
                    })
                    .filter(|&(start, end)| !input.whole_word || whole_word(line, start, end))
                    .map(|(start, end)| ProjectContentMatchRange {
                        start: utf16_index(line, start),
                        end: utf16_index(line, end),
                    })
                    .collect();
                if input.whole_word && ranges.is_empty() {
                    return Ok(true);
                }
                matches.push(ProjectContentMatch {
                    path: path.to_owned(),
                    line_number: line_number as i64,
                    line_content: line[..shown_end].to_owned(),
                    match_ranges: ranges,
                });
                in_file += 1;
                Ok(matches.len() <= limit && in_file < MAX_MATCHES_PER_FILE)
            });
            let searched = std::fs::File::open(&full).and_then(|file| {
                let reader = Budgeted {
                    inner: file,
                    expired,
                };
                searcher.search_reader(&matcher, reader, sink)
            });
            // A file that vanished or cannot be read is not part of the answer; a line over the
            // limit, or the budget running out mid-file, leaves the rest unread.
            if late
                || searched.is_err_and(|e| {
                    !matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                    )
                })
            {
                cut = true;
            }
            matches.len() <= limit && !expired()
        },
    );
    let truncated = cut || matches.len() > limit || end != WalkEnd::Complete;
    matches.truncate(limit);
    ProjectSearchContentsResult {
        matches,
        truncated,
        regex_fallback_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_name_matches_first() {
        let mut main = Scorer::new("main");
        let name = main.score("src/main.rs").unwrap();
        let fuzzy = main.score("src/my_arch_impl_name.rs").unwrap();
        assert!(name > fuzzy, "{name} {fuzzy}");
        assert_eq!(Scorer::new("zz").score("src/lib.rs"), None);
        assert!(Scorer::new("*.ts").score("a/b/c.ts").is_some());
        assert!(Scorer::new("*.ts").score("a/b/c.tsx").is_none());
        assert_eq!(normalize_query("  @./Foo[1]"), "foo1]");
    }

    /// The budget running out inside a long file with no match ends the search there and
    /// says the answer is partial.
    #[test]
    fn a_long_file_stops_at_the_budget() {
        let root = std::env::temp_dir().join(format!("conn-search-budget-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("large.txt"), "filler\n".repeat(2_000_000)).unwrap();
        let input = ProjectSearchContentsInput {
            cwd: String::new(),
            query: "absent".into(),
            limit: 10,
            case_sensitive: true,
            whole_word: false,
            use_regex: false,
        };
        let reads = std::cell::Cell::new(0);
        let expired = || {
            reads.set(reads.get() + 1);
            reads.get() > 3
        };
        let internal = InternalPaths::new(&root.join("state"));
        let far = Instant::now() + Duration::from_secs(3600);
        let found = search_contents_until(&root, &input, &internal, far, &expired);
        assert!(found.matches.is_empty());
        assert!(found.truncated, "the file was not read to its end");
        assert!(
            reads.get() < 10,
            "stopped right after the budget: {} checks",
            reads.get()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// Only the matches inside the shown preview are collected, however many follow.
    #[test]
    fn collects_matches_only_up_to_the_preview() {
        let matcher = RegexMatcherBuilder::new().build("ab").unwrap();
        let line = "ab".repeat(100_000);
        assert_eq!(find_all(&matcher, &line, 6), [(0, 2), (2, 4), (4, 6)]);
    }

    #[test]
    fn whole_words_and_utf16_offsets() {
        assert!(whole_word("let foo = 1", 4, 7));
        assert!(!whole_word("let foobar = 1", 4, 7));
        assert_eq!(utf16_index("😀ab", "😀".len()), 2);
    }
}
