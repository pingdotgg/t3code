//! Projects at runtime: `projects.mutate`, `ensureScratch`, `createNew`, `createFromThread`.
//!
//! A project is one row in `projects` plus a `project.updated` or `project.removed` shell
//! change. Deleting keeps the row with `deletedAt`, so a folder given with `--project` stays
//! removed after a restart. Folder work (mkdir, `git init`) runs before the write, on the
//! blocking pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

use crate::commands::{self, CommandError, Effect, is_live};
use crate::engine::{Inner, project_id};
use crate::store::{Receipt, ReceiptKey, ReceiptOwner, StoredOwner, Tx, new_project};

/// Title of the project that holds threads without a project (`ManagedProjectFolders.ts`).
const SCRATCH_TITLE: &str = "No project";

/// A project call failure: the client message and a cause for the logs.
pub(crate) struct ProjectFailure {
    pub message: String,
    pub cause: Option<Value>,
    pub internal: bool,
    /// Refused by planning against the stored projects (T3's `planProjectCommand`): the
    /// refusal is the command's receipt. Others (the folder, the store) can be retried.
    planned: bool,
}

impl ProjectFailure {
    fn rejected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cause: None,
            internal: false,
            planned: false,
        }
    }
    fn tagged(tag: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            cause: Some(json!({"_tag": tag, "message": message})),
            message,
            internal: false,
            planned: false,
        }
    }
    fn planned(tag: &str, message: impl Into<String>) -> Self {
        Self {
            planned: true,
            ..Self::tagged(tag, message)
        }
    }

    /// The receipt's form of a planned refusal: the typed cause, as T3's
    /// `encodeProjectCommandRejection`.
    fn encode(&self) -> String {
        self.cause
            .clone()
            .unwrap_or_else(|| json!({"message": self.message}))
            .to_string()
    }

    fn decode(refusal: &str) -> Self {
        let cause: Value =
            serde_json::from_str(refusal).unwrap_or_else(|_| json!({"message": refusal}));
        Self {
            message: cause["message"].as_str().unwrap_or(refusal).to_owned(),
            cause: Some(cause),
            internal: false,
            planned: true,
        }
    }
}

impl From<String> for ProjectFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            cause: None,
            internal: true,
            planned: false,
        }
    }
}

type ProjectResult<T> = Result<T, ProjectFailure>;

