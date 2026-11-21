//! Keeps the environment's label and Orbit Instance facts current while the server runs.
//!
//! Orbit renames a pre-warmed Instance when it finalizes it: it rewrites
//! `/etc/orbit/instance` and may change the hostname. Three triggers re-read both
//! ([`crate::environment::Environment::reload`]):
//!
//! - on Linux, an inotify watch on the file's folder, so an atomic rename is seen at once;
//! - `SIGHUP`, so Orbit can ask for a reload after it writes;
//! - a poll every [`POLL`], for the hostname and hosts without inotify.
//!
//! A changed descriptor reaches `/.well-known/t3/environment`, `/mcp` and every open
//! `subscribeServerConfig` stream (a new `snapshot`). Sockets and sessions stay as they are.

use std::{sync::Arc, time::Duration};

use crate::environment::Environment;

/// How often the label and the file are read without a trigger.
pub const POLL: Duration = Duration::from_secs(2);

/// Replaces SIGHUP's default action (stop the process) with a reload request. Call it
/// before startup work: a SIGHUP that arrives earlier would stop the server.
pub fn hangup() -> std::io::Result<tokio::signal::unix::Signal> {
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
}

/// Starts the reload task on the current runtime, with the handler from [`hangup`].
pub fn start(environment: Arc<Environment>, hangup: tokio::signal::unix::Signal) {
    start_with(environment, POLL, hangup);
}

pub(crate) fn start_with(
    environment: Arc<Environment>,
    poll: Duration,
    hangup: tokio::signal::unix::Signal,
) {
    let folder = folder_watch(&environment);
    tokio::spawn(run(environment, folder, poll, hangup));
}

async fn run(
    environment: Arc<Environment>,
    mut folder: Option<FolderWatch>,
    poll: Duration,
    hangup: tokio::signal::unix::Signal,
) {
    let mut hangup = Some(hangup);
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + poll, poll);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let reason = tokio::select! {
            changed = async { folder.as_mut()?.changed().await }, if folder.is_some() => {
                if changed.is_none() {
                    folder = None;
                    continue;
                }
                "the Orbit Instance folder changed"
            }
            received = async { hangup.as_mut()?.recv().await }, if hangup.is_some() => {
                if received.is_none() {
                    hangup = None;
                    continue;
                }
                "SIGHUP"
            }
            _ = tick.tick() => "poll",
        };
        let reader = environment.clone();
        if let Ok(true) = tokio::task::spawn_blocking(move || reader.reload()).await {
            eprintln!(
                "conn-server: environment reloaded ({reason}): label {:?}",
                environment.label()
            );
        }
    }
}

/// Signals from the inotify thread; one queued signal stands for any burst of events.
#[cfg(target_os = "linux")]
struct FolderWatch(tokio::sync::mpsc::Receiver<()>);

#[cfg(target_os = "linux")]
impl FolderWatch {
    /// Resolves after the next event in the folder; `None` when the watch broke.
    async fn changed(&mut self) -> Option<()> {
        self.0.recv().await
    }
}

