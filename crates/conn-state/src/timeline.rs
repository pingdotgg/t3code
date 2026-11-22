//! Pure, GPUI-free presentation logic for timeline cards, ported 1:1 from Conn:
//!
//! - Pending user-input answers (`client-runtime/src/state/pendingUserInput.ts`).
//! - Proposed plan title, display body, and collapsed preview (`shared/src/proposedPlanText.ts`,
//!   `web/src/proposedPlan.ts`).
//! - Subagent display title, detail, and status visuals (`subagentDisplay.ts`,
//!   `V2LifecycleRow.tsx`).
//! - Changed-files directory tree (`web/src/lib/turnDiffTree.ts`, `ChangedFilesTree.tsx`).
//! - Duration and day-aware timestamp formatting (`shared/src/orchestrationTiming.ts`,
//!   `web/src/timestampFormat.ts`).

use std::cmp::Ordering;
use std::collections::HashMap;

use conn_contract::OrchestrationV2TurnItemStatus as TurnItemStatus;

// ---------------------------------------------------------------------------------------------
// Pending user input
// ---------------------------------------------------------------------------------------------

/// One selectable option of a [`UserInputQuestion`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserInputOption {
    pub label: String,
    pub description: String,
    /// Provider value sent as the answer; falls back to `label` when absent.
    pub value: Option<String>,
}

impl UserInputOption {
    /// The value Conn submits for this option (`option.value ?? option.label`).
    #[must_use]
    pub fn answer_value(&self) -> &str {
        self.value.as_deref().unwrap_or(&self.label)
    }
}

/// One question of a pending `user_input_request` turn item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<UserInputOption>,
    pub multi_select: bool,
    /// `false` only when the provider set `allowCustomAnswer: false`.
    pub allow_custom_answer: bool,
    pub initial_answer: Option<String>,
}

/// One answered question of a settled `user_input_request` (`question_answer`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserInputAnswer {
    pub question_id: String,
    /// The question text shown with the answer (from `questionTextById` or the question).
    pub question: String,
    /// The answer, with multi-select values joined by `", "`.
    pub answer: String,
}

/// The local draft answer for one question (`PendingUserInputDraftAnswer`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UserInputDraft {
    pub selected: Vec<String>,
    pub custom: Option<String>,
}

/// The answer submitted for one question (`PendingUserInputAnswer`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserInputAnswerValue {
    Single(String),
    Multi(Vec<String>),
}

impl UserInputAnswerValue {
    /// Converts this answer into the JSON value `runtime-request.respond` expects.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Single(value) => serde_json::Value::String(value.clone()),
            Self::Multi(values) => serde_json::Value::Array(
                values
                    .iter()
                    .map(|v| serde_json::Value::String(v.clone()))
                    .collect(),
            ),
        }
    }
}

