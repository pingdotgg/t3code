//! Panel requests fan out to connected desktops; the first success answers the agent.

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::from_json;
    use serde_json::json;

    fn request() -> AgentPanelRequest {
        from_json(json!({"requestId":"pending", "threadId":"t", "panel":"mcp", "focusWindow":true}))
            .unwrap()
    }
    #[tokio::test(flavor = "current_thread")]
    async fn no_desktop_and_dropped_subscriptions_fail_clearly() {
        let broker = PanelBroker::default();
        assert_eq!(
            broker
                .show(request(), Duration::from_secs(15))
                .await
                .unwrap_err()
                .reason,
            "no_desktop"
        );
        let _linked = broker.subscribe_for(1, Some("t".into()), true).unwrap();
        assert!(!broker.has_desktop());
        let rx = broker.subscribe().unwrap();
        assert!(broker.has_desktop());
        drop(rx);
        assert!(!broker.has_desktop());
        assert_eq!(
            broker
                .show(request(), Duration::from_secs(15))
                .await
                .unwrap_err()
                .reason,
            "no_desktop"
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn fans_out_and_waits_past_a_refusal_for_the_first_success() {
        let broker = PanelBroker::default();
        let mut old = broker.subscribe().unwrap();
        let mut mac = broker.subscribe().unwrap();
        let (result, ()) = tokio::join!(broker.show(request(), Duration::from_secs(15)), async {
            let first = old.recv().await.unwrap();
            let second = mac.recv().await.unwrap();
            assert_eq!(first, second);
            broker.respond(
                from_json(json!({"requestId":first.request_id, "ok":false, "error":"Old desktop"}))
                    .unwrap(),
            );
            broker.respond(
                from_json(json!({"requestId":second.request_id, "ok":true, "deviceName":"Mac"}))
                    .unwrap(),
            );
        });
        assert_eq!(result.unwrap().device_name, Some("Mac".into()));
        assert!(broker.inner.lock().unwrap().pending.is_empty());
    }
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn all_refused_timeout_and_cancel_release_pending_requests() {
        let broker = PanelBroker::default();
        let mut desktop = broker.subscribe().unwrap();
        let (answer, ()) = tokio::join!(broker.show(request(), Duration::from_secs(1)), async {
            let request = desktop.recv().await.unwrap();
            broker.respond(
                from_json(
                    json!({"requestId":request.request_id,"ok":false,"error":"No MCP panel."}),
                )
                .unwrap(),
            );
        });
        assert_eq!(answer.unwrap_err().message, "No MCP panel.");
        assert_eq!(
            broker
                .show(request(), Duration::from_secs(1))
                .await
                .unwrap_err()
                .reason,
            "timeout"
        );
        {
            let mut waiting = Box::pin(broker.show(request(), Duration::from_secs(15)));
            tokio::select! { _ = &mut waiting => panic!("unexpected completion"), _ = desktop.recv() => {} }
        }
        assert!(
            broker.state().pending.is_empty(),
            "cancelled waits release pending entries"
        );
        broker.respond(from_json(json!({"requestId":"unknown","ok":true})).unwrap());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn subscribers_and_queues_are_bounded() {
        let broker = PanelBroker::default();
        let subscriptions: Vec<_> = (0..MAX_DESKTOPS)
            .map(|_| broker.subscribe().unwrap())
            .collect();
        assert!(broker.subscribe().is_err());
        drop(subscriptions);
        assert!(broker.subscribe().is_ok());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn pending_waits_are_bounded_and_aborting_releases_every_slot() {
        let broker = PanelBroker::default();
        let mut desktop = broker.subscribe().unwrap();
        let mut waits = Vec::new();
        for _ in 0..MAX_PENDING {
            let broker = broker.clone();
            waits.push(tokio::spawn(async move {
                broker.show(request(), Duration::from_secs(15)).await
            }));
            desktop.recv().await.unwrap();
        }
        assert_eq!(
            broker
                .show(request(), Duration::from_secs(15))
                .await
                .unwrap_err()
                .message,
            "Too many panel requests are waiting for Conn."
        );
        for wait in waits {
            wait.abort();
            assert!(wait.await.unwrap_err().is_cancelled());
        }
        assert!(broker.state().pending.is_empty());
    }
}

use conn_contract::{
    AgentPanelRequest, AgentPanelResponse,
    source::{DesktopPanelRequest, DesktopPanelResponse, FilesAction},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

/// Limits open desktop streams, queued requests per desktop, and simultaneous tool waits.
const MAX_DESKTOPS: usize = 16;
const MAX_PENDING: usize = 64;
const QUEUE_CAPACITY: usize = 16;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct PanelError {
    pub reason: &'static str,
    pub message: String,
}

#[derive(Debug)]
struct Pending {
    remaining: usize,
    answer: oneshot::Sender<DesktopPanelResponse>,
    connection: Option<u64>,
}
#[derive(Debug)]
struct Subscriber {
    connection: u64,
    files_thread: Option<String>,
    files_only: bool,
    tx: mpsc::Sender<DesktopPanelRequest>,
}

#[derive(Debug, Default)]
struct State {
    subscribers: Vec<Subscriber>,
    pending: HashMap<String, Pending>,
}

#[derive(Clone, Debug, Default)]
pub struct PanelBroker {
    inner: Arc<Mutex<State>>,
}

struct Waiting {
    broker: PanelBroker,
    id: String,
}
impl Drop for Waiting {
    fn drop(&mut self) {
        self.broker.state().pending.remove(&self.id);
    }
}

impl PanelBroker {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().expect("panel broker lock poisoned")
    }

    pub fn subscribe(&self) -> Result<mpsc::Receiver<DesktopPanelRequest>, PanelError> {
        self.subscribe_for(0, None, false)
    }
    pub fn subscribe_for(
        &self,
        connection: u64,
        files_thread: Option<String>,
        files_only: bool,
    ) -> Result<mpsc::Receiver<DesktopPanelRequest>, PanelError> {
        let mut state = self.state();
        state.subscribers.retain(|tx| !tx.tx.is_closed());
        if state.subscribers.len() >= MAX_DESKTOPS {
            return Err(PanelError {
                reason: "rejected",
                message: "Too many Conn desktops are connected.".into(),
            });
        }
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        state.subscribers.push(Subscriber {
            tx,
            connection,
            files_thread,
            files_only,
        });
        Ok(rx)
    }

    pub fn has_desktop(&self) -> bool {
        self.state()
            .subscribers
            .iter()
            .any(|s| !s.files_only && !s.tx.is_closed())
    }

    pub fn respond(&self, response: AgentPanelResponse) {
        self.respond_from(
            0,
            DesktopPanelResponse {
                panel: response,
                selection: None,
            },
        );
    }

    pub fn respond_from(&self, connection: u64, response: DesktopPanelResponse) {
        let mut state = self.state();
        let Some(entry) = state.pending.get_mut(&response.panel.request_id) else {
            return;
        };
        if entry.connection.is_some_and(|id| id != connection) {
            return;
        }
        entry.remaining = entry.remaining.saturating_sub(1);
        if (response.panel.ok || entry.remaining == 0)
            && let Some(entry) = state.pending.remove(&response.panel.request_id)
        {
            let _ = entry.answer.send(response);
        }
    }

    pub async fn show(
        &self,
        request: AgentPanelRequest,
        timeout: Duration,
    ) -> Result<AgentPanelResponse, PanelError> {
        self.show_action(request, None, timeout)
            .await
            .map(|answer| answer.panel)
    }

    pub async fn show_action(
        &self,
        mut request: AgentPanelRequest,
        files_action: Option<FilesAction>,
        timeout: Duration,
    ) -> Result<DesktopPanelResponse, PanelError> {
        let (answer, guard) = {
            let mut state = self.state();
            state.subscribers.retain(|tx| !tx.tx.is_closed());
            if state.subscribers.is_empty()
                || (files_action.is_none() && state.subscribers.iter().all(|s| s.files_only))
            {
                return Err(PanelError { reason:"no_desktop", message:"No Conn desktop app is connected to this server, so nothing can show the panel. Ask the user to open Conn on their Mac.".into() });
            }
            if state.pending.len() >= MAX_PENDING {
                return Err(PanelError {
                    reason: "rejected",
                    message: "Too many panel requests are waiting for Conn.".into(),
                });
            }
            request.request_id = conn_support::uuid_v4();
            let (tx, rx) = oneshot::channel();
            let mut remaining = 0;
            let targets: Vec<_> = state
                .subscribers
                .iter()
                .filter(|s| {
                    if files_action.is_some() {
                        s.files_thread.as_deref() == Some(&request.thread_id)
                    } else {
                        !s.files_only
                    }
                })
                .collect();
            if files_action.is_some() && targets.len() != 1 {
                return Err(PanelError {
                    reason: "rejected",
                    message: if targets.is_empty() {
                        "Open this thread in Conn GPUI to use Files."
                    } else {
                        "This thread is open in multiple windows. Keep it open in one to use Files."
                    }
                    .into(),
                });
            }
            let connection = files_action
                .as_ref()
                .and_then(|_| targets.first().map(|s| s.connection));
            let envelope = DesktopPanelRequest {
                panel: request.clone(),
                files_action,
            };
            for subscriber in targets {
                if subscriber.tx.try_send(envelope.clone()).is_ok() {
                    remaining += 1;
                }
            }
            if remaining == 0 {
                return Err(PanelError {
                    reason: "rejected",
                    message: "Conn could not receive the panel request.".into(),
                });
            }
            state.pending.insert(
                request.request_id.clone(),
                Pending {
                    remaining,
                    connection,
                    answer: tx,
                },
            );
            (
                rx,
                Waiting {
                    broker: self.clone(),
                    id: request.request_id.clone(),
                },
            )
        };
        let panel = conn_contract::to_json(&request.panel);
        let panel = panel.as_str().unwrap_or("requested");
        let result = tokio::time::timeout(timeout, answer).await;
        drop(guard);
        match result {
            Ok(Ok(mut response)) if response.panel.ok => {
                response
                    .panel
                    .device_name
                    .get_or_insert_with(|| "Conn desktop".into());
                Ok(response)
            }
            Ok(Ok(response)) => Err(PanelError {
                reason: "rejected",
                message: response
                    .panel
                    .error
                    .unwrap_or_else(|| format!("Conn could not show the {panel} panel.")),
            }),
            _ => Err(PanelError {
                reason: "timeout",
                message: format!(
                    "No Conn desktop showed the {panel} panel within {} s.",
                    timeout.as_secs_f64()
                ),
            }),
        }
    }
}