/// An inotify watch on the Orbit Instance file's folder. Without the folder (not an Orbit
/// Instance, or not yet), the poll and `SIGHUP` still reload.
///
/// A blocking thread reads the inotify descriptor: tokio's safe `AsyncFd::new` is
/// deprecated and the workspace forbids `unsafe`. The thread ends at the first event after
/// the receiver is gone, or when the watch fails.
#[cfg(target_os = "linux")]
fn folder_watch(environment: &Environment) -> Option<FolderWatch> {
    use rustix::fs::inotify::{self, CreateFlags, WatchFlags};
    let folder = environment.orbit_instance_file().parent()?;
    let fd = inotify::init(CreateFlags::CLOEXEC).ok()?;
    let flags = WatchFlags::CLOSE_WRITE
        | WatchFlags::MOVED_TO
        | WatchFlags::MOVED_FROM
        | WatchFlags::CREATE
        | WatchFlags::DELETE
        | WatchFlags::ATTRIB;
    inotify::add_watch(&fd, folder, flags).ok()?;
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    std::thread::Builder::new()
        .name("conn-orbit-watch".into())
        .spawn(move || {
            use std::mem::MaybeUninit;
            let mut buf = [MaybeUninit::<u8>::uninit(); 4096];
            let mut reader = inotify::Reader::new(&fd, &mut buf);
            loop {
                match reader.next() {
                    // A full channel already holds a pending reload: the burst is one reload.
                    Ok(_) => {
                        if let Err(tokio::sync::mpsc::error::TrySendError::Closed(())) =
                            sender.try_send(())
                        {
                            return;
                        }
                    }
                    Err(rustix::io::Errno::INTR) => continue,
                    Err(error) => {
                        eprintln!("conn-server: the Orbit Instance watch stopped: {error}");
                        return;
                    }
                }
            }
        })
        .ok()?;
    Some(FolderWatch(receiver))
}

#[cfg(not(target_os = "linux"))]
struct FolderWatch;

#[cfg(not(target_os = "linux"))]
impl FolderWatch {
    async fn changed(&mut self) -> Option<()> {
        None
    }
}

