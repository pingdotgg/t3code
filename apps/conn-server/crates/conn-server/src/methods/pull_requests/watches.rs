//! The pull request watch loop, as T3's `PullRequestWatchReactor` runs it: every two minutes,
//! and at once for a new watch, it reads each watched pull request from GitHub through the
//! panel's client (`gh`'s login), evaluates it (`conn_source_control::pull_requests::watch`)
//! and sends the engine `thread.pull-request-watch.sync` with the new watch and at most one
//! wake per thread. Watches live on the thread's links, so they survive a restart.
//!
//! Not here (README, "Pull request watches"): GitHub's change feed and watch fingerprints
//! (T3 reads sooner after a host event and skips unchanged pull requests), the cached
//! review-thread tails, and the watch-life log lines.

use super::{Panel, ReadKey};
use conn_source_control::pull_requests::{
    normalize::{array, text},
    watch::{self, Change, Wake},
};
use conn_support::time::{millis_from_iso, now_ms};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;

/// `SWEEP_MINUTES`: checks take minutes; faster sweeps spend the account's quota.
const SWEEP: Duration = Duration::from_secs(2 * 60);
/// `READ_FAILURE_LIMIT`.
const READ_FAILURE_LIMIT: u32 = 8;
/// `QUIET_REREAD_MS`: without fingerprints, quiet pull requests are read again this often.
const QUIET_REREAD_MS: f64 = 10.0 * 60_000.0;
/// Review-thread comment pages read for one thread in one pass.
const MAX_COMMENT_PAGES: usize = 50;
/// Threads the change listener remembers, as the panel's linked-thread view does.
const MAX_OBSERVED_THREADS: usize = 2048;

fn parse(text: &str) -> f64 {
    millis_from_iso(text).map_or(f64::NAN, |ms| ms as f64)
}

/// `threadPullRequestKeyOf`.
fn pull_request_key(link: &Value) -> String {
    format!(
        "{}/{}#{}",
        text(link, "host").to_lowercase(),
        text(link, "repository").to_lowercase(),
        link.get("number").and_then(Value::as_u64).unwrap_or(0)
    )
}

#[derive(Clone, Debug)]
struct Target {
    thread: Value,
    link: Value,
    watch: Value,
}

impl Target {
    fn thread_id(&self) -> &str {
        text(&self.thread, "id")
    }
    /// `watchKey`.
    fn watch_key(&self) -> String {
        format!("{} {}", self.thread_id(), text(&self.watch, "startedAt"))
    }
    fn number(&self) -> u64 {
        self.link.get("number").and_then(Value::as_u64).unwrap_or(0)
    }
    /// `snapshotFingerprint`.
    fn snapshot_fingerprint(&self) -> String {
        let snapshot = &self.link["snapshot"];
        if snapshot.is_null() {
            return String::new();
        }
        [
            "state",
            "updatedAt",
            "checksState",
            "mergeability",
            "rebaseRequired",
            "reviewDecision",
            "isDraft",
        ]
        .iter()
        .map(|key| match snapshot.get(*key) {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
    }
}

struct Group {
    key: String,
    targets: Vec<Target>,
    fingerprint: String,
}

struct LastRead {
    at: f64,
    fingerprint: String,
    in_flight: bool,
    remarks_complete: bool,
    watches: HashSet<String>,
}

/// A wake held back so each thread gets one for everything a pass found.
struct Held {
    group_key: String,
    target: Target,
    next: Option<Value>,
    ended: Option<Value>,
    wake: Wake,
    includes_remarks: bool,
}

/// What one pass keeps between passes, pruned to the current watches on every sweep.
pub(super) struct Watcher {
    panel: Arc<Panel>,
    last_reads: HashMap<String, LastRead>,
    failures: HashMap<String, u32>,
    held: Vec<Held>,
}

/// `checksPendingBefore`: lets the engine tell that a push cleared the answer during the read.
fn identity(target: &Target) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert(
        "host".into(),
        json!(text(&target.link, "host").to_lowercase()),
    );
    map.insert("repository".into(), target.link["repository"].clone());
    map.insert("number".into(), target.link["number"].clone());
    map.insert("startedAt".into(), target.watch["startedAt"].clone());
    if let Some(pending) = target.watch.get("checksPending") {
        map.insert("checksPendingBefore".into(), pending.clone());
    }
    map
}

fn wake_json(wake: &Wake, includes_remarks: bool, message_id: &str) -> Value {
    let mut value = json!({"text": wake.text, "notification": wake.notification(),
        "messageId": message_id});
    if includes_remarks {
        value["includesRemarks"] = json!(true);
    }
    value
}

/// T3's `providerFailureReason`: the provider's reason inside a `PullRequestOperationError`.
fn failure_reason(failure: &crate::table::Failure) -> Option<String> {
    match failure {
        crate::table::Failure::Fail(value)
            if value["_tag"] == "PullRequestOperationError"
                && value["cause"]["_tag"] == "PullRequestProviderError" =>
        {
            value["cause"]["reason"].as_str().map(str::to_owned)
        }
        _ => None,
    }
}

impl Watcher {
    pub(super) fn new(panel: Arc<Panel>) -> Self {
        Self {
            panel,
            last_reads: HashMap::new(),
            failures: HashMap::new(),
            held: Vec::new(),
        }
    }

