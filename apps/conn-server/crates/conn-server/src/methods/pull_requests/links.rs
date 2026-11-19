//! The pull request link sweep, as T3's `PullRequestSyncReactor` and
//! `ThreadPullRequestService` run it. Every minute, and at once on a new link, it reads each
//! due linked pull request from GitHub through the panel's client (`gh`'s login) and writes its
//! snapshot and stack with `thread.pull-request-link.sync`. It also looks up each active
//! thread's branch on GitHub and writes the branch's pull request with
//! `thread.pull-request.sync`: the pull request the sidebar chip shows. The decisions live in
//! `conn_source_control::pull_requests::link_sync`; this file does the reads and dispatches.
//!
//! It runs in its own task beside the watch loop (`watches::run`), one GitHub read at a time,
//! so a slow lookup never holds back a new watch's first read.

use super::{Failure, Panel, Project};
use conn_source_control::{
    pull_requests::{
        link_sync::{
            self, BranchGroup, BranchHead, BranchProject, BranchSync, Group, LinkSync, ReadFailure,
            Scope, StackNeed, StackRead,
        },
        normalize::{array, text},
    },
    registry,
};
use conn_support::time::{iso_from_ms, now_ms};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

/// What the shell listener asks the sweep for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Request {
    /// A link without a snapshot appeared (`requestUnsyncedLinks`).
    Unsynced { project_id: String, link: Value },
    /// A thread settled: read its open and closed links once (`refreshUnmergedLinks`). The
    /// listener moves the keys into [`Settles`] and sends this empty as a wake-up.
    Settled(Vec<String>),
    /// A thread's own event: look its branch up at once.
    Branch(String),
}

/// Settle refreshes waiting for the link sweep (`pendingRequests`). They live here, not only in
/// the request channel: a full channel drops its message, and a normal sweep skips links whose
/// threads have all settled, so a pull request merged before the settle would stay open.
#[derive(Clone, Debug, Default)]
pub(super) struct Settles(Arc<Mutex<HashSet<String>>>);

impl Settles {
    pub(super) fn add(&self, keys: Vec<String>) {
        if let Ok(mut pending) = self.0.lock() {
            pending.extend(keys);
        }
    }

    pub(super) fn take(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut pending| pending.drain().collect())
            .unwrap_or_default()
    }
}

/// Hands one request from the shell listener to the link sweep. Settle keys go to `settles`
/// first; the channel only wakes the sweep. Returns `false` when the channel was full: the
/// caller then asks for a full sweep, which takes in the waiting settles too.
pub(super) fn route(request: Request, tx: &mpsc::Sender<Request>, settles: &Settles) -> bool {
    let request = match request {
        Request::Settled(keys) => {
            settles.add(keys);
            Request::Settled(Vec::new())
        }
        other => other,
    };
    tx.try_send(request).is_ok()
}

pub(super) struct Links {
    panel: Arc<Panel>,
    settles: Settles,
    links: LinkSync,
    branches: BranchSync,
    started: bool,
}

/// `PullRequestUnavailableError` (no CLI, signed out, not GitHub) and not-found wait for the
/// slow cadence; anything else backs off.
fn read_failure(failure: &Failure) -> ReadFailure {
    match failure {
        Failure::Fail(value)
            if value["_tag"] == "PullRequestUnavailableError" || value["reason"] == "not-found" =>
        {
            ReadFailure::Missing
        }
        _ => ReadFailure::Failed,
    }
}

fn rate_limited(failure: &Failure) -> bool {
    matches!(failure, Failure::Fail(value) if value["cause"]["reason"] == "rate-limited")
}

impl Links {
    pub(super) fn new(panel: Arc<Panel>, settles: Settles) -> Self {
        Self {
            panel,
            settles,
            links: LinkSync::default(),
            branches: BranchSync::default(),
            started: false,
        }
    }

    /// Moves the waiting settle refreshes into the sweep's requests.
    fn take_settles(&mut self) {
        take_settles(&self.settles, &mut self.links);
    }

    pub(super) async fn handle(&mut self, request: Request) {
        self.take_settles();
        match request {
            Request::Unsynced { project_id, link } => {
                self.links.request_unsynced(&project_id, &link);
                self.sweep(Scope::Requested).await;
            }
            Request::Settled(keys) => {
                for key in keys {
                    self.links.request(key);
                }
                self.sweep(Scope::Requested).await;
            }
            Request::Branch(thread_id) => self.branches(Some(&thread_id)).await,
        }
    }

    /// The minute sweep: due links, then branches.
    pub(super) async fn tick(&mut self) {
        self.take_settles();
        self.sweep(Scope::All).await;
        self.branches(None).await;
    }

