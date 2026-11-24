//! Pure-Rust file tree model for the Files right-panel surface.
//!
//! Stores lazily loaded directory children from `projects.listEntries`, tracks
//! expanded/loading folders, and flattens/filters visible rows for rendering.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use conn_contract::{ProjectEntry, ProjectEntryKind};

/// One flattened row rendered in the file explorer tree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VisibleTreeRow {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) depth: usize,
    pub(crate) kind: ProjectEntryKind,
    pub(crate) expanded: bool,
    pub(crate) loading: bool,
    pub(crate) ignored: bool,
}

/// Pure tree state backing the Files explorer column.
#[derive(Clone, Debug, Default)]
pub(crate) struct FileTreeState {
    /// Children keyed by parent directory path (`""` for workspace root).
    children: BTreeMap<String, Vec<ProjectEntry>>,
    /// Expanded directory paths.
    expanded: BTreeSet<String>,
    /// Directories currently being fetched via `projects.listEntries`.
    loading: BTreeSet<String>,
    /// Currently selected file path.
    selected_path: Option<String>,
    /// Active case-insensitive filter query.
    query: String,
    /// Matches the server found for the query (`projects.searchEntries`), with their folders,
    /// by parent directory. Merged into the rows only while filtering, so a folder never looks
    /// loaded because a search touched it.
    search: BTreeMap<String, Vec<ProjectEntry>>,
}

impl FileTreeState {
    /// Clears all loaded entries, expanded state, and selection.
    pub(crate) fn clear(&mut self) {
        self.children.clear();
        self.expanded.clear();
        self.loading.clear();
        self.selected_path = None;
        self.search.clear();
    }

    /// Keeps the server's matches (`buildTreeEntries`): each match, and every folder above it,
    /// is listed under its parent directory.
    pub(crate) fn set_search_results(&mut self, matches: &[ProjectEntry]) {
        let mut search: BTreeMap<String, Vec<ProjectEntry>> = BTreeMap::new();
        let mut add = |entry: ProjectEntry| {
            let parent = entry
                .path
                .rsplit_once('/')
                .map_or(String::new(), |(parent, _)| parent.to_owned());
            let list = search.entry(parent).or_default();
            if !list.iter().any(|e| e.path == entry.path) {
                list.push(entry);
            }
        };
        for entry in matches {
            add(entry.clone());
            let mut path = String::new();
            let parts: Vec<&str> = entry.path.split('/').collect();
            for part in &parts[..parts.len().saturating_sub(1)] {
                if !path.is_empty() {
                    path.push('/');
                }
                path.push_str(part);
                add(ProjectEntry {
                    path: path.clone(),
                    kind: ProjectEntryKind::Directory,
                    ignored: None,
                });
            }
        }
        self.search = search;
    }

    /// Drops the server's matches (the query was cleared or changed).
    pub(crate) fn clear_search(&mut self) {
        self.search.clear();
    }

    /// The children of `dir` that are loaded or that a search found.
    fn merged_children(&self, dir: &str) -> Vec<ProjectEntry> {
        let mut out = self.children.get(dir).cloned().unwrap_or_default();
        if let Some(found) = self.search.get(dir) {
            for entry in found {
                if !out.iter().any(|e| e.path == entry.path) {
                    out.push(entry.clone());
                }
            }
            out.sort_by(compare_entries);
        }
        out
    }

    /// Replaces the loaded children of `directory` (`""` for root) and clears its loading flag.
    pub(crate) fn set_directory_entries(
        &mut self,
        directory: &str,
        mut entries: Vec<ProjectEntry>,
    ) {
        entries.sort_by(compare_entries);
        self.loading.remove(directory);
        self.children.insert(directory.to_owned(), entries);
    }

    /// Marks `directory` as loading.
    pub(crate) fn mark_loading(&mut self, directory: &str) {
        self.loading.insert(directory.to_owned());
    }

    /// Clears the loading flag for `directory` without altering its cached entries.
    pub(crate) fn clear_loading(&mut self, directory: &str) {
        self.loading.remove(directory);
    }

    /// Returns whether `directory` already has loaded children.
    #[must_use]
    pub(crate) fn has_loaded(&self, directory: &str) -> bool {
        self.children.contains_key(directory)
    }

    /// Returns whether any directory is loading (the refresh button spins meanwhile).
    pub(crate) fn is_loading(&self) -> bool {
        !self.loading.is_empty()
    }

