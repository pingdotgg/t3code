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

use conn_contract::{AgentPanelRequest, AgentPanelResponse};
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
    answer: oneshot::Sender<AgentPanelResponse>,
}
#[derive(Debug, Default)]
struct State {
    subscribers: Vec<mpsc::Sender<AgentPanelRequest>>,
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

    pub fn subscribe(&self) -> Result<mpsc::Receiver<AgentPanelRequest>, PanelError> {
        let mut state = self.state();
        state.subscribers.retain(|tx| !tx.is_closed());
        if state.subscribers.len() >= MAX_DESKTOPS {
            return Err(PanelError {
                reason: "rejected",
                message: "Too many Conn desktops are connected.".into(),
            });
        }
        let (tx, rx) = mpsc::channel(QUEUE_CAPACITY);
        state.subscribers.push(tx);
        Ok(rx)
    }

    pub fn has_desktop(&self) -> bool {
        self.state().subscribers.iter().any(|tx| !tx.is_closed())
    }

    pub fn respond(&self, response: AgentPanelResponse) {
        let mut state = self.state();
        let Some(entry) = state.pending.get_mut(&response.request_id) else {
            return;
        };
        entry.remaining = entry.remaining.saturating_sub(1);
        if (response.ok || entry.remaining == 0)
            && let Some(entry) = state.pending.remove(&response.request_id)
        {
            let _ = entry.answer.send(response);
        }
    }

    pub async fn show(
        &self,
        mut request: AgentPanelRequest,
        timeout: Duration,
    ) -> Result<AgentPanelResponse, PanelError> {
        let (answer, guard) = {
            let mut state = self.state();
            state.subscribers.retain(|tx| !tx.is_closed());
            if state.subscribers.is_empty() {
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
            for subscriber in &state.subscribers {
                if subscriber.try_send(request.clone()).is_ok() {
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
            Ok(Ok(mut response)) if response.ok => {
                response
                    .device_name
                    .get_or_insert_with(|| "Conn desktop".into());
                Ok(response)
            }
            Ok(Ok(response)) => Err(PanelError {
                reason: "rejected",
                message: response
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
