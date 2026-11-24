//! `projects.*` file methods, `filesystem.*`, `assets.*`, `attachments.*`, `shell.openInEditor`.
//! Owner: the files track. The work lives in `conn-files`; this file checks scopes, looks up
//! thread and project folders in the engine, and runs the blocking work on `spawn_blocking`.

use std::sync::Arc;

use conn_contract::{
    AssetCreateUrlInput, AssetResource, AttachmentCreateUploadUrlInput, AttachmentDeleteInput,
    ExternalLauncherCommandNotFoundError, FilesystemBrowseInput, FilesystemGetMetadataInput,
    LaunchEditorInput, PersistChatAttachmentsInput, PersistChatAttachmentsResult,
    ProjectListEntriesInput, ProjectReadFileInput, ProjectSearchContentsInput,
    ProjectSearchEntriesInput, ProjectWriteFileInput, ThreadId, lit,
};
use conn_engine::Engine;
use conn_files::{AssetContext, KnownWorkspaces, assets, attachments, entries, search, workspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Deps;
use crate::table::{Failure, MethodTable};

/// Runs blocking file work off the async thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Failure> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Failure::die("file work stopped unexpectedly"))
}

fn fail<E: Serialize>(error: E) -> Failure {
    Failure::fail(&error)
}

/// `PROJECT_READ_FILE_PATH_MAX_LENGTH`, `_WRITE_FILE_`, `FILESYSTEM_PATH_MAX_LENGTH`.
const PATH_MAX_LENGTH: usize = 512;

/// A contract string limit the generated types do not check: 1 to `max` UTF-16 units, after
/// trimming when the schema is `TrimmedNonEmptyString`. A breach is a defect, as a decode
/// failure is on the T3 server.
fn check_length(value: &str, trimmed: bool, max: usize, field: &str) -> Result<(), Failure> {
    let value = if trimmed { value.trim() } else { value };
    let n = value.encode_utf16().count();
    if n == 0 || n > max {
        return Err(Failure::die(format!(
            "{field} must be 1 to {max} characters"
        )));
    }
    Ok(())
}

/// Where the engine says projects and threads live. Empty without an engine.
#[derive(Default)]
struct Layout {
    shell: Value,
}

impl Layout {
    async fn load(engine: Option<&Arc<dyn Engine>>) -> Self {
        let shell = match engine {
            Some(engine) => engine.shell_snapshot().await.unwrap_or(Value::Null),
            None => Value::Null,
        };
        Self { shell }
    }

    fn projects(&self) -> impl Iterator<Item = &Value> {
        self.shell["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["deletedAt"].is_null())
    }

    fn project_root(&self, project_id: &str) -> Option<String> {
        self.projects()
            .find(|p| p["id"] == project_id)
            .and_then(|p| p["workspaceRoot"].as_str())
            .map(str::to_owned)
    }

    /// The thread's worktree, else its project's root.
    fn thread_root(&self, thread_id: &str) -> Option<String> {
        let thread = self.shell["threads"]
            .as_array()?
            .iter()
            .find(|t| t["id"] == thread_id)?;
        thread["worktreePath"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| self.project_root(thread["projectId"].as_str()?))
    }

    fn project_by_root(&self, cwd: &str) -> Option<&Value> {
        let wanted = conn_files::paths::normalize(std::path::Path::new(cwd.trim()));
        self.projects().find(|p| {
            p["workspaceRoot"].as_str().is_some_and(|root| {
                conn_files::paths::normalize(std::path::Path::new(root)) == wanted
            })
        })
    }

    fn known_workspaces(&self) -> (Vec<String>, Vec<(String, String)>) {
        let projects = self
            .projects()
            .filter_map(|p| p["workspaceRoot"].as_str().map(str::to_owned))
            .collect();
        let worktrees = self.shell["threads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| {
                let worktree = t["worktreePath"].as_str()?;
                Some((
                    self.project_root(t["projectId"].as_str()?)?,
                    worktree.to_owned(),
                ))
            })
            .collect();
        (projects, worktrees)
    }
}

/// The thread a resource names, for resources resolved against its workspace.
fn resource_thread(resource: &AssetResource) -> Option<&str> {
    match resource {
        AssetResource::WorkspaceFile(r) => Some(&r.thread_id),
        AssetResource::MediaFile(r) => Some(&r.thread_id),
        AssetResource::ToolOutputImage(r) => Some(&r.thread_id),
        _ => None,
    }
}