fn normalize_draft_answer(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

impl UserInputQuestion {
    /// Provider values match exactly; options without a value match by trimmed label.
    fn resolve_option_value(&self, value: &str) -> Option<String> {
        if self
            .options
            .iter()
            .any(|o| o.value.as_deref() == Some(value))
        {
            return Some(value.to_owned());
        }
        let label = value.trim();
        (!label.is_empty()
            && self
                .options
                .iter()
                .any(|o| o.value.is_none() && o.label.trim() == label))
        .then(|| label.to_owned())
    }

    /// The draft's selections that name an offered option, deduplicated, in selection order.
    #[must_use]
    pub fn normalized_selection(&self, draft: Option<&UserInputDraft>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for entry in draft.map(|d| d.selected.as_slice()).unwrap_or_default() {
            if let Some(resolved) = self.resolve_option_value(entry)
                && !out.contains(&resolved)
            {
                out.push(resolved);
            }
        }
        out
    }

    /// Whether `option_value` shows as selected (a typed custom answer clears selections).
    #[must_use]
    pub fn is_option_selected(&self, draft: Option<&UserInputDraft>, option_value: &str) -> bool {
        if self.allow_custom_answer
            && normalize_draft_answer(draft.and_then(|d| d.custom.as_deref())).is_some()
        {
            return false;
        }
        self.resolve_option_value(option_value)
            .is_some_and(|resolved| self.normalized_selection(draft).contains(&resolved))
    }

    /// Toggles an offered option. An unknown option returns the same draft.
    #[must_use]
    pub fn toggle_option(
        &self,
        draft: Option<&UserInputDraft>,
        option_value: &str,
    ) -> UserInputDraft {
        let Some(resolved) = self.resolve_option_value(option_value) else {
            return draft.cloned().unwrap_or_default();
        };
        if self.multi_select {
            let mut selected = self.normalized_selection(draft);
            if let Some(pos) = selected.iter().position(|v| *v == resolved) {
                selected.remove(pos);
            } else {
                selected.push(resolved);
            }
            return UserInputDraft {
                selected,
                custom: Some(String::new()),
            };
        }
        UserInputDraft {
            selected: vec![resolved],
            custom: Some(String::new()),
        }
    }

    /// Sets the free-text answer; typing clears selections unless `initial_answer` is set.
    #[must_use]
    pub fn set_custom_answer(
        &self,
        draft: Option<&UserInputDraft>,
        custom: &str,
    ) -> UserInputDraft {
        if !self.allow_custom_answer {
            return draft.cloned().unwrap_or_default();
        }
        let selected = if self.initial_answer.is_some() || !custom.trim().is_empty() {
            Vec::new()
        } else {
            self.normalized_selection(draft)
        };
        UserInputDraft {
            selected,
            custom: Some(custom.to_owned()),
        }
    }

    /// The answer to submit for this question, or `None` while it is unanswered.
    #[must_use]
    pub fn resolve_answer(&self, draft: Option<&UserInputDraft>) -> Option<UserInputAnswerValue> {
        let custom = if !self.allow_custom_answer {
            None
        } else if self.initial_answer.is_some() {
            draft.and_then(|d| d.custom.clone())
        } else {
            normalize_draft_answer(draft.and_then(|d| d.custom.as_deref()))
        };
        if let Some(text) = custom.as_ref().filter(|c| !c.is_empty()) {
            return Some(UserInputAnswerValue::Single(text.clone()));
        }
        let selected = self.normalized_selection(draft);
        if self.multi_select {
            return if selected.is_empty() {
                custom.map(UserInputAnswerValue::Single)
            } else {
                Some(UserInputAnswerValue::Multi(selected))
            };
        }
        selected
            .into_iter()
            .next()
            .or(custom)
            .map(UserInputAnswerValue::Single)
    }
}

/// Every question's answer keyed by question id, or `None` while any is unanswered
/// (`buildPendingUserInputAnswers`).
#[must_use]
pub fn build_user_input_answers(
    questions: &[UserInputQuestion],
    drafts: &HashMap<String, UserInputDraft>,
) -> Option<Vec<(String, UserInputAnswerValue)>> {
    questions
        .iter()
        .map(|q| Some((q.id.clone(), q.resolve_answer(drafts.get(&q.id))?)))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Proposed plans
// ---------------------------------------------------------------------------------------------

/// Plans longer than this many characters collapse behind `Expand plan`.
pub(crate) const PLAN_COLLAPSE_MIN_CHARS: usize = 900;
/// Plans with more lines than this collapse behind `Expand plan`.
pub(crate) const PLAN_COLLAPSE_MIN_LINES: usize = 20;
/// Visible lines kept in a collapsed plan preview.
pub const PLAN_PREVIEW_MAX_LINES: usize = 10;

fn heading_text(line: &str) -> Option<&str> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = &rest[hashes..];
    let body = after.strip_prefix([' ', '\t'])?;
    let text = body.trim();
    (!text.is_empty()).then_some(text)
}

/// The first Markdown heading of a plan (`proposedPlanTitle`).
#[must_use]
pub fn proposed_plan_title(markdown: &str) -> Option<String> {
    markdown.lines().find_map(heading_text).map(str::to_owned)
}

/// The plan body without its leading title heading and an immediate `Summary` heading
/// (`stripDisplayedPlanMarkdown`).
#[must_use]
pub fn strip_displayed_plan_markdown(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.trim_end().lines().collect();
    let blank = |idx: usize| lines.get(idx).is_some_and(|l| l.trim().is_empty());
    let mut start = usize::from(lines.first().is_some_and(|l| heading_text(l).is_some()));
    while blank(start) {
        start += 1;
    }
    if lines
        .get(start)
        .and_then(|l| heading_text(l))
        .is_some_and(|h| h.eq_ignore_ascii_case("summary"))
    {
        start += 1;
        while blank(start) {
            start += 1;
        }
    }
    lines.get(start..).unwrap_or_default().join("\n")
}

/// Whether a plan is long enough to collapse (`> 900` chars or `> 20` lines).
#[must_use]
pub fn plan_can_collapse(markdown: &str) -> bool {
    markdown.len() > PLAN_COLLAPSE_MIN_CHARS
        || markdown.split('\n').count() > PLAN_COLLAPSE_MIN_LINES
}

/// The first `max_lines` visible lines of the display body, with a trailing `...`
/// when more content follows (`buildCollapsedProposedPlanPreviewMarkdown`).
#[must_use]
pub fn collapsed_plan_preview(markdown: &str, max_lines: usize) -> String {
    let stripped = strip_displayed_plan_markdown(markdown);
    let mut preview: Vec<&str> = Vec::new();
    let mut visible = 0usize;
    let mut has_more = false;
    for line in stripped.trim_end().lines().map(str::trim_end) {
        let is_visible = !line.trim().is_empty();
        if is_visible && visible >= max_lines {
            has_more = true;
            break;
        }
        preview.push(line);
        if is_visible {
            visible += 1;
        }
    }
    while preview.last().is_some_and(|l| l.trim().is_empty()) {
        preview.pop();
    }
    if preview.is_empty() {
        return proposed_plan_title(markdown)
            .unwrap_or_else(|| "Plan preview unavailable.".to_owned());
    }
    let mut out = preview.join("\n");
    if has_more {
        out.push_str("\n\n...");
    }
    out
}

/// The plan text Conn copies or saves (`normalizePlanMarkdownForExport`).
#[must_use]
pub fn normalize_plan_markdown_for_export(markdown: &str) -> String {
    format!("{}\n", markdown.trim_end())
}

// ---------------------------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------------------------

/// Removes a `Subagent:` prefix and turns `/root/.../name` paths into a title-cased name
/// (`formatSubagentDisplayTitle`).
#[must_use]
pub fn format_subagent_display_title(title: &str) -> String {
    let trimmed = title.trim_start();
    let display = if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("subagent:") {
        trimmed[9..].trim_start()
    } else {
        title
    };
    let Some(rest) = display.strip_prefix("/root/") else {
        return display.to_owned();
    };
    let last = rest
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    if last.is_empty() {
        return display.to_owned();
    }
    let name = last
        .split(|c: char| c == '_' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                let mut word: String = first.to_uppercase().collect();
                word.push_str(chars.as_str());
                word
            })
        })
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        display.to_owned()
    } else {
        name
    }
}

