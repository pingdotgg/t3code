//! The project name a sidebar row shows (`projectDisplayNameByKey` in `Sidebar.tsx`).
//!
//! Conn does not list a thread under its project's own title. It groups projects that are one
//! repository (`buildProjectGroups`, grouping mode `repository`, the default) and labels the group
//! (`deriveProjectGroupLabel`): a group of two clones of `nckrtl/conn` reads `nckrtl/conn`, while a
//! lone project keeps its title. Plain data in and out, so the iPhone app can share it.
//!
//! [`project_group_labels`] groups one environment's projects; [`project_group_labels_across_environments`]
//! groups the projects of every connected environment, as Conn's merged sidebar does.

use std::collections::HashMap;

use conn_contract::RepositoryIdentity;

use crate::ProjectShell;
use crate::thread::parse_iso8601_epoch_ms;

fn identity(project: &ProjectShell) -> Option<&RepositoryIdentity> {
    project
        .repository_identity
        .as_ref()
        .and_then(Option::as_ref)
}

/// `repositoryGroupingKeyOf`: a fork groups with the repository it came from.
fn grouping_key(identity: &RepositoryIdentity) -> &str {
    identity
        .origin
        .as_ref()
        .map_or(identity.canonical_key.as_str(), |origin| {
            origin.canonical_key.as_str()
        })
}

/// `repositoryGroupingDisplayNameOf`.
fn grouping_display_name(identity: &RepositoryIdentity) -> Option<&str> {
    match &identity.origin {
        Some(origin) => Some(
            origin
                .display_name
                .as_deref()
                .unwrap_or(origin.canonical_key.as_str()),
        ),
        None => identity.display_name.as_deref(),
    }
}

/// `normalizeProjectPathForComparison` for POSIX paths: trimmed, without trailing separators.
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed == "/" {
        return trimmed.to_owned();
    }
    let stripped = trimmed.trim_end_matches(['/', '\\']);
    if stripped.is_empty() {
        trimmed.to_owned()
    } else {
        stripped.to_owned()
    }
}

fn freshness(project: &ProjectShell) -> i64 {
    parse_iso8601_epoch_ms(&project.updated_at)
        .or_else(|| parse_iso8601_epoch_ms(&project.created_at))
        .unwrap_or(0)
}

/// `shouldReplacePhysicalProjectWinner`: the fresher project, the greater id on a tie.
fn replaces(existing: &ProjectShell, candidate: &ProjectShell) -> bool {
    let delta = freshness(candidate) - freshness(existing);
    delta > 0 || (delta == 0 && candidate.id > existing.id)
}

fn unique_non_empty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for value in values.into_iter().flatten() {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    out
}

/// `deriveProjectGroupLabel` for a group of more than one project.
fn group_label(
    group_key: &str,
    representative: &ProjectShell,
    members: &[&ProjectShell],
) -> String {
    let titles = unique_non_empty(members.iter().map(|m| Some(m.title.as_str())));
    let display_names = unique_non_empty(
        members
            .iter()
            .map(|m| identity(m).and_then(grouping_display_name)),
    );
    let repository_names = unique_non_empty(
        members
            .iter()
            .map(|m| identity(m).and_then(|i| i.name.as_deref())),
    );
    if let [title] = titles.as_slice()
        && (members.iter().any(|m| m.has_custom_title == Some(true))
            || (!display_names.contains(title) && !repository_names.contains(title)))
    {
        return (*title).to_owned();
    }
    if let [name] = display_names.as_slice() {
        return (*name).to_owned();
    }
    if let [name] = repository_names.as_slice() {
        return (*name).to_owned();
    }
    // A whole-repository group is named for the repository, not one member's folder.
    if let Some(identity) = identity(representative)
        && group_key == grouping_key(identity)
    {
        return grouping_display_name(identity)
            .or(identity.name.as_deref())
            .unwrap_or(representative.title.as_str())
            .to_owned();
    }
    representative.title.clone()
}

/// The label each project's threads carry in the sidebar, by project id.
#[must_use]
pub fn project_group_labels(projects: &[ProjectShell]) -> HashMap<String, String> {
    group_labels(projects, |project| normalize_path(&project.workspace_root))
}

/// [`project_group_labels`] for projects of several environments listed together
/// (`derivePhysicalProjectKey`): a folder is one physical project only within its environment,
/// so two machines' `/Users/me/conn` stay two projects, and the same repository on both still
/// groups under one label. `environment_of` names the environment of a project id.
#[must_use]
pub fn project_group_labels_across_environments(
    projects: &[ProjectShell],
    environment_of: impl Fn(&str) -> String,
) -> HashMap<String, String> {
    group_labels(projects, |project| {
        format!(
            "{}:{}",
            environment_of(&project.id),
            normalize_path(&project.workspace_root)
        )
    })
}

