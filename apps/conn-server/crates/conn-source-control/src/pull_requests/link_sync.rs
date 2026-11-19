//! What the server's pull request sweeps decide, as T3 decides it. No I/O here: the server
//! (`conn-server/src/methods/pull_requests/links.rs`) reads GitHub and dispatches the commands.
//!
//! - [`LinkSync`]: T3's `PullRequestSyncReactor` (`orchestration-v2/PullRequestSyncReactor.ts`).
//!   Each linked pull request is read on its cadence and its link gets the snapshot (title,
//!   state, checks, review state) and stack the host gave, through
//!   `thread.pull-request-link.sync`. New stack layers are linked with `source: "stack"`.
//! - [`BranchSync`] and [`plan_branch`]: T3's `ThreadPullRequestService`. A thread's branch is
//!   looked up on GitHub and the thread gets `thread.pull-request.sync` with its pull request.
//!
//! Not here (README, "Pull request link sync"): T3's sibling stack retries across groups, its
//! per-host pauses until a rate limit's reset time (GitHub's answer here carries no reset
//! time, so a limited read backs off as T3 does without one), the replacement of an older
//! single `linkedPullRequest`, and the start-up backfill of settled threads.

use crate::registry::{
    self, ChangeRequestUrlInput,
    thread_keys::{KeySource, ThreadPullRequestKey, normalize_thread_pull_request_key},
};
use conn_support::time::millis_from_iso;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

/// T3 sweeps every minute (`Schedule.spaced("1 minute")`), links and branches alike.
pub const SWEEP_MS: u64 = 60_000;
const SLOW_SYNC_INTERVAL_MS: f64 = 15.0 * 60_000.0;
/// `QUIET_AFTER_MS`: an open pull request nobody updated for this long is read less often.
const QUIET_AFTER_MS: f64 = 30.0 * 60_000.0;
const QUIET_SYNC_INTERVAL_MS: f64 = 5.0 * 60_000.0;
/// `CLOSED_FINAL_AFTER_MS`.
const CLOSED_FINAL_AFTER_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// `FAILED_READ_BACKOFF_MS`: a failed read waits a sweep, then twice as long each time.
const FAILED_READ_BACKOFF_MS: f64 = 60_000.0;
/// Requested pull requests waiting for the next sweep. T3's set has no bound; past this, a
/// request waits for the periodic sweep.
const MAX_PENDING: usize = 1024;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `Date.parse`: NaN when absent or unreadable, so every comparison with it is false.
fn parse(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_str)
        .and_then(millis_from_iso)
        .map_or(f64::NAN, |ms| ms as f64)
}

/// `normalizeThreadPullRequestKey` of a link or command.
pub fn key_of(value: &Value) -> ThreadPullRequestKey {
    normalize_thread_pull_request_key(KeySource {
        host: text(value, "host"),
        repository: text(value, "repository"),
        number: value.get("number").and_then(Value::as_u64).unwrap_or(0),
        authority: value.get("authority").and_then(Value::as_str),
        url: value.get("url").and_then(Value::as_str),
    })
}

/// `threadPullRequestKeyOf`.
pub fn pull_request_key(link: &Value) -> String {
    key_of(link).text()
}

fn is_unsettled(thread: &Value) -> bool {
    thread["settledOverride"] != "settled" && thread["settledAt"].is_null()
}

/// `visibleThreadPullRequests`: links that were not dismissed from a stack.
pub fn visible_links(thread: &Value) -> impl Iterator<Item = &Value> {
    thread["pullRequests"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|link| link["source"] != "stack-dismissed")
}

// ---- Snapshots ---------------------------------------------------------------------------

/// `snapshotFieldsOf`: a summary's snapshot fields, without `syncedAt`. A summary field that
/// is absent (or null where the snapshot takes no null) stays absent.
pub fn snapshot_fields(summary: &Value) -> Value {
    let mut fields = json!({
        "state": summary["state"],
        "title": summary["title"],
        "headBranch": summary["headBranch"],
        "baseBranch": summary["baseBranch"],
        "isDraft": summary["isDraft"].as_bool().unwrap_or(false),
        "updatedAt": summary.get("updatedAt").cloned().unwrap_or(Value::Null),
        "closedAt": summary.get("closedAt").cloned().unwrap_or(Value::Null),
        "mergedAt": summary.get("mergedAt").cloned().unwrap_or(Value::Null),
    });
    let Some(map) = fields.as_object_mut() else {
        return fields;
    };
    for key in ["author", "reviewDecision", "checksState"] {
        if let Some(value) = summary.get(key) {
            map.insert(key.into(), value.clone());
        }
    }
    for key in [
        "additions",
        "deletions",
        "changedFiles",
        "mergeability",
        "rebaseRequired",
    ] {
        if let Some(value) = summary.get(key).filter(|v| !v.is_null()) {
            map.insert(key.into(), value.clone());
        }
    }
    fields
}

/// `withKnownMergeability`: GitHub briefly answers `unknown` after a base push, so an open
/// pull request whose `updatedAt` did not move keeps the mergeability it had.
pub fn with_known_mergeability(previous: &Value, fields: Value) -> Value {
    if fields["state"] != "open"
        || fields["mergeability"] != "unknown"
        || previous.get("updatedAt") != fields.get("updatedAt")
        || previous.is_null()
    {
        return fields;
    }
    let known = (previous["state"] == "open")
        .then(|| previous.get("mergeability"))
        .flatten();
    match known {
        Some(known) if known != "unknown" => {
            let mut fields = fields;
            fields["mergeability"] = known.clone();
            fields
        }
        _ => fields,
    }
}

/// `avatarIdentity`: rotating ghe.com avatar tokens do not make snapshots differ.
fn avatar_identity(avatar: Option<&Value>) -> Option<String> {
    let avatar = avatar.and_then(Value::as_str)?;
    let Ok(mut url) = url::Url::parse(avatar) else {
        return Some(avatar.to_owned());
    };
    let host = url.host_str().unwrap_or_default().to_owned();
    if host != "ghe.com" && !host.ends_with(".ghe.com") {
        return Some(avatar.to_owned());
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "token")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    Some(url.to_string())
}

