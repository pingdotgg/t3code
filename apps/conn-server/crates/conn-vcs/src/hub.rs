//! Keeps `subscribeVcsStatus` and `subscribeVcsBranch` current.
//!
//! How the TypeScript server learns of changes (`VcsStatusBroadcaster.ts`): a file watch on the
//! folder that holds `HEAD` (checkouts), a remote poll with `git fetch` every 30 s while a
//! subscriber wants remote status, a local refresh after each turn and after each VCS RPC,
//! and the client's own `vcs.refreshStatus` on focus and reconnect.
//!
//! Here: one ticker task for all subscribed folders. Every [`TICK`] it stats `HEAD` and the
//! index of each folder; a change in either (checkout, commit, stage) refreshes that folder.
//! Remote status is read once, then every fetch interval with a fetch while a client lease
//! lets the work run ([`RemotePolicy`]), backing off on failure. No
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
    /// The folder as the subscriber gave it, which settings and leases name.
    cwd: String,
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
    /// The next poll reads remote status even when fetching is off or work is paused
    /// (`needsInitialRefresh`).
    remote_initial: bool,
    /// The next poll rereads remote status after a checkout, with no fetch and no pull
    /// (`reconcileCheckedOutRef`).
    remote_reread: bool,
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

    /// The folders, as given, of the subscribers that want remote status (`demandCwds`).
    fn demand_cwds(&self) -> Vec<String> {
        let mut cwds: Vec<String> = Vec::new();
        for sub in self.status_subs.iter().filter(|s| s.remote) {
            if !cwds.contains(&sub.cwd) {
                cwds.push(sub.cwd.clone());
            }
        }
        cwds
    }

    fn remote_now(&mut self) {
        self.next_remote = Some(Instant::now());
        self.remote_initial = true;
    }

    fn reread_now(&mut self) {
        self.next_remote = Some(Instant::now());
        self.remote_reread = true;
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

/// The settings that shape a folder's remote refresh: `automaticGitFetchInterval`
/// (`VcsAutomaticFetchInterval`; zero turns fetching off) and `defaultAutoPull` for the
/// project at that folder (`VcsAutoPullPolicy`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RemotePolicy {
    pub fetch_interval: Duration,
    pub auto_pull: bool,
    /// `shouldRunScopeWork` for `vcs-status`: a client lease lets periodic work run now.
    /// Explicit refreshes ignore it.
    pub background: bool,
}

impl Default for RemotePolicy {
    /// T3's defaults: fetch every 30 s, no automatic pull.
    fn default() -> Self {
        Self {
            fetch_interval: REMOTE_INTERVAL,
            auto_pull: false,
            background: true,
        }
    }
}

impl RemotePolicy {
    fn fetches(self) -> bool {
        !self.fetch_interval.is_zero()
    }

    /// How long until the next background read (`activeInterval`).
    fn poll_interval(self) -> Duration {
        if self.fetches() {
            self.fetch_interval
        } else {
            REMOTE_INTERVAL
        }
    }
}

/// Reads [`RemotePolicy`] for folders as callers gave them (`policyCwds`); the server answers
/// from its settings, projects and client leases. Any one folder may enable a pull or work.
pub trait RemotePolicySource: Send + Sync {
    fn policy<'a>(
        &'a self,
        cwds: &'a [String],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = RemotePolicy> + Send + 'a>>;
}

#[derive(Clone, Default)]
pub struct VcsHub {
    state: Arc<Mutex<State>>,
    policy: Arc<std::sync::OnceLock<Arc<dyn RemotePolicySource>>>,
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

    /// Sets where remote refreshes read their settings, once; without it they use
    /// [`RemotePolicy::default`].
    pub fn set_policy(&self, source: Arc<dyn RemotePolicySource>) {
        let _ = self.policy.set(source);
    }

    async fn policy(&self, cwds: &[String]) -> RemotePolicy {
        match self.policy.get() {
            Some(source) => source.policy(cwds).await,
            None => RemotePolicy::default(),
        }
    }

