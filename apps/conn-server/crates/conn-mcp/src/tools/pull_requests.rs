//! The pull request link tools: `link_pull_request`, `link_pull_requests`,
//! `unlink_pull_request`, `unlink_pull_requests` and `list_thread_pull_requests`
//! (`apps/server/src/mcp/toolkits/pullRequests/handlers.ts`, `pullRequestTarget.ts`).
//! Keys, URLs and chains come from the host definition registry
//! (`conn_source_control::registry`), as T3's come from `sourceControlDefinitions`.
//!
//! `watch_pull_request` and `unwatch_pull_request` follow `PullRequestWatchService.setWatching`;
//! `read_pull_request_guide` follows the toolkit's `locateAll`. `write_pull_request_guides` is
//! not served: the server has no review guide generator.
//! Their host reads go through the server's GitHub panel (`McpConfig::pull_requests`).

use std::collections::{BTreeSet, HashMap};

use conn_source_control::registry::{
    self, ChangeRequestUrlInput, HostKind, ProjectIdentity,
    thread_keys::{KeySource, ThreadPullRequestKey, normalize_thread_pull_request_key},
};
use serde_json::{Map, Value, json};

use super::{Args, Cx, ToolError, ToolResult};

/// `CHILD_PULL_REQUEST_REPORT_NEXT`.
const CHILD_REPORT_NEXT: &str =
    "End your reply with: PR <full URL>, head <SHA>, checks and reviews <state>.";
const PAGE_SIZE: usize = 50;

fn message(text: &str) -> ToolError {
    ToolError::Message(text.to_owned())
}

const THREAD_REQUIRED: &str = "Pass threadId: this MCP client is not running inside a T3 thread.";
const LINK_FAILED: &str = "Could not link the pull request.";
const UNLINK_FAILED: &str = "Could not unlink the pull request.";

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn number(value: &Value) -> u64 {
    value.get("number").and_then(Value::as_u64).unwrap_or(0)
}

/// `normalizeThreadPullRequestKey` of a link or target.
fn key_of(value: &Value) -> ThreadPullRequestKey {
    normalize_thread_pull_request_key(KeySource {
        host: text(value, "host"),
        repository: text(value, "repository"),
        number: number(value),
        authority: value.get("authority").and_then(Value::as_str),
        url: value.get("url").and_then(Value::as_str),
    })
}

fn is_dismissed(link: &Value) -> bool {
    link["source"] == "stack-dismissed"
}

/// `threadPullRequestsOf`, with the legacy single link read as one.
fn links_of(thread: &Value) -> Vec<Value> {
    if let Some(links) = thread.get("pullRequests").and_then(Value::as_array) {
        return links.clone();
    }
    match thread.get("linkedPullRequest").filter(|l| l.is_object()) {
        Some(linked) => {
            let key = registry::thread_keys::legacy_thread_pull_request_key(
                text(linked, "repository"),
                number(linked),
                text(linked, "url"),
                None,
            );
            vec![
                json!({"host": key.host, "repository": key.repository, "number": key.number,
                "url": linked["url"], "source": "manual", "linkedAt": "1970-01-01T00:00:00.000Z",
                "snapshot": null, "stack": null}),
            ]
        }
        None => Vec::new(),
    }
}

/// `ResolvedTarget`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    key: ThreadPullRequestKey,
    url: String,
}

impl Target {
    fn json(&self) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("host".into(), json!(self.key.host));
        map.insert("repository".into(), json!(self.key.repository));
        map.insert("number".into(), json!(self.key.number));
        map.insert("url".into(), json!(self.url));
        map
    }

    fn source(&self) -> Value {
        Value::Object(self.json())
    }
}