fn group_labels(
    projects: &[ProjectShell],
    physical_key_of: impl Fn(&ProjectShell) -> String,
) -> HashMap<String, String> {
    // Projects on one folder are one physical project; the freshest represents it.
    let mut physical_order: Vec<String> = Vec::new();
    let mut by_physical: HashMap<String, Vec<&ProjectShell>> = HashMap::new();
    for project in projects {
        let key = physical_key_of(project);
        by_physical
            .entry(key.clone())
            .or_insert_with(|| {
                physical_order.push(key);
                Vec::new()
            })
            .push(project);
    }

    let mut group_order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&ProjectShell>> = HashMap::new();
    let mut group_of_physical: HashMap<&str, String> = HashMap::new();
    for physical in &physical_order {
        let candidates = &by_physical[physical];
        let winner = candidates
            .iter()
            .copied()
            .fold(candidates[0], |best, next| {
                if replaces(best, next) { next } else { best }
            });
        // The winner names the repository; failing that, the freshest project that has one.
        let source = if identity(winner).is_some() {
            winner
        } else {
            candidates
                .iter()
                .copied()
                .filter(|p| identity(p).is_some())
                .fold(None::<&ProjectShell>, |best, next| match best {
                    Some(best) if !replaces(best, next) => Some(best),
                    _ => Some(next),
                })
                .unwrap_or(winner)
        };
        // A NUL reserves the scratch key namespace outside valid repository identities.
        let logical = identity(source)
            .map(grouping_key)
            .filter(|key| !key.contains('\0'))
            .map_or_else(|| physical.clone(), str::to_owned);
        group_of_physical.insert(physical.as_str(), logical.clone());
        groups
            .entry(logical.clone())
            .or_insert_with(|| {
                group_order.push(logical);
                Vec::new()
            })
            .push(winner);
    }

    let mut label_of_group: HashMap<&str, String> = HashMap::new();
    for key in &group_order {
        let members = &groups[key];
        let representative = members[0];
        let label = if members.len() > 1 {
            group_label(key, representative, members)
        } else {
            representative.title.clone()
        };
        label_of_group.insert(key.as_str(), label);
    }

    projects
        .iter()
        .filter_map(|project| {
            let group = group_of_physical.get(physical_key_of(project).as_str())?;
            Some((
                project.id.clone(),
                label_of_group.get(group.as_str())?.clone(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn identity_json(key: &str, display: &str, name: &str) -> Value {
        json!({
            "canonicalKey": key,
            "locator": { "source": "git-remote", "remoteName": "origin", "remoteUrl": format!("git@github.com:{display}.git") },
            "displayName": display,
            "name": name
        })
    }

    fn project(id: &str, title: &str, root: &str, repository: Option<Value>) -> ProjectShell {
        let mut value = json!({
            "id": id, "title": title, "workspaceRoot": root,
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "deletedAt": null
        });
        if let Some(repository) = repository {
            value["repositoryIdentity"] = repository;
        }
        serde_json::from_value(value).expect("project decodes")
    }

    fn conn() -> Value {
        identity_json("github.com/nckrtl/conn", "nckrtl/conn", "conn")
    }

    #[test]
    fn a_lone_project_keeps_its_title() {
        let labels = project_group_labels(&[project("a", "Conn - Dev", "/w/conn", Some(conn()))]);
        assert_eq!(labels["a"], "Conn - Dev");
    }

    #[test]
    fn projects_of_one_repository_share_the_repository_name() {
        let labels = project_group_labels(&[
            project("a", "Conn - Dev", "/w/conn", Some(conn())),
            project("b", "Conn (Conn Server move)", "/w/conn-move", Some(conn())),
            project("c", "spaces", "/w/spaces", None),
        ]);
        assert_eq!(labels["a"], "nckrtl/conn");
        assert_eq!(labels["b"], "nckrtl/conn");
        assert_eq!(
            labels["c"], "spaces",
            "a project with no repository stands alone"
        );
    }

    #[test]
    fn clones_with_one_title_keep_it_unless_it_is_only_the_repository_name() {
        let same_title = project_group_labels(&[
            project("a", "Conn - Dev", "/w/one", Some(conn())),
            project("b", "Conn - Dev", "/w/two", Some(conn())),
        ]);
        assert_eq!(same_title["a"], "Conn - Dev");
        let repository_name = project_group_labels(&[
            project("a", "conn", "/w/one", Some(conn())),
            project("b", "conn", "/w/two", Some(conn())),
        ]);
        assert_eq!(repository_name["a"], "nckrtl/conn");
    }

    #[test]
    fn a_title_the_user_chose_wins_over_the_repository_name() {
        let mut named = project("a", "My conn", "/w/one", Some(conn()));
        named.has_custom_title = Some(true);
        let labels =
            project_group_labels(&[named, project("b", "My conn", "/w/two", Some(conn()))]);
        assert_eq!(labels["a"], "My conn");
    }

    #[test]
    fn different_repositories_do_not_group() {
        let other = identity_json("github.com/nckrtl/orbit", "nckrtl/orbit", "orbit");
        let labels = project_group_labels(&[
            project("a", "Conn - Dev", "/w/conn", Some(conn())),
            project("b", "Orbit", "/w/orbit", Some(other)),
        ]);
        assert_eq!(labels["a"], "Conn - Dev");
        assert_eq!(labels["b"], "Orbit");
    }

    #[test]
    fn a_fork_groups_with_its_origin() {
        let mut fork = identity_json("github.com/me/conn", "me/conn", "conn");
        fork["origin"] =
            json!({ "canonicalKey": "github.com/nckrtl/conn", "displayName": "nckrtl/conn" });
        let labels = project_group_labels(&[
            project("a", "Conn - Dev", "/w/conn", Some(conn())),
            project("b", "Conn fork", "/w/fork", Some(fork)),
        ]);
        assert_eq!(labels["a"], "nckrtl/conn");
        assert_eq!(labels["b"], "nckrtl/conn");
    }

    #[test]
    fn projects_on_one_folder_are_one_project_and_trailing_slashes_do_not_split_it() {
        let labels = project_group_labels(&[
            project("a", "Conn - Dev", "/w/conn", None),
            project("b", "Conn - Dev", "/w/conn/", None),
        ]);
        assert_eq!(labels["a"], "Conn - Dev");
        assert_eq!(labels["b"], "Conn - Dev");
    }
}
