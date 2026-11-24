//! Workspace rail edits: dragging a tile to a new place, the right-click menu, and `Remove
//! workspace`.
//!
//! The list is Orbit's (`orbit.workspaces`, synced in the profile). An edit changes it here
//! first, then saves it the way the other profile sections are saved: the local snapshot
//! on disk, and a 3-way merged push to the Gateway when workspace sync is on.

use conn_desktop::orbit::workspace_editor::{
    EditorProject, WorkspaceDraft, create_workspace, next_workspace_color, update_workspace,
};
use conn_desktop::orbit::{OrbitProfileClient, OrbitProjectsClient, OrbitWorkspace, ProfileError};
use gpui_kit::{AppContext as _, Context, Entity, Pixels, Point, PromptLevel, Window};

use super::ConnApp;
use crate::sidebar::rail::RailMenuAnchor;
use crate::sidebar::workspace_order;
use crate::workspace_editor::{WorkspaceEditor, WorkspaceEditorEvent, WorkspaceEditorInit};

/// Where the selected workspace is kept between launches (web: `activeWorkspaceId` in the
/// workspace store).
fn active_workspace_path() -> Option<std::path::PathBuf> {
    if cfg!(test) {
        return None;
    }
    Some(
        conn_desktop::orbit::OrbitSessionStore::default_path()?
            .parent()?
            .join("active-workspace.json"),
    )
}

/// The workspace selected last time, when it still exists (`merge` in `workspaceStore.ts`:
/// a stored selection that no longer names a workspace is all projects).
pub(super) fn saved_active_workspace(workspaces: &[OrbitWorkspace]) -> Option<String> {
    let text = std::fs::read_to_string(active_workspace_path()?).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id = value.get("activeWorkspaceId")?.as_str()?;
    workspaces.iter().any(|w| w.id == id).then(|| id.to_owned())
}

/// Keeps the selected workspace (none: all projects).
pub(super) fn save_active_workspace(active: Option<&str>) {
    let Some(path) = active_workspace_path() else {
        return;
    };
    let json = serde_json::json!({ "activeWorkspaceId": active }).to_string();
    let write = || -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    };
    if let Err(err) = write() {
        eprintln!("workspaces: could not keep the selection: {err}");
    }
}

impl ConnApp {
    /// Opens the workspace menu for `workspace_id` at `position` (window coordinates).
    pub(crate) fn open_rail_menu(
        &mut self,
        workspace_id: String,
        workspace_name: String,
        position: Point<Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        // One menu at a time: the thread menu and the details card close first.
        self.dismiss_shell_popovers(cx);
        self.rail_menu = Some(RailMenuAnchor {
            workspace_id,
            workspace_name,
            position,
        });
        cx.notify();
    }