/// `snapshotFieldsEqual`.
pub fn fields_equal(left: &Value, right: &Value) -> bool {
    let same = |key: &str| left.get(key) == right.get(key);
    let same_or_null =
        |key: &str| left.get(key).unwrap_or(&Value::Null) == right.get(key).unwrap_or(&Value::Null);
    let login = |v: &Value| v["author"]["login"].clone();
    [
        "state",
        "title",
        "headBranch",
        "baseBranch",
        "isDraft",
        "updatedAt",
        "additions",
        "deletions",
        "changedFiles",
        "mergeability",
        "rebaseRequired",
    ]
    .iter()
    .all(|key| same(key))
        && ["closedAt", "mergedAt", "reviewDecision", "checksState"]
            .iter()
            .all(|key| same_or_null(key))
        && login(left) == login(right)
        && avatar_identity(left["author"].get("avatarUrl"))
            == avatar_identity(right["author"].get("avatarUrl"))
}

/// `stacksEqual`.
pub fn stacks_equal(left: &Value, right: &Value) -> bool {
    if left.is_null() || right.is_null() {
        return left.is_null() && right.is_null();
    }
    let layers = |v: &Value| -> Vec<(Value, Value, Value)> {
        v["layers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| {
                (
                    l["number"].clone(),
                    l["headBranch"].clone(),
                    l["state"].clone(),
                )
            })
            .collect()
    };
    ["kind", "id", "number", "url", "base"]
        .iter()
        .all(|k| left.get(k) == right.get(k))
        && layers(left) == layers(right)
}

/// A host's stack read as a link stores it: `{kind: "native", ...stack}`, layers cut to the
/// fields a link keeps.
pub fn native_stack(stack: &Value) -> Value {
    if !stack.is_object() {
        return Value::Null;
    }
    let layers: Vec<Value> = stack["layers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| json!({"number": l["number"], "headBranch": l["headBranch"], "state": l["state"]}))
        .collect();
    json!({"kind": "native", "id": stack["id"], "number": stack["number"], "url": stack["url"],
        "base": stack["base"], "layers": layers})
}

/// `siblingChangeRequestUrl`: another layer of the stack `url` belongs to.
fn sibling_url(url: &str, number: u64) -> Option<String> {
    if number < 1 {
        return None;
    }
    let (kind, parsed) = registry::parse_change_request_url(url)?;
    kind.change_request_url(ChangeRequestUrlInput {
        host: &parsed.link.host,
        repository: &parsed.link.repository,
        number,
        remote_url: None,
        web_url: Some(&parsed.repository_url),
    })
}

// ---- The link sweep ----------------------------------------------------------------------

/// One linked pull request in one thread.
#[derive(Clone, Debug)]
pub struct Entry {
    pub thread: Value,
    pub link: Value,
}

/// The links of one pull request in one project: one host read serves them all.
#[derive(Clone, Debug)]
pub struct Group {
    pub key: String,
    pub entries: Vec<Entry>,
}

impl Group {
    fn first(&self) -> Option<&Entry> {
        self.entries.first()
    }
    /// `referenceOf`: what the panel reads (`{projectId, host, repository, number}`).
    pub fn reference(&self) -> Value {
        let Some(first) = self.first() else {
            return Value::Null;
        };
        json!({"projectId": first.thread["projectId"], "host": key_of(&first.link).host,
            "repository": first.link["repository"], "number": first.link["number"]})
    }
}

/// Which links a sweep reads: all due ones, or only the requested ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    All,
    Requested,
}

/// Why a summary read failed, as the sweep tells failures apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    /// Not found, or a host this server cannot read (no CLI, signed out): the slow cadence.
    Missing,
    /// Anything else, rate limits included: a backoff.
    Failed,
}

/// What a group needs after its summary read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StackNeed {
    /// The stored stacks stay.
    Keep,
    /// The summary says there is no stack, and no link has one.
    Unstacked,
    /// Read the stack.
    Read,
}

/// The stack read's outcome, for [`LinkSync::finish`].
#[derive(Clone, Debug, PartialEq)]
pub enum StackRead {
    /// Not read ([`StackNeed::Keep`]).
    Kept,
    /// The stack, or `Value::Null` for none.
    Read(Value),
    /// The read failed: the group waits for the next sweep and reads its stack again.
    Failed,
    /// The read hit a rate limit: as [`StackRead::Failed`], and the group backs off.
    Limited,
}

/// T3's `PullRequestSyncReactor` state. Every map is pruned to the current links on every
/// sweep; pending requests are bounded by [`MAX_PENDING`].
#[derive(Debug, Default)]
pub struct LinkSync {
    last_synced: HashMap<String, f64>,
    requested: HashSet<String>,
    pending: HashSet<String>,
    retry_stacks: HashSet<String>,
    failed: HashMap<String, (f64, f64)>,
    missing: HashSet<String>,
    linked_this_sweep: HashSet<String>,
    /// This sweep's groups as stacks see them: key, project, and each link's native stack key
    /// and layer numbers. Cleared at the start of every sweep.
    sweep_stacks: Vec<SweepStacks>,
    /// `stacksReadThisSweep`: the stacks the host answered this sweep, by group.
    stacks_read: HashMap<String, Value>,
}

#[derive(Debug)]
struct SweepStacks {
    key: String,
    project_id: String,
    /// Per link: its host and repository, and its stored stack.
    links: Vec<(ThreadPullRequestKey, Value)>,
}

/// `nativeStackKeyOf`: stack ids are unique only within a repository.
fn native_stack_key(link: &ThreadPullRequestKey, stack: &Value) -> String {
    let id = match &stack["id"] {
        Value::String(id) => id.clone(),
        other => other.to_string(),
    };
    format!("{}/{}#stack:{id}", link.host, link.repository)
}