/// Visual status of a subagent row: its dot color role and label (`STATUS_VISUALS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentTone {
    Info,
    Success,
    Destructive,
    Idle,
    Stopped,
}

/// Returns the status dot tone and label for a subagent `status`.
#[must_use]
pub fn subagent_status_visual(status: TurnItemStatus) -> (SubagentTone, &'static str) {
    match status {
        TurnItemStatus::Pending => (SubagentTone::Info, "Queued"),
        TurnItemStatus::Running => (SubagentTone::Info, "Running"),
        TurnItemStatus::Waiting => (SubagentTone::Info, "Waiting"),
        TurnItemStatus::Idle => (SubagentTone::Idle, "Idle · resumable"),
        TurnItemStatus::Completed => (SubagentTone::Success, "Completed"),
        TurnItemStatus::Failed => (SubagentTone::Destructive, "Failed"),
        TurnItemStatus::Cancelled | TurnItemStatus::Interrupted => {
            (SubagentTone::Stopped, "Stopped")
        }
    }
}

/// Whether a subagent status is settled (`SETTLED_SUBAGENT_STATUSES`).
#[must_use]
pub fn subagent_settled(status: TurnItemStatus) -> bool {
    matches!(
        status,
        TurnItemStatus::Completed
            | TurnItemStatus::Failed
            | TurnItemStatus::Cancelled
            | TurnItemStatus::Interrupted
    )
}