    async fn dispatch(&self, command: Value) -> Result<(), String> {
        let command = conn_contract::from_json(command).map_err(|e| e.to_string())?;
        self.panel
            .engine
            .dispatch(command)
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    /// One link sweep (`sweep`).
    pub(super) async fn sweep(&mut self, scope: Scope) {
        if scope == Scope::Requested && !self.links.has_pending() {
            return;
        }
        let Ok(shell) = self.panel.engine.shell_snapshot().await else {
            return;
        };
        let now = now_ms();
        let groups = self
            .links
            .begin(array(shell.get("threads")), scope, now as f64);
        for group in groups {
            self.read_group(&group, now).await;
        }
    }

    async fn read_group(&mut self, group: &Group, now: u64) {
        let reference = group.reference();
        let connected = self.panel.reference_client("summary", &reference).await;
        let (project, client, lookup) = match connected {
            Ok(connected) => connected,
            Err(failure) => {
                self.links
                    .read_failed(group, read_failure(&failure), now as f64);
                return;
            }
        };
        let summary = self
            .panel
            .load_read("summary", &reference, &project, &client, &lookup)
            .await;
        let summary = match summary {
            Ok(summary) => summary,
            Err(failure) => {
                self.links
                    .read_failed(group, read_failure(&failure), now as f64);
                return;
            }
        };
        let stack = match self.links.stack_need(group, &summary) {
            StackNeed::Keep => StackRead::Kept,
            StackNeed::Unstacked => StackRead::Read(Value::Null),
            StackNeed::Read => match self
                .panel
                .load_read("stack", &reference, &project, &client, &lookup)
                .await
            {
                Ok(stack) => StackRead::Read(link_sync::native_stack(&stack)),
                Err(failure) if rate_limited(&failure) => StackRead::Limited,
                Err(_) => StackRead::Failed,
            },
        };
        let commands = self.links.finish(
            group,
            &summary,
            stack,
            now as f64,
            &iso_from_ms(now),
            &mut conn_support::uuid_v4,
        );
        for command in commands {
            if self.dispatch(command).await.is_err() {
                self.links.dispatch_failed(group);
            }
        }
    }

    /// One branch lookup pass (`synchronize`): every active thread's branch, or one thread's.
    /// The minute sweep after the first runs only while a client is in the foreground
    /// (`backgroundPolicy.shouldRunOpportunisticWork`); a thread's own events always look up.
    async fn branches(&mut self, thread: Option<&str>) {
        if thread.is_none() && self.started && !self.panel.opportunistic() {
            return;
        }
        let Ok(shell) = self.panel.engine.shell_snapshot().await else {
            return;
        };
        let sequence = shell["snapshotSequence"].as_u64().unwrap_or(0);
        let now = now_ms() as f64;
        if !self.started && thread.is_none() {
            self.started = true;
            self.branches.start_backfill(array(shell.get("threads")));
        }
        let groups = self
            .branches
            .groups(array(shell.get("threads")), thread, now);
        // Git reads first, then one GitHub document per 25 heads of a host (T3 batches its
        // background head lookups by host and credential), then the writes.
        let mut prepared = Vec::new();
        for group in groups {
            let Some(project) = array(shell.get("projects"))
                .iter()
                .find(|p| text(p, "id") == group.project_id())
                .cloned()
            else {
                self.branches.finish(&group, &[], &[]);
                continue;
            };
            let Ok(github) = self
                .panel
                .projects(&json!({"projectId": group.project_id()}))
                .await
            else {
                continue;
            };
            let Some(github) = github.into_iter().next() else {
                self.branches.finish(&group, &[], &[]);
                continue;
            };
            let root = text(&project, "workspaceRoot").to_owned();
            // A worktree folder can outlive its `.git`; then the project's checkout answers.
            let cwd = match group.worktree_path() {
                Some(path) if exists(Path::new(path).join(".git")).await => path.to_owned(),
                _ => root.clone(),
            };
            let head = match group.branch() {
                Some(branch) => head_of(&github, Path::new(&cwd), branch).await,
                None => None,
            };
            prepared.push(Prepared {
                group,
                root,
                cwd,
                github,
                head,
                found: None,
            });
        }
        self.look_up(&mut prepared).await;
        for item in prepared {
            self.write_branch(item, sequence, now).await;
        }
    }

    /// Fills `found` for every prepared group with a branch: `Some(Ok(..))` when GitHub
    /// answered.
    async fn look_up(&self, prepared: &mut [Prepared]) {
        let mut hosts: Vec<String> = prepared
            .iter()
            .filter(|p| p.head.is_some())
            .map(|p| p.github.host.clone())
            .collect();
        hosts.sort();
        hosts.dedup();
        for host in hosts {
            let members: Vec<usize> = (0..prepared.len())
                .filter(|&i| {
                    prepared
                        .get(i)
                        .is_some_and(|p| p.head.is_some() && p.github.host == host)
                })
                .collect();
            let Some(first) = members.first().and_then(|&i| prepared.get(i)) else {
                continue;
            };
            let Ok(client) = self.panel.client(&first.github, "listChangeRequests").await else {
                continue;
            };
            let heads: Vec<(String, String, String)> = members
                .iter()
                .filter_map(|&i| prepared.get(i))
                .map(|p| {
                    let (owner, name) = p.github.repository.split_once('/').unwrap_or_default();
                    let head = p.head.as_ref().map_or("", |h| h.head.name.as_str());
                    (owner.to_owned(), name.to_owned(), head.to_owned())
                })
                .collect();
            let answers = client.pull_requests_by_heads(&heads).await;
            for (&i, nodes) in members.iter().zip(answers) {
                if let Some(item) = prepared.get_mut(i) {
                    item.found = nodes.map(|nodes| {
                        let default = item.head.as_ref().and_then(|h| h.default_branch.clone());
                        item.head.as_ref().and_then(|h| {
                            link_sync::branch_pull_request(&nodes, &h.head, default.as_deref())
                        })
                    });
                }
            }
        }
    }

    async fn write_branch(&mut self, item: Prepared, sequence: u64, now: f64) {
        let Prepared {
            group,
            root,
            cwd,
            github,
            head,
            found,
        } = item;
        let detected = match (&head, found) {
            (None, _) => None,
            (Some(_), Some(found)) => found,
            (Some(_), None) => {
                let ids: Vec<&str> = group.threads.iter().map(|t| text(t, "id")).collect();
                self.branches.fail(&ids);
                return;
            }
        };
        if group.branch().is_some() {
            self.branches.record(&group.key, now, detected.is_some());
        }
        let target = BranchProject {
            id: group.project_id(),
            workspace_root: &root,
            repository: &github.repository,
        };
        let checked_out = match (&detected, group.branch()) {
            (Some(found), Some(branch))
                if link_sync::needs_checkout_check(&group, &target, Some(found)) =>
            {
                conn_vcs::repo::config_get(
                    Path::new(&cwd),
                    &format!("branch.{branch}.t3-pull-request"),
                )
                .await
                .ok()
                .flatten()
                .is_some_and(|url| url == text(found, "url"))
            }
            _ => false,
        };
        let mut previous = Map::new();
        for saved in link_sync::previous_to_check(&group, &target, detected.as_ref(), checked_out) {
            let reference = json!({"projectId": saved["projectId"], "host": github.host,
                "repository": saved["repository"], "number": saved["number"]});
            if let Ok((project, client, lookup)) =
                self.panel.reference_client("summary", &reference).await
                && let Ok(summary) = self
                    .panel
                    .load_read("summary", &reference, &project, &client, &lookup)
                    .await
            {
                previous.insert(text(&saved, "url").to_owned(), summary);
            }
        }
        let plan = link_sync::plan_branch(
            &group,
            &target,
            detected.as_ref(),
            checked_out,
            &previous,
            sequence,
            &mut conn_support::uuid_v4,
        );
        // A thread leaves the start-up backfill only once its write lands: a refused write
        // (the stale-write guard) is looked up again.
        self.branches.finish(&group, &plan.failed, &plan.writing());
        for command in plan.commands {
            let thread_id = text(&command, "threadId").to_owned();
            if self.dispatch(command).await.is_ok() {
                self.branches.written(&thread_id);
            } else {
                self.branches.fail(&[&thread_id]);
            }
        }
    }
}

pub(super) fn take_settles(settles: &Settles, links: &mut LinkSync) {
    for key in settles.take() {
        links.request(key);
    }
}

/// A branch group ready for its GitHub lookup.
struct Prepared {
    group: BranchGroup,
    root: String,
    cwd: String,
    github: Project,
    head: Option<HeadQuery>,
    /// `None`: not looked up, or GitHub failed. `Some(found)`: GitHub answered.
    found: Option<Option<Value>>,
}

pub(super) struct HeadQuery {
    pub(super) head: BranchHead,
    pub(super) default_branch: Option<String>,
}

/// `resolveBranchHeadContext` for a published remote: the head is `name` in that remote's
/// repository, or in the project's when there is no remote. A remote that is not a GitHub
/// repository leaves the head's identity unknown.
fn head_context(
    project: &Project,
    branch: &str,
    name: &str,
    remote_url: Option<&str>,
    has_remote: bool,
) -> BranchHead {
    let repository = match (has_remote, remote_url) {
        (false, _) => project.repository.clone(),
        (true, Some(url)) => registry::git_remote_repository(url)
            .map(|(_, repository)| repository)
            .unwrap_or_default(),
        (true, None) => String::new(),
    };
    let cross_repository =
        !repository.is_empty() && !repository.eq_ignore_ascii_case(&project.repository);
    BranchHead {
        branch: branch.to_owned(),
        name: name.to_owned(),
        repository,
        cross_repository,
    }
}

/// `isPullRequestWorktreeLocalBranchName`: `t3code/pr-<n>/…` or `t3code-pr-<n>-…`.
fn is_pull_request_branch(branch: &str) -> bool {
    let Some(rest) = branch.strip_prefix("t3code") else {
        return false;
    };
    let Some(rest) = rest
        .strip_prefix(['/', '-'])
        .and_then(|r| r.strip_prefix("pr-"))
    else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0 && rest[digits..].starts_with(['/', '-'])
}

/// `resolveLookupHeadContext`: where the branch's pull request head lives, or `None` when the
/// branch has nothing published to look up.
///
/// - A branch with an upstream pushes to that remote's branch (`branch.<b>.remote`,
///   `branch.<b>.merge`), as Conn's checkout of someone's pull request sets it up.
/// - A branch without one that was pushed (`git push fork feature`) is looked up in the remote
///   that has its commit (`refs/remotes/<remote>/<b>`).
/// - An upstream that is the branch's base (`git checkout -b feature origin/main`) is not its
///   head: the branch's own name on the remote that has it is, and with none there is nothing.
///
/// The default branch is `origin`'s, else the first remote's.
pub(super) async fn head_of(project: &Project, cwd: &Path, branch: &str) -> Option<HeadQuery> {
    let config = |key: String| async move {
        conn_vcs::repo::config_get(cwd, &key)
            .await
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    };
    let context = |remote: Option<String>, name: String| async move {
        let url = match &remote {
            Some(remote) => config(format!("remote.{remote}.url")).await,
            None => None,
        };
        (
            head_context(project, branch, &name, url.as_deref(), remote.is_some()),
            remote,
        )
    };
    let default_branch = conn_vcs::repo::Remotes::load(cwd)
        .await
        .ok()
        .and_then(|remotes| remotes.primary_default);
    let branch_remote = config(format!("branch.{branch}.remote")).await;
    let merge = config(format!("branch.{branch}.merge")).await;
    let has_upstream = branch_remote.is_some() && merge.is_some();
    let remote = branch_remote.clone().filter(|r| r != ".");
    let name = match (&remote, &merge) {
        (Some(_), Some(merge)) => merge
            .strip_prefix("refs/heads/")
            .unwrap_or(merge)
            .to_owned(),
        _ => branch.to_owned(),
    };
    let found = |head: BranchHead| {
        Some(HeadQuery {
            head,
            default_branch: default_branch.clone(),
        })
    };
    let (head, remote) = context(remote, name.clone()).await;
    if !has_upstream {
        let published = conn_vcs::repo::published_branch_remote(cwd, branch)
            .await
            .ok()
            .flatten();
        if let Some(published) = published
            && Some(&published) != remote.as_ref()
        {
            let (head, _) = context(Some(published), branch.to_owned()).await;
            return found(head);
        }
    }
    let tracks_fork_head = head.cross_repository
        && (remote.as_deref() != Some("origin") || is_pull_request_branch(branch));
    if name == branch || tracks_fork_head {
        return found(head);
    }
    let base = match config(format!("branch.{branch}.t3-merge-base")).await {
        Some(base) => Some(base),
        None => config(format!("branch.{branch}.gh-merge-base")).await,
    };
    let upstream_is_base = Some(&name) == default_branch.as_ref()
        || (default_branch.is_none() && (name == "main" || name == "master"))
        || Some(&name) == base.as_ref();
    if !upstream_is_base {
        return found(head);
    }
    let tracking = conn_vcs::repo::remote_tracking_remote(cwd, branch, remote.as_deref())
        .await
        .ok()
        .flatten()?;
    let (head, _) = context(Some(tracking), branch.to_owned()).await;
    found(head)
}

async fn exists(path: std::path::PathBuf) -> bool {
    tokio::task::spawn_blocking(move || path.exists())
        .await
        .unwrap_or(true)
}