/// `sameLayerNumbers`.
fn same_layer_numbers(left: &Value, right: &Value) -> bool {
    let numbers = |v: &Value| -> Vec<Value> {
        v["layers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|l| l["number"].clone())
            .collect()
    };
    numbers(left) == numbers(right)
}

fn group_key(project_id: &str, pr_key: &str) -> String {
    format!("{project_id}\0{pr_key}")
}

impl LinkSync {
    /// `requestSync`: the pull request is read on the next requested sweep, even when final.
    pub fn request(&mut self, pr_key: String) {
        if self.pending.len() < MAX_PENDING {
            self.pending.insert(pr_key);
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// `requestUnsyncedLinks`: a link without a snapshot is read at once, unless its project's
    /// host could not find it (then the slow cadence reads it).
    pub fn request_unsynced(&mut self, project_id: &str, link: &Value) {
        let pr_key = pull_request_key(link);
        if link["snapshot"].is_null() && !self.missing.contains(&group_key(project_id, &pr_key)) {
            self.request(pr_key);
        }
    }

    /// Starts a sweep (`sweep`): groups the links, takes in the requests, prunes the state,
    /// and returns the groups in scope that are due.
    pub fn begin(&mut self, threads: &[Value], scope: Scope, now: f64) -> Vec<Group> {
        let mut groups: Vec<Group> = Vec::new();
        let mut index: HashMap<String, usize> = HashMap::new();
        for thread in threads {
            for link in visible_links(thread) {
                let key = group_key(text(thread, "projectId"), &pull_request_key(link));
                let entry = Entry {
                    thread: thread.clone(),
                    link: link.clone(),
                };
                match index.get(&key).and_then(|i| groups.get_mut(*i)) {
                    Some(group) => group.entries.push(entry),
                    None => {
                        index.insert(key.clone(), groups.len());
                        groups.push(Group {
                            key,
                            entries: vec![entry],
                        });
                    }
                }
            }
        }
        for group in &groups {
            let Some(first) = group.first() else { continue };
            if !self.pending.contains(&pull_request_key(&first.link)) {
                continue;
            }
            self.requested.insert(group.key.clone());
            // A new request reads at once; a failure after it backs off further.
            if let Some(failed) = self.failed.get_mut(&group.key) {
                failed.0 = now;
            }
        }
        self.pending.clear();
        let live: HashSet<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        self.last_synced.retain(|k, _| live.contains(k.as_str()));
        self.retry_stacks.retain(|k| live.contains(k.as_str()));
        self.failed.retain(|k, _| live.contains(k.as_str()));
        self.missing.retain(|k| live.contains(k.as_str()));
        self.requested.retain(|k| live.contains(k.as_str()));
        self.linked_this_sweep.clear();
        self.stacks_read.clear();
        self.sweep_stacks = groups
            .iter()
            .map(|g| SweepStacks {
                key: g.key.clone(),
                project_id: g
                    .first()
                    .map(|e| text(&e.thread, "projectId").to_owned())
                    .unwrap_or_default(),
                links: g
                    .entries
                    .iter()
                    .map(|e| (key_of(&e.link), e.link["stack"].clone()))
                    .collect(),
            })
            .collect();
        groups
            .into_iter()
            .filter(|g| scope == Scope::All || self.requested.contains(&g.key))
            .filter(|g| self.is_due(g, now))
            .collect()
    }

    /// `isDue`.
    pub fn is_due(&self, group: &Group, now: f64) -> bool {
        let key = &group.key;
        if self
            .failed
            .get(key)
            .is_some_and(|(retry_at, _)| *retry_at > now)
        {
            return false;
        }
        if self.requested.contains(key) {
            return true;
        }
        let active: Vec<&Entry> = group
            .entries
            .iter()
            .filter(|e| is_unsettled(&e.thread))
            .collect();
        if active.is_empty() {
            return false;
        }
        let since = self
            .last_synced
            .get(key)
            .map_or(f64::INFINITY, |last| now - last);
        if self.missing.contains(key) {
            return since >= SLOW_SYNC_INTERVAL_MS;
        }
        if self.retry_stacks.contains(key) || active.iter().any(|e| e.link["snapshot"].is_null()) {
            return true;
        }
        let is_final = |e: &&Entry| {
            let snapshot = &e.link["snapshot"];
            match snapshot["state"].as_str() {
                Some("merged") => !snapshot["mergedAt"].is_null(),
                Some("closed") => now - parse(snapshot.get("closedAt")) >= CLOSED_FINAL_AFTER_MS,
                _ => false,
            }
        };
        if active.iter().all(is_final) {
            return false;
        }
        let open: Vec<&&Entry> = active
            .iter()
            .filter(|e| e.link["snapshot"]["state"] == "open")
            .collect();
        if !open.is_empty() {
            let quiet = open
                .iter()
                .all(|e| now - parse(e.link["snapshot"].get("updatedAt")) >= QUIET_AFTER_MS);
            return !quiet || since >= QUIET_SYNC_INTERVAL_MS;
        }
        since >= SLOW_SYNC_INTERVAL_MS
    }

    /// Whether the read must skip the panel's cache: a requested refresh, a merged snapshot
    /// still without its merge time, or a stack retry.
    pub fn invalidates(&self, group: &Group) -> bool {
        self.requested.contains(&group.key)
            || self.retry_stacks.contains(&group.key)
            || group.entries.iter().any(|e| {
                e.link["snapshot"]["state"] == "merged" && e.link["snapshot"]["mergedAt"].is_null()
            })
    }

    /// The summary read failed.
    pub fn read_failed(&mut self, group: &Group, failure: ReadFailure, now: f64) {
        if failure == ReadFailure::Missing {
            self.missing.insert(group.key.clone());
            self.last_synced.insert(group.key.clone(), now);
            self.requested.remove(&group.key);
        }
        self.back_off(&group.key, now);
    }

    fn back_off(&mut self, key: &str, now: f64) {
        let backoff = match self.failed.get(key) {
            None => FAILED_READ_BACKOFF_MS,
            Some((_, previous)) => (previous * 2.0).min(SLOW_SYNC_INTERVAL_MS),
        };
        self.failed.insert(key.to_owned(), (now + backoff, backoff));
    }

    /// After the summary read: whether the stack must be read (`needsStack`, `knownUnstacked`).
    pub fn stack_need(&mut self, group: &Group, summary: &Value) -> StackNeed {
        self.missing.remove(&group.key);
        let fields = snapshot_fields(summary);
        let summary_stack = summary.get("stack");
        let needs = self.requested.contains(&group.key)
            || self.retry_stacks.contains(&group.key)
            || group.entries.iter().any(|e| {
                let snapshot = &e.link["snapshot"];
                snapshot.is_null()
                    || !fields_equal(snapshot, &with_known_mergeability(snapshot, fields.clone()))
                    || summary_stack.is_some_and(|stack| {
                        e.link["stack"]["number"]
                            != stack.get("number").cloned().unwrap_or_default()
                    })
            });
        if !needs {
            return StackNeed::Keep;
        }
        // The retry this read answers is consumed before the read.
        self.retry_stacks.remove(&group.key);
        let unstacked = summary_stack.is_some_and(Value::is_null)
            && group.entries.iter().all(|e| e.link["stack"].is_null());
        if unstacked {
            StackNeed::Unstacked
        } else {
            StackNeed::Read
        }
    }

    /// The commands for a group after its reads (`syncGroup`, `syncEntry`): sibling links for
    /// new stack layers, then a sync for each link whose snapshot or stack changed.
    pub fn finish(
        &mut self,
        group: &Group,
        summary: &Value,
        stack: StackRead,
        now: f64,
        now_iso: &str,
        uuid: &mut dyn FnMut() -> String,
    ) -> Vec<Value> {
        let fetched = match stack {
            StackRead::Kept => None,
            StackRead::Read(stack) => Some(stack),
            StackRead::Failed => {
                self.retry_stacks.insert(group.key.clone());
                return Vec::new();
            }
            StackRead::Limited => {
                self.retry_stacks.insert(group.key.clone());
                self.back_off(&group.key, now);
                return Vec::new();
            }
        };
        if let Some(fetched) = &fetched {
            self.flag_stale_siblings(group, fetched);
        }
        self.last_synced.insert(group.key.clone(), now);
        self.failed.remove(&group.key);
        self.requested.remove(&group.key);
        let host_fields = snapshot_fields(summary);
        let mut commands = Vec::new();
        for Entry { thread, link } in &group.entries {
            let thread_id = text(thread, "id");
            let key = key_of(link);
            let fields = with_known_mergeability(&link["snapshot"], host_fields.clone());
            let next_stack = fetched.clone().unwrap_or_else(|| link["stack"].clone());
            let changed = link["snapshot"].is_null()
                || !fields_equal(&link["snapshot"], &fields)
                || !stacks_equal(&link["stack"], &next_stack);
            if is_unsettled(thread) {
                for layer in fetched
                    .as_ref()
                    .and_then(|s| s["layers"].as_array())
                    .into_iter()
                    .flatten()
                {
                    let number = layer["number"].as_u64().unwrap_or(0);
                    let layer_key = ThreadPullRequestKey {
                        host: key.host.clone(),
                        repository: text(link, "repository").to_owned(),
                        number,
                    };
                    let layer_link = json!({"host": layer_key.host,
                        "repository": layer_key.repository, "number": number});
                    let dedupe = format!("{thread_id}:{}", pull_request_key(&layer_link));
                    // Tombstones count as present: a dismissed layer is never added again.
                    let present = thread["pullRequests"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|existing| key_of(existing) == key_of(&layer_link));
                    if self.linked_this_sweep.contains(&dedupe) || present {
                        continue;
                    }
                    let Some(url) = sibling_url(text(link, "url"), number) else {
                        continue;
                    };
                    commands.push(json!({
                        "type": "thread.pull-request.link",
                        "commandId": format!("server:pr-stack-link:{thread_id}:{}", uuid()),
                        "threadId": thread_id,
                        "host": layer_key.host,
                        "repository": layer_key.repository,
                        "number": number,
                        "url": url,
                        "source": "stack",
                    }));
                    self.linked_this_sweep.insert(dedupe);
                }
            }
            if changed {
                let mut snapshot = fields;
                snapshot["syncedAt"] = json!(now_iso);
                commands.push(json!({
                    "type": "thread.pull-request-link.sync",
                    "commandId": format!("server:pr-sync:{thread_id}:{}", uuid()),
                    "threadId": thread_id,
                    "host": key.host,
                    "repository": link["repository"],
                    "number": link["number"],
                    "snapshot": snapshot,
                    "stack": next_stack,
                }));
            }
        }
        commands
    }

    /// New upper layers leave older members' fields unchanged, so a member of the stack just
    /// read whose layer list differs reads its stack again on the next sweep. Only members in
    /// the same project: other credentials can see lists that never agree.
    fn flag_stale_siblings(&mut self, group: &Group, fetched: &Value) {
        self.stacks_read.insert(group.key.clone(), fetched.clone());
        let Some(first) = group.first() else { return };
        if fetched.is_null() {
            return;
        }
        let fetched_key = native_stack_key(&key_of(&first.link), fetched);
        let project_id = text(&first.thread, "projectId");
        let stale: Vec<String> = self
            .sweep_stacks
            .iter()
            .filter(|sibling| sibling.key != group.key && sibling.project_id == project_id)
            .filter(|sibling| {
                let read = self.stacks_read.get(&sibling.key);
                sibling.links.iter().any(|(link, stored)| {
                    let stack = read.unwrap_or(stored);
                    !stack.is_null()
                        && native_stack_key(link, stack) == fetched_key
                        && !same_layer_numbers(stack, fetched)
                })
            })
            .map(|sibling| sibling.key.clone())
            .collect();
        self.retry_stacks.extend(stale);
    }

    /// A dispatch failed: the group reads its stack again next sweep (`syncGroup`'s catch).
    pub fn dispatch_failed(&mut self, group: &Group) {
        self.retry_stacks.insert(group.key.clone());
    }
}

/// `refreshUnmergedLinks`: the links of a thread whose snapshot is open or closed, read once
/// when the thread settles.
pub fn unmerged_links(thread: &Value) -> Vec<String> {
    visible_links(thread)
        .filter(|l| matches!(l["snapshot"]["state"].as_str(), Some("open" | "closed")))
        .map(pull_request_key)
        .collect()
}

// ---- The branch lookup ---------------------------------------------------------------------

const RECHECK_MIN_MS: f64 = 30.0 * 60_000.0;
const RECHECK_MAX_MS: f64 = 24.0 * 60.0 * 60_000.0;
const RECHECK_IDLE_DIVISOR: f64 = 12.0;
const RECHECKS_PER_SWEEP: usize = 4;

/// The threads of one branch in one checkout: one lookup serves them all.
#[derive(Clone, Debug)]
pub struct BranchGroup {
    pub key: String,
    pub threads: Vec<Value>,
}

impl BranchGroup {
    fn first(&self) -> &Value {
        self.threads.first().unwrap_or(&Value::Null)
    }
    pub fn project_id(&self) -> &str {
        text(self.first(), "projectId")
    }
    pub fn branch(&self) -> Option<&str> {
        self.first()["branch"].as_str()
    }
    pub fn worktree_path(&self) -> Option<&str> {
        self.first()["worktreePath"].as_str()
    }
}

/// T3's `noPullRequestRechecks` and the group selection of `synchronize`. Pruned to the
/// current branches on every sweep.
#[derive(Debug, Default)]
pub struct BranchSync {
    reads: HashMap<String, (f64, bool)>,
    /// `pendingBackfill`: settled threads with no branch pull request, looked up by the
    /// sweeps after start until one lookup answers, at most [`BACKFILL_ATTEMPTS`] times.
    backfill: HashMap<String, u8>,
}

const BACKFILL_ATTEMPTS: u8 = 5;

fn has(thread: &Value, key: &str) -> bool {
    thread.get(key).is_some_and(|v| !v.is_null())
}

impl BranchSync {
    /// The start-up backfill (`backfill: true`): settled threads with no branch pull request
    /// join the next sweeps.
    pub fn start_backfill(&mut self, threads: &[Value]) {
        for t in threads {
            let settled = !is_unsettled(t);
            if settled
                && !has(t, "branchPullRequest")
                && t["lineage"]["relationshipToParent"] != "subagent"
            {
                self.backfill
                    .insert(text(t, "id").to_owned(), BACKFILL_ATTEMPTS);
            }
        }
    }

    /// `finishBackfill`: the group's lookup answered. `failed` threads lose one attempt;
    /// threads in `writing` stay until their write lands ([`Self::written`]) or fails
    /// ([`Self::fail`]), as T3 deletes a thread's entry only after its dispatch.
    pub fn finish(&mut self, group: &BranchGroup, failed: &[String], writing: &[&str]) {
        for t in &group.threads {
            let id = text(t, "id");
            if !failed.iter().any(|f| f == id) && !writing.contains(&id) {
                self.backfill.remove(id);
            }
        }
        let ids: Vec<&str> = failed.iter().map(String::as_str).collect();
        self.fail(&ids);
    }

    /// A thread's `thread.pull-request.sync` was accepted: it leaves the backfill.
    pub fn written(&mut self, thread_id: &str) {
        self.backfill.remove(thread_id);
    }

    /// Whether the thread still waits in the start-up backfill.
    pub fn backfilling(&self, thread_id: &str) -> bool {
        self.backfill.contains_key(thread_id)
    }

    /// `failBackfill`: a lookup or a write failed; the thread has one attempt less.
    pub fn fail(&mut self, thread_ids: &[&str]) {
        for id in thread_ids {
            if let Some(left) = self.backfill.get_mut(*id) {
                if *left <= 1 {
                    self.backfill.remove(*id);
                } else {
                    *left -= 1;
                }
            }
        }
    }

    /// The branch groups to look up now. `thread`: one thread's own event (it reads at once,
    /// settled or not); `None`: the minute sweep over unsettled threads, which skips subagents
    /// and reads few branches that had no pull request.
    pub fn groups(
        &mut self,
        threads: &[Value],
        thread: Option<&str>,
        now: f64,
    ) -> Vec<BranchGroup> {
        let mut groups: Vec<BranchGroup> = Vec::new();
        let swept = |t: &&Value| match thread {
            Some(id) => text(t, "id") == id,
            None => t["lineage"]["relationshipToParent"] != "subagent",
        };
        // A pending thread that has no branch any more leaves the backfill.
        let checked: Vec<String> = match thread {
            Some(id) => vec![id.to_owned()],
            None => self.backfill.keys().cloned().collect(),
        };
        for id in checked {
            let visible = threads
                .iter()
                .filter(swept)
                .any(|t| text(t, "id") == id && has(t, "branch"));
            if !visible {
                self.backfill.remove(&id);
            }
        }
        for t in threads.iter().filter(swept) {
            let eligible =
                thread.is_some() || is_unsettled(t) || self.backfill.contains_key(text(t, "id"));
            if !eligible
                || !t["archivedAt"].is_null()
                || !(has(t, "branch") || has(t, "branchPullRequest"))
            {
                continue;
            }
            let key = json!([t["projectId"], t["worktreePath"], t["branch"]]).to_string();
            match groups.iter_mut().find(|g| g.key == key) {
                Some(group) => group.threads.push(t.clone()),
                None => groups.push(BranchGroup {
                    key,
                    threads: vec![t.clone()],
                }),
            }
        }
        if thread.is_some() {
            return groups;
        }
        let scheduled: Vec<(String, f64)> = groups
            .iter()
            .filter(|g| {
                g.branch().is_some()
                    && g.threads.iter().all(|t| {
                        !has(t, "branchPullRequest") && !self.backfill.contains_key(text(t, "id"))
                    })
            })
            .map(|g| {
                let activity = g
                    .threads
                    .iter()
                    .map(|t| parse(t.get("updatedAt")))
                    .fold(f64::NEG_INFINITY, f64::max);
                (g.key.clone(), activity)
            })
            .collect();
        let selected = self.select(now, &scheduled);
        let live: HashSet<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        self.reads.retain(|k, _| live.contains(k.as_str()));
        groups
            .into_iter()
            .filter(|g| !scheduled.iter().any(|(k, _)| *k == g.key) || selected.contains(&g.key))
            .collect()
    }

    /// `noPullRequestRechecks.select`.
    fn select(&mut self, now: f64, branches: &[(String, f64)]) -> HashSet<String> {
        let mut selected = HashSet::new();
        let mut due: Vec<(&str, f64, f64)> = Vec::new();
        for (key, activity) in branches {
            let read = self.reads.get(key);
            if read.is_some_and(|(_, found)| *found) {
                selected.insert(key.clone());
                continue;
            }
            let delay =
                ((now - activity) / RECHECK_IDLE_DIVISOR).clamp(RECHECK_MIN_MS, RECHECK_MAX_MS);
            if let Some((read_at, _)) = read
                && now - read_at < delay
            {
                continue;
            }
            due.push((
                key,
                *activity,
                read.map_or(f64::NEG_INFINITY, |(at, _)| *at),
            ));
        }
        due.sort_by(|a, b| {
            if a.2 == b.2 {
                b.1.total_cmp(&a.1)
            } else {
                a.2.total_cmp(&b.2)
            }
        });
        for (key, _, _) in due.into_iter().take(RECHECKS_PER_SWEEP) {
            selected.insert(key.to_owned());
            self.reads.insert(key.to_owned(), (now, false));
        }
        selected
    }

    /// `noPullRequestRechecks.record`.
    pub fn record(&mut self, key: &str, now: f64, found: bool) {
        self.reads.insert(key.to_owned(), (now, found));
    }
}

/// A branch's head as GitHub knows it (`BranchHeadContext`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchHead {
    /// The local branch.
    pub branch: String,
    /// The published head name: the upstream's branch, else the local name.
    pub name: String,
    /// `owner/name` of the repository the head lives in: the published remote's, else the
    /// project's. Empty when the remote is not a GitHub repository.
    pub repository: String,
    /// The head lives in another repository than the project's (a fork).
    pub cross_repository: bool,
}

fn lowered(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_lowercase())
}

/// `parseRepositoryOwnerLogin`: the first path segment.
fn owner_of(repository: Option<&str>) -> Option<String> {
    repository
        .and_then(|r| r.split('/').next())
        .and_then(lowered)
}

/// `matchesBranchHeadContext` on a `PullRequestsByHead` node: the head name must match, a
/// known head owner or repository must match, and a pull request from another repository
/// counts only when both sides know the head's identity (a deleted fork's does not).
pub fn matches_head(node: &Value, head: &BranchHead) -> bool {
    if text(node, "headRefName") != head.name {
        return false;
    }
    let expected_repository = lowered(&head.repository);
    let expected_owner = owner_of(expected_repository.as_deref());
    let pr_repository = node["headRepository"]["nameWithOwner"]
        .as_str()
        .and_then(lowered);
    let pr_owner = node["headRepositoryOwner"]["login"]
        .as_str()
        .and_then(lowered)
        .or_else(|| owner_of(pr_repository.as_deref()));
    if let (Some(expected), Some(actual)) = (&expected_repository, &pr_repository)
        && expected != actual
    {
        return false;
    }
    if let (Some(expected), Some(actual)) = (&expected_owner, &pr_owner)
        && expected != actual
    {
        return false;
    }
    let expected_known = expected_repository.is_some() || expected_owner.is_some();
    let pr_known = pr_repository.is_some() || pr_owner.is_some();
    let pr_cross = node["isCrossRepository"].as_bool();
    if head.cross_repository {
        return pr_cross != Some(false) && !(expected_known && !pr_known);
    }
    !(pr_cross == Some(true) && (!expected_known || !pr_known))
}

/// `findLatestPrForHeadContext` on GitHub's `PullRequestsByHead` nodes: the newest open pull
/// request of the head, else its newest one. `head` is the published head: the name the
/// branch pushes to (its upstream), which differs from the local `branch` after a checkout
/// of someone's pull request. Only pull requests that [`matches_head`] count: not a fork
/// reusing the name, nor a deleted fork's. On the default branch only an open one counts. The answer is a
/// `GitBranchPullRequest`: `{number, url, state, closedAt, mergedAt}`.
pub fn branch_pull_request(
    nodes: &[Value],
    head: &BranchHead,
    default_branch: Option<&str>,
) -> Option<Value> {
    let branch = head.branch.as_str();
    let mut candidates: Vec<Value> = nodes
        .iter()
        .filter(|node| matches_head(node, head))
        .filter_map(|node| {
            let state = match text(node, "state") {
                "OPEN" => "open",
                "CLOSED" => "closed",
                "MERGED" => "merged",
                _ => return None,
            };
            let number = node["number"].as_u64().filter(|n| *n > 0)?;
            Some(json!({"number": number, "url": node["url"], "state": state,
                "closedAt": node.get("closedAt").cloned().unwrap_or(Value::Null),
                "mergedAt": node.get("mergedAt").cloned().unwrap_or(Value::Null),
                "updatedAt": node.get("updatedAt").cloned().unwrap_or(Value::Null)}))
        })
        .collect();
    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(c["number"].as_u64()));
    candidates.sort_by(|a, b| {
        let at = |v: &Value| v["updatedAt"].as_str().and_then(millis_from_iso);
        match (at(a), at(b)) {
            (Some(x), Some(y)) => y.cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
    });
    let latest = candidates
        .iter()
        .find(|c| c["state"] == "open")
        .or_else(|| candidates.first())?
        .clone();
    let default = match default_branch {
        Some(default) => branch == default,
        None => branch == "main" || branch == "master",
    };
    (!default || latest["state"] == "open").then_some(latest)
}

/// `samePullRequest`.
fn same_pull_request(left: &Value, right: &Value) -> bool {
    if left.is_null() || right.is_null() {
        return left.is_null() && right.is_null();
    }
    left["projectId"] == right["projectId"]
        && text(left, "repository").to_lowercase() == text(right, "repository").to_lowercase()
        && left["number"] == right["number"]
        && left["url"] == right["url"]
}

/// `pullRequestPredatesThread`: it closed or merged before the thread was made.
fn predates_thread(pull_request: &Value, created_at: &Value) -> bool {
    let terminal = match pull_request["state"].as_str() {
        Some("merged") => pull_request.get("mergedAt"),
        Some("closed") => pull_request.get("closedAt"),
        _ => None,
    };
    terminal.is_some_and(|t| !t.is_null()) && parse(terminal) < parse(Some(created_at))
}

/// What a branch lookup knows about the project.
#[derive(Clone, Debug)]
pub struct BranchProject<'a> {
    pub id: &'a str,
    pub workspace_root: &'a str,
    /// `repositorySelector`: `owner/name` as the project's identity spells it.
    pub repository: &'a str,
}

