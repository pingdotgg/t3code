//! Terminals for Conn clients: shells on PTYs, keyed by thread and client-chosen terminal id.
//!
//! Behaviour follows `apps/server/src/terminal/Manager.ts`, the reference for what clients
//! expect; the implementation is our own. One [`TerminalManager`] holds every session. A
//! session outlives its viewers: a client that disconnects leaves the shell running, and its
//! next `attach` gets a snapshot with the scrollback. A shell stops on `close`, when its thread
//! is deleted or archived (the engine calls [`TerminalManager::close`]), on settle for
//! `stopOnSettle` terminals ([`TerminalManager::close_on_settle`]), on
//! [`TerminalManager::shutdown`], and when the manager is dropped.
//!
//! Costs per terminal: one tokio task, the PTY's file descriptors, a scrollback of at most
//! [`TerminalConfig::history_bytes`], and per subscriber a queue of at most
//! [`TerminalConfig::max_queued_bytes`]. No threads.

mod feed;
mod history;
mod processes;
mod pty;
mod sanitize;
mod store;

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use conn_contract::{
    TerminalAttachInput, TerminalAttachStreamEvent, TerminalAttachStreamEventActivity,
    TerminalAttachStreamEventCleared, TerminalAttachStreamEventClosed,
    TerminalAttachStreamEventError, TerminalAttachStreamEventExited,
    TerminalAttachStreamEventOutput, TerminalAttachStreamEventSnapshot, TerminalClearInput,
    TerminalCloseInput, TerminalCwdNotDirectoryError, TerminalCwdNotFoundError,
    TerminalCwdStatError, TerminalMetadataStreamEvent, TerminalMetadataStreamEventRemove,
    TerminalMetadataStreamEventSnapshot, TerminalMetadataStreamEventUpsert,
    TerminalNotRunningError, TerminalOpenError, TerminalOpenInput, TerminalResizeError,
    TerminalResizeInput, TerminalSessionLookupError, TerminalSessionSnapshot,
    TerminalSessionStatus, TerminalSummary, TerminalWriteError, TerminalWriteInput,
    support::{JsNumber, Map},
};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex as AsyncMutex, oneshot},
    task::JoinHandle,
};

use crate::{
    feed::{EVENT_OVERHEAD, Feed, Take},
    history::{History, Utf8Stream},
    sanitize::HistoryFilter,
    store::Store,
};

pub use crate::pty::shell_candidates;

/// Columns and rows of a new terminal when the client sends none (`DEFAULT_OPEN_COLS/ROWS`).
pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 30;
/// Most bytes of consecutive output merged into one event, and most bytes one `next` returns.
/// Keeps every chunk the session sends near the 64 KiB ack window.
const MERGE_BYTES: usize = 16 * 1024;
const TAKE_BYTES: usize = 64 * 1024;
/// Closed terminal ids remembered, so a resumed attach does not reopen a closed shell.
const MAX_CLOSED_KEYS: usize = 1024;
/// Longest wire label (`TerminalSummary.label`).
const MAX_LABEL_CHARS: usize = 128;

#[derive(Clone, Debug)]
pub struct TerminalConfig {
    /// Where scrollback is kept across restarts; `None` keeps it in memory only.
    pub history_dir: Option<PathBuf>,
    /// Scrollback per terminal. `apps/server` keeps 8 MiB but replays at most 512 KiB to a new
    /// session, and the web client asks for 512 KiB; we keep only what is ever sent.
    pub history_bytes: usize,
    /// About this many lines of scrollback (`DEFAULT_HISTORY_LINE_LIMIT`).
    pub history_lines: usize,
    /// Between SIGHUP and SIGKILL when a terminal closes (`processKillGraceMs`).
    pub kill_grace: Duration,
    /// How often running terminals are checked for a foreground command.
    pub poll_interval: Duration,
    /// Exited terminals kept for their scrollback (`DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS`).
    pub max_inactive: usize,
    /// A subscriber further behind than this starts again from a snapshot. `apps/server`
    /// allows 8 MiB; a client this far behind gains nothing from the backlog.
    pub max_queued_bytes: usize,
    /// Shells to try, in order.
    pub shells: Vec<String>,
    /// `TERM_PROGRAM_VERSION` in the shell's environment.
    pub version: String,
    /// Scrollback flushed to disk this long after output (`DEFAULT_PERSIST_DEBOUNCE_MS`).
    pub persist_delay: Duration,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            history_dir: None,
            history_bytes: 512 * 1024,
            history_lines: 5000,
            kill_grace: Duration::from_secs(1),
            poll_interval: Duration::from_secs(1),
            max_inactive: 128,
            max_queued_bytes: 1024 * 1024,
            shells: shell_candidates(),
            version: env!("CARGO_PKG_VERSION").into(),
            persist_delay: Duration::from_millis(250),
        }
    }
}

/// Who a stream belongs to, for the shared grid: one per client connection.
pub type ViewerId = u64;

type Key = (String, String);

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for TerminalManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalManager").finish_non_exhaustive()
    }
}

struct Inner {
    config: TerminalConfig,
    store: Option<Store>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<Key, Session>,
    /// Attach and observe streams, by terminal. They survive a close and a reopen.
    watchers: HashMap<Key, Vec<Watcher>>,
    metadata: Vec<(u64, Arc<Feed<TerminalMetadataStreamEvent>>)>,
    closed: HashSet<Key>,
    closed_order: VecDeque<Key>,
    /// The attached viewer that answers terminal queries (DA, DSR, DECRQM), until it detaches.
    query_owner: HashMap<Key, ViewerId>,
    /// Each attached viewer's grid: its first sized attach, then its resizes. It goes when the
    /// viewer's last attach stream closes, as T3's `retainViewer` and `releaseViewer`.
    grids: HashMap<Key, HashMap<ViewerId, (u16, u16)>>,
    poller: bool,
    next_id: u64,
}

struct Watcher {
    id: u64,
    feed: Arc<Feed<TerminalAttachStreamEvent>>,
    max_history: Option<usize>,
    /// Set for attach streams: the client connection.
    viewer: Option<ViewerId>,
}

struct Session {
    thread_id: String,
    terminal_id: String,
    cwd: String,
    worktree_path: Option<String>,
    env: BTreeMap<String, String>,
    stop_on_settle: bool,
    status: TerminalSessionStatus,
    /// Why the shell failed to start, kept so later attachments can show it.
    startup_error: Option<String>,
    pid: Option<i32>,
    exit_code: Option<i64>,
    exit_signal: Option<i64>,
    /// The foreground process group and its command name, while one runs.
    job: Option<(i32, String)>,
    /// The running shell's executable (`getShell`).
    shell: Option<String>,
    history: History,
    filter: HistoryFilter,
    utf8: Utf8Stream,
    sequence: i64,
    /// Writes to the shell (`inputCount`): with `sequence`, the terminal's activity mark.
    input_count: u64,
    updated_at: String,
    touched: u64,
    cols: u16,
    rows: u16,
    proc: Option<Proc>,
    generation: u64,
    persist: Persist,
}

