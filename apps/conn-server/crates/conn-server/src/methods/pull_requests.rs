//! GitHub PR panel RPCs. Host I/O lives in conn-source-control; project and thread routing stays here.
use super::Deps;
use crate::{
    environment::Environment as ServerEnvironment,
    table::{Failure, MethodTable},
};
use conn_contract::{from_json, rpc::pull_requests as rpc, to_json};
use conn_engine::Engine;
use conn_source_control::{
    cache::TtlCache,
    hosts::{DiscoveryContext, Endpoints, Environment},
    pull_requests::{
        Client, Error, Lookup, actions, listing,
        normalize::{array, text},
    },
    registry,
    settings::Settings,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{OnceCell, mpsc, watch};
mod guides;
mod watches;

#[derive(Clone, Debug)]
struct Project {
    id: String,
    title: String,
    root: PathBuf,
    host: String,
    repository: String,
}
fn operation_error(operation: &str, detail: &str) -> Failure {
    Failure::Fail(json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail}))
}
fn routing_error() -> Failure {
    operation_error(
        "routeIdentity",
        "The signed-in account could not be verified before starting the operation.",
    )
}
fn action_unavailable(input: &Value) -> Failure {
    let detail = if text(input, "action") == "delete-branch" {
        "This host cannot delete a change request's source branch.".into()
    } else if input.get("stackNumber").is_some() {
        "This stack action is not supported or has no expected head revision.".into()
    } else {
        format!(
            "This host cannot {} a change request.",
            text(input, "action")
        )
    };
    operation_error("runAction", &detail)
}
fn unsupported() -> Failure {
    Failure::Fail(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}))
}
fn host_error(error: &Error, operation: &str) -> Failure {
    Failure::Fail(error.to_contract(operation))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
struct ReadKey {
    scope: u64,
    method: String,
    host: String,
    repo: String,
    number: Option<u32>,
    input: String,
}

fn cache_ttl(result: &Result<Value, Failure>, seconds: u64) -> Duration {
    match result {
        Ok(value) if value.to_string().len() <= 65_536 => Duration::from_secs(seconds),
        _ => Duration::ZERO,
    }
}

struct Panel {
    engine: Arc<dyn Engine>,
    environment: Option<Arc<ServerEnvironment>>,
    cache: TtlCache<ReadKey, Result<Value, Failure>>,
    identities: TtlCache<u64, Result<Value, Error>>,
    endpoints: Endpoints,
    host_environment: Environment,
    child_env: Vec<(&'static str, std::ffi::OsString)>,
    credentials: Mutex<VecDeque<(Client, u64)>>,
    next_scope: AtomicU64,
    refreshes: watch::Sender<u64>,
    linked: watch::Sender<u64>,
    monitor: OnceCell<tokio::task::JoinHandle<()>>,
    reports: Mutex<VecDeque<(String, Value, tokio::time::Instant)>>,
}
struct MutationReads<'a> {
    panel: &'a Panel,
    reference: ReadKey,
}
impl Drop for MutationReads<'_> {
    fn drop(&mut self) {
        self.panel.invalidate_cached(Some(&self.reference), false);
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        if let Some(task) = self.monitor.get() {
            task.abort();
        }
    }
}
impl Panel {
    fn settings(&self) -> Settings {
        Settings::new(
            self.environment
                .as_ref()
                .map(|e| e.settings.raw())
                .unwrap_or_default(),
        )
    }
    async fn projects(&self, input: &Value) -> Result<Vec<Project>, Failure> {
        let shell =
            self.engine.shell_snapshot().await.map_err(|_| {
                operation_error("listProjects", "The project list could not be read.")
            })?;
        let mut result = Vec::new();
        for p in array(shell.get("projects")) {
            if input
                .get("projectId")
                .is_some_and(|id| p.get("id") != Some(id))
                || input
                    .get("projectIds")
                    .is_some_and(|ids| !array(Some(ids)).iter().any(|id| p.get("id") == Some(id)))
            {
                continue;
            }
            let root = PathBuf::from(text(p, "workspaceRoot"));
            let stored = p
                .pointer("/repositoryIdentity/locator/remoteUrl")
                .and_then(Value::as_str);
            let remote = if let Some(remote) = stored {
                remote.to_owned()
            } else {
                let output = conn_vcs::process::GitCommand::new(
                    "PullRequestService.resolveRepository",
                    &root,
                    ["remote", "-v"],
                )
                .run()
                .await;
                let Ok(output) = output else {
                    continue;
                };
                let remotes =
                    conn_source_control::detect::parse_remote_verbose(&output.stdout_text());
                let Some(context) = conn_source_control::detect::select_provider_context(&remotes)
                else {
                    continue;
                };
                if context.provider.kind != "github" {
                    continue;
                }
                context.remote_url
            };
            let Some(info) = registry::recognize_remote(&remote) else {
                continue;
            };
            if info.kind != "github" {
                continue;
            }
            let Some((host, repository)) = registry::git_remote_repository(&remote) else {
                continue;
            };
            if input
                .get("host")
                .is_some_and(|h| !h.as_str().unwrap_or("").eq_ignore_ascii_case(&host))
            {
                continue;
            }
            if Lookup::new(&repository, 1).is_err() {
                continue;
            }
            result.push(Project {
                id: text(p, "id").into(),
                title: text(p, "title").into(),
                root,
                host,
                repository,
            });
        }
        Ok(result)
    }
    async fn resolve(&self, input: &Value) -> Result<Project, Failure> {
        let own = self
            .projects(&json!({"projectId":input.get("projectId")}))
            .await?;
        let repository = text(input, "repository").trim();
        let host = text(input, "host").trim().to_lowercase();
        if let Some(p) = own.first().filter(|p| {
            p.repository.eq_ignore_ascii_case(repository) && (host.is_empty() || p.host == host)
        }) {
            return Ok(p.clone());
        }
        if host.is_empty() {
            return Err(if own.is_empty() {
                unsupported()
            } else {
                operation_error(
                    "resolveRepository",
                    "The change request does not belong to the selected project.",
                )
            });
        }
        let all = self.projects(&json!({"host":host})).await?;
        if let Some(p) = all
            .iter()
            .find(|p| p.repository.eq_ignore_ascii_case(repository))
            .or_else(|| all.first())
        {
            let mut p = p.clone();
            p.repository = repository.into();
            return Ok(p);
        }
        // GitHub public reads may use a project with no checkout of that repository.
        if host == "github.com" {
            let shell = self.engine.shell_snapshot().await.map_err(|_| {
                operation_error(
                    "resolveRepository",
                    "The selected project could not be read.",
                )
            })?;
            if let Some(p) = array(shell.get("projects"))
                .iter()
                .find(|p| p.get("id") == input.get("projectId"))
            {
                return Ok(Project {
                    id: text(p, "id").into(),
                    title: text(p, "title").into(),
                    root: PathBuf::from(text(p, "workspaceRoot")),
                    host,
                    repository: repository.into(),
                });
            }
        }
        Err(unsupported())
    }
    async fn client(&self, project: &Project, operation: &str) -> Result<Client, Failure> {
        let settings = self.settings();
        let env = &self.host_environment;
        let endpoints = &self.endpoints;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Client::connect(
            DiscoveryContext {
                cwd: &project.root,
                home: home.as_deref(),
                settings: &settings,
                env,
                endpoints,
                child_env: &self.child_env,
            },
            &project.host,
        )
        .await
        .map_err(|e| host_error(&e, operation))
    }
    fn credential_scope(&self, client: &Client) -> u64 {
        let mut held = self
            .credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some((_, id)) = held.iter().find(|(c, _)| c.same_credential(client)) {
            return *id;
        }
        let id = self.next_scope.fetch_add(1, Ordering::Relaxed);
        if held.len() >= 8 {
            if let Some((_, scope)) = held.pop_front() {
                self.identities.invalidate(&scope);
            }
            self.cache.invalidate_all();
        }
        held.push_back((client.clone(), id));
        id
    }
    async fn identity(&self, client: &Client) -> Result<Value, Error> {
        self.identities
            .get_with(
                self.credential_scope(client),
                |result| {
                    if result.is_ok() {
                        Duration::from_secs(10 * 60)
                    } else {
                        Duration::ZERO
                    }
                },
                || client.identity(),
            )
            .await
    }
    async fn call(&self, method: &str, input: Value) -> Result<Value, Failure> {
        match method {
            "invalidate" => {
                let viewed = input.get("filesViewedOnly") == Some(&Value::Bool(true));
                self.invalidate(input.get("reference"), viewed).await;
                if !viewed {
                    self.refreshes.send_modify(|v| *v = v.saturating_add(1));
                }
                Ok(Value::Null)
            }
            "reportState" => self.report_state(&input).await,
            "linkedThreads" => self.linked_threads(&input).await,
            "list" | "listStats" => self.cached_listing(method, &input).await,
            "filterOptions" => self.filter_options(&input).await,
            "routing" => self.routing(&input).await,
            "routingIdentity" => self.routing_identity(&input).await,
            "setFilesViewed" => self.set_files_viewed(&input).await,
            "reviewGuide" => self.review_guide(&input).await,
            "generateReviewGuide" => self.generate_review_guide(&input).await,
            "runAction" | "reviewerCandidates" | "labelCandidates" => {
                self.action(method, &input).await
            }
            _ if actions::is_mutation(method) => self.action(method, &input).await,
            _ => self.cached_read(method, &input).await,
        }
    }
    /// What `/mcp` asks of the panel (`mcp_host`).
    async fn mcp_call(&self, operation: &str, input: Value) -> Result<Value, Failure> {
        match operation {
            // `summary` with `bypassCache`, as `PullRequestWatchService` reads it.
            "watchSummary" => {
                let (project, client, lookup) = self.reference_client("summary", &input).await?;
                self.load_read("summary", &input, &project, &client, &lookup)
                    .await
            }
            // The project that checks out `host/repository` (`projectForPullRequest`).
            "locateProject" => {
                let host = text(&input, "host").to_lowercase();
                let repository = text(&input, "repository");
                let projects = self.projects(&json!({"host": host})).await?;
                let matches =
                    |p: &&Project| p.host == host && p.repository.eq_ignore_ascii_case(repository);
                let preferred = input.get("preferredProjectId");
                let found = projects
                    .iter()
                    .filter(matches)
                    .find(|p| preferred.is_some_and(|id| id == p.id.as_str()))
                    .or_else(|| projects.iter().find(matches));
                Ok(json!({"projectId": found.map(|p| p.id.clone())}))
            }
            "reviewGuide" => self.review_guide(&input).await,
            "generateReviewGuide" => self.generate_review_guide(&input).await,
            _ => Err(Failure::die(format!(
                "Unknown pull request operation {operation}"
            ))),
        }
    }
    fn guide_unavailable(&self) -> Failure {
        let off = self.environment.as_ref().is_some_and(|environment| {
            environment.settings.for_client().get("reviewGuidesEnabled")
                == Some(&Value::Bool(false))
        });
        operation_error(
            "generateReviewGuide",
            if off {
                "Review guides are off. Turn them on in Settings → Source control & issues."
            } else {
                "This server cannot generate review guides yet."
            },
        )
    }
    async fn generate_review_guide(&self, input: &Value) -> Result<Value, Failure> {
        if input.get("expectedAccountId").is_some() {
            self.reference_client("routeIdentity", input)
                .await
                .map_err(|_| routing_error())?;
        }
        Err(self.guide_unavailable())
    }
    async fn action(&self, method: &str, input: &Value) -> Result<Value, Failure> {
        let routed = input.get("expectedAccountId").is_some();
        let project = self
            .resolve(input)
            .await
            .map_err(|error| if routed { routing_error() } else { error })?;
        let client = if routed {
            let client = self
                .client(&project, "routeIdentity")
                .await
                .map_err(|_| routing_error())?;
            self.verified_identity(&project, &client, input)
                .await
                .map_err(|_| routing_error())?;
            Some(client)
        } else {
            None
        };
        let lookup = Lookup::new(
            &project.repository,
            input.get("number").and_then(Value::as_u64).unwrap_or(0),
        )
        .map_err(|error| host_error(&error, method))?;
        let invalidation = (actions::is_mutation(method) || method == "runAction").then(|| {
            let reads = MutationReads {
                panel: self,
                reference: ReadKey {
                    host: project.host.clone(),
                    repo: project.repository.to_lowercase(),
                    number: Some(lookup.number),
                    ..ReadKey::default()
                },
            };
            self.invalidate_cached(Some(&reads.reference), false);
            reads
        });
        if method == "runAction" {
            return Err(action_unavailable(input));
        }
        actions::validate(method, input).map_err(|error| host_error(&error, method))?;
        let client = match client {
            Some(client) => client,
            None => self.client(&project, method).await?,
        };
        let result = client
            .action(&lookup, method, input)
            .await
            .map_err(|error| host_error(&error, method));
        drop(invalidation);
        if result.is_ok() && actions::is_mutation(method) {
            self.refreshes
                .send_modify(|value| *value = value.saturating_add(1));
        }
        result
    }
    async fn review_guide(&self, input: &Value) -> Result<Value, Failure> {
        let unidentified = || {
            operation_error(
                "reviewGuide",
                "Could not identify this pull request's host.",
            )
        };
        let shell = self
            .engine
            .shell_snapshot()
            .await
            .map_err(|_| unidentified())?;
        if !array(shell.get("projects"))
            .iter()
            .any(|project| project.get("id") == input.get("projectId"))
        {
            return Err(unidentified());
        }
        let (project, client, lookup) =
            self.reference_client("reviewGuide", input)
                .await
                .map_err(|error| {
                    if text(input, "host").is_empty() {
                        unidentified()
                    } else {
                        error
                    }
                })?;
        let key = thread_key(input, &project.host).ok_or_else(unidentified)?;
        let guide = if let Some(environment) = &self.environment {
            guides::load(
                environment.state_dir.join("statev2.sqlite"),
                key.host,
                key.repository,
                lookup.number,
            )
            .await?
        } else {
            Value::Null
        };
        let detail = client
            .detail(&lookup)
            .await
            .map_err(|error| host_error(&error, "detail"))?;
        Ok(json!({"guide":guide,"run":null,"currentHeadSha":detail.get("headSha")}))
    }
    async fn report_state(&self, input: &Value) -> Result<Value, Failure> {
        let reference = input.get("reference").unwrap_or(&Value::Null);
        let project = self.resolve(reference).await?;
        let key = format!(
            "{} {}/{}#{}",
            text(reference, "expectedAccountId"),
            project.host,
            project.repository.to_lowercase(),
            reference.get("number").unwrap_or(&Value::Null)
        );
        let value = json!([input.get("state"), input.get("isDraft")]);
        let now = tokio::time::Instant::now();
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        if reports.iter().any(|(k, v, at)| {
            k == &key && v == &value && now.duration_since(*at) < Duration::from_secs(5 * 60)
        }) {
            return Ok(Value::Null);
        }
        reports.retain(|(k, _, _)| k != &key);
        if reports.len() >= 2048 {
            reports.pop_front();
        }
        reports.push_back((key, value, now));
        self.cache.invalidate_all();
        self.refreshes.send_modify(|v| *v = v.saturating_add(1));
        Ok(Value::Null)
    }
    async fn verified_identity(
        &self,
        project: &Project,
        client: &Client,
        input: &Value,
    ) -> Result<Value, Failure> {
        let identity = self
            .identity(client)
            .await
            .map_err(|e| host_error(&e, "routeIdentity"))?;
        if let Some(expected) = input.get("expectedAccountId")
            && (identity.get("accountId") != Some(expected)
                || !text(input, "host").eq_ignore_ascii_case(&project.host))
        {
            return Err(routing_error());
        }
        Ok(identity)
    }
    async fn routed_identity(&self, project: &Project, input: &Value) -> Result<Value, Failure> {
        let client = self.client(project, "routeIdentity").await?;
        let mut identity = self.verified_identity(project, &client, input).await?;
        identity["host"] = json!(project.host);
        identity["provider"] = json!("github");
        Ok(identity)
    }
    async fn routing_identity(&self, input: &Value) -> Result<Value, Failure> {
        let project = self
            .projects(input)
            .await?
            .into_iter()
            .next()
            .ok_or_else(unsupported)?;
        self.routed_identity(&project, input).await
    }
    async fn routing(&self, input: &Value) -> Result<Value, Failure> {
        let project = self.resolve(input).await?;
        let mut identity = self.routed_identity(&project, input).await?;
        identity["projectTitle"] = json!(project.title);
        identity["workspaceRoot"] = json!(project.root);
        Ok(identity)
    }
    async fn reference_client(
        &self,
        method: &str,
        input: &Value,
    ) -> Result<(Project, Client, Lookup), Failure> {
        let project = self.resolve(input).await?;
        let client = self.client(&project, method).await?;
        if method != "diff" && input.get("expectedAccountId").is_some() {
            self.verified_identity(&project, &client, input).await?;
        }
        let lookup = Lookup::new(
            &project.repository,
            input.get("number").and_then(Value::as_u64).unwrap_or(0),
        )
        .map_err(|e| host_error(&e, method))?;
        Ok((project, client, lookup))
    }
    async fn set_files_viewed(&self, input: &Value) -> Result<Value, Failure> {
        let (_, client, lookup) = self.reference_client("setFilesViewed", input).await?;
        client
            .set_files_viewed(&lookup, array(input.get("files")))
            .await
            .map_err(|e| host_error(&e, "setFilesViewed"))?;
        self.invalidate(Some(input), true).await;
        Ok(Value::Null)
    }
    async fn cached_read(&self, method: &str, input: &Value) -> Result<Value, Failure> {
        let (project, client, lookup) = self.reference_client(method, input).await?;
        let key = ReadKey {
            scope: self.credential_scope(&client),
            method: method.into(),
            host: project.host.clone(),
            repo: project.repository.to_lowercase(),
            number: Some(lookup.number),
            input: input.to_string(),
        };
        self.cache
            .get_with(
                key,
                |result| {
                    cache_ttl(
                        result,
                        match method {
                            "checks" | "filesViewed" => 15,
                            "preview" => 300,
                            _ => 60,
                        },
                    )
                },
                || self.load_read(method, input, &project, &client, &lookup),
            )
            .await
    }
    async fn load_read(
        &self,
        method: &str,
        input: &Value,
        project: &Project,
        client: &Client,
        lookup: &Lookup,
    ) -> Result<Value, Failure> {
        let observed = conn_support::time::now_ms();
        let mut value = match method {
            "stack" => client.stack(lookup).await,
            "summary" => client.summary(lookup).await,
            "preview" => client.preview(lookup).await,
            "detail" | "checks" => client.detail(lookup).await,
            "activity" => client.activity(lookup).await,
            "filesViewed" => client.files_viewed(lookup).await,
            "changeBreakdown" => client.change_breakdown(lookup).await,
            "threadComments" => {
                client
                    .thread_comments(
                        lookup,
                        text(input, "threadId"),
                        input.get("cursor").and_then(Value::as_str),
                    )
                    .await
            }
            "diff" => client.diff(lookup, input).await,
            "diffFileContents" => client.diff_file_contents(lookup, input).await,
            _ => return Err(Failure::die(format!("Unregistered PR operation {method}"))),
        }
        .map_err(|e| host_error(&e, method))?;
        if method == "checks" {
            return Ok(
                json!({"state":value.get("state"),"checks":value.get("checks"),"observedAt":observed}),
            );
        }
        if matches!(method, "summary" | "preview" | "detail") {
            value["projectId"] = json!(project.id);
            value["repository"] = json!(project.repository);
            if method != "preview" {
                value["provider"] = json!("github");
                value["observedAt"] = json!(observed);
            }
        }
        if method == "detail" {
            value["projectTitle"] = json!(project.title);
            value["workspaceRoot"] = json!(project.root);
            value["capabilities"] = capabilities();
            if let Ok(identity) = self.identity(client).await {
                value["viewer"] = identity.get("viewer").cloned().unwrap_or(Value::Null);
            }
        }
        Ok(value)
    }
    async fn invalidate(&self, reference: Option<&Value>, viewed: bool) {
        let canonical = if let Some(reference) = reference {
            match self.resolve(reference).await {
                Ok(project) => Some(ReadKey {
                    host: project.host,
                    repo: project.repository.to_lowercase(),
                    number: reference
                        .get("number")
                        .and_then(Value::as_u64)
                        .and_then(|number| u32::try_from(number).ok()),
                    ..ReadKey::default()
                }),
                Err(_) => return,
            }
        } else {
            None
        };
        self.invalidate_cached(canonical.as_ref(), viewed);
    }
    fn invalidate_cached(&self, canonical: Option<&ReadKey>, viewed: bool) {
        self.cache.invalidate_where(|key| {
            if !viewed && matches!(key.method.as_str(), "list" | "listStats") {
                return true;
            }
            (!viewed || key.method == "filesViewed")
                && canonical.is_none_or(|reference| {
                    key.host == reference.host
                        && key.repo == reference.repo
                        && key.number == reference.number
                })
        });
    }
    async fn cached_listing(&self, method: &str, input: &Value) -> Result<Value, Failure> {
        let mut projects = self
            .projects(if method == "list" {
                input
            } else {
                &Value::Null
            })
            .await?;
        if method == "listStats" {
            projects.retain(|p| {
                array(input.get("refs")).iter().any(|r| {
                    text(r, "projectId") == p.id
                        && text(r, "repository").eq_ignore_ascii_case(&p.repository)
                })
            });
        }
        let mut clients = BTreeMap::new();
        for project in &projects {
            if !clients.contains_key(&project.host) {
                clients.insert(project.host.clone(), self.client(project, method).await);
            }
        }
        let scopes: Vec<_> = clients
            .iter()
            .map(|(host, client)| {
                json!([
                    host,
                    client
                        .as_ref()
                        .ok()
                        .map(|client| self.credential_scope(client))
                ])
            })
            .collect();
        let project_keys: Vec<_> = projects
            .iter()
            .map(|p| json!([p.id, p.title, p.root, p.host, p.repository]))
            .collect();
        let mut canonical_input = input.clone();
        let sorted = if method == "list" {
            "projectIds"
        } else {
            "refs"
        };
        if let Some(values) = canonical_input
            .get_mut(sorted)
            .and_then(Value::as_array_mut)
        {
            values.sort_by_cached_key(Value::to_string);
        }
        let key = ReadKey {
            method: method.into(),
            input: json!([canonical_input, scopes, project_keys]).to_string(),
            ..ReadKey::default()
        };
        self.cache
            .get_with(
                key,
                |result| {
                    if clients.values().all(Result::is_ok) {
                        cache_ttl(result, if method == "list" { 30 } else { 60 })
                    } else {
                        Duration::ZERO
                    }
                },
                || async {
                    if method == "list" {
                        self.list(input, &projects, &clients).await
                    } else {
                        self.list_stats(input, &projects, &clients).await
                    }
                },
            )
            .await
    }
    async fn list(
        &self,
        input: &Value,
        projects: &[Project],
        clients: &BTreeMap<String, Result<Client, Failure>>,
    ) -> Result<Value, Failure> {
        let mut cursors = BTreeMap::new();
        if let Some(c) = input.get("cursors").and_then(Value::as_object) {
            for (key, raw) in c {
                cursors.insert(
                    key.clone(),
                    listing::Cursor::parse(raw.as_str().unwrap_or(""))
                        .map_err(|e| host_error(&e, "list"))?,
                );
            }
        }
        let mut unique = BTreeMap::new();
        for p in projects {
            unique
                .entry(format!("{} {}", p.host, p.repository.to_lowercase()))
                .or_insert(p);
        }
        let mut entries = Vec::new();
        let mut errors = Vec::new();
        let mut viewers = json!({});
        let mut providers = Vec::new();
        let mut next = json!({});
        let mut blocking = None;
        let mut truncated = false;
        for (key, p) in &unique {
            let client = clients
                .get(&p.host)
                .cloned()
                .unwrap_or_else(|| Err(unsupported()));
            let identity = match &client {
                Ok(c) => self.identity(c).await.map_err(|e| host_error(&e, "list")),
                Err(e) => Err(e.clone()),
            };
            let viewer = identity
                .as_ref()
                .ok()
                .map(|i| text(i, "viewer"))
                .unwrap_or("");
            if !viewer.is_empty() {
                viewers[&p.host] = json!(viewer);
            }
            if !providers.iter().any(|v: &Value| text(v, "host") == p.host) {
                providers.push(provider_info(
                    p,
                    &identity,
                    unique.values().filter(|other| other.host == p.host).count(),
                ));
            }
            if input.get("cursors").is_some() && !cursors.contains_key(key) {
                continue;
            }
            if let Err(error) = identity {
                blocking = Some(error);
                errors.push(json!({"projectId":p.id,"projectTitle":p.title,"message":format!("{} could not be read.",p.repository)}));
                continue;
            }
            let client = client?;
            match client
                .list(&p.repository, input, viewer, cursors.get(key))
                .await
            {
                Ok(page) => {
                    entries.extend(
                        array(page.get("items"))
                            .iter()
                            .cloned()
                            .map(|row| list_entry(row, p, input, viewer)),
                    );
                    truncated |= page.get("truncated") == Some(&Value::Bool(true));
                    if let Some(cursor) = page.get("nextCursor").filter(|v| !v.is_null()) {
                        next[key] = cursor.clone();
                    }
                }
                Err(error) => {
                    let hint = error
                        .access_hint()
                        .map(|hint| format!(" {hint}"))
                        .unwrap_or_default();
                    errors.push(json!({"projectId":p.id,"projectTitle":p.title,"message":format!("{} could not be read.{hint}",p.repository)}));
                }
            }
        }
        entries.sort_by(|a, b| text(b, "updatedAt").cmp(text(a, "updatedAt")));
        let result = json!({"viewers":viewers,"providers":providers,"entries":entries,"errors":errors,"truncated":truncated,"nextCursors":next});
        if array(result.get("entries")).is_empty()
            && let Some(Failure::Fail(mut error)) = blocking
        {
            error["listResult"] = result;
            return Err(Failure::Fail(error));
        }
        Ok(result)
    }
    async fn list_stats(
        &self,
        input: &Value,
        projects: &[Project],
        clients: &BTreeMap<String, Result<Client, Failure>>,
    ) -> Result<Value, Failure> {
        let mut wanted = BTreeMap::new();
        for reference in array(input.get("refs")) {
            let Some(project) = projects.iter().find(|p| {
                p.id == text(reference, "projectId")
                    && p.repository
                        .eq_ignore_ascii_case(text(reference, "repository"))
            }) else {
                continue;
            };
            let Ok(lookup) = Lookup::new(
                &project.repository,
                reference.get("number").and_then(Value::as_u64).unwrap_or(0),
            ) else {
                continue;
            };
            wanted.insert(
                format!("{} {}", project.id, lookup.number),
                (project, lookup),
            );
        }
        let mut groups: BTreeMap<String, Vec<_>> = BTreeMap::new();
        for entry in wanted.into_values() {
            groups.entry(entry.0.host.clone()).or_default().push(entry);
        }
        let mut stats = Vec::new();
        for entries in groups.into_values() {
            let Some((first, _)) = entries.first() else {
                continue;
            };
            let Some(Ok(client)) = clients.get(&first.host) else {
                continue;
            };
            let lookups: Vec<_> = entries.iter().map(|(_, l)| l.clone()).collect();
            if let Ok(read) = client.stats_batch(&lookups).await {
                for (index, mut value) in read {
                    if let Some((project, _)) = entries.get(index) {
                        value["projectId"] = json!(project.id);
                        value["repository"] = json!(project.repository);
                        stats.push(value);
                    }
                }
            }
        }
        Ok(json!({"stats":stats}))
    }
    async fn filter_options(&self, input: &Value) -> Result<Value, Failure> {
        let projects = self.projects(input).await?;
        let kind = text(input, "kind");
        let mut unique = Vec::new();
        let mut option_keys = std::collections::BTreeSet::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut truncated = false;
        for project in projects {
            if !seen.insert(format!("{} {}", project.host, project.repository)) {
                continue;
            }
            let Ok(client) = self.client(&project, "filterOptions").await else {
                continue;
            };
            let Ok(page) = client.filter_options(&project.repository, input).await else {
                continue;
            };
            truncated |= page.get("truncated") == Some(&Value::Bool(true));
            for item in array(page.get("items")) {
                let key = text(
                    item,
                    match kind {
                        "labels" => "name",
                        "authors" => "login",
                        _ => "reference",
                    },
                )
                .to_lowercase();
                if option_keys.insert(key) {
                    unique.push(item.clone());
                }
            }
        }
        let q = text(input, "query").trim().to_lowercase();
        let mut items: Vec<(u8, Value)> = unique
            .into_iter()
            .filter_map(|item| {
                let fields = match kind {
                    "labels" => vec![text(&item, "name").to_lowercase()],
                    "authors" => vec![
                        text(&item, "login").to_lowercase(),
                        text(&item, "name").to_lowercase(),
                    ],
                    _ => vec![
                        item.get("number").map(Value::to_string).unwrap_or_default(),
                        text(&item, "title").to_lowercase(),
                    ],
                };
                let rank = if q.is_empty() || fields.contains(&q) {
                    0
                } else if fields.iter().any(|s| s.starts_with(&q)) {
                    1
                } else if fields.iter().any(|s| s.contains(&q)) {
                    2
                } else {
                    return None;
                };
                Some((rank, item))
            })
            .collect();
        items.sort_by(|(left_rank, left), (right_rank, right)| {
            left_rank.cmp(right_rank).then_with(|| {
                if kind == "references" {
                    std::cmp::Ordering::Equal
                } else {
                    let key = if kind == "labels" { "name" } else { "login" };
                    text(left, key)
                        .to_lowercase()
                        .cmp(&text(right, key).to_lowercase())
                }
            })
        });
        truncated |= items.len() > 100;
        items.truncate(100);
        let values: Vec<_> = items.into_iter().map(|(_, v)| v).collect();
        let empty = Vec::<Value>::new();
        Ok(
            json!({"labels":if kind=="labels"{&values}else{&empty},"authors":if kind=="authors"{&values}else{&empty},"references":if kind=="references"{&values}else{&empty},"truncated":truncated}),
        )
    }
    async fn linked_threads(&self, input: &Value) -> Result<Value, Failure> {
        let active = self
            .engine
            .shell_snapshot()
            .await
            .map_err(|_| operation_error("linkedThreads", "Could not load linked threads."))?;
        let archived = self
            .engine
            .call("orchestration.getArchivedShellSnapshot", json!({}))
            .await
            .map_err(|_| operation_error("linkedThreads", "Could not load linked threads."))?;
        let host = if text(input, "host").is_empty() {
            self.resolve(input)
                .await
                .ok()
                .map(|p| p.host)
                .unwrap_or_default()
        } else {
            text(input, "host").into()
        };
        let wanted = thread_key(input, &host);
        let mut threads: Vec<_> = array(active.get("threads"))
            .iter()
            .chain(array(archived.get("threads")))
            .filter(|t| {
                t.pointer("/lineage/sideChat") != Some(&Value::Bool(true))
                    && wanted.is_some()
                    && array(t.get("pullRequests")).iter().any(|p| {
                        text(p, "source") != "stack-dismissed" && thread_key(p, "") == wanted
                    })
            })
            .cloned()
            .collect();
        threads.sort_by(|a, b| {
            text(b, "updatedAt")
                .cmp(text(a, "updatedAt"))
                .then_with(|| text(a, "id").cmp(text(b, "id")))
        });
        let threads: Vec<_> = threads.iter().map(linked_thread).collect();
        Ok(json!({"threads":threads}))
    }
    async fn subscribe_refreshes(
        self: &Arc<Self>,
        linked: bool,
    ) -> Result<mpsc::Receiver<Result<Value, Failure>>, Failure> {
        self.monitor().await?;
        let mut changes = if linked {
            self.linked.subscribe()
        } else {
            self.refreshes.subscribe()
        };
        let (tx, rx) = mpsc::channel(1);
        tokio::spawn(async move {
            loop {
                let value = *changes.borrow_and_update();
                if tx.send(Ok(json!(value))).await.is_err() {
                    return;
                }
                tokio::select! {
                    _ = tx.closed() => return,
                    result = changes.changed() => if result.is_err() { return; }
                }
            }
        });
        Ok(rx)
    }
    async fn monitor(self: &Arc<Self>) -> Result<(), Failure> {
        self.monitor
            .get_or_try_init(|| async {
                let input = from_json(json!({"requestCompletionMarker":true}))
                    .map_err(|_| Failure::die("Invalid shell subscription"))?;
                let mut shell =
                    self.engine.subscribe_shell(input).await.map_err(|_| {
                        Failure::die("Could not subscribe to linked-thread changes")
                    })?;
                let weak = Arc::downgrade(self);
                Ok::<_, Failure>(tokio::spawn(async move {
                    let mut linked_views = VecDeque::<ObservedThread>::new();
                    let mut synchronized = false;
                    while let Some(item) = shell.recv().await {
                        let Ok(item) = item else {
                            break;
                        };
                        let item = to_json(&item);
                        let Some(panel) = weak.upgrade() else {
                            break;
                        };
                        match text(&item, "kind") {
                            "snapshot" => {
                                linked_views.clear();
                                for thread in
                                    array(item.pointer("/snapshot/threads")).iter().take(2048)
                                {
                                    remember_view(&mut linked_views, ObservedThread::new(thread));
                                }
                            }
                            "synchronized" => synchronized = true,
                            "thread.updated" => {
                                let thread = item.get("thread").unwrap_or(&Value::Null);
                                let next = ObservedThread::new(thread);
                                let previous = linked_views.iter().find(|v| v.id == next.id);
                                if synchronized
                                    && previous.and_then(|v| v.links.as_ref())
                                        != next.links.as_ref()
                                {
                                    panel.linked.send_modify(|v| *v = v.saturating_add(1));
                                }
                                if synchronized
                                    && !next.completed.is_null()
                                    && previous.map(|v| &v.completed) != Some(&next.completed)
                                {
                                    panel.cache.invalidate_all();
                                    panel.refreshes.send_modify(|v| *v = v.saturating_add(1));
                                }
                                remember_view(&mut linked_views, next);
                            }
                            "thread.removed" => {
                                let id = text(&item, "threadId");
                                if synchronized
                                    && linked_views
                                        .iter()
                                        .find(|v| v.id == id)
                                        .is_none_or(|v| v.links.is_some())
                                {
                                    panel.linked.send_modify(|v| *v = v.saturating_add(1));
                                }
                                linked_views.retain(|v| v.id != id);
                            }
                            "project.updated" | "project.removed" => panel.cache.invalidate_all(),
                            _ => {}
                        }
                    }
                }))
            })
            .await?;
        Ok(())
    }
}