    fn with<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut crate::lock(&self.state))
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
        let raw = cwd.to_owned();
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
                entry.remote_now();
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
                    cwd: raw,
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
                    entry.reread_now();
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
        let raw = [cwd.to_owned()];
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
        let policy = self.policy(&raw).await;
        if policy.fetches()
            && let Some(done) = self.start_fetch(&cwd)
        {
            let _ = tokio::time::timeout(FETCH_WAIT, done).await;
        }
        let remote = status::remote_status(&cwd).await?;
        // Without a fetch, the cached behind count cannot justify an automatic pull.
        if policy.fetches()
            && policy.auto_pull
            && let Some(pulled) = self.auto_pull(&cwd, &local, remote.as_ref()).await
        {
            return Ok(pulled);
        }
        self.publish_remote(&cwd, local.ref_name.clone(), remote.clone());
        Ok(status::merge(local, remote))
    }

    /// `maybeAutoPull`: fast-forwards a clean default branch that is only behind its upstream,
    /// then rereads and publishes both parts. `None` when the folder is not eligible.
    async fn auto_pull(
        &self,
        cwd: &Path,
        read: &VcsStatusLocalResult,
        remote: Option<&VcsStatusRemoteResult>,
    ) -> Option<VcsStatusResult> {
        let remote = remote?;
        if !remote.has_upstream || remote.ahead_count > 0 || remote.behind_count <= 0 {
            return None;
        }
        let local = self.refresh_local_at(cwd).await.ok()?;
        if !local.is_repo
            || !local.is_default_ref
            || local.has_working_tree_changes
            || local.ref_name != read.ref_name
        {
            return None;
        }
        if let Err(error) = crate::refs::pull(cwd).await {
            eprintln!("conn-vcs: automatic project pull failed: {error}");
        }
        // A pull can fail after it changed local state: reread both parts either way.
        let local = self.refresh_local_at(cwd).await.ok()?;
        let remote = status::remote_status(cwd).await.ok()?;
        self.publish_remote(cwd, local.ref_name.clone(), remote.clone());
        Some(status::merge(local, remote))
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
                            let remote = remote_due.then(|| {
                                e.remote_busy = true;
                                let reread = std::mem::take(&mut e.remote_reread);
                                (e.demand_cwds(), e.remote_initial, reread)
                            });
                            (
                                cwd.clone(),
                                e.watched.clone(),
                                e.stamp.clone(),
                                !e.status_subs.is_empty(),
                                remote,
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            });
            let Some(work) = work else {
                return;
            };
            for (cwd, watched, old, detailed, remote) in work {
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
                if let Some((demand, initial, reread)) = remote {
                    let hub = self.clone();
                    tokio::spawn(
                        async move { hub.poll_remote(cwd, demand, initial, reread).await },
                    );
                }
            }
        }
    }

    async fn poll_remote(&self, cwd: PathBuf, demand: Vec<String>, initial: bool, reread: bool) {
        // A reread after a checkout runs whatever the gate says, but fetches and pulls nothing.
        let policy = if reread && !initial {
            RemotePolicy {
                fetch_interval: Duration::ZERO,
                auto_pull: false,
                background: true,
            }
        } else {
            self.policy(&demand).await
        };
        // `refreshRemoteStatusIfEnabled`: after the first read, nothing while fetching is off
        // or no client lets the work run.
        if !initial && !reread && !(policy.fetches() && policy.background) {
            self.with(|s| {
                if let Some(entry) = s.entries.get_mut(&cwd) {
                    entry.remote_busy = false;
                    entry.next_remote = Some(Instant::now() + policy.poll_interval());
                }
            });
            return;
        }
        if policy.fetches()
            && let Some(done) = self.start_fetch(&cwd)
        {
            let _ = done.await;
        }
        let branch = repo::current_branch(&cwd).await;
        let result = match branch {
            Ok(branch) => status::remote_status(&cwd).await.map(|r| (branch, r)),
            Err(e) => Err(e),
        };
        let ok = result.is_ok();
        if let Ok((branch, remote)) = result {
            let pulled = if policy.fetches() && policy.auto_pull {
                let read = self.with(|s| s.entries.get(&cwd).and_then(|e| e.local.clone()));
                match read {
                    Some(read) if read.ref_name == branch => {
                        self.auto_pull(&cwd, &read, remote.as_ref()).await
                    }
                    _ => None,
                }
            } else {
                None
            };
            if pulled.is_none() {
                self.publish_remote(&cwd, branch, remote);
            }
        }
        let interval = policy.poll_interval();
        self.with(|s| {
            if let Some(entry) = s.entries.get_mut(&cwd) {
                entry.remote_busy = false;
                entry.remote_reread |= reread && !ok;
                if ok {
                    entry.remote_failures = 0;
                    entry.remote_initial = false;
                    entry.next_remote = Some(Instant::now() + interval);
                } else {
                    entry.remote_failures += 1;
                    let backoff = interval
                        .saturating_mul(1 << (entry.remote_failures - 1).min(10))
                        .min(REMOTE_MAX_BACKOFF);
                    entry.next_remote = Some(Instant::now() + backoff.max(interval));
                }
                if entry.remote_reread && !reread {
                    // A checkout while this poll ran.
                    entry.next_remote = Some(Instant::now());
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