/// `projects.mutate`: create, update or delete one project. Returns the `Project` and the
/// effects of threads a forced delete removed.
fn mutate(tx: &mut Tx<'_>, input: &Value) -> ProjectResult<(Value, Vec<Effect>)> {
    let project_id = input["projectId"].as_str().unwrap_or_default().to_owned();
    let now = tx.now().to_owned();
    match input["type"].as_str() {
        Some("project.create") => {
            // Other areas name folders after a project id; `.` and `..` name no folder of
            // their own. The T3 server takes them.
            if matches!(project_id.as_str(), "." | "..") {
                return Err(ProjectFailure::tagged(
                    "ProjectInvalidError",
                    format!("`{project_id}` cannot be a project id."),
                ));
            }
            let raw = input["workspaceRoot"].as_str().unwrap_or_default().trim();
            if raw.is_empty() {
                return Err(ProjectFailure::tagged(
                    "ProjectInvalidError",
                    "The project needs a folder.",
                ));
            }
            let normalized = normalize_workspace_root(raw);
            let root = normalized.as_str();
            // T3 checks the folder before it plans (`ProjectService.create`): a missing one
            // is a retryable refusal, never a recorded conflict.
            let path = Path::new(root);
            if !path.is_dir() {
                if input["createWorkspaceRootIfMissing"] == true {
                    std::fs::create_dir_all(path).map_err(|e| {
                        ProjectFailure::tagged(
                            "ProjectOperationError",
                            format!("Could not create {root}: {e}"),
                        )
                    })?;
                } else {
                    // T3 fails to normalize the folder (`ProjectOperationError`).
                    return Err(ProjectFailure::tagged(
                        "ProjectOperationError",
                        format!("{root} is not a folder."),
                    ));
                }
            }
            if tx
                .project_any(&project_id)?
                .is_some_and(|p| p["deletedAt"].is_null())
            {
                return Err(ProjectFailure::planned(
                    "ProjectConflictError",
                    format!("Project {project_id} already exists."),
                ));
            }
            if tx
                .project_by_root(root)?
                .is_some_and(|p| p["deletedAt"].is_null())
            {
                return Err(ProjectFailure::planned(
                    "ProjectConflictError",
                    format!("Another project already uses {root}."),
                ));
            }
            let title = input["title"].as_str().unwrap_or_default().trim();
            let mut project = new_project(&project_id, title, root, &now);
            if let Some(selection) = input.get("defaultModelSelection") {
                project["defaultModelSelection"] = commands::normalize_model_selection(selection);
            }
            if input["scripts"].is_array() {
                project["scripts"] = input["scripts"].clone();
            }
            tx.put_project(&project)?;
            Ok((project, vec![]))
        }
        Some("project.update") => {
            let Some(mut project) = tx.project(&project_id)? else {
                return Err(ProjectFailure::tagged(
                    "ProjectNotFoundError",
                    format!("Project {project_id} does not exist."),
                ));
            };
            if let Some(title) = input["title"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
            {
                project["title"] = json!(title);
                project["hasCustomTitle"] = json!(true);
            }
            if let Some(raw) = input["workspaceRoot"].as_str().map(str::trim) {
                let normalized = normalize_workspace_root(raw);
                let root = normalized.as_str();
                // T3 normalizes the folder first and fails when it is not one.
                if !Path::new(root).is_dir() {
                    return Err(ProjectFailure::tagged(
                        "ProjectOperationError",
                        format!("{root} is not a folder."),
                    ));
                }
                if tx
                    .project_by_root(root)?
                    .is_some_and(|p| p["id"] != project_id.as_str() && p["deletedAt"].is_null())
                {
                    return Err(ProjectFailure::planned(
                        "ProjectConflictError",
                        format!("Another project already uses {root}."),
                    ));
                }
                project["workspaceRoot"] = json!(root);
            }
            for field in [
                "autoPull",
                "projectIcon",
                "faviconPath",
                "defaultThreadEnvMode",
                "scripts",
            ] {
                if let Some(value) = input.get(field) {
                    project[field] = value.clone();
                }
            }
            if let Some(selection) = input.get("defaultModelSelection") {
                project["defaultModelSelection"] = if selection.is_null() {
                    Value::Null
                } else {
                    commands::normalize_model_selection(selection)
                };
            }
            if let Some(icon) = input["projectIcon"].as_object()
                && icon.get("kind") == Some(&json!("monogram"))
                && icon["text"]
                    .as_str()
                    .is_some_and(|t| t.graphemes(true).count() > 2)
            {
                return Err(ProjectFailure::planned(
                    "ProjectInvalidError",
                    "A monogram icon has at most two characters.",
                ));
            }
            for (flag, field) in [("pinned", "pinnedAt"), ("archived", "archivedAt")] {
                match input[flag].as_bool() {
                    Some(true) if project[field].is_null() => project[field] = json!(now),
                    Some(false) => project[field] = Value::Null,
                    _ => {}
                }
            }
            project["updatedAt"] = json!(now);
            tx.put_project(&project)?;
            Ok((project, vec![]))
        }
        Some("project.delete") => {
            let Some(mut project) = tx.project(&project_id)? else {
                return Err(ProjectFailure::tagged(
                    "ProjectNotFoundError",
                    format!("Project {project_id} does not exist."),
                ));
            };
            let threads = tx.project_thread_ids(&project_id)?;
            if !threads.is_empty() && input["force"] != true {
                let mut failure = ProjectFailure::tagged(
                    "ProjectNotEmptyError",
                    format!(
                        "Project {} still has {} thread(s). Delete them first.",
                        project["title"].as_str().unwrap_or(&project_id),
                        threads.len()
                    ),
                );
                failure.internal = false;
                return Err(failure);
            }
            let command_id = input["commandId"].as_str().unwrap_or_default();
            let mut effects = vec![];
            for thread_id in threads {
                let delete = commands::handler("thread.delete").expect("thread.delete handler");
                let outcome = delete(
                    tx,
                    json!({"type": "thread.delete", "threadId": thread_id,
                           "commandId": format!("{command_id}:delete-thread:{thread_id}")}),
                );
                match outcome {
                    Ok(more) => effects.extend(more),
                    Err(CommandError::Rejected(message)) => {
                        return Err(ProjectFailure::tagged("ProjectOperationError", message));
                    }
                    Err(CommandError::Store(message)) => return Err(message.into()),
                }
            }
            project["deletedAt"] = json!(now);
            project["updatedAt"] = json!(now);
            tx.put_project(&project)?;
            Ok((project, effects))
        }
        other => Err(ProjectFailure::tagged(
            "ProjectInvalidError",
            format!("Unknown project mutation `{}`.", other.unwrap_or("")),
        )),
    }
}

/// Adds a project for `root` unless an active one owns it. Returns `(projectId, created)`.
fn bootstrap(tx: &mut Tx<'_>, title: &str, root: &str) -> ProjectResult<(String, bool)> {
    if let Some(existing) = tx
        .project_by_root(root)?
        .filter(|p| p["deletedAt"].is_null())
    {
        return Ok((
            existing["id"].as_str().unwrap_or_default().to_owned(),
            false,
        ));
    }
    let id = project_id(root);
    let project = new_project(&id, title, root, tx.now());
    tx.put_project(&project)?;
    Ok((id, true))
}

/// `newProjectFolderName` in `packages/shared/src/path.ts`: an ASCII slug of at most 64.
fn folder_name(name: &str) -> String {
    let mut slug = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_end_matches('-').chars().take(64).collect();
    let slug = slug.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        "project".into()
    } else {
        slug
    }
}

