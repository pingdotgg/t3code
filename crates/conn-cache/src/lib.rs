#![forbid(unsafe_code)]

//! Durable conversation data shared by the desktop and iOS clients.

mod store;
use conn_client::{ClientError, Connection};
use conn_contract::ChatAttachment;
use conn_state::{ItemStatus, ReviewComment, ThreadState, TimelineEntry};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
pub use store::MessageCache;

pub const MESSAGE_CAP: usize = 1000;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Message {
    User {
        id: String,
        text: String,
        created_by_agent: bool,
        created_at: Option<String>,
        attachments: Vec<ChatAttachment>,
        is_steer: bool,
        /// Rows saved before review comments were kept have none.
        #[serde(default)]
        review_comments: Vec<ReviewComment>,
        run_id: Option<String>,
    },
    Assistant {
        id: String,
        markdown: String,
        created_at: Option<String>,
        run_id: Option<String>,
    },
}

impl Message {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. } | Self::Assistant { id, .. } => id,
        }
    }

    pub fn capture(entry: &TimelineEntry) -> Option<Self> {
        match entry {
            TimelineEntry::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => Some(Self::User {
                id: id.clone(),
                text: text.clone(),
                created_by_agent: *created_by_agent,
                created_at: created_at.clone(),
                attachments: attachments.clone(),
                is_steer: *is_steer,
                review_comments: review_comments.clone(),
                run_id: run_id.clone(),
            }),
            TimelineEntry::Assistant {
                id,
                markdown,
                created_at,
                run_id,
                ..
            } => Some(Self::Assistant {
                id: id.clone(),
                markdown: markdown.clone(),
                created_at: created_at.clone(),
                run_id: run_id.clone(),
            }),
            _ => None,
        }
    }

    pub fn entry(self) -> TimelineEntry {
        match self {
            Self::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            } => TimelineEntry::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                review_comments,
                run_id,
            },
            Self::Assistant {
                id,
                markdown,
                created_at,
                run_id,
            } => TimelineEntry::Assistant {
                id,
                markdown,
                created_at,
                run_id,
                streaming: false,
                status: ItemStatus::Completed,
            },
        }
    }
}

/// Fetches at most the missing prefix of a bounded snapshot, newest page first.
/// The result is chronological and contains each conversation row once.
///
/// # Errors
/// Returns a transport or codec error if any page fails. A cursor cycle is also an error:
/// callers must never commit a partial prefix as complete.
pub async fn fetch_history_prefix(
    connection: &Connection,
    thread: &str,
    cursor: &str,
    limit: usize,
) -> Result<Vec<Message>, ClientError> {
    let limit = limit.min(MESSAGE_CAP);
    let mut next = Some(cursor.to_owned());
    let mut messages = VecDeque::with_capacity(limit);
    let mut ids = HashSet::with_capacity(limit);
    let mut cursors = HashSet::new();
    while messages.len() < limit
        && let Some(cursor) = next.take()
    {
        if !cursors.insert(cursor.clone()) {
            return Err(ClientError::Connection(
                "repeated server history cursor".to_owned(),
            ));
        }
        let page = connection
            .fetch_thread_conversation_page(thread, &cursor)
            .await?;
        let mut state = ThreadState::new(thread);
        state.prepend_history_page(page);
        if state.has_more_history {
            next = Some(state.history_cursor.ok_or_else(|| {
                ClientError::Connection("missing server history cursor".to_owned())
            })?);
        }
        for entry in state.entries.iter().rev() {
            if let Some(message) = Message::capture(entry)
                && ids.insert(message.id().to_owned())
            {
                messages.push_front(message);
                if messages.len() == limit {
                    break;
                }
            }
        }
    }
    Ok(messages.into())
}