struct Proc {
    writer: Arc<AsyncMutex<pty_process::OwnedWritePty>>,
    control: Arc<OwnedFd>,
    pid: i32,
    kill: Option<oneshot::Sender<pty::KillPolicy>>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Persist {
    file_len: u64,
    unpersisted: usize,
    scheduled: bool,
}

/// What a new or restarted shell is started with.
struct Launch {
    cwd: String,
    worktree_path: Option<Option<String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    env: Option<BTreeMap<String, String>>,
    stop_on_settle: Option<bool>,
}

impl TerminalManager {
    /// Needs a tokio runtime with IO, time and process support.
    pub fn new(config: TerminalConfig) -> Self {
        let store = config.history_dir.clone().map(Store::new);
        Self {
            inner: Arc::new(Inner {
                config,
                store,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// `terminal.open`: starts the shell, or returns the running one. A changed cwd, env or
    /// worktree restarts it with empty scrollback; so does opening an exited one.
    pub fn open(
        &self,
        input: TerminalOpenInput,
    ) -> Result<TerminalSessionSnapshot, TerminalOpenError> {
        let mut state = self.inner.lock();
        let key = self.open_in(&mut state, input)?;
        state
            .sessions
            .get(&key)
            .map(|s| s.snapshot(None))
            .ok_or_else(|| lookup_error(&key))
    }

    /// Opens a setup terminal and subscribes before its first output can be published.
    pub fn open_observed(
        &self,
        input: TerminalOpenInput,
    ) -> Result<Subscription, TerminalOpenError> {
        let mut state = self.inner.lock();
        let key = self.open_in(&mut state, input)?;
        Ok(self.subscribe(&mut state, key, None, None))
    }

    fn open_in(
        &self,
        state: &mut State,
        input: TerminalOpenInput,
    ) -> Result<Key, TerminalOpenError> {
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let launch = Launch {
            cwd: input.cwd,
            worktree_path: input.worktree_path,
            cols: input.cols.map(clamp_cols),
            rows: input.rows.map(clamp_rows),
            env: input.env.map(into_env),
            stop_on_settle: input.stop_on_settle,
        };
        let grid = state.shared_grid(&key);
        self.inner.open_locked(state, &key, launch, grid)?;
        Ok(key)
    }

    /// `terminal.attach`: the terminal's stream, starting with a snapshot (or `closed`).
    /// Opens the shell when the terminal is unknown and `cwd` is given; with `resume`, a
    /// terminal closed earlier stays closed.
    pub fn attach(
        &self,
        input: TerminalAttachInput,
        viewer: ViewerId,
    ) -> Result<Subscription, TerminalOpenError> {
        let key = (input.thread_id.clone(), input.terminal_id.clone());
        let requested = input
            .cols
            .zip(input.rows)
            .map(|(c, r)| (clamp_cols(c), clamp_rows(r)));
        let resume = input.resume == Some(true);
        let max_history = input
            .max_history_bytes
            .map(|b| usize::try_from(b).unwrap_or(0));
        let launch = input.cwd.clone().map(|cwd| Launch {
            cwd,
            worktree_path: input.worktree_path.clone(),
            cols: input.cols.map(clamp_cols),
            rows: input.rows.map(clamp_rows),
            env: input.env.clone().map(into_env),
            stop_on_settle: input.stop_on_settle,
        });
        let mut state = self.inner.lock();
        // After a viewer's first size, its resizes own it: a client's attach retry resends the
        // first size, so a viewer still attached keeps the grid it last reported.
        let grid = state.viewer_grid(&key, viewer).or(requested);
        // The new viewer's grid counts before anything starts or resizes.
        let shared = min_grid(state.shared_grid(&key), grid);
        match (state.sessions.get(&key), launch) {
            (None, _) if resume && state.closed.contains(&key) => {}
            (None, None) => return Err(lookup_error(&key)),
            (None, Some(launch)) => self.inner.open_locked(&mut state, &key, launch, shared)?,
            (Some(s), Some(launch))
                if !resume && s.proc.is_none() && input.restart_if_not_running == Some(true) =>
            {
                self.inner.open_locked(&mut state, &key, launch, shared)?
            }
            (Some(_), _) => {
                if let Some((cols, rows)) = shared
                    && let Some(session) = state.sessions.get_mut(&key)
                    && session.proc.is_some()
                    && let Some(event) = session.resize(cols, rows)?
                {
                    state.publish(&key, event);
                }
            }
        }
        if let Some(grid) = requested {
            let grids = state.grids.entry(key.clone()).or_default();
            grids.entry(viewer).or_insert(grid);
        }
        Ok(self.subscribe(&mut state, key, max_history, Some(viewer)))
    }

    /// `terminal.observe`: the stream of an existing terminal, for read-only viewers. Never
    /// starts, resizes or counts as a viewer.
    pub fn observe(&self, input: TerminalClearInput) -> Result<Subscription, TerminalOpenError> {
        let key = (input.thread_id, input.terminal_id);
        let mut state = self.inner.lock();
        if !state.sessions.contains_key(&key) {
            return Err(lookup_error(&key));
        }
        Ok(self.subscribe(&mut state, key, None, None))
    }

    fn subscribe(
        &self,
        state: &mut State,
        key: Key,
        max_history: Option<usize>,
        viewer: Option<ViewerId>,
    ) -> Subscription {
        let id = state.id();
        let feed = Feed::new(self.inner.config.max_queued_bytes);
        let first = first_event(state, &key, max_history);
        let size = event_size(&first);
        feed.push(first, size);
        state
            .watchers
            .entry(key.clone())
            .or_default()
            .push(Watcher {
                id,
                feed: feed.clone(),
                max_history,
                viewer,
            });
        Subscription {
            inner: self.inner.clone(),
            key,
            id,
            feed,
            max_history,
            ready: VecDeque::new(),
        }
    }

    /// `terminal.write`. Writing to an exited shell does nothing, as in `apps/server`. A
    /// query reply (`reply`) reaches the shell only from the viewer that answers queries: the
    /// first attached viewer to reply, until it detaches. A reply from a connection that is no
    /// viewer is dropped; a write without a viewer claims nothing.
    pub async fn write(
        &self,
        input: TerminalWriteInput,
        viewer: Option<ViewerId>,
    ) -> Result<(), TerminalOpenError> {
        let key = (input.thread_id, input.terminal_id);
        let (writer, pid) = {
            let mut state = self.inner.lock();
            let Some(session) = state.sessions.get(&key) else {
                return Err(lookup_error(&key));
            };
            let found = match &session.proc {
                Some(proc) => (proc.writer.clone(), proc.pid),
                None if session.status == TerminalSessionStatus::Exited => return Ok(()),
                None => {
                    return Err(TerminalOpenError::TerminalNotRunningError(
                        TerminalNotRunningError {
                            tag: Default::default(),
                            thread_id: key.0,
                            terminal_id: key.1,
                        },
                    ));
                }
            };
            if input.reply == Some(true) && !state.accepts_query_reply(&key, viewer) {
                return Ok(());
            }
            if let Some(session) = state.sessions.get_mut(&key) {
                session.input_count += 1;
            }
            found
        };
        let bytes = pty_input(&input.data, input.binary == Some(true));
        let mut writer = writer.lock().await;
        let result = writer.write_all(&bytes).await;
        result.map_err(|error| {
            TerminalOpenError::TerminalWriteError(TerminalWriteError {
                tag: Default::default(),
                thread_id: key.0,
                terminal_id: key.1,
                terminal_pid: JsNumber(f64::from(pid)),
                cause: serde_json::json!({ "message": error.to_string() }),
            })
        })
    }

    /// `terminal.resize`. From an attached viewer it sets that viewer's grid; the PTY takes
    /// the smallest grid of all viewers. Anyone else resizes only while no viewer set a grid.
    pub fn resize(
        &self,
        input: TerminalResizeInput,
        viewer: Option<ViewerId>,
    ) -> Result<(), TerminalOpenError> {
        let key = (input.thread_id, input.terminal_id);
        let grid = (clamp_cols(input.cols), clamp_rows(input.rows));
        let mut state = self.inner.lock();
        let mine = viewer.filter(|&v| state.is_attached(&key, v));
        let target = if let Some(viewer) = mine {
            state
                .grids
                .entry(key.clone())
                .or_default()
                .insert(viewer, grid);
            state.shared_grid(&key)
        } else if state.shared_grid(&key).is_some() {
            None
        } else {
            Some(grid)
        };
        let Some((cols, rows)) = target else {
            return Ok(());
        };
        let Some(session) = state.sessions.get_mut(&key) else {
            return Ok(());
        };
        if session.proc.is_none() {
            return Ok(());
        }
        if let Some(event) = session.resize(cols, rows)? {
            state.publish(&key, event);
        }
        Ok(())
    }

    /// `terminal.clear`: empties the scrollback; the shell keeps running.
    pub fn clear(&self, input: TerminalClearInput) -> Result<(), TerminalOpenError> {
        let key = (input.thread_id, input.terminal_id);
        let mut state = self.inner.lock();
        let Some(session) = state.sessions.get_mut(&key) else {
            return Err(lookup_error(&key));
        };
        session.history.clear();
        session.filter.reset();
        session.advance();
        if let Some(store) = &self.inner.store {
            session.persist.file_len = store.write(&key.0, &key.1, "").unwrap_or(0);
        }
        session.persist.unpersisted = 0;
        let event = TerminalAttachStreamEvent::Cleared(TerminalAttachStreamEventCleared {
            thread_id: key.0.clone(),
            terminal_id: key.1.clone(),
            sequence: Some(session.sequence),
            r#type: Default::default(),
        });
        state.publish(&key, event);
        Ok(())
    }

    /// `terminal.close`: stops one terminal, or every terminal of the thread when
    /// `terminalId` is absent. `deleteHistory` also removes the scrollback on disk. The
    /// engine calls this with `deleteHistory` when a thread is deleted or archived.
    pub fn close(&self, input: TerminalCloseInput) {
        let delete = input.delete_history == Some(true);
        let mut state = self.inner.lock();
        match input.terminal_id {
            Some(terminal_id) => {
                self.inner
                    .close_locked(&mut state, &(input.thread_id, terminal_id), delete);
            }
            None => {
                let keys: Vec<Key> = state
                    .sessions
                    .keys()
                    .filter(|(thread, _)| *thread == input.thread_id)
                    .cloned()
                    .collect();
                for key in keys {
                    self.inner.close_locked(&mut state, &key, false);
                }
                if delete && let Some(store) = &self.inner.store {
                    store.delete_thread(&input.thread_id);
                }
            }
        }
    }

    /// Holds the manager's lock until the guard drops, so a test can stall a close.
    #[cfg(feature = "test-util")]
    #[doc(hidden)]
    pub fn hold_lock(&self) -> impl Drop + '_ {
        self.inner.lock()
    }

    /// `getShell`: the executable of a running terminal's shell.
    pub fn shell(&self, thread_id: &str, terminal_id: &str) -> Option<String> {
        let state = self.inner.lock();
        let session = state
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))?;
        session.proc.as_ref()?;
        session.shell.clone()
    }

    /// `closeIdle` (`Manager.ts:3880`): closes the thread's running terminals (or just
    /// `terminal_id`) whose shell runs nothing, keeping their scrollback. One process table
    /// read decides: a terminal is kept when its shell has a child (a foreground or background
    /// job), was replaced by `exec`, or had input or output while it was checked. When the
    /// table cannot be read, every terminal stays.
    pub async fn close_idle(&self, thread_id: &str, terminal_id: Option<&str>) {
        self.close_idle_with(thread_id, terminal_id, processes::process_table())
            .await;
    }

    async fn close_idle_with(
        &self,
        thread_id: &str,
        terminal_id: Option<&str>,
        table: impl std::future::Future<Output = std::io::Result<processes::ProcessTable>>,
    ) {
        let marks: Vec<(Key, (u64, i64, u64))> = {
            let state = self.inner.lock();
            state
                .sessions
                .iter()
                .filter(|((thread, terminal), s)| {
                    thread == thread_id
                        && terminal_id.is_none_or(|t| t == terminal)
                        && s.proc.is_some()
                })
                .map(|(key, s)| (key.clone(), s.activity_mark()))
                .collect()
        };
        if marks.is_empty() {
            return;
        }
        let table = match table.await {
            Ok(table) => table,
            Err(error) => {
                eprintln!("conn-terminal: failed to close idle terminals of {thread_id}: {error}");
                return;
            }
        };
        let mut state = self.inner.lock();
        for (key, mark) in marks {
            let idle = state.sessions.get(&key).is_some_and(|s| {
                s.activity_mark() == mark
                    && s.proc.as_ref().is_some_and(|p| {
                        !table.has_running_subprocess(
                            p.pid,
                            s.shell.as_deref(),
                            pty::foreground_group(&p.control),
                        )
                    })
            });
            if idle {
                self.inner.close_locked(&mut state, &key, false);
            }
        }
    }

    /// Closes the thread's terminals that were opened with `stopOnSettle`, keeping their
    /// scrollback. For the engine, when a thread settles; T3's `closeOnSettle` then calls
    /// [`Self::close_idle`] for the thread.
    pub fn close_on_settle(&self, thread_id: &str) {
        let mut state = self.inner.lock();
        let keys: Vec<Key> = state
            .sessions
            .iter()
            .filter(|((thread, _), s)| thread == thread_id && s.stop_on_settle)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.inner.close_locked(&mut state, &key, false);
        }
    }

