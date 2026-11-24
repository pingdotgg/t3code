//! One [`Connection`] per environment, for a client that shows several environments at once.
//!
//! Conn keeps a connection per saved environment and merges their shells into one thread list.
//! [`EnvironmentSet`] does the same bookkeeping for native clients: it starts a connection per
//! [`EnvironmentTarget`], subscribes the shell and server config, and fans every connection's
//! [`ClientEvent`]s into one receiver, tagged with the environment they came from.
//!
//! Additive: [`Connection::start`] and [`ClientEvent`] are unchanged, so a client that holds one
//! connection (the iPhone app) never needs this module.

use std::collections::HashMap;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::{ClientEvent, Connection, ServerConfig};

/// Capacity of the shared, bounded [`EnvironmentEvent`] channel.
const ENVIRONMENT_EVENT_CHANNEL_CAPACITY: usize = 2048;

/// Where and how to reach one environment.
#[derive(Clone, Debug)]
pub struct EnvironmentTarget {
    /// The environment's id (an Orbit `environment_id`).
    pub environment_id: String,
    /// What the sidebar calls it.
    pub label: String,
    pub config: ServerConfig,
}

/// One [`ClientEvent`] and the environment whose connection reported it.
#[derive(Clone, Debug)]
pub struct EnvironmentEvent {
    pub environment_id: String,
    pub event: ClientEvent,
}

struct Entry {
    label: String,
    connection: Connection,
    forwarder: JoinHandle<()>,
}

/// The connections of the environments a client shows beside its primary one.
pub struct EnvironmentSet {
    rt: tokio::runtime::Handle,
    tx: mpsc::Sender<EnvironmentEvent>,
    entries: HashMap<String, Entry>,
}