struct ObservedThread {
    id: String,
    links: Option<Value>,
    completed: Value,
}
impl ObservedThread {
    fn new(thread: &Value) -> Self {
        Self {
            id: text(thread, "id").into(),
            links: linked_view(thread),
            completed: thread
                .get("latestRunCompletedAt")
                .cloned()
                .unwrap_or(Value::Null),
        }
    }
}
fn remember_view(views: &mut VecDeque<ObservedThread>, next: ObservedThread) {
    views.retain(|v| v.id != next.id);
    if views.len() >= 2048 {
        views.pop_front();
    }
    views.push_back(next);
}
fn provider_info(project: &Project, identity: &Result<Value, Failure>, count: usize) -> Value {
    let detail = identity.as_ref().err().map(|error| match error {
        Failure::Fail(value) => value
            .get("requirement")
            .or_else(|| value.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("GitHub could not be read.")
            .to_owned(),
        _ => String::new(),
    });
    json!({
        "host": project.host, "kind": "github", "searchesOnHost": true, "actions": [],
        "projectCount": count, "configured": identity.as_ref().is_ok_and(|v| !text(v,"viewer").is_empty()), "detail": detail
    })
}
fn list_entry(mut row: Value, project: &Project, input: &Value, viewer: &str) -> Value {
    row["provider"] = json!("github");
    row["host"] = json!(project.host);
    row["projectId"] = json!(project.id);
    row["projectTitle"] = json!(project.title);
    row["repository"] = json!(project.repository);
    row["observedAt"] = json!(conn_support::time::now_ms());
    let authored =
        text(row.get("author").unwrap_or(&Value::Null), "login").eq_ignore_ascii_case(viewer);
    let requested = array(row.get("reviewRequestLogins"))
        .iter()
        .any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(viewer)));
    let team = text(input, "involvement") == "reviewing"
        && row.get("hasTeamReviewRequest") == Some(&Value::Bool(true));
    row["viewerReviewRequested"] = json!(!authored && (requested || team));
    if let Some(object) = row.as_object_mut() {
        object.remove("reviewRequestLogins");
        object.remove("hasTeamReviewRequest");
        for key in ["checksState", "reviewDecision"] {
            if object.get(key).is_some_and(Value::is_null) {
                object.remove(key);
            }
        }
    }
    row
}