    /// `subscribeTerminalMetadata`: a snapshot of every terminal, then upserts and removals.
    pub fn subscribe_metadata(&self) -> MetadataSubscription {
        let mut state = self.inner.lock();
        let id = state.id();
        let feed = Feed::new(self.inner.config.max_queued_bytes);
        let snapshot = state.metadata_snapshot();
        feed.push(snapshot, 0);
        state.metadata.push((id, feed.clone()));
        MetadataSubscription {
            inner: self.inner.clone(),
            id,
            feed,
            ready: VecDeque::new(),
        }
    }

    /// Every terminal, newest first. For agents and tools.
    pub fn list(&self) -> Vec<TerminalSummary> {
        self.inner.lock().summaries()
    }

    /// A terminal's state and the last `max_bytes` of its scrollback (query sequences
    /// removed), or `None` when there is no such terminal. For agents and tools: the same
    /// data a viewer's first snapshot carries, without subscribing.
    pub fn read(
        &self,
        thread_id: &str,
        terminal_id: &str,
        max_bytes: Option<usize>,
    ) -> Option<TerminalSessionSnapshot> {
        let state = self.inner.lock();
        state
            .sessions
            .get(&(thread_id.to_owned(), terminal_id.to_owned()))
            .map(|s| s.snapshot(max_bytes))
    }

