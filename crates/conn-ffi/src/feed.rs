//! Thread card data crossing the iOS boundary.
use crate::{FfiError, FfiTaskSummary};
use conn_client::{Connection, StreamId};
use conn_state::thread_feed::FeedDetail;
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiReviewExcerpt {
    pub context_id: String,
    pub file_path: String,
    pub range_label: String,
    pub text: String,
    pub diff: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiFeedDetail {
    Message {
        sender: Option<String>,
        thread: Option<String>,
        environment: Option<String>,
        reviews: Vec<FfiReviewExcerpt>,
    },
    Html {
        attachment: String,
        title: String,
        height: u32,
    },
    Mcp {
        thread: String,
        attachment: String,
        title: String,
    },
    Task {
        task: FfiTaskSummary,
    },
    Subagent {
        provider: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        environment: Option<String>,
        thread: Option<String>,
    },
}

impl FfiFeedDetail {
    pub(crate) fn from_detail(detail: &FeedDetail) -> Option<Self> {
        Some(match detail {
            FeedDetail::Message {
                sender,
                thread,
                environment,
                reviews,
            } => Self::Message {
                sender: sender.clone(),
                thread: thread.clone(),
                environment: environment.clone(),
                reviews: reviews
                    .iter()
                    .map(|r| FfiReviewExcerpt {
                        context_id: r.context_id.clone(),
                        file_path: r.file_path.clone(),
                        range_label: r.range_label.clone(),
                        text: r.text.clone(),
                        diff: r.diff.clone(),
                    })
                    .collect(),
            },
            FeedDetail::Html {
                attachment,
                title,
                height,
            } => Self::Html {
                attachment: attachment.clone(),
                title: title.clone(),
                height: *height,
            },
            FeedDetail::Mcp {
                thread,
                attachment,
                title,
            } => Self::Mcp {
                thread: thread.clone(),
                attachment: attachment.clone(),
                title: title.clone(),
            },
            FeedDetail::Task(row) => Self::Task {
                task: (&conn_orbit::tasks::decode_task_created(&serde_json::json!({"data":row}))?)
                    .into(),
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct FfiSetupStage {
    pub id: String,
    pub status: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct FfiWorktreeSetup {
    pub thread_id: String,
    pub phase: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub stages: Vec<FfiSetupStage>,
    pub error: Option<String>,
}

#[derive(Debug, uniffi::Object)]
pub struct WorktreeSetupFeed {
    connection: Connection,
    id: StreamId,
    updates: Mutex<mpsc::Receiver<serde_json::Value>>,
}

impl WorktreeSetupFeed {
    pub(crate) fn start(connection: Connection, thread_id: String) -> Arc<Self> {
        let (id, updates) = connection.stream_json(
            "subscribeWorktreeSetup",
            serde_json::json!({"threadId":thread_id}),
        );
        Arc::new(Self {
            connection,
            id,
            updates: Mutex::new(updates),
        })
    }
}

#[uniffi::export]
impl WorktreeSetupFeed {
    pub async fn next(&self) -> Result<Option<FfiWorktreeSetup>, FfiError> {
        let item = self
            .updates
            .lock()
            .await
            .recv()
            .await
            .ok_or(FfiError::Closed)?;
        serde_json::from_value(item).map_err(|e| FfiError::Rpc {
            message: e.to_string(),
        })
    }

    pub fn cancel(&self) {
        self.connection.cancel_stream(self.id);
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiCodeSpan {
    pub text: String,
    pub color: crate::FfiColor,
    pub bold: bool,
    pub italic: bool,
}

#[uniffi::export]
pub fn highlight_code(source: String, language: String, theme: String) -> Vec<Vec<FfiCodeSpan>> {
    let Some(theme) = conn_theme::theme_by_id(&theme) else {
        return vec![];
    };
    conn_theme::highlight::highlight_lines(&language, &source, &conn_theme::Tokens::derive(&theme))
        .into_iter()
        .map(|line| {
            line.into_iter()
                .map(|s| FfiCodeSpan {
                    text: s.text,
                    color: s.color.into(),
                    bold: s.bold,
                    italic: s.italic,
                })
                .collect()
        })
        .collect()
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiPatchLine {
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub number: Option<u32>,
    pub marker: String,
    pub text: String,
}
#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiFilePatch {
    pub new_path: Option<String>,
    pub old_path: Option<String>,
    pub path: String,
    pub lines: Vec<FfiPatchLine>,
    pub binary: bool,
}

#[uniffi::export]
pub fn parse_file_patches(patch: String) -> Vec<FfiFilePatch> {
    file_patches(&patch)
}

pub(crate) fn file_patches(diff: &str) -> Vec<FfiFilePatch> {
    use conn_state::diff_parser::{DiffLineKind, parse_unified_diff};
    parse_unified_diff(diff)
        .into_iter()
        .map(|file| {
            let mut lines = Vec::new();
            for hunk in file.hunks {
                lines.push(FfiPatchLine {
                    old_line: None,
                    new_line: None,
                    number: None,
                    marker: "@@".into(),
                    text: hunk.header,
                });
                lines.extend(hunk.lines.into_iter().map(|line| {
                    FfiPatchLine {
                        old_line: line.old_line,
                        new_line: line.new_line,
                        number: line.new_line.or(line.old_line),
                        marker: match line.kind {
                            DiffLineKind::Added => "+",
                            DiffLineKind::Removed => "-",
                            DiffLineKind::Context => " ",
                        }
                        .into(),
                        text: line.text,
                    }
                }));
            }
            FfiFilePatch {
                new_path: file.new_path,
                old_path: file.old_path,
                path: file.display_path,
                binary: file.is_binary,
                lines,
            }
        })
        .collect()
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiChangedFileRow {
    pub path: String,
    pub name: String,
    pub depth: u32,
    pub directory: bool,
    pub expanded: bool,
    pub additions: i64,
    pub deletions: i64,
}

#[uniffi::export]
pub fn changed_file_rows(
    files: Vec<crate::FfiTurnCheckpointFile>,
    overrides: std::collections::HashMap<String, bool>,
    expanded: bool,
) -> Vec<FfiChangedFileRow> {
    let files: Vec<_> = files
        .into_iter()
        .map(|f| conn_state::TurnCheckpointFile {
            path: f.path,
            kind: f.kind,
            additions: f.additions,
            deletions: f.deletions,
        })
        .collect();
    conn_state::flatten_turn_diff_tree(
        &conn_state::build_turn_diff_tree(&files),
        &overrides,
        expanded,
    )
    .into_iter()
    .map(|r| FfiChangedFileRow {
        path: r.path,
        name: r.name,
        depth: u32::try_from(r.depth).unwrap_or(u32::MAX),
        directory: r.is_directory,
        expanded: r.expanded,
        additions: r.additions,
        deletions: r.deletions,
    })
    .collect()
}
