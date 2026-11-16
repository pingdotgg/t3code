//! GitHub pull request checkout and the container's commit action.
use super::Deps;
use crate::table::{Failure, ItemStream, MethodTable};
use conn_contract::{
    GitPreparePullRequestThreadInput, GitPullRequestRefInput, GitResolvePullRequestResult,
    GitRunStackedActionInput, GitStackedAction,
};
use conn_source_control::{
    checkout,
    hosts::{DiscoveryContext, Endpoints, Environment},
    settings::Settings,
};
use conn_vcs::{commit, repo};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, Semaphore, mpsc};

pub(super) fn manager(cwd: &str, detail: &str) -> Failure {
    Failure::Fail(
        json!({"_tag":"GitManagerError","operation":"runStackedAction","cwd":cwd,"detail":detail}),
    )
}
fn vcs(error: conn_vcs::VcsError) -> Failure {
    Failure::fail(&error.to_git_command_error())
}

async fn ensure_git(cwd: &str, operation: &str) -> Result<(), Failure> {
    if repo::toplevel(Path::new(cwd)).await.map_err(vcs)?.is_some() {
        return Ok(());
    }
    Err(Failure::Fail(
        json!({"_tag":"GitManagerError","operation":operation,"cwd":cwd,"detail":"Failed to resolve the VCS driver for this Git workflow."}),
    ))
}

fn settings(deps: &Deps, project: Option<&str>) -> Settings {
    let mut raw = deps
        .environment
        .as_ref()
        .map(|e| e.settings.raw())
        .unwrap_or_default();
    if let Some(value) = project
        .and_then(|id| {
            raw.get("projectSettingsOverrides")?
                .get(id)?
                .get("worktreeSubmodules")
        })
        .filter(|v| !v.is_null())
        .cloned()
    {
        raw.insert("worktreeSubmodules".into(), value);
    }
    Settings::new(raw)
}

pub(super) async fn project_id(
    deps: &Deps,
    cwd: &str,
    thread: Option<&str>,
    explicit: Option<&str>,
) -> Option<String> {
    if let Some(engine) = &deps.engine
        && let Some(thread) = thread
        && let Ok(projection) = engine.get_thread_projection(thread.into()).await
        && let Some(id) = projection
            .pointer("/thread/projectId")
            .and_then(Value::as_str)
    {
        return Some(id.into());
    }
    if let Some(id) = explicit {
        return Some(id.into());
    }
    let shell = deps.engine.as_ref()?.shell_snapshot().await.ok()?;
    shell
        .get("projects")?
        .as_array()?
        .iter()
        .find(|p| {
            p.get("workspaceRoot").and_then(Value::as_str) == Some(cwd)
                && p.get("deletedAt").is_none_or(Value::is_null)
        })?
        .get("id")?
        .as_str()
        .map(str::to_owned)
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    // Serialize our checkout mutations without retaining a map of every repository visited.
    let lease = Arc::new(Mutex::new(()));
    let d = deps.clone();
    table.unary(
        "git.resolvePullRequest",
        move |_, input: GitPullRequestRefInput| {
            let d = d.clone();
            async move {
                ensure_git(&input.cwd, "GitWorkflowService.resolvePullRequest").await?;
                let settings = settings(&d, None);
                let env = Environment::process();
                let endpoints = Endpoints::default();
                let home = std::env::var_os("HOME").map(PathBuf::from);
                let ctx = DiscoveryContext {
                    cwd: Path::new(&input.cwd),
                    home: home.as_deref(),
                    settings: &settings,
                    env: &env,
                    endpoints: &endpoints,
                    child_env: &[],
                };
                let pr = checkout::resolve(ctx, Path::new(&input.cwd), &input.reference)
                    .await
                    .map_err(|e| Failure::Fail(e.to_contract()))?;
                Ok(GitResolvePullRequestResult {
                    pull_request: pr.resolved,
                })
            }
        },
    );
    let d = deps.clone();
    let lock = lease.clone();
    table.unary(
        "git.preparePullRequestThread",
        move |_, input: GitPreparePullRequestThreadInput| {
            let d = d.clone();
            let lock = lock.clone();
            async move {
                let _lease = lock.lock().await;
                ensure_git(&input.cwd, "GitWorkflowService.preparePullRequestThread").await?;
                let project = project_id(&d, &input.cwd, input.thread_id.as_deref(), None).await;
                let settings = settings(&d, project.as_deref());
                let env = Environment::process();
                let endpoints = Endpoints::default();
                let home = std::env::var_os("HOME").map(PathBuf::from);
                let dir = d
                    .environment
                    .as_deref()
                    .map(crate::host::worktrees_dir)
                    .unwrap_or_else(|| std::env::temp_dir().join("conn-server-worktrees"));
                let ctx = DiscoveryContext {
                    cwd: Path::new(&input.cwd),
                    home: home.as_deref(),
                    settings: &settings,
                    env: &env,
                    endpoints: &endpoints,
                    child_env: &[],
                };
                let result = checkout::prepare(ctx, &input, &dir).await;
                if let Ok((result, true)) = &result
                    && let (Some(mcp), Some(thread), Some(path)) =
                        (&d.mcp, &input.thread_id, &result.worktree_path)
                    && let Err(error) = mcp.run_worktree_setup(thread, path).await
                {
                    eprintln!("pull request worktree setup failed: {error}");
                }
                let _ = d.vcs.hub.refresh_local(&input.cwd).await;
                result
                    .map(|(result, _)| result)
                    .map_err(|e| Failure::Fail(e.to_contract()))
            }
        },
    );
    let d = deps.clone();
    let slots = Arc::new(Semaphore::new(16));
    table.stream(
        "git.runStackedAction",
        move |_, input: GitRunStackedActionInput| {
            let d = d.clone();
            let lock = lease.clone();
            let permit = slots.clone().try_acquire_owned();
            async move {
                let permit =
                    permit.map_err(|_| manager(&input.cwd, "Too many Git actions are running."))?;
                let (tx, rx) = mpsc::channel(16);
                tokio::spawn(async move {
                    let _permit = permit;
                    let _lease = tokio::select! {lease=lock.lock()=>lease, ()=tx.closed()=>return};
                    let mut phase = None;
                    let result = run_commit(&d, &input, &tx, &mut phase).await;
                    if let Err(error) = result {
                        let message = match &error {
                            Failure::Fail(value) => {
                                let detail = value
                                    .get("detail")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Git action failed.");
                                let operation = value
                                    .get("operation")
                                    .and_then(Value::as_str)
                                    .unwrap_or("runStackedAction");
                                match value.get("_tag").and_then(Value::as_str) {
                                    Some("TextGenerationError") => {
                                        format!("Text generation failed in {operation}: {detail}")
                                    }
                                    Some("GitCommandError") => format!(
                                        "Git command failed in {operation} ({}): {detail}",
                                        input.cwd
                                    ),
                                    _ => format!("Git manager failed in {operation}: {detail}"),
                                }
                            }
                            Failure::Die(_) => "Git action is not supported.".into(),
                        };
                        send(
                            &tx,
                            &input,
                            json!({"kind":"action_failed","phase":phase,"message":message}),
                        )
                        .await;
                        let _ = tx.send(Err(error)).await;
                    }
                    let _ = d.vcs.hub.refresh_local(&input.cwd).await;
                });
                Ok::<ItemStream, Failure>(rx)
            }
        },
    );
}