/// The reference a found pull request is saved as (`detectedReference`).
pub fn detected_reference(project: &BranchProject<'_>, detected: Option<&Value>) -> Value {
    match detected {
        Some(d) => json!({"projectId": project.id, "repository": project.repository,
            "number": d["number"], "url": d["url"]}),
        None => Value::Null,
    }
}

/// Whether a found pull request closed before some thread of the group was made; then only a
/// pull request T3 checked out onto the branch stays with those threads (`dropsHistorical`).
pub fn needs_checkout_check(
    group: &BranchGroup,
    project: &BranchProject<'_>,
    detected: Option<&Value>,
) -> bool {
    let reference = detected_reference(project, detected);
    detected.is_some_and(|d| {
        group.branch().is_some()
            && group.threads.iter().any(|t| {
                predates_thread(d, &t["createdAt"])
                    && !same_pull_request(&t["branchPullRequest"], &reference)
            })
    })
}

/// The pull request a thread would save before its saved one is checked: the found one, or
/// none when it closed before the thread was made and T3 did not check it out.
fn candidate_for(
    group: &BranchGroup,
    project: &BranchProject<'_>,
    detected: Option<&Value>,
    checked_out: bool,
    thread: &Value,
) -> Value {
    let reference = detected_reference(project, detected);
    let historical = detected.is_some_and(|d| {
        predates_thread(d, &thread["createdAt"])
            && !same_pull_request(&thread["branchPullRequest"], &reference)
    });
    let drops = needs_checkout_check(group, project, detected) && !checked_out;
    if drops && historical {
        Value::Null
    } else {
        reference
    }
}

