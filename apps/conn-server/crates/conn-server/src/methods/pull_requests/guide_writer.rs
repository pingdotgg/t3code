//! Writes review guides as `PullRequestReviewGuideService.generate` does: claim a run for the
//! pull request's current head, check the head out in a temporary worktree of the project,
//! let the review guide model investigate it read-only, normalize its answer against the
//! change and store it. A second request for the same head joins the run. Runs live in memory,
//! as in T3; a restart forgets them (the stored guides stay).

use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use conn_source_control::pull_requests::{Client, Lookup, normalize::text};
use conn_vcs::process::{GitCommand, OnLimit, ProcessError};
use serde_json::{Value, json};

use super::{Failure, Panel, Project, guides, operation_error};
use crate::text_generation::{
    prompts::{self, ReviewGuidePromptInput, StackLayer},
    review_guide, title,
};

/// `INVESTIGATION_TIMEOUT_MS`.
const INVESTIGATION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The fetch and worktree limit T3 sets (`timeoutMs: 5 * 60_000`).
const CHECKOUT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// `readChange`'s limits.
const DIFF_TIMEOUT: Duration = Duration::from_secs(60);
const DIFF_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Finished runs kept for `run` (T3 keeps every failed run until the next one). Running
/// runs are never dropped.
const MAX_FINISHED_RUNS: usize = 256;
/// `PATCH_RENDER_PREFIX_ARGS`: git's default prefixes, whatever the user configured.
const PATCH_PREFIX_ARGS: [&str; 2] = ["--src-prefix=a/", "--dst-prefix=b/"];
/// The drivers that can read a checkout read-only (`INVESTIGATING_DRIVERS`).
const INVESTIGATING_DRIVERS: [&str; 2] = ["codex", "claudeAgent"];

struct Run {
    id: u64,
    /// `PullRequestReviewGuideRun`: `Running` or `Failed`.
    value: Value,
}

/// The runs, keyed `host/repository#number`, and the lock T3 calls `ownership`.
#[derive(Default)]
pub(super) struct Runs {
    runs: Mutex<BTreeMap<String, Run>>,
    finished: Mutex<VecDeque<String>>,
    next: AtomicU64,
    ownership: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Runs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runs").finish_non_exhaustive()
    }
}

impl Runs {
    pub(super) fn get(&self, key: &str) -> Value {
        self.runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .map_or(Value::Null, |run| run.value.clone())
    }
    fn owns(&self, key: &str, id: u64) -> bool {
        self.runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .is_some_and(|run| run.id == id)
    }
    /// `finish`: only the run that still owns the key ends it.
    fn finish(&self, key: &str, id: u64, next: Option<Value>) {
        let mut runs = self.runs.lock().unwrap_or_else(PoisonError::into_inner);
        if runs.get(key).is_none_or(|run| run.id != id) {
            return;
        }
        match next {
            None => {
                runs.remove(key);
            }
            Some(value) => {
                runs.insert(key.to_owned(), Run { id, value });
                let mut finished = self.finished.lock().unwrap_or_else(PoisonError::into_inner);
                finished.retain(|k| k != key);
                finished.push_back(key.to_owned());
                while finished.len() > MAX_FINISHED_RUNS {
                    let Some(old) = finished.pop_front() else {
                        break;
                    };
                    if runs
                        .get(&old)
                        .is_some_and(|run| run.value["_tag"] == "Failed")
                    {
                        runs.remove(&old);
                    }
                }
            }
        }
    }
}

fn failed(detail: impl Into<String>) -> String {
    detail.into()
}

fn git_detail(error: &ProcessError) -> String {
    let stderr = error.stderr().trim();
    if stderr.is_empty() {
        error.to_string()
    } else {
        stderr.to_owned()
    }
}

async fn git(
    operation: &'static str,
    cwd: &Path,
    args: &[&str],
    timeout: Option<Duration>,
) -> Result<String, String> {
    let mut command = GitCommand::new(operation, cwd, args.iter().copied());
    if let Some(timeout) = timeout {
        command = command.timeout(timeout);
    }
    command.text().await.map_err(|e| git_detail(&e))
}