fn thread_key(
    input: &Value,
    default_host: &str,
) -> Option<registry::thread_keys::ThreadPullRequestKey> {
    let host = if text(input, "host").is_empty() {
        default_host
    } else {
        text(input, "host")
    };
    if host.is_empty() {
        return None;
    }
    Some(registry::thread_keys::normalize_thread_pull_request_key(
        registry::thread_keys::KeySource {
            host,
            repository: text(input, "repository"),
            number: input.get("number").and_then(Value::as_u64)?,
            authority: input.get("authority").and_then(Value::as_str),
            url: input.get("url").and_then(Value::as_str),
        },
    ))
}

fn linked_view(thread: &Value) -> Option<Value> {
    if thread.pointer("/lineage/sideChat") == Some(&Value::Bool(true))
        || thread.get("deletedAt").is_some_and(|v| !v.is_null())
    {
        return None;
    }
    let mut keys: Vec<_> = array(thread.get("pullRequests"))
        .iter()
        .filter(|p| text(p, "source") != "stack-dismissed")
        .map(|p| {
            format!(
                "{}/{}#{}",
                text(p, "host").to_lowercase(),
                text(p, "repository").to_lowercase(),
                p.get("number").unwrap_or(&Value::Null)
            )
        })
        .collect();
    if keys.is_empty() {
        return None;
    }
    keys.sort();
    Some(json!([
        keys,
        thread.get("title"),
        thread.get("projectId"),
        thread.get("archivedAt"),
        thread.get("settledAt"),
        thread.get("settledOverride"),
        thread.get("updatedAt")
    ]))
}