/// Makes `<home>/projects/<name>` (or `<name>-2`, ...), runs `git init` and commits a README.
/// Returns the folder and a commit error the client shows as a warning.
fn make_project_folder(home: &Path, name: &str) -> ProjectResult<(PathBuf, Option<String>)> {
    let parent = home.join("projects");
    std::fs::create_dir_all(&parent).map_err(|e| {
        ProjectFailure::rejected(format!("Could not create {}: {e}", parent.display()))
    })?;
    let base = folder_name(name);
    let mut folder = None;
    for attempt in 1..=100 {
        let candidate = if attempt == 1 {
            parent.join(&base)
        } else {
            parent.join(format!("{base}-{attempt}"))
        };
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                folder = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(ProjectFailure::rejected(format!(
                    "Could not create {}: {e}",
                    candidate.display()
                )));
            }
        }
    }
    let folder =
        folder.ok_or_else(|| ProjectFailure::rejected("No free folder name for this project."))?;
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&folder)
            .envs(conn_support::login_env::vars())
            .output()
    };
    let fail = |message: String| {
        let _ = std::fs::remove_dir_all(&folder);
        ProjectFailure::rejected(message)
    };
    match git(&["init", "--quiet"]) {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            return Err(fail(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Err(_) => {
            return Err(fail(
                "Git is not installed, so a new project cannot be created.".into(),
            ));
        }
    }
    if let Err(e) = std::fs::write(folder.join("README.md"), format!("# {}\n", name.trim())) {
        return Err(fail(format!("Could not write README.md: {e}")));
    }
    let commit = git(&["add", "--force", "README.md"])
        .and_then(|_| git(&["commit", "--quiet", "-m", "Initial commit"]));
    let commit_error = match commit {
        Ok(out) if out.status.success() => None,
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stderr);
            Some(
                if text.contains("user.email") || text.contains("user.name") {
                    "Git has no name or email set, so the first commit was skipped.".to_owned()
                } else {
                    format!("The first commit failed: {}", text.trim())
                },
            )
        }
        Err(e) => Some(format!("The first commit failed: {e}")),
    };
    Ok((folder, commit_error))
}

/// A project command's receipt key: its id, T3's command type and its project.
struct ProjectCommand {
    id: String,
    kind: &'static str,
    project_id: String,
}

