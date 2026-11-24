//! Linked environments: the thread list of every Orbit environment, as Conn lists them.
//!
//! Conn keeps one connection per registered Orbit server (Nodes are paired automatically, an
//! Instance's server once the user connected it) and merges their shells into one sidebar.
//! `ConnApp` does the same beside its primary connection: [`plan_linked_environments`] picks the
//! servers, [`EnvironmentSet`] connects them, and every environment's shell is merged into
//! `ConnApp::shell` (`conn_state::environments`). A thread remembers its environment, so opening
//! it subscribes on that environment's connection and its chat sends there too.
//!
//! Decided by Nick on 2026-11-23 ("same state in Conn GPUI as in the current Conn"); see
//! `docs/scope.md`, section "Linked environments".

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use conn_client::environments::{EnvironmentEvent, EnvironmentSet, EnvironmentTarget};
use conn_client::{ClientEvent, Connection, ConnectionStatus, Credential, ServerConfig};
use conn_desktop::orbit::linked::{
    LinkedPlanInput, confirm_gone_environments, plan_linked_environments,
};
use conn_desktop::orbit::{LinkedEnvironmentSettings, LinkedStore};
use conn_state::ThreadState;
use conn_state::environments::{LinkedShellSnapshot, LinkedShells, Origins};
use gpui_kit::Context;

use super::ConnApp;

/// How long a changed shell waits before it is saved, so a burst of events writes once.
const SHELL_SAVE_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

/// What the app knows about the environments it lists beside its primary one.
#[derive(Default)]
pub(super) struct LinkedEnvironments {
    shells: LinkedShells,
    /// Where the snapshots and the user's choices live; none in tests and demo runs.
    store: Option<LinkedStore>,
    /// The user's choices: environments switched off, Instances chosen for linking.
    settings: LinkedEnvironmentSettings,
    /// Connection state of each held environment, for Settings.
    statuses: HashMap<String, ConnectionStatus>,
    /// When each known server was first missing from the Gateway's list (`GONE_CONFIRM_MS`).
    missing_since_ms: HashMap<String, i64>,
    /// Environments whose live shell changed since it was last saved.
    dirty: HashSet<String>,
    save_scheduled: bool,
    origins: Origins,
    set: Option<EnvironmentSet>,
    /// Environments a pairing is being minted for.
    pairing: HashSet<String>,
    pair_attempted_at_ms: HashMap<String, i64>,
    /// Where each linked environment answers, for the chat's per-environment draft key.
    urls: HashMap<String, String>,
    /// The environment the open thread's subscription lives on; `None` is the primary one.
    subscribed_env: Option<String>,
    /// A child opened from its parent before the linked shell lists it.
    opened_child: Option<(String, String)>,
    /// The environment the chat and right panel were last pointed at; `None` is the primary one.
    chat_env: Option<String>,
    /// What each linked environment says it is (`EnvironmentMachineKind`), from its server config.
    machines: HashMap<String, String>,
    /// Each linked environment's provider and model catalog (`subscribeServerConfig`), which the
    /// composer offers while a thread of that environment is open.
    configs: HashMap<String, std::sync::Arc<conn_state::providers::ServerConfigState>>,
    /// Each linked environment's scratch workspace root, to tell its scratch projects.
    scratch_roots: HashMap<String, String>,
    /// What the primary environment says it is, for its rows when the list spans environments.
    primary_machine: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `ICON_BY_KIND` of `EnvironmentMachineIcon.tsx`, as superheroicons. Linux has no glyph of its
/// own in the set, so it reads as a server.
fn machine_icon_path(kind: Option<&str>) -> &'static str {
    match kind {
        Some("cloud") => "superhero/cloud.svg",
        Some("desktop") => "superhero/desktop.svg",
        Some("laptop") => "superhero/laptop.svg",
        Some("mac-mini") => "superhero/computer-mini.svg",
        Some("mac-studio") => "superhero/computer-studio.svg",
        _ => "superhero/server.svg",
    }
}

/// `resolveEnvironmentMachineKind`: the icon the user chose, else the platform's machine.
fn machine_kind(config: &conn_contract::ServerConfig) -> Option<String> {
    let chosen = config
        .settings
        .environment_icon
        .as_ref()
        .and_then(Option::as_ref)
        .and_then(serde_json::Value::as_str);
    let platform = config
        .environment
        .platform
        .machine
        .as_ref()
        .and_then(serde_json::Value::as_str);
    chosen.or(platform).map(str::to_owned)
}

fn is_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("401") || lower.contains("auth") || lower.contains("unauthorized")
}

impl LinkedEnvironments {
    /// Loads the user's choices and lists every saved environment from its last snapshot, as Conn
    /// does from its connection cache. Nothing is read in tests or demo runs.
    pub(super) fn load() -> Self {
        let mut linked = Self::default();
        if !crate::orbit_sync::orbit_sync_enabled_by_env() {
            return linked;
        }
        linked.store = LinkedStore::default_store();
        if let Some(store) = &linked.store {
            linked.settings = store.load_settings();
            for bytes in store.load_shells() {
                if let Some(snapshot) = LinkedShellSnapshot::from_json(&bytes)
                    && linked.settings.is_enabled(&snapshot.environment_id)
                {
                    linked.shells.restore_snapshot(snapshot);
                }
            }
        }
        linked
    }

    pub(super) fn shell_for_cache(&self, env: &str) -> Option<&conn_state::ShellState> {
        self.shells.shell(env)
    }

    pub(super) fn cache_threads(
        &self,
        predicate: impl Fn(&conn_state::ThreadShell) -> bool,
    ) -> Vec<(String, String)> {
        let mut keys = Vec::new();
        for env in self.shells.environments() {
            if let Some(shell) = self.shells.shell(&env.id) {
                keys.extend(
                    shell
                        .threads
                        .iter()
                        .chain(&shell.archived_threads)
                        .filter(|t| predicate(t))
                        .map(|t| (env.id.clone(), t.id.clone())),
                );
            }
        }
        keys
    }

