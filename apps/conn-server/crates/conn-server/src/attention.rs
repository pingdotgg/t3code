//! The sender of attention events for iOS push (nckrtl/conn#229, section 1): it drains the
//! engine's outbox (`conn-engine/src/attention.rs`) to the Orbit Gateway, which sends the push.
//!
//! - Off unless `CONN_ATTENTION_PUSH=1` and this server has a sender. With it off, the engine
//!   writes nothing to the outbox.
//! - A failed send waits 1 s, 5 s, 30 s, then every 5 minutes. A 429, a 5xx or no answer is a
//!   failure; any other refusal drops the event, since sending it again cannot succeed.
//! - Events older than one hour are dropped: a stale "turn finished" is noise.
//! - The outbox is in SQLite, so events a sleeping container still holds go out on wake.
//!
//! Container servers send through the managed Gateway client (`POST /attention` under
//! `/api/v1/conn/managed`). Native servers (`POST /api/v1/conn/environments/{env}/attention`)
//! have no Gateway client yet: see [`native_sender`].

use std::{sync::Arc, time::Duration};

use conn_contract::attention::ConnAttentionEvent;
use conn_engine::SqliteEngine;
use futures_core::future::BoxFuture;

use crate::managed::gateway::{Gateway, GatewayError};

/// The variable that turns attention events on.
pub const ENABLE_VAR: &str = "CONN_ATTENTION_PUSH";
/// Events older than this are dropped, not sent.
pub const MAX_AGE: Duration = Duration::from_secs(60 * 60);
/// Events read from the outbox per pass.
const BATCH: usize = 32;
/// How long the sender waits after the outbox itself failed to answer.
const STORE_RETRY: Duration = Duration::from_secs(30);

/// Whether `CONN_ATTENTION_PUSH=1` asks for attention events.
pub fn enabled_by_env() -> bool {
    std::env::var_os(ENABLE_VAR).is_some_and(|v| v == "1")
}

/// Why one send did not land.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendError {
    /// Try again later: a 429, a 5xx, or no answer.
    RetryLater(String),
    /// The Gateway refused the event for good; it is dropped.
    Rejected(String),
}

/// Where events go. Tests use an in-memory sender.
pub trait AttentionSender: Send + Sync {
    fn send(&self, event: ConnAttentionEvent) -> BoxFuture<'static, Result<(), SendError>>;
}

/// The wait after `attempts` failed sends: 1 s, 5 s, 30 s, then every 5 minutes.
pub fn backoff(attempts: u32) -> Duration {
    Duration::from_secs(match attempts {
        0 | 1 => 1,
        2 => 5,
        3 => 30,
        _ => 5 * 60,
    })
}

/// A container server's sender: the managed Gateway client, with its credential, environment
/// ID and generation.
pub struct ManagedSender {
    gateway: Arc<dyn Gateway>,
}

impl std::fmt::Debug for ManagedSender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManagedSender").finish_non_exhaustive()
    }
}

impl ManagedSender {
    pub fn new(gateway: Arc<dyn Gateway>) -> Self {
        Self { gateway }
    }
}

impl AttentionSender for ManagedSender {
    fn send(&self, event: ConnAttentionEvent) -> BoxFuture<'static, Result<(), SendError>> {
        let body = match serde_json::to_value(&event) {
            Ok(body) => body,
            Err(error) => {
                return Box::pin(std::future::ready(Err(SendError::Rejected(
                    error.to_string(),
                ))));
            }
        };
        let call = self.gateway.attention(body);
        Box::pin(async move { call.await.map(drop).map_err(classify) })
    }
}

/// A 429, a 5xx or no answer is worth another try; any other refusal is not.
pub fn classify(error: GatewayError) -> SendError {
    match error {
        GatewayError::Transport(reason) => SendError::RetryLater(reason),
        GatewayError::Refused { status, code } if status == 429 || status >= 500 => {
            SendError::RetryLater(format!("{status} {code}"))
        }
        GatewayError::Refused { status, code } => SendError::Rejected(format!("{status} {code}")),
    }
}

/// A native server's sender (mini, nick.local).
///
/// TODO(nckrtl/conn#229): native servers have no Gateway client. The route is
/// `POST {gateway}/api/v1/conn/environments/{environment}/attention`, called by the server's
/// own Node over WireGuard like `conn:thread:record`. Until it is built this is `None`, and
/// a native server keeps attention events off.
pub fn native_sender() -> Option<Arc<dyn AttentionSender>> {
    None
}

/// What one pass did, for the log and the tests.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pass {
    pub sent: usize,
    pub retried: usize,
    pub rejected: usize,
    pub stale: usize,
    /// When the next event is due, by the engine's clock.
    pub next_due: Option<u64>,
}

/// Sends every event that is due now, once. Never logs a title or a token.
pub async fn drain_once(
    engine: &SqliteEngine,
    sender: &dyn AttentionSender,
    environment_id: &str,
) -> Result<Pass, String> {
    let now = engine.now_millis();
    let max_age = u64::try_from(MAX_AGE.as_millis()).unwrap_or(u64::MAX);
    let mut pass = Pass {
        stale: engine
            .attention_drop_older(now.saturating_sub(max_age))
            .await?,
        ..Pass::default()
    };
    for row in engine.attention_due(now, BATCH).await? {
        match sender.send(row.to_event(environment_id)).await {
            Ok(()) => {
                engine.attention_delivered(row.outbox_id).await?;
                pass.sent += 1;
            }
            Err(SendError::RetryLater(_)) => {
                let attempts = row.attempts.saturating_add(1);
                let wait = u64::try_from(backoff(attempts).as_millis()).unwrap_or(u64::MAX);
                engine
                    .attention_retry(row.outbox_id, attempts, now.saturating_add(wait))
                    .await?;
                pass.retried += 1;
            }
            Err(SendError::Rejected(reason)) => {
                eprintln!(
                    "conn-server: attention event {} dropped: {reason}",
                    row.event_id
                );
                engine.attention_delivered(row.outbox_id).await?;
                pass.rejected += 1;
            }
        }
    }
    pass.next_due = engine.attention_next_due().await?;
    Ok(pass)
}

/// Drains the outbox for as long as the server runs: at start (events left from before a
/// restart or a sleep), after each commit that wrote an event, and when a retry comes due.
pub fn spawn(
    engine: Arc<SqliteEngine>,
    sender: Arc<dyn AttentionSender>,
    environment_id: String,
) -> Option<tokio::task::JoinHandle<()>> {
    let signal = engine.attention_signal()?;
    Some(tokio::spawn(async move {
        loop {
            let wait = match drain_once(&engine, sender.as_ref(), &environment_id).await {
                Ok(pass) => pass.next_due.map(|at| {
                    let wait = Duration::from_millis(at.saturating_sub(engine.now_millis()));
                    // A due row this pass could not read must not spin the loop.
                    if pass.sent + pass.retried + pass.rejected == 0 {
                        wait.max(Duration::from_secs(1))
                    } else {
                        wait
                    }
                }),
                Err(error) => {
                    eprintln!("conn-server: attention outbox: {error}");
                    Some(STORE_RETRY)
                }
            };
            match wait {
                Some(Duration::ZERO) => tokio::task::yield_now().await,
                Some(wait) => {
                    tokio::select! {
                        () = signal.notified() => {}
                        () = tokio::time::sleep(wait) => {}
                    }
                }
                None => signal.notified().await,
            }
        }
    }))
}

#[cfg(test)]
#[path = "attention_tests.rs"]
mod tests;
