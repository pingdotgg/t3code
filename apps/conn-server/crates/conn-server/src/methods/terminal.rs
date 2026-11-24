//! `terminal.*` and `subscribeTerminalMetadata`, served by one `conn_terminal::TerminalManager`.
//! Owner: the terminal track.
//!
//! Inputs are checked against the contract's bounds here, as Effect's schema does in the T3
//! server: a payload outside them is a defect, not a typed error.

use std::{future::Future, path::PathBuf, sync::Arc};

use conn_contract::{
    TerminalAttachInput, TerminalAttachStreamEvent, TerminalClearInput, TerminalCloseInput,
    TerminalMetadataStreamEvent, TerminalOpenError, TerminalOpenInput, TerminalResizeInput,
    TerminalWriteInput, to_json,
};
use conn_engine::{Engine, ThreadWorktree};
use conn_terminal::{MetadataSubscription, Subscription, TerminalConfig, TerminalManager};
use serde::Serialize;
use tokio::sync::mpsc;

use super::Deps;
use crate::{
    environment::CONTRACT_SERVER_VERSION,
    table::{Failure, ItemStream, MethodTable},
};

/// Values a stream may have waiting for the session. The session puts at most 64 KiB of them
/// (by T3's charge) in one chunk, as T3's `takeBatch` does.
const STREAM_BUFFER: usize = 4;

/// The manager terminals of this environment share; scrollback lives under the state folder.
pub fn manager(environment: Option<&crate::environment::Environment>) -> TerminalManager {
    TerminalManager::new(TerminalConfig {
        history_dir: environment.map(|e| e.state_dir.join("terminals")),
        t3_history_dir: environment.map(|e| e.state_dir.join("logs").join("terminals")),
        version: CONTRACT_SERVER_VERSION.into(),
        ..TerminalConfig::default()
    })
}

/// T3 opens a terminal under the folder's workspace lease (`Manager.openLocked`), the one
/// worktree cleanup removes a checkout under.
async fn lease<'a>(
    leases: Option<&'a conn_vcs::locks::WorkspaceLocks>,
    folder: Option<&str>,
) -> Option<conn_vcs::locks::WorkspaceLock<'a>> {
    match (leases, folder) {
        (Some(leases), Some(folder)) => Some(leases.workspace(folder).await),
        _ => None,
    }
}