    async fn send(&self, command: Value) -> Result<(), String> {
        self.panel.engine.sync_pull_request_watch(command).await
    }

    /// `record`: the engine applies it only while the same watch is on.
    async fn record(
        &self,
        target: &Target,
        next: Option<Value>,
        wake: Option<(&Wake, bool)>,
        ended: Option<&Value>,
    ) -> Result<(), String> {
        let uuid = conn_support::uuid_v4();
        let mut command = identity(target);
        command.insert(
            "commandId".into(),
            json!(format!("server:pr-watch:{}:{uuid}", target.thread_id())),
        );
        command.insert("threadId".into(), json!(target.thread_id()));
        command.insert("watch".into(), next.unwrap_or(Value::Null));
        if let Some(ended) = ended {
            command.insert("endedWatch".into(), ended.clone());
        }
        if let Some((wake, remarks)) = wake {
            command.insert(
                "wake".into(),
                wake_json(wake, remarks, &format!("message:pr-watch:{uuid}")),
            );
        }
        self.send(Value::Object(command)).await
    }

    /// One pass over every watch, or with `changed` only that pull request's (`pass`).
    pub(super) async fn pass(&mut self, changed: Option<&str>) {
        self.held.clear();
        let Ok(shell) = self.panel.engine.shell_snapshot().await else {
            return;
        };
        let mut targets = Vec::new();
        for thread in array(shell.get("threads")) {
            for link in array(thread.get("pullRequests")) {
                let Some(watch) = link.get("watch").filter(|w| w.is_object()) else {
                    continue;
                };
                if text(link, "source") == "stack-dismissed"
                    || changed.is_some_and(|key| key != pull_request_key(link))
                {
                    continue;
                }
                targets.push(Target {
                    thread: thread.clone(),
                    link: link.clone(),
                    watch: watch.clone(),
                });
            }
        }
        let mut groups: Vec<Group> = Vec::new();
        let mut ending = Vec::new();
        for target in targets {
            let settled = target.thread["settledOverride"] == "settled"
                || !target.thread["settledAt"].is_null();
            // `endsWithoutRead`: merged, settled and subagent threads stop without a read.
            if target.link["snapshot"]["state"] == "merged"
                || settled
                || target.thread["lineage"]["relationshipToParent"] == "subagent"
            {
                ending.push(target);
                continue;
            }
            // Grouped by project: checkout access differs, so one failure stays in its project.
            let key = format!(
                "{} {}",
                text(&target.thread, "projectId"),
                pull_request_key(&target.link)
            );
            match groups.iter_mut().find(|g| g.key == key) {
                Some(group) => group.targets.push(target),
                None => groups.push(Group {
                    key,
                    targets: vec![target],
                    fingerprint: String::new(),
                }),
            }
        }
        for group in &mut groups {
            let mut prints: Vec<String> = group
                .targets
                .iter()
                .map(Target::snapshot_fingerprint)
                .collect();
            prints.sort();
            prints.dedup();
            group.fingerprint = prints.join("\n");
        }
        if changed.is_none() {
            let live: HashSet<&str> = groups.iter().map(|g| g.key.as_str()).collect();
            self.last_reads.retain(|key, _| live.contains(key.as_str()));
            self.failures.retain(|key, _| live.contains(key.as_str()));
        }
        for target in &ending {
            let _ = self.record(target, None, None, None).await;
        }
        for group in &groups {
            self.read_group(group).await;
        }
        self.send_held().await;
    }