    /// Returns whether the root directory is currently loading.
    #[must_use]
    pub(crate) fn is_root_loading(&self) -> bool {
        self.loading.contains("")
    }

    /// Toggles expansion for `directory`. Returns `true` if expanded and needs a lazy load.
    pub(crate) fn toggle_directory(&mut self, directory: &str) -> bool {
        if self.expanded.remove(directory) {
            false
        } else {
            self.expanded.insert(directory.to_owned());
            !self.children.contains_key(directory) && !self.loading.contains(directory)
        }
    }

    pub(crate) fn expand(&mut self, directory: &str) -> bool {
        self.expanded.insert(directory.to_owned());
        !self.has_loaded(directory) && !self.loading.contains(directory)
    }

    /// Returns whether any directory entry is currently known in the tree.
    #[must_use]
    pub(crate) fn has_directories(&self) -> bool {
        self.children
            .values()
            .flatten()
            .any(|e| e.kind == ProjectEntryKind::Directory && !e.ignored.unwrap_or(false))
    }

    /// Returns `true` when every non-ignored known directory is expanded.
    #[must_use]
    pub(crate) fn all_directories_expanded(&self) -> bool {
        let mut any = false;
        for entry in self.children.values().flatten() {
            if entry.kind == ProjectEntryKind::Directory && !entry.ignored.unwrap_or(false) {
                any = true;
                if !self.expanded.contains(&entry.path) {
                    return false;
                }
            }
        }
        any
    }

    /// Expands all known non-ignored directories and returns those that still need a lazy load.
    pub(crate) fn expand_all_directories(&mut self) -> Vec<String> {
        let dirs: Vec<String> = self
            .children
            .values()
            .flatten()
            .filter(|e| e.kind == ProjectEntryKind::Directory && !e.ignored.unwrap_or(false))
            .map(|e| e.path.clone())
            .collect();
        let mut to_load = Vec::new();
        for dir in dirs {
            self.expanded.insert(dir.clone());
            if !self.children.contains_key(&dir) && !self.loading.contains(&dir) {
                to_load.push(dir);
            }
        }
        to_load
    }

    /// Expands `folder` and every folder above it, and selects it. Returns the folders among
    /// them that still need a lazy load.
    pub(crate) fn reveal_folder(&mut self, folder: &str) -> Vec<String> {
        let mut to_load = Vec::new();
        let mut path = String::new();
        let parts: Vec<&str> = folder.split('/').filter(|p| !p.is_empty()).collect();
        for part in parts {
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(part);
            self.expanded.insert(path.clone());
            if !self.children.contains_key(&path) && !self.loading.contains(&path) {
                to_load.push(path.clone());
            }
        }
        self.selected_path = (!path.is_empty()).then_some(path);
        to_load
    }

    /// Collapses every expanded directory.
    pub(crate) fn collapse_all_directories(&mut self) {
        self.expanded.clear();
    }

    /// Returns all currently expanded directory paths (useful for refreshing).
    #[must_use]
    pub(crate) fn expanded_directories(&self) -> Vec<String> {
        self.expanded.iter().cloned().collect()
    }

    /// Updates the filter query.
    pub(crate) fn set_query(&mut self, query: String) {
        self.query = query;
    }

    /// Returns the active filter query.
    #[must_use]
    pub(crate) fn query(&self) -> &str {
        &self.query
    }

    /// Sets the selected file path.
    pub(crate) fn select(&mut self, path: Option<String>) {
        self.selected_path = path;
    }

    /// Returns the selected file path.
    #[must_use]
    pub(crate) fn selected(&self) -> Option<&str> {
        self.selected_path.as_deref()
    }

    /// Flattens the tree into the ordered list of rows to display.
    ///
    /// When `query` is empty, only expanded directories descend into their children.
    /// When `query` is non-empty, all loaded directories are searched case-insensitively
    /// and any directory containing a matching descendant is shown expanded.
    #[must_use]
    pub(crate) fn visible_rows(&self) -> Vec<VisibleTreeRow> {
        let trimmed = self.query.trim();
        let mut out = Vec::new();
        if trimmed.is_empty() {
            self.collect_unfiltered("", 0, &mut out);
        } else {
            let needle = trimmed.to_ascii_lowercase();
            self.collect_filtered("", 0, &needle, &mut out);
        }
        out
    }