/// Strips links, backticks, and bullets and collapses whitespace (`plainDetail`).
fn plain_detail(text: &str) -> String {
    let mut unlinked = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        if let Some(close) = after_open.find(']')
            && !after_open[..close].is_empty()
            && after_open[close + 1..].starts_with('(')
            && let Some(paren_end) = after_open[close + 2..].find(')')
        {
            unlinked.push_str(&rest[..open]);
            unlinked.push_str(&after_open[..close]);
            rest = &after_open[close + 2 + paren_end + 1..];
            continue;
        }
        unlinked.push_str(&rest[..=open]);
        rest = after_open;
    }
    unlinked.push_str(rest);
    let no_ticks = unlinked.replace('`', "");
    let joined = no_ticks
        .lines()
        .map(|line| {
            let trimmed = line.trim_start_matches([' ', '\t']);
            match trimmed.strip_prefix(['-', '*']) {
                Some(after) if after.starts_with([' ', '\t']) => {
                    after.trim_start_matches([' ', '\t'])
                }
                _ => line,
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Generic child-end text Conn hides (`/^Child task ended with status\b/i`).
const GENERIC_CHILD_END: &str = "child task ended with status";

/// The one-line subagent detail: progress while running, result once settled, hidden when
/// it only restates the generic child-end message.
#[must_use]
pub fn subagent_detail(
    status: TurnItemStatus,
    progress: Option<&str>,
    result: Option<&str>,
) -> Option<String> {
    let progress = progress.map(str::trim).filter(|s| !s.is_empty());
    let result = result.map(str::trim).filter(|s| !s.is_empty());
    let raw = if subagent_settled(status) {
        result.or(progress)
    } else {
        progress.or(result)
    }?;
    let generic = raw
        .get(..GENERIC_CHILD_END.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(GENERIC_CHILD_END));
    if generic {
        return None;
    }
    let detail = plain_detail(raw);
    (!detail.is_empty()).then_some(detail)
}

// ---------------------------------------------------------------------------------------------
// Changed-files tree
// ---------------------------------------------------------------------------------------------

/// One changed file of a ready turn checkpoint (`TurnDiffFileChange`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnCheckpointFile {
    pub path: String,
    /// Change kind from the server (`added`, `modified`, `deleted`, `renamed`, ...).
    pub kind: String,
    pub additions: i64,
    pub deletions: i64,
}

/// One directory or file node of [`build_turn_diff_tree`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnDiffTreeNode {
    pub is_directory: bool,
    pub name: String,
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
    pub children: Vec<TurnDiffTreeNode>,
}

/// One visible row of the flattened changed-files tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnDiffRow {
    pub depth: usize,
    pub is_directory: bool,
    pub expanded: bool,
    pub name: String,
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
}

impl TurnDiffRow {
    /// Whether the row shows a `+A -D` stat (`hasNonZeroStat` for folders; files always do).
    #[must_use]
    pub fn shows_stat(&self) -> bool {
        !self.is_directory || self.additions != 0 || self.deletions != 0
    }
}

