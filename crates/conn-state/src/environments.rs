//! The shells of the environments a client shows beside its primary one, merged into one list.
//!
//! Conn connects to every saved environment and lists their threads together: one sidebar, each
//! row remembering the environment it lives on. [`LinkedShells`] holds one [`ShellState`] per
//! linked environment (the primary environment's shell stays with the client, with its Settled
//! shelf paging), and [`LinkedShells::merged`] builds the shell the sidebar reads plus the
//! [`Origins`] that say which environment each project and thread belongs to.
//!
//! Plain data in and out, so the iPhone app can share it.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{
    OlderPageRequest, ProjectShell, ShellChange, ShellState, ShellStreamItem, ThreadShell,
};
use conn_contract::OrchestrationV2OlderSettledThreadsPage as OlderSettledPage;

/// A linked environment and what the sidebar calls it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvironmentLabel {
    pub id: String,
    pub label: String,
}

/// What a client keeps of a linked environment's shell between launches, so its threads list
/// while the environment is asleep or offline (Conn saves each environment's last snapshot:
/// `EnvironmentCacheStore.saveShell`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedShellSnapshot {
    pub version: u32,
    pub environment_id: String,
    pub label: String,
    pub projects: Vec<ProjectShell>,
    pub threads: Vec<ThreadShell>,
    pub archived_threads: Vec<ThreadShell>,
    pub sequence: Option<i64>,
}

impl LinkedShellSnapshot {
    /// The layout of the saved file. A file of another version is ignored, never half-read.
    pub const VERSION: u32 = 1;

    #[must_use]
    pub fn capture(environment_id: &str, label: &str, shell: &ShellState) -> Self {
        Self {
            version: Self::VERSION,
            environment_id: environment_id.to_owned(),
            label: label.to_owned(),
            projects: shell.projects.clone(),
            threads: shell.threads.clone(),
            archived_threads: shell.archived_threads.clone(),
            sequence: shell.sequence,
        }
    }

    #[must_use]
    pub fn into_shell(self) -> ShellState {
        ShellState::from_parts(
            self.projects,
            self.threads,
            self.archived_threads,
            self.sequence,
        )
    }

    /// # Errors
    /// Returns the serializer's error.
    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }

    /// The snapshot saved in `bytes`, or `None` when it is unreadable or of another version.
    #[must_use]
    pub fn from_json(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice::<Self>(bytes)
            .ok()
            .filter(|snapshot| snapshot.version == Self::VERSION)
    }
}

#[derive(Clone, Debug, Default)]
struct LinkedShell {
    label: String,
    shell: ShellState,
}

/// One shell per linked environment, in the order the environments were first seen.
#[derive(Clone, Debug, Default)]
pub struct LinkedShells {
    order: Vec<String>,
    shells: HashMap<String, LinkedShell>,
}

impl LinkedShells {
    /// Adds `environment_id` with an empty shell, or renames it when it is already held.
    pub fn ensure(&mut self, environment_id: &str, label: &str) {
        if let Some(existing) = self.shells.get_mut(environment_id) {
            label.clone_into(&mut existing.label);
            return;
        }
        self.order.push(environment_id.to_owned());
        self.shells.insert(
            environment_id.to_owned(),
            LinkedShell {
                label: label.to_owned(),
                shell: ShellState::default(),
            },
        );
    }

    /// Forgets an environment and everything it listed.
    pub fn remove(&mut self, environment_id: &str) -> bool {
        self.order.retain(|id| id != environment_id);
        self.shells.remove(environment_id).is_some()
    }

    /// Applies one `subscribeShell` item of `environment_id`. `None` when no such environment is
    /// held: an item from a connection that was just dropped.
    pub fn apply(&mut self, environment_id: &str, item: ShellStreamItem) -> Option<ShellChange> {
        let linked = self.shells.get_mut(environment_id)?;
        Some(linked.shell.apply(item))
    }