/// The project's `repositoryIdentity`, when its shell carries one.
fn project_identity(project: Option<&Value>) -> Option<ProjectIdentity> {
    let identity = project?
        .get("repositoryIdentity")
        .filter(|i| i.is_object())?;
    let field = |key: &str| identity.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(ProjectIdentity {
        canonical_key: field("canonicalKey").unwrap_or_default(),
        remote_url: identity["locator"]["remoteUrl"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        web_url: field("webUrl"),
        display_name: field("displayName"),
        owner: field("owner"),
        name: field("name"),
        provider: field("provider"),
    })
}

/// `resolveTarget`: a URL, or a repository and number on the project's host or `host`.
fn resolve_target(args: &Args, project: Option<&Value>) -> Result<Target, ToolError> {
    if let Some(url) = args.get("url").and_then(Value::as_str) {
        let Some((_, parsed)) = registry::parse_change_request_url(url) else {
            return Err(message(
                "This is not a recognised pull request URL. Pass repository and number instead.",
            ));
        };
        let link = &parsed.link;
        let key = normalize_thread_pull_request_key(KeySource {
            host: &link.host,
            repository: &link.repository,
            number: link.number,
            authority: link.authority.as_deref(),
            url: None,
        });
        return Ok(Target {
            key,
            url: url.to_owned(),
        });
    }
    let repository = args.get("repository").and_then(Value::as_str);
    let requested = args.get("number").and_then(Value::as_u64);
    let (Some(repository), Some(number)) = (repository, requested) else {
        return Err(message("Pass either url, or both repository and number."));
    };
    let identity = project_identity(project);
    let project_kind = identity.as_ref().and_then(|i| i.provider.clone());
    let project_host = match (&identity, &project_kind) {
        (Some(identity), Some(kind)) => registry::change_request_host(identity, Some(kind)),
        _ => None,
    };
    let host = args
        .get("host")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or(project_host)
        .map(|h| h.to_lowercase());
    let Some(host) = host else {
        return Err(message(
            "This thread's project has no recognised remote. Pass host or url.",
        ));
    };
    let repository = repository.to_lowercase();
    // Without a URL, a public forge host says what shape its change request URLs take; any
    // other host is taken to run the project's own forge.
    let kind = registry::find_by_public_host(&host)
        .map(|k| k.as_str().to_owned())
        .or(project_kind);
    let remote_url = identity.as_ref().map(|i| i.remote_url.clone());
    let url = kind.as_deref().and_then(HostKind::parse).and_then(|k| {
        k.change_request_url(ChangeRequestUrlInput {
            host: &host,
            repository: &repository,
            number,
            remote_url: remote_url.as_deref(),
            web_url: None,
        })
    });
    let Some(url) = url else {
        return Err(message(
            "This thread's project is on a host with no known pull request URL shape. Pass url.",
        ));
    };
    let key = normalize_thread_pull_request_key(KeySource {
        host: &host,
        repository: &repository,
        number,
        authority: None,
        url: Some(&url),
    });
    Ok(Target { key, url })
}

// ---- Chains: `resolveThreadPullRequestChains` --------------------------------------------

struct Chain {
    kind: &'static str,
    /// Indices into the visible links.
    layers: Vec<usize>,
    depths: Vec<usize>,
}

fn key_text(link: &Value) -> String {
    key_of(link).text()
}

fn chains(links: &[Value]) -> (Vec<Value>, Vec<Chain>) {
    let visible: Vec<Value> = links.iter().filter(|l| !is_dismissed(l)).cloned().collect();
    let keys: Vec<ThreadPullRequestKey> = visible.iter().map(key_of).collect();
    let mut out = Vec::new();
    let mut placed: BTreeSet<String> = BTreeSet::new();

    // Native stacks, in first-seen order.
    let mut stacks: Vec<(String, Vec<usize>)> = Vec::new();
    for (index, link) in visible.iter().enumerate() {
        if link["stack"].is_null() || link.get("stack").is_none() {
            continue;
        }
        let key = &keys[index];
        let stack_key = format!(
            "{}/{}#stack:{}",
            key.host, key.repository, link["stack"]["id"]
        );
        match stacks.iter_mut().find(|(k, _)| *k == stack_key) {
            Some((_, members)) => members.push(index),
            None => stacks.push((stack_key, vec![index])),
        }
    }
    let layer_numbers = |index: usize| -> Vec<u64> {
        visible[index]["stack"]["layers"]
            .as_array()
            .map(|l| l.iter().map(number).collect())
            .unwrap_or_default()
    };
    for (_, mut members) in stacks {
        let numbers: BTreeSet<u64> = members.iter().map(|i| number(&visible[*i])).collect();
        let Some(first) = members.first().copied() else {
            continue;
        };
        let mut layers = layer_numbers(first);
        let mut coverage = layers.iter().filter(|n| numbers.contains(n)).count();
        for member in members.iter().skip(1) {
            let candidate = layer_numbers(*member);
            let candidate_coverage = candidate.iter().filter(|n| numbers.contains(n)).count();
            if candidate_coverage > coverage
                || (candidate_coverage == coverage && candidate.len() > layers.len())
            {
                layers = candidate;
                coverage = candidate_coverage;
            }
        }
        let order = |index: &usize| {
            let n = number(&visible[*index]);
            layers.iter().position(|l| *l == n).unwrap_or(layers.len())
        };
        members.sort_by_key(order);
        for member in &members {
            placed.insert(keys[*member].text());
        }
        let depths = (0..members.len()).collect();
        out.push(Chain {
            kind: "native",
            layers: members,
            depths,
        });
    }

    let remaining: Vec<usize> = (0..visible.len())
        .filter(|i| !placed.contains(&keys[*i].text()))
        .collect();
    let branch_key = |index: usize, branch: &str| {
        let key = &keys[index];
        format!("{}/{}:{branch}", key.host, key.repository)
    };
    let mut by_head: HashMap<String, Option<usize>> = HashMap::new();
    for &index in &remaining {
        let snapshot = &visible[index]["snapshot"];
        if snapshot.is_null() {
            continue;
        }
        let key = branch_key(index, text(snapshot, "headBranch"));
        let entry = if by_head.contains_key(&key) {
            None
        } else {
            Some(index)
        };
        by_head.insert(key, entry);
    }
    let parent_of = |index: usize| -> Option<usize> {
        let snapshot = &visible[index]["snapshot"];
        if snapshot.is_null() {
            return None;
        }
        let parent = by_head
            .get(&branch_key(index, text(snapshot, "baseBranch")))
            .copied()
            .flatten()?;
        (parent != index).then_some(parent)
    };
    let mut children: HashMap<String, Vec<usize>> = HashMap::new();
    for &index in &remaining {
        if let Some(parent) = parent_of(index) {
            children.entry(keys[parent].text()).or_default().push(index);
        }
    }
    for &base in &remaining {
        if parent_of(base).is_some() {
            continue;
        }
        let mut layers = Vec::new();
        let mut depths = Vec::new();
        let mut pending = vec![(base, 0usize)];
        while let Some((index, depth)) = pending.pop() {
            let key = keys[index].text();
            if !placed.insert(key.clone()) {
                continue;
            }
            layers.push(index);
            depths.push(depth);
            for child in children.get(&key).into_iter().flatten().rev() {
                pending.push((*child, depth + 1));
            }
        }
        if !layers.is_empty() {
            out.push(Chain {
                kind: "derived",
                layers,
                depths,
            });
        }
    }
    for &index in &remaining {
        if placed.insert(keys[index].text()) {
            out.push(Chain {
                kind: "derived",
                layers: vec![index],
                depths: vec![0],
            });
        }
    }
    (visible, out)
}

/// `listThreadPullRequests`.
fn list(thread: &Value, cursor: Option<&str>, states: Option<&[Value]>) -> Value {
    let links = thread["pullRequests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let (visible, chains) = chains(&links);
    let position = |link: &Value| {
        format!(
            "{} {} {} {:0>10}",
            text(link, "linkedAt"),
            text(link, "host"),
            text(link, "repository"),
            number(link)
        )
    };
    let mut after: Vec<(usize, String)> = visible
        .iter()
        .enumerate()
        .filter(|(_, link)| {
            let state = link["snapshot"]["state"].as_str().unwrap_or("open");
            states.is_none_or(|s| s.iter().any(|v| v.as_str() == Some(state)))
        })
        .map(|(i, link)| (i, position(link)))
        .filter(|(_, p)| cursor.is_none_or(|c| p.as_str() > c))
        .collect();
    after.sort_by(|a, b| a.1.cmp(&b.1));
    let page: Vec<(usize, String)> = after.iter().take(PAGE_SIZE).cloned().collect();
    let page_keys: BTreeSet<String> = page.iter().map(|(i, _)| key_text(&visible[*i])).collect();
    let entry = |index: usize| {
        let link = &visible[index];
        let key = key_text(link);
        let mut stack = Value::Null;
        for chain in &chains {
            if chain.layers.len() < 2 {
                continue;
            }
            if let Some(at) = chain
                .layers
                .iter()
                .position(|l| key_text(&visible[*l]) == key)
            {
                stack = json!({"kind": chain.kind, "position": chain.depths[at] + 1,
                    "size": chain.layers.len()});
                break;
            }
        }
        let snapshot = &link["snapshot"];
        let field = |name: &str| snapshot.get(name).cloned().unwrap_or(Value::Null);
        json!({
            "host": key_of(link).host,
            "repository": link["repository"],
            "number": link["number"],
            "url": link["url"],
            "source": link["source"],
            "watching": link.get("watch").is_some_and(|w| !w.is_null()),
            "state": field("state"),
            "title": field("title"),
            "headBranch": field("headBranch"),
            "baseBranch": field("baseBranch"),
            "isDraft": field("isDraft"),
            "stack": stack,
        })
    };
    let chain_views: Vec<Value> = chains
        .iter()
        .filter(|chain| chain.layers.iter().any(|l| page_keys.contains(&key_text(&visible[*l]))))
        .map(|chain| {
            json!({"kind": chain.kind,
                "numbers": chain.layers.iter().map(|l| visible[*l]["number"].clone()).collect::<Vec<_>>()})
        })
        .collect();
    json!({
        "pullRequests": page.iter().map(|(i, _)| entry(*i)).collect::<Vec<_>>(),
        "chains": chain_views,
        "nextCursor": if after.len() > page.len() { page.last().map(|(_, p)| json!(p)).unwrap_or(Value::Null) } else { Value::Null },
    })
}

// ---- Handlers ----------------------------------------------------------------------------

impl Cx<'_> {
    /// `requireThread`: the named thread, else the caller's own; T3's `threadNotFound` text.
    async fn pull_request_thread(&self, args: &Args) -> Result<Value, ToolError> {
        let requested = args.get("threadId").and_then(Value::as_str);
        let Some(thread_id) = requested.or(self.caller_thread_id()).map(str::to_owned) else {
            return Err(message(THREAD_REQUIRED));
        };
        match self.projection(&thread_id).await {
            Ok(projection) => Ok(projection["thread"].clone()),
            Err(ToolError::Failure {
                code: "thread_not_found",
                ..
            }) => {
                let base = format!("Thread {thread_id} was not found.");
                let prefixed = format!("mcp:{thread_id}");
                let text = match self.projection(&prefixed).await {
                    Ok(_) => format!("{base} Did you mean `{prefixed}`?"),
                    Err(_) => base,
                };
                // The toolkit's failures render as their message (`declaredFailureResult`).
                Err(ToolError::Message(text))
            }
            Err(other) => Err(other),
        }
    }

    async fn project_of(&self, thread: &Value) -> Option<Value> {
        let shell = self.shell().await.ok()?;
        shell["projects"]
            .as_array()?
            .iter()
            .find(|p| p["id"] == thread["projectId"])
            .cloned()
    }

    fn pull_request_command_id(tag: &str, thread_id: &str) -> String {
        format!("server:{tag}:{thread_id}:{}", conn_support::uuid_v4())
    }

    async fn dispatch_link(&self, thread_id: &str, target: &Target) -> Result<(), ToolError> {
        let mut command = target.json();
        command.insert("type".into(), json!("thread.pull-request.link"));
        command.insert(
            "commandId".into(),
            json!(Self::pull_request_command_id("mcp-pr-link", thread_id)),
        );
        command.insert("threadId".into(), json!(thread_id));
        command.insert("source".into(), json!("agent"));
        self.dispatch(Value::Object(command))
            .await
            .map(|_| ())
            .map_err(|_| message(LINK_FAILED))
    }

    async fn dispatch_unlink(
        &self,
        thread_id: &str,
        key: &ThreadPullRequestKey,
    ) -> Result<(), ToolError> {
        let command = json!({
            "type": "thread.pull-request.unlink",
            "commandId": Self::pull_request_command_id("mcp-pr-unlink", thread_id),
            "threadId": thread_id,
            "host": key.host, "repository": key.repository, "number": key.number,
        });
        self.dispatch(command)
            .await
            .map(|_| ())
            .map_err(|_| message(UNLINK_FAILED))
    }
}

fn subagent_next(thread: &Value, map: &mut Map<String, Value>) {
    if thread["lineage"]["relationshipToParent"] == "subagent" {
        map.insert("next".into(), json!(CHILD_REPORT_NEXT));
    }
}

/// Groups `(host, repository)` targets as `byRepository` does, in first-seen order.
fn by_repository(targets: &[&Target]) -> Vec<Value> {
    let mut groups: Vec<(String, String, Vec<u64>)> = Vec::new();
    for target in targets {
        let key = &target.key;
        match groups
            .iter_mut()
            .find(|(h, r, _)| *h == key.host && *r == key.repository)
        {
            Some((_, _, numbers)) => numbers.push(key.number),
            None => groups.push((key.host.clone(), key.repository.clone(), vec![key.number])),
        }
    }
    groups
        .into_iter()
        .map(|(host, repository, numbers)| json!({"host": host, "repository": repository, "numbers": numbers}))
        .collect()
}

pub(crate) async fn link(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx.pull_request_thread(args).await?;
    let project = cx.project_of(&thread).await;
    let target = resolve_target(args, project.as_ref())?;
    let thread_id = text(&thread, "id").to_owned();
    let existing = links_of(&thread)
        .into_iter()
        .find(|link| key_of(link) == key_of(&target.source()));
    let already = existing.is_some_and(|link| !is_dismissed(&link));
    if !already {
        cx.dispatch_link(&thread_id, &target).await?;
    }
    let mut result = target.json();
    result.insert("alreadyLinked".into(), json!(already));
    subagent_next(&thread, &mut result);
    Ok(Value::Object(result))
}

pub(crate) async fn link_many(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx.pull_request_thread(args).await?;
    let thread_id = text(&thread, "id").to_owned();
    let mut targets: Vec<Target> = Vec::new();
    let mut invalid: Vec<Value> = Vec::new();
    for url in args
        .get("urls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut one = Args::new();
        one.insert("url".into(), url.clone());
        match resolve_target(&one, None) {
            Err(_) => invalid.push(url.clone()),
            Ok(target) => {
                if !targets
                    .iter()
                    .any(|seen| key_of(&seen.source()) == key_of(&target.source()))
                {
                    targets.push(target);
                }
            }
        }
    }
    let links = links_of(&thread);
    let is_linked = |target: &Target| {
        let key = key_of(&target.source());
        links
            .iter()
            .any(|link| !is_dismissed(link) && key_of(link) == key)
    };
    let fresh: Vec<&Target> = targets.iter().filter(|t| !is_linked(t)).collect();
    let already: Vec<&Target> = targets.iter().filter(|t| is_linked(t)).collect();
    for target in &fresh {
        cx.dispatch_link(&thread_id, target).await?;
    }
    let mut result = Map::new();
    result.insert("linked".into(), json!(by_repository(&fresh)));
    result.insert("alreadyLinked".into(), json!(by_repository(&already)));
    result.insert("linkedCount".into(), json!(targets.len()));
    if !invalid.is_empty() {
        result.insert("invalidUrls".into(), json!(invalid));
    }
    subagent_next(&thread, &mut result);
    Ok(Value::Object(result))
}

pub(crate) async fn unlink(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx.pull_request_thread(args).await?;
    let project = cx.project_of(&thread).await;
    let target = resolve_target(args, project.as_ref())?;
    let key = key_of(&target.source());
    let linked = links_of(&thread)
        .iter()
        .any(|link| !is_dismissed(link) && key_of(link) == key);
    if linked {
        cx.dispatch_unlink(text(&thread, "id"), &target.key).await?;
    }
    Ok(
        json!({"host": target.key.host, "repository": target.key.repository,
        "number": target.key.number, "wasLinked": linked}),
    )
}

pub(crate) async fn unlink_many(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx.pull_request_thread(args).await?;
    let states: Vec<Value> = args
        .get("states")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let visible: Vec<Value> = links_of(&thread)
        .into_iter()
        .filter(|l| !is_dismissed(l))
        .collect();
    let matching: Vec<(ThreadPullRequestKey, String)> = visible
        .iter()
        .filter_map(|link| {
            let state = link["snapshot"]["state"].as_str()?;
            states
                .iter()
                .any(|s| s.as_str() == Some(state))
                .then(|| (key_of(link), state.to_owned()))
        })
        .collect();
    for (key, _) in &matching {
        cx.dispatch_unlink(text(&thread, "id"), key).await?;
    }
    let mut groups: Vec<(String, String, String, Vec<u64>)> = Vec::new();
    for (key, state) in &matching {
        match groups
            .iter_mut()
            .find(|(h, r, s, _)| *h == key.host && *r == key.repository && s == state)
        {
            Some((_, _, _, numbers)) => numbers.push(key.number),
            None => groups.push((
                key.host.clone(),
                key.repository.clone(),
                state.clone(),
                vec![key.number],
            )),
        }
    }
    Ok(json!({
        "unlinked": groups.into_iter().map(|(host, repository, state, numbers)| {
            json!({"host": host, "repository": repository, "state": state, "numbers": numbers})
        }).collect::<Vec<_>>(),
        "unlinkedCount": matching.len(),
        "remaining": visible.len() - matching.len(),
    }))
}

pub(crate) async fn list_thread(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let thread = cx.pull_request_thread(args).await?;
    let cursor = args.get("cursor").and_then(Value::as_str);
    let states = args
        .get("states")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    Ok(list(&thread, cursor, states))
}

// ---- Watches and guides ------------------------------------------------------------------

const WATCH_FAILED: &str = "Could not change whether the pull request is watched.";
const WATCH_FROM_SUBAGENT: &str = "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/// `PullRequestProjectNotFoundError`.
fn project_not_found(repository: &str) -> String {
    format!(
        "No project in this environment is a checkout of {repository}, so its pull requests cannot be read here. Add one with t3_project_create."
    )
}

/// The `message` of a pull request contract failure, as T3's error classes render it.
fn contract_message(error: &Value) -> String {
    match error["_tag"].as_str() {
        Some("PullRequestUnavailableError") => match error["reason"].as_str() {
            Some("cli-missing") => error["requirement"]
                .as_str()
                .unwrap_or("The tool this host is read through is not installed or set up.")
                .to_owned(),
            Some("cli-unauthenticated") => error["requirement"]
                .as_str()
                .unwrap_or("This host has no working credentials.")
                .to_owned(),
            Some("provider-unsupported") => {
                "Change requests cannot be browsed for this project's host yet.".to_owned()
            }
            _ => match error["host"].as_str() {
                Some(host) => format!(
                    "No project in T3 Code is on {host}. Add any {host} project to read its change requests."
                ),
                None => format!(
                    "{} is not a project in T3 Code. Add it as a project to read its change requests.",
                    error["repository"].as_str().unwrap_or("This repository")
                ),
            },
        },
        Some("PullRequestOperationError") => format!(
            "Pull request operation {} failed: {}",
            text(error, "operation"),
            text(error, "detail")
        ),
        _ => error["message"]
            .as_str()
            .unwrap_or("An error occurred")
            .to_owned(),
    }
}

/// `guideFailureDetail`: the failure's `detail`, else its message.
fn guide_failure_detail(error: &Value) -> String {
    error["detail"]
        .as_str()
        .map_or_else(|| contract_message(error), str::to_owned)
}

fn watched_link(thread: &Value, key: &ThreadPullRequestKey) -> Option<Value> {
    links_of(thread)
        .into_iter()
        .find(|link| !is_dismissed(link) && key_of(link) == *key)
}

impl Cx<'_> {
    async fn pull_request_host(
        &self,
        operation: &'static str,
        input: Value,
    ) -> Option<Result<Value, Value>> {
        let host = self.config().pull_requests.clone()?;
        Some(host(operation, input).await)
    }

    /// `projectForPullRequest`: the project that checks out the target's repository,
    /// preferring the caller's.
    async fn project_for(&self, target: &Target, preferred: Option<&Value>) -> Option<Value> {
        let input = json!({"host": target.key.host, "repository": target.key.repository,
            "preferredProjectId": preferred.map(|p| p["id"].clone())});
        let found = self.pull_request_host("locateProject", input).await?.ok()?;
        let id = found["projectId"].as_str()?;
        let shell = self.shell().await.ok()?;
        shell["projects"]
            .as_array()?
            .iter()
            .find(|p| p["id"] == id)
            .cloned()
    }
}