pub fn register(table: &mut MethodTable, deps: &Deps) {
    let manager = deps
        .terminals
        .clone()
        .unwrap_or_else(|| manager(deps.environment.as_deref()));

    let restore = Restore {
        engine: deps.engine.clone(),
        environment: deps.environment.clone(),
        locks: Arc::default(),
    };
    let (m, r) = (manager.clone(), restore.clone());
    let leases = deps.workspace_locks.clone();
    table.unary("terminal.open", move |_, mut input: TerminalOpenInput| {
        let (m, r, leases) = (m.clone(), r.clone(), leases.clone());
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            check_grid(input.cols, input.rows)?;
            input.env = launch_env(
                r.environment.as_deref(),
                input.provider_instance_id.as_deref(),
                input.env.take(),
            )?;
            m.adopt_t3_history(&input.thread_id, &input.terminal_id)
                .await;
            let worktree = r.worktree_of(&input.thread_id, &input.cwd).await;
            if let Some(w) = &worktree {
                input.worktree_path = Some(Some(w.worktree_path.clone()));
            }
            // Held across the open, the restore and the retry, as turns and captures hold it. A
            // terminal outside the thread's worktree leases its own folder (`openLocked`).
            let folder = input.worktree_path.clone().flatten();
            let _lease = match &worktree {
                Some(_) => r.lease(worktree.as_ref()).await,
                None => {
                    lease(
                        leases.as_deref(),
                        Some(folder.as_deref().unwrap_or(&input.cwd)),
                    )
                    .await
                }
            };
            match m.open(input.clone()) {
                Err(TerminalOpenError::TerminalCwdNotFoundError(_))
                    if r.restore(worktree.as_ref()).await =>
                {
                    m.open(input)
                }
                opened => opened,
            }
            .map_err(|e| Failure::fail(&e))
        }
    });
    let (m, r) = (manager.clone(), restore);
    let leases = deps.workspace_locks.clone();
    table.stream(
        "terminal.attach",
        move |ctx, mut input: TerminalAttachInput| {
            let (m, r, leases) = (m.clone(), r.clone(), leases.clone());
            async move {
                check_session(&input.thread_id, &input.terminal_id)?;
                check_grid(input.cols, input.rows)?;
                // A reconnect joins the running shell as it is (T3 resolves only to launch).
                let launches = m.attach_starts_shell(&input);
                let mut worktree = None;
                if launches {
                    m.adopt_t3_history(&input.thread_id, &input.terminal_id)
                        .await;
                    input.env = launch_env(
                        r.environment.as_deref(),
                        input.provider_instance_id.as_deref(),
                        input.env.take(),
                    )?;
                    let cwd = input.cwd.as_deref().unwrap_or_default();
                    worktree = r.worktree_of(&input.thread_id, cwd).await;
                    if let Some(w) = &worktree {
                        input.worktree_path = Some(Some(w.worktree_path.clone()));
                    }
                }
                // As at open; only an attach that starts a shell takes a lease.
                let folder = input.worktree_path.clone().flatten();
                let _lease = match (&worktree, input.cwd.as_deref()) {
                    (Some(_), _) => r.lease(worktree.as_ref()).await,
                    (None, Some(cwd)) if launches => {
                        lease(leases.as_deref(), Some(folder.as_deref().unwrap_or(cwd))).await
                    }
                    (None, _) => None,
                };
                let sub = match m.attach(input.clone(), ctx.connection_id) {
                    Err(TerminalOpenError::TerminalCwdNotFoundError(_))
                        if r.restore(worktree.as_ref()).await =>
                    {
                        m.attach(input, ctx.connection_id)
                    }
                    attached => attached,
                }
                .map_err(|e| Failure::fail(&e))?;
                Ok(forward(sub))
            }
        },
    );
    let m = manager.clone();
    table.stream("terminal.observe", move |_, input: TerminalClearInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            let sub = m.observe(input).map_err(|e| Failure::fail(&e))?;
            Ok(forward(sub))
        }
    });
    let m = manager.clone();
    table.unary("terminal.write", move |ctx, input: TerminalWriteInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            // `Schema.isMaxLength` counts UTF-16 code units.
            let units = input.data.encode_utf16().count();
            if units == 0 || units > 65_536 {
                return Err(Failure::die(format!(
                    "terminal.write data must hold 1 to 65536 characters, not {units}"
                )));
            }
            m.write(input, Some(ctx.connection_id))
                .await
                .map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.resize", move |ctx, input: TerminalResizeInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            check_grid(Some(input.cols), Some(input.rows))?;
            m.resize(input, Some(ctx.connection_id))
                .map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.clear", move |_, input: TerminalClearInput| {
        let m = m.clone();
        async move {
            check_session(&input.thread_id, &input.terminal_id)?;
            m.clear(input).map_err(|e| Failure::fail(&e))
        }
    });
    let m = manager.clone();
    table.unary("terminal.close", move |_, input: TerminalCloseInput| {
        let m = m.clone();
        async move {
            check_id(&input.thread_id, usize::MAX)?;
            if let Some(terminal_id) = &input.terminal_id {
                check_id(terminal_id, 128)?;
            }
            m.close(input);
            Ok(())
        }
    });
    table.stream(
        "subscribeTerminalMetadata",
        move |_, _: serde_json::Value| {
            let sub = manager.subscribe_metadata();
            async move { Ok(forward(sub)) }
        },
    );
}

/// A terminal or metadata subscription.
trait Source: Send + 'static {
    type Item: Serialize + Send;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send;
}

