//! A bounded chat preview. Only the live reducer owns stream cursors and interactive items.
use crate::chat::{ThreadOutline, TocEntry};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use conn_cache::{Message, MessageCache, fetch_history_prefix};
use conn_client::Connection;
use conn_state::environments::LinkedShellSnapshot;
use conn_state::{ShellState, ThreadShell, ThreadState, TimelineEntry};
use gpui_kit::Context;
use sha2::{Digest as _, Sha256};

use super::ConnApp;

static CACHE_WRITER: Mutex<()> = Mutex::new(());

const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

fn expires_at(thread: &ThreadShell) -> Option<i64> {
    if thread.deleted_at.is_some() {
        return Some(0);
    }
    thread
        .settled_at
        .as_deref()
        .or(thread.archived_at.as_deref())
        .and_then(conn_state::parse_iso8601_epoch_ms)
        .map(|t| t.saturating_add(RETENTION_MS))
}

fn expired(thread: &ThreadShell) -> bool {
    expires_at(thread).is_some_and(|at| i128::from(at) <= i128::from(super::now_ms()))
}

type ThreadKey = (String, String);

#[derive(Clone)]
struct Backfill {
    key: ThreadKey,
    cursor: String,
    anchor: Option<String>,
    limit: usize,
    serial: u64,
    stamp: String,
}

#[derive(Default)]
pub(super) struct Offline {
    dir: Option<PathBuf>,
    db: Option<MessageCache>,
    owners: HashMap<String, String>,
    shadow: HashMap<ThreadKey, ThreadState>,
    subscriptions: HashMap<(String, String), Connection>,
    dirty: HashSet<(String, String)>,
    expired: HashSet<(String, String)>,
    deadlines: HashMap<ThreadKey, i64>,
    deadlines_dirty: bool,
    outlines: HashMap<(String, String), Arc<ThreadOutline>>,
    outline_writes: HashMap<(String, String), String>,
    outline_requested: HashMap<(String, String), String>,
    outline_queue: std::collections::VecDeque<(String, String)>,
    loading_outline: Option<(String, String)>,
    outline_epoch: u64,
    backfills: std::collections::VecDeque<Backfill>,
    snapshots: HashMap<ThreadKey, Arc<u64>>,
    lifetime: Arc<()>,
    snapshot_cursors: HashMap<ThreadKey, String>,
    commits: HashMap<ThreadKey, Commit>,
    serial: u64,
    backfilling: bool,
    shell_dirty: bool,
    saving: bool,
}

fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

impl Offline {
    pub(super) fn new() -> Self {
        if cfg!(test) && std::env::var_os("CONN_GPUI_CONFIG_DIR").is_none() {
            return Self::default();
        }
        let dir = conn_desktop::orbit::OrbitSessionStore::default_path()
            .and_then(|p| p.parent().map(|d| d.join("offline-v1")));
        let db = dir.as_ref().and_then(|dir| {
            let opened = std::fs::create_dir_all(dir).and_then(|()| {
                crate::live::RT
                    .block_on(MessageCache::open(&dir.join("messages.sqlite3")))
                    .map_err(io::Error::other)
            });
            match opened {
                Ok(db) => Some(db),
                Err(err) => {
                    eprintln!("offline message database: {err}");
                    None
                }
            }
        });
        let deadlines = dir
            .as_ref()
            .and_then(|dir| std::fs::read(dir.join("settlement-deadlines")).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<(ThreadKey, i64)>>(&bytes).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        Self {
            dir,
            db,
            deadlines,
            ..Self::default()
        }
    }
    fn path(&self, env: &str, id: Option<&str>) -> Option<PathBuf> {
        Some(
            self.dir
                .as_ref()?
                .join(key(env))
                .join(id.map_or_else(|| "shell".to_owned(), key)),
        )
    }
    pub(super) fn disconnected(&mut self, env: &str) {
        self.snapshots.retain(|(owner, _), _| owner != env);
        self.snapshot_cursors.retain(|(owner, _), _| owner != env);
        self.commits.retain(|(owner, _), _| owner != env);
        self.backfills.retain(|job| job.key.0 != env);
        self.subscriptions.retain(|(owner, _), _| owner != env);
        if self
            .loading_outline
            .as_ref()
            .is_some_and(|key| key.0 == env)
        {
            self.loading_outline = None;
            self.outline_epoch = self.outline_epoch.wrapping_add(1);
        }
        self.outline_queue.retain(|key| key.0 != env);
        self.outline_requested.retain(|(owner, _), _| owner != env);
    }

    pub(super) fn watching(&self, env: Option<&str>, id: &str) -> bool {
        env.is_some_and(|env| {
            self.subscriptions
                .contains_key(&(env.to_owned(), id.to_owned()))
        })
    }
    pub(super) fn snapshot_cursor(&self, env: Option<&str>, id: &str) -> Option<String> {
        self.snapshot_cursors
            .get(&(env?.to_owned(), id.to_owned()))
            .cloned()
    }
    pub(super) fn snapshot_serial(&self, env: Option<&str>, id: &str) -> Option<u64> {
        self.snapshots
            .get(&(env?.to_owned(), id.to_owned()))
            .map(|serial| **serial)
    }
    pub(super) fn changed(&mut self, env: &str, id: &str) {
        if self.dir.is_some() {
            self.dirty.insert((env.to_owned(), id.to_owned()));
        }
    }
    pub(super) fn shell_changed(&mut self) {
        self.shell_dirty = true;
    }
}

enum Commit {
    Replace,
    Prefix {
        anchor: Option<String>,
        rows: Vec<Message>,
        stamp: String,
    },
}

enum Save {
    Shell(PathBuf, LinkedShellSnapshot),
    Deadlines(Vec<(ThreadKey, i64)>),
    Chat(ThreadKey, Vec<Message>, Option<Commit>, Option<Weak<u64>>),
    Remove(String, String),
    Outline(String, String, String),
}

fn write_json(path: &Path, value: &impl serde::Serialize) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    file.persist(path)?;
    Ok(())
}