impl ProjectCommand {
    fn from_input(input: &Value) -> Self {
        Self {
            id: input["commandId"].as_str().unwrap_or_default().to_owned(),
            // T3's receipt names the command it dispatched (`ProjectService.update`).
            kind: match input["type"].as_str().unwrap_or_default() {
                "project.update" => "project.meta.update",
                "project.delete" => "project.delete",
                _ => "project.create",
            },
            project_id: input["projectId"].as_str().unwrap_or_default().to_owned(),
        }
    }

    fn key(&self) -> ReceiptKey<'_> {
        ReceiptKey {
            command_id: &self.id,
            command_type: self.kind,
            owner: ReceiptOwner::Project(&self.project_id),
        }
    }

    /// Whether this command may answer from the receipt another write holds (T3's
    /// `ProjectService.commit`): its own accepted one replays, its own refusal is refused
    /// again, and any other is a conflict.
    fn check(&self, receipt: Receipt) -> ProjectResult<()> {
        let id = &self.id;
        match receipt.owner {
            Some(StoredOwner::Project(Some(project)))
                if project == self.project_id && receipt.command_type == self.kind =>
            {
                match receipt.refusal {
                    Some(refusal) => Err(ProjectFailure::decode(&refusal)),
                    None => Ok(()),
                }
            }
            Some(StoredOwner::Project(Some(project))) => Err(ProjectFailure::rejected(format!(
                "Command {id} was already used by {} for {project}.",
                receipt.command_type
            ))),
            Some(StoredOwner::Thread(_)) => Err(ProjectFailure::rejected(format!(
                "Command {id} was already used by a thread command."
            ))),
            Some(StoredOwner::Project(None)) | None => Err(ProjectFailure::rejected(format!(
                "Command {id} was handled before receipts named their owner; it cannot be replayed."
            ))),
        }
    }
}

impl Inner {
    /// Runs one project write that has no command id, so no receipt.
    async fn project_write<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(&mut Tx<'_>) -> ProjectResult<(T, Vec<Effect>)> + Send + 'static,
    ) -> ProjectResult<T> {
        let no_replay = |_: &Tx<'_>| Err(ProjectFailure::rejected("No receipt to replay."));
        self.project_command_write(None, no_replay, f).await
    }