impl Source for Subscription {
    type Item = TerminalAttachStreamEvent;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send {
        Subscription::next(self)
    }
}

impl Source for MetadataSubscription {
    type Item = TerminalMetadataStreamEvent;
    fn next(&mut self) -> impl Future<Output = Self::Item> + Send {
        MetadataSubscription::next(self)
    }
}

/// Passes a subscription's events to the session until the client unsubscribes; then the
/// subscription is dropped, which unsubscribes it from the terminal.
fn forward(mut source: impl Source) -> ItemStream {
    let (tx, rx) = mpsc::channel(STREAM_BUFFER);
    tokio::spawn(async move {
        loop {
            let item = tokio::select! {
                () = tx.closed() => return,
                item = source.next() => item,
            };
            if tx.send(Ok(to_json(&item))).await.is_err() {
                return;
            }
        }
    });
    rx
}

/// `TerminalCwdRecovery` from `prepareTerminalLaunch` (T3 `restoreMissingWorktree.ts`): a
/// terminal whose folder is inside its thread's managed worktree, gone with its branch kept,
/// gets the checkout back before the open is tried again.
#[derive(Clone)]
struct Restore {
    engine: Option<Arc<dyn Engine>>,
    environment: Option<Arc<crate::environment::Environment>>,
    /// For an engine without workspace locks of its own.
    locks: Arc<conn_vcs::locks::WorkspaceLocks>,
}

impl Restore {
    /// The thread's worktree when the terminal's `cwd` lies in it; the launch records its path,
    /// as T3's `prepareTerminalLaunch` does.
    async fn worktree_of(&self, thread_id: &str, cwd: &str) -> Option<ThreadWorktree> {
        let worktree = self
            .engine
            .as_ref()?
            .thread_worktree(thread_id)
            .await
            .ok()??;
        let root = PathBuf::from(&worktree.worktree_path);
        let target = conn_files::paths::normalize(&root.join(cwd));
        conn_files::paths::is_within(&target, &root).then_some(worktree)
    }

    /// The workspace lease for `worktree` (`withWorkspaceLease`), shared with the engine's turn
    /// preparation and checkpoint capture.
    async fn lease<'a>(
        &'a self,
        worktree: Option<&'a ThreadWorktree>,
    ) -> Option<conn_vcs::locks::WorkspaceLock<'a>> {
        let root = worktree?.worktree_path.as_str();
        if let Some(engine) = &self.engine
            && let Some(lease) = engine.workspace_lease(root).await
        {
            return Some(lease);
        }
        Some(self.locks.workspace(root).await)
    }

    /// Whether `worktree` is a checkout again (`host::restore_thread_worktree`). The caller
    /// holds its lease.
    async fn restore(&self, worktree: Option<&ThreadWorktree>) -> bool {
        match (worktree, &self.environment) {
            (Some(worktree), Some(environment)) => {
                crate::host::restore_thread_worktree(environment, worktree).await
            }
            _ => false,
        }
    }
}

/// `resolveLaunchInputEnvironment`: a terminal opened for a provider instance starts with that
/// instance's environment; an instance the settings do not have is refused.
fn launch_env(
    environment: Option<&crate::environment::Environment>,
    instance_id: Option<&str>,
    env: Option<conn_contract::support::Map<String, String>>,
) -> Result<Option<conn_contract::support::Map<String, String>>, Failure> {
    let Some(instance_id) = instance_id else {
        return Ok(env);
    };
    environment
        .and_then(|e| {
            crate::settings::provider_terminal_env(
                &e.settings.raw(),
                instance_id,
                env.unwrap_or_default(),
            )
        })
        .map(Some)
        .ok_or_else(|| {
            Failure::fail(&conn_contract::TerminalProviderInstanceNotFoundError {
                tag: Default::default(),
                provider_instance_id: instance_id.to_owned(),
            })
        })
}

fn check_session(thread_id: &str, terminal_id: &str) -> Result<(), Failure> {
    check_id(thread_id, usize::MAX)?;
    check_id(terminal_id, 128)
}