impl std::fmt::Debug for EnvironmentSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvironmentSet")
            .field("environments", &self.entries.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl EnvironmentSet {
    /// An empty set whose connections run on `rt`, and the receiver of their tagged events.
    #[must_use]
    pub fn new(rt: &tokio::runtime::Handle) -> (Self, mpsc::Receiver<EnvironmentEvent>) {
        let (tx, rx) = mpsc::channel(ENVIRONMENT_EVENT_CHANNEL_CAPACITY);
        (
            Self {
                rt: rt.clone(),
                tx,
                entries: HashMap::new(),
            },
            rx,
        )
    }

    /// Connects to `target` with the shell and server-config streams subscribed. A connection the
    /// set already holds for that environment is closed and replaced (a renewed credential).
    pub fn connect(&mut self, target: EnvironmentTarget) -> Connection {
        self.disconnect(&target.environment_id);
        let (connection, events) = Connection::start(target.config, &self.rt);
        connection.subscribe_shell_with_idle_subagents();
        connection.subscribe_server_config();
        let forwarder = self.rt.spawn(forward(
            target.environment_id.clone(),
            events,
            self.tx.clone(),
        ));
        self.entries.insert(
            target.environment_id,
            Entry {
                label: target.label,
                connection: connection.clone(),
                forwarder,
            },
        );
        connection
    }

    /// Closes and forgets the connection to `environment_id`. Events it already queued are
    /// dropped by the forwarder's abort, but one in flight may still arrive: callers ignore
    /// events of environments they no longer hold.
    pub fn disconnect(&mut self, environment_id: &str) -> bool {
        let Some(entry) = self.entries.remove(environment_id) else {
            return false;
        };
        entry.forwarder.abort();
        entry.connection.close();
        true
    }

    /// The connection to `environment_id`, if the set holds one.
    #[must_use]
    pub fn connection(&self, environment_id: &str) -> Option<&Connection> {
        self.entries
            .get(environment_id)
            .map(|entry| &entry.connection)
    }

    /// The label `environment_id` was connected with.
    #[must_use]
    pub fn label(&self, environment_id: &str) -> Option<&str> {
        self.entries
            .get(environment_id)
            .map(|entry| entry.label.as_str())
    }

    /// The ids of the environments the set holds, in no particular order.
    #[must_use]
    pub fn environment_ids(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    #[must_use]
    pub fn contains(&self, environment_id: &str) -> bool {
        self.entries.contains_key(environment_id)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Reconnects every held environment now, instead of after its backoff.
    pub fn reconnect_all(&self) {
        for entry in self.entries.values() {
            entry.connection.reconnect();
        }
    }
}

impl Drop for EnvironmentSet {
    fn drop(&mut self) {
        for (_, entry) in self.entries.drain() {
            entry.forwarder.abort();
            entry.connection.close();
        }
    }
}

/// Tags each event of `events` with `environment_id` and passes it on until either side closes.
pub(crate) async fn forward(
    environment_id: String,
    mut events: mpsc::Receiver<ClientEvent>,
    tx: mpsc::Sender<EnvironmentEvent>,
) {
    while let Some(event) = events.recv().await {
        let tagged = EnvironmentEvent {
            environment_id: environment_id.clone(),
            event,
        };
        if tx.send(tagged).await.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ConnectionStatus;

    #[tokio::test]
    async fn events_are_tagged_with_their_environment_and_keep_their_order() {
        let (tx, mut rx) = mpsc::channel(8);
        let (a_tx, a_rx) = mpsc::channel(8);
        let (b_tx, b_rx) = mpsc::channel(8);
        tokio::spawn(forward("env-a".to_owned(), a_rx, tx.clone()));
        tokio::spawn(forward("env-b".to_owned(), b_rx, tx));

        a_tx.send(ClientEvent::Status(ConnectionStatus::Connecting))
            .await
            .expect("a sends");
        a_tx.send(ClientEvent::Status(ConnectionStatus::Connected))
            .await
            .expect("a sends");
        b_tx.send(ClientEvent::Status(ConnectionStatus::Reconnecting {
            attempt: 2,
        }))
        .await
        .expect("b sends");
        drop((a_tx, b_tx));

        let mut from_a = Vec::new();
        let mut from_b = Vec::new();
        while let Some(tagged) = rx.recv().await {
            match tagged.environment_id.as_str() {
                "env-a" => from_a.push(tagged.event),
                "env-b" => from_b.push(tagged.event),
                other => panic!("an event from an unknown environment {other}"),
            }
        }
        assert!(matches!(
            from_a.as_slice(),
            [
                ClientEvent::Status(ConnectionStatus::Connecting),
                ClientEvent::Status(ConnectionStatus::Connected)
            ]
        ));
        assert!(matches!(
            from_b.as_slice(),
            [ClientEvent::Status(ConnectionStatus::Reconnecting {
                attempt: 2
            })]
        ));
    }

    #[tokio::test]
    async fn a_forwarder_ends_when_the_receiver_is_dropped() {
        let (tx, rx) = mpsc::channel(1);
        let (a_tx, a_rx) = mpsc::channel(1);
        let forwarder = tokio::spawn(forward("env-a".to_owned(), a_rx, tx));
        drop(rx);
        a_tx.send(ClientEvent::Status(ConnectionStatus::Connected))
            .await
            .expect("a sends");
        forwarder.await.expect("the forwarder ends");
    }

    #[test]
    fn a_set_connects_replaces_and_disconnects_by_environment() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .expect("a runtime");
        let (mut set, _events) = EnvironmentSet::new(rt.handle());
        let target = |id: &str, label: &str| EnvironmentTarget {
            environment_id: id.to_owned(),
            label: label.to_owned(),
            config: ServerConfig {
                http_base_url: url::Url::parse("http://127.0.0.1:9/").expect("a url"),
                credential: crate::Credential::Bearer("test".to_owned()),
            },
        };
        assert!(set.is_empty());
        set.connect(target("mini", "mini"));
        set.connect(target("nick-vm", "nick-vm"));
        assert_eq!(set.len(), 2);
        assert_eq!(set.label("mini"), Some("mini"));

        set.connect(target("mini", "mini (renewed)"));
        assert_eq!(set.len(), 2, "a second connect replaces the first");
        assert_eq!(set.label("mini"), Some("mini (renewed)"));

        assert!(set.disconnect("mini"));
        assert!(!set.disconnect("mini"));
        assert!(set.connection("mini").is_none());
        assert!(set.contains("nick-vm"));
    }
}