    /// Stops every shell (SIGHUP, then SIGKILL after the grace time) and waits for them, and
    /// flushes scrollback to disk. Terminals stay listed as exited.
    pub async fn shutdown(&self) {
        let tasks: Vec<JoinHandle<()>> = {
            let mut state = self.inner.lock();
            let grace = self.inner.config.kill_grace;
            let store = self.inner.store.as_ref();
            state
                .sessions
                .values_mut()
                .filter_map(|s| {
                    if let Some(store) = store {
                        s.flush(store, self.inner.config.history_bytes);
                    }
                    s.stop(grace)
                })
                .collect()
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        crate::lock(&self.state)
    }

    fn open_locked(
        self: &Arc<Self>,
        state: &mut State,
        key: &Key,
        launch: Launch,
        grid: Option<(u16, u16)>,
    ) -> Result<(), TerminalOpenError> {
        check_cwd(&launch.cwd)?;
        // A reused terminal keeps its grid where the launch leaves a dimension out.
        let (cols, rows) = grid.unwrap_or_else(|| {
            let (cols, rows) = state
                .sessions
                .get(key)
                .map_or((DEFAULT_COLS, DEFAULT_ROWS), |s| (s.cols, s.rows));
            (launch.cols.unwrap_or(cols), launch.rows.unwrap_or(rows))
        });
        let env = launch.env.unwrap_or_default();
        let grace = self.config.kill_grace;
        if let Some(session) = state.sessions.get_mut(key) {
            if let Some(stop) = launch.stop_on_settle {
                session.stop_on_settle = stop;
            }
            let worktree = launch
                .worktree_path
                .clone()
                .unwrap_or_else(|| session.worktree_path.clone());
            let changed = session.cwd != launch.cwd
                || session.env != env
                || session.worktree_path != worktree;
            if !changed && session.proc.is_some() {
                if let Some(event) = session.resize(cols, rows)? {
                    state.publish(key, event);
                }
                return Ok(());
            }
            // A new launch context or a dead shell: start over with empty scrollback.
            session.stop(grace);
            session.cwd = launch.cwd;
            session.worktree_path = worktree;
            session.env = env;
            session.history.clear();
            session.filter.reset();
            if let Some(store) = &self.store {
                session.persist.file_len = store.write(&key.0, &key.1, "").unwrap_or(0);
            }
            session.persist.unpersisted = 0;
            session.cols = cols;
            session.rows = rows;
        } else {
            let mut history = History::new(self.config.history_bytes, self.config.history_lines);
            let mut persist = Persist::default();
            if let Some(store) = &self.store {
                let inherited = store.read(&key.0, &key.1, self.config.history_bytes);
                if !inherited.is_empty() {
                    history.push(&inherited);
                    history.push(&sanitize::inherited_suffix(history.tail(None)));
                    // Rewrite the file on the first flush: it holds the old shell's tail.
                    persist.file_len = u64::MAX / 2;
                }
            }
            state.forget_closed(key);
            let touched = tick();
            state.sessions.insert(
                key.clone(),
                Session {
                    thread_id: key.0.clone(),
                    terminal_id: key.1.clone(),
                    cwd: launch.cwd,
                    worktree_path: launch.worktree_path.flatten(),
                    env,
                    stop_on_settle: launch.stop_on_settle.unwrap_or(false),
                    status: TerminalSessionStatus::Starting,
                    startup_error: None,
                    pid: None,
                    exit_code: None,
                    exit_signal: None,
                    job: None,
                    shell: None,
                    history,
                    filter: HistoryFilter::default(),
                    utf8: Utf8Stream::default(),
                    sequence: 0,
                    input_count: 0,
                    updated_at: conn_support::time::now_iso(),
                    touched,
                    cols,
                    rows,
                    proc: None,
                    generation: 0,
                    persist,
                },
            );
            self.evict(state);
        }
        self.start(state, key);
        Ok(())
    }

    /// Starts the shell of an existing session and announces it with a snapshot.
    fn start(self: &Arc<Self>, state: &mut State, key: &Key) {
        let Some(session) = state.sessions.get_mut(key) else {
            return;
        };
        let env = pty::shell_env(&session.env, &self.config.version);
        session.generation += 1;
        session.exit_code = None;
        session.exit_signal = None;
        session.job = None;
        session.utf8 = Utf8Stream::default();
        match pty::spawn(
            &self.config.shells,
            &session.cwd,
            &env,
            session.cols,
            session.rows,
        ) {
            Ok(spawned) => {
                let (kill_tx, kill_rx) = oneshot::channel();
                let weak = Arc::downgrade(self);
                let generation = session.generation;
                let task_key = key.clone();
                let pid = spawned.pid;
                let control = Arc::new(spawned.control);
                let task = tokio::spawn(pty::run(
                    spawned.reader,
                    spawned.child,
                    control.clone(),
                    pid,
                    kill_rx,
                    self.config.kill_grace,
                    move |report| {
                        if let Some(inner) = weak.upgrade() {
                            inner.on_report(&task_key, generation, report);
                        }
                    },
                ));
                session.shell = Some(spawned.shell);
                session.proc = Some(Proc {
                    writer: Arc::new(AsyncMutex::new(spawned.writer)),
                    control,
                    pid,
                    kill: Some(kill_tx),
                    task,
                });
                session.status = TerminalSessionStatus::Running;
                session.startup_error = None;
                session.pid = Some(pid);
                session.advance();
                let snapshot = session.snapshot(None);
                state.publish_started(key, snapshot);
                self.ensure_poller(state);
            }
            Err(error) => {
                session.status = TerminalSessionStatus::Error;
                session.startup_error = Some(error.to_string()).filter(|m| !m.is_empty());
                session.pid = None;
                session.advance();
                let event = TerminalAttachStreamEvent::Error(TerminalAttachStreamEventError {
                    thread_id: key.0.clone(),
                    terminal_id: key.1.clone(),
                    sequence: Some(session.sequence),
                    r#type: Default::default(),
                    message: error.to_string(),
                });
                state.publish(key, event);
            }
        }
    }

    fn on_report(self: &Arc<Self>, key: &Key, generation: u64, report: pty::Report) {
        let mut state = self.lock();
        let Some(session) = state.sessions.get_mut(key) else {
            return;
        };
        if session.generation != generation || session.proc.is_none() {
            return;
        }
        match report {
            pty::Report::Output(bytes) => {
                let data = session.utf8.decode(&bytes);
                if data.is_empty() {
                    return;
                }
                self.record(session, &data);
                session.advance();
                let event = TerminalAttachStreamEvent::Output(TerminalAttachStreamEventOutput {
                    thread_id: key.0.clone(),
                    terminal_id: key.1.clone(),
                    sequence: Some(session.sequence),
                    r#type: Default::default(),
                    data,
                });
                let schedule = self.store.is_some() && !session.persist.scheduled;
                session.persist.scheduled |= schedule;
                state.publish(key, event);
                if schedule {
                    let weak = Arc::downgrade(self);
                    let key = key.clone();
                    let delay = self.config.persist_delay;
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        if let Some(inner) = weak.upgrade() {
                            inner.flush(&key);
                        }
                    });
                }
            }
            pty::Report::Exited(exit) => {
                let rest = session.utf8.finish();
                if !rest.is_empty() {
                    self.record(session, &rest);
                }
                session.proc = None;
                session.pid = None;
                session.job = None;
                session.status = TerminalSessionStatus::Exited;
                session.exit_code = exit.code;
                session.exit_signal = exit.signal;
                session.advance();
                if let Some(store) = &self.store {
                    session.flush(store, self.config.history_bytes);
                }
                let event = TerminalAttachStreamEvent::Exited(TerminalAttachStreamEventExited {
                    thread_id: key.0.clone(),
                    terminal_id: key.1.clone(),
                    sequence: Some(session.sequence),
                    r#type: Default::default(),
                    exit_code: exit.code,
                    exit_signal: exit.signal,
                });
                state.publish(key, event);
                self.evict(&mut state);
            }
        }
    }