/// Whether a thread's saved pull request must be read before its branch pull request is
/// cleared: no candidate, a branch without a worktree, and a saved one.
fn checks_saved(thread: &Value, candidate: &Value) -> bool {
    candidate.is_null()
        && has(thread, "branch")
        && thread["worktreePath"].is_null()
        && has(thread, "branchPullRequest")
}

/// The saved pull requests whose summary the caller reads before [`plan_branch`]: a thread on
/// a branch without a worktree keeps a merged or closed one when the lookup found none, or
/// only one that closed before the thread was made.
pub fn previous_to_check(
    group: &BranchGroup,
    project: &BranchProject<'_>,
    detected: Option<&Value>,
    checked_out: bool,
) -> Vec<Value> {
    group
        .threads
        .iter()
        .filter(|t| checks_saved(t, &candidate_for(group, project, detected, checked_out, t)))
        .map(|t| t["branchPullRequest"].clone())
        .collect()
}

/// What a branch lookup writes, and the threads it could not decide.
#[derive(Debug, Default)]
pub struct BranchPlan {
    pub commands: Vec<Value>,
    /// Threads whose saved pull request could not be read: T3 leaves them as they are and
    /// tries again later (`failBackfill`).
    pub failed: Vec<String>,
}

impl BranchPlan {
    /// The threads a command writes.
    pub fn writing(&self) -> Vec<&str> {
        self.commands.iter().map(|c| text(c, "threadId")).collect()
    }
}