    /// Lists `environment_id` again from its saved snapshot (it was switched back on).
    fn restore_cached(&mut self, environment_id: &str) {
        let Some(store) = &self.store else {
            return;
        };
        for bytes in store.load_shells() {
            if let Some(snapshot) = LinkedShellSnapshot::from_json(&bytes)
                && snapshot.environment_id == environment_id
            {
                self.shells.restore_snapshot(snapshot);
            }
        }
    }

    fn save_settings(&self) {
        if let Some(store) = &self.store
            && let Err(err) = store.save_settings(&self.settings)
        {
            eprintln!("linked environments: could not save choices: {err}");
        }
    }

    pub(super) fn origins(&self) -> &Origins {
        &self.origins
    }

    pub(super) fn is_empty(&self) -> bool {
        self.shells.is_empty() && self.origins == Origins::default()
    }

    /// The machine icon of `environment_id` (`EnvironmentMachineIcon`): its configured icon, else
    /// the platform's machine, else a server.
    pub(super) fn machine_icon(&self, environment_id: &str) -> &'static str {
        machine_icon_path(self.machines.get(environment_id).map(String::as_str))
    }

    /// Machine icons of the linked environments, by environment id, for the sidebar rows.
    pub(super) fn machine_icons(&self) -> HashMap<String, &'static str> {
        self.shells
            .environments()
            .into_iter()
            .map(|environment| {
                let icon = self.machine_icon(&environment.id);
                (environment.id, icon)
            })
            .collect()
    }
}

impl ConnApp {
    /// The id of the environment the primary connection talks to: the Orbit server it was paired
    /// as, else the fleet entry at its address, else its address.
    pub(super) fn primary_environment_id(&self) -> String {
        self.orbit
            .active_server_id
            .clone()
            .or_else(|| {
                self.server_url
                    .as_deref()
                    .and_then(|url| self.orbit.fleet.find_by_url(url))
                    .map(|target| target.server_id.clone())
            })
            .or_else(|| self.server_url.clone())
            .unwrap_or_else(|| "primary".to_owned())
    }

    pub(super) fn primary_environment_label(&self) -> String {
        self.server_label
            .clone()
            .or_else(|| {
                self.orbit
                    .fleet
                    .find_by_server_id(&self.primary_environment_id())
                    .map(|target| target.label.clone())
            })
            .unwrap_or_else(|| self.primary_environment_id())
    }

    /// Whether the app lists linked environments at all: a live primary connection and Orbit on.
    fn linking_enabled(&self) -> bool {
        self.connection.is_some() && crate::orbit_sync::orbit_sync_enabled_by_env()
    }

    /// The environment a thread of the merged list lives on; `None` is the primary one.
    pub(crate) fn linked_environment_of_thread(&self, thread_id: &str) -> Option<&str> {
        let origins = self.linked.origins();
        if origins.is_linked_thread(thread_id) {
            return Some(origins.environment_of_thread(thread_id));
        }
        self.linked
            .opened_child
            .as_ref()
            .filter(|(child, _)| child == thread_id && self.shell.find_thread(thread_id).is_none())
            .map(|(_, environment)| environment.as_str())
    }

