//! Per-entry timeline row cache, flat virtual-list items, and turn TOC index.
//!
//! Designed for arbitrarily large threads (thousands of items):
//! - Assistant Markdown is parsed **lazily** on first render of a visible row
//!   rather than eagerly on `set_thread`, and reused across streaming updates
//!   whenever `(id, markdown)` is unchanged.
//! - Consecutive `Thinking` / `Tool` rows are pre-grouped into flat [`VirtualItem`]
//!   slots so GPUI's virtualized `list(ListState, ...)` renders in O(viewport).
//! - A lightweight [`TocEntry`] outline (one entry per user turn) is built in the
//!   same pass for the side message tracker and instant random-access jumps.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use conn_state::{EntryTiming, ItemStatus, TimelineEntry, TurnCheckpointSummary};

use super::markdown::{MarkdownBlock, parse_markdown};

/// Maximum characters stored for a single-line TOC turn preview.
const TOC_PREVIEW_MAX_CHARS: usize = 96;

/// A longer queue shows its first messages and a toggle that shows the rest (web `QUEUE_VISIBLE_ROWS`).
pub(super) const QUEUE_VISIBLE_ROWS: usize = 3;

/// One cached timeline row ready for virtualized rendering.
#[derive(Clone, Debug)]
pub(super) struct CachedRow {
    pub(super) entry: TimelineEntry,
    /// Lazily parsed Markdown blocks for `TimelineEntry::Assistant`; `None` until
    /// that row actually enters the virtualized viewport.
    blocks: RefCell<Option<Arc<[MarkdownBlock]>>>,
}

impl CachedRow {
    fn new(entry: TimelineEntry, blocks: Option<Arc<[MarkdownBlock]>>) -> Self {
        Self {
            entry,
            blocks: RefCell::new(blocks),
        }
    }

    /// Returns parsed Markdown blocks for an assistant entry, parsing and caching
    /// on first access. Returns an empty slice for non-assistant entries.
    pub(super) fn markdown_blocks(&self) -> Arc<[MarkdownBlock]> {
        let TimelineEntry::Assistant { markdown, .. } = &self.entry else {
            return Arc::from([]);
        };
        if let Some(existing) = self.blocks.borrow().as_ref() {
            return Arc::clone(existing);
        }
        let parsed: Arc<[MarkdownBlock]> = Arc::from(parse_markdown(markdown));
        *self.blocks.borrow_mut() = Some(Arc::clone(&parsed));
        parsed
    }

    /// Returns whether parsed Markdown blocks are already cached for this row.
    #[cfg(any(test, feature = "automation"))]
    pub(super) fn has_parsed_markdown(&self) -> bool {
        self.blocks.borrow().is_some()
    }
}

/// One flat row in GPUI's virtualized `ListState`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum VirtualItem {
    LoadEarlier {
        loading: bool,
    },
    User {
        row_idx: usize,
        grouped_with_previous: bool,
        grouped_with_next: bool,
    },
    QueuedUser {
        row_idx: usize,
        /// Index among the queued messages, and how many there are (the web `Queued message n of N`).
        position: usize,
        total: usize,
    },
    /// The `Show all N queued` / `Show fewer` toggle under a queue longer than
    /// `QUEUE_VISIBLE_ROWS` (web `QueuedRunsControl`).
    QueuedToggle {
        total: usize,
    },
    Assistant {
        row_idx: usize,
        followed_by_work: bool,
        /// Show Conn's hover meta bar (Copy, Fork, timestamp): the run's terminal assistant
        /// message once the run no longer streams (`terminalAssistantMessageIds`).
        show_meta: bool,
    },
    WorkGroup {
        id: String,
        row_start: usize,
        row_end: usize,
        has_active: bool,
        /// True when the group directly follows a steer message (`Continued for ...`).
        continues_steer: bool,
    },
    Approval {
        row_idx: usize,
    },
    /// An interactive or link card: user input request, secret request, proposed plan, or
    /// subagent.
    Card {
        row_idx: usize,
    },
    Notice {
        row_idx: usize,
    },
    ChangedFiles {
        run_id: String,
        summary: TurnCheckpointSummary,
    },
    Working,
}

