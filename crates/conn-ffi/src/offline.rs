//! Offline reading keeps message bodies separate from authoritative live state.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use conn_cache::{Message, MessageCache};
use conn_client::Connection;
use conn_contract::ThreadOutline;
use conn_state::{ThreadState, environments::LinkedShellSnapshot};
use tokio::sync::watch;

use crate::{
    FfiError, FfiShellSnapshot, FfiThreadSnapshot,
    types::{build_shell_snapshot, build_thread_snapshot},
};

#[derive(Debug, uniffi::Record)]
pub struct FfiPromptMarker {
    pub id: String,
    pub preview: String,
    pub assistant_preview: Option<String>,
    pub has_error: bool,
    pub has_checkpoint: bool,
    pub is_agent_prompt: bool,
}

#[derive(Debug, uniffi::Object)]
pub struct OfflineReader {
    pub(crate) db: MessageCache,
    pub(crate) env: String,
    dir: PathBuf,
    expires: RwLock<HashMap<String, u64>>,
    fetch_slots: tokio::sync::Semaphore,
    connection: Connection,
}

fn read_error(e: impl std::fmt::Display) -> FfiError {
    FfiError::Connection {
        message: e.to_string(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn deadlines<'a>(
    threads: impl Iterator<Item = &'a conn_state::ThreadShell>,
) -> HashMap<String, u64> {
    threads
        .filter_map(|thread| {
            let expiry = if thread.deleted_at.is_some() {
                0
            } else {
                let settled = thread
                    .settled_at
                    .as_deref()
                    .or(thread.archived_at.as_deref())?;
                let at = conn_state::parse_iso8601_epoch_ms(settled)?;
                u64::try_from(at.saturating_add(86_400_000)).unwrap_or_default()
            };
            Some((thread.id.clone(), expiry))
        })
        .collect()
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SavedShell {
    #[serde(flatten)]
    snapshot: LinkedShellSnapshot,
    #[serde(default)]
    expires: HashMap<String, u64>,
}

impl SavedShell {
    fn decode(bytes: &[u8], env: &str) -> Option<Self> {
        let mut saved: Self = serde_json::from_slice(bytes).ok()?;
        if saved.snapshot.version != LinkedShellSnapshot::VERSION
            || saved.snapshot.environment_id != env
        {
            return None;
        }
        saved.expires.extend(deadlines(
            saved
                .snapshot
                .threads
                .iter()
                .chain(&saved.snapshot.archived_threads),
        ));
        Some(saved)
    }
}

impl OfflineReader {
    pub(crate) async fn open(
        dir: PathBuf,
        env: String,
        connection: Connection,
    ) -> Result<Arc<Self>, FfiError> {
        std::fs::create_dir_all(&dir).map_err(read_error)?;
        let db = MessageCache::open(&dir.join("messages.sqlite3"))
            .await
            .map_err(read_error)?;
        let saved = tokio::fs::read(dir.join("shell.json"))
            .await
            .ok()
            .and_then(|bytes| SavedShell::decode(&bytes, &env));
        let expires = saved.map(|file| file.expires).unwrap_or_default();
        Ok(Arc::new(Self {
            expires: RwLock::new(expires),
            fetch_slots: tokio::sync::Semaphore::new(2),
            db,
            env,
            dir,
            connection,
        }))
    }

    fn may_read(&self, thread: &str) -> bool {
        self.expires
            .read()
            .is_ok_and(|map| map.get(thread).is_none_or(|at| *at > now_ms()))
    }

    fn capture_shell(&self, state: &conn_state::ShellState) -> SavedShell {
        SavedShell {
            snapshot: LinkedShellSnapshot::capture(&self.env, "", state),
            expires: self
                .expires
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone(),
        }
    }

    fn save_shell(&self, snapshot: SavedShell) -> std::io::Result<()> {
        let temp = self.dir.join("shell.tmp");
        std::fs::write(&temp, serde_json::to_vec(&snapshot)?)?;
        std::fs::rename(temp, self.dir.join("shell.json"))
    }

    pub(crate) async fn save_thread(
        &self,
        thread: &str,
        messages: &[Message],
    ) -> Result<(), FfiError> {
        let rows: Vec<_> = messages.iter().map(|m| (m.id(), m)).collect();
        self.db
            .merge(&self.env, thread, &rows)
            .await
            .map_err(read_error)
    }

    fn snapshot(&self, thread: &str, bodies: Vec<String>) -> Result<FfiThreadSnapshot, FfiError> {
        let mut state = ThreadState::new(thread);
        for body in bodies {
            state.entries.push(
                serde_json::from_str::<Message>(&body)
                    .map_err(read_error)?
                    .entry(),
            );
        }
        Ok(build_thread_snapshot(&state, None))
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl OfflineReader {
    pub async fn saved_shell(&self) -> Option<FfiShellSnapshot> {
        let bytes = tokio::fs::read(self.dir.join("shell.json")).await.ok()?;
        let saved = LinkedShellSnapshot::from_json(&bytes)?;
        if saved.environment_id != self.env {
            return None;
        }
        let mut snapshot = build_shell_snapshot(&saved.into_shell());
        snapshot.synchronized = false;
        Some(snapshot)
    }

    pub async fn recent(&self, thread: String) -> Result<FfiThreadSnapshot, FfiError> {
        if !self.may_read(&thread) {
            return self.snapshot(&thread, Vec::new());
        }
        self.snapshot(
            &thread,
            self.db
                .recent(&self.env, &thread)
                .await
                .map_err(read_error)?,
        )
    }

    pub async fn before(&self, thread: String, id: String) -> Result<FfiThreadSnapshot, FfiError> {
        if !self.may_read(&thread) {
            return self.snapshot(&thread, Vec::new());
        }
        self.snapshot(
            &thread,
            self.db
                .before(&self.env, &thread, &id)
                .await
                .map_err(read_error)?,
        )
    }

    pub async fn prompt_window(
        &self,
        thread: String,
        id: String,
        online: bool,
    ) -> Result<FfiThreadSnapshot, FfiError> {
        let rows = self
            .db
            .around(&self.env, &thread, &id)
            .await
            .map_err(read_error)?;
        if self.may_read(&thread) && !rows.is_empty() {
            return self.snapshot(&thread, rows);
        }
        if !online {
            return Err(read_error(
                "This prompt is outside the saved history. Reconnect to read it.",
            ));
        }
        let page = self.connection.fetch_thread_window(&thread, &id).await?;
        let mut state = ThreadState::new(thread);
        state.prepend_history_page(page);
        let mut snapshot = build_thread_snapshot(&state, None);
        snapshot.server_page = true;
        Ok(snapshot)
    }

    pub async fn server_before(
        &self,
        thread: String,
        anchor: String,
        continuation: Option<String>,
        snapshot_cursor: Option<String>,
    ) -> Result<FfiThreadSnapshot, FfiError> {
        let mut state = ThreadState::new(&thread);
        let page = if let Some(cursor) = continuation {
            self.connection
                .fetch_thread_history_page(&thread, &cursor)
                .await?
        } else {
            let cursor = match snapshot_cursor {
                Some(cursor) => Some(cursor),
                None => self
                    .db
                    .outline(&self.env, &thread)
                    .await
                    .map_err(read_error)?
                    .map(|json| serde_json::from_str::<SavedOutline>(&json))
                    .transpose()
                    .map_err(read_error)?
                    .and_then(|saved| saved.stamp.cursor),
            };
            let Some(cursor) = cursor else {
                return Ok(build_thread_snapshot(&state, None));
            };
            self.connection
                .fetch_history_before_message(&thread, &cursor, &anchor)
                .await?
        };
        state.prepend_history_page(page);
        Ok(build_thread_snapshot(&state, None))
    }

    pub async fn outline(
        &self,
        thread: String,
        online: bool,
    ) -> Result<Vec<FfiPromptMarker>, FfiError> {
        let cached = self
            .db
            .outline(&self.env, &thread)
            .await
            .map_err(read_error)?;
        let outline = if self.may_read(&thread)
            && let Some(json) = cached
        {
            serde_json::from_str::<SavedOutline>(&json)
                .map_err(read_error)?
                .outline
        } else if online {
            self.connection.fetch_thread_outline(&thread).await?
        } else {
            return Ok(Vec::new());
        };
        Ok(outline
            .markers
            .into_iter()
            .map(|m| FfiPromptMarker {
                id: m.entry_id,
                preview: m.preview,
                assistant_preview: m.assistant_preview,
                has_error: m.has_error,
                has_checkpoint: m.has_checkpoint,
                is_agent_prompt: m.is_agent_prompt,
            })
            .collect())
    }
}

#[derive(Clone)]
struct Update {
    generation: u64,
    sequence: Option<i64>,
    cursor: Option<String>,
    messages: Vec<Message>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SavedOutline {
    outline: ThreadOutline,
    #[serde(flatten)]
    stamp: HistoryStamp,
}

#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct HistoryStamp {
    sequence: Option<i64>,
    cursor: Option<String>,
    tail_ids: Vec<String>,
}

impl HistoryStamp {
    fn same_bounded_tail(&self, other: &Self) -> bool {
        self.cursor.as_ref().is_some_and(|s| !s.is_empty())
            && self.cursor == other.cursor
            && self.tail_ids == other.tail_ids
    }
}

impl OfflineReader {
    async fn reconcile(
        &self,
        thread: &str,
        update: &Update,
        previous: &mut Option<HistoryStamp>,
        applied_generation: &mut Option<u64>,
    ) -> Result<(), FfiError> {
        let key = HistoryStamp {
            sequence: update.sequence,
            cursor: update.cursor.clone(),
            tail_ids: update
                .messages
                .iter()
                .map(|message| message.id().to_owned())
                .collect(),
        };
        if previous.is_none()
            && let Some(raw) = self
                .db
                .outline(&self.env, thread)
                .await
                .map_err(read_error)?
            && let Ok(saved) = serde_json::from_str::<SavedOutline>(&raw)
        {
            *previous = Some(saved.stamp);
        }
        if previous
            .as_ref()
            .is_some_and(|old| old == &key || old.same_bounded_tail(&key))
        {
            self.save_thread(thread, &update.messages).await?;
            *previous = Some(key);
            *applied_generation = Some(update.generation);
            return Ok(());
        }
        let _slot = self.fetch_slots.acquire().await.map_err(read_error)?;
        if *applied_generation == Some(update.generation)
            && previous.as_ref().is_some_and(|old| {
                key.cursor == old.cursor
                    && (key.tail_ids.starts_with(&old.tail_ids)
                        || key.tail_ids.len() == conn_cache::MESSAGE_CAP)
            })
        {
            self.save_thread(thread, &update.messages).await?;
            let outline = self.connection.fetch_thread_outline(thread).await?;
            self.save_index(thread, outline, &key).await?;
            *previous = Some(key);
            return Ok(());
        }
        let prefix = if let Some(cursor) = &update.cursor {
            conn_cache::fetch_history_prefix(
                &self.connection,
                thread,
                cursor,
                conn_cache::MESSAGE_CAP.saturating_sub(update.messages.len()),
            )
            .await?
        } else {
            Vec::new()
        };
        let outline = self.connection.fetch_thread_outline(thread).await?;
        replace_history(&self.db, &self.env, thread, &prefix, &update.messages).await?;
        self.save_index(thread, outline, &key).await?;
        *previous = Some(key);
        *applied_generation = Some(update.generation);
        Ok(())
    }

    async fn save_index(
        &self,
        thread: &str,
        outline: ThreadOutline,
        key: &HistoryStamp,
    ) -> Result<(), FfiError> {
        let record = SavedOutline {
            stamp: key.clone(),
            outline,
        };
        self.db
            .save_outline(
                &self.env,
                thread,
                &serde_json::to_string(&record).map_err(read_error)?,
            )
            .await
            .map_err(read_error)?;
        Ok(())
    }
}

async fn replace_history(
    db: &MessageCache,
    env: &str,
    thread: &str,
    prefix: &[Message],
    messages: &[Message],
) -> Result<(), FfiError> {
    db.replace(env, thread, prefix, messages)
        .await
        .map_err(read_error)
}

struct Subscription {
    generation: u64,
    updates: watch::Sender<Option<Update>>,
    worker: tokio::task::JoinHandle<()>,
    sequence: Option<i64>,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

pub(crate) struct SyncState {
    reader: Arc<OfflineReader>,
    subscriptions: std::collections::HashMap<String, Subscription>,
    pruning: HashMap<String, (u64, tokio::task::JoinHandle<()>)>,
    shell_updates: watch::Sender<Option<SavedShell>>,
}

impl SyncState {
    pub(crate) fn new(reader: Arc<OfflineReader>) -> Self {
        let (shell_updates, mut rx) = watch::channel(None::<SavedShell>);
        let cache = reader.clone();
        tokio::spawn(async move {
            while rx.changed().await.is_ok() {
                if let Some(shell) = rx.borrow_and_update().clone()
                    && let Err(error) = cache.save_shell(shell)
                {
                    tracing::warn!(%error, "offline shell write failed");
                }
            }
        });
        let mut sync = Self {
            pruning: HashMap::new(),
            reader,
            subscriptions: Default::default(),
            shell_updates,
        };
        sync.prune();
        sync
    }

    fn prune(&mut self) {
        let Ok(expires) = self.reader.expires.read() else {
            return;
        };
        self.pruning.retain(|id, (at, task)| {
            if expires.get(id) == Some(at) {
                return true;
            }
            task.abort();
            false
        });
        for (id, at) in expires.iter() {
            if self.pruning.contains_key(id) {
                continue;
            }
            let reader = self.reader.clone();
            let thread = id.clone();
            let delay = Duration::from_millis(at.saturating_sub(now_ms()));
            let task = tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if !reader.may_read(&thread)
                    && let Err(error) = reader.db.remove(&reader.env, &thread).await
                {
                    tracing::warn!(%error, "expired thread removal failed");
                }
            });
            self.pruning.insert(id.clone(), (*at, task));
        }
    }

    pub(crate) fn may_read(&self, id: &str) -> bool {
        self.reader.may_read(id)
    }

    pub(crate) fn subscribed(&self, thread: &str) -> bool {
        self.subscriptions.contains_key(thread)
    }

    pub(crate) fn shell(
        &mut self,
        state: &conn_state::ShellState,
        open: &std::collections::HashSet<String>,
    ) {
        let desired: std::collections::HashSet<_> = state
            .threads
            .iter()
            .filter(|t| t.deleted_at.is_none() && !conn_state::ShellState::is_settled(t))
            .map(|t| t.id.clone())
            .collect();
        if let Ok(mut expires) = self.reader.expires.write() {
            for id in &desired {
                expires.remove(id);
            }
            expires.extend(deadlines(
                state.threads.iter().chain(&state.archived_threads),
            ));
            for id in self.subscriptions.keys() {
                if !desired.contains(id) {
                    expires.entry(id.clone()).or_insert(0);
                }
            }
        }
        self.subscriptions.retain(|id, _| {
            if desired.contains(id) {
                return true;
            }
            if !open.contains(id) {
                self.reader.connection.unsubscribe_thread(id);
            }
            false
        });
        self.prune();
        for thread in desired {
            if self.subscribed(&thread) {
                continue;
            }
            if !open.contains(&thread) {
                self.reader.connection.subscribe_thread(&thread);
            }
            let reader = self.reader.clone();
            let (updates, mut rx) = watch::channel(None::<Update>);
            let id = thread.clone();
            let worker = tokio::spawn(async move {
                let mut previous = None;
                let mut applied_generation = None;
                while rx.changed().await.is_ok() {
                    let mut next = rx.borrow_and_update().clone();
                    while let Some(update) = next.take() {
                        let reconcile =
                            reader.reconcile(&id, &update, &mut previous, &mut applied_generation);
                        tokio::pin!(reconcile);
                        loop {
                            tokio::select! {
                                biased;
                                changed = rx.changed() => {
                                    if changed.is_err() { return; }
                                    next = rx.borrow_and_update().clone();
                                    if next.as_ref().is_some_and(|u| u.generation != update.generation) { break; }
                                }
                                result = &mut reconcile => {
                                    if let Err(error) = result {
                                        tracing::warn!(%error, "offline synchronization failed");
                                        if next.is_none() {
                                            tokio::select! {
                                                changed = rx.changed() => { if changed.is_err() { return; } }
                                                () = tokio::time::sleep(Duration::from_secs(5)) => {}
                                            }
                                            next = rx.borrow_and_update().clone();
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            });
            self.subscriptions.insert(
                thread,
                Subscription {
                    generation: 0,
                    updates,
                    worker,
                    sequence: None,
                },
            );
        }
        self.shell_updates
            .send_replace(Some(self.reader.capture_shell(state)));
    }

    pub(crate) fn thread(&mut self, state: &ThreadState, snapshot: Option<i64>) {
        let Some(sub) = self.subscriptions.get_mut(&state.thread_id) else {
            return;
        };
        if snapshot.is_some() {
            sub.generation = sub.generation.wrapping_add(1);
            sub.sequence = snapshot;
        }
        if sub.sequence.is_none() {
            return;
        }
        let mut messages = state
            .entries
            .iter()
            .rev()
            .filter_map(Message::capture)
            .take(conn_cache::MESSAGE_CAP)
            .collect::<Vec<_>>();
        messages.reverse();
        sub.updates.send_replace(Some(Update {
            generation: sub.generation,
            sequence: sub.sequence,
            cursor: state.history_cursor.clone(),
            messages,
        }));
    }
}

impl Drop for SyncState {
    fn drop(&mut self) {
        for (_, task) in self.pruning.values() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str) -> Message {
        Message::Assistant {
            id: id.into(),
            markdown: id.into(),
            created_at: None,
            run_id: None,
        }
    }

    #[tokio::test]
    async fn an_omitted_settled_child_expires_after_offline_reopen()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let config = conn_client::ServerConfig {
            http_base_url: "http://127.0.0.1:1".parse()?,
            credential: conn_client::Credential::Bearer("fixture".into()),
        };
        let (connection, _events) = Connection::start(config, &tokio::runtime::Handle::current());
        let open =
            || OfflineReader::open(dir.path().to_owned(), "env".to_owned(), connection.clone());
        let reader = open().await?;
        reader.save_thread("child", &[message("old")]).await?;
        reader.db.save_outline("env", "child", "{}").await?;
        reader
            .expires
            .write()
            .map_err(|_| "lock poisoned")?
            .insert("child".into(), now_ms());
        let shell = conn_state::ShellState::default();
        reader.save_shell(reader.capture_shell(&shell))?;
        drop(reader);
        let reopened = open().await?;
        let mut sync = SyncState::new(reopened.clone());
        let (_, removal) = sync
            .pruning
            .remove("child")
            .ok_or("omitted child's deadline was lost")?;
        removal.await?;
        if !reopened.db.recent("env", "child").await?.is_empty()
            || reopened.db.outline("env", "child").await?.is_some()
        {
            return Err("expired child survived offline reopen".into());
        }
        Ok(())
    }

    #[test]
    fn bounded_coverage_survives_an_unrelated_server_event() {
        let old = HistoryStamp {
            sequence: Some(10),
            cursor: Some("thread-version/75".into()),
            tail_ids: vec!["first".into(), "middle".into(), "last".into()],
        };
        let mut next = old.clone();
        next.sequence = Some(100);
        assert!(next.same_bounded_tail(&old));
        next.tail_ids[1] = "replaced".into();
        assert!(!next.same_bounded_tail(&old));
        next = old.clone();
        next.cursor = Some("fork-parent-version/75".into());
        assert!(!next.same_bounded_tail(&old));
        next.cursor = None;
        assert!(!next.same_bounded_tail(&next));
    }

    #[tokio::test]
    async fn a_tool_only_snapshot_replaces_rolled_back_messages_with_its_history()
    -> Result<(), Box<dyn std::error::Error>> {
        let dir = tempfile::tempdir()?;
        let db = MessageCache::open(&dir.path().join("messages.sqlite")).await?;
        replace_history(
            &db,
            "env",
            "thread",
            &[message("first")],
            &[message("removed")],
        )
        .await?;
        replace_history(
            &db,
            "env",
            "thread",
            &[message("first"), message("second")],
            &[],
        )
        .await?;
        let rows = db.recent("env", "thread").await?;
        let ids = rows
            .iter()
            .map(|s| serde_json::from_str::<Message>(s).map(|m| m.id().to_owned()))
            .collect::<Result<Vec<_>, _>>()?;
        if ids != ["first", "second"] {
            return Err(format!("unexpected recovered order {ids:?}").into());
        }
        replace_history(&db, "env", "thread", &[], &[]).await?;
        if !db.recent("env", "thread").await?.is_empty() {
            return Err("rolled-back messages remain".into());
        }
        Ok(())
    }
}