    pub(super) fn open_remote_child(
        &mut self,
        environment: &str,
        child: &str,
        cx: &mut Context<'_, Self>,
    ) {
        let primary = self.primary_environment_id();
        if self.shell.find_thread(child).is_some() {
            let owner = self.linked_environment_of_thread(child).unwrap_or(&primary);
            if owner != environment {
                self.chat.update(cx, |chat, cx| {
                    chat.set_error(
                        Some("This thread ID is also in another environment.".to_owned()),
                        cx,
                    )
                });
                return;
            }
        } else if environment != primary && self.linked_connection(environment).is_none() {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(
                    Some("Connect to the child’s environment to open its thread.".to_owned()),
                    cx,
                )
            });
            return;
        }
        self.linked.opened_child =
            (environment != primary).then(|| (child.to_owned(), environment.to_owned()));
        self.select_thread(child, cx);
    }

    /// The environment a project of the merged list lives on; `None` is the primary one.
    pub(crate) fn linked_environment_of_project(&self, project_id: &str) -> Option<&str> {
        let origins = self.linked.origins();
        origins
            .is_linked_project(project_id)
            .then(|| origins.environment_of_project(project_id))
    }

    /// The label of the environment a thread lives on, for its hover card and details
    /// (`environmentLabelById.get(thread.environmentId)`): a linked environment's own label, else
    /// the primary connection's.
    pub(crate) fn hover_environment_label(&self, thread_id: Option<&str>) -> Option<String> {
        thread_id
            .and_then(|id| {
                self.linked_environment_of_thread(id)
                    .and_then(|environment| self.linked.origins().label(environment))
                    .map(str::to_owned)
            })
            .or_else(|| self.server_label.clone())
    }

    pub(super) fn thread_connected(&self, id: &str) -> bool {
        let status = match self.linked_environment_of_thread(id) {
            Some(env) => self.linked.statuses.get(env),
            None => self.status.as_ref(),
        };
        matches!(status, Some(ConnectionStatus::Connected))
    }

    pub(super) fn cache_environment_connected(&self, env: &str) -> bool {
        let status = if self.server_url.as_deref() == Some(env) {
            self.status.as_ref()
        } else {
            self.linked.statuses.get(env)
        };
        matches!(status, Some(ConnectionStatus::Connected))
    }

    /// The connection of the environment `thread_id` lives on.
    pub(crate) fn connection_for_thread(&self, thread_id: &str) -> Option<Connection> {
        match self.linked_environment_of_thread(thread_id) {
            Some(environment) => self.linked_connection(environment),
            None => self.connection.clone(),
        }
    }

    /// The connection of the environment `project_id` lives on.
    pub(crate) fn connection_for_project(&self, project_id: &str) -> Option<Connection> {
        match self.linked_environment_of_project(project_id) {
            Some(environment) => self.linked_connection(environment),
            None => self.connection.clone(),
        }
    }

    /// The connections of every linked environment that is connected now.
    pub(super) fn linked_connections(&self) -> Vec<Connection> {
        let Some(set) = self.linked.set.as_ref() else {
            return Vec::new();
        };
        let mut ids = set.environment_ids();
        ids.sort();
        ids.iter()
            .filter_map(|id| set.connection(id).cloned())
            .collect()
    }

    pub(super) fn linked_connection(&self, environment_id: &str) -> Option<Connection> {
        self.linked
            .set
            .as_ref()
            .and_then(|set| set.connection(environment_id))
            .cloned()
    }

    /// The connection of the environment a command is for: its thread's, else its project's,
    /// else the primary one.
    pub(crate) fn connection_for_command(
        &self,
        command: &conn_contract::OrchestrationV2Command,
    ) -> Option<Connection> {
        let value = serde_json::to_value(command).ok();
        let field = |name: &str| {
            value
                .as_ref()
                .and_then(|v| v.get(name))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        };
        if let Some(thread_id) = field("threadId") {
            return self.connection_for_thread(&thread_id);
        }
        if let Some(project_id) = field("projectId") {
            return self.connection_for_project(&project_id);
        }
        self.connection.clone()
    }

    /// The provider and model catalog of the environment the open thread (or draft) lives on.
    pub(crate) fn active_server_config(
        &self,
    ) -> std::sync::Arc<conn_state::providers::ServerConfigState> {
        match self.context_environment() {
            Some(environment) => self
                .linked
                .configs
                .get(&environment)
                .cloned()
                .unwrap_or_default(),
            None => std::sync::Arc::clone(&self.server_config),
        }
    }

    /// The scratch workspace root of the environment `project_id` lives on.
    pub(crate) fn scratch_root_for_project(&self, project_id: &str) -> Option<String> {
        match self.linked_environment_of_project(project_id) {
            Some(environment) => self.linked.scratch_roots.get(environment).cloned(),
            None => self.scratch_workspace_root.clone(),
        }
    }

    /// Records what the primary environment says it is, from its config snapshot.
    pub(super) fn record_primary_machine(
        &mut self,
        event: &conn_contract::ServerConfigStreamEvent,
    ) {
        if let conn_contract::ServerConfigStreamEvent::Snapshot(snapshot) = event {
            self.linked.primary_machine = machine_kind(&snapshot.config);
        }
    }

    /// The projects that are scratch projects on their own environment (`isScratchProject`).
    pub(crate) fn scratch_project_ids(&self) -> HashSet<String> {
        self.shell
            .projects
            .iter()
            .filter(|project| self.is_scratch_project(&project.id, Some(&project.workspace_root)))
            .map(|project| project.id.clone())
            .collect()
    }

    /// The machine icon of the primary environment's rows.
    pub(crate) fn primary_machine_icon(&self) -> &'static str {
        machine_icon_path(self.linked.primary_machine.as_deref())
    }

    /// The connection for what the user has open: the selected thread's environment, else the
    /// open draft's (or selected) project's, else the primary one.
    pub(crate) fn context_connection(&self) -> Option<Connection> {
        if let Some(thread_id) = self.layout.selected_thread_id.as_deref() {
            return self.connection_for_thread(thread_id);
        }
        let project_id = self
            .draft
            .as_ref()
            .map(|draft| draft.project_id.as_str())
            .or(self.layout.selected_project_id.as_deref());
        match project_id {
            Some(project_id) => self.connection_for_project(project_id),
            None => self.connection.clone(),
        }
    }

    /// The environment [`Self::context_connection`] belongs to; `None` is the primary one.
    pub(super) fn context_environment(&self) -> Option<String> {
        if let Some(thread_id) = self.layout.selected_thread_id.as_deref() {
            return self
                .linked_environment_of_thread(thread_id)
                .map(str::to_owned);
        }
        let project_id = self
            .draft
            .as_ref()
            .map(|draft| draft.project_id.as_str())
            .or(self.layout.selected_project_id.as_deref())?;
        self.linked_environment_of_project(project_id)
            .map(str::to_owned)
    }

    /// Points the chat and the right panel at the connection of what is open, when that moved to
    /// another environment since the last call.
    pub(super) fn sync_chat_environment(&mut self, cx: &mut Context<'_, Self>) {
        let environment = self.context_environment();
        if environment == self.linked.chat_env {
            return;
        }
        let Some(connection) = self.context_connection() else {
            return;
        };
        let url = match &environment {
            Some(id) => self.linked.urls.get(id).cloned(),
            None => self.server_url.clone(),
        };
        self.linked.chat_env = environment;
        self.push_server_config(cx);
        self.chat.update(cx, |chat, cx| {
            chat.set_environment_key(url);
            chat.set_connection(Some(connection.clone()), cx);
        });
        self.right_panel
            .update(cx, |panel, cx| panel.set_connection(Some(connection), cx));
    }

    /// Subscribes the open thread's timeline on its environment's connection, after ending the
    /// previous subscription on the connection it lives on.
    pub(super) fn subscribe_open_thread(&mut self, thread_id: &str) {
        self.unsubscribe_open_thread();
        let environment = self
            .linked_environment_of_thread(thread_id)
            .map(str::to_owned);
        let Some(connection) = self.connection_for_thread(thread_id) else {
            return;
        };
        self.threads
            .entry(thread_id.to_owned())
            .or_insert_with(|| ThreadState::new(thread_id.to_owned()));
        connection.subscribe_thread(thread_id);
        self.subscribed_thread_id = Some(thread_id.to_owned());
        self.linked.subscribed_env = environment;
    }

    /// Ends the open thread's subscription on the connection it was made on.
    pub(super) fn unsubscribe_open_thread(&mut self) {
        let Some(previous) = self.subscribed_thread_id.take() else {
            return;
        };
        let owner = self.linked.subscribed_env.take();
        let connection = match &owner {
            Some(environment) => self.linked_connection(environment),
            None => self.connection.clone(),
        };
        if let Some(connection) = connection
            && !self
                .offline
                .watching(owner.as_deref().or(self.server_url.as_deref()), &previous)
        {
            connection.unsubscribe_thread(&previous);
        }
    }

    /// Merges the linked environments' shells into `self.shell` again. Call after the primary
    /// shell or a linked one changed.
    pub(super) fn remerge_linked_shells(&mut self) {
        if self.linked.is_empty() {
            return;
        }
        let primary_id = self.primary_environment_id();
        let primary_label = self.primary_environment_label();
        self.linked.origins = self.linked.shells.merge_into(
            &primary_id,
            &primary_label,
            &mut self.shell,
            &self.linked.origins,
        );
    }

    /// The projects the workspace editor offers, under the machine each lives on
    /// (`availableProjects` of `workspaceStore.ts`), and the ones an edited workspace already
    /// covers by name or folder, which start checked.
    pub(super) fn workspace_editor_projects(
        &self,
        editing: Option<&conn_desktop::orbit::OrbitWorkspace>,
    ) -> (
        Vec<conn_desktop::orbit::workspace_editor::EditorProject>,
        Vec<String>,
    ) {
        use conn_desktop::orbit::workspace_editor::{EditorConnection, EditorProject};
        let primary_id = self.primary_environment_id();
        let environment_of = |project_id: &str| {
            self.linked_environment_of_project(project_id)
                .map_or_else(|| primary_id.clone(), str::to_owned)
        };
        let labels = conn_state::project_groups::project_group_labels_across_environments(
            &self.shell.projects,
            |id| environment_of(id),
        );
        let primary_label = self.primary_environment_label();
        let mut projects = Vec::new();
        let mut preselected = Vec::new();
        for project in &self.shell.projects {
            if project.archived_at.is_some()
                || self.is_scratch_project(&project.id, Some(&project.workspace_root))
            {
                continue;
            }
            let environment = environment_of(&project.id);
            let primary = environment == primary_id;
            let label = if primary {
                primary_label.clone()
            } else {
                self.linked
                    .origins()
                    .label(&environment)
                    .unwrap_or(&environment)
                    .to_owned()
            };
            let kind = if primary {
                self.linked.primary_machine.clone()
            } else {
                self.linked.machines.get(&environment).cloned()
            }
            .unwrap_or_else(|| "server".to_owned());
            let key = format!("{environment}:{}", project.id);
            if editing.is_some_and(|workspace| {
                conn_desktop::orbit::workspace_matches_project(
                    workspace,
                    &project.id,
                    &project.title,
                    &project.workspace_root,
                )
            }) {
                preselected.push(key.clone());
            }
            projects.push(EditorProject {
                key,
                display_name: labels
                    .get(&project.id)
                    .cloned()
                    .unwrap_or_else(|| project.title.clone()),
                connection: Some(EditorConnection {
                    environment_id: environment,
                    label,
                    kind,
                    primary,
                }),
                logical: false,
            });
        }
        (projects, preselected)
    }

    /// Saves the shells that changed, a little after the last change, off the main thread
    /// (Conn: `EnvironmentShellState.persistLatest`). Only a synced shell is saved, never one that
    /// was merely restored.
    fn schedule_linked_shell_save(&mut self, cx: &mut Context<'_, Self>) {
        if self.linked.save_scheduled || self.linked.dirty.is_empty() || self.linked.store.is_none()
        {
            return;
        }
        self.linked.save_scheduled = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SHELL_SAVE_DELAY).await;
            let _ = this.update(cx, |app, _cx| {
                app.linked.save_scheduled = false;
                let dirty: Vec<String> = app.linked.dirty.drain().collect();
                let snapshots: Vec<LinkedShellSnapshot> = dirty
                    .iter()
                    .filter(|id| {
                        app.linked
                            .shells
                            .shell(id)
                            .is_some_and(|shell| shell.synchronized)
                    })
                    .filter_map(|id| app.linked.shells.snapshot(id))
                    .collect();
                let Some(store) = app.linked.store.clone() else {
                    return;
                };
                crate::live::RT.spawn_blocking(move || {
                    for snapshot in snapshots {
                        match snapshot.to_json() {
                            Ok(bytes) => {
                                if let Err(err) = store.save_shell(&snapshot.environment_id, &bytes)
                                {
                                    eprintln!("linked environments: could not save a shell: {err}");
                                }
                            }
                            Err(err) => eprintln!("linked environments: shell snapshot: {err}"),
                        }
                    }
                });
            });
        })
        .detach();
    }

    /// The linked environments for Settings: every one this device lists, saved or switched off,
    /// with how it stands.
    pub(crate) fn linked_settings_rows(&self) -> Vec<crate::orbit_sync::LinkedEnvironmentInfo> {
        use crate::orbit_sync::{LinkedEnvironmentInfo, LinkedEnvironmentState};
        let primary = self.primary_environment_id();
        let mut ids: Vec<String> = self
            .linked
            .shells
            .environments()
            .into_iter()
            .map(|environment| environment.id)
            .collect();
        // A switched-off environment stays listed to be switched back on; so does a paired one
        // the Gateway still lists that has no threads yet.
        for id in self
            .linked
            .settings
            .disabled
            .iter()
            .chain(self.orbit.sessions.sessions.keys())
        {
            let known = self.linked.settings.disabled.contains(id)
                || self.orbit.fleet.find_by_server_id(id).is_some();
            if *id != primary && known && !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let mut rows: Vec<LinkedEnvironmentInfo> = ids
            .into_iter()
            .map(|id| {
                let label = self
                    .linked
                    .shells
                    .label(&id)
                    .map(str::to_owned)
                    .or_else(|| {
                        self.orbit
                            .fleet
                            .find_by_server_id(&id)
                            .map(|target| target.label.clone())
                    })
                    .unwrap_or_else(|| id.clone());
                let enabled = self.linked.settings.is_enabled(&id);
                let state = if !enabled {
                    LinkedEnvironmentState::Off
                } else {
                    match self.linked.statuses.get(&id) {
                        Some(ConnectionStatus::Connected) => LinkedEnvironmentState::Connected,
                        Some(
                            ConnectionStatus::Connecting | ConnectionStatus::Reconnecting { .. },
                        ) => LinkedEnvironmentState::Connecting,
                        _ => LinkedEnvironmentState::Offline,
                    }
                };
                let thread_count = self
                    .linked
                    .shells
                    .shell(&id)
                    .map_or(0, |shell| shell.threads.len());
                LinkedEnvironmentInfo {
                    id,
                    label,
                    enabled,
                    state,
                    thread_count,
                }
            })
            .collect();
        rows.sort_by_key(|a| a.label.to_lowercase());
        rows
    }

    /// The Instance servers the user chose to link (switched on in Settings) and the ones this
    /// device already holds a session for.
    pub(crate) fn linked_instance_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.linked.settings.instances.iter().cloned().collect();
        ids.extend(self.orbit.sessions.sessions.keys().cloned());
        ids.sort();
        ids.dedup();
        ids
    }

    /// Conn's per-environment switch (`setEnabled`): off holds the environment off and takes its
    /// threads out of the list while it stays saved; on connects it again and lists them.
    pub(crate) fn set_linked_environment_enabled(
        &mut self,
        environment_id: &str,
        enabled: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.linked.settings.set_enabled(environment_id, enabled) {
            return;
        }
        self.linked.save_settings();
        if enabled {
            self.linked.restore_cached(environment_id);
        } else {
            if let Some(set) = self.linked.set.as_mut() {
                self.offline.disconnected(environment_id);
                set.disconnect(environment_id);
            }
            self.linked.statuses.remove(environment_id);
            self.linked.shells.remove(environment_id);
        }
        self.remerge_linked_shells();
        self.sync_linked_environments(cx);
        self.sync_chat(cx);
        self.refresh_settings_orbit_info(cx);
        cx.notify();
    }

    /// Links an Orbit Instance's server (or stops choosing it): once it runs it is paired and kept
    /// like a Node's, and its threads list from the saved copy while it sleeps.
    pub(crate) fn set_linked_instance(
        &mut self,
        server_id: &str,
        linked: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let changed = if linked {
            self.linked.settings.instances.insert(server_id.to_owned())
        } else {
            self.linked.settings.instances.remove(server_id)
        };
        if !changed {
            return;
        }
        self.linked.save_settings();
        self.sync_linked_environments(cx);
        self.refresh_settings_orbit_info(cx);
        cx.notify();
    }

    /// Test helper: lists `shell` as the threads of a linked environment, as its connection would.
    #[cfg(test)]
    pub(crate) fn add_linked_shell_for_test(
        &mut self,
        environment_id: &str,
        label: &str,
        shell: conn_state::ShellState,
        cx: &mut Context<'_, Self>,
    ) {
        self.linked.shells.ensure(environment_id, label);
        self.linked.shells.restore(environment_id, shell);
        self.remerge_linked_shells();
        cx.notify();
    }

    /// Test helper: the scratch workspace root a linked environment reported.
    #[cfg(test)]
    pub(crate) fn set_linked_scratch_root_for_test(&mut self, environment_id: &str, root: &str) {
        self.linked
            .scratch_roots
            .insert(environment_id.to_owned(), root.to_owned());
    }

    /// Test helper: a linked environment's provider catalog.
    #[cfg(test)]
    pub(crate) fn set_linked_config_for_test(
        &mut self,
        environment_id: &str,
        config: std::sync::Arc<conn_state::providers::ServerConfigState>,
    ) {
        self.linked
            .configs
            .insert(environment_id.to_owned(), config);
    }

    /// Test helper: the ids of every thread of the merged list.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn merged_thread_ids_for_test(&self) -> Vec<String> {
        self.shell.threads.iter().map(|t| t.id.clone()).collect()
    }

    /// Test helper: older settled threads the shelf has not loaded, over every environment.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn unloaded_older_settled_for_test(&self) -> usize {
        self.shell.unloaded_older_settled(None)
    }

    /// Test helper: the catalog the composer reads now.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn active_server_config_is_primary_for_test(&self) -> bool {
        std::sync::Arc::ptr_eq(&self.active_server_config(), &self.server_config)
    }

    /// Test helper: the environment a thread of the merged list lives on.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn thread_environment_for_test(&self, thread_id: &str) -> Option<String> {
        self.linked_environment_of_thread(thread_id)
            .map(str::to_owned)
    }

    /// `retry` on a Settled page that failed on a linked environment.
    pub(super) fn retry_linked_older_pages(&mut self) {
        self.linked.shells.retry_older_pages();
        self.remerge_linked_shells();
    }

    /// The Settled shelf pages every environment on its own cut: scopes each linked environment
    /// to its projects in the shelf's scope, then reads the next older page of each one that has
    /// one while the open shelf lists fewer rows than it shows, one page at a time per
    /// environment (`useOlderSettledShelfGrowth`).
    pub(super) fn drive_linked_older_pages(&mut self, cx: &mut Context<'_, Self>) {
        let environments: Vec<String> = self
            .linked
            .shells
            .environments()
            .into_iter()
            .map(|environment| environment.id)
            .collect();
        if environments.is_empty() {
            return;
        }
        let scope = self.older_scope();
        let mut scope_changed = false;
        for environment in &environments {
            let environment_scope: Option<Vec<String>> = scope.as_ref().map(|ids| {
                ids.iter()
                    .filter(|id| {
                        conn_state::orbit_filing_id(id).is_some()
                            || self.linked_environment_of_project(id) == Some(environment.as_str())
                    })
                    .cloned()
                    .collect()
            });
            if self
                .linked
                .shells
                .older_scope_differs(environment, &environment_scope)
            {
                self.linked
                    .shells
                    .set_older_scope(environment, environment_scope);
                scope_changed = true;
            }
        }
        if scope_changed {
            self.remerge_linked_shells();
        }
        if !self.sidebar.settled_expanded {
            return;
        }
        let visible = self.settled_visible_count();
        let listed = crate::sidebar::thread_list::sidebar_lists(
            &self.shell,
            &self.orbit.workspaces,
            self.active_workspace.as_deref(),
            "",
            &[],
            None,
        )
        .listed_settled
        .len();
        for environment in environments {
            let Some(connection) = self.linked_connection(&environment) else {
                continue;
            };
            let Some(request) = self
                .linked
                .shells
                .next_older_page(&environment, listed, visible)
            else {
                continue;
            };
            self.linked
                .shells
                .older_page_started(&environment, &request);
            let payload = request.payload();
            cx.spawn(async move |this, cx| {
                let result = connection
                    .call::<_, conn_contract::OrchestrationV2OlderSettledThreadsPage>(
                        "orchestration.getOlderSettledThreads",
                        &payload,
                    )
                    .await;
                let _ = this.update(cx, |app, cx| {
                    match result {
                        Ok(page) => {
                            app.linked
                                .shells
                                .apply_older_page(&environment, &request, page)
                        }
                        Err(err) => {
                            eprintln!("older settled threads of {environment}: {err}");
                            app.linked.shells.older_page_failed(&environment, &request);
                        }
                    }
                    app.remerge_linked_shells();
                    // A page may not fill the shelf, and the next one is read in turn.
                    app.drive_older_pages(cx);
                    cx.notify();
                });
            })
            .detach();
        }
        self.remerge_linked_shells();
    }

    /// Drops every linked environment: the primary connection changed, so the old list is stale.
    pub(super) fn reset_linked_environments(&mut self) {
        self.linked.set = None;
        self.linked.shells = LinkedShells::default();
        self.linked.origins = Origins::default();
        self.linked.opened_child = None;
        self.linked.statuses.clear();
        self.linked.dirty.clear();
        if let Some(store) = &self.linked.store {
            for bytes in store.load_shells() {
                if let Some(snapshot) = LinkedShellSnapshot::from_json(&bytes)
                    && self.linked.settings.is_enabled(&snapshot.environment_id)
                {
                    self.linked.shells.restore_snapshot(snapshot);
                }
            }
        }
        self.linked.pairing.clear();
        self.linked.urls.clear();
        self.linked.machines.clear();
        self.linked.configs.clear();
        self.linked.scratch_roots.clear();
        self.linked.subscribed_env = None;
        self.linked.chat_env = None;
    }

    /// Brings the linked connections in line with the Orbit fleet. Call after the fleet or the
    /// primary connection changed.
    pub(super) fn sync_linked_environments(&mut self, cx: &mut Context<'_, Self>) {
        if !self.linking_enabled() {
            return;
        }
        let primary_id = self.primary_environment_id();
        let saved: HashSet<String> = self.orbit.sessions.sessions.keys().cloned().collect();
        let held: HashSet<String> = self
            .linked
            .set
            .as_ref()
            .map(|set| set.environment_ids().into_iter().collect())
            .unwrap_or_default();
        let targets: Vec<_> = self
            .orbit
            .fleet
            .nodes
            .iter()
            .chain(self.orbit.fleet.instances.iter())
            .cloned()
            .collect();
        let mut pairing_held = held;
        pairing_held.extend(self.linked.pairing.iter().cloned());
        let now = now_ms();
        let opt_in: HashSet<String> = self.linked.settings.instances.iter().cloned().collect();
        let disabled: HashSet<String> = self.linked.settings.disabled.iter().cloned().collect();
        let plan = plan_linked_environments(&LinkedPlanInput {
            targets: &targets,
            primary_id: Some(primary_id.as_str()),
            saved: &saved,
            held: &pairing_held,
            pair_attempted_at_ms: &self.linked.pair_attempted_at_ms,
            instance_opt_in: &opt_in,
            disabled: &disabled,
            now_ms: now,
        });

        let mut changed = false;
        // The primary environment is listed by its own connection, so a saved copy of it goes.
        changed |= self.linked.shells.remove(&primary_id);
        for environment_id in &plan.disconnect {
            if self.linked.pairing.remove(environment_id) {
                continue;
            }
            if let Some(set) = self.linked.set.as_mut() {
                self.offline.disconnected(environment_id);
                set.disconnect(environment_id);
            }
            self.linked.statuses.remove(environment_id);
            // An asleep or unreachable environment keeps listing its saved threads; one the user
            // switched off does not list at all.
            if !self.linked.settings.is_enabled(environment_id) {
                changed |= self.linked.shells.remove(environment_id);
            }
        }
        // A server the Gateway no longer lists, for long enough, is gone: its pairing, saved
        // threads and choices go with it.
        let known: Vec<String> = self
            .linked
            .shells
            .environments()
            .into_iter()
            .map(|environment| environment.id)
            .chain(saved.iter().filter(|id| **id != primary_id).cloned())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let verdict =
            confirm_gone_environments(&known, &targets, &self.linked.missing_since_ms, now);
        self.linked.missing_since_ms = verdict.missing_since_ms;
        for environment_id in &verdict.gone {
            if let Some(set) = self.linked.set.as_mut() {
                self.offline.disconnected(environment_id);
                set.disconnect(environment_id);
            }
            changed |= self.linked.shells.remove(environment_id);
            self.linked.statuses.remove(environment_id);
            self.linked.dirty.remove(environment_id);
            self.linked.settings.disabled.remove(environment_id);
            self.linked.settings.instances.remove(environment_id);
            self.orbit.sessions.remove_bearer(environment_id);
            if let Some(store) = &self.linked.store {
                store.remove_shell(environment_id);
            }
        }
        if !verdict.gone.is_empty() {
            self.linked.save_settings();
            self.orbit.persist_sessions();
        }
        for environment_id in &plan.connect {
            let Some(target) = targets.iter().find(|t| &t.server_id == environment_id) else {
                continue;
            };
            let Some(bearer) = self
                .orbit
                .sessions
                .bearer_for(environment_id)
                .map(str::to_owned)
            else {
                continue;
            };
            let Ok(http_base_url) = url::Url::parse(&target.url) else {
                continue;
            };
            self.connect_linked(
                environment_id.clone(),
                target.label.clone(),
                ServerConfig {
                    http_base_url,
                    credential: Credential::Bearer(bearer),
                },
                cx,
            );
            changed = true;
        }
        for environment_id in &plan.pair {
            let Some(target) = targets.iter().find(|t| &t.server_id == environment_id) else {
                continue;
            };
            self.pair_linked(
                environment_id.clone(),
                target.label.clone(),
                target.url.clone(),
                cx,
            );
        }
        if changed {
            self.remerge_linked_shells();
            self.sync_chat(cx);
            cx.notify();
        }
    }

    /// Mints a pairing link for `environment_id`, then connects with it.
    fn pair_linked(
        &mut self,
        environment_id: String,
        label: String,
        fallback_url: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.linked.pairing.insert(environment_id.clone());
        self.linked
            .pair_attempted_at_ms
            .insert(environment_id.clone(), now_ms());
        let generation = self.connection_gen;
        cx.spawn(async move |this, cx| {
            let task = crate::live::RT.spawn(crate::orbit_sync::mint_orbit_pairing(
                environment_id.clone(),
            ));
            let outcome = task.await;
            let _ = this.update(cx, |app, cx| {
                app.linked.pairing.remove(&environment_id);
                if app.connection_gen != generation {
                    return;
                }
                let ticket = match outcome {
                    Ok(Ok(ticket)) => ticket,
                    Ok(Err(err)) => {
                        eprintln!("linked environment {label}: pairing failed: {err}");
                        return;
                    }
                    Err(err) => {
                        eprintln!("linked environment {label}: pairing task failed: {err}");
                        return;
                    }
                };
                let Some(code) = ticket.pairing_code() else {
                    eprintln!("linked environment {label}: the pairing link has no code");
                    return;
                };
                let Some(http_base_url) = ticket
                    .http_base_url()
                    .or_else(|| url::Url::parse(&fallback_url).ok())
                else {
                    return;
                };
                app.connect_linked(
                    environment_id,
                    label,
                    ServerConfig {
                        http_base_url,
                        credential: Credential::PairingCode(code),
                    },
                    cx,
                );
                app.remerge_linked_shells();
                app.sync_chat(cx);
                cx.notify();
            });
        })
        .detach();
    }

    #[cfg(feature = "automation")]
    pub(crate) fn automation_connect_saved(
        &mut self,
        id: &str,
        cx: &mut Context<'_, Self>,
    ) -> Result<(), String> {
        let session = conn_desktop::orbit::OrbitSessionStore::load_default()
            .sessions
            .remove(id)
            .ok_or_else(|| format!("Missing saved environment {id}"))?;
        let config = ServerConfig {
            http_base_url: url::Url::parse(&session.url).map_err(|e| e.to_string())?,
            credential: Credential::Bearer(session.bearer),
        };
        self.connect_linked(id.to_owned(), session.label, config, cx);
        Ok(())
    }

    fn connect_linked(
        &mut self,
        environment_id: String,
        label: String,
        config: ServerConfig,
        cx: &mut Context<'_, Self>,
    ) {
        if self.linked.set.is_none() {
            let (set, events) = EnvironmentSet::new(crate::live::RT.handle());
            self.linked.set = Some(set);
            self.pump_linked_events(events, cx);
        }
        self.linked
            .urls
            .insert(environment_id.clone(), config.http_base_url.to_string());
        self.linked.shells.ensure(&environment_id, &label);
        let device_name = self.device_name();
        if let Some(set) = self.linked.set.as_mut() {
            // Its threads' agents drive their panels here too (`startAgentPanelRequests`
            // follows every connected environment).
            set.connect(EnvironmentTarget {
                environment_id,
                label,
                config,
            })
            .subscribe_panel_requests(Some(device_name));
        }
    }

    fn pump_linked_events(
        &mut self,
        mut events: tokio::sync::mpsc::Receiver<EnvironmentEvent>,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn(async move |this, cx| {
            while let Some(first) = events.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = events.try_recv() {
                    batch.push(more);
                }
                let alive = this.update(cx, |app, cx| {
                    let mut shells_changed = false;
                    for event in batch {
                        shells_changed |= app.apply_linked_event(event, cx);
                    }
                    if shells_changed {
                        app.remerge_linked_shells();
                        app.expire_offline(cx);
                        app.reconcile_offline(cx);
                        app.drive_older_pages(cx);
                        // A thread started on a linked environment opens once it is listed.
                        if let Some(pending_id) = app.pending_open_thread.clone()
                            && app.shell.find_thread(&pending_id).is_some()
                        {
                            app.pending_open_thread = None;
                            app.select_thread(pending_id, cx);
                        }
                    }
                    app.schedule_offline_save(cx);
                    app.schedule_linked_shell_save(cx);
                    app.sync_chat(cx);
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Applies one event of a linked environment's connection. Returns whether its shell changed.
    fn apply_linked_event(&mut self, event: EnvironmentEvent, cx: &mut Context<'_, Self>) -> bool {
        let EnvironmentEvent {
            environment_id,
            event,
        } = event;
        // An event of a connection that was just dropped.
        if !self
            .linked
            .set
            .as_ref()
            .is_some_and(|set| set.contains(&environment_id))
        {
            return false;
        }
        match event {
            ClientEvent::Status(status) => {
                if !matches!(status, ConnectionStatus::Connected) {
                    self.offline.disconnected(&environment_id);
                }
                if let ConnectionStatus::Failed(message) = &status
                    && is_auth_failure(message)
                {
                    // The stored token no longer works: the next fleet change pairs again.
                    self.orbit.sessions.remove_bearer(&environment_id);
                    self.orbit.persist_sessions();
                    if let Some(set) = self.linked.set.as_mut() {
                        self.offline.disconnected(&environment_id);
                        set.disconnect(&environment_id);
                    }
                }
                self.linked.statuses.insert(environment_id, status);
                false
            }
            ClientEvent::BearerIssued(token) => {
                let url = self
                    .linked
                    .urls
                    .get(&environment_id)
                    .cloned()
                    .unwrap_or_default();
                let label = self
                    .linked
                    .shells
                    .label(&environment_id)
                    .unwrap_or(&environment_id)
                    .to_owned();
                self.orbit
                    .sessions
                    .record_linked_bearer(environment_id, url, label, token);
                self.orbit.persist_sessions();
                false
            }
            ClientEvent::Shell(item) => {
                let Some(change) = self.linked.shells.apply(&environment_id, item) else {
                    return false;
                };
                if change.snapshot_required
                    && let Some(connection) = self.linked_connection(&environment_id)
                {
                    connection.subscribe_shell_with_idle_subagents();
                }
                if !change.threads_changed.is_empty() {
                    self.resubscribe_ended_threads();
                }
                let changed = change.projects_changed || !change.threads_changed.is_empty();
                if changed {
                    self.linked.dirty.insert(environment_id);
                }
                changed
            }
            ClientEvent::Thread { thread_id, item } => {
                self.apply_cache_stream(&environment_id, &thread_id, item);
                false
            }
            ClientEvent::StreamEnded { tag, key, error } => {
                if tag == "orchestration.subscribeThread" && self.threads.contains_key(&key) {
                    if let Some(error) = error {
                        eprintln!("thread stream {key} ended: {error}");
                    }
                    self.ended_threads.insert(key);
                    self.resubscribe_ended_threads();
                }
                false
            }
            ClientEvent::ServerConfig(event) => {
                if let conn_contract::ServerConfigStreamEvent::Snapshot(snapshot) = &*event {
                    match machine_kind(&snapshot.config) {
                        Some(kind) => self.linked.machines.insert(environment_id.clone(), kind),
                        None => self.linked.machines.remove(&environment_id),
                    };
                }
                let config = self
                    .linked
                    .configs
                    .entry(environment_id.clone())
                    .or_default();
                let change = std::sync::Arc::make_mut(config).apply(*event);
                if change.config_changed {
                    match config.scratch_workspace_root() {
                        Some(root) => self
                            .linked
                            .scratch_roots
                            .insert(environment_id.clone(), root.to_owned()),
                        None => self.linked.scratch_roots.remove(&environment_id),
                    };
                }
                // The composer and the right panel read the catalog of the open thread's
                // environment, so a change to that one reaches them now.
                if change.any()
                    && self.context_environment().as_deref() == Some(environment_id.as_str())
                {
                    self.push_server_config(cx);
                }
                cx.notify();
                false
            }
            ClientEvent::PanelRequest(request) => {
                if let Some(origin) = self.linked_connection(&environment_id) {
                    self.dispatch_agent_panel_request(
                        request,
                        super::PanelOrigin::Linked(environment_id),
                        super::PanelReply::Server(origin),
                        cx,
                    );
                }
                false
            }
            ClientEvent::Annotations { .. } => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use conn_state::ShellState;
    use conn_state::environments::{LinkedShellSnapshot, LinkedShells};

    use super::*;

    fn shell_with_a_thread() -> ShellState {
        let project: conn_state::ProjectShell = conn_contract::from_json(serde_json::json!({
            "id": "p-orbit", "title": "Orbit", "workspaceRoot": "/Users/mini/orbit",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-22T15:00:00.000Z"
        }))
        .expect("project decodes");
        let thread: conn_state::ThreadShell = conn_contract::from_json(serde_json::json!({
            "createdBy": "user", "creationSource": "web", "id": "t-mini", "projectId": "p-orbit",
            "title": "Map Stalled Orbit Threads and PRs", "providerInstanceId": "claudeAgent",
            "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
            "runtimeMode": "full-access", "interactionMode": "default", "branch": null,
            "worktreePath": null,
            "lineage": { "rootThreadId": "t-mini", "parentThreadId": null, "relationshipToParent": null },
            "forkedFrom": null, "activeProviderThreadId": null, "latestRunId": null,
            "activeRunId": null, "status": "idle", "pendingRuntimeRequest": null,
            "latestVisibleMessage": null, "latestUserMessageAt": null,
            "hasActionableProposedPlan": false, "itemCount": 0, "visibleItemCount": 0,
            "createdAt": "2026-11-13T09:00:00.000Z", "updatedAt": "2026-11-13T09:00:00.000Z",
            "archivedAt": null, "settledOverride": null, "settledAt": null, "deletedAt": null
        }))
        .expect("thread decodes");
        let mut shell = ShellState::from_parts(vec![project], vec![thread], Vec::new(), Some(9));
        shell.synchronized = true;
        shell
    }

    /// What the app does between launches: a synced shell is saved, and a fresh run lists it
    /// from the file before any connection exists.
    #[test]
    fn a_synced_shell_is_saved_and_lists_again_on_the_next_launch_without_a_connection() {
        let dir =
            std::env::temp_dir().join(format!("conn-gpui-linked-test-{}", std::process::id()));
        let store = LinkedStore::at(&dir);

        let mut running = LinkedShells::default();
        running.ensure("mini", "mini");
        running.restore("mini", shell_with_a_thread());
        let snapshot = running.snapshot("mini").expect("a shell to save");
        store
            .save_shell(
                &snapshot.environment_id,
                &snapshot.to_json().expect("serializes"),
            )
            .expect("saved");

        let mut next_launch = LinkedShells::default();
        for bytes in store.load_shells() {
            let read = LinkedShellSnapshot::from_json(&bytes).expect("a snapshot");
            next_launch.restore_snapshot(read);
        }
        let merged = next_launch.merged("nick", "nick", &ShellState::default());
        assert!(merged.shell.find_thread("t-mini").is_some());
        assert_eq!(
            merged.origins.thread_environment_label("t-mini"),
            Some("mini")
        );
        assert_eq!(merged.origins.environment_of_thread("t-mini"), "mini");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