fn linked_thread(thread: &Value) -> Value {
    let settled = thread.get("settledAt").is_some_and(|v| !v.is_null())
        || text(thread, "settledOverride") == "settled";
    json!({
        "id":thread.get("id"), "projectId":thread.get("projectId"), "title":thread.get("title"),
        "archivedAt":thread.get("archivedAt"), "settled":settled
    })
}
fn capabilities() -> Value {
    json!({"diff":true,"comment":true,"actions":[],"mergeMethods":[],"search":true,"reactions":true,"mentions":true,"referenceSigils":["#"],"viewedFiles":"host","review":{"inlineComment":true,"rangeComment":true,"reply":true,"resolve":true,"verdicts":["comment","approve","request-changes"]},"reviewers":{"request":true,"listCandidates":true,"searchCandidates":true},"edit":{"changeRequest":true,"comment":true,"maintainerEdits":true},"stacks":true,"labels":true,"checksAlwaysReport":true})
}

/// Lazily initialized so HTTP and RPC share the same bounded cache and refresh state.
#[derive(Clone, Default)]
pub struct Shared(Arc<OnceLock<Arc<Panel>>>);
impl std::fmt::Debug for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Shared")
            .field("initialized", &self.0.get().is_some())
            .finish()
    }
}
impl Shared {
    fn panel(&self, deps: &Deps) -> Option<Arc<Panel>> {
        let engine = deps.engine.clone()?;
        Some(
            self.0
                .get_or_init(|| {
                    Arc::new(Panel {
                        engine,
                        environment: deps.environment.clone(),
                        cache: TtlCache::new(32),
                        identities: TtlCache::new(8),
                        endpoints: Endpoints::default(),
                        host_environment: Environment::process(),
                        child_env: Vec::new(),
                        credentials: Mutex::new(VecDeque::new()),
                        next_scope: AtomicU64::new(1),
                        refreshes: watch::channel(0).0,
                        linked: watch::channel(0).0,
                        monitor: OnceCell::new(),
                        reports: Mutex::new(VecDeque::new()),
                    })
                })
                .clone(),
        )
    }
}

