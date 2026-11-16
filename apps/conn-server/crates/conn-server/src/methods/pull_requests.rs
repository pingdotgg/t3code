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
    pull_requests::{Client, Error, Lookup, actions, listing},
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

#[derive(Clone, Debug)]
struct Project {
    id: String,
    title: String,
    root: PathBuf,
    host: String,
    repository: String,
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn array(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}
fn operation_error(operation: &str, detail: &str) -> Failure {
    Failure::Fail(json!({"_tag":"PullRequestOperationError","operation":operation,"detail":detail}))
}
fn unsupported() -> Failure {
    Failure::Fail(json!({"_tag":"PullRequestUnavailableError","reason":"provider-unsupported"}))
}
fn host_error(error: &Error, operation: &str) -> Failure {
    Failure::Fail(error.to_contract(operation))
}

struct Panel {
    engine: Arc<dyn Engine>,
    environment: Option<Arc<ServerEnvironment>>,
    cache: TtlCache<String, Result<Value, Failure>>,
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
    reference: (String, String, Value),
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
            held.pop_front();

            self.cache.invalidate_all();
        }
        held.push_back((client.clone(), id));

        id
    }
    async fn call(&self, method: &str, input: Value) -> Result<Value, Failure> {
        if !actions::is_mutation(method) {
            return self.call_inner(method, input).await;
        }
        let project = self.resolve(&input).await?;
        let invalidation = MutationReads {
            panel: self,
            reference: (
                project.host,
                project.repository.to_lowercase(),
                input.get("number").cloned().unwrap_or(Value::Null),
            ),
        };
        self.invalidate_cached(Some(&invalidation.reference), false);
        let result = self.call_inner(method, input).await;
        drop(invalidation);
        if result.is_ok() {
            self.refreshes.send_modify(|v| *v = v.saturating_add(1));
        }
        result
    }
    async fn call_inner(&self, method: &str, input: Value) -> Result<Value, Failure> {
        actions::validate(method, &input).map_err(|e| host_error(&e, method))?;
        if method == "reviewGuide" {
            let shell = self.engine.shell_snapshot().await.map_err(|_| {
                operation_error(
                    "reviewGuide",
                    "Could not identify this pull request's host.",
                )
            })?;
            if !array(shell.get("projects"))
                .iter()
                .any(|p| p.get("id") == input.get("projectId"))
            {
                return Err(operation_error(
                    "reviewGuide",
                    "Could not identify this pull request's host.",
                ));
            }
        }
        match method {
            "invalidate" => {
                let viewed = input.get("filesViewedOnly") == Some(&Value::Bool(true));

                self.invalidate(input.get("reference"), viewed).await;

                if !viewed {
                    self.refreshes.send_modify(|v| *v = v.saturating_add(1));
                }
                return Ok(Value::Null);
            }
            "reportState" => {
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
                    k == &key
                        && v == &value
                        && now.duration_since(*at) < Duration::from_secs(5 * 60)
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

                return Ok(Value::Null);
            }
            "linkedThreads" => return self.linked_threads(&input).await,
            "list" | "listStats" => return self.cached_listing(method, &input).await,
            "filterOptions" => return self.filter_options(&input).await,
            _ => {}
        }
        let project = if method == "routingIdentity" {
            self.projects(&input)
                .await?
                .into_iter()
                .next()
                .ok_or_else(unsupported)?
        } else {
            self.resolve(&input).await.map_err(|error| {
                if method == "reviewGuide" && text(&input, "host").is_empty() {
                    operation_error(
                        "reviewGuide",
                        "Could not identify this pull request's host.",
                    )
                } else {
                    error
                }
            })?
        };

        let client = self
            .client(
                &project,
                if method.starts_with("routing") {
                    "routeIdentity"
                } else {
                    method
                },
            )
            .await?;

        let scope = self.credential_scope(&client);

        let identity = if method.starts_with("routing")
            || (method != "diff" && input.get("expectedAccountId").is_some())
        {
            let identity = client
                .identity()
                .await
                .map_err(|e| host_error(&e, "routeIdentity"))?;

            if let Some(expected) = input.get("expectedAccountId")
                && (identity.get("accountId") != Some(expected)
                    || !text(&input, "host").eq_ignore_ascii_case(&project.host))
            {
                return Err(operation_error(
                    "routeIdentity",
                    "The signed-in account could not be verified before starting the operation.",
                ));
            }
            Some(identity)
        } else {
            None
        };

        if let Some(mut identity) = identity.filter(|_| method.starts_with("routing")) {
            identity["host"] = json!(project.host);

            identity["provider"] = json!("github");

            if method == "routing" {
                identity["projectTitle"] = json!(project.title);

                identity["workspaceRoot"] = json!(project.root);
            }
            return Ok(identity);
        }
        let lookup = Lookup::new(
            &project.repository,
            input.get("number").and_then(Value::as_u64).unwrap_or(0),
        )
        .map_err(|e| host_error(&e, method))?;

        if method == "reviewGuide" {
            let key = thread_key(&input, &project.host).ok_or_else(|| {
                operation_error(
                    "reviewGuide",
                    "Could not identify this pull request's host.",
                )
            })?;
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
                .map_err(|e| host_error(&e, "detail"))?;
            return Ok(json!({"guide":guide,"run":null,"currentHeadSha":detail.get("headSha")}));
        }
        if actions::is_mutation(method)
            || matches!(method, "reviewerCandidates" | "labelCandidates")
        {
            return client
                .action(&lookup, method, &input)
                .await
                .map_err(|e| host_error(&e, method));
        }
        if method == "setFilesViewed" {
            client
                .set_files_viewed(&lookup, array(input.get("files")))
                .await
                .map_err(|e| host_error(&e, method))?;

            self.invalidate(Some(&input), true).await;

            return Ok(Value::Null);
        }
        let key = json!([
            scope,
            method,
            project.id,
            project.host,
            project.repository.to_lowercase(),
            lookup.number,
            input
        ])
        .to_string();

        self.cache.get_with(key,|r|if let Ok(value)=r{if value.to_string().len()>65_536{return Duration::ZERO;
}Duration::from_secs(match method{"checks"|"filesViewed"=>15,"preview"=>300,_=>60})}else{Duration::ZERO},||async{
            let observed=conn_support::time::now_ms();

            let value=match method {
                "stack"=>client.stack(&lookup).await,
                "summary"=>client.summary(&lookup).await,
                "preview"=>client.preview(&lookup).await,
                "detail"|"checks"=>client.detail(&lookup).await,
                "activity"=>client.activity(&lookup).await,
                "filesViewed"=>client.files_viewed(&lookup).await,
                "changeBreakdown"=>client.change_breakdown(&lookup).await,
                "threadComments"=>client.thread_comments(&lookup,text(&input,"threadId"),input.get("cursor").and_then(Value::as_str)).await,
                "diff"=>client.diff(&lookup,&input).await,
                "diffFileContents"=>client.diff_file_contents(&lookup,&input).await,
                _=>return Err(Failure::die(format!("Unregistered PR operation {method}"))),
            }.map_err(|e|host_error(&e,method))?;

            if method=="checks"{return Ok(json!({"state":value.get("state"),"checks":value.get("checks"),"observedAt":observed}));
}
            let mut value=value;

            if ["summary","preview","detail"].contains(&method){value["projectId"]=json!(project.id);
value["repository"]=json!(project.repository);
if method!="preview"{value["provider"]=json!("github");
value["observedAt"]=json!(observed);
}}
            if method=="detail"{value["projectTitle"]=json!(project.title);
value["workspaceRoot"]=json!(project.root);
value["capabilities"]=capabilities();
if let Ok(identity)=client.identity().await{value["viewer"]=identity.get("viewer").cloned().unwrap_or(Value::Null);
}}
            Ok(value)
        }).await
    }
    async fn invalidate(&self, reference: Option<&Value>, viewed: bool) {
        let canonical = if let Some(reference) = reference {
            match self.resolve(reference).await {
                Ok(p) => Some((
                    p.host,
                    p.repository.to_lowercase(),
                    reference.get("number").cloned().unwrap_or(Value::Null),
                )),
                Err(_) => return,
            }
        } else {
            None
        };

        self.invalidate_cached(canonical.as_ref(), viewed);
    }
    fn invalidate_cached(&self, canonical: Option<&(String, String, Value)>, viewed: bool) {
        self.cache.invalidate_where(|key| {
            let Ok(key) = serde_json::from_str::<Value>(key) else {
                return false;
            };

            let method = key.get(1).and_then(Value::as_str).unwrap_or("");

            if !viewed && matches!(method, "list" | "listStats") {
                return true;
            }
            (!viewed || method == "filesViewed")
                && canonical.is_none_or(|(host, repo, number)| {
                    key.get(3).and_then(Value::as_str) == Some(host)
                        && key.get(4).and_then(Value::as_str) == Some(repo)
                        && key.get(5) == Some(number)
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
        let key = json!([
            0,
            method,
            null,
            null,
            null,
            null,
            canonical_input,
            scopes,
            project_keys
        ])
        .to_string();
        self.cache
            .get_with(
                key,
                |result| {
                    if clients.values().all(Result::is_ok)
                        && let Ok(value) = result
                        && value.to_string().len() <= 65_536
                    {
                        return Duration::from_secs(if method == "list" { 30 } else { 60 });
                    }
                    Duration::ZERO
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
                Ok(c) => c.identity().await.map_err(|e| host_error(&e, "list")),
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
                providers.push(json!({"host":p.host,"kind":"github","searchesOnHost":true,"actions":[],"projectCount":unique.values().filter(|other|other.host==p.host).count(),"configured":!viewer.is_empty(),"detail":identity.as_ref().err().map(|e|match e{Failure::Fail(v)=>v.get("requirement").or_else(||v.get("detail")).and_then(Value::as_str).unwrap_or("GitHub could not be read.").to_owned(),_=>String::new()})}));
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

            match client.list(&p.repository,input,viewer,cursors.get(key)).await {
                Ok(page)=>{for mut row in array(page.get("items")).iter().cloned(){if !listing::matches(&row,input,viewer){continue;
}row["provider"]=json!("github");
row["host"]=json!(p.host);
row["projectId"]=json!(p.id);
row["projectTitle"]=json!(p.title);
row["repository"]=json!(p.repository);
row["observedAt"]=json!(conn_support::time::now_ms());
row["viewerReviewRequested"]=json!(!row.pointer("/author/login").and_then(Value::as_str).unwrap_or("").eq_ignore_ascii_case(viewer)&&(array(row.get("reviewRequestLogins")).iter().any(|l|l.as_str().is_some_and(|s|s.eq_ignore_ascii_case(viewer)))||(text(input,"involvement")=="reviewing"&&row.get("hasTeamReviewRequest")==Some(&Value::Bool(true)))));
if let Some(o)=row.as_object_mut(){for key in ["reviewRequestLogins","hasTeamReviewRequest"]{o.remove(key);
}for key in ["checksState","reviewDecision"]{if o.get(key).is_some_and(Value::is_null){o.remove(key);
}}}entries.push(row);
}truncated|=page.get("truncated")==Some(&Value::Bool(true));
if let Some(c)=page.get("nextCursor").filter(|v|!v.is_null()){next[key]=c.clone();
}},
                Err(error)=>errors.push(json!({"projectId":p.id,"projectTitle":p.title,"message":format!("{} could not be read.{}",p.repository,error.access_hint().map(|hint|format!(" {hint}")).unwrap_or_default())})),
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

        Ok(
            json!({"threads":threads.into_iter().map(|t|json!({"id":t.get("id"),"projectId":t.get("projectId"),"title":t.get("title"),"archivedAt":t.get("archivedAt"),"settled":t.get("settledAt").is_some_and(|v|!v.is_null())||text(&t,"settledOverride")=="settled"})).collect::<Vec<_>>()}),
        )
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
                    let mut linked_views = BTreeMap::new();

                    let mut completed = BTreeMap::new();

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

                                completed.clear();

                                for thread in
                                    array(item.pointer("/snapshot/threads")).iter().take(2048)
                                {
                                    linked_views
                                        .insert(text(thread, "id").to_owned(), linked_view(thread));

                                    completed.insert(
                                        text(thread, "id").to_owned(),
                                        thread
                                            .get("latestRunCompletedAt")
                                            .cloned()
                                            .unwrap_or(Value::Null),
                                    );
                                }
                            }
                            "synchronized" => synchronized = true,
                            "thread.updated" => {
                                let thread = item.get("thread").unwrap_or(&Value::Null);

                                let id = text(thread, "id").to_owned();

                                let next = linked_view(thread);

                                let previous = linked_views.get(&id).cloned().flatten();

                                if synchronized && previous != next {
                                    panel.linked.send_modify(|v| *v = v.saturating_add(1));
                                }
                                let at = thread
                                    .get("latestRunCompletedAt")
                                    .cloned()
                                    .unwrap_or(Value::Null);

                                if synchronized && !at.is_null() && completed.get(&id) != Some(&at)
                                {
                                    panel.cache.invalidate_all();

                                    panel.refreshes.send_modify(|v| *v = v.saturating_add(1));
                                }
                                if linked_views.len() >= 2048
                                    && !linked_views.contains_key(&id)
                                    && let Some(oldest) = linked_views.keys().next().cloned()
                                {
                                    linked_views.remove(&oldest);

                                    completed.remove(&oldest);
                                }
                                linked_views.insert(id.clone(), next);

                                completed.insert(id, at);
                            }
                            "thread.removed" => {
                                let id = text(&item, "threadId");

                                if synchronized && linked_views.get(id).is_none_or(Option::is_some)
                                {
                                    panel.linked.send_modify(|v| *v = v.saturating_add(1));
                                }
                                linked_views.remove(id);

                                completed.remove(id);
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
    // runAction needs guarded Git/stack operations and engine merge/link synchronization.
    unary!("pullRequests.stack", stack);
    // Generation needs owned background runs, scratch checkouts, diff normalization and writes.
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

        table.stream(tag,move |_,_:Value|{let panel=panel.clone();
async move {
            panel.monitor().await?;
let mut changes=if linked{panel.linked.subscribe()}else{panel.refreshes.subscribe()};
let(tx,rx)=mpsc::channel(1);

            tokio::spawn(async move {loop {let value=*changes.borrow_and_update();
if tx.send(Ok(json!(value))).await.is_err(){return;
}tokio::select!{_=tx.closed()=>return,result=changes.changed()=>if result.is_err(){return;
}}}});
Ok(rx)
        }});
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