/// The `thread.pull-request.sync` commands for a group after its lookup. `checked_out`: the
/// answer of [`needs_checkout_check`]'s git read (false when not needed). `previous`: the
/// summaries read for [`previous_to_check`], by pull request URL; a missing one failed.
pub fn plan_branch(
    group: &BranchGroup,
    project: &BranchProject<'_>,
    detected: Option<&Value>,
    checked_out: bool,
    previous: &Map<String, Value>,
    snapshot_sequence: u64,
    uuid: &mut dyn FnMut() -> String,
) -> BranchPlan {
    let mut plan = BranchPlan::default();
    for thread in &group.threads {
        let thread_id = text(thread, "id");
        let mut branch_pull_request = candidate_for(group, project, detected, checked_out, thread);
        let saved = thread.get("branchPullRequest").unwrap_or(&Value::Null);
        if checks_saved(thread, &branch_pull_request) {
            let Some(summary) = previous.get(text(saved, "url")) else {
                plan.failed.push(thread_id.to_owned());
                continue;
            };
            if summary["headBranch"] == thread["branch"]
                && matches!(summary["state"].as_str(), Some("merged" | "closed"))
            {
                branch_pull_request = saved.clone();
            }
        }
        if same_pull_request(saved, &branch_pull_request) {
            continue;
        }
        plan.commands.push(json!({
            "type": "thread.pull-request.sync",
            "commandId": format!("server:thread-pull-request:{thread_id}:{}", uuid()),
            "threadId": thread_id,
            "projectId": project.id,
            "snapshotSequence": snapshot_sequence,
            "expected": {
                "workspaceRoot": project.workspace_root,
                "branch": thread["branch"],
                "worktreePath": thread["worktreePath"],
                "linkedPullRequest": thread.get("linkedPullRequest").cloned().unwrap_or(Value::Null),
                "branchPullRequest": saved,
            },
            "branchPullRequest": branch_pull_request,
        }));
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_800_000_000_000.0;

    fn summary(state: &str) -> Value {
        json!({"provider": "github", "state": state, "title": "Fix", "headBranch": "fix",
            "baseBranch": "main", "updatedAt": "2027-01-14T08:00:00.000Z", "isDraft": false,
            "checksState": "failing", "reviewDecision": "approved", "stack": null})
    }

    fn thread(links: Value) -> Value {
        json!({"id": "t", "projectId": "p", "settledOverride": null, "settledAt": null,
            "pullRequests": links})
    }

    fn link(snapshot: Value) -> Value {
        json!({"host": "github.com", "repository": "o/r", "number": 14,
            "url": "https://github.com/o/r/pull/14", "source": "manual",
            "linkedAt": "2027-01-15T08:00:00.000Z", "snapshot": snapshot, "stack": null})
    }

    #[test]
    fn a_new_link_is_read_and_synced_then_left_until_due() {
        let mut sync = LinkSync::default();
        let threads = vec![thread(json!([link(Value::Null)]))];
        let groups = sync.begin(&threads, Scope::All, NOW);
        let group = groups.first().expect("due");
        assert_eq!(
            sync.stack_need(group, &summary("open")),
            StackNeed::Unstacked
        );
        let commands = sync.finish(
            group,
            &summary("open"),
            StackRead::Read(Value::Null),
            NOW,
            "2027-01-15T09:00:00.000Z",
            &mut || "u".into(),
        );
        let [command] = commands.as_slice() else {
            panic!("one command: {commands:?}")
        };
        assert_eq!(command["type"], "thread.pull-request-link.sync");
        assert_eq!(command["snapshot"]["title"], "Fix");
        assert_eq!(command["snapshot"]["checksState"], "failing");
        assert_eq!(command["snapshot"]["syncedAt"], "2027-01-15T09:00:00.000Z");
        let synced = thread(json!([link(command["snapshot"].clone())]));
        assert!(
            sync.begin(&[synced], Scope::All, NOW + 1_000.0).is_empty(),
            "a quiet pull request read a second ago"
        );
        assert_eq!(
            sync.begin(
                &[thread(json!([link(command["snapshot"].clone())]))],
                Scope::All,
                NOW + 5.0 * 60_000.0
            )
            .len(),
            1,
            "the quiet cadence"
        );
    }

    #[test]
    fn a_missing_pull_request_waits_for_the_slow_cadence() {
        let mut sync = LinkSync::default();
        let threads = vec![thread(json!([link(Value::Null)]))];
        let group = sync.begin(&threads, Scope::All, NOW).remove(0);
        sync.read_failed(&group, ReadFailure::Missing, NOW);
        assert!(
            sync.begin(&threads, Scope::All, NOW + 2.0 * 60_000.0)
                .is_empty()
        );
        assert_eq!(
            sync.begin(&threads, Scope::All, NOW + 15.0 * 60_000.0)
                .len(),
            1
        );
    }

    #[test]
    fn the_branch_lookup_prefers_the_newest_open_pull_request() {
        let node = |n: u64, state: &str, updated: &str, head: &str| {
            json!({"number": n,
            "url": format!("https://github.com/o/r/pull/{n}"), "state": state,
            "headRefName": "fix", "updatedAt": updated, "closedAt": null, "mergedAt": null,
            "headRepository": {"nameWithOwner": head}})
        };
        let nodes = vec![
            node(3, "CLOSED", "2027-01-15T00:00:00Z", "o/r"),
            node(2, "OPEN", "2027-01-14T00:00:00Z", "o/r"),
            node(4, "OPEN", "2027-01-16T00:00:00Z", "fork/r"),
        ];
        let head = |branch: &str, name: &str, repository: &str| BranchHead {
            branch: branch.into(),
            name: name.into(),
            repository: repository.into(),
            cross_repository: !repository.eq_ignore_ascii_case("o/r"),
        };
        let found =
            branch_pull_request(&nodes, &head("fix", "fix", "O/R"), Some("main")).expect("found");
        assert_eq!(found["number"], 2);
        // A checkout of a fork's pull request: local `t3code/pr-4/fix`, published `fix`.
        let fork = head("t3code/pr-4/fix", "fix", "fork/r");
        let found = branch_pull_request(&nodes, &fork, Some("main")).expect("the fork's");
        assert_eq!(found["number"], 4);
        // On the default branch only an open pull request counts.
        let main = head("main", "fix", "o/r");
        assert_eq!(branch_pull_request(&nodes[..1], &main, Some("main")), None);
    }

    /// Codex finding 3 (T3 `matchesBranchHeadContext`): a pull request from a deleted fork
    /// (`headRepository: null`) with the same head name is not the branch's own.
    #[test]
    fn a_deleted_forks_pull_request_does_not_match_a_branch() {
        let own = BranchHead {
            branch: "feature".into(),
            name: "feature".into(),
            repository: "o/r".into(),
            cross_repository: false,
        };
        let deleted = json!({"number": 7, "url": "https://github.com/o/r/pull/7",
            "state": "OPEN", "headRefName": "feature", "updatedAt": "2027-01-15T00:00:00Z",
            "isCrossRepository": true, "headRepository": null, "headRepositoryOwner": null});
        assert!(!matches_head(&deleted, &own));
        assert_eq!(
            branch_pull_request(std::slice::from_ref(&deleted), &own, Some("main")),
            None
        );
        // Another owner's fork is not ours either, even with the repository unknown.
        let other = json!({"number": 8, "headRefName": "feature", "isCrossRepository": true,
            "headRepository": null, "headRepositoryOwner": {"login": "someone"}});
        let fork = BranchHead {
            repository: "contributor/r".into(),
            cross_repository: true,
            ..own.clone()
        };
        assert!(!matches_head(&other, &fork));
        // A fork head needs the pull request's head identity.
        assert!(!matches_head(&deleted, &fork));
        let ours = json!({"number": 9, "headRefName": "feature", "isCrossRepository": true,
            "headRepository": {"nameWithOwner": "Contributor/r"},
            "headRepositoryOwner": {"login": "contributor"}});
        assert!(matches_head(&ours, &fork));
        assert!(!matches_head(&ours, &own));
        // The project's own branch still matches without cross-repository data.
        let plain = json!({"number": 10, "headRefName": "feature",
            "headRepository": {"nameWithOwner": "o/r"}});
        assert!(matches_head(&plain, &own));
    }

    /// Codex finding 5: a settled thread in the start-up backfill whose write is refused
    /// (the stale-write guard) is looked up again by the next sweep.
    #[test]
    fn a_refused_backfill_write_is_retried() {
        let thread = json!({"id": "t1", "projectId": "p", "branch": "feature",
            "worktreePath": null, "settledAt": "2027-01-15T00:00:00.000Z",
            "archivedAt": null, "branchPullRequest": null,
            "lineage": {"relationshipToParent": null}});
        let threads = vec![thread];
        let mut sync = BranchSync::default();
        sync.start_backfill(&threads);
        let groups = sync.groups(&threads, None, NOW);
        assert_eq!(groups.len(), 1);
        let group = &groups[0];
        let command = json!({"threadId": "t1"});
        let plan = BranchPlan {
            commands: vec![command],
            failed: Vec::new(),
        };
        sync.finish(group, &plan.failed, &plan.writing());
        // The dispatch is refused.
        sync.fail(&["t1"]);
        assert!(sync.backfilling("t1"));
        let again = sync.groups(&threads, None, NOW + 60_000.0);
        assert_eq!(again.len(), 1, "the settled thread is looked up again");
        // A write that lands ends its backfill.
        sync.finish(&again[0], &[], &["t1"]);
        sync.written("t1");
        assert!(!sync.backfilling("t1"));
        assert!(sync.groups(&threads, None, NOW + 120_000.0).is_empty());
    }
}
