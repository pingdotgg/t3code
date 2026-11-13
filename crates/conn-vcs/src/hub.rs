//! Keeps `subscribeVcsStatus` and `subscribeVcsBranch` current.
//!
//! How the TypeScript server learns of changes (`VcsStatusBroadcaster.ts`): a file watch on the
//! folder that holds `HEAD` (checkouts), a remote poll with `git fetch` every 30 s while a
//! subscriber wants remote status, a local refresh after each turn and after each VCS RPC,
//! and the client's own `vcs.refreshStatus` on focus and reconnect.
//!
//! Here: one ticker task for all subscribed folders. Every [`TICK`] it stats `HEAD` and the
//! index of each folder; a change in either (checkout, commit, stage) refreshes that folder.
//! Remote status is read every [`REMOTE_INTERVAL`] with a fetch, backing off on failure. No
//! watcher threads, no per-folder tasks; the ticker ends when the last subscriber leaves.
//! State is one entry per subscribed folder, removed with its last subscriber.
//!
//! The integrator calls [`VcsHub::refresh_local`] when a turn ends, as `RunFinalizationService`
//! does.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use conn_contract::{
    VcsBranchStatus, VcsStatusLocalResult, VcsStatusRemoteResult, VcsStatusResult,
    VcsStatusStreamEvent, VcsStatusStreamEventLocalUpdated, VcsStatusStreamEventRemoteUpdated,
    VcsStatusStreamEventSnapshot, lit,
};
use tokio::sync::oneshot;

use crate::{
    error::VcsResult,
    repo::{self, git},
    status,
};

pub const TICK: Duration = Duration::from_secs(2);
/// `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL`.
pub const REMOTE_INTERVAL: Duration = Duration::from_secs(30);
const REMOTE_MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// A fetch younger than this is not repeated (`refreshStatusUpstreamIfStale`).
const FETCH_FRESH: Duration = Duration::from_secs(15);
/// How long an explicit refresh waits on a fetch before it reads the old refs.
const FETCH_WAIT: Duration = Duration::from_secs(5);

/// Where a subscription's items go. `send` returns false once the subscriber is gone.
pub trait Sink<T>: Send {
    fn send(&self, item: T) -> bool;
    fn is_closed(&self) -> bool;
}

impl<T: Send> Sink<T> for tokio::sync::mpsc::Sender<T> {
    fn send(&self, item: T) -> bool {
        !matches!(
            self.try_send(item),
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_))
        )
    }

    fn is_closed(&self) -> bool {
        tokio::sync::mpsc::Sender::is_closed(self)
    }
}

struct StatusSub {
    sink: Box<dyn Sink<VcsStatusStreamEvent>>,
    remote: bool,
}

#[derive(Clone, PartialEq)]
struct RemotePart {
    /// The branch the remote part was read for; it is dropped when the branch changes.
    branch: Option<String>,
    value: Option<VcsStatusRemoteResult>,
}

#[derive(Default)]
struct Entry {
    status_subs: Vec<StatusSub>,
    branch_subs: Vec<Box<dyn Sink<VcsBranchStatus>>>,
    local: Option<VcsStatusLocalResult>,
    remote: Option<RemotePart>,
    branch: Option<VcsBranchStatus>,
    watched: Vec<PathBuf>,
    stamp: Vec<Option<(SystemTime, u64)>>,
    next_remote: Option<Instant>,
    remote_failures: u32,
    remote_busy: bool,
}

impl Entry {
    fn prune(&mut self) {
        self.status_subs.retain(|s| !s.sink.is_closed());
        self.branch_subs.retain(|s| !s.is_closed());
    }

    fn is_empty(&self) -> bool {
        self.status_subs.is_empty() && self.branch_subs.is_empty()
    }

    fn wants_remote(&self) -> bool {
        self.status_subs.iter().any(|s| s.remote)
    }

    fn publish_status(&mut self, event: &VcsStatusStreamEvent) {
        self.status_subs.retain(|s| s.sink.send(event.clone()));
    }

    fn publish_branch(&mut self, branch: VcsBranchStatus) {
        if self.branch.as_ref() == Some(&branch) {
            return;
        }
        self.branch = Some(branch.clone());
        self.branch_subs.retain(|s| s.send(branch.clone()));
    }
}

#[derive(Default)]
struct State {
    entries: HashMap<PathBuf, Entry>,
    ticking: bool,
    fetching: HashSet<PathBuf>,
    last_fetch: HashMap<PathBuf, Instant>,
}