fn merge_chat(db: &MessageCache, env: &str, id: &str, messages: &[Message]) -> io::Result<()> {
    let rows = messages
        .iter()
        .map(|message| (message.id(), message))
        .collect::<Vec<_>>();
    crate::live::RT
        .block_on(db.merge(env, id, &rows))
        .map_err(io::Error::other)
}

// The previous local spike wrote one JSON array per thread. Import it before the
// first read or live merge so a short server snapshot cannot replace the older history.
fn import_legacy(db: &MessageCache, env: &str, id: &str, path: &Path) -> io::Result<()> {
    let array = match std::fs::read_to_string(path) {
        Ok(array) => array,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    crate::live::RT
        .block_on(db.import_legacy(env, id, &array))
        .map_err(io::Error::other)?;
    remove_legacy(path)
}

fn remove_legacy(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn read_chat(db: &MessageCache, env: &str, id: &str) -> io::Result<ThreadState> {
    let rows = crate::live::RT
        .block_on(db.recent(env, id))
        .map_err(io::Error::other)?;
    let mut state = ThreadState::new(id);
    state.replace_cached_prefix(decode_messages(rows)?);
    state.has_more_history = state.entries.len() == 100;
    Ok(state)
}

fn decode_messages(rows: Vec<String>) -> serde_json::Result<Vec<TimelineEntry>> {
    rows.into_iter()
        .map(|body| serde_json::from_str::<Message>(&body).map(Message::entry))
        .collect()
}

fn replace_messages(db: &MessageCache, env: &str, id: &str, rows: &[Message]) -> io::Result<()> {
    crate::live::RT
        .block_on(db.replace(env, id, &[], rows))
        .map_err(io::Error::other)
}

fn save(dir: &Path, db: Option<&MessageCache>, write: Save) -> io::Result<()> {
    match write {
        Save::Shell(path, snapshot) => write_json(&path, &snapshot),
        Save::Deadlines(records) => write_json(&dir.join("settlement-deadlines"), &records),
        Save::Chat((env, id), messages, commit, snapshot) => {
            if snapshot.is_some_and(|snapshot| snapshot.strong_count() == 0) {
                return Ok(());
            }
            if let Some(db) = db {
                import_legacy(db, &env, &id, &dir.join(key(&env)).join(key(&id)))?;
                let receipt = dir.join(key(&env)).join(key(&id)).with_extension("prefix");
                match commit {
                    Some(Commit::Replace) => {
                        remove_legacy(&receipt)?;
                        replace_messages(db, &env, &id, &messages)?;
                    }
                    Some(Commit::Prefix {
                        anchor,
                        mut rows,
                        stamp,
                    }) => {
                        if let Some(anchor) = anchor {
                            if !crate::live::RT
                                .block_on(db.merge_prefix(&env, &id, &anchor, &rows, &messages))
                                .map_err(io::Error::other)?
                            {
                                return Ok(());
                            }
                        } else {
                            rows.extend(messages);
                            replace_messages(db, &env, &id, &rows)?;
                        }
                        if let Some(parent) = receipt.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::fs::write(receipt, stamp)?;
                    }
                    None => merge_chat(db, &env, &id, &messages)?,
                }
            }
            Ok(())
        }
        Save::Outline(env, id, markers) => {
            if let Some(db) = db {
                crate::live::RT
                    .block_on(db.save_outline(&env, &id, &markers))
                    .map_err(io::Error::other)?;
            }
            Ok(())
        }
        Save::Remove(env, id) => {
            if let Some(db) = db {
                let path = dir.join(key(&env)).join(key(&id));
                remove_legacy(&path.with_extension("prefix"))?;
                remove_legacy(&path)?;
                crate::live::RT
                    .block_on(db.remove(&env, &id))
                    .map_err(io::Error::other)?;
            }
            Ok(())
        }
    }
}

fn capture_chat(entries: &[TimelineEntry]) -> Vec<Message> {
    let mut messages: Vec<_> = entries
        .iter()
        .rev()
        .filter_map(Message::capture)
        .take(1000)
        .collect();
    messages.reverse();
    messages
}

impl ConnApp {
    pub(super) fn cache_env(&self, thread: &str) -> Option<&str> {
        self.linked_environment_of_thread(thread)
            .or(self.server_url.as_deref())
    }
    fn cache_shell(&self, env: &str, id: &str) -> Option<&ThreadShell> {
        if self.server_url.as_deref() == Some(env) {
            self.shell
                .find_thread(id)
                .filter(|_| self.cache_env(id) == Some(env))
        } else {
            self.linked.shell_for_cache(env)?.find_thread(id)
        }
    }

    fn cache_state(&self, key: &ThreadKey) -> Option<&ThreadState> {
        if self.offline.owners.get(&key.1) == Some(&key.0) {
            self.threads.get(&key.1)
        } else {
            self.offline.shadow.get(key)
        }
    }

    fn route_cached_thread(&mut self, env: &str, id: &str) {
        if let Some(old) = self.offline.owners.insert(id.to_owned(), env.to_owned())
            && old != env
        {
            if let Some(state) = self.threads.remove(id) {
                self.offline.shadow.insert((old, id.to_owned()), state);
            }
            if let Some(state) = self.offline.shadow.remove(&(env.to_owned(), id.to_owned())) {
                self.threads.insert(id.to_owned(), state);
            }
        }
    }

    pub(super) fn apply_cache_stream(
        &mut self,
        env: &str,
        id: &str,
        item: conn_state::ThreadStreamItem,
    ) {
        let rollback = matches!(&item,conn_state::ThreadStreamItem::Event(ev)
            if matches!(&ev.event,conn_contract::OrchestrationV2DomainEvent::RunUpdated(run)
                if run.payload.status == conn_contract::OrchestrationV2RunStatus::RolledBack));
        if rollback {
            let key = (env.to_owned(), id.to_owned());
            if self.offline.snapshots.remove(&key).is_some() {
                self.offline.commits.remove(&key);
                self.offline.backfills.retain(|job| job.key != key);
                if let Some(connection) = self.offline.subscriptions.get(&key) {
                    connection.refresh_thread(id);
                }
            }
        }
        let snapshot = matches!(item, conn_state::ThreadStreamItem::Snapshot(_));
        let changed = if self.cache_env(id) == Some(env) {
            self.route_cached_thread(env, id);
            self.threads
                .entry(id.to_owned())
                .or_insert_with(|| ThreadState::new(id))
                .apply(item)
        } else {
            self.offline
                .shadow
                .entry((env.to_owned(), id.to_owned()))
                .or_insert_with(|| ThreadState::new(id))
                .apply(item)
        };
        if changed || snapshot {
            self.offline.changed(env, id);
        }
        if snapshot {
            self.offline_snapshot(env.to_owned(), id);
        }
    }

    pub(super) fn restore_offline_shell(&mut self) {
        let Some(env) = self.server_url.as_deref() else {
            return;
        };
        if let Some(snapshot) = self
            .offline
            .path(env, None)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| LinkedShellSnapshot::from_json(&b))
            .filter(|s| s.environment_id == env)
        {
            self.shell = snapshot.into_shell();
        }
        self.remerge_linked_shells();
        let initial = self
            .shell
            .top_level_active_threads()
            .next()
            .or_else(|| self.shell.threads.first())
            .map(|t| (t.project_id.clone(), t.id.clone()));
        if let Some((project, id)) = initial {
            self.layout.selected_project_id = Some(project);
            self.open_thread(id);
        }
    }
    pub(super) fn cached_outline(&self, id: &str) -> Option<Arc<ThreadOutline>> {
        self.offline
            .outlines
            .get(&(self.cache_env(id)?.to_owned(), id.to_owned()))
            .cloned()
    }

    fn restore_outline(&mut self, id: &str) {
        let Some(env) = self.cache_env(id).map(str::to_owned) else {
            return;
        };
        let key = (env.clone(), id.to_owned());
        if self.offline.outlines.contains_key(&key)
            || self.shell.find_thread(id).is_none_or(expired)
        {
            return;
        }
        let Some(db) = self.offline.db.as_ref() else {
            return;
        };
        if let Ok(Some(raw)) = crate::live::RT.block_on(db.outline(&env, id))
            && let Ok(markers) = serde_json::from_str::<Vec<TocEntry>>(&raw)
        {
            self.offline
                .outlines
                .insert(key, Arc::new(ThreadOutline::new(markers)));
        }
    }

    pub(super) fn resolve_prompt(&mut self, prompt: &str, cx: &mut Context<'_, Self>) {
        let Some(id) = self.layout.selected_thread_id.clone() else {
            return;
        };
        let Some(env) = self.cache_env(&id).map(str::to_owned) else {
            return;
        };
        if self.shell.find_thread(&id).is_some_and(|t| !expired(t))
            && let Some(db) = &self.offline.db
            && let Ok(rows) = crate::live::RT.block_on(db.around(&env, &id, prompt))
            && !rows.is_empty()
            && let Ok(entries) = decode_messages(rows)
        {
            self.chat
                .update(cx, |chat, cx| chat.show_prompt_window(prompt, &entries, cx));
            return;
        }
        if !self.thread_connected(&id) {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(Some(crate::chat::OFFLINE_PROMPT_NOTICE.to_owned()), cx)
            });
            return;
        }
        self.fetch_prompt_window(env, id, prompt.to_owned(), cx);
    }

    pub(super) fn restore_offline_chat(&mut self, id: &str) {
        if let Some(env) = self.cache_env(id).map(str::to_owned) {
            self.route_cached_thread(&env, id);
        }
        self.restore_outline(id);
        if self.shell.find_thread(id).is_none_or(expired) {
            return;
        }
        if self.threads.contains_key(id) {
            self.fill_warm_preview(id);
            return;
        }
        let (Some(env), Some(db)) = (self.cache_env(id), &self.offline.db) else {
            return;
        };
        let Some(path) = self.offline.path(env, Some(id)) else {
            return;
        };
        match import_legacy(db, env, id, &path).and_then(|()| read_chat(db, env, id)) {
            Ok(state) if !state.entries.is_empty() => {
                self.threads.insert(id.to_owned(), state);
            }
            Ok(_) => (),
            Err(e) => eprintln!("offline message read: {e}"),
        }
    }
    fn offline_snapshot(&mut self, env: String, id: &str) {
        if self.offline.db.is_none() {
            return;
        }
        let key = (env, id.to_owned());
        self.offline.serial = self.offline.serial.wrapping_add(1);
        let serial = self.offline.serial;
        self.offline.snapshots.insert(key.clone(), Arc::new(serial));
        self.offline.commits.remove(&key);
        self.offline.backfills.retain(|job| job.key != key);
        let Some(state) = self.cache_state(&key) else {
            return;
        };
        let cursor = state.history_cursor.clone();
        let messages = capture_chat(&state.entries);
        self.offline.snapshot_cursors.remove(&key);
        if let Some(cursor) = &cursor {
            self.offline
                .snapshot_cursors
                .insert(key.clone(), cursor.clone());
        }
        let limit = conn_cache::MESSAGE_CAP - messages.len();
        conn_client::perf_log!(
            "offline.snapshot thread={id} messages={} bounded={}",
            messages.len(),
            cursor.is_some()
        );
        if limit > 0
            && let Some(cursor) = cursor
        {
            let anchor = messages.first().map(|m| m.id().to_owned());
            let stamp =
                serde_json::json!([cursor, anchor, messages.last().map(Message::id), limit])
                    .to_string();
            let warm = self
                .offline
                .path(&key.0, Some(id))
                .and_then(|p| std::fs::read_to_string(p.with_extension("prefix")).ok())
                .as_ref()
                == Some(&stamp);
            if !warm {
                self.offline.backfills.push_back(Backfill {
                    key,
                    cursor,
                    anchor,
                    limit,
                    serial,
                    stamp,
                });
            }
        } else {
            self.offline.commits.insert(key, Commit::Replace);
            return;
        }
        if self.layout.selected_thread_id.as_deref() == Some(id) {
            self.fill_warm_preview(id);
        }
    }

    fn start_backfill(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.backfilling {
            return;
        }
        while let Some(job) = self.offline.backfills.pop_front() {
            let (env, id) = &job.key;
            if self.cache_shell(env, id).is_none_or(ShellState::is_settled) {
                continue;
            }
            let Some(connection) = self.offline.subscriptions.get(&job.key).cloned() else {
                continue;
            };
            let generation = self.connection_gen;
            self.offline.backfilling = true;
            conn_client::perf_log!("offline.backfill thread={id} limit={}", job.limit);
            cx.spawn(async move |this, cx| {
                let request = job.clone();
                let result = crate::live::RT
                    .spawn(async move {
                        fetch_history_prefix(
                            &connection,
                            &request.key.1,
                            &request.cursor,
                            request.limit,
                        )
                        .await
                    })
                    .await
                    .map_err(io::Error::other)
                    .and_then(|r| r.map_err(io::Error::other));
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation {
                        return;
                    }
                    app.offline.backfilling = false;
                    let (env, id) = &job.key;
                    if app.offline.snapshots.get(&job.key).map(Arc::as_ref) == Some(&job.serial)
                        && app
                            .cache_shell(env, id)
                            .is_some_and(|t| !ShellState::is_settled(t) && !expired(t))
                    {
                        match result {
                            Ok(rows) => {
                                app.offline.commits.insert(
                                    job.key.clone(),
                                    Commit::Prefix {
                                        anchor: job.anchor,
                                        rows,
                                        stamp: job.stamp,
                                    },
                                );
                                app.offline.dirty.insert(job.key);
                                app.schedule_offline_save(cx);
                            }
                            Err(err) => {
                                eprintln!("offline history fetch: {err}");
                                cx.spawn(async move |this, cx| {
                                    cx.background_executor().timer(Duration::from_secs(5)).await;
                                    let _ = this.update(cx, |app, cx| {
                                        if app.connection_gen == generation
                                            && app.offline.snapshots.get(&job.key).map(Arc::as_ref)
                                                == Some(&job.serial)
                                        {
                                            app.offline.backfills.push_back(job);
                                            app.start_backfill(cx);
                                        }
                                    });
                                })
                                .detach();
                            }
                        }
                    }
                    app.start_backfill(cx);
                });
            })
            .detach();
            break;
        }
    }

    fn cached_before(&self, id: &str, anchor: &str) -> Option<Vec<TimelineEntry>> {
        let db = self.offline.db.as_ref()?;
        let rows = crate::live::RT
            .block_on(db.before(self.cache_env(id)?, id, anchor))
            .ok()?;
        decode_messages(rows).ok()
    }

    fn fill_warm_preview(&mut self, id: &str) {
        let Some(state) = self.threads.get(id) else {
            return;
        };
        let Some(env) = self.cache_env(id) else {
            return;
        };
        let key = (env.to_owned(), id.to_owned());
        if state.sequence.is_none() || !self.offline.snapshot_cursors.contains_key(&key) {
            return;
        }
        let prefix_count = state.history_prefix_len();
        if prefix_count > 100 {
            return;
        }
        let mut messages = state.entries[prefix_count..].iter().filter(|e| {
            matches!(
                e,
                TimelineEntry::User { .. } | TimelineEntry::Assistant { .. }
            )
        });
        let (missing, rows) = if let Some(first) = messages.next() {
            let missing = 99usize.saturating_sub(messages.count());
            if missing == 0 {
                return;
            }
            (missing, self.cached_before(id, first.id()))
        } else {
            if !state.has_more_history {
                return;
            }
            let Some(db) = self.offline.db.as_ref() else {
                return;
            };
            (
                100,
                crate::live::RT
                    .block_on(db.recent(env, id))
                    .ok()
                    .and_then(|rows| decode_messages(rows).ok()),
            )
        };
        if let Some(mut rows) = rows {
            let has_more = rows.len() >= missing;
            rows.drain(..rows.len().saturating_sub(missing));
            if let Some(state) = self.threads.get_mut(id)
                && (!rows.is_empty() || prefix_count > 0)
            {
                state.replace_cached_prefix(rows);
                state.history_cursor = None;
                state.has_more_history |= has_more;
            }
        }
    }

    pub(super) fn load_cached_page(&mut self, id: &str) -> bool {
        let Some(state) = self.threads.get(id) else {
            return false;
        };
        if !state.has_more_history || state.loading_earlier {
            return false;
        }
        let Some(first) = state.entries.iter().find(|e| {
            matches!(
                e,
                TimelineEntry::User { .. } | TimelineEntry::Assistant { .. }
            )
        }) else {
            return false;
        };
        let Some(rows) = self
            .cached_before(id, first.id())
            .filter(|rows| !rows.is_empty())
        else {
            return false;
        };
        let more = rows.len() == 100 || self.thread_connected(id);
        let Some(state) = self.threads.get_mut(id) else {
            return false;
        };
        state.prepend_cached_messages(rows);
        state.history_cursor = None;
        state.has_more_history = more;
        true
    }

    pub(super) fn expire_offline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let mut deadlines = std::mem::take(&mut self.offline.deadlines);
        let previous = deadlines.clone();
        deadlines.retain(|(env, id), _| self.cache_shell(env, id).is_none());
        let settled = |t: &ThreadShell| t.deleted_at.is_some() || ShellState::is_settled(t);
        for thread in self
            .shell
            .threads
            .iter()
            .chain(&self.shell.archived_threads)
            .filter(|t| settled(t))
        {
            if let (Some(env), Some(at)) = (self.cache_env(&thread.id), expires_at(thread)) {
                deadlines.insert((env.to_owned(), thread.id.clone()), at);
            }
        }
        for key in self.linked.cache_threads(settled) {
            if let Some(at) = self.cache_shell(&key.0, &key.1).and_then(expires_at) {
                deadlines.insert(key, at);
            }
        }
        let now = i128::from(super::now_ms());
        let mut expired_keys: HashSet<_> = deadlines
            .iter()
            .filter(|(_, at)| i128::from(**at) <= now)
            .map(|(key, _)| key.clone())
            .collect();
        expired_keys.extend(
            self.offline
                .expired
                .iter()
                .filter(|key| {
                    self.offline.dirty.contains(*key) && self.cache_shell(&key.0, &key.1).is_none()
                })
                .cloned(),
        );
        deadlines.retain(|_, at| i128::from(*at) > now);
        self.offline.deadlines_dirty |= previous != deadlines;
        self.offline.deadlines = deadlines;
        self.offline
            .dirty
            .extend(expired_keys.difference(&self.offline.expired).cloned());
        for key in expired_keys.difference(&self.offline.expired) {
            self.offline.shadow.remove(key);
            if self.offline.owners.get(&key.1) == Some(&key.0) {
                self.threads.remove(&key.1);
            }
        }
        for key in &expired_keys {
            if self.offline.loading_outline.as_ref() == Some(key) {
                self.offline.loading_outline = None;
                self.offline.outline_epoch = self.offline.outline_epoch.wrapping_add(1);
            }
            self.offline.snapshots.remove(key);
            self.offline.commits.remove(key);
            self.offline.outlines.remove(key);
            self.offline.outline_writes.remove(key);
            self.offline.outline_requested.remove(key);
        }
        let selection_expired = self
            .layout
            .selected_thread_id
            .as_deref()
            .and_then(|id| Some((self.cache_env(id)?.to_owned(), id.to_owned())))
            .is_some_and(|key| expired_keys.contains(&key) && !self.offline.expired.contains(&key));
        self.offline.expired = expired_keys;
        if selection_expired {
            self.sync_chat(cx);
        }
        self.schedule_offline_save(cx);
    }
    pub(super) fn reconcile_offline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let eligible = |t: &ThreadShell| t.deleted_at.is_none() && !ShellState::is_settled(t);
        let mut candidates: Vec<_> = self
            .shell
            .threads
            .iter()
            .filter(|t| eligible(t))
            .filter_map(|t| Some((self.cache_env(&t.id)?.to_owned(), t.id.clone())))
            .collect();
        candidates.extend(self.linked.cache_threads(eligible));
        let mut desired = HashSet::new();
        for pair in candidates {
            if !desired.insert(pair.clone()) {
                continue;
            }
            self.queue_outline(&pair);
            if !self.offline.subscriptions.contains_key(&pair)
                && let Some(connection) = self.cache_connection(&pair.0)
            {
                connection.refresh_thread(&pair.1);
                self.offline.subscriptions.insert(pair, connection);
            }
        }
        self.load_next_outline(cx);
        self.offline.commits.retain(|key, commit| {
            !matches!(commit, Commit::Prefix { .. }) || desired.contains(key)
        });
        self.offline
            .snapshots
            .retain(|key, _| desired.contains(key));
        self.offline
            .backfills
            .retain(|job| desired.contains(&job.key));
        let opened_env = self
            .subscribed_thread_id
            .as_deref()
            .and_then(|id| self.cache_env(id))
            .map(str::to_owned);
        self.offline.subscriptions.retain(|pair, conn| {
            if desired.contains(pair) {
                return true;
            }
            if self.subscribed_thread_id.as_ref() != Some(&pair.1)
                || opened_env.as_ref() != Some(&pair.0)
            {
                conn.unsubscribe_thread(&pair.1);
            }
            false
        });
    }
    pub(super) fn refresh_selected_outline(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(id) = self.layout.selected_thread_id.clone()
            && let Some(env) = self.cache_env(&id).map(str::to_owned)
        {
            self.queue_outline(&(env, id));
            self.load_next_outline(cx);
        }
    }

    fn cache_connection(&self, env: &str) -> Option<Connection> {
        if self.server_url.as_deref() == Some(env) {
            self.connection.clone()
        } else {
            self.linked_connection(env)
        }
    }

    fn queue_outline(&mut self, key: &ThreadKey) {
        if self.offline.dir.is_none() || !self.cache_environment_connected(&key.0) {
            return;
        }
        let Some(stamp) = self
            .cache_shell(&key.0, &key.1)
            .filter(|t| !expired(t))
            .map(|t| t.updated_at.clone())
        else {
            return;
        };
        if self.offline.outline_requested.get(key) != Some(&stamp) {
            self.offline.outline_requested.insert(key.clone(), stamp);
            if !self.offline.outline_queue.contains(key) {
                self.offline.outline_queue.push_back(key.clone());
            }
        }
    }

    fn load_next_outline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.loading_outline.is_some() {
            return;
        }
        while let Some(key) = self.offline.outline_queue.pop_front() {
            let Some(stamp) = self.offline.outline_requested.get(&key).cloned() else {
                continue;
            };
            let Some(connection) = self.cache_connection(&key.0) else {
                continue;
            };
            self.offline.loading_outline = Some(key.clone());
            let epoch = self.offline.outline_epoch;
            let generation = self.connection_gen;
            cx.spawn(async move |this, cx| {
                let result = connection.fetch_thread_outline(&key.1).await;
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen != generation || app.offline.outline_epoch != epoch {
                        return;
                    }
                    app.offline.loading_outline = None;
                    if app.offline.outline_requested.get(&key) == Some(&stamp)
                        && app.cache_shell(&key.0, &key.1).is_some_and(|t| !expired(t))
                    {
                        match result {
                            Ok(outline) => {
                                let markers: Vec<_> = outline
                                    .markers
                                    .into_iter()
                                    .enumerate()
                                    .map(|(index, m)| TocEntry {
                                        turn_number: index + 1,
                                        item_index: 0,
                                        entry_id: m.entry_id,
                                        preview: m.preview,
                                        assistant_preview: m.assistant_preview,
                                        is_agent_prompt: m.is_agent_prompt,
                                        has_checkpoint: m.has_checkpoint,
                                        has_error: m.has_error,
                                    })
                                    .collect();
                                if let Ok(raw) = serde_json::to_string(&markers) {
                                    app.offline.outline_writes.insert(key.clone(), raw);
                                }
                                app.offline
                                    .outlines
                                    .insert(key.clone(), Arc::new(ThreadOutline::new(markers)));
                                app.schedule_offline_save(cx);
                                if app.layout.selected_thread_id.as_ref() == Some(&key.1) {
                                    app.sync_chat(cx);
                                }
                            }
                            Err(err) => {
                                eprintln!("thread outline: {err}");
                                if app.offline.outline_requested.get(&key) == Some(&stamp) {
                                    app.offline.outline_requested.remove(&key);
                                }
                            }
                        }
                    }
                    app.load_next_outline(cx);
                });
            })
            .detach();
            break;
        }
    }

    fn fetch_prompt_window(
        &mut self,
        env: String,
        id: String,
        prompt: String,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(connection) = self.connection_for_thread(&id) else {
            return;
        };
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let result = connection.fetch_thread_window(&id, &prompt).await;
            let _ = this.update(cx, |app, cx| {
                if app.connection_gen != generation
                    || app.cache_env(&id) != Some(&env)
                    || app.layout.selected_thread_id.as_ref() != Some(&id)
                    || app.shell.find_thread(&id).is_none_or(expired)
                    || !app.chat.read(cx).awaiting_prompt(&prompt)
                {
                    return;
                }
                match result {
                    Ok(page) => {
                        let mut state = ThreadState::new(&id);
                        state.prepend_history_page(page);
                        app.chat.update(cx, |chat, cx| {
                            chat.show_prompt_window(&prompt, &state.entries, cx)
                        });
                    }
                    Err(err) => {
                        let message = if app.thread_connected(&id) {
                            format!("Could not load this message: {err}")
                        } else {
                            crate::chat::OFFLINE_PROMPT_NOTICE.to_owned()
                        };
                        app.chat
                            .update(cx, |chat, cx| chat.set_error(Some(message), cx));
                    }
                }
            });
        })
        .detach();
    }
    fn pending_saves(&mut self) -> Vec<Save> {
        let mut writes: Vec<_> = self
            .offline
            .outline_writes
            .drain()
            .map(|((env, id), raw)| Save::Outline(env, id, raw))
            .collect();
        if std::mem::take(&mut self.offline.shell_dirty)
            && self.shell.synchronized
            && let Some(env) = &self.server_url
            && let Some(path) = self.offline.path(env, None)
        {
            let mut primary = LinkedShellSnapshot::capture(env, env, &self.shell);
            let origins = self.linked.origins();
            primary
                .projects
                .retain(|p| !origins.is_linked_project(&p.id));
            primary.threads.retain(|t| !origins.is_linked_thread(&t.id));
            primary
                .archived_threads
                .retain(|t| !origins.is_linked_thread(&t.id));
            writes.push(Save::Shell(path, primary));
        }
        for (env, id) in std::mem::take(&mut self.offline.dirty) {
            let key = (env.clone(), id.clone());
            if self.offline.expired.contains(&key)
                || self.cache_shell(&env, &id).is_some_and(expired)
            {
                writes.push(Save::Remove(env, id));
            } else if let Some(state) = self.cache_state(&key)
                && state.sequence.is_some()
            {
                let key = (env, id);
                let start = state.history_prefix_len();
                writes.push(Save::Chat(
                    key.clone(),
                    capture_chat(&state.entries[start..]),
                    self.offline.commits.remove(&key),
                    self.offline.snapshots.get(&key).map(Arc::downgrade),
                ));
            }
        }
        if std::mem::take(&mut self.offline.deadlines_dirty) {
            writes.push(Save::Deadlines(
                self.offline
                    .deadlines
                    .iter()
                    .map(|(key, at)| (key.clone(), *at))
                    .collect(),
            ));
        }
        writes
    }
    pub(super) fn schedule_offline_save(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none()
            || self.offline.saving
            || (!self.offline.shell_dirty
                && !self.offline.deadlines_dirty
                && self.offline.dirty.is_empty()
                && self.offline.outline_writes.is_empty())
        {
            return;
        }
        self.offline.saving = true;
        let lifetime = Arc::downgrade(&self.offline.lifetime);
        let generation = self.connection_gen;
        let Some(dir) = self.offline.dir.clone() else {
            return;
        };
        let db = self.offline.db.clone();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(300))
                    .await;
                let Ok(writes) = this.update(cx, |app, _| {
                    if app.connection_gen != generation {
                        return Vec::new();
                    }
                    let writes = app.pending_saves();
                    if writes.is_empty() {
                        app.offline.saving = false;
                    }
                    writes
                }) else {
                    break;
                };
                if writes.is_empty() {
                    break;
                }
                let dir = dir.clone();
                let db = db.clone();
                let refresh = writes
                    .iter()
                    .filter_map(|value| match value {
                        Save::Chat(key, _, Some(Commit::Prefix { .. }), _) => Some(key.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let lifetime = lifetime.clone();
                cx.background_executor()
                    .spawn(async move {
                        // A previous connection generation may still be draining its last write.
                        let _guard = CACHE_WRITER
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if lifetime.strong_count() == 0 {
                            return;
                        }
                        for value in writes {
                            if let Err(e) = save(&dir, db.as_ref(), value) {
                                eprintln!("offline thread cache: {e}");
                            }
                        }
                    })
                    .await;
                let _ = this.update(cx, |app, cx| {
                    if app.connection_gen == generation {
                        for (env, id) in refresh {
                            if app.cache_env(&id) == Some(&env)
                                && app.layout.selected_thread_id.as_ref() == Some(&id)
                            {
                                app.fill_warm_preview(&id);
                                app.sync_chat(cx);
                            }
                        }
                        app.start_backfill(cx);
                    }
                });
            }
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_retains_latest_thousand_messages_and_opens_latest_hundred_in_order() {
        let dir = tempfile::tempdir().expect("test directory");
        let path = dir.path().join("thread");
        let mut state = ThreadState::new("t");
        for index in 0..1050 {
            state.entries.push(TimelineEntry::Assistant {
                id: index.to_string(),
                markdown: format!("reply {index}"),
                streaming: false,
                created_at: None,
                run_id: None,
                status: conn_state::ItemStatus::Completed,
            });
            state.entries.push(TimelineEntry::Notice {
                id: format!("notice-{index}"),
                text: "tool status".to_owned(),
                is_error: false,
            });
        }
        let messages = capture_chat(&state.entries);
        assert_eq!(messages.len(), 1000);
        assert_eq!(messages[0].id(), "50");
        let db = crate::live::RT
            .block_on(MessageCache::open(&path))
            .expect("open SQLite");
        let legacy = dir.path().join("legacy");
        std::fs::write(
            &legacy,
            serde_json::to_vec(&messages).expect("encode legacy messages"),
        )
        .expect("legacy file");
        import_legacy(&db, "env", "t", &legacy).expect("import old cache into SQLite");
        assert!(!legacy.exists());
        merge_chat(&db, "env", "t", &messages[998..]).expect("bounded update");
        let reopened = read_chat(&db, "env", "t").expect("offline chat");
        assert_eq!(reopened.entries.len(), 100);
        assert_eq!(reopened.entries[0].id(), "950");
        assert_eq!(reopened.entries[99].id(), "1049");
        assert_eq!(reopened.sequence, None);
        let generation = Arc::new(1);
        let stale = Save::Chat(
            ("env".to_owned(), "t".to_owned()),
            Vec::new(),
            Some(Commit::Replace),
            Some(Arc::downgrade(&generation)),
        );
        drop(generation);
        save(dir.path(), Some(&db), stale).expect("discard stale write");
        assert_eq!(
            read_chat(&db, "env", "t")
                .expect("preserved after reset")
                .entries
                .len(),
            100
        );
        crate::live::RT
            .block_on(db.remove("env", "t"))
            .expect("expire chat");
        assert!(
            read_chat(&db, "env", "t")
                .expect("read expired chat")
                .entries
                .is_empty()
        );
    }
}