    fn record(&self, session: &mut Session, data: &str) {
        let kept = session.filter.filter(data);
        session.history.push(&kept);
        session.persist.unpersisted += kept.len();
    }

    fn flush(&self, key: &Key) {
        let mut state = self.lock();
        if let (Some(session), Some(store)) = (state.sessions.get_mut(key), &self.store) {
            session.persist.scheduled = false;
            session.flush(store, self.config.history_bytes);
        }
    }

    fn close_locked(&self, state: &mut State, key: &Key, delete_history: bool) {
        if let Some(mut session) = state.sessions.remove(key) {
            if let Some(store) = &self.store {
                session.flush(store, self.config.history_bytes);
            }
            session.stop(self.config.kill_grace);
            let event = TerminalAttachStreamEvent::Closed(TerminalAttachStreamEventClosed {
                thread_id: key.0.clone(),
                terminal_id: key.1.clone(),
                sequence: Some(session.sequence + 1),
                r#type: Default::default(),
            });
            state.publish(key, event);
            state.publish_metadata(TerminalMetadataStreamEvent::Remove(
                TerminalMetadataStreamEventRemove {
                    r#type: Default::default(),
                    thread_id: key.0.clone(),
                    terminal_id: key.1.clone(),
                },
            ));
        }
        state.remember_closed(key.clone());
        if delete_history && let Some(store) = &self.store {
            store.delete(&key.0, &key.1);
        }
    }

    /// Drops the oldest exited terminals beyond `max_inactive`, silently, as `apps/server`.
    fn evict(&self, state: &mut State) {
        let mut inactive: Vec<(u64, Key)> = state
            .sessions
            .iter()
            .filter(|(_, s)| s.proc.is_none() && s.status != TerminalSessionStatus::Starting)
            .map(|(k, s)| (s.touched, k.clone()))
            .collect();
        if inactive.len() <= self.config.max_inactive {
            return;
        }
        inactive.sort();
        let excess = inactive.len() - self.config.max_inactive;
        for (_, key) in inactive.into_iter().take(excess) {
            state.sessions.remove(&key);
            state.remember_closed(key);
        }
    }