async fn send(
    tx: &mpsc::Sender<Result<Value, Failure>>,
    input: &GitRunStackedActionInput,
    mut event: Value,
) {
    if let Some(object) = event.as_object_mut() {
        object.insert("actionId".into(), json!(input.action_id));
        object.insert("cwd".into(), json!(input.cwd));
        object.insert("action".into(), json!(input.action));
    }
    let _ = tx.send(Ok(event)).await;
}

async fn run_commit(
    deps: &Deps,
    input: &GitRunStackedActionInput,
    tx: &mpsc::Sender<Result<Value, Failure>>,
    phase: &mut Option<&str>,
) -> Result<(), Failure> {
    ensure_git(&input.cwd, "GitWorkflowService.runStackedAction").await?;
    if input.action != GitStackedAction::Commit {
        return Err(Failure::Die(conn_wire::error_defect(
            "ConnServerNotSupported",
            "conn-server does not support push or pull request creation in git.runStackedAction; use Orbit",
        )));
    }
    let cwd = Path::new(&input.cwd);
    let feature = input.feature_branch == Some(true);
    let phases = if feature {
        json!(["branch", "commit"])
    } else {
        json!(["commit"])
    };
    send(tx, input, json!({"kind":"action_started","phases":phases})).await;
    *phase = Some(if feature { "branch" } else { "commit" });
    let custom_message = input
        .commit_message
        .as_deref()
        .filter(|message| !message.trim().is_empty());
    let context =
        commit::prepare_context(cwd, input.file_paths.as_deref(), custom_message.is_none())
            .await
            .map_err(vcs)?;
    let mut branch_step = json!({"status":"skipped_not_requested"});
    let commit_step = if let Some(context) = context {
        let branch = repo::current_branch(cwd).await.map_err(vcs)?;
        if feature {
            send(tx,input,json!({"kind":"phase_started","phase":"branch","label":"Preparing feature branch..."})).await;
        }
        let (subject, body, suggested) = if let Some(message) = custom_message {
            let normalized = message.replace("\r\n", "\n");
            let (subject, body) = normalized
                .trim()
                .split_once('\n')
                .unwrap_or((normalized.trim(), ""));
            (subject.trim().to_owned(), body.trim().to_owned(), None)
        } else {
            send(tx,input,json!({"kind":"phase_started","phase":"commit","label":"Generating commit message..."})).await;
            super::git_message::generate(deps, input, branch.as_deref(), &context, feature).await?
        };
        if feature {
            let fragment = checkout::branch_fragment(suggested.as_deref().unwrap_or(&subject));
            let base = if fragment.contains('/') {
                fragment
            } else {
                format!("feature/{fragment}")
            };
            let names = conn_vcs::process::GitCommand::new(
                "GitManager.runFeatureBranchStep",
                cwd,
                ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"],
            )
            .text()
            .await
            .map_err(|e| vcs(e.into()))?;
            let names = names.lines().map(str::to_lowercase).collect::<Vec<_>>();
            let mut branch = String::new();
            for part in base.split('/') {
                let prefix = if branch.is_empty() {
                    part.into()
                } else {
                    format!("{branch}/{part}")
                };
                let mut candidate = prefix.clone();
                for n in 2..=names.len().saturating_add(2) {
                    if !names.iter().any(|name| {
                        name == &candidate || name.starts_with(&format!("{candidate}/"))
                    }) {
                        break;
                    }
                    candidate = format!("{prefix}-{n}");
                }
                branch = candidate;
            }
            conn_vcs::process::GitCommand::new(
                "GitManager.runFeatureBranchStep",
                cwd,
                ["checkout", "-b", &branch, "--"],
            )
            .run()
            .await
            .map_err(|e| vcs(e.into()))?;
            branch_step = json!({"status":"created","name":branch});
        }
        *phase = Some("commit");
        send(
            tx,
            input,
            json!({"kind":"phase_started","phase":"commit","label":"Committing..."}),
        )
        .await;
        let sha = commit::create(cwd, &subject, &body, input.file_paths.as_deref())
            .await
            .map_err(vcs)?;
        json!({"status":"created","commitSha":sha,"subject":subject})
    } else {
        if feature {
            return Err(manager(
                &input.cwd,
                "Cannot create a feature branch because there are no changes to commit.",
            ));
        }
        json!({"status":"skipped_no_changes"})
    };
    let toast = if let Some(sha) = commit_step.get("commitSha").and_then(Value::as_str) {
        let short = sha.chars().take(7).collect::<String>();
        json!({"title":format!("Committed {short}"),"description":commit_step.get("subject"),"cta":{"kind":"run_action","label":"Push","action":{"kind":"push"}}})
    } else {
        json!({"title":"Done","cta":{"kind":"none"}})
    };
    send(tx,input,json!({"kind":"action_finished","result":{"action":input.action,"branch":branch_step,"commit":commit_step,"push":{"status":"skipped_not_requested"},"pr":{"status":"skipped_not_requested"},"toast":toast}})).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::{CallContext, Handler};

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().into()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn commit_stream_finishes_and_never_pushes() {
        let root =
            std::env::temp_dir().join(format!("conn-commit-rpc-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "test"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("file"), "text").unwrap();
        let mut table = MethodTable::new();
        register(&mut table, &Deps::default());
        let Some(Handler::Stream(handler)) = table.get("git.runStackedAction") else {
            panic!("stream missing")
        };
        let mut stream=handler(CallContext::default(),json!({"cwd":root,"actionId":"a","action":"commit","commitMessage":"feat: change\n\nBody"})).await.unwrap();
        let mut events = Vec::new();
        while let Some(event) = stream.recv().await {
            events.push(event.unwrap());
        }
        assert_eq!(events.first().unwrap()["kind"], "action_started");
        let result = events.last().unwrap().get("result").unwrap();
        assert_eq!(result["commit"]["status"], "created");
        assert_eq!(result["push"]["status"], "skipped_not_requested");
        assert_eq!(git(&root, &["log", "-1", "--format=%s"]), "feat: change");
        std::fs::write(root.join("file"), "changed").unwrap();
        let mut feature=handler(CallContext::default(),json!({"cwd":root,"actionId":"feature","action":"commit","commitMessage":"Fix selected file","featureBranch":true})).await.unwrap();
        let mut finished = None;
        while let Some(event) = feature.recv().await {
            let event = event.unwrap();
            if event["kind"] == "action_finished" {
                finished = Some(event);
            }
        }
        assert_eq!(
            finished.unwrap()["result"]["branch"]["name"],
            "feature/fix-selected-file"
        );
        let head = git(&root, &["rev-parse", "HEAD"]);
        for action in ["push", "create_pr", "commit_push", "commit_push_pr"] {
            let mut stream = handler(
                CallContext::default(),
                json!({"cwd":root,"actionId":"a","action":action}),
            )
            .await
            .unwrap();
            let mut refused = false;
            while let Some(event) = stream.recv().await {
                refused |= event.is_err();
            }
            assert!(refused);
            assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