    fn collect_unfiltered(&self, dir: &str, depth: usize, out: &mut Vec<VisibleTreeRow>) {
        let Some(entries) = self.children.get(dir) else {
            return;
        };
        for entry in entries {
            let expanded =
                entry.kind == ProjectEntryKind::Directory && self.expanded.contains(&entry.path);
            let loading =
                entry.kind == ProjectEntryKind::Directory && self.loading.contains(&entry.path);
            out.push(VisibleTreeRow {
                path: entry.path.clone(),
                name: entry_name(&entry.path).to_owned(),
                depth,
                kind: entry.kind,
                expanded,
                loading,
                ignored: entry.ignored.unwrap_or(false),
            });
            if expanded {
                self.collect_unfiltered(&entry.path, depth + 1, out);
            }
        }
    }

    /// Returns `true` if any row under `dir` matched `needle`.
    fn collect_filtered(
        &self,
        dir: &str,
        depth: usize,
        needle: &str,
        out: &mut Vec<VisibleTreeRow>,
    ) -> bool {
        let entries = self.merged_children(dir);
        if entries.is_empty() {
            return false;
        }
        let mut any_match = false;
        for entry in &entries {
            let self_matches = entry.path.to_ascii_lowercase().contains(needle);
            if entry.kind == ProjectEntryKind::Directory {
                let mut child_rows = Vec::new();
                let child_matched =
                    self.collect_filtered(&entry.path, depth + 1, needle, &mut child_rows);
                if self_matches || child_matched {
                    any_match = true;
                    out.push(VisibleTreeRow {
                        path: entry.path.clone(),
                        name: entry_name(&entry.path).to_owned(),
                        depth,
                        kind: entry.kind,
                        expanded: child_matched || self.expanded.contains(&entry.path),
                        loading: self.loading.contains(&entry.path),
                        ignored: entry.ignored.unwrap_or(false),
                    });
                    if child_matched {
                        out.extend(child_rows);
                    } else if self.expanded.contains(&entry.path) {
                        self.collect_unfiltered(&entry.path, depth + 1, out);
                    }
                }
            } else if self_matches {
                any_match = true;
                out.push(VisibleTreeRow {
                    path: entry.path.clone(),
                    name: entry_name(&entry.path).to_owned(),
                    depth,
                    kind: entry.kind,
                    expanded: false,
                    loading: false,
                    ignored: entry.ignored.unwrap_or(false),
                });
            }
        }
        any_match
    }
}