    /// Runs one project write. A command with an id reads its receipt in the same write, as
    /// T3's `commitProjectCommand`: a retry of it answers with `replay`, and an id another
    /// command used is refused with that receipt kept.
    async fn project_command_write<T: Send + 'static>(
        self: &Arc<Self>,
        command: Option<ProjectCommand>,
        replay: impl FnOnce(&Tx<'_>) -> ProjectResult<T> + Send + 'static,
        f: impl FnOnce(&mut Tx<'_>) -> ProjectResult<(T, Vec<Effect>)> + Send + 'static,
    ) -> ProjectResult<T> {
        self.ensure_effect_worker();
        self.db(move |store| {
            let mut tx = store.tx().map_err(ProjectFailure::from)?;
            // The id is taken inside this write; a receipt another command holds decides
            // the answer here, and is never replaced.
            if let Some(command) = &command
                && !tx.reserve(&command.key()).map_err(ProjectFailure::from)?
            {
                let held = tx.outcome(&command.id).map_err(ProjectFailure::from)?;
                let answer = held
                    .ok_or_else(|| ProjectFailure::from("The receipt vanished.".to_owned()))
                    .and_then(|receipt| command.check(receipt))
                    .and_then(|()| replay(&tx));
                tx.rollback();
                return answer;
            }
            match f(&mut tx) {
                Ok((value, effects)) => {
                    let receipt = command.as_ref().map(ProjectCommand::key);
                    let command_id = command.as_ref().map(|command| command.id.as_str());
                    if let Err(e) = tx.enqueue(command_id, &effects) {
                        tx.rollback();
                        return Err(ProjectFailure::from(e));
                    }
                    tx.commit(receipt.as_ref()).map_err(ProjectFailure::from)?;
                    Ok(value)
                }
                Err(e) => {
                    tx.rollback();
                    // A refusal from planning is the command's outcome (T3's
                    // `commitRejectedProjectCommand`); others stay retryable.
                    if e.planned
                        && let Some(command) = &command
                    {
                        store
                            .record_refusal(&command.key(), &e.encode())
                            .map_err(ProjectFailure::from)?;
                    }
                    Err(e)
                }
            }
        })
        .await
    }

    pub(crate) async fn project_mutate(self: &Arc<Self>, input: Value) -> ProjectResult<Value> {
        let command = ProjectCommand::from_input(&input);
        // A retried command returns the project as it is now (T3's `readCommitted`).
        let pid = command.project_id.clone();
        self.project_command_write(
            Some(command),
            move |tx| {
                tx.project_any(&pid)
                    .map_err(ProjectFailure::from)?
                    .ok_or_else(|| {
                        ProjectFailure::tagged(
                            "ProjectOperationError",
                            "The accepted project command did not produce a project row.",
                        )
                    })
            },
            move |tx| mutate(tx, &input),
        )
        .await
    }

    pub(crate) async fn project_ensure_scratch(self: &Arc<Self>) -> ProjectResult<Value> {
        let root = self.home.join("scratch");
        let mkdir = root.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(mkdir))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| {
                ProjectFailure::rejected(format!("Could not create the scratch folder: {e}"))
            })?;
        let root = root.to_string_lossy().into_owned();
        let id = self
            .project_write(move |tx| {
                let (id, created) = bootstrap(tx, SCRATCH_TITLE, &root)?;
                if created && let Some(mut project) = tx.project(&id)? {
                    project["projectIcon"] =
                        json!({"kind": "lucide", "name": "message-square-dashed", "color": "gray"});
                    tx.put_project(&project)?;
                }
                Ok((id, vec![]))
            })
            .await?;
        Ok(json!({"projectId": id}))
    }

    pub(crate) async fn project_create_new(self: &Arc<Self>, input: Value) -> ProjectResult<Value> {
        let name = input["name"].as_str().unwrap_or_default().trim().to_owned();
        if name.is_empty() {
            return Err(ProjectFailure::rejected("The project needs a name."));
        }
        let home = self.home.clone();
        let folder_name = name.clone();
        let (folder, commit_error) =
            tokio::task::spawn_blocking(move || make_project_folder(&home, &folder_name))
                .await
                .map_err(|e| e.to_string())??;
        let root = folder.to_string_lossy().into_owned();
        let written = root.clone();
        let created = self
            .project_write(move |tx| {
                // A fresh id, as T3's `createNamedProject`: a folder freed by a moved project
                // must not bring that project's id back.
                let id = conn_support::uuid_v4();
                if tx
                    .project_by_root(&written)?
                    .is_some_and(|p| p["deletedAt"].is_null())
                {
                    return Err(ProjectFailure::tagged(
                        "ProjectConflictError",
                        format!("Another project already uses {written}."),
                    ));
                }
                let project = new_project(&id, &name, &written, tx.now());
                tx.put_project(&project)?;
                Ok((id, vec![]))
            })
            .await;
        let id = match created {
            Ok(id) => id,
            Err(e) => {
                // The folder stays: another request may own it by now, and removing it could
                // take that project's files (T3 removes it only while no project owns it; this
                // keeps it in every case).
                return Err(e);
            }
        };
        let mut result = json!({"projectId": id, "workspaceRoot": root});
        if let Some(commit_error) = commit_error {
            result["commitError"] = json!(commit_error);
        }
        Ok(result)
    }

    /// Promotes a No-project thread's own folder to a project, in place
    /// (`ScratchThreadPromotion.ts`). Every scratch thread in that folder moves with it.
    pub(crate) async fn project_create_from_thread(
        self: &Arc<Self>,
        input: Value,
    ) -> ProjectResult<Value> {
        let thread_id = input["threadId"].as_str().unwrap_or_default().to_owned();
        let scratch = self.home.join("scratch");
        let id = self
            .project_write(move |tx| {
                let refuse = || {
                    ProjectFailure::rejected(
                        "Only a No project thread with its own folder can become a project.",
                    )
                };
                let thread = tx.thread(&thread_id)?.ok_or_else(refuse)?;
                let project = tx.project(thread["projectId"].as_str().unwrap_or_default())?;
                let folder = thread["worktreePath"]
                    .as_str()
                    .or_else(|| project.as_ref().and_then(|p| p["workspaceRoot"].as_str()))
                    .ok_or_else(refuse)?
                    .to_owned();
                let parent_is_scratch = Path::new(&folder)
                    .parent()
                    .and_then(|p| p.canonicalize().ok())
                    .zip(scratch.canonicalize().ok())
                    .is_some_and(|(a, b)| a == b);
                if !parent_is_scratch {
                    return Err(refuse());
                }
                let scratch_id = project_id(&scratch.to_string_lossy());
                let mut moving = tx.threads_where("worktreePath", &folder)?;
                if moving.iter().all(|t| t["id"] != thread_id.as_str()) {
                    moving.push(thread);
                }
                moving.retain(|t| {
                    t["projectId"] == scratch_id.as_str() || t["id"] == thread_id.as_str()
                });
                for t in &moving {
                    let id = t["id"].as_str().unwrap_or_default();
                    if tx.entities(id, "runs")?.iter().any(is_live) {
                        return Err(ProjectFailure::rejected(format!(
                            "\"{}\" is still working. Finish or stop it first.",
                            t["title"].as_str().unwrap_or(id)
                        )));
                    }
                }
                let title = moving
                    .iter()
                    .find(|t| t["id"] == thread_id.as_str())
                    .and_then(|t| t["title"].as_str())
                    .unwrap_or("Project")
                    .to_owned();
                let (id, _) = bootstrap(tx, &title, &folder)?;
                let now = tx.now().to_owned();
                for mut t in moving {
                    let tid = t["id"].as_str().unwrap_or_default().to_owned();
                    t["projectId"] = json!(id);
                    t["worktreePath"] = Value::Null;
                    t["updatedAt"] = json!(now);
                    tx.append(
                        crate::store::Draft::new(&tid, "thread.metadata-updated", t)
                            .payload_instance(),
                    )?;
                }
                Ok((id, vec![]))
            })
            .await?;
        Ok(json!({"projectId": id}))
    }
}

