//! Worktree inspection and a guarded move of the calling thread's workspace.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use conn_contract::{VcsListRefsInput, from_json, to_json};
use conn_vcs::{
    refs, repo,
    worktree::{self, CreateWorktree, Removal},
};
use serde_json::{Value, json};

use super::{Args, Cx, ToolError, ToolResult, bool_arg, fail, internal, str_arg};
use crate::{McpService, WorktreeConfig};

fn failure(code: &'static str, message: impl Into<String>) -> ToolError {
    ToolError::Worktree {
        code,
        message: message.into(),
    }
}

fn operation(prefix: &str, error: impl std::fmt::Display) -> ToolError {
    failure("operation_failed", format!("{prefix}: {error}"))
}

fn config<'a>(cx: &'a Cx<'_>) -> Result<&'a WorktreeConfig, ToolError> {
    cx.config().worktrees.as_ref().ok_or_else(|| {
        failure(
            "capability_denied",
            "This MCP credential does not grant worktree capabilities.",
        )
    })
}

pub(super) async fn project(cx: &Cx<'_>, thread: &Value) -> ToolResult {
    let shell = cx.shell().await?;
    shell["projects"]
        .as_array()
        .and_then(|p| {
            p.iter()
                .find(|p| p["id"] == thread["projectId"] && p["deletedAt"].is_null())
        })
        .cloned()
        .ok_or_else(|| {
            failure(
                "project_not_found",
                format!(
                    "Project '{}' was not found for thread '{}'.",
                    thread["projectId"].as_str().unwrap_or_default(),
                    thread["id"].as_str().unwrap_or_default()
                ),
            )
        })
}

async fn load(cx: &Cx<'_>) -> ToolResult {
    let caller = cx.require_thread("conn_worktree_status")?;
    cx.projection(&caller.thread_id).await.map_err(|e| match e {
        ToolError::Failure {
            code: "thread_not_found",
            ..
        } => failure(
            "thread_not_found",
            format!("Thread '{}' was not found.", caller.thread_id),
        ),
        other => other,
    })
}

fn default_origin(config: &WorktreeConfig, project: &Value) -> bool {
    let settings = (config.settings)();
    settings["projectSettingsOverrides"][project["id"].as_str().unwrap_or_default()]["newWorktreesStartFromOrigin"].as_bool()
        .or_else(|| settings["newWorktreesStartFromOrigin"].as_bool()).unwrap_or(true)
}

pub(super) async fn status(cx: &Cx<'_>) -> ToolResult {
    let config = config(cx)?;
    let projection = load(cx).await?;
    let thread = &projection["thread"];
    let project = project(cx, thread).await?;
    Ok(
        json!({"attached":!thread["worktreePath"].is_null(),"worktreePath":thread["worktreePath"],"branch":thread["branch"],
        "projectWorkspaceRoot":project["workspaceRoot"],"defaultStartFromOrigin":default_origin(config,&project)}),
    )
}

pub(super) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    if cx.config().worktrees.is_none() {
        return Err(fail(
            "capability_denied",
            "This credential cannot inspect worktrees.",
        ));
    }
    let id = str_arg(args, "threadId")
        .or_else(|| cx.caller_thread_id())
        .ok_or_else(|| {
            fail(
                "target_required",
                "Pass threadId: this MCP client is not running inside a Conn thread.",
            )
        })?;
    let projection = cx.projection(id).await?;
    let project = project(cx, &projection["thread"])
        .await
        .map_err(|_| fail("invalid_request", "The project was not found."))?;
    let root = project["workspaceRoot"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let path = projection["thread"]["worktreePath"]
        .as_str()
        .map(str::to_owned);
    let cwd =
        tokio::task::spawn_blocking(move || path.filter(|p| Path::new(p).exists()).unwrap_or(root))
            .await
            .map_err(internal)?;
    let mut input = Value::Object(args.clone());
    if let Some(map) = input.as_object_mut() {
        map.remove("threadId");
    }
    input["cwd"] = json!(cwd);
    let input: VcsListRefsInput = from_json(input).map_err(internal)?;
    refs::list_refs(input)
        .await
        .map(|result| to_json(&result))
        .map_err(internal)
}