/// `TrimmedNonEmptyString`, with the terminal id's 128-character cap.
fn check_id(id: &str, max: usize) -> Result<(), Failure> {
    if id.is_empty() || id.trim() != id || id.encode_utf16().count() > max {
        return Err(Failure::die(format!(
            "invalid terminal or thread id {id:?}"
        )));
    }
    Ok(())
}

fn check_grid(cols: Option<i64>, rows: Option<i64>) -> Result<(), Failure> {
    let cols_ok = cols.is_none_or(|c| (1..=1000).contains(&c));
    let rows_ok = rows.is_none_or(|r| (1..=500).contains(&r));
    if cols_ok && rows_ok {
        Ok(())
    } else {
        Err(Failure::die(format!(
            "terminal size out of range: {cols:?} columns, {rows:?} rows"
        )))
    }
}

#[cfg(test)]
mod tests {
    //! The terminal methods through a real session, with a real shell, as the client sees them.

    use std::{sync::Arc, time::Duration};

    use conn_wire::ack_window;
    use serde_json::{Value, json};
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    use super::*;
    use crate::session::{Incoming, SessionOptions, Transport, run};

    struct Socket {
        incoming: UnboundedReceiver<Incoming>,
        sent: UnboundedSender<String>,
    }

    impl Transport for Socket {
        async fn recv(&mut self) -> Incoming {
            self.incoming.recv().await.unwrap_or(Incoming::Closed)
        }
        async fn send(&mut self, text: String) -> bool {
            self.sent.send(text).is_ok()
        }
        async fn close(&mut self, _: u16, _: &'static str) {}
    }

    struct Client {
        to_server: UnboundedSender<Incoming>,
        from_server: UnboundedReceiver<String>,
    }

    impl Client {
        fn connect() -> Self {
            Self::connect_with(&Deps::default())
        }

        fn connect_with(deps: &Deps) -> Self {
            let mut table = MethodTable::new();
            register(&mut table, deps);
            let (to_server, incoming) = unbounded_channel();
            let (sent, from_server) = unbounded_channel();
            tokio::spawn(run(
                Socket { incoming, sent },
                Arc::new(table),
                SessionOptions::default(),
            ));
            Self {
                to_server,
                from_server,
            }
        }

        fn send(&self, frame: Value) {
            let _ = self.to_server.send(Incoming::Text(frame.to_string()));
        }

        fn request(&self, id: i64, tag: &str, payload: Value) {
            self.send(
                json!({"_tag": "Request", "id": id, "tag": tag, "payload": payload, "headers": []}),
            );
        }

        /// The next frame, or `None` after `quiet` without one.
        async fn next(&mut self, quiet: Duration) -> Option<(String, Value)> {
            let text = tokio::time::timeout(quiet, self.from_server.recv())
                .await
                .ok()??;
            let value = serde_json::from_str(&text).expect("frames are JSON");
            Some((text, value))
        }

        /// Frames until `done` matches one.
        async fn until(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
            let mut seen = Vec::new();
            while let Some((_, frame)) = self.next(Duration::from_secs(15)).await {
                let stop = done(&frame);
                seen.push(frame);
                if stop {
                    return seen;
                }
            }
            panic!("timed out; saw {seen:#?}");
        }
    }

    fn is_exit(frame: &Value, id: i64) -> bool {
        frame["_tag"] == "Exit" && frame["requestId"] == id
    }

    fn output(frame: &Value) -> String {
        frame["values"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| {
                v["data"]
                    .as_str()
                    .or(v["snapshot"]["history"].as_str())
                    .unwrap_or("")
                    .to_owned()
            })
            .collect()
    }