    /// Opens the workspace editor: `None` creates a workspace (the rail's `+`), `Some(id)` edits
    /// that one (`Edit…` in a tile's menu).
    pub(crate) fn open_workspace_editor(
        &mut self,
        target: Option<String>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.rail_menu = None;
        if self.workspace_editor.is_some() {
            return;
        }
        let editing = target
            .as_ref()
            .and_then(|id| self.orbit.workspaces.iter().find(|w| &w.id == id).cloned());
        if target.is_some() && editing.is_none() {
            return;
        }
        self.remember_focus(window, cx);
        let (projects, preselected) = self.workspace_editor_projects(editing.as_ref());
        let init = WorkspaceEditorInit {
            default_color: next_workspace_color(&self.orbit.workspaces).to_owned(),
            editing,
            projects,
            preselected,
            tokens: self.tokens.clone(),
            geometry: self.geometry,
        };
        let editor = cx.new(|cx| WorkspaceEditor::new(init, window, cx));
        let sub = cx.subscribe_in(
            &editor,
            window,
            |app, editor, event: &WorkspaceEditorEvent, window, cx| match event {
                WorkspaceEditorEvent::Cancel => app.close_workspace_editor(window, cx),
                WorkspaceEditorEvent::Delete => {
                    if let Some(id) = app.workspace_editor_target.clone() {
                        app.remove_workspace_now(&id, cx);
                    }
                    app.close_workspace_editor(window, cx);
                }
                WorkspaceEditorEvent::Save(draft) => {
                    app.save_workspace_draft(editor, draft, window, cx);
                }
            },
        );
        self.overlay_subscriptions.push(sub);
        self.workspace_editor_target = target;
        self.workspace_editor = Some(editor.clone());
        self.load_orbit_projects_into(&editor, cx);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// Reads the Orbit projects the editor lists beside the machines' own.
    fn load_orbit_projects_into(
        &mut self,
        editor: &Entity<WorkspaceEditor>,
        cx: &mut Context<'_, Self>,
    ) {
        let weak = editor.downgrade();
        if !crate::orbit_sync::orbit_sync_enabled_by_env() {
            let _ = weak.update(cx, |editor, cx| {
                editor.set_orbit_projects(Some(Vec::new()), cx)
            });
            return;
        }
        cx.spawn(async move |_this, cx| {
            let task = crate::live::RT.spawn(async {
                OrbitProjectsClient::live()
                    .map_err(|err| err.to_string())?
                    .list_projects()
                    .await
                    .map_err(|err| err.to_string())
            });
            let projects = match task.await {
                Ok(Ok(projects)) => Some(
                    projects
                        .into_iter()
                        .map(|project| EditorProject {
                            key: project.slug,
                            display_name: project.name,
                            connection: None,
                            logical: true,
                        })
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            };
            let _ = weak.update(cx, |editor, cx| editor.set_orbit_projects(projects, cx));
        })
        .detach();
    }

    fn close_workspace_editor(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.workspace_editor = None;
        self.workspace_editor_target = None;
        self.restore_focus(window, cx);
        self.sync_browser_visibility(cx);
        cx.notify();
    }

    /// `Create` or `Save` in the editor: validates the draft, saves the list (to disk and to the
    /// Orbit profile) and selects a new workspace (`selectWorkspace(createWorkspace(draft).id)`).
    /// A refused draft stays open with the reason under the form.
    fn save_workspace_draft(
        &mut self,
        editor: &Entity<WorkspaceEditor>,
        draft: &WorkspaceDraft,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let target = self.workspace_editor_target.clone();
        let new_id = format!("ws-{}", new_workspace_uuid());
        let result = match &target {
            Some(id) => update_workspace(&self.orbit.workspaces, id, draft),
            None => create_workspace(&self.orbit.workspaces, draft, &new_id),
        };
        match result {
            Err(message) => editor.update(cx, |editor, cx| editor.set_error(message, cx)),
            Ok(next) => {
                self.set_workspaces(next, cx);
                if target.is_none() {
                    self.select_workspace(Some(new_id), cx);
                }
                self.close_workspace_editor(window, cx);
            }
        }
    }

    /// The badge images the rail paints, decoded once from each workspace's data URL.
    pub(crate) fn refresh_workspace_images(&mut self) {
        let workspaces = &self.orbit.workspaces;
        self.workspace_images
            .retain(|id, _| workspaces.iter().any(|w| &w.id == id));
        for workspace in workspaces {
            let Some(url) = &workspace.image else {
                self.workspace_images.remove(&workspace.id);
                continue;
            };
            if self
                .workspace_images
                .get(&workspace.id)
                .is_some_and(|(cached, _)| cached == url)
            {
                continue;
            }
            self.workspace_images.insert(
                workspace.id.clone(),
                (url.clone(), crate::workspace_image::image_of_data_url(url)),
            );
        }
    }

    /// The pointer went down on a workspace tile: a move of 6px turns the press into a drag.
    pub(crate) fn rail_tile_pressed(
        &mut self,
        workspace_id: &str,
        position: Point<Pixels>,
        cx: &mut Context<'_, Self>,
    ) {
        // A menu or a gesture of the thread sidebar has the pointer; a rename or a single
        // workspace has nothing to reorder.
        if self.thread_menu.is_some() || self.pointer_captured() || self.orbit.workspaces.len() < 2
        {
            return;
        }
        self.rail_gesture
            .state
            .pressed(workspace_id, (f32::from(position.x), f32::from(position.y)));
        // The window listens for the pointer from the next frame on.
        cx.notify();
    }

    /// The pointer moved with the button down. Whether the rail has the pointer.
    pub(crate) fn rail_pointer_moved(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if !self.rail_gesture.state.is_active() {
            return false;
        }
        if self
            .rail_gesture
            .pointer_moved(position, &self.orbit.workspaces)
        {
            cx.notify();
        }
        true
    }

    /// The pointer went up, or `Escape` or a lost window cancelled the gesture. A drop on
    /// another tile's place moves the workspace there and saves the list. Whether the rail had
    /// the pointer.
    pub(crate) fn rail_pointer_released(
        &mut self,
        cancel: bool,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        if !self.rail_gesture.state.is_active() {
            return false;
        }
        if let Some((held, over)) = self.rail_gesture.state.released(cancel)
            && let Some(next) = workspace_order::moved(&self.orbit.workspaces, &held, &over)
        {
            self.set_workspaces(next, cx);
        }
        cx.notify();
        true
    }

    /// A drag ended on the tile: the click that follows selects nothing.
    pub(crate) fn rail_click_suppressed(&self) -> bool {
        self.rail_gesture.state.click_suppressed()
    }

    /// `Remove workspace "<name>"?` destructive confirmation, then the removal. The projects and
    /// threads it grouped are not touched: a workspace is only a saved scope over them.
    pub(crate) fn confirm_remove_workspace(
        &mut self,
        workspace_id: String,
        workspace_name: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.rail_menu = None;
        cx.notify();
        let answer = window.prompt(
            PromptLevel::Critical,
            &format!("Remove workspace \"{workspace_name}\"?"),
            Some("Its projects and threads stay in Conn. Only the workspace is removed."),
            &["Remove", "Cancel"],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await != Ok(0) {
                return;
            }
            let _ = this.update(cx, |app, cx| {
                app.remove_workspace_now(&workspace_id, cx);
            });
        })
        .detach();
    }

    fn remove_workspace_now(&mut self, workspace_id: &str, cx: &mut Context<'_, Self>) {
        let Some(next) = workspace_order::removed(&self.orbit.workspaces, workspace_id) else {
            return;
        };
        let active =
            workspace_order::active_after_removal(self.active_workspace.as_deref(), workspace_id);
        self.set_workspaces(next, cx);
        if active != self.active_workspace {
            self.select_workspace(active, cx);
        }
    }

    /// Takes `next` as the workspace list and saves it: to disk, and to the Orbit profile when
    /// workspace sync is on. A failed push leaves the local edit in place and says so in the
    /// Orbit notice; the next successful fetch brings the profile's list back.
    fn set_workspaces(&mut self, next: Vec<OrbitWorkspace>, cx: &mut Context<'_, Self>) {
        self.orbit.workspaces = next.clone();
        let push = crate::orbit_sync::orbit_sync_enabled_by_env()
            && self.orbit.snapshot.prefs.sync_workspaces;
        let Some(profile_id) = self.orbit.active_profile_id().filter(|_| push) else {
            self.orbit.snapshot.workspaces = next;
            // A test must not write over the snapshot in the user's config directory.
            if !cfg!(test) {
                self.orbit.persist_snapshot();
            }
            cx.notify();
            return;
        };
        // The snapshot keeps the last list Orbit confirmed: the merge base if the push conflicts.
        let base = self.orbit.snapshot.workspaces.clone();
        let version = self.orbit.snapshot.profile_version;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(push_workspaces(profile_id, base, next, version));
            let outcome = match task.await {
                Ok(res) => res,
                Err(err) => Err(ProfileError::Unreachable(err.to_string())),
            };
            let _ = this.update(cx, |app, cx| {
                match outcome {
                    Ok(saved) => {
                        app.orbit.snapshot.profile_version = saved.version;
                        app.orbit.snapshot.workspaces = saved.workspaces.clone();
                        app.orbit.workspaces = saved.workspaces;
                        app.orbit.persist_snapshot();
                    }
                    Err(err) => {
                        app.orbit.notice =
                            Some(format!("Could not save workspaces to Orbit: {err}"));
                    }
                }
                app.refresh_settings_orbit_info(cx);
                cx.notify();
            });
        })
        .detach();
    }
}