/// `resolveCommit`.
async fn resolve_commit(cwd: &Path, revision: &str) -> Result<String, String> {
    let revision = format!("{revision}^{{commit}}");
    git(
        "GitVcsDriver.resolveCommit",
        cwd,
        &["rev-parse", "--verify", &revision],
        None,
    )
    .await
    .map(|out| out.trim().to_owned())
}

fn is_commit_hash(sha: &str) -> bool {
    (7..=64).contains(&sha.len()) && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// One checkout for one run; `drop_all` removes it.
struct Checkout {
    workspace: PathBuf,
    base_ref: String,
    directory: Option<PathBuf>,
    path: PathBuf,
    added: bool,
}

impl Checkout {
    async fn drop_all(self) {
        if self.added {
            let path = self.path.to_string_lossy().into_owned();
            let _ = git(
                "GitVcsDriver.removeWorktree",
                &self.workspace,
                &["worktree", "remove", "--force", &path],
                None,
            )
            .await;
        }
        let _ = git(
            "PullRequestReviewGuideService.dropBaseRef",
            &self.workspace,
            &["update-ref", "-d", &self.base_ref],
            None,
        )
        .await;
        if let Some(directory) = self.directory {
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(directory)).await;
        }
    }
}

struct Fetcher<'a> {
    workspace: &'a Path,
    remote: String,
}

impl Fetcher<'_> {
    async fn fetch(&self, refspec: &str) -> Result<String, String> {
        git(
            "PullRequestReviewGuideService.fetch",
            self.workspace,
            &["fetch", "--quiet", "--no-tags", "--", &self.remote, refspec],
            Some(CHECKOUT_TIMEOUT),
        )
        .await
    }

    /// `resolveHead`: the commit, never a branch or tag that shares its short name.
    async fn resolve_head(&self, sha: &str) -> Result<String, String> {
        let commit = resolve_commit(self.workspace, sha).await?;
        if commit.starts_with(sha) {
            Ok(commit)
        } else {
            Err(format!(
                "{sha} names {commit} here, a branch or tag rather than the commit."
            ))
        }
    }

    /// `fetchHead`: local objects, then the commit, the branch, and the host's head ref.
    async fn head(&self, number: u64, reported: &str, branch: &str) -> Result<String, String> {
        let sha = reported.to_lowercase();
        if !is_commit_hash(&sha) {
            return Err(format!(
                "The host reported a head for #{number} that is not a commit hash."
            ));
        }
        let mut failures: Vec<String> = Vec::new();
        match self.resolve_head(&sha).await {
            Ok(commit) => return Ok(commit),
            Err(detail) => failures.push(format!("local objects: {detail}")),
        }
        if sha.len() == 40 || sha.len() == 64 {
            match self.fetch_and_resolve(&sha, &sha).await {
                Ok(commit) => return Ok(commit),
                Err(detail) => failures.push(format!("the commit: {detail}")),
            }
        }
        let branch_ref = format!("refs/heads/{branch}");
        let by_branch = async {
            git(
                "PullRequestReviewGuideService.checkHeadBranch",
                self.workspace,
                &["check-ref-format", &branch_ref],
                None,
            )
            .await?;
            self.fetch_and_resolve(&branch_ref, &sha).await
        };
        match by_branch.await {
            Ok(commit) => return Ok(commit),
            Err(detail) => failures.push(format!("branch {branch}: {detail}")),
        }
        // GitHub's `changeRequestHeadRef`.
        let head_ref = format!("refs/pull/{number}/head");
        match self.fetch_and_resolve(&head_ref, &sha).await {
            Ok(commit) => return Ok(commit),
            Err(detail) => failures.push(format!("{head_ref}: {detail}")),
        }
        Err(format!(
            "Could not find head {sha} of #{number}. {}",
            failures.join(" ")
        ))
    }

    async fn fetch_and_resolve(&self, refspec: &str, sha: &str) -> Result<String, String> {
        self.fetch(refspec).await?;
        self.resolve_head(sha).await
    }
}

/// The parts of `checkoutHead` that need no answer from the model.
struct Prepared {
    checkout: Checkout,
    base_commit: String,
    stack: Vec<StackLayer>,
}