    /// `planRead` without fingerprints: whether to read the detail, and the comments too.
    fn plan(&self, group: &Group, now: f64) -> (bool, bool) {
        let last = self.last_reads.get(&group.key);
        let Some(last) = last.filter(|last| {
            group
                .targets
                .iter()
                .all(|t| last.watches.contains(&t.watch_key()))
        }) else {
            return (true, true);
        };
        let checks_due = group.targets.iter().any(|t| {
            t.watch.get("checksPending").is_none()
                || t.watch["checksAwaitedSince"]
                    .as_str()
                    .is_some_and(|since| now - parse(since) >= watch::NO_CHECKS_MS)
        });
        let read = last.in_flight
            || !last.remarks_complete
            || last.fingerprint != group.fingerprint
            || now - last.at >= QUIET_REREAD_MS;
        (read || checks_due, read)
    }

    async fn read_group(&mut self, group: &Group) {
        let now = now_ms() as f64;
        let (read_detail, read_activity) = self.plan(group, now);
        if !read_detail {
            return;
        }
        let Some(first) = group.targets.first() else {
            return;
        };
        let reference = json!({"projectId": first.thread["projectId"],
            "host": text(&first.link, "host").to_lowercase(),
            "repository": first.link["repository"], "number": first.link["number"]});
        let panel = self.panel.clone();
        let connected = panel.reference_client("detail", &reference).await;
        let detail = match &connected {
            Ok((project, client, lookup)) => {
                panel
                    .load_read("detail", &reference, project, client, lookup)
                    .await
            }
            Err(failure) => Err(failure.clone()),
        };
        let detail = match detail {
            Ok(detail) => detail,
            Err(failure) => {
                self.last_reads.remove(&group.key);
                match failure_reason(&failure).as_deref() {
                    Some("rate-limited") => {}
                    // Transport and host failures can outlast the limit; the watch waits.
                    Some("failed") => {
                        self.failures.remove(&group.key);
                    }
                    _ => {
                        let failures = self.failures.get(&group.key).copied().unwrap_or(0) + 1;
                        self.failures.insert(group.key.clone(), failures);
                        if failures >= READ_FAILURE_LIMIT {
                            self.failures.remove(&group.key);
                            for target in &group.targets {
                                self.give_up(target).await;
                            }
                        }
                    }
                }
                return;
            }
        };
        self.failures.remove(&group.key);
        // The panel's cached reads of this pull request are older than this one.
        self.panel.invalidate_cached(
            Some(&ReadKey {
                host: text(&reference, "host").to_owned(),
                repo: text(&reference, "repository").to_lowercase(),
                number: first
                    .link
                    .get("number")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok()),
                ..ReadKey::default()
            }),
            false,
        );
        let state = text(&detail, "state");
        if state != "open" {
            self.last_reads.remove(&group.key);
            for target in &group.targets {
                if state == "closed" {
                    self.held.push(Held {
                        group_key: group.key.clone(),
                        target: target.clone(),
                        next: None,
                        ended: None,
                        wake: Wake {
                            text: format!(
                                "Pull request #{} ({}) was closed, so T3 Code stopped watching it. Call watch_pull_request if it reopens.",
                                target.number(),
                                text(&target.link, "url")
                            ),
                            outcome: "updated",
                            summary: format!("#{}: closed, stopped watching", target.number()),
                        },
                        includes_remarks: false,
                    });
                } else {
                    let _ = self.record(target, None, None, None).await;
                }
            }
            return;
        }
        // A failed comments read leaves remarks incomplete, so the next pass reads them again.
        let remarks = match (&connected, read_activity) {
            (Ok((project, client, lookup)), true) => {
                match panel
                    .load_read("activity", &reference, project, client, lookup)
                    .await
                {
                    Ok(activity) => read_remarks(client, lookup, &activity).await,
                    Err(_) => None,
                }
            }
            _ => None,
        };
        let last = self.last_reads.get(&group.key);
        let at = match last {
            Some(last) if !read_activity => last.at,
            _ => now,
        };
        let remarks_complete = if read_activity {
            remarks.is_some()
        } else {
            last.is_some_and(|l| l.remarks_complete)
        };
        self.last_reads.insert(
            group.key.clone(),
            LastRead {
                at,
                fingerprint: group.fingerprint.clone(),
                in_flight: text(&detail, "mergeability") == "unknown"
                    || array(detail.get("checks"))
                        .iter()
                        .any(|c| text(c, "status") == "pending"),
                remarks_complete,
                watches: group.targets.iter().map(Target::watch_key).collect(),
            },
        );
        for target in &group.targets {
            let report = watch::evaluate(&target.watch, &detail, remarks.as_deref(), now);
            if report.changes.is_empty() {
                if report.next != target.watch {
                    let _ = self.record(target, Some(report.next), None, None).await;
                }
                continue;
            }
            let wake = watch::message(
                target.number(),
                text(&target.link, "url"),
                text(&detail, "baseBranch"),
                report.next["headSha"].as_str(),
                &report,
            );
            let includes_remarks = report
                .changes
                .iter()
                .any(|c| matches!(c, Change::Remarks(_)));
            // An ending watch keeps what this pass saw, so watching again starts from it.
            let (next, ended) = if report.exhausted {
                (None, Some(report.next))
            } else {
                (Some(report.next), None)
            };
            self.held.push(Held {
                group_key: group.key.clone(),
                target: target.clone(),
                next,
                ended,
                wake,
                includes_remarks,
            });
        }
    }