    fn ensure_poller(self: &Arc<Self>, state: &mut State) {
        if state.poller {
            return;
        }
        state.poller = true;
        let weak = Arc::downgrade(self);
        let interval = self.config.poll_interval;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(inner) = weak.upgrade() else { return };
                if !inner.poll().await {
                    return;
                }
            }
        });
    }

    /// Checks each running terminal's foreground job and its command name, and publishes
    /// `activity` when either changes, as T3 does. The name is read again on every poll while
    /// a job runs: a poll between the shell's `fork` and `exec` sees the shell's own name.
    /// Returns `false`, and stops polling, when no terminal runs.
    async fn poll(&self) -> bool {
        let checked: Vec<(Key, u64, Option<i32>)> = {
            let mut state = self.lock();
            let running = state.sessions.values().any(|s| s.proc.is_some());
            if !running {
                state.poller = false;
                return false;
            }
            state
                .sessions
                .iter()
                .filter_map(|(key, s)| {
                    let proc = s.proc.as_ref()?;
                    let job = pty::foreground_job(&proc.control, proc.pid);
                    (job.is_some() || s.job.is_some()).then(|| (key.clone(), s.generation, job))
                })
                .collect()
        };
        for (key, generation, job) in checked {
            let label = match job {
                Some(group) => Some(process_name(group).await.unwrap_or_default()),
                None => None,
            };
            let job = job.zip(label);
            let mut state = self.lock();
            let Some(session) = state.sessions.get_mut(&key) else {
                continue;
            };
            if session.generation != generation || session.proc.is_none() || session.job == job {
                continue;
            }
            session.job = job;
            session.advance();
            let event = TerminalAttachStreamEvent::Activity(TerminalAttachStreamEventActivity {
                thread_id: key.0.clone(),
                terminal_id: key.1.clone(),
                sequence: Some(session.sequence),
                r#type: Default::default(),
                has_running_subprocess: session.job.is_some(),
                label: session.label(),
                cols: None,
                rows: None,
            });
            state.publish(&key, event);
        }
        true
    }
}

impl State {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// Whether a query reply from `viewer` goes on to the shell. The first attached viewer to
    /// reply keeps answering until it detaches, as `acceptsQueryReply` in `apps/server`.
    fn accepts_query_reply(&mut self, key: &Key, viewer: Option<ViewerId>) -> bool {
        if let Some(id) = viewer
            && !self.is_attached(key, id)
        {
            return false;
        }
        match (self.query_owner.get(key), viewer) {
            (Some(owner), Some(id)) => *owner == id,
            (Some(_), None) => false,
            (None, Some(id)) => {
                self.query_owner.insert(key.clone(), id);
                true
            }
            (None, None) => true,
        }
    }

    fn is_attached(&self, key: &Key, viewer: ViewerId) -> bool {
        self.watchers
            .get(key)
            .is_some_and(|ws| ws.iter().any(|w| w.viewer == Some(viewer)))
    }

    fn viewer_grid(&self, key: &Key, viewer: ViewerId) -> Option<(u16, u16)> {
        self.grids.get(key)?.get(&viewer).copied()
    }

    fn shared_grid(&self, key: &Key) -> Option<(u16, u16)> {
        self.grids
            .get(key)?
            .values()
            .copied()
            .reduce(|a, b| (a.0.min(b.0), a.1.min(b.1)))
    }

    fn remember_closed(&mut self, key: Key) {
        if self.closed.insert(key.clone()) {
            self.closed_order.push_back(key);
            if self.closed_order.len() > MAX_CLOSED_KEYS
                && let Some(old) = self.closed_order.pop_front()
            {
                self.closed.remove(&old);
            }
        }
    }

    fn forget_closed(&mut self, key: &Key) {
        if self.closed.remove(key) {
            self.closed_order.retain(|k| k != key);
        }
    }

    /// Sends an event to the terminal's streams, and the matching metadata change.
    fn publish(&mut self, key: &Key, event: TerminalAttachStreamEvent) {
        let metadata = matches!(
            event,
            TerminalAttachStreamEvent::Exited(_)
                | TerminalAttachStreamEvent::Error(_)
                | TerminalAttachStreamEvent::Activity(_)
        );
        let size = event_size(&event);
        if let Some(watchers) = self.watchers.get(key) {
            for watcher in watchers {
                watcher.feed.push(event.clone(), size);
            }
        }
        if metadata {
            self.upsert_metadata(key);
        }
    }

    /// A (re)started shell: each stream gets a snapshot cut to its history limit.
    fn publish_started(&mut self, key: &Key, snapshot: TerminalSessionSnapshot) {
        if let Some(watchers) = self.watchers.get(key) {
            for watcher in watchers {
                let event = snapshot_event(snapshot.clone(), watcher.max_history);
                let size = event_size(&event);
                watcher.feed.push(event, size);
            }
        }
        self.upsert_metadata(key);
    }

    fn upsert_metadata(&mut self, key: &Key) {
        if let Some(session) = self.sessions.get(key) {
            let event = TerminalMetadataStreamEvent::Upsert(TerminalMetadataStreamEventUpsert {
                r#type: Default::default(),
                terminal: session.summary(),
            });
            self.publish_metadata(event);
        }
    }

    fn publish_metadata(&mut self, event: TerminalMetadataStreamEvent) {
        for (_, feed) in &self.metadata {
            feed.push(event.clone(), EVENT_OVERHEAD);
        }
    }

    fn summaries(&self) -> Vec<TerminalSummary> {
        let mut terminals: Vec<TerminalSummary> =
            self.sessions.values().map(Session::summary).collect();
        terminals.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.thread_id.cmp(&b.thread_id))
                .then_with(|| a.terminal_id.cmp(&b.terminal_id))
        });
        terminals
    }

    fn metadata_snapshot(&self) -> TerminalMetadataStreamEvent {
        TerminalMetadataStreamEvent::Snapshot(TerminalMetadataStreamEventSnapshot {
            r#type: Default::default(),
            terminals: self.summaries(),
        })
    }
}

impl Session {
    /// `terminalActivityMark`: changes with each output, resize, write and restart.
    fn activity_mark(&self) -> (u64, i64, u64) {
        (self.generation, self.sequence, self.input_count)
    }

    fn advance(&mut self) {
        self.sequence += 1;
        self.touched = tick();
        self.updated_at = conn_support::time::now_iso();
    }

    fn label(&self) -> String {
        let label = match &self.job {
            Some((_, name)) if !name.trim().is_empty() => name.trim().to_owned(),
            _ => terminal_label(&self.terminal_id),
        };
        label.chars().take(MAX_LABEL_CHARS).collect()
    }

    fn snapshot(&self, max_history: Option<usize>) -> TerminalSessionSnapshot {
        TerminalSessionSnapshot {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            error: self.startup_error.clone(),
            pid: self.pid.map(i64::from),
            history: self.history.tail(max_history).to_owned(),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            label: self.label(),
            updated_at: self.updated_at.clone(),
            sequence: Some(self.sequence),
            cols: Some(i64::from(self.cols)),
            rows: Some(i64::from(self.rows)),
        }
    }

    fn summary(&self) -> TerminalSummary {
        TerminalSummary {
            thread_id: self.thread_id.clone(),
            terminal_id: self.terminal_id.clone(),
            cwd: self.cwd.clone(),
            worktree_path: self.worktree_path.clone(),
            status: self.status,
            pid: self.pid.map(i64::from),
            exit_code: self.exit_code,
            exit_signal: self.exit_signal,
            has_running_subprocess: self.job.is_some(),
            label: self.label(),
            updated_at: self.updated_at.clone(),
        }
    }