/// `watch_pull_request` and `unwatch_pull_request`: `PullRequestWatchService.setWatching`.
pub(crate) async fn set_watching(cx: &Cx<'_>, args: &Args, watching: bool) -> ToolResult {
    cx.writes_threads(&[args.get("threadId").and_then(Value::as_str)])
        .await?;
    let thread = cx.pull_request_thread(args).await?;
    let project = cx.project_of(&thread).await;
    let target = resolve_target(args, project.as_ref())?;
    let thread_id = text(&thread, "id").to_owned();
    if watching && thread["lineage"]["relationshipToParent"] == "subagent" {
        return Err(message(WATCH_FROM_SUBAGENT));
    }
    let before = watched_link(&thread, &target.key);
    let not_open = || message("The pull request is merged, so there is nothing to watch.");
    if watching
        && before
            .as_ref()
            .is_some_and(|l| l["snapshot"]["state"] == "merged")
    {
        return Err(not_open());
    }
    if watching && before.as_ref().is_none_or(|l| l.get("watch").is_none()) {
        let input = json!({"projectId": thread["projectId"], "host": target.key.host,
            "repository": target.key.repository, "number": target.key.number});
        match cx.pull_request_host("watchSummary", input).await {
            Some(Ok(summary)) if summary["state"] == "merged" => return Err(not_open()),
            // Host and transport errors can recover while the watch is on.
            Some(Err(error)) if error["_tag"] == "PullRequestUnavailableError" => {
                return Err(ToolError::Message(contract_message(&error)));
            }
            _ => {}
        }
    }
    let mut command = target.json();
    command.insert("type".into(), json!("thread.pull-request.watch"));
    command.insert(
        "commandId".into(),
        json!(Cx::pull_request_command_id("mcp-pr-watch", &thread_id)),
    );
    command.insert("threadId".into(), json!(thread_id));
    command.insert("watching".into(), json!(watching));
    command.remove("url");
    if watching {
        command.insert("link".into(), json!({"url": target.url, "source": "agent"}));
    }
    cx.dispatch(Value::Object(command))
        .await
        .map_err(|_| message(WATCH_FAILED))?;
    let after = cx
        .projection(&thread_id)
        .await
        .map_err(|_| message(&format!("Thread {thread_id} was not found.")))?;
    let mut result = target.json();
    result.insert(
        "watching".into(),
        json!(
            watched_link(&after["thread"], &target.key).is_some_and(|l| l.get("watch").is_some())
        ),
    );
    result.insert(
        "wasWatching".into(),
        json!(before.is_some_and(|l| l.get("watch").is_some())),
    );
    Ok(Value::Object(result))
}

