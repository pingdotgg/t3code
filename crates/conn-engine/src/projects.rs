//! Projects at runtime: `projects.mutate`, `ensureScratch`, `createNew`, `createFromThread`.
//!
//! A project is one row in `projects` plus a `project.updated` or `project.removed` shell
//! change. Deleting keeps the row with `deletedAt`, so a folder given with `--project` stays
//! removed after a restart. Folder work (mkdir, `git init`) runs before the write, on the
//! blocking pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::commands::{self, CommandError, Effect, is_live};
use crate::engine::{Inner, project_id};
use crate::store::{Tx, new_project};

/// Title of the project that holds threads without a project (`ManagedProjectFolders.ts`).
const SCRATCH_TITLE: &str = "No project";

/// A project call failure: the client message and a cause for the logs.
pub(crate) struct ProjectFailure {
    pub message: String,
    pub cause: Option<Value>,
    pub internal: bool,
}

impl ProjectFailure {
    fn rejected(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            cause: None,
            internal: false,
        }
    }
    fn tagged(tag: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            cause: Some(json!({"_tag": tag, "message": message})),
            message,
            internal: false,
        }
    }
}

impl From<String> for ProjectFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            cause: None,
            internal: true,
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
            if tx
                .project_any(&project_id)?
                .is_some_and(|p| p["deletedAt"].is_null())
            {
                return Err(ProjectFailure::tagged(
                    "ProjectConflictError",
                    format!("Project {project_id} already exists."),
                ));
            }
            let root = input["workspaceRoot"].as_str().unwrap_or_default().trim();
            if root.is_empty() {
                return Err(ProjectFailure::tagged(
                    "ProjectInvalidError",
                    "The project needs a folder.",
                ));
            }
            if tx
                .project_by_root(root)?
                .is_some_and(|p| p["deletedAt"].is_null())
            {
                return Err(ProjectFailure::tagged(
                    "ProjectConflictError",
                    format!("Another project already uses {root}."),
                ));
            }
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
                    return Err(ProjectFailure::tagged(
                        "ProjectInvalidError",
                        format!("{root} is not a folder."),
                    ));
                }
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
            if let Some(root) = input["workspaceRoot"].as_str().map(str::trim) {
                if tx
                    .project_by_root(root)?
                    .is_some_and(|p| p["id"] != project_id.as_str() && p["deletedAt"].is_null())
                {
                    return Err(ProjectFailure::tagged(
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
                && icon["text"].as_str().is_some_and(|t| t.chars().count() > 2)
            {
                return Err(ProjectFailure::tagged(
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

impl Inner {
    /// Runs one project write, with a receipt when the input has a `commandId`.
    async fn project_write<T: Send + 'static>(
        self: &Arc<Self>,
        command_id: Option<String>,
        f: impl FnOnce(&mut Tx<'_>) -> ProjectResult<(T, Vec<Effect>)> + Send + 'static,
    ) -> ProjectResult<T> {
        let result = self
            .db(move |store| {
                let mut tx = store.tx().map_err(ProjectFailure::from)?;
                match f(&mut tx) {
                    Ok((value, effects)) => {
                        let receipt = command_id.as_deref().map(|id| (id, "project"));
                        let seq = tx.commit(receipt).map_err(ProjectFailure::from)?;
                        Ok((value, effects, seq))
                    }
                    Err(e) => {
                        tx.rollback();
                        Err(e)
                    }
                }
            })
            .await;
        let (value, effects, seq) = result?;
        self.notify.send_replace(seq);
        for effect in effects {
            self.spawn_effect(effect);
        }
        Ok(value)
    }

    pub(crate) async fn project_mutate(self: &Arc<Self>, input: Value) -> ProjectResult<Value> {
        let command_id = input["commandId"].as_str().unwrap_or_default().to_owned();
        let project_id = input["projectId"].as_str().unwrap_or_default().to_owned();
        // A retried command returns the project as it is now.
        let (cid, pid) = (command_id.clone(), project_id.clone());
        let replay = self
            .db(move |store| -> Result<Option<Value>, String> {
                if store.receipt(&cid)?.is_none() {
                    return Ok(None);
                }
                let tx = store.tx()?;
                let project = tx.project_any(&pid);
                tx.rollback();
                project
            })
            .await?;
        if let Some(project) = replay {
            return Ok(project);
        }
        self.project_write(Some(command_id), move |tx| mutate(tx, &input))
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
            .project_write(None, move |tx| {
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
            .project_write(None, move |tx| {
                let id = project_id(&written);
                if tx
                    .project_by_root(&written)?
                    .is_some_and(|p| p["deletedAt"].is_null())
                {
                    return Err(ProjectFailure::rejected(format!(
                        "Another project already uses {written}."
                    )));
                }
                let project = new_project(&id, &name, &written, tx.now());
                tx.put_project(&project)?;
                Ok((id, vec![]))
            })
            .await;
        let id = match created {
            Ok(id) => id,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&folder);
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
            .project_write(None, move |tx| {
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
                    tx.append(crate::store::Draft::new(&tid, "thread.metadata-updated", t))?;
                }
                Ok((id, vec![]))
            })
            .await?;
        Ok(json!({"projectId": id}))
    }
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
}