    /// Resizes the PTY. Returns the `activity` event that carries the new grid, if it changed.
    fn resize(
        &mut self,
        cols: u16,
        rows: u16,
    ) -> Result<Option<TerminalAttachStreamEvent>, TerminalOpenError> {
        if (cols, rows) == (self.cols, self.rows) {
            return Ok(None);
        }
        if let Some(proc) = &self.proc {
            pty::resize(&proc.control, cols, rows).map_err(|error| {
                TerminalOpenError::TerminalResizeError(TerminalResizeError {
                    tag: Default::default(),
                    thread_id: self.thread_id.clone(),
                    terminal_id: self.terminal_id.clone(),
                    terminal_pid: JsNumber(f64::from(proc.pid)),
                    cols: i64::from(cols),
                    rows: i64::from(rows),
                    cause: serde_json::json!({ "message": error.to_string() }),
                })
            })?;
        }
        self.cols = cols;
        self.rows = rows;
        self.sequence += 1;
        self.updated_at = conn_support::time::now_iso();
        Ok(Some(TerminalAttachStreamEvent::Activity(
            TerminalAttachStreamEventActivity {
                thread_id: self.thread_id.clone(),
                terminal_id: self.terminal_id.clone(),
                sequence: Some(self.sequence),
                r#type: Default::default(),
                has_running_subprocess: self.job.is_some(),
                label: self.label(),
                cols: Some(i64::from(cols)),
                rows: Some(i64::from(rows)),
            },
        )))
    }

    /// Stops the shell, if one runs, without an `exited` event (as `stopProcess`). Returns
    /// the PTY task, which ends once the shell is gone.
    fn stop(&mut self, grace: Duration) -> Option<JoinHandle<()>> {
        let mut proc = self.proc.take()?;
        self.status = TerminalSessionStatus::Exited;
        self.pid = None;
        self.job = None;
        if let Some(kill) = proc.kill.take() {
            let _ = kill.send(pty::KillPolicy { grace });
        }
        Some(proc.task)
    }

    fn flush(&mut self, store: &Store, cap: usize) {
        let pending = std::mem::take(&mut self.persist.unpersisted);
        if pending == 0 {
            return;
        }
        let full = self.history.tail(None);
        // The last `pending` bytes are whole pushes, so they start at a char boundary.
        let tail = full
            .len()
            .checked_sub(pending)
            .and_then(|start| full.get(start..))
            .unwrap_or(full);
        let limit = 2 * cap as u64;
        let len = if pending <= full.len() {
            store.append(
                &self.thread_id,
                &self.terminal_id,
                self.persist.file_len,
                tail,
                full,
                limit,
            )
        } else {
            store.write(&self.thread_id, &self.terminal_id, full)
        };
        if let Ok(len) = len {
            self.persist.file_len = len;
        }
    }
}

/// Orders sessions by last change, for eviction.
fn tick() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static CLOCK: AtomicU64 = AtomicU64::new(0);
    CLOCK.fetch_add(1, Ordering::Relaxed) + 1
}

/// A stream of one terminal's events. Dropping it unsubscribes, and an attach stream's
/// viewer stops counting toward the shared grid.
pub struct Subscription {
    inner: Arc<Inner>,
    key: Key,
    id: u64,
    feed: Arc<Feed<TerminalAttachStreamEvent>>,
    max_history: Option<usize>,
    ready: VecDeque<TerminalAttachStreamEvent>,
}

impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("key", &self.key)
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Subscription {
    /// The next event. Never ends by itself: a closed terminal sends `closed`, and a terminal
    /// opened again under the same id sends a new snapshot.
    pub async fn next(&mut self) -> TerminalAttachStreamEvent {
        loop {
            if let Some(event) = self.ready.pop_front() {
                return event;
            }
            match self.feed.take(TAKE_BYTES, merge_output).await {
                Take::Items(items) => self.ready.extend(items),
                Take::Resync => {
                    let mut state = self.inner.lock();
                    let event = first_event(&mut state, &self.key, self.max_history);
                    let size = event_size(&event);
                    self.feed.reset(event, size);
                }
            }
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        let Some(watchers) = state.watchers.get_mut(&self.key) else {
            return;
        };
        let viewer = watchers
            .iter()
            .find(|w| w.id == self.id)
            .and_then(|w| w.viewer);
        watchers.retain(|w| w.id != self.id);
        let viewer_left = viewer.is_some_and(|v| !watchers.iter().any(|w| w.viewer == Some(v)));
        if watchers.is_empty() {
            state.watchers.remove(&self.key);
        }
        let Some(viewer) = viewer.filter(|_| viewer_left) else {
            return;
        };
        if state.query_owner.get(&self.key) == Some(&viewer) {
            state.query_owner.remove(&self.key);
        }
        let had_grid = state
            .grids
            .get_mut(&self.key)
            .and_then(|grids| grids.remove(&viewer))
            .is_some();
        if state.grids.get(&self.key).is_some_and(HashMap::is_empty) {
            state.grids.remove(&self.key);
        }
        // The grid may grow back now that this viewer left.
        if had_grid && let Some((cols, rows)) = state.shared_grid(&self.key) {
            let key = self.key.clone();
            if let Some(session) = state.sessions.get_mut(&key)
                && session.proc.is_some()
                && let Ok(Some(event)) = session.resize(cols, rows)
            {
                state.publish(&key, event);
            }
        }
    }
}

/// The metadata stream. Dropping it unsubscribes.
pub struct MetadataSubscription {
    inner: Arc<Inner>,
    id: u64,
    feed: Arc<Feed<TerminalMetadataStreamEvent>>,
    ready: VecDeque<TerminalMetadataStreamEvent>,
}

impl std::fmt::Debug for MetadataSubscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MetadataSubscription")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl MetadataSubscription {
    pub async fn next(&mut self) -> TerminalMetadataStreamEvent {
        loop {
            if let Some(event) = self.ready.pop_front() {
                return event;
            }
            match self.feed.take(TAKE_BYTES, |_, b| Some(b)).await {
                Take::Items(items) => self.ready.extend(items),
                Take::Resync => {
                    let snapshot = self.inner.lock().metadata_snapshot();
                    self.feed.reset(snapshot, 0);
                }
            }
        }
    }
}

impl Drop for MetadataSubscription {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.metadata.retain(|(id, _)| *id != self.id);
        }
    }
}