impl VirtualItem {
    /// Stable identity key used to detect prefix preservation for `ListState::splice`.
    pub(super) fn stable_key(&self, rows: &[CachedRow]) -> String {
        match self {
            Self::LoadEarlier { loading } => format!("load-earlier:{}", *loading as u8),
            Self::User {
                row_idx,
                grouped_with_previous,
                grouped_with_next,
            } => format!(
                "u:{}:{}:{}",
                rows[*row_idx].entry.id(),
                *grouped_with_previous as u8,
                *grouped_with_next as u8
            ),
            Self::QueuedUser {
                row_idx,
                position,
                total,
            } => match &rows[*row_idx].entry {
                TimelineEntry::QueuedUser {
                    id,
                    run_id,
                    text,
                    attachments,
                    ..
                } => format!(
                    "qu:{id}:{run_id}:{:016x}:{}:{position}:{total}",
                    fnv1a64(text.as_bytes()),
                    attachments.len()
                ),
                other => format!("qu:{}", other.id()),
            },
            Self::QueuedToggle { total } => format!("qt:{total}"),
            Self::Assistant {
                row_idx,
                followed_by_work,
                show_meta,
            } => {
                let (id, len, streaming, status) = match &rows[*row_idx].entry {
                    TimelineEntry::Assistant {
                        id,
                        markdown,
                        streaming,
                        status,
                        ..
                    } => (id.as_str(), markdown.len(), *streaming, Some(*status)),
                    other => (other.id(), 0, false, None),
                };
                format!(
                    "a:{id}:{len}:{}:{streaming}:{status:?}:{}",
                    *followed_by_work as u8, *show_meta as u8
                )
            }
            Self::WorkGroup {
                id,
                row_start,
                row_end,
                has_active,
                continues_steer,
            } => format!(
                "w:{id}:{}:{}:{}:{}",
                row_end - row_start,
                rows[*row_end - 1].entry.id(),
                *has_active as u8,
                *continues_steer as u8
            ),
            Self::Approval { row_idx } => format!("ap:{}", rows[*row_idx].entry.id()),
            // Cards change shape with their status, answers, or streamed body.
            Self::Card { row_idx } => {
                let entry = &rows[*row_idx].entry;
                format!(
                    "c:{}:{:016x}",
                    entry.id(),
                    fnv1a64(format!("{entry:?}").as_bytes())
                )
            }
            Self::Notice { row_idx } => format!("n:{}", rows[*row_idx].entry.id()),
            Self::ChangedFiles { run_id, summary } => format!(
                "cf:{run_id}:{}:{}:{}:{}",
                summary.file_count,
                summary.additions,
                summary.deletions,
                summary.files.len()
            ),
            Self::Working => "working".to_owned(),
        }
    }

    /// Returns whether this virtual item contains an expandable entry/group matching `target_id`.
    pub(super) fn contains_expandable_id(&self, target_id: &str, rows: &[CachedRow]) -> bool {
        match self {
            Self::User { row_idx, .. } => {
                let id = rows[*row_idx].entry.id();
                target_id == id || target_id == format!("agent-msg-{id}")
            }
            Self::Assistant { row_idx, .. } => {
                let id = rows[*row_idx].entry.id();
                target_id == id || target_id.starts_with(&format!("{id}:"))
            }
            Self::WorkGroup {
                id,
                row_start,
                row_end,
                ..
            } => {
                target_id == id
                    || rows[*row_start..*row_end]
                        .iter()
                        .any(|r| r.entry.id() == target_id)
            }
            Self::Approval { row_idx }
            | Self::Notice { row_idx }
            | Self::QueuedUser { row_idx, .. } => rows[*row_idx].entry.id() == target_id,
            Self::Card { row_idx } => {
                let id = rows[*row_idx].entry.id();
                target_id == id || target_id.starts_with(&format!("{id}:"))
            }
            Self::ChangedFiles { run_id, .. } => {
                target_id.strip_prefix("changed-files:") == Some(run_id.as_str())
            }
            Self::LoadEarlier { .. } | Self::QueuedToggle { .. } | Self::Working => false,
        }
    }
}

/// One user-turn marker for the left-edge TimelineMinimap / TOC rail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TocEntry {
    /// 1-based user turn number.
    pub(super) turn_number: usize,
    /// Index in [`RowCache::items`] / GPUI `ListState` to jump to.
    pub(super) item_index: usize,
    /// Contract entry id of the user prompt starting this turn.
    pub(super) entry_id: String,
    /// Single-line truncated prompt preview.
    pub(super) preview: String,
    /// Optional short plain-text excerpt of the turn's assistant reply (for minimap hover card).
    pub(super) assistant_preview: Option<String>,
    /// Whether this turn was initiated by an agent prompt rather than the human user.
    pub(super) is_agent_prompt: bool,
    /// Whether the turn produced a git checkpoint with changed files.
    pub(super) has_checkpoint: bool,
    /// Whether any notice/tool in this turn failed.
    pub(super) has_error: bool,
}

/// Summary of work performed during [`RowCache::sync`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct SyncStats {
    pub(super) total: usize,
    pub(super) reused: usize,
    pub(super) invalidated: usize,
    /// Start index in the virtual list where changes begin (`ListState::splice`).
    pub(super) splice_start: usize,
    /// Exclusive end index in the previous virtual list where changes end.
    pub(super) splice_old_end: usize,
    /// Exclusive end index in the new virtual list where changes end.
    pub(super) splice_new_end: usize,
    /// Signed shift in virtual-item count above the unchanged tail when items are prepended
    /// (used to keep the user's viewport anchored when older history pages arrive).
    pub(super) prepended_delta: isize,
    /// Previous virtual item count before this sync.
    pub(super) old_item_count: usize,
    /// New virtual item count after this sync.
    pub(super) new_item_count: usize,
}

fn is_work_entry(entry: &TimelineEntry) -> bool {
    matches!(
        entry,
        TimelineEntry::Thinking { .. } | TimelineEntry::Tool { .. }
    )
}

fn is_active_work_entry(entry: &TimelineEntry) -> bool {
    matches!(
        entry,
        TimelineEntry::Thinking {
            streaming: true,
            ..
        } | TimelineEntry::Tool {
            status: ItemStatus::Running,
            ..
        }
    )
}

/// The task title for a delegated-task id: the matching `Subagent` row's title.
pub(super) fn delegated_task_title(rows: &[CachedRow], id: &str) -> Option<String> {
    rows.iter().find_map(|row| match &row.entry {
        TimelineEntry::Subagent {
            id: task_id,
            child_thread_id,
            title,
            ..
        } if task_id == id || child_thread_id.as_deref() == Some(id) => Some(title.clone()),
        _ => None,
    })
}