/// Pushes the workspace list to the profile with 3-way merge and retry on a version conflict.
async fn push_workspaces(
    profile_id: i64,
    base: Vec<OrbitWorkspace>,
    local: Vec<OrbitWorkspace>,
    version: i64,
) -> Result<conn_desktop::orbit::OrbitProfileSettings, ProfileError> {
    let client =
        OrbitProfileClient::live().map_err(|err| ProfileError::Unreachable(err.to_string()))?;
    client
        .push_workspaces_merged(profile_id, &base, &local, version)
        .await
}

/// A random id for a new workspace (`randomUUID`), shaped as the thread ids are.
fn new_workspace_uuid() -> String {
    conn_client::commands::new_thread_id()
        .trim_start_matches("thread-")
        .to_owned()
}

#[cfg(test)]
impl ConnApp {
    /// The workspace editor, when it is open.
    pub(crate) fn workspace_editor_for_test(&self) -> Option<Entity<WorkspaceEditor>> {
        self.workspace_editor.clone()
    }

    /// Closes the workspace editor.
    pub(crate) fn workspace_editor_for_test_close(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.close_workspace_editor(window, cx);
    }

    /// The workspaces as saved.
    pub(crate) fn workspaces_for_test(&self) -> Vec<OrbitWorkspace> {
        self.orbit.workspaces.clone()
    }

    /// Replaces the rail's workspaces without saving them anywhere.
    pub(crate) fn set_rail_workspaces_for_test(
        &mut self,
        workspaces: Vec<OrbitWorkspace>,
        cx: &mut Context<'_, Self>,
    ) {
        self.orbit.workspaces = workspaces;
        cx.notify();
    }

    /// The rail's workspace ids in order.
    pub(crate) fn rail_workspace_ids_for_test(&self) -> Vec<String> {
        self.orbit.workspaces.iter().map(|w| w.id.clone()).collect()
    }

    /// The tile held in the rail and the slot it hovers over.
    pub(crate) fn rail_held_for_test(&self) -> Option<(String, String)> {
        self.rail_gesture
            .state
            .drag()
            .map(|drag| (drag.id.clone(), drag.over.clone()))
    }

    /// Whether the workspace menu is open.
    pub(crate) fn rail_menu_open_for_test(&self) -> bool {
        self.rail_menu.is_some()
    }

    /// `Remove workspace` after the confirmation said yes.
    pub(crate) fn remove_workspace_for_test(&mut self, id: &str, cx: &mut Context<'_, Self>) {
        self.remove_workspace_now(id, cx);
    }
}