#[cfg(not(target_os = "linux"))]
fn folder_watch(_: &Environment) -> Option<FolderWatch> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment(dir: &std::path::Path) -> Environment {
        let mut env =
            Environment::load(dir, Some("Box".into()), dir.to_owned(), Default::default()).unwrap();
        env.set_orbit_instance_file(dir.join("orbit").join("instance"));
        env
    }

    fn write_atomically(file: &std::path::Path, text: &str) {
        let temp = file.with_extension("tmp");
        std::fs::write(&temp, text).unwrap();
        std::fs::rename(&temp, file).unwrap();
    }

    #[test]
    fn reload_publishes_only_a_changed_descriptor() {
        let dir = std::env::temp_dir().join(format!("conn-reload-{}", crate::auth::random_hex(6)));
        let env = environment(&dir);
        let mut seen = env.subscribe_descriptor();
        assert!(env.descriptor().get("orbitInstance").is_none());
        assert!(!env.reload(), "nothing changed");
        assert!(!seen.has_changed().unwrap());

        std::fs::create_dir_all(dir.join("orbit")).unwrap();
        write_atomically(
            env.orbit_instance_file(),
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=reserved-1\n",
        );
        assert!(env.reload());
        assert!(seen.has_changed().unwrap());
        let descriptor = seen.borrow_and_update().clone();
        assert_eq!(descriptor["orbitInstance"]["instanceName"], "reserved-1");
        assert_eq!(descriptor["environmentId"], env.environment_id());
        assert_eq!(descriptor["label"], "Box", "--label stays");

        write_atomically(
            env.orbit_instance_file(),
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=feature-x\n",
        );
        assert!(env.reload());
        assert_eq!(
            env.descriptor()["orbitInstance"]["instanceName"],
            "feature-x"
        );
        std::fs::remove_file(env.orbit_instance_file()).unwrap();
        assert!(env.reload());
        assert!(env.descriptor().get("orbitInstance").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The folder watch (Linux) or `SIGHUP` reloads well before the poll would.
    #[tokio::test(flavor = "current_thread")]
    async fn a_trigger_reloads_before_the_poll() {
        let dir = std::env::temp_dir().join(format!("conn-reload-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(dir.join("orbit")).unwrap();
        let env = Arc::new(environment(&dir));
        let folder = folder_watch(&env);
        assert_eq!(folder.is_some(), cfg!(target_os = "linux"));
        let mut seen = env.subscribe_descriptor();
        tokio::spawn(run(
            env.clone(),
            folder,
            Duration::from_secs(3600),
            hangup().unwrap(),
        ));
        tokio::task::yield_now().await;
        write_atomically(
            env.orbit_instance_file(),
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=feature-x\n",
        );
        if !cfg!(target_os = "linux") {
            rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::HUP)
                .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(5), seen.changed())
            .await
            .expect("a reload within 5 s")
            .unwrap();
        assert_eq!(seen.borrow()["orbitInstance"]["instanceName"], "feature-x");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A connected client sees the new label and Orbit Instance on the socket it already has:
    /// a new `snapshot` on its open `subscribeServerConfig` stream, no reconnect.
    #[tokio::test(flavor = "current_thread")]
    async fn an_open_config_stream_receives_the_rename() {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::{Value, json};
        use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

        let dir = std::env::temp_dir().join(format!("conn-reload-{}", crate::auth::random_hex(6)));
        std::fs::create_dir_all(dir.join("orbit")).unwrap();
        let mut env = environment(&dir);
        let hostname = dir.join("hostname");
        std::fs::write(&hostname, "reserved-1\n").unwrap();
        env.set_hostname_file(hostname.clone());
        write_atomically(
            env.orbit_instance_file(),
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=reserved-1\n",
        );
        env.reload();
        let env = Arc::new(env);
        let deps = crate::methods::Deps {
            environment: Some(env.clone()),
            ..crate::methods::Deps::default()
        };
        let auth = env.auth.clone();
        let state = crate::AppState {
            table: Arc::new(crate::method_table(&deps)),
            auth: auth.clone(),
            descriptor: env.subscribe_descriptor(),
            engine: None,
            deps,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, crate::router(state)).await });
        start_with(env.clone(), Duration::from_secs(3600), hangup().unwrap());

        let session = auth
            .exchange(
                &auth
                    .issue_pairing_code(None, crate::auth::PAIRING_CODE_TTL_MS)
                    .unwrap()
                    .code,
                None,
                crate::auth::ClientInfo::default(),
            )
            .unwrap();
        let (ticket, _) = auth.issue_ticket(&session.token, Some("rpc")).unwrap();
        let request = format!("ws://{addr}/ws?orchestrationProtocol=2&wsTicket={ticket}")
            .into_client_request()
            .unwrap();
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
        socket
            .send(Message::Text(
                json!({"_tag": "Request", "id": "1", "tag": "subscribeServerConfig", "payload": {}, "headers": []})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        // The stream's values, in order; chunks are acked as a client does.
        let mut next_config = async || loop {
            let Some(Ok(Message::Text(text))) = socket.next().await else {
                panic!("the socket closed");
            };
            let frame: Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(frame["_tag"], "Chunk", "{frame}");
            socket
                .send(Message::Text(
                    json!({"_tag": "Ack", "requestId": frame["requestId"]})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            if let Some(event) = frame["values"]
                .as_array()
                .and_then(|values| values.iter().find(|v| v["type"] == "snapshot"))
            {
                return event["config"]["environment"].clone();
            }
        };
        let first = next_config().await;
        assert_eq!(first["label"], "reserved-1");
        assert_eq!(first["orbitInstance"]["instanceName"], "reserved-1");

        // Orbit's finalize: a new hostname and an atomically replaced Instance file.
        std::fs::write(&hostname, "feature-x\n").unwrap();
        write_atomically(
            env.orbit_instance_file(),
            "ORBIT_PROJECT_ID=7\nORBIT_INSTANCE_ID=41\nORBIT_INSTANCE=feature-x\n",
        );
        if !cfg!(target_os = "linux") {
            rustix::process::kill_process(rustix::process::getpid(), rustix::process::Signal::HUP)
                .unwrap();
        }
        let renamed = tokio::time::timeout(Duration::from_secs(5), next_config())
            .await
            .expect("a new snapshot within 5 s");
        assert_eq!(renamed["label"], "feature-x");
        assert_eq!(renamed["orbitInstance"]["instanceName"], "feature-x");
        assert_eq!(renamed["environmentId"], first["environmentId"]);
        drop(next_config);
        assert!(
            auth.client_session(&session.principal.session_id, None)
                .is_some_and(|s| s.connected)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
