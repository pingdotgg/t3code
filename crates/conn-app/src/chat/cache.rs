//! Per-entry timeline row cache.
//!
//! Keeps parsed Markdown blocks cached by [`TimelineEntry::id`] so calling `set_thread`
//! on every streaming delta only re-parses the entry whose Markdown actually changed.

use std::collections::HashMap;
use std::sync::Arc;

use conn_state::TimelineEntry;

use super::markdown::{MarkdownBlock, parse_markdown};

/// One cached timeline row ready for rendering.
#[derive(Clone, Debug)]
pub(super) struct CachedRow {
    pub(super) entry: TimelineEntry,
    /// Parsed Markdown blocks for `TimelineEntry::Assistant`; `None` for other variants.
    pub(super) blocks: Option<Arc<[MarkdownBlock]>>,
}

/// Summary of work performed during [`RowCache::sync`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct SyncStats {
    pub(super) total: usize,
    pub(super) reparsed: usize,
    pub(super) reused: usize,
}

/// Ordered cache of timeline rows keyed by contract entry id.
#[derive(Debug, Default)]
pub(super) struct RowCache {
    rows: Vec<CachedRow>,
}

impl RowCache {
    /// Returns the ordered cached rows.
    pub(super) fn rows(&self) -> &[CachedRow] {
        &self.rows
    }

    /// Clears all cached rows (for example when no thread is selected).
    pub(super) fn clear(&mut self) {
        self.rows.clear();
    }

    /// Synchronizes the cache against the latest `entries` slice.
    ///
    /// Assistant entries whose `id` and `markdown` text are unchanged reuse their
    /// existing `Arc<Vec<MarkdownBlock>>` without re-parsing.
    pub(super) fn sync(&mut self, entries: &[TimelineEntry]) -> SyncStats {
        let mut previous: HashMap<String, CachedRow> = self
            .rows
            .drain(..)
            .map(|row| (row.entry.id().to_owned(), row))
            .collect();

        let mut stats = SyncStats {
            total: entries.len(),
            reparsed: 0,
            reused: 0,
        };

        self.rows.reserve(entries.len());
        for entry in entries {
            let prev = previous.remove(entry.id());
            let blocks = match entry {
                TimelineEntry::Assistant { markdown, .. } => {
                    let reusable = prev.as_ref().and_then(|old| match &old.entry {
                        TimelineEntry::Assistant {
                            markdown: old_md, ..
                        } if old_md == markdown => old.blocks.clone(),
                        _ => None,
                    });
                    if let Some(existing) = reusable {
                        stats.reused += 1;
                        Some(existing)
                    } else {
                        stats.reparsed += 1;
                        Some(Arc::from(parse_markdown(markdown)))
                    }
                }
                _ => {
                    if prev.is_some() {
                        stats.reused += 1;
                    }
                    None
                }
            };
            self.rows.push(CachedRow {
                entry: entry.clone(),
                blocks,
            });
        }

        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_state::ItemStatus;

    #[test]
    fn reuses_unchanged_assistant_markdown_and_reparses_only_streaming_entry() {
        let mut cache = RowCache::default();
        let initial = vec![
            TimelineEntry::User {
                id: "u1".to_owned(),
                text: "Hello".to_owned(),
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "First reply".to_owned(),
                streaming: false,
            },
            TimelineEntry::Assistant {
                id: "a2".to_owned(),
                markdown: "Streaming...".to_owned(),
                streaming: true,
            },
        ];

        let s1 = cache.sync(&initial);
        assert_eq!(s1.total, 3, "initial sync count");
        assert_eq!(s1.reparsed, 2, "both assistant entries parsed initially");
        assert_eq!(s1.reused, 0, "nothing cached yet");

        let a1_ptr = cache.rows()[1]
            .blocks
            .as_ref()
            .map(|b| b.as_ptr())
            .unwrap_or(std::ptr::null());

        // Stream a delta into `a2`; `a1` must keep the exact same Arc allocation.
        let mut updated = initial.clone();
        updated[2] = TimelineEntry::Assistant {
            id: "a2".to_owned(),
            markdown: "Streaming... more text".to_owned(),
            streaming: true,
        };
        let s2 = cache.sync(&updated);
        assert_eq!(s2.reparsed, 1, "only changed assistant entry reparsed");
        assert_eq!(s2.reused, 2, "user + unchanged assistant reused");
        let a1_ptr_after = cache.rows()[1]
            .blocks
            .as_ref()
            .map(|b| b.as_ptr())
            .unwrap_or(std::ptr::null());
        assert_eq!(
            a1_ptr, a1_ptr_after,
            "unchanged assistant row must reuse Arc<[MarkdownBlock]>"
        );

        // Finishing streaming without changing markdown must also reuse the parsed blocks.
        updated[2] = TimelineEntry::Assistant {
            id: "a2".to_owned(),
            markdown: "Streaming... more text".to_owned(),
            streaming: false,
        };
        let s3 = cache.sync(&updated);
        assert_eq!(
            s3.reparsed, 0,
            "toggling streaming flag with same markdown must not reparse"
        );
        assert_eq!(s3.reused, 3, "all three entries reused");
    }

    #[test]
    fn drops_removed_entries_and_handles_tool_updates() {
        let mut cache = RowCache::default();
        let entries = vec![
            TimelineEntry::Tool {
                id: "t1".to_owned(),
                kind: "command".to_owned(),
                title: "cargo test".to_owned(),
                detail: None,
                status: ItemStatus::Running,
            },
            TimelineEntry::Assistant {
                id: "a1".to_owned(),
                markdown: "Done".to_owned(),
                streaming: false,
            },
        ];
        cache.sync(&entries);
        assert_eq!(cache.rows().len(), 2, "two rows cached");

        cache.sync(&entries[..1]);
        assert_eq!(cache.rows().len(), 1, "removed assistant row dropped");
        assert_eq!(cache.rows()[0].entry.id(), "t1", "tool row remains");
    }
}