/// `checkoutHead`.
async fn checkout_head(
    project: &Project,
    worktrees: &Path,
    detail: &Value,
    head_sha: &str,
    stack: &Value,
    run_id: u64,
) -> Result<Prepared, String> {
    let workspace = project.root.as_path();
    let names = git(
        "PullRequestReviewGuideService.listRemotes",
        workspace,
        &["remote"],
        None,
    )
    .await?;
    let mut candidates: Vec<String> = project.remote_name.iter().cloned().collect();
    candidates.extend(
        names
            .lines()
            .filter(|n| !n.is_empty() && project.remote_name.as_deref() != Some(*n))
            .map(str::to_owned),
    );
    let mut remote = None;
    for name in candidates {
        let url = git(
            "PullRequestReviewGuideService.remoteUrl",
            workspace,
            &["remote", "get-url", "--", &name],
            None,
        )
        .await;
        if url.is_ok_and(|u| u.trim() == project.remote_url) {
            remote = Some(name);
            break;
        }
    }
    let Some(remote) = remote else {
        return Err(failed(
            "This project's checkout no longer has a remote for the pull request's repository.",
        ));
    };
    let base_branch = text(detail, "baseBranch");
    let checked = git(
        "PullRequestReviewGuideService.checkBaseBranch",
        workspace,
        &["check-ref-format", "--branch", base_branch],
        None,
    )
    .await?;
    let _ = checked;
    if base_branch.starts_with('+') || base_branch.contains(':') {
        return Err(failed(
            "The pull request's base branch name is not one git can fetch.",
        ));
    }
    let fetcher = Fetcher { workspace, remote };
    let mut checkout = Checkout {
        workspace: workspace.to_owned(),
        base_ref: format!("refs/t3/review-guide/{run_id}/base"),
        directory: None,
        path: PathBuf::new(),
        added: false,
    };
    let result = async {
        fetcher
            .fetch(&format!("+refs/heads/{base_branch}:{}", checkout.base_ref))
            .await?;
        let base_tip = resolve_commit(workspace, &checkout.base_ref).await?;
        let number = detail.get("number").and_then(Value::as_u64).unwrap_or(0);
        let head = fetcher
            .head(number, head_sha, text(detail, "headBranch"))
            .await?;
        let mut layers = Vec::new();
        for layer in stack
            .get("layers")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let layer_number = layer.get("number").and_then(Value::as_u64).unwrap_or(0);
            let head_sha = if layer_number == number {
                Some(head_sha.to_owned())
            } else if let Some(sha) = layer.get("headSha").and_then(Value::as_str) {
                fetcher
                    .head(layer_number, sha, text(layer, "headBranch"))
                    .await
                    .ok()
            } else {
                None
            };
            layers.push(StackLayer {
                number: layer_number,
                title: layer
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                head_sha,
                state: text(layer, "state").to_owned(),
            });
        }
        let worktrees = worktrees.to_owned();
        let directory = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&worktrees)?;
            let suffix = conn_support::uuid_v4().replace('-', "");
            let directory = worktrees.join(format!(
                "review-guide-{}",
                suffix.get(..12).unwrap_or(&suffix)
            ));
            std::fs::create_dir(&directory).map(|()| directory)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not create the review guide checkout: {e}"))?;
        checkout.path = directory.join("checkout");
        checkout.directory = Some(directory);
        let path = checkout.path.to_string_lossy().into_owned();
        // A scratch checkout for reading the change: repository hooks only slow or fail it.
        git(
            "PullRequestReviewGuideService.addWorktree",
            workspace,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "worktree",
                "add",
                "--detach",
                "--quiet",
                &path,
                &head,
            ],
            Some(CHECKOUT_TIMEOUT),
        )
        .await?;
        checkout.added = true;
        let merge_base = git(
            "PullRequestReviewGuideService.mergeBase",
            &checkout.path,
            &["merge-base", &base_tip, "HEAD"],
            None,
        )
        .await?;
        Ok::<_, String>((merge_base.trim().to_owned(), layers))
    }
    .await;
    match result {
        Ok((base_commit, stack)) => Ok(Prepared {
            checkout,
            base_commit,
            stack,
        }),
        Err(detail) => {
            checkout.drop_all().await;
            Err(detail)
        }
    }
}