fn entry_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn compare_entries(a: &ProjectEntry, b: &ProjectEntry) -> Ordering {
    let rank = |k: ProjectEntryKind| match k {
        ProjectEntryKind::Directory => 0u8,
        ProjectEntryKind::File => 1u8,
    };
    rank(a.kind)
        .cmp(&rank(b.kind))
        .then_with(|| {
            a.path
                .to_ascii_lowercase()
                .cmp(&b.path.to_ascii_lowercase())
        })
        .then_with(|| a.path.cmp(&b.path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(path: &str) -> ProjectEntry {
        ProjectEntry {
            path: path.to_owned(),
            kind: ProjectEntryKind::Directory,
            ignored: None,
        }
    }

    fn file(path: &str) -> ProjectEntry {
        ProjectEntry {
            path: path.to_owned(),
            kind: ProjectEntryKind::File,
            ignored: None,
        }
    }

    #[test]
    fn server_matches_show_in_a_filtered_tree_without_marking_folders_loaded() {
        let mut tree = FileTreeState::default();
        tree.set_directory_entries("", vec![dir("src")]);
        tree.set_search_results(&[ProjectEntry {
            path: "src/deep/needle.rs".to_owned(),
            kind: ProjectEntryKind::File,
            ignored: None,
        }]);
        tree.set_query("needle".to_owned());
        let rows = tree.visible_rows();
        let paths: Vec<_> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["src", "src/deep", "src/deep/needle.rs"]);
        assert!(!tree.has_loaded("src"), "a search does not load folders");
        tree.clear_search();
        assert!(
            tree.visible_rows().is_empty(),
            "no loaded match without the server's"
        );
    }

    #[test]
    fn revealing_a_folder_expands_it_and_its_ancestors_and_selects_it() {
        let mut tree = FileTreeState::default();
        tree.set_directory_entries("", vec![dir("a")]);
        let to_load = tree.reveal_folder("a/b/c");
        assert_eq!(
            to_load,
            vec!["a".to_owned(), "a/b".to_owned(), "a/b/c".to_owned()]
        );
        assert_eq!(tree.selected(), Some("a/b/c"));
        assert!(tree.expanded_directories().contains(&"a".to_owned()));
    }

    #[test]
    fn sorts_directories_before_files_and_flattens_expanded() {
        let mut tree = FileTreeState::default();
        tree.set_directory_entries("", vec![file("README.md"), dir("src"), file("Cargo.toml")]);
        tree.set_directory_entries("src", vec![file("src/main.rs"), dir("src/panels")]);
        tree.set_directory_entries("src/panels", vec![file("src/panels/mod.rs")]);

        // Initially collapsed: only root entries, dirs first then files alphabetically.
        let rows = tree.visible_rows();
        let paths: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["src", "Cargo.toml", "README.md"],
            "directories must sort before files, alphabetically"
        );
        assert!(
            rows.iter().all(|r| r.depth == 0),
            "root entries have depth 0"
        );

        // Expand `src` (already loaded -> returns false for needs_load).
        assert!(
            !tree.toggle_directory("src"),
            "already-loaded directory should not need lazy load"
        );
        let rows = tree.visible_rows();
        let paths: Vec<(&str, usize)> = rows.iter().map(|r| (r.path.as_str(), r.depth)).collect();
        assert_eq!(
            paths,
            vec![
                ("src", 0),
                ("src/panels", 1),
                ("src/main.rs", 1),
                ("Cargo.toml", 0),
                ("README.md", 0),
            ],
            "expanding src shows its children at depth 1"
        );

        // Expand `src/panels`.
        tree.toggle_directory("src/panels");
        let rows = tree.visible_rows();
        assert!(
            rows.iter()
                .any(|r| r.path == "src/panels/mod.rs" && r.depth == 2 && r.name == "mod.rs"),
            "nested file should appear at depth 2 with basename"
        );

        // Collapse `src`: hides nested children.
        tree.toggle_directory("src");
        let rows = tree.visible_rows();
        assert_eq!(rows.len(), 3, "collapsing src hides descendants");
    }

    #[test]
    fn toggle_unloaded_directory_requests_lazy_load() {
        let mut tree = FileTreeState::default();
        tree.set_directory_entries("", vec![dir("crates")]);
        assert!(
            tree.toggle_directory("crates"),
            "expanding unloaded directory must signal lazy load"
        );
        tree.mark_loading("crates");
        let rows = tree.visible_rows();
        assert!(rows[0].expanded && rows[0].loading, "row reflects loading");
    }

    #[test]
    fn filtering_is_case_insensitive_and_preserves_ancestors() {
        let mut tree = FileTreeState::default();
        tree.set_directory_entries("", vec![dir("src"), file("Cargo.toml")]);
        tree.set_directory_entries("src", vec![file("src/Main.rs"), file("src/lib.rs")]);

        // Even while `src` is collapsed, filtering finds `src/Main.rs` and includes `src`.
        tree.set_query("main".to_owned());
        let rows = tree.visible_rows();
        let paths: Vec<(&str, usize, bool)> = rows
            .iter()
            .map(|r| (r.path.as_str(), r.depth, r.expanded))
            .collect();
        assert_eq!(
            paths,
            vec![("src", 0, true), ("src/Main.rs", 1, false)],
            "filter must match case-insensitively and expand matching ancestor"
        );

        tree.set_query("nonexistent".to_owned());
        assert!(
            tree.visible_rows().is_empty(),
            "unmatched query must yield no rows"
        );
    }

    #[test]
    fn expand_and_collapse_all_skips_ignored_directories() {
        let mut tree = FileTreeState::default();
        let ignored_dir = ProjectEntry {
            path: "target".to_owned(),
            kind: ProjectEntryKind::Directory,
            ignored: Some(true),
        };
        tree.set_directory_entries("", vec![dir("src"), ignored_dir, file("Cargo.toml")]);

        assert!(tree.has_directories());
        assert!(!tree.all_directories_expanded());

        let to_load = tree.expand_all_directories();
        assert_eq!(to_load, vec!["src"], "ignored dirs are not auto-expanded");
        assert!(tree.all_directories_expanded());

        tree.collapse_all_directories();
        assert!(!tree.all_directories_expanded());
    }
}