    /// The snapshot to save for `environment_id`: what its connection last reported (or what was
    /// restored). `None` while it holds nothing.
    #[must_use]
    pub fn snapshot(&self, environment_id: &str) -> Option<LinkedShellSnapshot> {
        let linked = self.shells.get(environment_id)?;
        let shell = &linked.shell;
        if shell.sequence.is_none() && shell.threads.is_empty() && shell.projects.is_empty() {
            return None;
        }
        Some(LinkedShellSnapshot::capture(
            environment_id,
            &linked.label,
            shell,
        ))
    }

    /// Lists a saved environment from its last snapshot, before (or without) a connection.
    /// Ignored when the environment already holds a synced shell.
    pub fn restore_snapshot(&mut self, snapshot: LinkedShellSnapshot) {
        self.ensure(&snapshot.environment_id.clone(), &snapshot.label.clone());
        let Some(linked) = self.shells.get_mut(&snapshot.environment_id) else {
            return;
        };
        if linked.shell.sequence.is_some() {
            return;
        }
        linked.shell = snapshot.into_shell();
    }

    /// A restored copy of an environment's last shell, shown until its connection syncs
    /// (Conn keeps each environment's last snapshot, so an asleep Instance still lists its threads).
    pub fn restore(&mut self, environment_id: &str, shell: ShellState) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell = shell;
        }
    }

    /// The Settled shelf pages each environment on its own cut (`olderOf(environmentId)`): the
    /// projects of `environment_id` the shelf pages for (`None`: all of them).
    pub fn set_older_scope(&mut self, environment_id: &str, scope: Option<Vec<String>>) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.set_older_scope(scope);
        }
    }

    /// Whether the pages read so far were read for another scope than `scope` would be.
    #[must_use]
    pub fn older_scope_differs(&self, environment_id: &str, scope: &Option<Vec<String>>) -> bool {
        let Some(linked) = self.shells.get(environment_id) else {
            return false;
        };
        let wanted = scope.as_ref().map(|ids| {
            let mut ids = ids.clone();
            ids.sort();
            ids
        });
        linked.shell.older_scope() != wanted.as_ref()
    }

    /// The next page to read from `environment_id`, when the shelf lists fewer rows than it
    /// shows. Mark it with [`Self::older_page_started`].
    #[must_use]
    pub fn next_older_page(
        &self,
        environment_id: &str,
        listed: usize,
        visible: usize,
    ) -> Option<OlderPageRequest> {
        self.shells
            .get(environment_id)?
            .shell
            .next_older_page(listed, visible)
    }

    pub fn older_page_started(&mut self, environment_id: &str, request: &OlderPageRequest) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.older_page_started(request);
        }
    }

    pub fn apply_older_page(
        &mut self,
        environment_id: &str,
        request: &OlderPageRequest,
        page: OlderSettledPage,
    ) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.apply_older_page(request, page);
        }
    }

    pub fn older_page_failed(&mut self, environment_id: &str, request: &OlderPageRequest) {
        if let Some(linked) = self.shells.get_mut(environment_id) {
            linked.shell.older_page_failed(request);
        }
    }

    /// `retry` on a failed page of any environment.
    pub fn retry_older_pages(&mut self) {
        for linked in self.shells.values_mut() {
            linked.shell.retry_older_page();
        }
    }

    #[must_use]
    pub fn shell(&self, environment_id: &str) -> Option<&ShellState> {
        self.shells.get(environment_id).map(|linked| &linked.shell)
    }

    #[must_use]
    pub fn label(&self, environment_id: &str) -> Option<&str> {
        self.shells
            .get(environment_id)
            .map(|linked| linked.label.as_str())
    }

    #[must_use]
    pub fn contains(&self, environment_id: &str) -> bool {
        self.shells.contains_key(environment_id)
    }

    /// The held environments with their labels, in the order they were first seen.
    #[must_use]
    pub fn environments(&self) -> Vec<EnvironmentLabel> {
        self.order
            .iter()
            .filter_map(|id| {
                self.shells.get(id).map(|linked| EnvironmentLabel {
                    id: id.clone(),
                    label: linked.label.clone(),
                })
            })
            .collect()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.shells.is_empty()
    }

    /// `primary` with every linked environment's projects and threads added, and where each came
    /// from. An id more than one environment holds belongs to the first: the primary, then the
    /// linked environments in the order they were first seen. Linked environments are listed in
    /// that order, so the result does not change when an environment reconnects.
    #[must_use]
    pub fn merged(
        &self,
        primary_id: &str,
        primary_label: &str,
        primary: &ShellState,
    ) -> MergedShell {
        let mut shell = primary.clone();
        let origins = self.merge_into(primary_id, primary_label, &mut shell, &Origins::default());
        MergedShell { shell, origins }
    }

    /// [`Self::merged`] in place, for a client that keeps one live shell (its Settled shelf
    /// paging lives there): first takes out what `previous` merged in, then merges again.
    /// Returns the new [`Origins`].
    pub fn merge_into(
        &self,
        primary_id: &str,
        primary_label: &str,
        shell: &mut ShellState,
        previous: &Origins,
    ) -> Origins {
        previous.strip_from(shell);
        let mut origins = Origins {
            primary_id: primary_id.to_owned(),
            labels: HashMap::from([(primary_id.to_owned(), primary_label.to_owned())]),
            ..Origins::default()
        };
        let mut projects: HashSet<String> = HashSet::new();
        let mut threads: HashSet<String> = HashSet::new();
        for project in &shell.projects {
            projects.insert(project.id.clone());
        }
        for thread in shell.threads.iter().chain(&shell.archived_threads) {
            threads.insert(thread.id.clone());
        }
        for id in &self.order {
            let Some(linked) = self.shells.get(id) else {
                continue;
            };
            origins.labels.insert(id.clone(), linked.label.clone());
            origins.linked_order.push(id.clone());
            for project in &linked.shell.projects {
                if projects.insert(project.id.clone()) {
                    origins.project_env.insert(project.id.clone(), id.clone());
                }
            }
            for thread in linked
                .shell
                .threads
                .iter()
                .chain(&linked.shell.archived_threads)
            {
                if threads.insert(thread.id.clone()) {
                    origins.thread_env.insert(thread.id.clone(), id.clone());
                }
            }
            shell.extend_with_environment(&linked.shell);
        }
        shell.refresh_derived();
        origins
    }
}