fn first_event(
    state: &mut State,
    key: &Key,
    max_history: Option<usize>,
) -> TerminalAttachStreamEvent {
    match state.sessions.get(key) {
        Some(session) => snapshot_event(session.snapshot(max_history), None),
        None => TerminalAttachStreamEvent::Closed(TerminalAttachStreamEventClosed {
            thread_id: key.0.clone(),
            terminal_id: key.1.clone(),
            sequence: None,
            r#type: Default::default(),
        }),
    }
}

fn snapshot_event(
    mut snapshot: TerminalSessionSnapshot,
    max_history: Option<usize>,
) -> TerminalAttachStreamEvent {
    if let Some(max) = max_history {
        let start = history::tail_start(&snapshot.history, max);
        snapshot.history.drain(..start);
    }
    TerminalAttachStreamEvent::Snapshot(TerminalAttachStreamEventSnapshot {
        r#type: Default::default(),
        snapshot,
    })
}

/// Folds consecutive output into one event of at most [`MERGE_BYTES`].
fn merge_output(
    last: &mut TerminalAttachStreamEvent,
    next: TerminalAttachStreamEvent,
) -> Option<TerminalAttachStreamEvent> {
    match (last, next) {
        (TerminalAttachStreamEvent::Output(a), TerminalAttachStreamEvent::Output(b))
            if a.data.len() + b.data.len() <= MERGE_BYTES =>
        {
            a.data.push_str(&b.data);
            a.sequence = b.sequence;
            None
        }
        (_, next) => Some(next),
    }
}

/// What the ack window charges for an event (`queuedSize` in `OutputProtocol.ts`).
fn event_size(event: &TerminalAttachStreamEvent) -> usize {
    use TerminalAttachStreamEvent as E;
    let ids = |t: &str, i: &str| t.len() + i.len();
    EVENT_OVERHEAD
        + match event {
            E::Output(e) => ids(&e.thread_id, &e.terminal_id) + e.data.len(),
            E::Error(e) => ids(&e.thread_id, &e.terminal_id) + e.message.len(),
            E::Activity(e) => ids(&e.thread_id, &e.terminal_id) + e.label.len(),
            E::Snapshot(e) => {
                let s = &e.snapshot;
                s.thread_id.len()
                    + s.terminal_id.len()
                    + s.history.len()
                    + s.cwd.len()
                    + s.worktree_path.as_ref().map_or(0, String::len)
                    + s.label.len()
            }
            E::Restarted(e) => e.snapshot.history.len(),
            E::Exited(e) => ids(&e.thread_id, &e.terminal_id),
            E::Closed(e) => ids(&e.thread_id, &e.terminal_id),
            E::Cleared(e) => ids(&e.thread_id, &e.terminal_id),
        }
}

fn min_grid(a: Option<(u16, u16)>, b: Option<(u16, u16)>) -> Option<(u16, u16)> {
    match (a, b) {
        (Some(a), Some(b)) => Some((a.0.min(b.0), a.1.min(b.1))),
        (a, b) => a.or(b),
    }
}

fn clamp_cols(cols: i64) -> u16 {
    cols.clamp(1, 1000) as u16
}

fn clamp_rows(rows: i64) -> u16 {
    rows.clamp(1, 500) as u16
}

fn into_env(env: Map<String, String>) -> BTreeMap<String, String> {
    env.into_iter().collect()
}

fn lookup_error(key: &Key) -> TerminalOpenError {
    TerminalOpenError::TerminalSessionLookupError(TerminalSessionLookupError {
        tag: Default::default(),
        thread_id: key.0.clone(),
        terminal_id: key.1.clone(),
    })
}

fn check_cwd(cwd: &str) -> Result<(), TerminalOpenError> {
    match std::fs::metadata(cwd) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(TerminalOpenError::TerminalCwdNotDirectoryError(
            TerminalCwdNotDirectoryError {
                tag: Default::default(),
                cwd: cwd.into(),
            },
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(
            TerminalOpenError::TerminalCwdNotFoundError(TerminalCwdNotFoundError {
                tag: Default::default(),
                cwd: cwd.into(),
            }),
        ),
        Err(error) => Err(TerminalOpenError::TerminalCwdStatError(
            TerminalCwdStatError {
                tag: Default::default(),
                cwd: cwd.into(),
                cause: serde_json::json!({ "message": error.to_string() }),
            },
        )),
    }
}

/// `getTerminalLabel`: `term-3` and `terminal-3` (with an optional UUID suffix) read
/// "Terminal 3"; any other id is its own label.
pub fn terminal_label(terminal_id: &str) -> String {
    let lower = terminal_id.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("terminal-")
        .or_else(|| lower.strip_prefix("term-"));
    if let Some(rest) = rest {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let suffix = &rest[digits.len()..];
        if !digits.is_empty() && (suffix.is_empty() || is_uuid_suffix(suffix)) {
            return format!("Terminal {digits}");
        }
    }
    terminal_id.to_owned()
}

fn is_uuid_suffix(suffix: &str) -> bool {
    let Some(uuid) = suffix.strip_prefix('-') else {
        return false;
    };
    let parts: Vec<&str> = uuid.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The command name of a process, as `ps -o comm=` shows it, without its folder.
async fn process_name(pid: i32) -> Option<String> {
    let raw = match tokio::fs::read_to_string(format!("/proc/{pid}/comm")).await {
        Ok(name) => name,
        Err(_) => {
            let output = tokio::process::Command::new("ps")
                .args(["-o", "comm=", "-p", &pid.to_string()])
                .output()
                .await
                .ok()?;
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
    };
    let name = raw.trim();
    let name = name.rsplit('/').next().unwrap_or(name);
    let name = name
        .trim_start_matches(['(', '['])
        .trim_end_matches([')', ']'])
        .trim_start_matches('-');
    (!name.is_empty()).then(|| name.chars().take(MAX_LABEL_CHARS).collect())
}

/// Locks a std mutex. A poisoned lock means a thread panicked while it held the lock: a bug.
/// With `panic = "abort"` a release build stops at the panic itself.
pub(crate) fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().expect("conn-terminal lock poisoned")
}

#[cfg(test)]
mod tests;

/// What the shell receives for client input. `binary` data holds one byte per UTF-16 code
/// unit, as `ptyInput` in `packages/shared` (`Buffer.from(data, "latin1")`, which keeps each
/// unit's low byte); other data goes as UTF-8 text.
fn pty_input(data: &str, binary: bool) -> Vec<u8> {
    if binary {
        data.encode_utf16()
            .map(|unit| unit.to_le_bytes()[0])
            .collect()
    } else {
        data.as_bytes().to_vec()
    }
}