struct InFlight {
    service: Arc<McpService>,
    thread: String,
}
impl Drop for InFlight {
    fn drop(&mut self) {
        crate::lock(&self.service.handoffs).remove(&self.thread);
    }
}

pub(super) async fn handoff(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("conn_worktree_handoff")?;
    cx.writing_caller().await?;
    config(cx)?;
    {
        let mut active = crate::lock(&cx.service.handoffs);
        if active.contains(&caller.thread_id) {
            return Err(failure(
                "handoff_in_progress",
                format!(
                    "A worktree handoff is already in progress for thread '{}'.",
                    caller.thread_id
                ),
            ));
        }
        if active.len() >= 256 {
            return Err(operation("Unable to start handoff", "too many handoffs"));
        }
        active.insert(caller.thread_id.clone());
    }
    let guard = InFlight {
        service: cx.service.clone(),
        thread: caller.thread_id.clone(),
    };
    let caller = cx.caller.clone();
    let args = args.clone();
    // Binding ends the caller's session; its disconnect must not cancel rollback or setup.
    tokio::spawn(async move {
        let cx = Cx {
            service: &guard.service,
            caller: &caller,
            origin: None,
        };
        perform(&cx, &args).await
    })
    .await
    .map_err(internal)?
}

async fn perform(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let config = config(cx)?;
    let projection = load(cx).await?;
    let thread = &projection["thread"];
    let thread_id = thread["id"].as_str().unwrap_or_default();
    if let Some(path) = thread["worktreePath"].as_str() {
        return Err(failure(
            "already_in_worktree",
            format!("Thread '{thread_id}' is already attached to worktree '{path}'."),
        ));
    }
    if !thread["archivedAt"].is_null() {
        return Err(failure(
            "invalid_request",
            format!("Thread '{thread_id}' is archived and cannot be handed off to a worktree."),
        ));
    }
    let project = project(cx, thread).await?;
    let root = PathBuf::from(project["workspaceRoot"].as_str().unwrap_or_default());
    if repo::toplevel(&root)
        .await
        .map_err(|e| operation("Unable to read git status", e))?
        .is_none()
    {
        return Err(failure(
            "invalid_request",
            format!(
                "Project workspace '{}' is not a git repository.",
                root.display()
            ),
        ));
    }
    let branch = str_arg(args, "branch").unwrap_or_default();
    if repo::ref_exists(&root, &format!("refs/heads/{branch}"))
        .await
        .map_err(|e| operation("Unable to list branches", e))?
    {
        let existing = refs::list_refs(
            from_json(json!({"cwd":root,"query":branch,"refKind":"local"})).map_err(internal)?,
        )
        .await
        .map_err(|e| operation("Unable to list branches", e))?;
        let checkout = existing
            .refs
            .iter()
            .find(|r| r.name == branch)
            .and_then(|r| r.worktree_path.as_deref())
            .map(|p| format!(" and is checked out at '{p}'"))
            .unwrap_or_default();
        return Err(failure(
            "invalid_request",
            format!(
                "Branch '{branch}' already exists{checkout}. Choose a different branch name, or delete the existing branch{} first.",
                if checkout.is_empty() {
                    ""
                } else {
                    " and its worktree"
                }
            ),
        ));
    }
    let base = match str_arg(args,"baseRef") {
        Some(base) => base.to_owned(),
        None => repo::current_branch(&root).await.map_err(|e|operation("Unable to read git status",e))?
            .ok_or_else(||failure("invalid_request","Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly."))?,
    };
    let start_from_origin =
        bool_arg(args, "startFromOrigin").unwrap_or_else(|| default_origin(config, &project));
    let remote = if start_from_origin {
        conn_vcs::setup::fetch_base(&root, &base)
            .await
            .map_err(|e| operation(&format!("Unable to fetch the remote base of '{base}'"), e))?
    } else {
        None
    };
    let worktree = worktree::create_worktree(&CreateWorktree {
        cwd: root.clone(),
        ref_name: remote
            .as_ref()
            .map_or_else(|| base.clone(), |(sha, _)| sha.clone()),
        new_ref_name: Some(branch.to_owned()),
        base_ref_name: Some(
            remote
                .as_ref()
                .map_or_else(|| base.clone(), |(_, name)| format!("refs/remotes/{name}")),
        ),
        worktrees_dir: (config.directory)(),
    })
    .await
    .map_err(|e| operation("Unable to create the worktree", e))?;
    let path = worktree.path.to_string_lossy().into_owned();
    let bind = async {
        let recheck = load(cx).await?;
        if let Some(path) = recheck["thread"]["worktreePath"].as_str() {
            return Err(failure("already_in_worktree",format!("Thread '{thread_id}' is already attached to worktree '{path}'.")));
        }
        if !recheck["thread"]["archivedAt"].is_null() {
            return Err(failure("invalid_request",format!("Thread '{thread_id}' was archived while the worktree was being created; the handoff was rolled back.")));
        }
        let key = conn_support::uuid_v4();
        let mut command = json!({"type":"thread.metadata.update","threadId":thread_id,"commandId":cx.stable_id("command","worktree-handoff",&key),
            "branch":branch,"worktreePath":path,"expectedWorktreePath":null});
        if let Some(prompt) = str_arg(args,"continuationPrompt") {
            command["continuation"] = json!({"messageId":cx.stable_id("message","worktree-continuation",&key),"text":prompt});
        }
        let command_id = command["commandId"].as_str().unwrap_or_default().to_owned();
        cx.dispatch(command).await.map_err(|e|operation("Unable to re-point the thread at the worktree",e))?;
        Ok(command_id)
    }.await;
    let command_id = match bind {
        Ok(status) => status,
        Err(error) => {
            let _ = worktree::remove_worktree(&root, &worktree.path, Removal::Force).await;
            let _ = worktree::delete_branch(&root, branch, Removal::Force).await;
            return Err(error);
        }
    };
    let created_run = cx
        .engine()
        .created_run_status(&command_id)
        .await
        .map_err(internal)?;
    let hub = config.hub.clone();
    let refresh_path = path.clone();
    tokio::spawn(async move {
        let _ = hub
            .refresh_status(&refresh_path, conn_vcs::hub::Remote::Cached)
            .await;
    });
    let setup = if bool_arg(args, "runSetupScript") == Some(false) {
        json!({"status":"skipped"})
    } else {
        setup(config, thread_id, &project, &path)
            .await
            .unwrap_or_else(|e| json!({"status":"failed","detail":e}))
    };
    let scheduled = str_arg(args, "continuationPrompt").is_some();
    Ok(
        json!({"worktreePath":path,"branch":branch,"baseRef":base,"startedFromOrigin":remote.is_some(),"setupScript":setup,
        "continuation":if scheduled {json!({"status":"scheduled","delivery":if created_run.as_deref().is_some_and(|s|s != "queued"){"started"}else{"queued"}})}else{json!({"status":"skipped"})},
        "note":if scheduled {
            "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
        } else {
            "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted."
        }}),
    )
}