/// `readChange`: the changed files and their hunks in `base...HEAD`.
async fn read_change(cwd: &Path, base: &str) -> Result<review_guide::Change, String> {
    let range = format!("{base}...HEAD");
    let diff = |extra: &'static [&'static str]| {
        let mut args: Vec<&str> = vec!["-c", "core.quotePath=false", "diff"];
        args.extend(PATCH_PREFIX_ARGS);
        args.extend(extra);
        args.push(&range);
        let command = GitCommand::new(
            "PullRequestReviewGuideService.readChange",
            cwd,
            args.iter().copied(),
        )
        .timeout(DIFF_TIMEOUT)
        .max_stdout(DIFF_MAX_BYTES, OnLimit::Fail);
        async move { command.text().await.map_err(|e| git_detail(&e)) }
    };
    let (names, patch) = tokio::join!(
        diff(&["--name-only", "-z"]),
        diff(&[
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv"
        ])
    );
    Ok(review_guide::parse_change(&names?, &patch?))
}

/// `resolveReviewGuideModelSelection`: the guide model when it is set, enabled and not a text
/// generator; else the source control writer; else the text generation model.
fn guide_selection(
    panel: &Panel,
    settings: &serde_json::Map<String, Value>,
    project: &str,
) -> Value {
    let generator = |id: &str| {
        panel
            .text_generators
            .as_ref()
            .is_some_and(|g| g.config(id).is_some())
    };
    let usable = |id: &str| generator(id) || panel.providers.get(id).is_some();
    let pick = |key: &str, generator_ok: bool| {
        title::project_override(settings, Some(project), key)
            .or_else(|| settings.get(key))
            .filter(|s| !s.is_null())
            .filter(|s| {
                s.get("instanceId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| {
                        (generator_ok || !generator(id))
                            && title::selection_enabled(settings, Some(project), id)
                            && usable(id)
                    })
            })
            .cloned()
    };
    let mut selection = pick("reviewGuideModelSelection", false)
        .or_else(|| pick("sourceControlWriterModelSelection", true))
        .unwrap_or_else(|| title::title_model_selection(settings, Some(project)).2);
    // The settings here are sparse; T3 reads the default selection with its model.
    if selection["instanceId"] == "codex"
        && selection["model"]
            .as_str()
            .is_none_or(|m| m.trim().is_empty())
    {
        selection["model"] = json!(prompts::DEFAULT_TEXT_GENERATION_MODEL);
    }
    // `TextGeneration.generate`: a text generator cannot read the checkout, so the first ready
    // investigating agent writes the guide (`fallbackTextGenerationModelSelection`: default
    // instances first, then configured ones; the thread default's custom model first on its
    // instance). Any other selection runs as chosen, as in T3.
    let chosen = selection["instanceId"]
        .as_str()
        .unwrap_or("codex")
        .to_owned();
    if generator(&chosen) {
        let defaults = prompts::INVESTIGATING_DEFAULT_MODELS;
        let mut candidates: Vec<(String, &str)> = defaults
            .iter()
            .map(|(driver, _)| ((*driver).to_owned(), *driver))
            .collect();
        for provider in panel.providers.snapshot() {
            let driver = provider.driver();
            if let Some((d, _)) = defaults.iter().find(|(d, _)| *d == driver) {
                candidates.push((provider.instance_id().to_string(), d));
            }
        }
        // T3's usability check on the provider's status entry: enabled, installed, signed in,
        // not failing.
        let ready = |id: &str, driver: &str| {
            panel.providers.get(id).is_some_and(|p| {
                p.driver() == driver
                    && p.server_provider_entry("").is_some_and(|entry| {
                        entry["enabled"] == true
                            && entry["installed"] == true
                            && entry.pointer("/auth/status") != Some(&json!("unauthenticated"))
                            && entry["status"] != "error"
                    })
            })
        };
        let thread_default = settings
            .get("defaultModelSelection")
            .filter(|d| d.is_object());
        for (id, driver) in candidates {
            if id == chosen
                || generator(&id)
                || !title::selection_enabled(settings, Some(project), &id)
                || !ready(&id, driver)
            {
                continue;
            }
            if let Some(default) = thread_default.filter(|d| {
                d["instanceId"] == id.as_str()
                    && settings
                        .get("providerInstances")
                        .and_then(|i| i.get(&id))
                        .and_then(|i| i.pointer("/config/customModels"))
                        .and_then(Value::as_array)
                        .is_some_and(|models| {
                            // `readCustomModelEntries`: a string or `{slug}`, trimmed.
                            models.iter().any(|m| {
                                m.as_str()
                                    .or_else(|| m.get("slug").and_then(Value::as_str))
                                    .map(str::trim)
                                    .filter(|slug| !slug.is_empty())
                                    .is_some_and(|slug| Some(slug) == d["model"].as_str())
                            })
                        })
            }) {
                return default.clone();
            }
            if let Some((_, model)) = defaults.iter().find(|(d, _)| *d == driver) {
                return json!({"instanceId": id, "model": model});
            }
        }
    }
    selection
}