/// The panel's operations `/mcp` uses for the watch and guide tools (`conn_mcp::PullRequestHost`).
pub(crate) fn mcp_host(deps: &Deps) -> Option<conn_mcp::PullRequestHost> {
    let panel = deps.pull_requests.panel(deps)?;
    Some(Arc::new(move |operation: &'static str, input: Value| {
        let panel = panel.clone();
        Box::pin(async move {
            panel
                .mcp_call(operation, input)
                .await
                .map_err(|failure| match failure {
                    Failure::Fail(value) => value,
                    Failure::Die(defect) => defect,
                })
        }) as conn_engine::BoxFuture<'static, Result<Value, Value>>
    }))
}

/// Starts the pull request watch loop (`watches.rs`) for the server's life.
pub(crate) fn start_watches(deps: &Deps) {
    if let Some(panel) = deps.pull_requests.panel(deps) {
        tokio::spawn(watches::run(panel));
    }
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    if let Some(panel) = deps.pull_requests.panel(deps) {
        register_panel(table, panel);
    }
}

fn register_panel(table: &mut MethodTable, panel: Arc<Panel>) {
    macro_rules! unary {
        ($name:literal,$area:ident) => {{
            let panel = panel.clone();
            table.unary($name, move |_, input: rpc::$area::Payload| {
                let panel = panel.clone();
                async move {
                    let result = panel
                        .call(
                            $name.strip_prefix("pullRequests.").unwrap_or($name),
                            to_json(&input),
                        )
                        .await?;
                    from_json::<rpc::$area::Success>(result).map_err(|e| {
                        Failure::die(format!("Invalid pullRequests.{} result: {e}", $name))
                    })
                }
            });
        }};
    }
    unary!("pullRequests.list", list);
    unary!("pullRequests.comment", comment);
    unary!("pullRequests.replyToThread", reply_to_thread);
    unary!("pullRequests.updateComment", update_comment);
    unary!("pullRequests.setReaction", set_reaction);
    unary!("pullRequests.setThreadResolution", set_thread_resolution);
    unary!("pullRequests.submitReview", submit_review);
    unary!("pullRequests.requestReviewers", request_reviewers);
    unary!("pullRequests.reviewerCandidates", reviewer_candidates);
    unary!("pullRequests.labelCandidates", label_candidates);
    unary!("pullRequests.setLabels", set_labels);
    unary!("pullRequests.update", update);
    unary!("pullRequests.runAction", run_action);
    unary!("pullRequests.stack", stack);
    unary!("pullRequests.generateReviewGuide", generate_review_guide);
    unary!("pullRequests.reviewGuide", review_guide);

    unary!("pullRequests.listStats", list_stats);
    unary!("pullRequests.filterOptions", filter_options);
    unary!("pullRequests.detail", detail);
    unary!("pullRequests.summary", summary);
    unary!("pullRequests.checks", checks);
    unary!("pullRequests.changeBreakdown", change_breakdown);
    unary!("pullRequests.diffFileContents", diff_file_contents);
    unary!("pullRequests.activity", activity);
    unary!("pullRequests.threadComments", thread_comments);
    unary!("pullRequests.linkedThreads", linked_threads);
    unary!("pullRequests.preview", preview);
    unary!("pullRequests.routing", routing);
    unary!("pullRequests.routingIdentity", routing_identity);
    unary!("pullRequests.reportState", report_state);
    unary!("pullRequests.invalidate", invalidate);
    unary!("pullRequests.filesViewed", files_viewed);
    unary!("pullRequests.setFilesViewed", set_files_viewed);
    for (tag, linked) in [
        ("pullRequests.subscribeRefreshes", false),
        ("pullRequests.subscribeLinkedThreadRefreshes", true),
    ] {
        let panel = panel.clone();
        table.stream(tag, move |_, _: Value| {
            let panel = panel.clone();
            async move { panel.subscribe_refreshes(linked).await }
        });
    }
}

#[cfg(test)]
mod tests;
pub(crate) async fn diff(
    deps: &Deps,
    input: conn_contract::PullRequestDiffInput,
) -> Result<Value, Failure> {
    let panel = deps.pull_requests.panel(deps).ok_or_else(unsupported)?;
    panel.call("diff", to_json(&input)).await
}