    /// The text a fresh terminal prints for `$AUDIT_PROFILE`, opened for `instance`.
    async fn profile_marker(
        client: &mut Client,
        id: i64,
        terminal: &str,
        instance: Option<&str>,
    ) -> String {
        let mut attach = json!({"threadId": "thread-p", "terminalId": terminal,
            "cwd": std::env::temp_dir(), "cols": 80, "rows": 24,
            "env": {"PS1": "$ ", "HISTFILE": "/dev/null"}});
        if let Some(instance) = instance {
            attach["providerInstanceId"] = json!(instance);
        }
        client.request(id, "terminal.attach", attach);
        client.until(|f| f["_tag"] == "Chunk").await;
        client.send(json!({"_tag": "Ack", "requestId": id}));
        client.request(
            id + 1,
            "terminal.write",
            json!({"threadId": "thread-p", "terminalId": terminal,
                "data": "echo \"marker:${AUDIT_PROFILE-unset}:end\"\n"}),
        );
        let mut seen = String::new();
        loop {
            let Some((_, frame)) = client.next(Duration::from_secs(15)).await else {
                panic!("no marker from {terminal}; the shell printed {seen:?}");
            };
            if frame["_tag"] == "Chunk" && frame["requestId"] == id {
                client.send(json!({"_tag": "Ack", "requestId": id}));
            }
            seen.push_str(&output(&frame));
            // The echoed command line holds `${`, the output does not.
            let printed = seen
                .match_indices("marker:")
                .map(|(start, _)| &seen[start + "marker:".len()..])
                .filter(|rest| !rest.starts_with("${"))
                .find_map(|rest| rest.find(":end").map(|end| rest[..end].to_owned()));
            if let Some(value) = printed {
                return value;
            }
        }
    }