pub(crate) async fn setup(
    config: &WorktreeConfig,
    thread: &str,
    project: &Value,
    path: &str,
) -> Result<Value, String> {
    run_project_script(config, thread, project, path, ScriptTrigger::Setup).await
}

/// Which project script a run picks (`runForThread`'s `trigger`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScriptTrigger {
    /// `setupProjectScript`: `runOnWorktreeCreate`, in terminal `setup-<id>`.
    Setup,
    /// `settleProjectScript`: `runOnSettle`, in a fresh `settle-<id>-<8 hex>` terminal, so a
    /// resumed settle is never typed into an earlier settle shell still at work.
    Settle,
}

/// `ProjectSetupScriptRunner.runForThread` (`ProjectSetupScriptRunner.ts:458`): the trigger's
/// script, typed into a thread terminal in `path` with the project's environment.
pub(crate) async fn run_project_script(
    config: &WorktreeConfig,
    thread: &str,
    project: &Value,
    path: &str,
    trigger: ScriptTrigger,
) -> Result<Value, String> {
    // A settle script is followed to its end (`observeCompletion`); after exit 0 its terminal
    // closes when idle, as T3's settle cleanup does.
    let observe = (trigger == ScriptTrigger::Settle).then(Observe::default);
    Ok(
        start_project_script(config, thread, project, path, trigger, observe)
            .await?
            .started,
    )
}