/// `TextGeneration.generateReviewGuide`: only an agent that can read the checkout writes it.
async fn generate(
    panel: &Panel,
    selection: &Value,
    cwd: &Path,
    prompt: String,
) -> Result<review_guide::Generated, String> {
    let instance = selection
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or("codex");
    if panel
        .text_generators
        .as_ref()
        .is_some_and(|g| g.config(instance).is_some())
    {
        return Err("Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control & issues.".into());
    }
    let provider = panel
        .providers
        .get(instance)
        .ok_or_else(|| format!("No provider instance registered for id '{instance}'."))?;
    let (label, investigates) = match provider.driver() {
        "codex" => ("Codex", true),
        "claudeAgent" => ("Claude", true),
        other => (other, INVESTIGATING_DRIVERS.contains(&other)),
    };
    if !investigates {
        return Err(format!(
            "{label} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set."
        ));
    }
    let request = conn_provider::TextGenerationRequest {
        operation: "generateReviewGuide".into(),
        cwd: cwd.to_string_lossy().into_owned(),
        prompt,
        output_schema: prompts::REVIEW_GUIDE_OUTPUT_SCHEMA.into(),
        model_selection: conn_contract::from_json(selection.clone()).map_err(|e| e.to_string())?,
        image_paths: Vec::new(),
        timeout: Some(INVESTIGATION_TIMEOUT),
        investigate: true,
    };
    let output = match provider.generate_text(request).await {
        Ok(value) => value,
        Err(conn_provider::ProviderError::Failed { detail, .. }) => return Err(detail),
        Err(conn_provider::ProviderError::Unsupported { .. }) => {
            return Err(format!(
                "{label} cannot investigate a checkout read-only. Choose another review guide model, or source control writer model when none is set."
            ));
        }
        Err(error) => return Err(error.to_string()),
    };
    let value = match output {
        Value::String(text) => serde_json::from_str(&prompts::extract_json_object(&text))
            .map_err(|_| format!("{label} returned invalid structured output."))?,
        other => other,
    };
    review_guide::decode_generated(&value)
        .ok_or_else(|| format!("{label} returned invalid structured output."))
}

/// What one run needs, read when it was claimed.
struct Job {
    key: String,
    run_id: u64,
    project: Project,
    client: Client,
    lookup: Lookup,
    detail: Value,
    head_sha: String,
    store: PathBuf,
}