/// Natural, case-insensitive name order (`Intl.Collator(numeric, sensitivity: "base")`).
fn compare_names(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let ord = ca.to_lowercase().cmp(cb.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

#[derive(Default)]
struct MutableDir {
    name: String,
    path: String,
    additions: i64,
    deletions: i64,
    dirs: Vec<MutableDir>,
    files: Vec<TurnDiffTreeNode>,
}

impl MutableDir {
    fn into_nodes(mut self) -> Vec<TurnDiffTreeNode> {
        self.dirs.sort_by(|a, b| compare_names(&a.name, &b.name));
        self.files.sort_by(|a, b| compare_names(&a.name, &b.name));
        let mut out: Vec<TurnDiffTreeNode> = self
            .dirs
            .into_iter()
            .map(|dir| {
                let mut node = TurnDiffTreeNode {
                    is_directory: true,
                    name: dir.name.clone(),
                    path: dir.path.clone(),
                    additions: dir.additions,
                    deletions: dir.deletions,
                    children: Vec::new(),
                };
                node.children = dir.into_nodes();
                // Compact single-child directory chains (`src/app` instead of `src` > `app`).
                while node.children.len() == 1 && node.children[0].is_directory {
                    let only = node.children.remove(0);
                    node = TurnDiffTreeNode {
                        is_directory: true,
                        name: format!("{}/{}", node.name, only.name),
                        path: only.path,
                        additions: only.additions,
                        deletions: only.deletions,
                        children: only.children,
                    };
                }
                node
            })
            .collect();
        out.extend(self.files);
        out
    }
}

/// Builds Conn's compacted, sorted directory tree with summed folder stats
/// (`buildTurnDiffTree`).
#[must_use]
pub fn build_turn_diff_tree(files: &[TurnCheckpointFile]) -> Vec<TurnDiffTreeNode> {
    let mut root = MutableDir::default();
    for file in files {
        let normalized = file.path.replace('\\', "/");
        let segments: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
        let Some((file_name, dirs)) = segments.split_last() else {
            continue;
        };
        root.additions += file.additions;
        root.deletions += file.deletions;
        let mut current = &mut root;
        for segment in dirs {
            let idx = if let Some(idx) = current.dirs.iter().position(|d| d.name == *segment) {
                idx
            } else {
                let path = if current.path.is_empty() {
                    (*segment).to_owned()
                } else {
                    format!("{}/{segment}", current.path)
                };
                current.dirs.push(MutableDir {
                    name: (*segment).to_owned(),
                    path,
                    ..MutableDir::default()
                });
                current.dirs.len() - 1
            };
            current = &mut current.dirs[idx];
            current.additions += file.additions;
            current.deletions += file.deletions;
        }
        current.files.push(TurnDiffTreeNode {
            is_directory: false,
            name: (*file_name).to_owned(),
            path: segments.join("/"),
            additions: file.additions,
            deletions: file.deletions,
            children: Vec::new(),
        });
    }
    root.into_nodes()
}

/// Flattens the tree into visible rows. A folder is open when its `overrides` entry says so,
/// else when `all_expanded` is set (`collectExpandedRows`).
#[must_use]
pub fn flatten_turn_diff_tree(
    nodes: &[TurnDiffTreeNode],
    overrides: &HashMap<String, bool>,
    all_expanded: bool,
) -> Vec<TurnDiffRow> {
    fn walk(
        nodes: &[TurnDiffTreeNode],
        depth: usize,
        overrides: &HashMap<String, bool>,
        all_expanded: bool,
        out: &mut Vec<TurnDiffRow>,
    ) {
        for node in nodes {
            let expanded =
                node.is_directory && overrides.get(&node.path).copied().unwrap_or(all_expanded);
            out.push(TurnDiffRow {
                depth,
                is_directory: node.is_directory,
                expanded,
                name: node.name.clone(),
                path: node.path.clone(),
                additions: node.additions,
                deletions: node.deletions,
            });
            if expanded {
                walk(&node.children, depth + 1, overrides, all_expanded, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, 0, overrides, all_expanded, &mut out);
    out
}

// ---------------------------------------------------------------------------------------------
// Durations and timestamps
// ---------------------------------------------------------------------------------------------

/// Conn's `formatDuration`: `1ms`..`999ms`, `1.5s`/`2s` under 10s, whole seconds under a
/// minute (unit chosen after rounding), then `Xh Ym Zs` with zero parts omitted.
#[must_use]
pub fn format_duration(duration_ms: u64) -> String {
    if duration_ms < 1_000 {
        return format!("{}ms", duration_ms.max(1));
    }
    if duration_ms < 10_000 {
        let tenths = (duration_ms + 50) / 100;
        return if tenths.is_multiple_of(10) {
            format!("{}s", tenths / 10)
        } else {
            format!("{}.{}s", tenths / 10, tenths % 10)
        };
    }
    let total_secs = (duration_ms + 500) / 1_000;
    if total_secs < 60 {
        return format!("{total_secs}s");
    }
    let hours = total_secs / 3_600;
    let minutes = (total_secs % 3_600) / 60;
    let seconds = total_secs % 60;
    let mut parts: Vec<String> = Vec::with_capacity(3);
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if seconds > 0 {
        parts.push(format!("{seconds}s"));
    }
    parts.join(" ")
}

/// Local wall-clock date and time (the caller resolves the time zone).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalDateTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

impl LocalDateTime {
    /// Converts Unix ms to wall-clock time at a fixed UTC offset (seconds east of UTC).
    #[must_use]
    pub fn from_epoch_ms(epoch_ms: i64, utc_offset_secs: i64) -> Self {
        let secs = epoch_ms.div_euclid(1_000) + utc_offset_secs;
        let days = secs.div_euclid(86_400);
        let day_secs = secs.rem_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        Self {
            year,
            month,
            day,
            hour: u32::try_from(day_secs / 3_600).unwrap_or(0),
            minute: u32::try_from((day_secs % 3_600) / 60).unwrap_or(0),
        }
    }

    fn day_number(self) -> i64 {
        crate::thread::days_from_civil(self.year, self.month, self.day)
    }

    /// `HH:MM` in 24-hour time.
    #[must_use]
    pub fn time_label(self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

/// Conn's `formatDayAwareTimestamp`: the time today, `yesterday at <time>`, `M/D <time>` this
/// year, else `M/D/YYYY <time>`.
#[must_use]
pub fn format_day_aware_timestamp(at: LocalDateTime, now: LocalDateTime) -> String {
    let time = at.time_label();
    let day_diff = now.day_number() - at.day_number();
    if day_diff <= 0 {
        time
    } else if day_diff == 1 {
        format!("yesterday at {time}")
    } else if at.year == now.year {
        format!("{}/{} {time}", at.month, at.day)
    } else {
        format!("{}/{}/{} {time}", at.month, at.day, at.year)
    }
}

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn ordinal_suffix(day: u32) -> &'static str {
    if (11..=13).contains(&(day % 100)) {
        return "th";
    }
    match day % 10 {
        1 => "st",
        2 => "nd",
        3 => "rd",
        _ => "th",
    }
}

/// Conn's `formatChatTimestampTooltip`: `14:02, 22nd November 2026`.
#[must_use]
pub fn format_chat_timestamp_tooltip(at: LocalDateTime) -> String {
    let month = usize::try_from(at.month.saturating_sub(1))
        .ok()
        .and_then(|idx| MONTH_NAMES.get(idx))
        .copied()
        .unwrap_or("");
    format!(
        "{}, {}{} {month} {}",
        at.time_label(),
        at.day,
        ordinal_suffix(at.day),
        at.year
    )
}