/// How much remote status a caller wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remote {
    /// Read it: fetch and poll while subscribed.
    Read,
    /// Only what is cached; no fetch, no poll.
    Cached,
}

#[derive(Clone, Default)]
pub struct VcsHub {
    state: Arc<Mutex<State>>,
}

/// `realpath`, falling back to the path as given.
pub fn normalize(cwd: &str) -> PathBuf {
    std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd))
}

fn stamp(paths: &[PathBuf]) -> Vec<Option<(SystemTime, u64)>> {
    paths
        .iter()
        .map(|p| {
            std::fs::metadata(p)
                .ok()
                .and_then(|m| Some((m.modified().ok()?, m.len())))
        })
        .collect()
}

async fn watched_paths(cwd: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(Some(head)) = repo::head_path(cwd).await {
        paths.push(head);
    }
    if let Ok(Some(index)) = repo::optional_text(git(
        "VcsHub.indexPath",
        cwd,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    ))
    .await
        && !index.is_empty()
    {
        paths.push(PathBuf::from(index));
    }
    paths
}

impl VcsHub {
    pub fn new() -> Self {
        Self::default()
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.lock().expect("hub lock"))
    }

    /// Number of folders with at least one subscriber.
    pub fn watched_folders(&self) -> usize {
        self.with(|s| s.entries.len())
    }

    /// Starts a status stream: sends the snapshot, then `localUpdated` / `remoteUpdated` as
    /// they change. [`Remote::Cached`] gets cached remote status without polling.
    pub async fn subscribe_status(
        &self,
        cwd: &str,
        wanted: Remote,
        sink: Box<dyn Sink<VcsStatusStreamEvent>>,
    ) -> VcsResult<()> {
        let cwd = normalize(cwd);
        let watched = watched_paths(&cwd).await;
        let before = stamp(&watched);
        let cached = self.with(|s| {
            s.entries.get(&cwd).and_then(|e| {
                (e.stamp == before && !e.status_subs.is_empty())
                    .then(|| e.local.clone())
                    .flatten()
            })
        });
        let local = match cached {
            Some(local) => local,
            None => status::local_status(&cwd).await?,
        };
        let snapshot_remote = self.with(|s| {
            let entry = s.entries.entry(cwd.clone()).or_default();
            entry.watched = watched;
            entry.stamp = before;
            let ref_name = local.ref_name.clone();
            if entry.remote.as_ref().is_some_and(|r| r.branch != ref_name) {
                entry.remote = None;
            }
            entry.local = Some(local.clone());
            entry.publish_branch(VcsBranchStatus {
                ref_name,
                is_repo: Some(local.is_repo),
            });
            let remote = entry.remote.as_ref().and_then(|r| r.value.clone());
            if wanted == Remote::Read && entry.remote.is_none() {
                entry.next_remote = Some(Instant::now());
            }
            let event = VcsStatusStreamEvent::Snapshot(VcsStatusStreamEventSnapshot {
                tag: lit::Snapshot,
                local: local.clone(),
                remote: remote.clone(),
            });
            if sink.send(event) {
                entry.status_subs.push(StatusSub {
                    sink,
                    remote: wanted == Remote::Read,
                });
            }
            remote
        });
        let _ = snapshot_remote;
        self.ensure_ticker();
        Ok(())
    }

    /// Starts a branch stream: the current `{refName, isRepo}`, then each change.
    pub async fn subscribe_branch(
        &self,
        cwd: &str,
        sink: Box<dyn Sink<VcsBranchStatus>>,
    ) -> VcsResult<()> {
        let cwd = normalize(cwd);
        let watched = watched_paths(&cwd).await;
        let before = stamp(&watched);
        let branch = status::branch_status(&cwd).await?;
        self.with(|s| {
            let entry = s.entries.entry(cwd.clone()).or_default();
            if entry.watched.is_empty() {
                entry.watched = watched;
                entry.stamp = before;
            }
            entry.publish_branch(branch.clone());
            if sink.send(branch) {
                entry.branch_subs.push(sink);
            }
        });
        self.ensure_ticker();
        Ok(())
    }

    /// Rereads local status and publishes what changed. Call after a turn ends and after any
    /// VCS mutation.
    pub async fn refresh_local(&self, cwd: &str) -> VcsResult<VcsStatusLocalResult> {
        let cwd = normalize(cwd);
        self.refresh_local_at(&cwd).await
    }

    async fn refresh_local_at(&self, cwd: &Path) -> VcsResult<VcsStatusLocalResult> {
        let watched = self.with(|s| s.entries.get(cwd).map(|e| e.watched.clone()));
        let before = watched.as_deref().map(stamp);
        let local = status::local_status(cwd).await?;
        self.publish_local(cwd, &local, before);
        Ok(local)
    }

    fn publish_local(
        &self,
        cwd: &Path,
        local: &VcsStatusLocalResult,
        stamp: Option<Vec<Option<(SystemTime, u64)>>>,
    ) {
        self.with(|s| {
            let Some(entry) = s.entries.get_mut(cwd) else {
                return;
            };
            if let Some(stamp) = stamp {
                entry.stamp = stamp;
            }
            if entry
                .remote
                .as_ref()
                .is_some_and(|r| r.branch != local.ref_name)
            {
                entry.remote = None;
                entry.publish_status(&VcsStatusStreamEvent::RemoteUpdated(
                    VcsStatusStreamEventRemoteUpdated {
                        tag: lit::RemoteUpdated,
                        remote: None,
                    },
                ));
                if entry.wants_remote() {
                    entry.next_remote = Some(Instant::now());
                }
            }
            if entry.local.as_ref() != Some(local) {
                entry.local = Some(local.clone());
                entry.publish_status(&VcsStatusStreamEvent::LocalUpdated(
                    VcsStatusStreamEventLocalUpdated {
                        tag: lit::LocalUpdated,
                        local: local.clone(),
                    },
                ));
            }
            entry.publish_branch(VcsBranchStatus {
                ref_name: local.ref_name.clone(),
                is_repo: Some(local.is_repo),
            });
        });
    }

    /// `vcs.refreshBranch`: rereads the branch and publishes a change.
    pub async fn refresh_branch(&self, cwd: &str) -> VcsResult<VcsBranchStatus> {
        let cwd = normalize(cwd);
        let detailed = self.with(|s| {
            s.entries
                .get(&cwd)
                .is_some_and(|e| !e.status_subs.is_empty())
        });
        if detailed {
            let local = self.refresh_local_at(&cwd).await?;
            return Ok(VcsBranchStatus {
                ref_name: local.ref_name,
                is_repo: Some(local.is_repo),
            });
        }
        let branch = status::branch_status(&cwd).await?;
        self.with(|s| {
            if let Some(entry) = s.entries.get_mut(&cwd) {
                entry.publish_branch(branch.clone());
            }
        });
        Ok(branch)
    }

    /// `vcs.refreshStatus`: local status, and with [`Remote::Read`] a fetch (waited on for at
    /// most 5 s) and remote status. Publishes both.
    pub async fn refresh_status(&self, cwd: &str, remote: Remote) -> VcsResult<VcsStatusResult> {
        let cwd = normalize(cwd);
        let local = self.refresh_local_at(&cwd).await?;
        if remote == Remote::Cached || !local.is_repo {
            let remote = self.with(|s| {
                s.entries
                    .get(&cwd)
                    .and_then(|e| e.remote.as_ref().and_then(|r| r.value.clone()))
            });
            return Ok(status::merge(local, remote));
        }
        let fetched = self.start_fetch(&cwd);
        if let Some(done) = fetched {
            let _ = tokio::time::timeout(FETCH_WAIT, done).await;
        }
        let remote = status::remote_status(&cwd).await?;
        self.publish_remote(&cwd, local.ref_name.clone(), remote.clone());
        Ok(status::merge(local, remote))
    }

    fn publish_remote(
        &self,
        cwd: &Path,
        branch: Option<String>,
        value: Option<VcsStatusRemoteResult>,
    ) {
        self.with(|s| {
            let Some(entry) = s.entries.get_mut(cwd) else {
                return;
            };
            if entry.local.as_ref().is_some_and(|l| l.ref_name != branch) {
                return;
            }
            let next = RemotePart { branch, value };
            if entry.remote.as_ref() != Some(&next) {
                entry.publish_status(&VcsStatusStreamEvent::RemoteUpdated(
                    VcsStatusStreamEventRemoteUpdated {
                        tag: lit::RemoteUpdated,
                        remote: next.value.clone(),
                    },
                ));
                entry.remote = Some(next);
            }
        });
    }

    /// Starts `git fetch` of the upstream remote unless one runs or ran in the last 15 s.
    /// The fetch is never cancelled once started: a killed fetch can leave ref locks.
    fn start_fetch(&self, cwd: &Path) -> Option<oneshot::Receiver<()>> {
        let go = self.with(|s| {
            let fresh = s
                .last_fetch
                .get(cwd)
                .is_some_and(|t| t.elapsed() < FETCH_FRESH);
            if fresh || !s.fetching.insert(cwd.to_owned()) {
                return false;
            }
            // Bounded by the folders fetched in the last 15 s.
            s.last_fetch.retain(|_, t| t.elapsed() < FETCH_FRESH);
            true
        });
        if !go {
            return None;
        }
        let (tx, rx) = oneshot::channel();
        let hub = self.clone();
        let cwd = cwd.to_owned();
        tokio::spawn(async move {
            if let Err(error) = status::fetch_upstream_remote(&cwd).await {
                eprintln!("conn-vcs: background fetch failed: {error}");
            }
            hub.with(|s| {
                s.fetching.remove(&cwd);
                s.last_fetch.insert(cwd, Instant::now());
            });
            let _ = tx.send(());
        });
        Some(rx)
    }

    fn ensure_ticker(&self) {
        let start = self.with(|s| !std::mem::replace(&mut s.ticking, true));
        if !start {
            return;
        }
        let hub = self.clone();
        tokio::spawn(async move { hub.tick_loop().await });
    }

    async fn tick_loop(&self) {
        loop {
            tokio::time::sleep(TICK).await;
            let work = self.with(|s| {
                s.entries.retain(|_, e| {
                    e.prune();
                    !e.is_empty()
                });
                if s.entries.is_empty() {
                    s.ticking = false;
                    return None;
                }
                let now = Instant::now();
                Some(
                    s.entries
                        .iter_mut()
                        .map(|(cwd, e)| {
                            let remote_due = e.wants_remote()
                                && !e.remote_busy
                                && e.next_remote.is_none_or(|t| t <= now);
                            if remote_due {
                                e.remote_busy = true;
                            }
                            (
                                cwd.clone(),
                                e.watched.clone(),
                                e.stamp.clone(),
                                !e.status_subs.is_empty(),
                                remote_due,
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            });
            let Some(work) = work else {
                return;
            };
            for (cwd, watched, old, detailed, remote_due) in work {
                let now = stamp(&watched);
                if now != old {
                    if detailed {
                        if let Err(error) = self.refresh_local_at(&cwd).await {
                            eprintln!("conn-vcs: status refresh failed: {error}");
                        }
                    } else {
                        let branch = status::branch_status(&cwd).await;
                        self.with(|s| {
                            if let Some(entry) = s.entries.get_mut(&cwd) {
                                entry.stamp = now;
                                if let Ok(branch) = branch {
                                    entry.publish_branch(branch);
                                }
                            }
                        });
                    }
                }
                if remote_due {
                    let hub = self.clone();
                    tokio::spawn(async move { hub.poll_remote(cwd).await });
                }
            }
        }
    }

    async fn poll_remote(&self, cwd: PathBuf) {
        if let Some(done) = self.start_fetch(&cwd) {
            let _ = done.await;
        }
        let branch = repo::current_branch(&cwd).await;
        let result = match branch {
            Ok(branch) => status::remote_status(&cwd).await.map(|r| (branch, r)),
            Err(e) => Err(e),
        };
        let ok = result.is_ok();
        if let Ok((branch, remote)) = result {
            self.publish_remote(&cwd, branch, remote);
        }
        self.with(|s| {
            if let Some(entry) = s.entries.get_mut(&cwd) {
                entry.remote_busy = false;
                if ok {
                    entry.remote_failures = 0;
                    entry.next_remote = Some(Instant::now() + REMOTE_INTERVAL);
                } else {
                    entry.remote_failures += 1;
                    let backoff = REMOTE_INTERVAL
                        .saturating_mul(1 << (entry.remote_failures - 1).min(10))
                        .min(REMOTE_MAX_BACKOFF);
                    entry.next_remote = Some(Instant::now() + backoff.max(REMOTE_INTERVAL));
                }
            }
        });
    }
}

impl std::fmt::Debug for VcsHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VcsHub")
            .field("watched_folders", &self.watched_folders())
            .finish()
    }
}