/// `write`: everything after the claim, in the background.
async fn write(panel: Arc<Panel>, job: Job) -> Result<(), String> {
    let settings = panel
        .environment
        .as_ref()
        .map(|e| e.settings.raw())
        .unwrap_or_default();
    let (activity, stack) = tokio::join!(
        job.client.activity(&job.lookup),
        job.client.stack(&job.lookup)
    );
    let activity = activity.map_err(|e| {
        e.to_contract("activity")["detail"].as_str().map_or_else(
            || "The review guide could not be written.".to_owned(),
            str::to_owned,
        )
    })?;
    let stack = stack.unwrap_or(Value::Null);
    let selection = guide_selection(&panel, &settings, &job.project.id);
    let instructions =
        title::project_override(&settings, Some(&job.project.id), "reviewGuideInstructions")
            .or_else(|| settings.get("reviewGuideInstructions"))
            .and_then(Value::as_str)
            .map(str::to_owned);
    // T3's server-managed `worktreesDir` (`<base>/worktrees`), not the user's setting.
    let worktrees = panel
        .environment
        .as_ref()
        .map_or_else(std::env::temp_dir, |e| {
            // `<base>/worktrees`: the state folder is `<base>/userdata` unless named directly.
            let base = if e.state_dir.file_name().is_some_and(|n| n == "userdata") {
                e.state_dir.parent().unwrap_or(&e.state_dir)
            } else {
                &e.state_dir
            };
            base.join("worktrees")
        });
    let prepared = checkout_head(
        &job.project,
        &worktrees,
        &job.detail,
        &job.head_sha,
        &stack,
        job.run_id,
    )
    .await?;
    let input = ReviewGuidePromptInput {
        number: job
            .detail
            .get("number")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        title: text(&job.detail, "title").to_owned(),
        description: text(&job.detail, "body").to_owned(),
        base_branch: text(&job.detail, "baseBranch").to_owned(),
        base_commit: prepared.base_commit.clone(),
        settled_review: review_guide::settled_review(&activity),
        instructions,
        stack: prepared.stack.clone(),
    };
    let prompt = prompts::review_guide_prompt(&input);
    let path = prepared.checkout.path.clone();
    let (generated, change) = tokio::join!(
        generate(&panel, &selection, &path, prompt),
        read_change(&path, &prepared.base_commit)
    );
    prepared.checkout.drop_all().await;
    let normalized = review_guide::normalize(generated?, &change?);
    let mut guide = json!({
        "headSha": job.head_sha,
        "generatedAt": conn_support::time::now_iso(),
        "modelSelection": selection,
    });
    if let (Some(object), Ok(Value::Object(rest))) =
        (guide.as_object_mut(), serde_json::to_value(&normalized))
    {
        object.extend(rest);
    }
    let _owner = panel.guide_runs.ownership.lock().await;
    if panel.guide_runs.owns(&job.key, job.run_id) {
        let (host, repository, number) = split_key(&job.key);
        guides::store(job.store, host, repository, number, guide)
            .await
            .map_err(|_| "The review guide could not be written.".to_owned())?;
    }
    Ok(())
}

fn split_key(key: &str) -> (String, String, u32) {
    let (rest, number) = key.rsplit_once('#').unwrap_or((key, "0"));
    let (host, repository) = rest.split_once('/').unwrap_or((rest, ""));
    (
        host.to_owned(),
        repository.to_owned(),
        number.parse().unwrap_or(0),
    )
}

