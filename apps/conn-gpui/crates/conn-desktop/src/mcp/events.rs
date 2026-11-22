//! Pushes a session's events to the panel, until the session is retired.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use super::types::{McpEvent, McpEventKind};

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// One session's event sender. Once `retired` is set (replaced or disconnected), late events
/// are dropped, as in Conn.
#[derive(Debug, Clone)]
pub(crate) struct Emitter {
    tx: mpsc::Sender<McpEvent>,
    session_id: String,
    retired: Arc<AtomicBool>,
}

impl Emitter {
    pub(crate) fn new(tx: mpsc::Sender<McpEvent>, session_id: String) -> Self {
        Self {
            tx,
            session_id,
            retired: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// Marks the session retired; true when this call did it.
    pub(crate) fn retire(&self) -> bool {
        !self.retired.swap(true, Ordering::SeqCst)
    }

    pub(crate) async fn emit(&self, kind: McpEventKind) {
        if !self.is_retired() {
            self.emit_always(kind).await;
        }
    }

    /// Sends even when retired: the `closed` event goes out after the session retires itself.
    pub(crate) async fn emit_always(&self, kind: McpEventKind) {
        let _ = self
            .tx
            .send(McpEvent {
                session_id: self.session_id.clone(),
                at: now_ms(),
                kind,
            })
            .await;
    }
}