/// Agent-written text with delegated-task ids swapped for the task title (never the node id).
pub(super) fn humanize_task_ids<'a>(
    rows: &[CachedRow],
    text: &'a str,
) -> std::borrow::Cow<'a, str> {
    conn_state::conn_tools::humanize_delegated_task_ids(text, &|id| delegated_task_title(rows, id))
}

fn single_line_preview(text: &str) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Message");
    let mut out = String::new();
    for (count, ch) in first.chars().enumerate() {
        if count >= TOC_PREVIEW_MAX_CHARS {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn assistant_excerpt(markdown: &str) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    const MAX_EXCERPT_CHARS: usize = 160;
    for raw_line in markdown.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with("```") {
            continue;
        }
        let cleaned = trimmed
            .trim_start_matches('#')
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim()
            .replace("**", "")
            .replace('`', "");
        if cleaned.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
            chars += 1;
        }
        for ch in cleaned.chars() {
            if chars >= MAX_EXCERPT_CHARS {
                out.push('…');
                return out;
            }
            out.push(ch);
            chars += 1;
        }
    }
    out
}

/// Ordered cache of timeline rows, virtual list items, and turn TOC markers.
#[derive(Debug, Default)]
pub(super) struct RowCache {
    rows: Vec<CachedRow>,
    items: Vec<VirtualItem>,
    item_keys: Vec<String>,
    toc: Vec<TocEntry>,
}

impl RowCache {
    /// Returns the ordered cached rows.
    pub(super) fn rows(&self) -> &[CachedRow] {
        &self.rows
    }

    /// Returns the flat virtualized list items (`0..items.len()`).
    pub(super) fn items(&self) -> &[VirtualItem] {
        &self.items
    }

    /// Returns the lightweight turn TOC outline.
    pub(super) fn toc(&self) -> &[TocEntry] {
        &self.toc
    }

    /// Returns how many assistant rows currently hold parsed Markdown blocks.
    #[cfg(any(test, feature = "automation"))]
    pub(super) fn parsed_markdown_count(&self) -> usize {
        self.rows
            .iter()
            .filter(|row| row.has_parsed_markdown())
            .count()
    }

    /// Finds the virtual list item index owning `target_id` (for targeted `remeasure_items`).
    pub(super) fn find_item_index_for_id(&self, target_id: &str) -> Option<usize> {
        self.items
            .iter()
            .position(|item| item.contains_expandable_id(target_id, &self.rows))
    }

    /// Maps a viewport top virtual item index to the active TOC entry index in O(log turns).
    pub(super) fn active_toc_index(&self, top_item_index: usize) -> Option<usize> {
        if self.toc.is_empty() {
            return None;
        }
        let next_after = self
            .toc
            .partition_point(|entry| entry.item_index <= top_item_index);
        Some(next_after.saturating_sub(1))
    }

    /// Clears all cached rows, virtual items, and TOC entries.
    pub(super) fn clear(&mut self) {
        self.rows.clear();
        self.items.clear();
        self.item_keys.clear();
        self.toc.clear();
    }

    /// Synchronizes the cache against `entries`, `entry_timings`, `turn_checkpoints`,
    /// `working`, and bounded-history pagination flags, rebuilding [`Self::items`] and
    /// [`Self::toc`] without eagerly parsing Markdown.
    pub(super) fn sync(
        &mut self,
        entries: &[TimelineEntry],
        entry_timings: &HashMap<String, EntryTiming>,
        turn_checkpoints: &HashMap<String, TurnCheckpointSummary>,
        working: bool,
        has_more_history: bool,
        loading_earlier: bool,
    ) -> SyncStats {
        let mut previous: HashMap<String, CachedRow> = self
            .rows
            .drain(..)
            .map(|row| (row.entry.id().to_owned(), row))
            .collect();
        let old_keys = std::mem::take(&mut self.item_keys);
        let old_item_count = old_keys.len();

        let mut reused = 0usize;
        let mut invalidated = 0usize;

        self.rows.reserve(entries.len());
        for entry in entries {
            // An unchanged row (the common case on every streaming update) keeps its entry and
            // parsed Markdown as they are: comparing is far cheaper than cloning the bodies.
            let prev = match previous.remove(entry.id()) {
                Some(old) if old.entry == *entry => {
                    reused += 1;
                    self.rows.push(old);
                    continue;
                }
                other => other,
            };
            let blocks = match entry {
                TimelineEntry::Assistant { markdown, .. } => {
                    let unchanged = prev.as_ref().is_some_and(|old| match &old.entry {
                        TimelineEntry::Assistant {
                            markdown: old_md, ..
                        } => old_md == markdown,
                        _ => false,
                    });
                    if unchanged {
                        reused += 1;
                        prev.and_then(|old| old.blocks.into_inner())
                    } else {
                        invalidated += 1;
                        None
                    }
                }
                _ => {
                    if prev.is_some() {
                        reused += 1;
                    }
                    None
                }
            };
            self.rows.push(CachedRow::new(entry.clone(), blocks));
        }

        self.rebuild_virtual_items(
            entry_timings,
            turn_checkpoints,
            working,
            has_more_history,
            loading_earlier,
        );

        let new_item_count = self.items.len();
        let splice_start = old_keys
            .iter()
            .zip(self.item_keys.iter())
            .take_while(|(a, b)| a == b)
            .count();
        let common_suffix = old_keys[splice_start..]
            .iter()
            .rev()
            .zip(self.item_keys[splice_start..].iter().rev())
            .take_while(|(a, b)| a == b)
            .count();
        let splice_old_end = old_item_count - common_suffix;
        let splice_new_end = new_item_count - common_suffix;
        let at_head = splice_start == 0
            || (splice_start == 1
                && matches!(self.items.first(), Some(VirtualItem::LoadEarlier { .. })));
        let prepended_delta = if at_head && common_suffix > 0 {
            isize::try_from(splice_new_end).unwrap_or(isize::MAX)
                - isize::try_from(splice_old_end).unwrap_or(isize::MAX)
        } else {
            0
        };

        SyncStats {
            total: entries.len(),
            reused,
            invalidated,
            splice_start,
            splice_old_end,
            splice_new_end,
            prepended_delta,
            old_item_count,
            new_item_count,
        }
    }

