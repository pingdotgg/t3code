//! A pull request watch's evaluation and its wake texts, as T3's
//! `apps/server/src/orchestration-v2/pullRequestWatch.ts` decides them:
//! `evaluatePullRequestWatch`, `pullRequestWatchMessage` and `combinePullRequestWatchWakes`.
//! `tools/pr-watch-diff.mjs` runs the same cases through T3's functions and ours.
//!
//! Watches, details and remarks stay JSON: the watch's optional fields mean different things
//! when absent and when `null`, as in T3.

use conn_support::time::{iso_from_millis, millis_from_iso};
use serde_json::{Map, Value, json};

/// `PULL_REQUEST_WATCH_WAKE_LIMIT`: consecutive comment-only wakes before the watch stops.
pub const WAKE_LIMIT: i64 = 10;
/// `PULL_REQUEST_WATCH_NO_CHECKS_MS`.
pub const NO_CHECKS_MS: f64 = 15.0 * 60_000.0;
const LISTED_ITEMS: usize = 10;
const SNIPPET_LENGTH: usize = 200;

/// `PullRequestWatchChange`.
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    ChecksFailed(Vec<Value>),
    ChecksPassed { count: usize, required: bool },
    ChecksAwaitingApproval(Vec<Value>),
    Remarks(Vec<Value>),
    NoChecks(i64),
    Conflicting,
    NeedsRebase,
    MergeQueueRemoved(Option<String>),
}

impl Change {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ChecksFailed(_) => "checks-failed",
            Self::ChecksPassed { .. } => "checks-passed",
            Self::ChecksAwaitingApproval(_) => "checks-awaiting-approval",
            Self::Remarks(_) => "remarks",
            Self::NoChecks(_) => "no-checks",
            Self::Conflicting => "conflicting",
            Self::NeedsRebase => "needs-rebase",
            Self::MergeQueueRemoved(_) => "merge-queue-removed",
        }
    }

    pub fn to_json(&self) -> Value {
        let kind = self.kind();
        match self {
            Self::ChecksFailed(failed) => json!({"kind": kind, "failed": failed}),
            Self::ChecksPassed { count, required } => {
                json!({"kind": kind, "count": count, "required": required})
            }
            Self::ChecksAwaitingApproval(checks) => json!({"kind": kind, "checks": checks}),
            Self::Remarks(remarks) => json!({"kind": kind, "remarks": remarks}),
            Self::NoChecks(minutes) => json!({"kind": kind, "minutes": minutes}),
            Self::Conflicting | Self::NeedsRebase => json!({"kind": kind}),
            Self::MergeQueueRemoved(reason) => json!({"kind": kind, "reason": reason}),
        }
    }

    fn summary(&self) -> &'static str {
        match self {
            Self::ChecksFailed(_) => "checks failed",
            Self::ChecksPassed { .. } => "checks passed",
            Self::ChecksAwaitingApproval(_) => "checks await approval",
            Self::Remarks(_) => "new comments",
            Self::NoChecks(_) => "no checks reported",
            Self::Conflicting => "merge conflict",
            Self::NeedsRebase => "rebase required",
            Self::MergeQueueRemoved(_) => "removed from merge queue",
        }
    }
}

/// `PullRequestWatchReport`.
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub changes: Vec<Change>,
    pub next: Value,
    pub exhausted: bool,
}