/// An archived thread is not in the shell snapshot; its projection still names its folder.
async fn archived_thread_root(
    engine: &Arc<dyn Engine>,
    layout: &Layout,
    thread_id: &str,
) -> Option<String> {
    let projection = engine
        .get_thread_projection(ThreadId::from(thread_id.to_owned()))
        .await
        .ok()?;
    let thread = if projection["thread"].is_object() {
        &projection["thread"]
    } else {
        &projection
    };
    thread["worktreePath"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| layout.project_root(thread["projectId"].as_str()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListIgnoredInput {
    cwd: String,
    query: Option<String>,
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(files) = deps.files.clone() else {
        return;
    };
    let engine = deps.engine.clone();

    let f = files.clone();
    table.unary(
        "projects.readFile",
        move |_, input: ProjectReadFileInput| {
            let f = f.clone();
            async move {
                check_length(&input.relative_path, false, PATH_MAX_LENGTH, "relativePath")?;
                blocking(move || {
                    workspace::read_file(&input, f.home.as_deref(), &f.internal)
                        .map_err(|e| fail(e.into_read_error(&input.cwd, &input.relative_path)))
                })
                .await?
            }
        },
    );

    let (e, environment) = (engine.clone(), deps.environment.clone());
    table.unary(
        "projects.writeFile",
        move |_, input: ProjectWriteFileInput| {
            let (e, environment) = (e.clone(), environment.clone());
            async move {
                check_length(&input.relative_path, false, PATH_MAX_LENGTH, "relativePath")?;
                let layout = Layout::load(e.as_ref()).await;
                let (projects, worktrees) = layout.known_workspaces();
                let managed = environment
                    .as_deref()
                    .map(crate::host::managed_worktree_dirs)
                    .unwrap_or_default();
                blocking(move || {
                    let known = KnownWorkspaces::new(&projects, &worktrees).with_managed(&managed);
                    workspace::write_file(&input, &|real| known.contains(real))
                        .map_err(|e| fail(e.into_write_error(&input.cwd, &input.relative_path)))
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "projects.listEntries",
        move |_, input: ProjectListEntriesInput| {
            let f = f.clone();
            async move {
                blocking(move || {
                    let root = entries::normalize_root(&input.cwd, f.home.as_deref(), &f.internal)
                        .map_err(|e| fail(e.into_list_error(&input.cwd)))?;
                    match input.directory_path.as_deref() {
                        Some(directory) => entries::list_directory(&root, directory, &f.internal)
                            .map_err(|e| fail(e.into_list_error(&input.cwd))),
                        None => Ok(entries::list_all(&root, &f.internal)),
                    }
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "projects.listIgnoredFiles",
        move |_, input: ListIgnoredInput| {
            let f = f.clone();
            async move {
                blocking(move || {
                    let root = entries::normalize_root(&input.cwd, f.home.as_deref(), &f.internal)
                        .map_err(|e| fail(e.into_list_error(&input.cwd)))?;
                    Ok(entries::list_ignored(
                        &root,
                        &f.internal,
                        input.query.as_deref(),
                    ))
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "projects.searchEntries",
        move |_, input: ProjectSearchEntriesInput| {
            let f = f.clone();
            async move {
                // A contract limit the generated types do not check.
                if input.query.encode_utf16().count() > 256 {
                    return Err(Failure::die("query must be at most 256 characters"));
                }
                blocking(move || {
                    let root = entries::normalize_root(&input.cwd, f.home.as_deref(), &f.internal)
                        .map_err(|e| {
                            fail(e.into_search_error(&input.cwd, &input.query, input.limit))
                        })?;
                    Ok(search::search_entries(&root, &input, &f.internal))
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "projects.searchContents",
        move |_, input: ProjectSearchContentsInput| {
            let f = f.clone();
            async move {
                // A contract limit the generated types do not check.
                if input.query.is_empty() || input.query.encode_utf16().count() > 256 {
                    return Err(Failure::die("query must be 1 to 256 characters"));
                }
                blocking(move || {
                    let root = entries::normalize_root(&input.cwd, f.home.as_deref(), &f.internal)
                        .map_err(|e| {
                            fail(e.into_contents_error(&input.cwd, &input.query, input.limit))
                        })?;
                    Ok(search::search_contents(&root, &input, &f.internal))
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "filesystem.getMetadata",
        move |_, input: FilesystemGetMetadataInput| {
            let f = f.clone();
            async move {
                if input.paths.is_empty() || input.paths.len() > 64 {
                    return Err(Failure::die("paths must hold 1 to 64 entries"));
                }
                for path in &input.paths {
                    check_length(path, true, PATH_MAX_LENGTH, "paths[]")?;
                }
                blocking(move || {
                    workspace::get_metadata(&input.paths, f.home.as_deref(), &f.internal)
                })
                .await
            }
        },
    );

    let f = files.clone();
    table.unary(
        "filesystem.browse",
        move |_, input: FilesystemBrowseInput| {
            let f = f.clone();
            async move {
                check_length(&input.partial_path, true, PATH_MAX_LENGTH, "partialPath")?;
                if let Some(cwd) = &input.cwd {
                    check_length(cwd, true, PATH_MAX_LENGTH, "cwd")?;
                }
                blocking(move || workspace::browse(&input, f.home.as_deref()).map_err(fail)).await?
            }
        },
    );

    // A container server has no desktop to open an editor on; `availableEditors` is empty, so
    // clients do not offer it. A call anyway gets the "command not found" answer.
    table.unary(
        "shell.openInEditor",
        |_, input: LaunchEditorInput| async move {
            let command = conn_contract::to_json(&input.editor)
                .as_str()
                .unwrap_or("editor")
                .to_owned();
            Err::<(), _>(fail(ExternalLauncherCommandNotFoundError {
                tag: lit::ExternalLauncherCommandNotFoundError,
                editor: input.editor,
                command,
            }))
        },
    );

    let (f, e) = (files.clone(), engine.clone());
    table.unary("assets.createUrl", move |_, input: AssetCreateUrlInput| {
        let (f, e) = (f.clone(), e.clone());
        async move {
            let resource = input.resource;
            if matches!(resource, AssetResource::GithubMedia(_)) {
                return Err(Failure::die(
                    "Conn Server does not fetch source control media yet",
                ));
            }
            let mut context = AssetContext::default();
            let absolute_media = matches!(&resource, AssetResource::MediaFile(m)
                if std::path::Path::new(&m.path).is_absolute() && !conn_files::paths::is_network_path(&m.path));
            if let AssetResource::DraftWorkspaceFile(draft) = &resource {
                context.workspace_root = Some(draft.cwd.clone());
            } else if let AssetResource::ProjectFavicon(favicon) = &resource {
                let layout = Layout::load(e.as_ref()).await;
                let Some(project) = layout.project_by_root(&favicon.cwd) else {
                    return Err(fail(assets::context_not_found(&resource)));
                };
                context.project_favicon_path = project["faviconPath"].as_str().map(str::to_owned);
            } else if let Some(thread_id) = resource_thread(&resource).filter(|_| !absolute_media) {
                let layout = Layout::load(e.as_ref()).await;
                context.workspace_root = match layout.thread_root(thread_id) {
                    Some(root) => Some(root),
                    None => match &e {
                        Some(engine) => archived_thread_root(engine, &layout, thread_id).await,
                        None => None,
                    },
                };
                if context.workspace_root.is_none() {
                    return Err(fail(assets::context_not_found(&resource)));
                }
            }
            blocking(move || {
                f.create_asset_url(&resource, &context, attachments::now_ms())
                    .map_err(fail)
            })
            .await?
        }
    });

    let f = files.clone();
    table.unary(
        "assets.persistChatAttachments",
        move |_, input: PersistChatAttachmentsInput| {
            let f = f.clone();
            async move {
                // The contract's limits, which the generated types do not check.
                conn_files::AttachmentStore::check_persist_input(&input).map_err(Failure::die)?;
                blocking(move || {
                    f.attachments
                        .persist_data_urls(&input)
                        .map(|attachments| PersistChatAttachmentsResult { attachments })
                        .map_err(fail)
                })
                .await?
            }
        },
    );

    let f = files.clone();
    table.unary(
        "attachments.createUploadUrl",
        move |_, input: AttachmentCreateUploadUrlInput| {
            let f = f.clone();
            async move {
                let input = attachments::UploadRequest::from(input);
                input.validate().map_err(Failure::die)?;
                blocking(move || {
                    f.attachments
                        .create_upload(&f.signer, &input, attachments::now_ms())
                })
                .await
            }
        },
    );

    let f = files;
    table.unary(
        "attachments.delete",
        move |_, input: AttachmentDeleteInput| {
            let f = f.clone();
            async move {
                blocking(move || f.attachments.delete_pending(&input.attachment_id)).await
            }
        },
    );
}

#[cfg(test)]
mod tests;