    /// `giveUp`.
    async fn give_up(&self, target: &Target) {
        let wake = Wake {
            text: format!(
                "T3 Code stopped watching pull request #{} ({}) because it failed to read it from the host {READ_FAILURE_LIMIT} times in a row. Check it yourself, and call watch_pull_request only if it is still open.",
                target.number(),
                text(&target.link, "url")
            ),
            outcome: "failed",
            summary: format!("#{}: stopped watching, could not read it", target.number()),
        };
        if self
            .record(target, None, Some((&wake, false)), None)
            .await
            .is_err()
        {
            let _ = self.record(target, None, None, None).await;
        }
    }

    async fn send_one(&mut self, item: &Held) {
        let result = self
            .record(
                &item.target,
                item.next.clone(),
                Some((&item.wake, item.includes_remarks)),
                item.ended.as_ref(),
            )
            .await;
        if result.is_err() {
            self.last_reads.remove(&item.group_key);
        }
    }

    /// `sendTogether`: one command and one wake for a thread's news on several pull requests.
    async fn send_together(&self, items: &[Held]) -> Result<(), String> {
        let Some((first, rest)) = items.split_first() else {
            return Ok(());
        };
        let uuid = conn_support::uuid_v4();
        let mut command = identity(&first.target);
        command.insert(
            "commandId".into(),
            json!(format!(
                "server:pr-watch:{}:{uuid}",
                first.target.thread_id()
            )),
        );
        command.insert("threadId".into(), json!(first.target.thread_id()));
        command.insert("watch".into(), first.next.clone().unwrap_or(Value::Null));
        if let Some(ended) = &first.ended {
            command.insert("endedWatch".into(), ended.clone());
        }
        let others: Vec<Value> = rest
            .iter()
            .map(|item| {
                let mut other = identity(&item.target);
                other.insert("watch".into(), item.next.clone().unwrap_or(Value::Null));
                if let Some(ended) = &item.ended {
                    other.insert("endedWatch".into(), ended.clone());
                }
                if item.includes_remarks {
                    other.insert("includesRemarks".into(), json!(true));
                }
                Value::Object(other)
            })
            .collect();
        command.insert("others".into(), json!(others));
        let wakes: Vec<Wake> = items.iter().map(|item| item.wake.clone()).collect();
        let combined = watch::combine(&wakes).unwrap_or_else(|| first.wake.clone());
        let mut wake = wake_json(
            &combined,
            first.includes_remarks,
            &format!("message:pr-watch:{uuid}"),
        );
        wake["sections"] = json!(
            items
                .iter()
                .map(
                    |item| json!({"text": item.wake.text, "outcome": item.wake.outcome,
                    "summary": item.wake.summary})
                )
                .collect::<Vec<_>>()
        );
        command.insert("wake".into(), wake);
        self.send(Value::Object(command)).await
    }

    /// `sendHeld`: per thread, one wake for everything this pass found.
    async fn send_held(&mut self) {
        let held = std::mem::take(&mut self.held);
        let mut by_thread: Vec<(String, Vec<Held>)> = Vec::new();
        for item in held {
            let id = item.target.thread_id().to_owned();
            match by_thread.iter_mut().find(|(t, _)| *t == id) {
                Some((_, items)) => items.push(item),
                None => by_thread.push((id, vec![item])),
            }
        }
        for (_, items) in by_thread {
            if let [one] = items.as_slice() {
                self.send_one(one).await;
                continue;
            }
            // A watch that ended or moved fails the whole command; each then goes alone.
            if self.send_together(&items).await.is_err() {
                for item in &items {
                    self.send_one(item).await;
                }
            }
        }
    }
}