    fn rebuild_virtual_items(
        &mut self,
        entry_timings: &HashMap<String, EntryTiming>,
        turn_checkpoints: &HashMap<String, TurnCheckpointSummary>,
        working: bool,
        has_more_history: bool,
        loading_earlier: bool,
    ) {
        let rows = &self.rows;
        // Terminal assistant message per run, and the live turn's start (after the last user
        // prompt) while working, for `show_meta`.
        let mut last_assistant_by_run: HashMap<&str, usize> = HashMap::new();
        for (i, row) in rows.iter().enumerate() {
            if let TimelineEntry::Assistant {
                run_id: Some(run), ..
            } = &row.entry
            {
                last_assistant_by_run.insert(run.as_str(), i);
            }
        }
        let live_turn_start = if working {
            rows.iter()
                .rposition(|r| matches!(r.entry, TimelineEntry::User { .. }))
                .map_or(0, |i| i + 1)
        } else {
            usize::MAX
        };
        let mut base_items: Vec<VirtualItem> = Vec::with_capacity(rows.len());
        let mut queued_items: Vec<VirtualItem> = Vec::new();
        let mut idx = 0usize;

        while idx < rows.len() {
            match &rows[idx].entry {
                TimelineEntry::Thinking { .. } | TimelineEntry::Tool { .. } => {
                    let start = idx;
                    while idx < rows.len() && is_work_entry(&rows[idx].entry) {
                        idx += 1;
                    }
                    let has_active = rows[start..idx]
                        .iter()
                        .any(|r| is_active_work_entry(&r.entry));
                    // Work right after a steer message folds under its own `Continued` row.
                    let continues_steer = start > 0
                        && matches!(
                            rows[start - 1].entry,
                            TimelineEntry::User { is_steer: true, .. }
                        );
                    base_items.push(VirtualItem::WorkGroup {
                        id: format!("work-group-{}", rows[start].entry.id()),
                        row_start: start,
                        row_end: idx,
                        has_active,
                        continues_steer,
                    });
                }
                TimelineEntry::User {
                    created_by_agent, ..
                } => {
                    let is_human_user = |entry: &TimelineEntry| {
                        matches!(
                            entry,
                            TimelineEntry::User {
                                created_by_agent: false,
                                ..
                            }
                        )
                    };
                    let grouped_with_previous =
                        !*created_by_agent && idx > 0 && is_human_user(&rows[idx - 1].entry);
                    let grouped_with_next = !*created_by_agent
                        && idx + 1 < rows.len()
                        && is_human_user(&rows[idx + 1].entry);
                    base_items.push(VirtualItem::User {
                        row_idx: idx,
                        grouped_with_previous,
                        grouped_with_next,
                    });
                    idx += 1;
                }
                TimelineEntry::QueuedUser { .. } => {
                    queued_items.push(VirtualItem::QueuedUser {
                        row_idx: idx,
                        position: queued_items.len(),
                        total: 0,
                    });
                    idx += 1;
                }
                TimelineEntry::Assistant {
                    run_id, streaming, ..
                } => {
                    let terminal = match run_id {
                        Some(run) => last_assistant_by_run.get(run.as_str()) == Some(&idx),
                        None => !rows[idx + 1..]
                            .iter()
                            .take_while(|r| !matches!(r.entry, TimelineEntry::User { .. }))
                            .any(|r| matches!(r.entry, TimelineEntry::Assistant { .. })),
                    };
                    let show_meta = terminal && !*streaming && idx < live_turn_start;
                    let followed_by_work = idx + 1 < rows.len()
                        && matches!(
                            rows[idx + 1].entry,
                            TimelineEntry::Thinking { .. }
                                | TimelineEntry::Tool { .. }
                                | TimelineEntry::Approval { .. }
                                | TimelineEntry::UserInputRequest { .. }
                                | TimelineEntry::SecretRequest { .. }
                                | TimelineEntry::Subagent { .. }
                        );
                    base_items.push(VirtualItem::Assistant {
                        row_idx: idx,
                        followed_by_work,
                        show_meta,
                    });
                    idx += 1;
                }
                TimelineEntry::Approval { .. } => {
                    base_items.push(VirtualItem::Approval { row_idx: idx });
                    idx += 1;
                }
                TimelineEntry::UserInputRequest { .. }
                | TimelineEntry::SecretRequest { .. }
                | TimelineEntry::ProposedPlan { .. }
                | TimelineEntry::Subagent { .. } => {
                    base_items.push(VirtualItem::Card { row_idx: idx });
                    idx += 1;
                }
                TimelineEntry::Notice { .. } => {
                    base_items.push(VirtualItem::Notice { row_idx: idx });
                    idx += 1;
                }
            }
        }

        let item_run_id = |item: &VirtualItem| -> Option<&str> {
            let id = match item {
                VirtualItem::User { row_idx, .. }
                | VirtualItem::Assistant { row_idx, .. }
                | VirtualItem::Approval { row_idx }
                | VirtualItem::Card { row_idx }
                | VirtualItem::Notice { row_idx } => rows[*row_idx].entry.id(),
                VirtualItem::WorkGroup { row_end, .. } => {
                    rows.get(row_end.saturating_sub(1))?.entry.id()
                }
                VirtualItem::LoadEarlier { .. }
                | VirtualItem::QueuedUser { .. }
                | VirtualItem::QueuedToggle { .. }
                | VirtualItem::ChangedFiles { .. }
                | VirtualItem::Working => return None,
            };
            entry_timings.get(id).and_then(|t| t.run_id.as_deref())
        };

        // When the turn is actively working, the trailing WorkGroup belongs to the live
        // turn even between consecutive tool calls (preventing a settled "Worked" flash).
        if working && let Some(VirtualItem::WorkGroup { has_active, .. }) = base_items.last_mut() {
            *has_active = true;
        }

        let working_before_idx = if working {
            base_items
                .last()
                .filter(|item| matches!(item, VirtualItem::WorkGroup { .. }))
                .map(|_| base_items.len() - 1)
        } else {
            None
        };

        let mut items: Vec<VirtualItem> = Vec::with_capacity(base_items.len() + 9);
        let mut toc: Vec<TocEntry> = Vec::new();

        if has_more_history {
            items.push(VirtualItem::LoadEarlier {
                loading: loading_earlier,
            });
        }

        for (base_idx, item) in base_items.iter().enumerate() {
            if working_before_idx == Some(base_idx) {
                items.push(VirtualItem::Working);
            }

            let out_idx = items.len();
            match item {
                VirtualItem::User {
                    row_idx,
                    grouped_with_previous,
                    ..
                } => {
                    if !*grouped_with_previous
                        && let TimelineEntry::User {
                            id,
                            text,
                            created_by_agent,
                            ..
                        } = &rows[*row_idx].entry
                    {
                        toc.push(TocEntry {
                            turn_number: toc.len() + 1,
                            item_index: out_idx,
                            entry_id: id.clone(),
                            preview: single_line_preview(&humanize_task_ids(rows, text)),
                            assistant_preview: None,
                            is_agent_prompt: *created_by_agent,
                            has_checkpoint: false,
                            has_error: false,
                        });
                    }
                }
                VirtualItem::Assistant { row_idx, .. } => {
                    if let TimelineEntry::Assistant { markdown, .. } = &rows[*row_idx].entry
                        && let Some(last) = toc.last_mut()
                    {
                        let excerpt = assistant_excerpt(markdown);
                        if !excerpt.is_empty() {
                            last.assistant_preview = Some(excerpt);
                        }
                    }
                }
                VirtualItem::WorkGroup {
                    row_start, row_end, ..
                } => {
                    let has_failed_tool = rows[*row_start..*row_end].iter().any(|r| {
                        matches!(
                            r.entry,
                            TimelineEntry::Tool {
                                status: ItemStatus::Failed,
                                ..
                            }
                        )
                    });
                    if has_failed_tool && let Some(last) = toc.last_mut() {
                        last.has_error = true;
                    }
                }
                VirtualItem::Notice { row_idx } => {
                    if matches!(
                        rows[*row_idx].entry,
                        TimelineEntry::Notice { is_error: true, .. }
                    ) && let Some(last) = toc.last_mut()
                    {
                        last.has_error = true;
                    }
                }
                VirtualItem::Card { row_idx } => {
                    if matches!(
                        rows[*row_idx].entry,
                        TimelineEntry::Subagent {
                            status: conn_state::TurnItemStatus::Failed,
                            ..
                        }
                    ) && let Some(last) = toc.last_mut()
                    {
                        last.has_error = true;
                    }
                }
                _ => {}
            }

            items.push(item.clone());

            // Insert ChangedFiles card after the final non-user item belonging to a run.
            if !matches!(item, VirtualItem::User { .. })
                && let Some(run_id) = item_run_id(item)
            {
                let next_same_run = base_items
                    .get(base_idx + 1)
                    .and_then(item_run_id)
                    .is_some_and(|next_id| next_id == run_id);
                if !next_same_run
                    && let Some(cp) = turn_checkpoints.get(run_id).filter(|c| c.file_count > 0)
                {
                    if let Some(last) = toc.last_mut() {
                        last.has_checkpoint = true;
                    }
                    items.push(VirtualItem::ChangedFiles {
                        run_id: run_id.to_owned(),
                        summary: cp.clone(),
                    });
                }
            }
        }

        if working && working_before_idx.is_none() {
            items.push(VirtualItem::Working);
        }

        // Queued user messages always render at the bottom of the timeline, after Working.
        let queued_total = queued_items.len();
        for item in &mut queued_items {
            if let VirtualItem::QueuedUser { total, .. } = item {
                *total = queued_total;
            }
        }
        items.extend(queued_items);
        if queued_total > QUEUE_VISIBLE_ROWS {
            items.push(VirtualItem::QueuedToggle {
                total: queued_total,
            });
        }

        let item_keys = items.iter().map(|item| item.stable_key(rows)).collect();
        self.items = items;
        self.item_keys = item_keys;
        self.toc = toc;
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_timings() -> HashMap<String, EntryTiming> {
        HashMap::new()
    }

    fn empty_checkpoints() -> HashMap<String, TurnCheckpointSummary> {
        HashMap::new()
    }

    /// Main-thread cost of opening a large thread, at the dev profile's opt-level.
    ///
    /// `cargo test -p conn-app --bin conn-app -- --ignored --nocapture bench_row_cache_sync`
    #[test]
    #[ignore = "latency benchmark; run explicitly"]
    fn bench_row_cache_sync() {
        use conn_state::testkit::{SyntheticThread, synthetic_thread_snapshot_json};
        use conn_state::{ThreadState, ThreadStreamItem};
        use std::time::Instant;
        for mib in [1usize, 5, 20] {
            let raw = synthetic_thread_snapshot_json(SyntheticThread::sized(mib * 1024 * 1024));
            let Ok(item) = serde_json::from_str::<ThreadStreamItem>(&raw) else {
                panic!("synthetic snapshot must decode");
            };
            let mut thread = ThreadState::new("bench");
            thread.apply(item);
            let mut cache = RowCache::default();
            let t = Instant::now();
            let first = cache.sync(
                &thread.entries,
                &thread.entry_timings,
                &thread.turn_checkpoints,
                false,
                false,
                false,
            );
            let first_ms = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            let again = cache.sync(
                &thread.entries,
                &thread.entry_timings,
                &thread.turn_checkpoints,
                false,
                false,
                false,
            );
            let again_ms = t.elapsed().as_secs_f64() * 1e3;
            let t = Instant::now();
            let timings = thread.entry_timings.clone();
            let clone_ms = t.elapsed().as_secs_f64() * 1e3;
            drop(timings);
            println!(
                "{} entries / {} items: first sync {first_ms:.1} ms, unchanged re-sync {again_ms:.1} ms (reused {}), entry_timings clone {clone_ms:.1} ms",
                first.total, first.new_item_count, again.reused
            );
        }
    }

    #[test]
    fn lazily_parses_markdown_and_reuses_unchanged_rows_across_streaming() {
        let mut cache = RowCache::default();
        let initial = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "Hello".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "First reply".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
            TimelineEntry::Assistant {
                id: "a2".to_owned(),
                markdown: "Streaming...".to_owned(),
                streaming: true,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
        ];

        let s1 = cache.sync(
            &initial,
            &empty_timings(),
            &empty_checkpoints(),
            true,
            false,
            false,
        );
        assert_eq!(s1.total, 3, "initial sync count");
        assert_eq!(
            cache.parsed_markdown_count(),
            0,
            "sync must NOT eagerly parse markdown for offscreen rows"
        );

        // Simulate rendering only `a1` (as if visible in viewport).
        let a1_blocks = cache.rows()[1].markdown_blocks();
        let a1_ptr = a1_blocks.as_ptr();
        assert_eq!(cache.parsed_markdown_count(), 1, "only rendered row parsed");

        // Stream a delta into `a2`; `a1` must keep the exact same Arc allocation,
        // and `splice_start` must preserve the unchanged prefix (`u1`, `a1`).
        let mut updated = initial.clone();
        updated[2] = TimelineEntry::Assistant {
            id: "a2".to_owned(),
            markdown: "Streaming... more text".to_owned(),
            streaming: true,
            created_at: None,
            run_id: None,
            status: ItemStatus::Completed,
        };
        let s2 = cache.sync(
            &updated,
            &empty_timings(),
            &empty_checkpoints(),
            true,
            false,
            false,
        );
        assert_eq!(s2.reused, 2, "user + unchanged assistant reused");
        assert_eq!(s2.invalidated, 1, "only changed assistant invalidated");
        assert_eq!(
            s2.splice_start, 2,
            "prefix u1 + a1 preserved for ListState::splice"
        );
        let a1_ptr_after = cache.rows()[1].markdown_blocks().as_ptr();
        assert_eq!(
            a1_ptr, a1_ptr_after,
            "unchanged assistant row must reuse Arc<[MarkdownBlock]>"
        );

        // Finishing streaming without changing markdown must also reuse parsed blocks.
        let _ = cache.rows()[2].markdown_blocks();
        assert_eq!(cache.parsed_markdown_count(), 2);
        updated[2] = TimelineEntry::Assistant {
            id: "a2".to_owned(),
            markdown: "Streaming... more text".to_owned(),
            streaming: false,
            created_at: None,
            run_id: None,
            status: ItemStatus::Completed,
        };
        let s3 = cache.sync(
            &updated,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            false,
            false,
        );
        assert_eq!(s3.invalidated, 0, "same markdown must not invalidate");
        assert_eq!(cache.parsed_markdown_count(), 2, "both parsed arcs kept");
    }

    #[test]
    fn builds_toc_outline_and_binary_searches_active_turn() {
        let mut cache = RowCache::default();
        let mut entries = Vec::new();
        let mut timings = HashMap::new();
        let mut checkpoints = HashMap::new();

        for turn in 1..=5 {
            entries.push(TimelineEntry::User {
                id: format!("u{turn}"),
                text: format!("Turn {turn} prompt\nsecond line"),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            });
            entries.push(TimelineEntry::Tool {
                id: format!("t{turn}"),
                kind: "command".to_owned(),
                title: "cargo test".to_owned(),
                detail: None,
                status: if turn == 3 {
                    ItemStatus::Failed
                } else {
                    ItemStatus::Completed
                },
                output_omitted: false,
            });
            let aid = format!("a{turn}");
            entries.push(TimelineEntry::Assistant {
                id: aid.clone(),
                markdown: format!("Reply {turn}"),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            });
            timings.insert(
                aid,
                EntryTiming {
                    run_id: Some(format!("r{turn}")),
                    started_at_ms: None,
                    completed_at_ms: None,
                },
            );
            if turn == 2 {
                checkpoints.insert(
                    format!("r{turn}"),
                    TurnCheckpointSummary {
                        run_id: format!("r{turn}"),
                        app_run_ordinal: Some(turn as i64),
                        file_count: 3,
                        additions: 42,
                        deletions: 7,
                        files: Vec::new(),
                    },
                );
            }
        }

        cache.sync(&entries, &timings, &checkpoints, false, false, false);
        assert_eq!(cache.toc().len(), 5, "one TOC entry per user turn");
        assert_eq!(cache.toc()[0].preview, "Turn 1 prompt");
        assert!(cache.toc()[1].has_checkpoint, "turn 2 flagged checkpoint");
        assert!(cache.toc()[2].has_error, "turn 3 flagged failed tool");

        // Virtual items for turn 1: [0]=u1, [1]=wg1, [2]=a1; turn 2 starts at [3]=u2.
        assert_eq!(cache.toc()[0].item_index, 0);
        assert_eq!(cache.toc()[1].item_index, 3);
        // Turn 2 has a ChangedFiles card at [6], so turn 3 starts at [7].
        assert_eq!(cache.toc()[2].item_index, 7);

        assert_eq!(cache.active_toc_index(0), Some(0));
        assert_eq!(cache.active_toc_index(2), Some(0));
        assert_eq!(cache.active_toc_index(3), Some(1));
        assert_eq!(cache.active_toc_index(6), Some(1));
        assert_eq!(cache.active_toc_index(7), Some(2));
        assert_eq!(cache.active_toc_index(999), Some(4));
    }

    #[test]
    fn groups_consecutive_work_entries_and_flags_neighbors() {
        let mut cache = RowCache::default();
        let entries = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "First".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::User {
                id: "u2".to_owned(),
                text: "Second".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::Thinking {
                id: "th1".to_owned(),
                text: "Plan".to_owned(),
                streaming: false,
            },
            TimelineEntry::Tool {
                id: "t1".to_owned(),
                kind: "command".to_owned(),
                title: "cargo test".to_owned(),
                detail: None,
                status: ItemStatus::Completed,
                output_omitted: false,
            },
            TimelineEntry::Approval {
                id: "ap1".to_owned(),
                title: "Run rm".to_owned(),
                detail: None,
            },
            TimelineEntry::Tool {
                id: "t2".to_owned(),
                kind: "file_change".to_owned(),
                title: "Edited main.rs".to_owned(),
                detail: None,
                status: ItemStatus::Running,
                output_omitted: false,
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "All done.".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
        ];
        cache.sync(
            &entries,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            false,
            false,
        );
        let items = cache.items();
        assert_eq!(
            items.len(),
            6,
            "expected 2 users, 2 work groups, 1 approval, 1 assistant"
        );
        assert_eq!(
            cache.toc().len(),
            1,
            "consecutive human user bubbles fold into one TOC turn"
        );
        assert!(matches!(
            items[0],
            VirtualItem::User {
                grouped_with_previous: false,
                grouped_with_next: true,
                ..
            }
        ));
        assert!(matches!(
            items[1],
            VirtualItem::User {
                grouped_with_previous: true,
                grouped_with_next: false,
                ..
            }
        ));
        assert!(matches!(
            &items[2],
            VirtualItem::WorkGroup {
                id,
                row_start: 2,
                row_end: 4,
                has_active: false,
                continues_steer: false,
            } if id == "work-group-th1"
        ));
        assert!(matches!(items[3], VirtualItem::Approval { row_idx: 4 }));
        assert!(matches!(
            &items[4],
            VirtualItem::WorkGroup {
                id,
                row_start: 5,
                row_end: 6,
                has_active: true,
                continues_steer: false,
            } if id == "work-group-t2"
        ));
        assert!(matches!(
            items[5],
            VirtualItem::Assistant {
                row_idx: 6,
                followed_by_work: false,
                show_meta: true,
            }
        ));
    }

    #[test]
    fn load_earlier_row_shifts_toc_and_tracks_prepend_delta_for_scroll_anchoring() {
        let mut cache = RowCache::default();
        let initial = vec![
            TimelineEntry::User {
                id: "u3".to_owned(),
                text: "Latest prompt".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::Assistant {
                id: "a3".to_owned(),
                markdown: "Latest reply".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
        ];

        // 1. Bounded snapshot with has_more_history=true prepends LoadEarlier at index 0.
        let s1 = cache.sync(
            &initial,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            true,
            false,
        );
        assert_eq!(s1.new_item_count, 3);
        assert_eq!(
            cache.items()[0],
            VirtualItem::LoadEarlier { loading: false }
        );
        assert_eq!(
            cache.toc()[0].item_index,
            1,
            "TOC turn 1 must account for LoadEarlier row at index 0"
        );

        // 2. Switching loading_earlier to true splices only index 0 with zero prepend delta.
        let s2 = cache.sync(
            &initial,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            true,
            true,
        );
        assert_eq!(s2.splice_start, 0);
        assert_eq!(s2.splice_old_end, 1);
        assert_eq!(s2.splice_new_end, 1);
        assert_eq!(s2.prepended_delta, 0);
        assert_eq!(cache.items()[0], VirtualItem::LoadEarlier { loading: true });

        // 3. Prepending 2 older entries while keeping has_more_history=true yields +2 delta.
        let with_page_2 = vec![
            TimelineEntry::User {
                id: "u2".to_owned(),
                text: "Middle prompt".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::Assistant {
                id: "a2".to_owned(),
                markdown: "Middle reply".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
            initial[0].clone(),
            initial[1].clone(),
        ];
        let s3 = cache.sync(
            &with_page_2,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            true,
            false,
        );
        assert_eq!(s3.splice_start, 0);
        assert_eq!(s3.splice_old_end, 1);
        assert_eq!(s3.splice_new_end, 3);
        assert_eq!(s3.prepended_delta, 2);
        assert_eq!(cache.items().len(), 5);

        // 4. Prepending final 2 entries with has_more_history=false removes LoadEarlier (+1 net delta).
        let with_page_1 = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "First prompt".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "First reply".to_owned(),
                streaming: false,
                created_at: None,
                run_id: None,
                status: ItemStatus::Completed,
            },
            with_page_2[0].clone(),
            with_page_2[1].clone(),
            with_page_2[2].clone(),
            with_page_2[3].clone(),
        ];
        let s4 = cache.sync(
            &with_page_1,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            false,
            false,
        );
        assert_eq!(s4.splice_start, 0);
        assert_eq!(s4.splice_old_end, 1);
        assert_eq!(s4.splice_new_end, 2);
        assert_eq!(s4.prepended_delta, 1);
        assert_eq!(cache.items().len(), 6);
        assert_eq!(cache.toc()[0].item_index, 0);

        // 5. Direct prepend with LoadEarlier staying loading=false (splice_start == 1) also shifts.
        let mut cache2 = RowCache::default();
        cache2.sync(
            &initial,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            true,
            false,
        );
        let s5 = cache2.sync(
            &with_page_2,
            &empty_timings(),
            &empty_checkpoints(),
            false,
            true,
            false,
        );
        assert_eq!(s5.splice_start, 1);
        assert_eq!(s5.prepended_delta, 2);
    }

    #[test]
    fn renders_queued_user_items_after_working_and_invalidates_on_edit() {
        let mut cache = RowCache::default();
        let entries = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "Start".to_owned(),
                created_by_agent: false,
                created_at: None,
                attachments: Vec::new(),
                is_steer: false,
                run_id: None,
            },
            TimelineEntry::QueuedUser {
                id: "turn-item:q1".to_owned(),
                run_id: "run-q1".to_owned(),
                message_id: "q1".to_owned(),
                text: "ABCD".to_owned(),
                attachments: Vec::new(),
                created_at: "2026-11-22T12:00:00.000Z".to_owned(),
                created_by_agent: false,
            },
        ];

        cache.sync(
            &entries,
            &empty_timings(),
            &empty_checkpoints(),
            true,
            false,
            false,
        );
        assert_eq!(
            cache.items().len(),
            3,
            "expected User, Working, then QueuedUser at the tail"
        );
        assert!(
            matches!(cache.items()[1], VirtualItem::Working),
            "Working row should precede queued messages"
        );
        assert!(
            matches!(cache.items()[2], VirtualItem::QueuedUser { row_idx: 1, .. }),
            "QueuedUser should sit at the bottom after Working"
        );
        assert_eq!(
            cache.toc().len(),
            1,
            "queued messages should not be counted as sent TOC turns"
        );

        // Same-length edit must still trigger a splice at the queued item's index.
        let mut edited = entries;
        if let TimelineEntry::QueuedUser { text, .. } = &mut edited[1] {
            *text = "WXYZ".to_owned();
        }
        let stats = cache.sync(
            &edited,
            &empty_timings(),
            &empty_checkpoints(),
            true,
            false,
            false,
        );
        assert_eq!(
            stats.splice_start, 2,
            "editing queued text to same length must invalidate its VirtualItem key"
        );
    }

    #[test]
    fn delegated_task_ids_in_agent_prompts_show_the_task_title() {
        let task_id = "node:delegated-task:command:mcp:abc:delegate-task";
        let rows = vec![CachedRow::new(
            TimelineEntry::Subagent {
                id: task_id.to_owned(),
                child_thread_id: None,
                title: "Fix the minimap".to_owned(),
                role: "claudeAgent".to_owned(),
                status: conn_state::TurnItemStatus::Completed,
                summary: None,
                remote_child: None,
                created_at: None,
                started_at: None,
                completed_at: None,
            },
            None,
        )];
        let text = format!("Delegated task {task_id} reached a terminal state.");
        assert_eq!(
            humanize_task_ids(&rows, &text),
            "Delegated task \u{201c}Fix the minimap\u{201d} reached a terminal state."
        );
        assert_eq!(
            humanize_task_ids(&[], &text),
            "Delegated task reached a terminal state."
        );
    }
}