/// `normalizeWorkspaceRoot` without the disk: `~` expanded to `HOME`, a relative path taken
/// from the working folder, `.` and `..` resolved by name (as Node's `path.resolve`).
pub(crate) fn normalize_workspace_root(raw: &str) -> String {
    // `expandHomePath`: `~`, `~/` and `~\`.
    let home = || {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default()
    };
    let expanded = if raw == "~" {
        home()
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        home().join(rest.trim_start_matches(['/', '\\']))
    } else {
        PathBuf::from(raw)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir().unwrap_or_default().join(expanded)
    };
    let mut out = PathBuf::new();
    for part in absolute.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::folder_name;

    #[test]
    fn folder_names_are_ascii_slugs() {
        assert_eq!(folder_name("My App!"), "my-app");
        assert_eq!(folder_name("  "), "project");
        assert_eq!(folder_name("Ünïcode 2"), "n-code-2");
        assert_eq!(folder_name(&"a".repeat(80)).len(), 64);
    }

    #[test]
    fn workspace_roots_normalize_as_t3_resolves_them() {
        use super::normalize_workspace_root as normalize;
        let home = std::env::var("HOME").unwrap_or_default();
        assert_eq!(normalize("/work/repo/."), "/work/repo");
        assert_eq!(normalize("/work/./x/../repo/"), "/work/repo");
        assert_eq!(normalize("~"), normalize(&home));
        assert_eq!(normalize("~/repo"), normalize(&format!("{home}/repo")));
        assert_eq!(normalize("~\\repo"), normalize(&format!("{home}/repo")));
        assert_eq!(normalize("~//repo"), normalize(&format!("{home}/repo")));
        assert!(normalize("~other").ends_with("/~other"));
    }
}