/// One `locateAll` entry: the resolved target, the project that holds it, the caller's.
struct Located {
    target: Result<Target, String>,
    project: Option<Value>,
    caller_project: Option<Value>,
}

/// `locateAll`, for one target.
async fn locate(cx: &Cx<'_>, input: &Args) -> Located {
    let caller_project = match cx.caller_projection().await {
        Ok(Some(own)) => cx.project_of(&own["thread"]).await,
        _ => None,
    };
    let target = match resolve_target(input, caller_project.as_ref()) {
        Ok(target) => Ok(target),
        Err(ToolError::Message(text)) => Err(text),
        Err(other) => Err(other.to_string()),
    };
    let project = match &target {
        Ok(target) => cx.project_for(target, caller_project.as_ref()).await,
        Err(_) => None,
    };
    Located {
        target,
        project,
        caller_project,
    }
}

fn guide_reference(project: &Value, target: &Target) -> Value {
    json!({"projectId": project["id"], "host": target.key.host,
        "repository": target.key.repository, "number": target.key.number})
}

/// `read_pull_request_guide`.
pub(crate) async fn read_guide(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let located = locate(cx, args).await;
    let target = located.target.map_err(ToolError::Message)?;
    let Some(project) = located.project.as_ref().or(located.caller_project.as_ref()) else {
        return Err(message(&project_not_found(&target.key.repository)));
    };
    let answer = match cx
        .pull_request_host("reviewGuide", guide_reference(project, &target))
        .await
    {
        Some(answer) => answer,
        None => {
            Err(json!({"_tag": "PullRequestUnavailableError", "reason": "provider-unsupported"}))
        }
    };
    let result = answer.map_err(|error| {
        let unsupported = matches!(
            error["reason"].as_str(),
            Some("provider-unsupported" | "repository-without-project")
        );
        if located.project.is_none()
            && error["_tag"] == "PullRequestUnavailableError"
            && unsupported
        {
            message(&project_not_found(&target.key.repository))
        } else {
            ToolError::Message(guide_failure_detail(&error))
        }
    })?;
    let guide = result.get("guide").cloned().unwrap_or(Value::Null);
    let current = result.get("currentHeadSha").cloned().unwrap_or(Value::Null);
    let stale = !guide.is_null() && !current.is_null() && guide["headSha"] != current;
    let mut out = target.json();
    out.insert("guide".into(), guide);
    out.insert(
        "run".into(),
        result.get("run").cloned().unwrap_or(Value::Null),
    );
    out.insert("currentHeadSha".into(), current);
    out.insert("stale".into(), json!(stale));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Args {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn targets_resolve_as_pull_request_target_ts() {
        let target = resolve_target(&args(json!({"url": "https://git.cafe/O/R/pull/4"})), None)
            .expect("resolved");
        assert_eq!(target.key.text(), "git.cafe/o/r#4", "key");
        assert_eq!(
            target.url, "https://git.cafe/O/R/pull/4",
            "an unknown host keeps the supplied URL"
        );
        let target = resolve_target(
            &args(json!({"repository": "O/R", "number": 3, "host": "GitHub.com"})),
            None,
        )
        .expect("resolved");
        assert_eq!(
            target.url, "https://github.com/o/r/pull/3",
            "a public host's shape"
        );
        let refused = |value| match resolve_target(&args(value), None) {
            Err(ToolError::Message(text)) => text,
            other => panic!("expected a refusal: {other:?}"),
        };
        assert!(
            refused(json!({"url": "https://example.com/x"})).starts_with("This is not"),
            "url"
        );
        assert!(
            refused(json!({"repository": "o/r"})).starts_with("Pass either"),
            "incomplete"
        );
        assert!(
            refused(json!({"repository": "o/r", "number": 1})).contains("Pass host"),
            "host"
        );
        assert!(
            refused(json!({"repository": "o/r", "number": 1, "host": "git.example"}))
                .contains("no known pull request URL"),
            "unknown host"
        );
    }

    #[test]
    fn lists_page_and_chain_as_t3_does() {
        let link = |n: u64, head: &str, base: &str, at: &str| {
            json!({"host": "github.com", "repository": "o/r", "number": n,
                "url": format!("https://github.com/o/r/pull/{n}"), "source": "agent", "linkedAt": at,
                "snapshot": {"state": "open", "title": format!("PR {n}"), "headBranch": head,
                    "baseBranch": base, "isDraft": false}, "stack": null})
        };
        let thread = json!({"pullRequests": [
            link(2, "b", "a", "2026-01-02T00:00:00.000Z"),
            link(1, "a", "main", "2026-01-01T00:00:00.000Z"),
            link(3, "c", "x", "2026-01-03T00:00:00.000Z"),
        ]});
        let listed = list(&thread, None, None);
        let numbers: Vec<u64> = listed["pullRequests"]
            .as_array()
            .map(|l| l.iter().map(number).collect())
            .unwrap_or_default();
        assert_eq!(numbers, vec![1, 2, 3], "by linkedAt");
        assert_eq!(
            listed["pullRequests"][1]["stack"],
            json!({"kind": "derived", "position": 2, "size": 2}),
            "stacked on #1"
        );
        assert_eq!(listed["chains"][0]["numbers"], json!([1, 2]), "the chain");
        assert_eq!(listed["nextCursor"], Value::Null, "one page");
        let mut tied = thread;
        for link in tied["pullRequests"].as_array_mut().unwrap() {
            link["linkedAt"] = json!("2026-01-01T00:00:00.000Z");
        }
        tied["pullRequests"][2]["repository"] = json!("g/s");
        let tied = list(&tied, None, None);
        assert_eq!(
            tied["pullRequests"]
                .as_array()
                .unwrap()
                .iter()
                .map(number)
                .collect::<Vec<_>>(),
            [3, 1, 2],
            "equal timestamps sort by repository and number"
        );
    }
}