/// `Date.parse` on the wire's ISO form; `NaN` where JavaScript's would be.
fn parse(text: &str) -> f64 {
    millis_from_iso(text).map_or(f64::NAN, |ms| ms as f64)
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn status(check: &Value) -> &str {
    string(check, "status").unwrap_or_default()
}

fn is_failed(check: &Value) -> bool {
    matches!(status(check), "failure" | "cancelled")
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JavaScript's `\s` (and what `String.prototype.trim` removes).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `workflowRunOf`: `url.match(/^.*\/actions\/runs\/\d+/)?.[0]`. `.` stops at a line end, and
/// the greedy `.*` takes the last run on the first line.
fn workflow_run_of(url: Option<&str>) -> Option<String> {
    let url = url?;
    let line = url.split(is_line_terminator).next().unwrap_or_default();
    const MARK: &str = "/actions/runs/";
    let mut best = None;
    let mut from = 0;
    while let Some(found) = line.get(from..).and_then(|rest| rest.find(MARK)) {
        let start = from + found;
        let digits_at = start + MARK.len();
        let digits = line
            .get(digits_at..)
            .map(|rest| rest.bytes().take_while(u8::is_ascii_digit).count())
            .unwrap_or(0);
        if digits > 0 {
            best = Some(digits_at + digits);
        }
        from = start + 1;
    }
    best.and_then(|end| line.get(..end)).map(str::to_owned)
}

fn approval_key(check: &Value) -> String {
    workflow_run_of(string(check, "url"))
        .unwrap_or_else(|| string(check, "name").unwrap_or_default().to_owned())
}

/// `Math.round` for the minutes in a notice.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// `evaluatePullRequestWatch(watch, detail, remarks, now)`.
pub fn evaluate(watch: &Value, detail: &Value, remarks: Option<&[Value]>, now: f64) -> Report {
    let mut changes = Vec::new();
    let watch_head = string(watch, "headSha");
    let detail_head = string(detail, "headSha");
    let head_sha = detail_head.or(watch_head).map(str::to_owned);
    let head_moved = watch_head.is_some() && head_sha.as_deref() != watch_head;
    let baseline = watch.get("awaitingBaseline").filter(|v| !v.is_null());
    let checks_baseline = baseline.is_some() && !head_moved;
    let baseline_all = baseline.and_then(Value::as_str) == Some("all");

    let mut failed_checks = if head_moved {
        vec![]
    } else {
        names(watch.get("failedChecks"))
    };
    let mut passed = !head_moved && watch["passed"] == true;
    let mut passed_checks = if head_moved {
        vec![]
    } else {
        names(watch.get("passedChecks"))
    };
    let mut owed_checks = if head_moved {
        vec![]
    } else {
        names(watch.get("owedChecks"))
    };
    let mut awaiting_approval = if head_moved {
        vec![]
    } else {
        names(watch.get("awaitingApproval"))
    };
    let mut approval_announced = !head_moved && watch["approvalAnnounced"] == true;
    let awaited_since = watch
        .get("checksAwaitedSince")
        .filter(|v| !v.is_null())
        .and_then(Value::as_str);
    let mut checks_pending = !head_moved
        && match watch.get("checksPending").and_then(Value::as_bool) {
            Some(pending) => pending,
            None => watch
                .get("checksAwaitedSince")
                .is_some_and(|v| !v.is_null()),
        };
    let all_checks: Vec<&Value> = detail
        .get("checks")
        .and_then(Value::as_array)
        .map(|c| c.iter().collect())
        .unwrap_or_default();
    let unread = all_checks.iter().any(|c| c["placeholder"] == true);
    let checks: Vec<&Value> = all_checks
        .into_iter()
        .filter(|c| c["placeholder"] != true)
        .collect();
    let failed: Vec<&Value> = checks.iter().copied().filter(|c| is_failed(c)).collect();
    let awaiting: Vec<&Value> = checks
        .iter()
        .copied()
        .filter(|c| status(c) == "action-required")
        .collect();
    let name = |c: &Value| string(c, "name").unwrap_or_default().to_owned();
    if !checks.is_empty() {
        checks_pending = checks.iter().any(|c| status(c) == "pending");
        let newly: Vec<Value> = failed
            .iter()
            .filter(|c| !failed_checks.contains(&name(c)))
            .map(|c| (*c).clone())
            .collect();
        if !checks_baseline && !newly.is_empty() {
            changes.push(Change::ChecksFailed(newly));
        }
        if !approval_announced && !awaiting.is_empty() {
            if !checks_baseline {
                changes.push(Change::ChecksAwaitingApproval(
                    awaiting.iter().map(|c| (*c).clone()).collect(),
                ));
            }
            approval_announced = true;
        }
        failed_checks = failed.iter().map(|c| name(c)).collect();

        let mut awaiting_now: Vec<String> = Vec::new();
        for key in awaiting.iter().map(|c| approval_key(c)) {
            if !awaiting_now.contains(&key) {
                awaiting_now.push(key);
            }
        }
        let name_unfinished = |key: &str| {
            let matching: Vec<&&Value> = checks.iter().filter(|c| name(c) == key).collect();
            matching.is_empty()
                || matching
                    .iter()
                    .any(|c| matches!(status(c), "pending" | "action-required"))
        };
        let jobs_pending = checks.iter().any(|c| {
            status(c) == "pending"
                && (c.get("url").is_none_or(Value::is_null)
                    || workflow_run_of(string(c, "url")).is_some())
        });
        let finished: Vec<Option<String>> = if jobs_pending {
            vec![]
        } else {
            checks
                .iter()
                .filter(|c| !matches!(status(c), "action-required" | "pending"))
                .map(|c| workflow_run_of(string(c, "url")))
                .collect()
        };
        let kept: Vec<String> = awaiting_approval
            .iter()
            .filter(|key| {
                !awaiting_now.contains(key)
                    && if workflow_run_of(Some(key)).as_deref() == Some(key.as_str()) {
                        !finished.iter().any(|f| f.as_deref() == Some(key.as_str()))
                    } else {
                        name_unfinished(key)
                    }
            })
            .cloned()
            .collect();
        awaiting_approval = awaiting_now.into_iter().chain(kept).collect();
    }
    let required: Vec<&Value> = checks
        .iter()
        .copied()
        .filter(|c| c["required"] == true)
        .collect();
    let gate: &[&Value] = if required.is_empty() {
        &checks
    } else {
        &required
    };
    let passed_now = awaiting_approval.is_empty()
        && gate.iter().all(|c| status(c) != "pending" && !is_failed(c));
    if !checks.is_empty() && !(unread && passed_now) {
        let gate_names: Vec<String> = gate.iter().map(|c| name(c)).collect();
        let told = if passed && passed_checks.is_empty() {
            &gate_names
        } else {
            &passed_checks
        };
        let gate_grew = !required.is_empty() && gate_names.iter().any(|n| !told.contains(n));
        let owed: Vec<String> = if passed_now && passed {
            checks
                .iter()
                .filter(|c| c["required"] != true && owed_checks.contains(&name(c)))
                .map(|c| name(c))
                .collect()
        } else {
            vec![]
        };
        let settled = failed.is_empty()
            && awaiting_approval.is_empty()
            && checks.iter().all(|c| status(c) != "pending");
        owed_checks = owed.clone();
        if passed_now && (!passed || gate_grew) {
            if !checks_baseline {
                changes.push(Change::ChecksPassed {
                    count: gate.len(),
                    required: !required.is_empty(),
                });
            }
            owed_checks = if required.is_empty() {
                vec![]
            } else {
                checks
                    .iter()
                    .filter(|c| c["required"] != true && status(c) == "pending")
                    .map(|c| name(c))
                    .collect()
            };
        } else if settled && !owed.is_empty() {
            changes.push(Change::ChecksPassed {
                count: checks.len(),
                required: false,
            });
            owed_checks = vec![];
        }
        passed = passed_now;
        passed_checks = if passed_now { gate_names } else { vec![] };
    }

    let awaited_before = if head_moved || baseline_all {
        Some(iso_from_millis(now as i64))
    } else {
        awaited_since.map(str::to_owned)
    };
    let mut checks_awaited_since = if checks.is_empty() {
        awaited_before
    } else {
        None
    };
    let awaited_ms = checks_awaited_since
        .as_deref()
        .map_or(0.0, |since| now - parse(since));
    if !unread && awaited_ms >= NO_CHECKS_MS {
        if detail["capabilities"]["checksAlwaysReport"] == true {
            changes.push(Change::NoChecks(js_round(awaited_ms / 60_000.0)));
        }
        checks_awaited_since = None;
        checks_pending = false;
    } else if checks_awaited_since.is_some() {
        checks_pending = true;
    }

    let own = string(detail, "viewer")
        .or_else(|| detail["author"]["login"].as_str())
        .map(str::to_lowercase);
    let remarks_through = string(watch, "remarksThrough").unwrap_or_default();
    let through = parse(remarks_through);
    let remark_ids = names(watch.get("remarkIds"));
    let active_at = |r: &Value| -> String {
        string(r, "editedAt")
            .or_else(|| string(r, "createdAt"))
            .unwrap_or_default()
            .to_owned()
    };
    let fresh: Vec<Value> = remarks
        .unwrap_or_default()
        .iter()
        .filter(|r| {
            let at = parse(&active_at(r));
            let id = string(r, "id").unwrap_or_default();
            let new = at > through || (at == through && !remark_ids.iter().any(|i| i == id));
            new && r["author"]["login"].as_str().map(str::to_lowercase) != own
        })
        .cloned()
        .collect();
    if !fresh.is_empty() {
        changes.push(Change::Remarks(fresh.clone()));
    }
    let latest = fresh.iter().fold(through, |latest, r| {
        let at = parse(&active_at(r));
        if latest.is_nan() || at.is_nan() {
            f64::NAN
        } else {
            latest.max(at)
        }
    });
    let at_latest: Vec<&Value> = fresh
        .iter()
        .filter(|r| parse(&active_at(r)) == latest)
        .collect();
    let unchanged = latest == through;
    let next_through = match at_latest.first() {
        Some(first) if !unchanged => active_at(first),
        _ => remarks_through.to_owned(),
    };
    let mut next_ids: Vec<String> = if unchanged { remark_ids } else { vec![] };
    next_ids.extend(
        at_latest
            .iter()
            .map(|r| string(r, "id").unwrap_or_default().to_owned()),
    );

    let mergeability = string(detail, "mergeability");
    let told_conflict = !head_moved && watch["conflicting"] == true;
    if !baseline_all && mergeability == Some("conflicting") && !told_conflict {
        changes.push(Change::Conflicting);
    }
    let told_rebase = !head_moved && watch["rebaseRequired"] == true;
    if !baseline_all && detail["rebaseRequired"] == true && !told_rebase {
        changes.push(Change::NeedsRebase);
    }
    let rebase_required = detail
        .get("rebaseRequired")
        .filter(|v| !v.is_null())
        .or_else(|| watch.get("rebaseRequired").filter(|v| !v.is_null()))
        .cloned();
    let conflicting = if mergeability == Some("unknown") {
        told_conflict
    } else {
        mergeability == Some("conflicting")
    };

    let removal = detail.get("mergeQueueRemoval").filter(|v| v.is_object());
    let stored_removal = watch.get("mergeQueueRemovalId");
    if let Some(removal) = removal {
        let id = removal.get("id").unwrap_or(&Value::Null);
        let started = parse(string(watch, "startedAt").unwrap_or_default());
        if removal["reason"] != "merged"
            && Some(id) != stored_removal
            && (stored_removal.is_some()
                || parse(string(removal, "removedAt").unwrap_or_default())
                    >= (started / 1000.0).floor() * 1000.0)
        {
            changes.push(Change::MergeQueueRemoved(
                string(removal, "reason").map(str::to_owned),
            ));
        }
    }
    let merge_queue_removal_id = removal
        .and_then(|r| r.get("id"))
        .filter(|v| !v.is_null())
        .or_else(|| stored_removal.filter(|v| !v.is_null()))
        .cloned()
        .unwrap_or(Value::Null);

    let comments_only = !changes.is_empty() && changes.iter().all(|c| c.kind() == "remarks");
    let progress = head_moved || (!changes.is_empty() && !comments_only);
    let wakes = if progress {
        0
    } else {
        watch["wakes"].as_i64().unwrap_or(0)
    } + i64::from(comments_only);

    let mut next = Map::new();
    next.insert("startedAt".into(), watch["startedAt"].clone());
    next.insert("headSha".into(), json!(head_sha));
    next.insert("failedChecks".into(), json!(failed_checks));
    next.insert("passed".into(), json!(passed));
    next.insert("passedChecks".into(), json!(passed_checks));
    next.insert("owedChecks".into(), json!(owed_checks));
    next.insert("awaitingApproval".into(), json!(awaiting_approval));
    next.insert("approvalAnnounced".into(), json!(approval_announced));
    next.insert("remarksThrough".into(), json!(next_through));
    next.insert("remarkIds".into(), json!(next_ids));
    next.insert("conflicting".into(), json!(conflicting));
    if let Some(rebase) = rebase_required {
        next.insert("rebaseRequired".into(), rebase);
    }
    next.insert("mergeQueueRemovalId".into(), merge_queue_removal_id);
    next.insert("wakes".into(), json!(wakes));
    if checks_baseline && (unread || (detail.get("headSha").is_none() && checks.is_empty())) {
        next.insert("awaitingBaseline".into(), json!("checks"));
    }
    next.insert("checksAwaitedSince".into(), json!(checks_awaited_since));
    next.insert("checksPending".into(), json!(checks_pending));
    Report {
        changes,
        next: Value::Object(next),
        exhausted: comments_only && wakes >= WAKE_LIMIT,
    }
}

// ---- Remark snippets --------------------------------------------------------------------

const TAG_NAMES: &[&str] = &[
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "caption",
    "cite",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "li",
    "mark",
    "ol",
    "p",
    "picture",
    "pre",
    "q",
    "s",
    "samp",
    "small",
    "source",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "tt",
    "ul",
    "var",
];

fn at(chars: &[char], index: usize) -> Option<char> {
    chars.get(index).copied()
}

fn backtick_before(chars: &[char], index: usize) -> bool {
    index > 0 && at(chars, index - 1) == Some('`')
}

/// `(?!\n[ \t\r]*\n)` at `index`.
fn blank_line_at(chars: &[char], index: usize) -> bool {
    if at(chars, index) != Some('\n') {
        return false;
    }
    let mut i = index + 1;
    while matches!(at(chars, i), Some(' ' | '\t' | '\r')) {
        i += 1;
    }
    at(chars, i) == Some('\n')
}

/// The code span alternative of `PROSE_MARKUP` at `start`: its end.
fn code_span(chars: &[char], start: usize) -> Option<usize> {
    if at(chars, start) != Some('`') || backtick_before(chars, start) {
        return None;
    }
    let mut ticks = 0;
    while at(chars, start + ticks) == Some('`') {
        ticks += 1;
    }
    let mut j = start + ticks;
    loop {
        if !backtick_before(chars, j) {
            let run = (0..).take_while(|k| at(chars, j + k) == Some('`')).count();
            if run == ticks {
                return Some(j + ticks);
            }
        }
        if j >= chars.len() || blank_line_at(chars, j) {
            return None;
        }
        j += 1;
    }
}

/// The tag alternative of `PROSE_MARKUP` at `start`: its end, whether it closes, and its name.
fn tag(chars: &[char], start: usize) -> Option<(usize, bool, &'static str)> {
    if at(chars, start) != Some('<') {
        return None;
    }
    let mut i = start + 1;
    let closing = at(chars, i) == Some('/');
    if closing {
        i += 1;
    }
    let name = TAG_NAMES.iter().copied().find(|name| {
        let len = name.chars().count();
        name.chars()
            .enumerate()
            .all(|(k, c)| at(chars, i + k) == Some(c))
            && at(chars, i + len).is_some_and(|c| is_js_space(c) || c == '/' || c == '>')
    })?;
    i += name.chars().count();
    loop {
        match at(chars, i)? {
            '>' => return Some((i + 1, closing, name)),
            '<' => return None,
            quote @ ('"' | '\'') => {
                i += 1;
                while at(chars, i)? != quote {
                    i += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
}

/// `withoutTags`: GitHub's presentation tags in prose become a space.
fn without_tags(prose: &str) -> String {
    let chars: Vec<char> = prose.chars().collect();
    let mut kept: Vec<(&'static str, usize)> = Vec::new();
    let mut text = String::new();
    let mut from = 0;
    let mut i = 0;
    while i < chars.len() {
        if let Some(end) = code_span(&chars, i) {
            i = end;
            continue;
        }
        let Some((end, closing, name)) = tag(&chars, i) else {
            i += 1;
            continue;
        };
        let held = kept
            .iter()
            .find(|(n, _)| *n == name)
            .map_or(0, |(_, count)| *count);
        let set = |kept: &mut Vec<(&'static str, usize)>, count: usize| match kept
            .iter_mut()
            .find(|(n, _)| *n == name)
        {
            Some(entry) => entry.1 = count,
            None => kept.push((name, count)),
        };
        if closing {
            if held > 0 {
                set(&mut kept, held - 1);
                i = end;
                continue;
            }
        } else if i > 0 && at(&chars, i - 1).is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            set(&mut kept, held + 1);
            i = end;
            continue;
        }
        text.extend(chars.get(from..i).unwrap_or_default());
        text.push(' ');
        from = end;
        i = end;
    }
    text.extend(chars.get(from..).unwrap_or_default());
    text
}

/// `^ {0,3}(`{3,}|~{3,})([\s\S]*)$`: the fence and the rest of the line.
fn fence_opener(line: &str) -> Option<(String, &str)> {
    let spaces = line.chars().take_while(|c| *c == ' ').count();
    if spaces > 3 {
        return None;
    }
    let rest = line.get(spaces..)?;
    let mark = rest.chars().next().filter(|c| matches!(c, '`' | '~'))?;
    let run = rest.chars().take_while(|c| *c == mark).count();
    if run < 3 {
        return None;
    }
    Some((
        mark.to_string().repeat(run),
        rest.get(run..).unwrap_or_default(),
    ))
}

/// `^(?: {4}| {0,3}\t)\s*\S`.
fn indented_code(line: &str) -> bool {
    let spaces = line.chars().take_while(|c| *c == ' ').count();
    let rest = if spaces >= 4 {
        line.get(4..)
    } else if line.chars().nth(spaces) == Some('\t') {
        line.get(spaces + 1..)
    } else {
        None
    };
    rest.is_some_and(|rest| rest.chars().any(|c| !is_js_space(c)))
}

/// `withoutMarkup`: tags dropped from prose; fenced and indented code kept as written.
fn without_markup(body: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut fence: Option<String> = None;
    let mut after_text = false;
    let flush = |parts: &mut Vec<String>, prose: &mut Vec<&str>| {
        if !prose.is_empty() {
            parts.push(without_tags(&prose.join("\n")));
        }
        prose.clear();
    };
    for line in body.split('\n') {
        if let Some(open) = &fence {
            let closer = js_trim(line);
            let mark = open.chars().next().unwrap_or('`');
            if closer.encode_utf16().count() >= open.len() && closer.chars().all(|c| c == mark) {
                fence = None;
            }
            flush(&mut parts, &mut prose);
            parts.push(line.to_owned());
            after_text = false;
            continue;
        }
        let opener =
            fence_opener(line).filter(|(run, rest)| !(run.starts_with('`') && rest.contains('`')));
        if let Some((run, _)) = opener {
            fence = Some(run);
            flush(&mut parts, &mut prose);
            parts.push(line.to_owned());
            after_text = false;
        } else if !after_text && indented_code(line) {
            flush(&mut parts, &mut prose);
            parts.push(line.to_owned());
            after_text = false;
        } else {
            prose.push(line);
            after_text = !js_trim(line).is_empty();
        }
    }
    flush(&mut parts, &mut prose);
    parts.join("\n")
}

/// Drops `<!-- ... -->` comments, as `/<!--[\s\S]*?-->/g` does.
fn without_comments(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some(start) = rest.find("<!--") {
        let Some(end) = rest.get(start + 4..).and_then(|after| after.find("-->")) else {
            break;
        };
        out.push_str(rest.get(..start).unwrap_or_default());
        out.push(' ');
        rest = rest.get(start + 4 + end + 3..).unwrap_or_default();
    }
    out.push_str(rest);
    out
}

/// `snippet`: a remark's words, at most 200 UTF-16 units, never half a surrogate pair.
pub fn snippet(body: &str) -> String {
    let markup = without_markup(&without_comments(body));
    let mut collapsed = String::new();
    let mut space = false;
    for c in markup.chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space {
                collapsed.push(' ');
            }
            space = false;
            collapsed.push(c);
        }
    }
    if space {
        collapsed.push(' ');
    }
    let text = js_trim(&collapsed);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= SNIPPET_LENGTH {
        return text.to_owned();
    }
    let last = units.get(SNIPPET_LENGTH - 4).copied().unwrap_or(0);
    let end = if (0xd800..=0xdbff).contains(&last) {
        SNIPPET_LENGTH - 4
    } else {
        SNIPPET_LENGTH - 3
    };
    format!(
        "{}...",
        String::from_utf16_lossy(units.get(..end).unwrap_or_default())
    )
}

// ---- Wake texts -------------------------------------------------------------------------

fn listed(items: &[Value], line: impl Fn(&Value) -> String) -> Vec<String> {
    let mut lines: Vec<String> = items.iter().take(LISTED_ITEMS).map(line).collect();
    if items.len() > LISTED_ITEMS {
        lines.push(format!("  - and {} more", items.len() - LISTED_ITEMS));
    }
    lines
}

fn url_suffix(value: &Value) -> String {
    match string(value, "url") {
        Some(url) if !url.is_empty() => format!(" {url}"),
        _ => String::new(),
    }
}

fn change_lines(change: &Change, base_branch: &str, commit: &str) -> Vec<String> {
    match change {
        Change::ChecksFailed(failed) => {
            let mut lines = vec![format!("- Checks failed{commit}:")];
            lines.extend(listed(failed, |check| {
                let state = match status(check) {
                    "failure" => String::new(),
                    other => format!(" ({other})"),
                };
                format!(
                    "  - {}{state}{}",
                    string(check, "name").unwrap_or_default(),
                    url_suffix(check)
                )
            }));
            lines
        }
        Change::ChecksAwaitingApproval(checks) => {
            let mut lines = vec![format!(
                "- Checks are waiting for approval or action from a maintainer{commit}:"
            )];
            lines.extend(listed(checks, |check| {
                format!(
                    "  - {}{}",
                    string(check, "name").unwrap_or_default(),
                    url_suffix(check)
                )
            }));
            lines
        }
        Change::ChecksPassed { count, required } => vec![format!(
            "- All {count} {}{} passed{commit}.",
            if *required { "required " } else { "" },
            if *count == 1 { "check" } else { "checks" }
        )],
        Change::Remarks(remarks) => {
            let mut lines = vec![format!(
                "- {} new {}:",
                remarks.len(),
                if remarks.len() == 1 {
                    "comment"
                } else {
                    "comments"
                }
            )];
            lines.extend(listed(remarks, |remark| {
                let place = string(remark, "path")
                    .map(|path| format!(" on {path}"))
                    .unwrap_or_default();
                let body = snippet(string(remark, "body").unwrap_or_default());
                let said = if body.is_empty() {
                    string(remark, "reviewState")
                        .unwrap_or("reviewed")
                        .to_owned()
                } else {
                    format!("\"{body}\"")
                };
                format!(
                    "  - {}{place}: {said}{}",
                    remark["author"]["login"].as_str().unwrap_or("someone"),
                    url_suffix(remark)
                )
            }));
            lines
        }
        Change::NoChecks(minutes) => vec![format!(
            "- No checks have reported{commit} after {minutes} minutes. None may be configured to run on this change."
        )],
        Change::NeedsRebase => vec![format!(
            "- The branch requires a rebase onto {base_branch}."
        )],
        Change::Conflicting => vec![format!("- The branch now conflicts with {base_branch}.")],
        Change::MergeQueueRemoved(reason) => vec![format!(
            "- It was removed from the merge queue without merging{}.",
            reason
                .as_deref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )],
    }
}

const WATCHING_CLOSING: &str = "Look into each item and act on it as your task requires. This PR stays linked and watched, so do not link, watch, or list it again. End your turn when you are done, and T3 Code wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.";
const WATCHING_CLOSING_PLURAL: &str = "Look into each item and act on it as your task requires. Each PR T3 Code still watches stays linked and watched, so do not link, watch, or list them again. End your turn when you are done, and T3 Code wakes you on the next change. When you hand the work back to the user, call unwatch_pull_request for each first so the thread returns to their inbox.";

/// `PullRequestWatchWake`: the text and the notification (`{source, outcome, summary}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Wake {
    pub text: String,
    pub outcome: &'static str,
    pub summary: String,
}

impl Wake {
    pub fn notification(&self) -> Value {
        json!({"source": {"kind": "monitor"}, "outcome": self.outcome, "summary": self.summary})
    }
}

/// `pullRequestWatchMessage`.
pub fn message(
    number: u64,
    url: &str,
    base_branch: &str,
    head_sha: Option<&str>,
    report: &Report,
) -> Wake {
    let commit = head_sha
        .map(|sha| format!(" on {}", sha.chars().take(7).collect::<String>()))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "Update on pull request #{number} ({url}), which T3 Code is watching for you:"
    )];
    for change in &report.changes {
        lines.extend(change_lines(change, base_branch, &commit));
    }
    lines.push(String::new());
    lines.push(if report.exhausted {
        format!(
            "T3 Code stopped watching after {WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again."
        )
    } else {
        WATCHING_CLOSING.to_owned()
    });
    let failed = report.changes.iter().any(|c| {
        matches!(
            c,
            Change::ChecksFailed(_)
                | Change::Conflicting
                | Change::NeedsRebase
                | Change::MergeQueueRemoved(_)
        )
    });
    let mut summary: Vec<&str> = report.changes.iter().map(Change::summary).collect();
    if report.exhausted {
        summary.push("stopped watching");
    }
    Wake {
        text: lines.join("\n"),
        outcome: if failed {
            "failed"
        } else if report
            .changes
            .iter()
            .all(|c| matches!(c, Change::ChecksPassed { .. }))
        {
            "completed"
        } else {
            "updated"
        },
        summary: format!("#{number}: {}", summary.join(", ")),
    }
}

/// `combinePullRequestWatchWakes`: one wake for several pull requests, closing said once.
pub fn combine(wakes: &[Wake]) -> Option<Wake> {
    match wakes {
        [] => None,
        [one] => Some(one.clone()),
        _ => {
            let closing = format!("\n\n{WATCHING_CLOSING}");
            let watching = wakes.iter().any(|w| w.text.ends_with(&closing));
            let mut texts: Vec<&str> = wakes
                .iter()
                .map(|w| w.text.strip_suffix(closing.as_str()).unwrap_or(&w.text))
                .collect();
            if watching {
                texts.push(WATCHING_CLOSING_PLURAL);
            }
            let outcome = if wakes.iter().any(|w| w.outcome == "failed") {
                "failed"
            } else if wakes.iter().all(|w| w.outcome == "completed") {
                "completed"
            } else {
                "updated"
            };
            Some(Wake {
                text: texts.join("\n\n"),
                outcome,
                summary: wakes
                    .iter()
                    .map(|w| w.summary.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_runs_take_the_last_run_on_the_first_line() {
        let run = |url: &str| workflow_run_of(Some(url));
        assert_eq!(
            run("https://github.com/o/r/actions/runs/12/job/9"),
            Some("https://github.com/o/r/actions/runs/12".into())
        );
        assert_eq!(run("https://ci.example/x"), None);
        assert_eq!(
            run("a/actions/runs/1/b/actions/runs/22x"),
            Some("a/actions/runs/1/b/actions/runs/22".into())
        );
        assert_eq!(run("a/actions/runs/x\n/actions/runs/3"), None);
    }

    #[test]
    fn snippets_drop_markup_but_keep_code() {
        assert_eq!(snippet("<p>Hi <b>there</b></p>"), "Hi there");
        assert_eq!(snippet("Use `<b>` here"), "Use `<b>` here");
        assert_eq!(snippet("Vec<code>x</code>"), "Vec<code>x</code>");
        assert_eq!(snippet("a <!-- hidden --> b"), "a b");
        let long = "x".repeat(300);
        assert_eq!(snippet(&long).encode_utf16().count(), 200);
    }
}