/// The merged shell the sidebar reads and where its rows came from.
#[derive(Clone, Debug, Default)]
pub struct MergedShell {
    pub shell: ShellState,
    pub origins: Origins,
}

/// Which environment each project and thread of a merged shell belongs to. Anything not listed
/// belongs to the primary environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Origins {
    primary_id: String,
    labels: HashMap<String, String>,
    linked_order: Vec<String>,
    thread_env: HashMap<String, String>,
    project_env: HashMap<String, String>,
}

impl Origins {
    /// Takes out of `shell` the projects and threads this merge put there.
    pub fn strip_from(&self, shell: &mut ShellState) {
        shell.clear_foreign();
        if self.thread_env.is_empty() && self.project_env.is_empty() {
            return;
        }
        shell
            .projects
            .retain(|p| !self.project_env.contains_key(&p.id));
        shell
            .threads
            .retain(|t| !self.thread_env.contains_key(&t.id));
        shell
            .archived_threads
            .retain(|t| !self.thread_env.contains_key(&t.id));
    }

    #[must_use]
    pub fn primary_id(&self) -> &str {
        &self.primary_id
    }

    /// The environment `thread_id` lives on.
    #[must_use]
    pub fn environment_of_thread(&self, thread_id: &str) -> &str {
        self.thread_env
            .get(thread_id)
            .map_or(self.primary_id.as_str(), String::as_str)
    }