/// `observeCompletion`: follow the script to its end, with its output lines.
#[derive(Default)]
pub(crate) struct Observe {
    pub(crate) on_line: Option<Box<dyn FnMut(String) + Send>>,
}

/// A started (or absent) project script.
pub(crate) struct ScriptRun {
    /// `{status: "no-script"}`, or `{status: "started", scriptName, terminalId}`.
    pub(crate) started: Value,
    pub(crate) command: String,
    /// The script's `async` flag: `false` asks the agent to wait for it (`script.async !== false`).
    pub(crate) is_async: bool,
    /// With [`Observe`]: the exit code, or `None` when the terminal ended first.
    pub(crate) completion: Option<tokio::sync::oneshot::Receiver<Option<i64>>>,
}

/// [`run_project_script`], optionally followed to its end.
pub(crate) async fn start_project_script(
    config: &WorktreeConfig,
    thread: &str,
    project: &Value,
    path: &str,
    trigger: ScriptTrigger,
    observe: Option<Observe>,
) -> Result<ScriptRun, String> {
    let settings = (config.settings)();
    let project_id = project["id"].as_str().unwrap_or_default();
    // `resolveProjectScripts`: once folded, absent machine defaults are no scripts.
    let none = json!([]);
    let scripts = settings["projectSettingsOverrides"][project_id]
        .get("defaultProjectScripts")
        .or_else(|| {
            (settings["projectSettingsFolded"] == true)
                .then(|| settings.get("defaultProjectScripts").unwrap_or(&none))
        })
        .or_else(|| {
            settings["projectScriptOverrides"].get(project_id).map(|s| {
                if s.is_null() {
                    &settings["defaultProjectScripts"]
                } else {
                    s
                }
            })
        })
        .unwrap_or_else(|| {
            if project["scripts"].as_array().is_some_and(|s| !s.is_empty()) {
                &project["scripts"]
            } else {
                &settings["defaultProjectScripts"]
            }
        });
    let Some(script) = scripts
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| match trigger {
            ScriptTrigger::Setup => s["runOnWorktreeCreate"] == true,
            ScriptTrigger::Settle => s["runOnSettle"] == true,
        })
    else {
        return Ok(ScriptRun {
            started: json!({"status":"no-script"}),
            command: String::new(),
            is_async: true,
            completion: None,
        });
    };
    let terminals = config
        .terminals
        .clone()
        .ok_or("Terminal service unavailable")?;
    let id = script["id"].as_str().unwrap_or_default();
    let terminal = match trigger {
        ScriptTrigger::Setup => format!("setup-{id}"),
        ScriptTrigger::Settle => {
            let suffix: String = conn_support::uuid_v4().chars().take(8).collect();
            format!("settle-{id}-{suffix}")
        }
    };
    let input = from_json(json!({"threadId":thread,"terminalId":terminal,"cwd":path,"worktreePath":path,
        "stopOnSettle":script["stopOnSettle"].as_bool().unwrap_or(false),
        "env":{"T3CODE_PROJECT_ROOT":project["workspaceRoot"],"T3CODE_WORKTREE_PATH":path,"COLORTERM":"","NO_COLOR":"1","FORCE_COLOR":"0"}})).map_err(|e|e.to_string())?;
    let manager = terminals.clone();
    let mut readiness = tokio::task::spawn_blocking(move ||manager.open_observed(input))
        .await.map_err(|e|e.to_string())?.map_err(|_|format!("Project setup script operation 'openTerminal' failed for thread '{thread}' in '{path}'."))?;
    let command = script["command"].as_str().unwrap_or_default();
    let (done, completion) = match observe {
        Some(_) => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            (Some(tx), Some(rx))
        }
        None => (None, None),
    };
    let mut on_line = observe.and_then(|o| o.on_line);
    let observe = done.is_some();
    let sentinel = super::script_completion::sentinel(&conn_support::uuid_v4().replace('-', ""));
    let shell = terminals
        .shell(thread, &terminal)
        .map(|shell| super::script_completion::completion_shell(&shell));
    let (kind, line) = match shell {
        // The shell already ended: nothing is typed (`commandLine === null`).
        None => (None, None),
        Some(None) if observe => {
            terminals.close_idle(thread, Some(&terminal)).await;
            return Err(
                "Project script completion is not supported in cmd.exe. Install PowerShell and retry."
                    .to_owned(),
            );
        }
        Some(kind) => {
            let line = match kind {
                Some(kind) if observe => super::script_completion::wrap(command, kind, &sentinel),
                _ => command.to_owned(),
            };
            (kind, Some(line))
        }
    };
    let (thread_owned, terminal_owned) = (thread.to_owned(), terminal.clone());
    tokio::spawn(async move {
        // Every way out before the sentinel reports no exit code (`abandon`).
        let code = async {
            let line = line?;
            // PowerShell and cmd have no line-editor signal.
            let ready = matches!(
                kind,
                Some(super::script_completion::CompletionShell::PowerShell) | None
            ) || shell_ready(&mut readiness).await;
            if !ready {
                return None;
            }
            let input = from_json(
                json!({"threadId":thread_owned,"terminalId":terminal_owned,"data":format!(" {line}\r")}),
            )
            .ok()?;
            if terminals.write(input, None).await.is_err() || !observe {
                return None;
            }
            let echoed: Vec<String> = line
                .split('\r')
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect();
            let output = on_line
                .as_deref_mut()
                .map(|sink| super::script_completion::OutputLines {
                    echoed: &echoed,
                    sink,
                });
            let code = super::script_completion::completion(&mut readiness, &sentinel, output).await;
            if code == Some(0) {
                terminals
                    .close_idle(&thread_owned, Some(&terminal_owned))
                    .await;
            }
            code
        }
        .await;
        if let Some(done) = done {
            let _ = done.send(code);
        }
    });
    Ok(ScriptRun {
        started: json!({"status":"started","scriptName":script["name"],"terminalId":terminal}),
        command: command.to_owned(),
        is_async: script["async"] != false,
        completion,
    })
}