/// `readRemarks`: the activity's comments plus every page of review threads that have more.
/// `None` when the read could have missed comments, so the watermark never passes them.
async fn read_remarks(
    client: &conn_source_control::pull_requests::Client,
    lookup: &conn_source_control::pull_requests::Lookup,
    activity: &Value,
) -> Option<Vec<Value>> {
    if activity["commentsTruncated"] == true && activity["reviewThreadsTruncated"] != false {
        return None;
    }
    let mut remarks: Vec<Value> = array(activity.get("comments")).to_vec();
    for thread in array(activity.get("reviewThreads")) {
        let Some(mut cursor) = thread["nextCommentsCursor"].as_str().map(str::to_owned) else {
            continue;
        };
        let id = text(thread, "id");
        let mut comments: Vec<Value> = Vec::new();
        let mut cursors: HashSet<String> = HashSet::new();
        let mut hidden = 0;
        loop {
            if !cursors.insert(cursor.clone()) || cursors.len() > MAX_COMMENT_PAGES {
                return None;
            }
            let page = client
                .thread_comments(lookup, id, Some(&cursor))
                .await
                .ok()?;
            for comment in array(page.get("comments")) {
                let mut comment = comment.clone();
                comment["kind"] = json!("review-comment");
                comment["path"] = thread["path"].clone();
                comment["reviewState"] = Value::Null;
                let comment_id = comment["id"].clone();
                comments.retain(|c| c["id"] != comment_id);
                comments.push(comment);
            }
            hidden += page["hiddenCount"].as_u64().unwrap_or(0);
            match page["nextCursor"].as_str() {
                Some(next) => cursor = next.to_owned(),
                None => break,
            }
        }
        let count = thread["commentCount"].as_u64().unwrap_or(0);
        if (array(thread.get("comments")).len() + comments.len()) as u64 + hidden < count {
            return None;
        }
        remarks.extend(comments);
    }
    remarks.sort_by(|a, b| text(a, "createdAt").cmp(text(b, "createdAt")));
    Some(remarks)
}

/// Runs the loop for the server's life: a sweep every two minutes, and a read of a pull
/// request as soon as a new watch appears on it, so CI that finishes before the next sweep
/// is not taken as the baseline.
pub(super) async fn run(panel: Arc<Panel>) {
    let (tx, mut rx) = mpsc::channel::<String>(16);
    // New watches beyond the channel's room are not lost: they ask for one more full pass.
    let overflow = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let overflowed = overflow.clone();
    let input = conn_contract::from_json(json!({"requestCompletionMarker": true}));
    if let Ok(input) = input
        && let Ok(mut shell) = panel.engine.subscribe_shell(input).await
    {
        tokio::spawn(async move {
            let mut known: Vec<(String, Vec<String>)> = Vec::new();
            while let Some(Ok(item)) = shell.recv().await {
                let item = conn_contract::to_json(&item);
                match text(&item, "kind") {
                    "snapshot" => {
                        known.clear();
                        for thread in array(item.pointer("/snapshot/threads"))
                            .iter()
                            .take(MAX_OBSERVED_THREADS)
                        {
                            known.push((text(thread, "id").to_owned(), watches_of(thread)));
                        }
                    }
                    "thread.updated" => {
                        let thread = item.get("thread").unwrap_or(&Value::Null);
                        let id = text(thread, "id").to_owned();
                        let now = watches_of(thread);
                        let before = known
                            .iter()
                            .position(|(t, _)| *t == id)
                            .map(|i| known.remove(i).1)
                            .unwrap_or_default();
                        for life in now.iter().filter(|life| !before.contains(life)) {
                            if let Some((key, _)) = life.split_once(' ')
                                && tx.try_send(key.to_owned()).is_err()
                            {
                                overflowed.store(true, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                        if known.len() >= MAX_OBSERVED_THREADS {
                            known.remove(0);
                        }
                        known.push((id, now));
                    }
                    "thread.removed" => {
                        let id = text(&item, "threadId");
                        known.retain(|(t, _)| t != id);
                    }
                    _ => {}
                }
            }
        });
    }
    let mut watcher = Watcher::new(panel);
    let mut sweep = tokio::time::interval(SWEEP);
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = sweep.tick() => watcher.pass(None).await,
            Some(key) = rx.recv() => watcher.pass(Some(&key)).await,
        }
        if overflow.swap(false, std::sync::atomic::Ordering::Relaxed) {
            watcher.pass(None).await;
        }
    }
}

/// `<pull request key> <startedAt>` for each watch of a thread.
fn watches_of(thread: &Value) -> Vec<String> {
    array(thread.get("pullRequests"))
        .iter()
        .filter(|link| link["watch"].is_object() && text(link, "source") != "stack-dismissed")
        .map(|link| {
            format!(
                "{} {}",
                pull_request_key(link),
                text(&link["watch"], "startedAt")
            )
        })
        .collect()
}