    /// The environment `project_id` lives on.
    #[must_use]
    pub fn environment_of_project(&self, project_id: &str) -> &str {
        self.project_env
            .get(project_id)
            .map_or(self.primary_id.as_str(), String::as_str)
    }

    /// Whether `thread_id` lives on a linked environment rather than the primary one.
    #[must_use]
    pub fn is_linked_thread(&self, thread_id: &str) -> bool {
        self.thread_env.contains_key(thread_id)
    }

    #[must_use]
    pub fn is_linked_project(&self, project_id: &str) -> bool {
        self.project_env.contains_key(project_id)
    }

    /// The label of an environment, primary or linked.
    #[must_use]
    pub fn label(&self, environment_id: &str) -> Option<&str> {
        self.labels.get(environment_id).map(String::as_str)
    }

    /// The label of the environment `thread_id` lives on.
    #[must_use]
    pub fn thread_environment_label(&self, thread_id: &str) -> Option<&str> {
        self.label(self.environment_of_thread(thread_id))
    }

    /// The linked environments, in the order the merge listed them.
    #[must_use]
    pub fn linked_environments(&self) -> &[String] {
        &self.linked_order
    }

    /// `projectGroupsSpanEnvironments`: whether the merged projects come from more than one
    /// environment, which is when Conn labels scratch-project threads with their machine.
    #[must_use]
    pub fn spans_environments(&self) -> bool {
        !self.project_env.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use conn_contract::{OrchestrationV2ShellStreamItem, from_json};
    use serde_json::{Value, json};

    use super::*;
    use crate::project_groups::{project_group_labels, project_group_labels_across_environments};
    use crate::test_threads::thread_json;

    fn project_json(id: &str, title: &str, root: &str, repository: Option<&str>) -> Value {
        let mut value = json!({
            "id": id, "title": title, "workspaceRoot": root,
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "deletedAt": null
        });
        if let Some(key) = repository {
            value["repositoryIdentity"] = json!({
                "canonicalKey": key,
                "locator": { "source": "git-remote", "remoteName": "origin", "remoteUrl": format!("git@{key}.git") },
                "displayName": key,
                "name": key.rsplit('/').next().unwrap_or(key)
            });
        }
        value
    }

    fn snapshot(
        projects: Vec<Value>,
        threads: Vec<Value>,
        archived: Vec<Value>,
    ) -> ShellStreamItem {
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 3,
                "projects": projects,
                "threads": threads,
                "archivedThreads": archived
            }
        }))
        .expect("snapshot decodes");
        item
    }

    fn at(updated: &'static str) -> impl FnOnce(&mut Value) {
        move |t| t["updatedAt"] = json!(updated)
    }

    fn primary_shell() -> ShellState {
        let mut shell = ShellState::default();
        shell.apply(snapshot(
            vec![project_json(
                "p-conn",
                "Conn",
                "/Users/nick/conn",
                Some("github.com/nckrtl/conn"),
            )],
            vec![
                thread_json("t-primary-old", "p-conn", at("2026-11-20T09:00:00.000Z")),
                thread_json("t-primary-new", "p-conn", at("2026-11-23T09:00:00.000Z")),
            ],
            vec![],
        ));
        shell
    }

    fn linked() -> LinkedShells {
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.ensure("nick-vm", "nick-vm");
        linked.apply(
            "mini",
            snapshot(
                vec![project_json(
                    "p-orbit",
                    "Orbit",
                    "/Users/mini/orbit",
                    Some("github.com/nckrtl/orbit"),
                )],
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    at("2026-11-22T09:00:00.000Z"),
                )],
                vec![thread_json("t-mini-archived", "p-orbit", |t| {
                    t["archivedAt"] = json!("2026-11-21T09:00:00.000Z");
                })],
            ),
        );
        linked.apply(
            "nick-vm",
            snapshot(
                vec![project_json(
                    "p-vm-conn",
                    "Conn",
                    "/Users/nick/conn",
                    Some("github.com/nckrtl/conn"),
                )],
                vec![thread_json(
                    "t-vm",
                    "p-vm-conn",
                    at("2026-11-23T10:00:00.000Z"),
                )],
                vec![],
            ),
        );
        linked
    }

    #[test]
    fn the_merged_shell_lists_every_environments_threads_newest_activity_first() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let ids: Vec<&str> = merged.shell.threads.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t-vm", "t-primary-new", "t-mini", "t-primary-old"]);
        assert_eq!(merged.shell.projects.len(), 3);
        assert_eq!(
            merged
                .shell
                .archived_threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["t-mini-archived"]
        );
        assert!(merged.shell.find_thread("t-mini").is_some());
    }

    #[test]
    fn every_row_remembers_its_environment() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let origins = &merged.origins;
        assert_eq!(origins.environment_of_thread("t-primary-new"), "nick");
        assert_eq!(origins.environment_of_thread("t-mini"), "mini");
        assert_eq!(origins.environment_of_thread("t-mini-archived"), "mini");
        assert_eq!(origins.environment_of_thread("t-vm"), "nick-vm");
        assert_eq!(origins.environment_of_project("p-orbit"), "mini");
        assert_eq!(origins.environment_of_project("p-conn"), "nick");
        assert!(origins.is_linked_thread("t-mini"));
        assert!(!origins.is_linked_thread("t-primary-new"));
        assert_eq!(origins.thread_environment_label("t-vm"), Some("nick-vm"));
        assert_eq!(
            origins.thread_environment_label("t-primary-old"),
            Some("nick")
        );
        assert_eq!(origins.linked_environments(), ["mini", "nick-vm"]);
        assert!(origins.spans_environments());
    }

    #[test]
    fn a_thread_id_two_environments_hold_belongs_to_the_first() {
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            snapshot(
                vec![project_json("p-conn", "Conn on mini", "/mini/conn", None)],
                vec![thread_json("t-primary-new", "p-conn", |t| {
                    t["title"] = json!("Mini's copy")
                })],
                vec![],
            ),
        );
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert_eq!(
            merged.origins.environment_of_thread("t-primary-new"),
            "nick"
        );
        assert!(!merged.origins.is_linked_thread("t-primary-new"));
        assert_eq!(
            merged
                .shell
                .threads
                .iter()
                .filter(|t| t.id == "t-primary-new")
                .count(),
            1
        );
        assert_eq!(
            merged.shell.projects.len(),
            1,
            "the primary's project keeps the id"
        );
        assert!(!merged.origins.spans_environments());
    }

    #[test]
    fn merging_in_place_again_replaces_what_the_last_merge_added() {
        let mut shell = primary_shell();
        let mut linked = linked();
        let first = linked.merge_into("nick", "nick", &mut shell, &Origins::default());
        assert!(shell.find_thread("t-mini").is_some());
        assert_eq!(shell.threads.len(), 4);

        // mini drops a thread, nick-vm leaves: neither lingers after the next merge.
        linked.apply(
            "mini",
            snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                vec![],
                vec![],
            ),
        );
        linked.remove("nick-vm");
        let second = linked.merge_into("nick", "nick", &mut shell, &first);
        assert_eq!(
            shell
                .threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["t-primary-new", "t-primary-old"]
        );
        assert!(shell.archived_threads.is_empty());
        assert_eq!(second.linked_environments(), ["mini"]);

        // No linked environment left: back to the primary shell alone.
        linked.remove("mini");
        linked.merge_into("nick", "nick", &mut shell, &second);
        assert_eq!(shell.projects.len(), 1);
        assert_eq!(shell.threads.len(), 2);
    }

    #[test]
    fn the_primary_snapshot_replacing_its_threads_does_not_lose_the_linked_ones_after_a_merge() {
        let mut shell = primary_shell();
        let linked = linked();
        let origins = linked.merge_into("nick", "nick", &mut shell, &Origins::default());
        shell.apply(snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json("t-primary-fresh", "p-conn", |_| {})],
            vec![],
        ));
        assert!(
            shell.find_thread("t-mini").is_none(),
            "a snapshot replaces the lists"
        );
        linked.merge_into("nick", "nick", &mut shell, &origins);
        assert!(shell.find_thread("t-mini").is_some());
        assert!(shell.find_thread("t-primary-fresh").is_some());
        assert!(shell.find_thread("t-primary-new").is_none());
    }

    fn older_snapshot(
        projects: Vec<Value>,
        threads: Vec<Value>,
        before: &str,
        counts: Value,
    ) -> ShellStreamItem {
        let item: OrchestrationV2ShellStreamItem = from_json(json!({
            "kind": "snapshot",
            "snapshot": {
                "schemaVersion": 1,
                "snapshotSequence": 5,
                "projects": projects,
                "threads": threads,
                "archivedThreads": [],
                "olderSettled": { "before": before, "asOfSequence": 5, "counts": counts }
            }
        }))
        .expect("snapshot decodes");
        item
    }

    fn settled(at: &'static str) -> impl FnOnce(&mut Value) {
        move |t| {
            t["settledOverride"] = json!("settled");
            t["settledAt"] = json!(at);
        }
    }

    #[test]
    fn a_snapshot_round_trips_and_lists_the_environment_before_it_connects() {
        let mut linked = linked();
        let saved = linked.snapshot("mini").expect("mini holds a shell");
        let bytes = saved.to_json().expect("serializes");
        let read = LinkedShellSnapshot::from_json(&bytes).expect("reads back");
        assert_eq!(read, saved);
        assert_eq!(read.label, "mini");

        // A fresh run: nothing connected, only the file.
        let mut fresh = LinkedShells::default();
        fresh.restore_snapshot(read);
        let merged = fresh.merged("nick", "nick", &primary_shell());
        assert_eq!(merged.origins.environment_of_thread("t-mini"), "mini");
        assert!(merged.shell.find_thread("t-mini-archived").is_some());
        assert_eq!(
            merged.origins.thread_environment_label("t-mini"),
            Some("mini")
        );

        // A snapshot never overwrites a shell its connection already synced.
        let current = fresh.shell("mini").map(|s| s.threads.len());
        linked.restore_snapshot(LinkedShellSnapshot {
            threads: vec![],
            ..saved
        });
        assert_eq!(linked.shell("mini").map(|s| s.threads.len()), current);
    }

    #[test]
    fn a_snapshot_of_another_version_or_with_garbage_is_ignored() {
        let mut snapshot = linked().snapshot("mini").expect("a shell");
        snapshot.version = LinkedShellSnapshot::VERSION + 1;
        let bytes = snapshot.to_json().expect("serializes");
        assert!(LinkedShellSnapshot::from_json(&bytes).is_none());
        assert!(LinkedShellSnapshot::from_json(b"{ not json").is_none());
        assert!(LinkedShells::default().snapshot("mini").is_none());
    }

    #[test]
    fn each_environment_pages_its_own_settled_threads_and_the_shelf_counts_them_all() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json(
                "t-primary-settled",
                "p-conn",
                settled("2026-11-22T09:00:00.000Z"),
            )],
            "2026-11-10T00:00:00.000Z",
            json!([{ "projectId": "p-conn", "count": 3 }]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                vec![thread_json(
                    "t-mini-settled",
                    "p-orbit",
                    settled("2026-11-21T09:00:00.000Z"),
                )],
                "2026-11-12T00:00:00.000Z",
                json!([{ "projectId": "p-orbit", "count": 5 }]),
            ),
        );
        let origins = linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        // 3 older threads on nick and 5 on mini, none of them held.
        assert_eq!(primary.unloaded_older_settled(None), 8);
        let scope: HashSet<String> = ["p-orbit".to_owned()].into();
        assert_eq!(primary.unloaded_older_settled(Some(&scope)), 5);

        // mini reads a page below its cut: two of its five arrive.
        let request = linked
            .next_older_page("mini", 1, 5)
            .expect("mini has a page to read");
        assert_eq!(request.before.settled_at, "2026-11-12T00:00:00.000Z");
        linked.older_page_started("mini", &request);
        assert!(
            linked.next_older_page("mini", 1, 5).is_none(),
            "one page at a time per environment"
        );
        let page: OlderSettledPage = from_json(json!({
            "snapshotSequence": 5,
            "threads": [
                thread_json("t-mini-old-1", "p-orbit", settled("2026-11-09T09:00:00.000Z")),
                thread_json("t-mini-old-2", "p-orbit", settled("2026-11-08T09:00:00.000Z")),
            ],
            "counts": []
        }))
        .expect("page decodes");
        linked.apply_older_page("mini", &request, page);
        linked.merge_into("nick", "nick", &mut primary, &origins);

        assert_eq!(
            primary.unloaded_older_settled(None),
            6,
            "3 on nick and 3 on mini remain"
        );
        assert!(primary.find_thread("t-mini-old-1").is_some());
        let settled_ids: Vec<&str> = primary
            .top_level_settled_threads()
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert!(settled_ids.contains(&"t-mini-old-1"));
        assert!(settled_ids.contains(&"t-mini-settled"));
        assert!(settled_ids.contains(&"t-primary-settled"));
    }

    #[test]
    fn a_thread_is_listed_against_its_own_environments_frontier() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![project_json("p-conn", "Conn", "/Users/nick/conn", None)],
            vec![thread_json(
                "t-primary",
                "p-conn",
                settled("2026-11-15T09:00:00.000Z"),
            )],
            "2026-11-10T00:00:00.000Z",
            json!([]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(
                vec![project_json("p-orbit", "Orbit", "/Users/mini/orbit", None)],
                // Newer than nick's cut, older than mini's own: mini's shelf has not read it yet.
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    settled("2026-11-11T09:00:00.000Z"),
                )],
                "2026-11-12T00:00:00.000Z",
                json!([]),
            ),
        );
        linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        let listed: Vec<&str> = primary
            .top_level_settled_threads()
            .iter()
            .map(|t| t.id.as_str())
            .collect();
        assert_eq!(listed, ["t-primary"]);
        assert_eq!(
            primary.all_settled_threads().len(),
            2,
            "held, but not listed yet"
        );
    }

    #[test]
    fn the_shelf_footer_shows_a_page_any_environment_is_reading_or_failed_to_read() {
        let mut primary = ShellState::default();
        primary.apply(older_snapshot(
            vec![],
            vec![],
            "2026-11-10T00:00:00.000Z",
            json!([]),
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("mini", "mini");
        linked.apply(
            "mini",
            older_snapshot(vec![], vec![], "2026-11-12T00:00:00.000Z", json!([])),
        );
        let origins = linked.merge_into("nick", "nick", &mut primary, &Origins::default());
        assert_eq!(primary.older_settled().status, crate::PageStatus::Ready);

        let request = linked.next_older_page("mini", 0, 5).expect("a page");
        linked.older_page_started("mini", &request);
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Pending);

        linked.older_page_failed("mini", &request);
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Failed);

        linked.retry_older_pages();
        linked.merge_into("nick", "nick", &mut primary, &origins);
        assert_eq!(primary.older_settled().status, crate::PageStatus::Ready);
    }

    #[test]
    fn with_no_linked_environment_the_merge_is_the_primary_shell() {
        let primary = primary_shell();
        let merged = LinkedShells::default().merged("nick", "nick", &primary);
        assert_eq!(merged.shell.threads.len(), primary.threads.len());
        assert!(merged.origins.linked_environments().is_empty());
        assert!(!merged.origins.spans_environments());
    }

    #[test]
    fn removing_an_environment_takes_its_threads_out_and_keeps_the_others() {
        let mut linked = linked();
        assert!(linked.remove("mini"));
        assert!(!linked.remove("mini"));
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert!(merged.shell.find_thread("t-mini").is_none());
        assert!(merged.shell.find_thread("t-vm").is_some());
        assert_eq!(linked.environments().len(), 1);
    }

    #[test]
    fn an_item_of_a_dropped_environment_is_ignored() {
        let mut linked = linked();
        linked.remove("mini");
        assert!(
            linked
                .apply("mini", snapshot(vec![], vec![], vec![]))
                .is_none()
        );
    }

    #[test]
    fn a_restored_shell_lists_its_threads_before_the_connection_syncs() {
        let mut restored = ShellState::default();
        restored.apply(snapshot(
            vec![project_json("p-studio", "studio", "/work/studio", None)],
            vec![thread_json("t-studio", "p-studio", |_| {})],
            vec![],
        ));
        let mut linked = LinkedShells::default();
        linked.ensure("studio", "superheroicons / studio");
        linked.restore("studio", restored);
        let merged = linked.merged("nick", "nick", &primary_shell());
        assert_eq!(merged.origins.environment_of_thread("t-studio"), "studio");
        assert_eq!(
            merged.origins.thread_environment_label("t-studio"),
            Some("superheroicons / studio")
        );
    }

    #[test]
    fn the_merge_order_does_not_depend_on_which_environment_reported_last() {
        let first = linked().merged("nick", "nick", &primary_shell());
        let mut reconnected = linked();
        reconnected.apply(
            "mini",
            snapshot(
                vec![project_json(
                    "p-orbit",
                    "Orbit",
                    "/Users/mini/orbit",
                    Some("github.com/nckrtl/orbit"),
                )],
                vec![thread_json(
                    "t-mini",
                    "p-orbit",
                    at("2026-11-22T09:00:00.000Z"),
                )],
                vec![thread_json("t-mini-archived", "p-orbit", |t| {
                    t["archivedAt"] = json!("2026-11-21T09:00:00.000Z");
                })],
            ),
        );
        let second = reconnected.merged("nick", "nick", &primary_shell());
        let ids = |m: &MergedShell| -> Vec<String> {
            m.shell.threads.iter().map(|t| t.id.clone()).collect()
        };
        assert_eq!(ids(&first), ids(&second));
        assert_eq!(first.origins, second.origins);
    }

    #[test]
    fn a_repository_on_two_machines_groups_under_one_label_but_folders_stay_per_machine() {
        let merged = linked().merged("nick", "nick", &primary_shell());
        let origins = merged.origins.clone();
        let labels = project_group_labels_across_environments(&merged.shell.projects, |id| {
            origins.environment_of_project(id).to_owned()
        });
        // `p-conn` (nick) and `p-vm-conn` (nick-vm) share /Users/nick/conn and one repository.
        assert_eq!(labels["p-conn"], labels["p-vm-conn"]);
        assert_eq!(labels["p-conn"], "Conn");
        assert_eq!(labels["p-orbit"], "Orbit");

        // The old, environment-blind grouping reads the two folders as one physical project, so
        // two machines with the same path but different repositories would merge.
        let mut other_repo = merged.shell.projects;
        other_repo.retain(|p| p.id != "p-vm-conn");
        let mut vm_other: ShellState = ShellState::default();
        vm_other.apply(snapshot(
            vec![project_json(
                "p-vm-site",
                "Site",
                "/Users/nick/conn",
                Some("github.com/nckrtl/site"),
            )],
            vec![],
            vec![],
        ));
        other_repo.extend(vm_other.projects.clone());
        let blind = project_group_labels(&other_repo);
        let aware = project_group_labels_across_environments(&other_repo, |id| {
            if id == "p-vm-site" {
                "nick-vm".to_owned()
            } else {
                "nick".to_owned()
            }
        });
        assert_eq!(aware["p-conn"], "Conn");
        assert_eq!(aware["p-vm-site"], "Site");
        assert_eq!(
            blind["p-vm-site"], blind["p-conn"],
            "the blind grouping merges the folders"
        );
    }
}