impl Panel {
    /// `PullRequestReviewGuideService.generate`.
    pub(super) async fn write_review_guide(
        self: &Arc<Self>,
        input: &Value,
    ) -> Result<Value, Failure> {
        // `reviewGuidesEnabled` defaults to false; the settings here are sparse.
        let off = self.environment.as_ref().is_none_or(|environment| {
            environment.settings.for_client().get("reviewGuidesEnabled") != Some(&Value::Bool(true))
        });
        if off {
            return Err(operation_error(
                "generateReviewGuide",
                "Review guides are off. Turn them on in Settings → Source control & issues.",
            ));
        }
        let Some(environment) = self.environment.clone() else {
            return Err(operation_error(
                "generateReviewGuide",
                "This server cannot generate review guides yet.",
            ));
        };
        let unidentified = || {
            operation_error(
                "reviewGuide",
                "Could not identify this pull request's host.",
            )
        };
        let own = self
            .projects(&json!({"projectId": input.get("projectId")}))
            .await
            .map_err(|_| unidentified())?;
        let Some(project) = own.into_iter().next() else {
            return Err(unidentified());
        };
        let key = super::thread_key(input, &project.host).ok_or_else(unidentified)?;
        // `requireOwnRepository`.
        if key.host != project.host || !key.repository.eq_ignore_ascii_case(&project.repository) {
            return Err(operation_error(
                "generateReviewGuide",
                "Guides are written from this project's checkout, and this pull request is in another repository. Write it from a project that is a checkout of that repository.",
            ));
        }
        let run_key = key.text();
        self.invalidate(Some(input), false).await;
        let client = self.client(&project, "generateReviewGuide").await?;
        let lookup = Lookup::new(&project.repository, key.number)
            .map_err(|error| super::host_error(&error, "detail"))?;
        let paths = vec![
            environment.state_dir.join(guides::OWN_FILE),
            environment.state_dir.join("statev2.sqlite"),
        ];
        let (detail, stored) = tokio::join!(
            client.detail(&lookup),
            guides::load(
                paths,
                key.host.clone(),
                key.repository.clone(),
                u32::try_from(key.number).unwrap_or(0)
            )
        );
        let detail = detail.map_err(|error| super::host_error(&error, "detail"))?;
        let stored = stored?;
        let Some(head) = detail
            .get("headSha")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Err(operation_error(
                "generateReviewGuide",
                "This host did not report the pull request's head commit.",
            ));
        };
        let running =
            json!({"_tag": "Running", "headSha": head, "startedAt": conn_support::time::now_iso()});
        // Claim under the lock, with the head read again, so a stale click cannot replace a
        // newer head's run.
        let (run_id, claimed, started) = {
            let _owner = self.guide_runs.ownership.lock().await;
            let latest = client
                .detail(&lookup)
                .await
                .map_err(|error| super::host_error(&error, "detail"))?;
            if latest.get("headSha").and_then(Value::as_str) != Some(head.as_str()) {
                return Err(operation_error(
                    "generateReviewGuide",
                    "The pull request changed while the guide was starting. Try again.",
                ));
            }
            let mut runs = self
                .guide_runs
                .runs
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match runs.get(&run_key) {
                Some(run)
                    if run.value["_tag"] == "Running" && run.value["headSha"] == head.as_str() =>
                {
                    (run.id, run.value.clone(), false)
                }
                _ => {
                    let id = self.guide_runs.next.fetch_add(1, Ordering::Relaxed);
                    runs.insert(
                        run_key.clone(),
                        Run {
                            id,
                            value: running.clone(),
                        },
                    );
                    (id, running.clone(), true)
                }
            }
        };
        // The claim itself says whether this request started the run: two requests in one
        // millisecond build equal `Running` values.
        if !started {
            return Ok(
                json!({"guide": stored, "run": claimed, "currentHeadSha": head, "started": false}),
            );
        }
        let current = detail.get("headSha").cloned();
        let job = Job {
            key: run_key.clone(),
            run_id,
            project,
            client,
            lookup,
            detail,
            head_sha: head.clone(),
            store: environment.state_dir.join(guides::OWN_FILE),
        };
        let panel = Arc::clone(self);
        tokio::spawn(async move {
            let result = write(Arc::clone(&panel), job).await;
            let next = result.err().map(|detail| {
                json!({"_tag": "Failed", "headSha": head, "failedAt": conn_support::time::now_iso(), "detail": detail})
            });
            panel.guide_runs.finish(&run_key, run_id, next);
        });
        Ok(json!({"guide": stored, "run": running, "currentHeadSha": current, "started": true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_runs_are_bounded_and_running_ones_stay() {
        let runs = Runs::default();
        {
            let mut map = runs.runs.lock().expect("lock");
            map.insert(
                "keep".into(),
                Run {
                    id: 0,
                    value: json!({"_tag": "Running"}),
                },
            );
            for i in 1..=300_u64 {
                map.insert(
                    format!("k{i}"),
                    Run {
                        id: i,
                        value: json!({"_tag": "Running"}),
                    },
                );
            }
        }
        for i in 1..=300_u64 {
            runs.finish(&format!("k{i}"), i, Some(json!({"_tag": "Failed"})));
        }
        let map = runs.runs.lock().expect("lock");
        assert_eq!(map.len(), MAX_FINISHED_RUNS + 1);
        assert!(map.contains_key("keep"));
        assert!(!map.contains_key("k1"));
        assert!(map.contains_key("k300"));
    }

    #[test]
    fn a_newer_run_is_not_ended_by_an_older_one() {
        let runs = Runs::default();
        runs.runs.lock().expect("lock").insert(
            "k".into(),
            Run {
                id: 2,
                value: json!({"_tag": "Running"}),
            },
        );
        runs.finish("k", 1, None);
        assert_eq!(runs.get("k")["_tag"], "Running");
        runs.finish("k", 2, None);
        assert_eq!(runs.get("k"), Value::Null);
    }
}