    /// T3 `resolveLaunchInputEnvironment`: each instance's terminal gets that instance's
    /// environment, a terminal without one gets none, and an unknown instance is refused with
    /// its typed error before any terminal exists.
    #[tokio::test(flavor = "current_thread")]
    async fn a_provider_instance_terminal_gets_its_environment() {
        let dir =
            std::env::temp_dir().join(format!("conn-terminal-profile-{}", std::process::id()));
        let environment = crate::environment::Environment::load(
            &dir,
            Some("Test".into()),
            dir.clone(),
            Default::default(),
        )
        .unwrap();
        let marker =
            |value: &str| json!([{"name": "AUDIT_PROFILE", "value": value, "sensitive": false}]);
        environment
            .settings
            .update(
                json!({"providerInstances": {
                    "fixtureprofile": {"driver": "codex", "environment": marker("fixture-value")},
                    "otherprofile": {"driver": "claudeAgent", "environment": marker("other-value")},
                }}),
                None,
            )
            .unwrap();
        let deps = Deps {
            environment: Some(Arc::new(environment)),
            ..Deps::default()
        };
        let mut client = Client::connect_with(&deps);
        client.request(
            1,
            "terminal.open",
            json!({"threadId": "thread-p", "terminalId": "unknown", "cwd": std::env::temp_dir(),
                "providerInstanceId": "unused-fixture-provider"}),
        );
        let refused = client.until(|f| is_exit(f, 1)).await;
        let exit = &refused.last().unwrap()["exit"];
        assert_eq!(
            exit["cause"][0]["error"]["_tag"], "TerminalProviderInstanceNotFoundError",
            "{exit}"
        );
        assert_eq!(
            exit["cause"][0]["error"]["providerInstanceId"],
            "unused-fixture-provider"
        );
        // No terminal was made: attaching without a folder finds none.
        client.request(
            2,
            "terminal.attach",
            json!({"threadId": "thread-p", "terminalId": "unknown"}),
        );
        let lookup = client.until(|f| is_exit(f, 2)).await;
        assert_eq!(
            lookup.last().unwrap()["exit"]["cause"][0]["error"]["_tag"],
            "TerminalSessionLookupError"
        );

        assert_eq!(
            profile_marker(&mut client, 10, "first", Some("fixtureprofile")).await,
            "fixture-value"
        );
        assert_eq!(
            profile_marker(&mut client, 20, "second", Some("otherprofile")).await,
            "other-value"
        );
        assert_eq!(
            profile_marker(&mut client, 30, "plain", None).await,
            "unset"
        );
        // A reconnect to a running shell joins it, even when its instance is gone since.
        client.request(
            40,
            "terminal.attach",
            json!({"threadId": "thread-p", "terminalId": "first", "cwd": std::env::temp_dir(),
                "providerInstanceId": "removed-since"}),
        );
        let joined = client
            .until(|f| (f["_tag"] == "Chunk" || f["_tag"] == "Exit") && f["requestId"] == 40)
            .await;
        let joined = joined.last().unwrap();
        assert_eq!(joined["_tag"], "Chunk", "{joined}");
        assert_eq!(
            joined["values"][0]["snapshot"]["status"], "running",
            "{joined}"
        );
        client.send(json!({"_tag": "Ack", "requestId": 40}));
        client.request(
            4,
            "terminal.close",
            json!({"threadId": "thread-p", "deleteHistory": true}),
        );
        client.until(|f| is_exit(f, 4)).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Serves one thread's worktree and a workspace lock, for the worktree restore.
    struct OneThread {
        worktree: ThreadWorktree,
        locks: conn_vcs::locks::WorkspaceLocks,
    }

    impl Engine for OneThread {
        fn dispatch(
            &self,
            _: conn_contract::Command,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_contract::DispatchCommandResult,
                conn_engine::EngineError<conn_contract::DispatchCommandError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("not called".into())) })
        }
        fn subscribe_shell(
            &self,
            _: conn_contract::SubscribeShellInput,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_engine::Subscription<
                    conn_contract::ShellStreamItem,
                    conn_contract::GetShellSnapshotError,
                >,
                conn_engine::EngineError<conn_contract::GetShellSnapshotError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("not called".into())) })
        }
        fn subscribe_thread(
            &self,
            _: conn_contract::SubscribeThreadInput,
        ) -> conn_engine::BoxFuture<
            '_,
            Result<
                conn_engine::Subscription<
                    conn_contract::ThreadStreamItem,
                    conn_contract::GetThreadProjectionError,
                >,
                conn_engine::EngineError<conn_contract::GetThreadProjectionError>,
            >,
        > {
            Box::pin(async { Err(conn_engine::EngineError::Internal("not called".into())) })
        }
        fn thread_worktree(
            &self,
            _: &str,
        ) -> conn_engine::BoxFuture<'_, Result<Option<ThreadWorktree>, String>> {
            let worktree = self.worktree.clone();
            Box::pin(async move { Ok(Some(worktree)) })
        }
        fn workspace_lease<'a>(
            &'a self,
            root: &'a str,
        ) -> conn_engine::BoxFuture<'a, Option<conn_vcs::locks::WorkspaceLock<'a>>> {
            Box::pin(async move { Some(self.locks.workspace(root).await) })
        }
    }

    fn git(cwd: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@e",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// T3 `prepareTerminalLaunch` with `restoreMissingWorktree`: two terminals opened in a
    /// removed managed worktree whose branch survives both open, after one restore of that
    /// branch; a missing folder outside the thread's worktree keeps its error.
    #[tokio::test(flavor = "current_thread")]
    async fn terminals_restore_a_missing_managed_worktree_once() {
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("conn-terminal-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = dir.join("project");
        std::fs::create_dir_all(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        std::fs::write(project.join("README.md"), "base\n").unwrap();
        git(&project, &["add", "."]);
        git(&project, &["commit", "-qm", "base"]);
        let state = dir.join("state");
        let worktree = state.join("worktrees/project/feature-restore-0123456789abcdef");
        git(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/restore",
                &worktree.to_string_lossy(),
            ],
        );
        std::fs::write(worktree.join("thread.txt"), "thread work\n").unwrap();
        git(&worktree, &["add", "."]);
        git(&worktree, &["commit", "-qm", "thread tip"]);
        let tip = git(&worktree, &["rev-parse", "HEAD"]);
        std::fs::remove_dir_all(&worktree).unwrap();

        let environment = crate::environment::Environment::load(
            &state,
            Some("Test".into()),
            state.clone(),
            Default::default(),
        )
        .unwrap();
        let engine = Arc::new(OneThread {
            worktree: ThreadWorktree {
                worktree_path: worktree.to_string_lossy().into_owned(),
                branch: Some("feature/restore".into()),
                project_root: Some(project.to_string_lossy().into_owned()),
            },
            locks: conn_vcs::locks::WorkspaceLocks::default(),
        });
        let deps = Deps {
            environment: Some(Arc::new(environment)),
            engine: Some(engine.clone() as Arc<dyn Engine>),
            ..Deps::default()
        };
        let mut client = Client::connect_with(&deps);
        let open = |terminal: &str, cwd: &std::path::Path| {
            json!({"threadId": "thread-r", "terminalId": terminal, "cwd": cwd,
                "env": {"PS1": "$ ", "HISTFILE": "/dev/null"}})
        };
        // A turn or a capture holds the workspace: both opens wait and nothing restores yet.
        let held = engine.locks.workspace(&worktree.to_string_lossy()).await;
        client.request(1, "terminal.open", open("one", &worktree));
        client.request(2, "terminal.open", open("two", &worktree));
        assert!(client.next(Duration::from_millis(500)).await.is_none());
        assert!(!worktree.exists());
        drop(held);
        let mut exits = Vec::new();
        while exits.len() < 2 {
            let (_, frame) = client
                .next(Duration::from_secs(30))
                .await
                .expect("open answers");
            if frame["_tag"] == "Exit" {
                exits.push(frame);
            }
        }
        for exit in &exits {
            assert_eq!(exit["exit"]["_tag"], "Success", "{exit}");
        }
        assert_eq!(
            git(&worktree, &["branch", "--show-current"]),
            "feature/restore"
        );
        assert_eq!(git(&worktree, &["rev-parse", "HEAD"]), tip);
        assert!(worktree.join("thread.txt").exists());

        // The open records the inferred worktree, so a reopen that names it keeps the shell.
        let pid_of = |exit: &Value| exit["exit"]["value"]["pid"].clone();
        let first = exits.iter().find(|e| e["requestId"] == 1).unwrap();
        assert_eq!(first["exit"]["value"]["worktreePath"], json!(worktree));
        let mut named = open("one", &worktree);
        named["worktreePath"] = json!(worktree);
        client.request(5, "terminal.open", named);
        let reopened = client.until(|f| is_exit(f, 5)).await;
        let reopened = reopened.last().unwrap();
        assert!(pid_of(reopened).is_i64(), "{reopened}");
        assert_eq!(pid_of(reopened), pid_of(first), "{reopened}");

        let elsewhere = dir.join("not-the-worktree");
        client.request(3, "terminal.open", open("three", &elsewhere));
        let refused = client.until(|f| is_exit(f, 3)).await;
        assert_eq!(
            refused.last().unwrap()["exit"]["cause"][0]["error"]["_tag"],
            "TerminalCwdNotFoundError"
        );
        client.request(
            4,
            "terminal.close",
            json!({"threadId": "thread-r", "deleteHistory": true}),
        );
        client.until(|f| is_exit(f, 4)).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_busy_terminal_stays_within_the_byte_window() {
        let mut client = Client::connect();
        let cwd = std::env::temp_dir();
        let session = json!({"threadId": "thread-1", "terminalId": "term-1"});
        let mut attach = session.clone();
        attach["cwd"] = json!(cwd);
        attach["cols"] = json!(80);
        attach["rows"] = json!(24);
        client.request(1, "terminal.attach", attach);
        let first = client.until(|f| f["_tag"] == "Chunk").await;
        assert_eq!(first.last().unwrap()["values"][0]["type"], "snapshot");
        client.send(json!({"_tag": "Ack", "requestId": 1}));

        let mut write = session.clone();
        write["data"] = json!("yes 0123456789abcdef | head -c 3000000; echo END-\"\"MARK\n");
        client.request(2, "terminal.write", write);

        // Ack until the flood arrives, then stop: the session sends at most the window.
        // Sizes are what T3 charges a chunk (`chunkSize`), not the encoded text: JSON escapes
        // make the text longer than the output it carries.
        let size = |_: &str, frame: &Value| {
            frame["values"]
                .as_array()
                .map_or(0, |values| ack_window::chunk_size(values))
        };
        let mut pending: Vec<usize> = Vec::new();
        while let Some((text, frame)) = client.next(Duration::from_secs(15)).await {
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                if text.len() > 8 * 1024 {
                    pending.push(size(&text, &frame));
                    break;
                }
                client.send(json!({"_tag": "Ack", "requestId": 1}));
            }
        }
        assert_eq!(pending.len(), 1, "the flood never arrived");
        while let Some((text, frame)) = client.next(Duration::from_millis(1500)).await {
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                pending.push(size(&text, &frame));
            }
        }
        let bytes: usize = pending.iter().sum();
        let largest = pending.iter().copied().max().unwrap_or(0);
        assert!(
            pending.len() <= ack_window::MAX_PENDING_CHUNKS,
            "{pending:?}"
        );
        // One chunk holds at most the window of events, plus T3's charge for the chunk itself.
        assert!(
            largest <= ack_window::MAX_PENDING_BYTES + ack_window::VALUE_OVERHEAD_BYTES,
            "{pending:?}"
        );
        assert!(
            bytes < ack_window::MAX_PENDING_BYTES + largest,
            "{pending:?}"
        );

        // Acking lets the rest through; a viewer that fell behind resyncs from a snapshot.
        let mut seen = String::new();
        for _ in &pending {
            client.send(json!({"_tag": "Ack", "requestId": 1}));
        }
        while !seen.contains("END-MARK") {
            let Some((_, frame)) = client.next(Duration::from_secs(15)).await else {
                panic!(
                    "no END-MARK; tail {:?}",
                    &seen[seen.len().saturating_sub(200)..]
                );
            };
            if frame["_tag"] == "Chunk" && frame["requestId"] == 1 {
                seen.push_str(&output(&frame));
                client.send(json!({"_tag": "Ack", "requestId": 1}));
            }
        }

        let mut close = session.clone();
        close["deleteHistory"] = json!(true);
        client.request(3, "terminal.close", close);
        let frames = client.until(|f| output_type(f) == Some("closed")).await;
        assert!(
            frames
                .iter()
                .any(|f| is_exit(f, 3) && f["exit"]["_tag"] == "Success")
        );
    }

    fn output_type(frame: &Value) -> Option<&str> {
        frame["values"].as_array()?.last()?["type"].as_str()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reports_typed_errors_and_defects() {
        let mut client = Client::connect();
        client.request(
            1,
            "terminal.write",
            json!({"threadId": "t", "terminalId": "term-1", "data": "x"}),
        );
        let frames = client.until(|f| is_exit(f, 1)).await;
        let cause = &frames.last().unwrap()["exit"]["cause"][0];
        assert_eq!(cause["_tag"], "Fail");
        assert_eq!(cause["error"]["_tag"], "TerminalSessionLookupError");

        client.request(
            2,
            "terminal.resize",
            json!({"threadId": "t", "terminalId": "term-1", "cols": 0, "rows": 10}),
        );
        let frames = client.until(|f| is_exit(f, 2)).await;
        assert_eq!(frames.last().unwrap()["exit"]["cause"][0]["_tag"], "Die");

        client.request(3, "subscribeTerminalMetadata", json!({}));
        let frames = client.until(|f| f["_tag"] == "Chunk").await;
        assert_eq!(
            frames.last().unwrap()["values"][0],
            json!({"type": "snapshot", "terminals": []})
        );
    }
}
