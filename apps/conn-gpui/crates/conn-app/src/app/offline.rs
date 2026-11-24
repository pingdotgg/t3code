//! A bounded chat preview. Only the live reducer owns stream cursors and interactive items.
use crate::chat::{ThreadOutline, TocEntry};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use conn_client::Connection;
use conn_contract::ChatAttachment;
use conn_desktop::message_cache::MessageCache;
use conn_state::environments::LinkedShellSnapshot;
use conn_state::{ItemStatus, ShellState, ThreadShell, ThreadState, TimelineEntry};
use gpui_kit::Context;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::ConnApp;

const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;

fn expired(thread: &ThreadShell) -> bool {
    thread.deleted_at.is_some()
        || thread
            .settled_at
            .as_deref()
            .or(thread.archived_at.as_deref())
            .and_then(conn_state::parse_iso8601_epoch_ms)
            .is_some_and(|at| {
                i128::from(super::now_ms()) - i128::from(at) >= i128::from(RETENTION_MS)
            })
}

#[derive(Serialize, Deserialize)]
enum Message {
    User {
        id: String,
        text: String,
        created_by_agent: bool,
        created_at: Option<String>,
        attachments: Vec<ChatAttachment>,
        is_steer: bool,
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
    fn capture(entry: &TimelineEntry) -> Option<Self> {
        match entry {
            TimelineEntry::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                run_id,
            } => Some(Self::User {
                id: id.clone(),
                text: text.clone(),
                created_by_agent: *created_by_agent,
                created_at: created_at.clone(),
                attachments: attachments.clone(),
                is_steer: *is_steer,
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

    fn entry(self) -> TimelineEntry {
        match self {
            Self::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
                run_id,
            } => TimelineEntry::User {
                id,
                text,
                created_by_agent,
                created_at,
                attachments,
                is_steer,
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

#[derive(Default)]
pub(super) struct Offline {
    dir: Option<PathBuf>,
    db: Option<MessageCache>,
    subscriptions: HashMap<(String, String), Connection>,
    dirty: HashSet<(String, String)>,
    expired: HashSet<(String, String)>,
    outlines: HashMap<(String, String), Arc<ThreadOutline>>,
    outline_writes: HashMap<(String, String), String>,
    outline_requested: HashMap<(String, String), String>,
    outline_queue: std::collections::VecDeque<(String, String)>,
    loading_outline: Option<(String, String)>,
    outline_epoch: u64,
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
        Self {
            dir,
            db,
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

    pub(super) fn watching(&self, id: &str) -> bool {
        self.subscriptions.keys().any(|(_, thread)| thread == id)
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

enum Save {
    Shell(PathBuf, LinkedShellSnapshot),
    Chat(String, String, Vec<Message>),
    Remove(String, String),
    Outline(String, String, String),
}

fn write_shell(path: &Path, shell: &LinkedShellSnapshot) -> io::Result<()> {
    let dir = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(dir)?;
    let mut file = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(&mut file, shell)?;
    file.flush()?;
    file.persist(path)?;
    Ok(())
}

fn merge_chat(db: &MessageCache, env: &str, id: &str, messages: &[Message]) -> io::Result<()> {
    let rows = messages
        .iter()
        .map(|message| {
            let (Message::User { id, .. } | Message::Assistant { id, .. }) = message;
            (id.as_str(), message)
        })
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
    state.entries = decode_messages(rows)?;
    Ok(state)
}

fn decode_messages(rows: Vec<String>) -> serde_json::Result<Vec<TimelineEntry>> {
    rows.into_iter()
        .map(|body| serde_json::from_str::<Message>(&body).map(Message::entry))
        .collect()
}

fn save(dir: &Path, db: Option<&MessageCache>, write: Save) -> io::Result<()> {
    match write {
        Save::Shell(path, snapshot) => write_shell(&path, &snapshot),
        Save::Chat(env, id, messages) => {
            if let Some(db) = db {
                import_legacy(db, &env, &id, &dir.join(key(&env)).join(key(&id)))?;
                merge_chat(db, &env, &id, &messages)?;
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
                remove_legacy(&dir.join(key(&env)).join(key(&id)))?;
                crate::live::RT
                    .block_on(db.remove(&env, &id))
                    .map_err(io::Error::other)?;
            }
            Ok(())
        }
    }
}

fn capture_chat(state: &ThreadState) -> Vec<Message> {
    let mut messages: Vec<_> = state
        .entries
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
        self.restore_outline(id);
        if self.threads.contains_key(id) || self.shell.find_thread(id).is_none_or(expired) {
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
    pub(super) fn expire_offline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let expired: HashSet<_> = self
            .shell
            .threads
            .iter()
            .chain(&self.shell.archived_threads)
            .filter(|t| expired(t))
            .filter_map(|t| Some((self.cache_env(&t.id)?.to_owned(), t.id.clone())))
            .collect();
        self.offline
            .dirty
            .extend(expired.difference(&self.offline.expired).cloned());
        for key in &expired {
            if self.offline.loading_outline.as_ref() == Some(key) {
                self.offline.loading_outline = None;
                self.offline.outline_epoch = self.offline.outline_epoch.wrapping_add(1);
            }
            self.offline.outlines.remove(key);
            self.offline.outline_writes.remove(key);
            self.offline.outline_requested.remove(key);
        }
        self.offline.expired = expired;
        self.schedule_offline_save(cx);
    }
    pub(super) fn reconcile_offline(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none() {
            return;
        }
        let candidates: Vec<_> = self
            .shell
            .threads
            .iter()
            .filter(|t| !ShellState::is_settled(t))
            .map(|t| t.id.clone())
            .collect();
        for id in candidates {
            self.queue_outline(&id);
        }
        self.load_next_outline(cx);
        let mut desired = HashSet::new();
        for thread in &self.shell.threads {
            if thread.deleted_at.is_some() || ShellState::is_settled(thread) {
                continue;
            }
            let Some(env) = self.cache_env(&thread.id) else {
                continue;
            };
            let pair = (env.to_owned(), thread.id.clone());
            if !self.offline.subscriptions.contains_key(&pair)
                && let Some(conn) = self.connection_for_thread(&thread.id)
            {
                conn.subscribe_thread(&thread.id);
                self.offline.subscriptions.insert(pair.clone(), conn);
            }
            desired.insert(pair);
        }
        self.offline.subscriptions.retain(|pair, conn| {
            if desired.contains(pair) {
                return true;
            }
            if self.subscribed_thread_id.as_ref() != Some(&pair.1) {
                conn.unsubscribe_thread(&pair.1);
            }
            false
        });
    }
    pub(super) fn refresh_selected_outline(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(id) = self.layout.selected_thread_id.clone() {
            self.queue_outline(&id);
            self.load_next_outline(cx);
        }
    }

    fn queue_outline(&mut self, id: &str) {
        if self.offline.dir.is_none() || !self.thread_connected(id) {
            return;
        }
        let Some(t) = self.shell.find_thread(id).filter(|t| !expired(t)) else {
            return;
        };
        let Some(env) = self.cache_env(id) else {
            return;
        };
        let key = (env.to_owned(), id.to_owned());
        if self.offline.outline_requested.get(&key) != Some(&t.updated_at) {
            self.offline
                .outline_requested
                .insert(key.clone(), t.updated_at.clone());
            if !self.offline.outline_queue.contains(&key) {
                self.offline.outline_queue.push_back(key);
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
            let Some(connection) = self.connection_for_thread(&key.1) else {
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
                    if app.offline.outline_requested.contains_key(&key)
                        && app.cache_env(&key.1) == Some(&key.0)
                        && app.shell.find_thread(&key.1).is_some_and(|t| !expired(t))
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
            if self.cache_env(&id) != Some(&env) {
                continue;
            }
            if self.shell.find_thread(&id).is_none_or(expired) {
                writes.push(Save::Remove(env, id));
            } else if let Some(state) = self.threads.get(&id)
                && state.sequence.is_some()
            {
                writes.push(Save::Chat(env, id, capture_chat(state)));
            }
        }
        writes
    }
    pub(super) fn schedule_offline_save(&mut self, cx: &mut Context<'_, Self>) {
        if self.offline.dir.is_none()
            || self.offline.saving
            || (!self.offline.shell_dirty
                && self.offline.dirty.is_empty()
                && self.offline.outline_writes.is_empty())
        {
            return;
        }
        self.offline.saving = true;
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
                cx.background_executor()
                    .spawn(async move {
                        for value in writes {
                            if let Err(e) = save(&dir, db.as_ref(), value) {
                                eprintln!("offline thread cache: {e}");
                            }
                        }
                    })
                    .await;
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
                status: ItemStatus::Completed,
            });
            state.entries.push(TimelineEntry::Notice {
                id: format!("notice-{index}"),
                text: "tool status".to_owned(),
                is_error: false,
            });
        }
        let messages = capture_chat(&state);
        assert_eq!(messages.len(), 1000);
        assert!(matches!(&messages[0],Message::Assistant{id,..} if id=="50"));
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