// RC-file prompts may consume early input. Match T3's line-editor signal or quiet fallback.
async fn shell_ready(stream: &mut conn_terminal::Subscription) -> bool {
    use conn_contract::TerminalAttachStreamEvent as Event;
    const QUIET: std::time::Duration = std::time::Duration::from_secs(3);
    const ON: &str = "\x1b[?2004h";
    const OFF: &str = "\x1b[?2004l";
    let quiet = tokio::time::sleep(QUIET);
    tokio::pin!(quiet);
    let mut busy = false;
    let mut carry = String::new();
    loop {
        tokio::select! {
            event = stream.next() => {
                match event {
                    Event::Output(output) => {
                        carry.push_str(&output.data);
                        if carry.rfind(ON).is_some_and(|at| carry.rfind(OFF).is_none_or(|off| at > off)) { return true; }
                        carry = carry.chars().rev().take(ON.len()-1).collect::<String>().chars().rev().collect();
                    }
                    Event::Activity(activity) => busy = activity.has_running_subprocess,
                    Event::Exited(_) | Event::Closed(_) => return false,
                    Event::Snapshot(_) | Event::Restarted(_) => { busy = false; carry.clear(); }
                    _ => {}
                }
                quiet.as_mut().reset(tokio::time::Instant::now()+QUIET);
            }
            () = &mut quiet => {
                if !busy { return true; }
                quiet.as_mut().reset(tokio::time::Instant::now()+QUIET);
            }
        }
    }
}
