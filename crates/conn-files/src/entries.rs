//! `projects.listEntries` and `projects.listIgnoredFiles`, plus the file walk search uses.
//!
//! The TypeScript server keeps an `fff` index per workspace for 15 idle minutes. This server
//! keeps nothing: each call walks the workspace again with the `ignore` crate (ripgrep's
//! walker), bounded by [`MAX_ENTRIES`] files.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use conn_contract::{
    ProjectEntry, ProjectEntryKind, ProjectIgnoredFile, ProjectListEntriesError,
    ProjectListEntriesErrorFailure as Failure, ProjectListEntriesResult,
    ProjectListIgnoredFilesResult, ProjectSearchContentsError, ProjectSearchEntriesError, lit,
};

use crate::{
    git,
    paths::{self, InternalPaths},
    workspace::display,
};

/// `WORKSPACE_INDEX_MAX_ENTRIES`.
pub const MAX_ENTRIES: usize = 25_000;
/// `IGNORED_FILES_LIMIT`.
const IGNORED_FILES_LIMIT: usize = 200;
const IGNORE_CHECK_CHUNK: usize = 1000;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a listing or search failed, before it becomes one of the three contract errors.
#[derive(Debug)]
pub struct EntriesFailure {
    pub failure: Failure,
    pub normalized_cwd: Option<String>,
    pub detail: Option<String>,
}

impl std::fmt::Display for EntriesFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.failure)?;
        match &self.detail {
            Some(detail) => write!(f, ": {detail}"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for EntriesFailure {}

impl EntriesFailure {
    fn new(failure: Failure, normalized: &Path, detail: Option<String>) -> Self {
        Self {
            failure,
            normalized_cwd: Some(display(normalized.to_owned())),
            detail,
        }
    }

    pub fn into_list_error(self, cwd: &str) -> ProjectListEntriesError {
        ProjectListEntriesError {
            tag: lit::ProjectListEntriesError,
            cwd: Some(cwd.to_owned()),
            message: format!("Failed to list workspace entries in '{cwd}'."),
            failure: Some(self.failure),
            normalized_cwd: self.normalized_cwd,
            timeout: None,
            detail: self.detail,
            cause: None,
        }
    }

    pub fn into_search_error(
        self,
        cwd: &str,
        query: &str,
        limit: i64,
    ) -> ProjectSearchEntriesError {
        ProjectSearchEntriesError {
            tag: lit::ProjectSearchEntriesError,
            cwd: Some(cwd.to_owned()),
            query_length: Some(query.encode_utf16().count() as i64),
            limit: Some(limit),
            message: format!("Failed to search workspace entries in '{cwd}'."),
            failure: Some(self.failure),
            normalized_cwd: self.normalized_cwd,
            timeout: None,
            detail: self.detail,
            cause: None,
        }
    }

    pub fn into_contents_error(
        self,
        cwd: &str,
        query: &str,
        limit: i64,
    ) -> ProjectSearchContentsError {
        ProjectSearchContentsError {
            tag: lit::ProjectSearchContentsError,
            cwd: Some(cwd.to_owned()),
            query_length: Some(query.encode_utf16().count() as i64),
            limit: Some(limit),
            message: format!("Failed to search workspace contents in '{cwd}'."),
            failure: Some(self.failure),
            normalized_cwd: self.normalized_cwd,
            timeout: None,
            detail: self.detail,
            cause: None,
        }
    }
}

/// `normalizeWorkspaceRoot`: the resolved folder, which must exist and be a directory. A
/// folder inside the server's internal set answers as missing (T3 does not check this; the
/// signing key there mints asset URLs that work without a session).
pub fn normalize_root(
    cwd: &str,
    home: Option<&Path>,
    internal: &InternalPaths,
) -> Result<PathBuf, EntriesFailure> {
    let root = paths::resolve_cwd(cwd, home);
    match fs::metadata(&root) {
        Ok(_) if internal.contains(&InternalPaths::real(&root)) => Err(EntriesFailure::new(
            Failure::WorkspaceRootNotFound,
            &root,
            None,
        )),
        Ok(meta) if meta.is_dir() => Ok(root),
        Ok(_) => Err(EntriesFailure::new(
            Failure::WorkspaceRootNotDirectory,
            &root,
            None,
        )),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Err(EntriesFailure::new(
            Failure::WorkspaceRootNotFound,
            &root,
            None,
        )),
        Err(_) => Err(EntriesFailure::new(
            Failure::WorkspaceRootStatFailed,
            &root,
            Some("validate-existing".into()),
        )),
    }
}

/// Why a walk stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum WalkEnd {
    /// Every file was visited.
    Complete,
    /// The visitor asked to stop.
    Stopped,
    /// [`MAX_ENTRIES`] files or the deadline was reached first.
    Bounded,
}

/// Visits each non-ignored file under `root` as a `/`-separated relative path, in no fixed
/// order. `visit` returns false to stop. Nothing is kept between calls.
///
/// Ignore rules are Git's (`.gitignore` in the tree and its parents, `.git/info/exclude`, the
/// global excludes file), applied in and out of a Git checkout, as fff does. Hidden files are
/// listed; `.git` and the server's internal files are not; links are not followed.
pub fn walk_files(
    root: &Path,
    internal: &InternalPaths,
    deadline: Option<Instant>,
    visit: &mut dyn FnMut(&str) -> bool,
) -> WalkEnd {
    // From the canonical root, every path the walk yields is canonical too (it follows no
    // links), so the internal check needs no further lookups.
    let root = &InternalPaths::real(root);
    let internal = internal.clone();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .require_git(false)
        // The `ignore` crate reads `~/.gitconfig` itself for the global excludes file. Git
        // reads no `~/.gitconfig` when `GIT_CONFIG_GLOBAL` names another file, so neither does
        // the walk (the crate cannot read that file's `core.excludesFile`).
        .git_global(std::env::var_os("GIT_CONFIG_GLOBAL").is_none())
        .follow_links(false)
        .filter_entry(move |entry| entry.file_name() != ".git" && !internal.contains(entry.path()))
        .build();
    let mut seen = 0usize;
    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        if seen >= MAX_ENTRIES || deadline.is_some_and(|d| Instant::now() >= d) {
            return WalkEnd::Bounded;
        }
        seen += 1;
        let relative = relative.to_string_lossy();
        let relative = if std::path::MAIN_SEPARATOR == '/' {
            relative
        } else {
            relative.replace(std::path::MAIN_SEPARATOR, "/").into()
        };
        if !visit(&relative) {
            return WalkEnd::Stopped;
        }
    }
    WalkEnd::Complete
}

/// `projects.listEntries` without a folder: every file and folder, sorted, at most
/// [`MAX_ENTRIES`].
pub fn list_all(root: &Path, internal: &InternalPaths) -> ProjectListEntriesResult {
    let mut files: Vec<String> = Vec::new();
    let end = walk_files(root, internal, None, &mut |path| {
        files.push(path.to_owned());
        true
    });
    let mut dirs: HashSet<&str> = HashSet::new();
    for file in &files {
        let mut rest = file.as_str();
        while let Some(i) = rest.rfind('/') {
            rest = &rest[..i];
            if !dirs.insert(rest) {
                break;
            }
        }
    }
    let mut entries: Vec<ProjectEntry> = dirs
        .iter()
        .map(|d| entry(d, ProjectEntryKind::Directory))
        .chain(files.iter().map(|f| entry(f, ProjectEntryKind::File)))
        .collect();
    entries.sort_by(|a, b| sort_key(&a.path).cmp(&sort_key(&b.path)));
    let truncated = end == WalkEnd::Bounded || entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    ProjectListEntriesResult { entries, truncated }
}

fn sort_key(path: &str) -> (String, &str) {
    (path.to_lowercase(), path)
}

fn entry(path: &str, kind: ProjectEntryKind) -> ProjectEntry {
    ProjectEntry {
        path: path.to_owned(),
        kind,
        ignored: None,
    }
}

/// `projects.listEntries` with a folder: its children, with links resolved inside the root
/// only, `.git` and the server's internal files left out, and Git-ignored children marked.
pub fn list_directory(
    root: &Path,
    directory: &str,
    internal: &InternalPaths,
) -> Result<ProjectListEntriesResult, EntriesFailure> {
    let fail =
        |detail: String| EntriesFailure::new(Failure::DirectoryListFailed, root, Some(detail));
    let (target, relative) = if directory.is_empty() {
        (root.to_owned(), String::new())
    } else {
        paths::resolve_within_root(root, directory)
            .ok_or_else(|| fail(format!("'{directory}' is outside the workspace.")))?
    };
    let real_root = fs::canonicalize(root).map_err(|e| fail(e.to_string()))?;
    let real_dir = fs::canonicalize(&target).map_err(|e| fail(e.to_string()))?;
    let inside = real_dir
        .strip_prefix(&real_root)
        .map_err(|_| fail("Directory must be inside the workspace and outside .git.".into()))?;
    if inside.components().any(|c| c.as_os_str() == ".git")
        || relative.split('/').any(|s| s == ".git")
        || internal.contains(&real_dir)
    {
        return Err(fail(
            "Directory must be inside the workspace and outside .git.".into(),
        ));
    }
    let through_symlink =
        inside != Path::new(&relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    // Folders on the way down, so a link back up ("Expand all folders") is not followed.
    let mut ancestors = vec![real_root.clone()];
    let mut current = root.to_owned();
    for segment in relative.split('/').filter(|s| !s.is_empty()) {
        current.push(segment);
        if let Ok(real) = fs::canonicalize(&current) {
            ancestors.push(real);
        }
    }
    let mut entries = Vec::new();
    for child in fs::read_dir(&real_dir).map_err(|e| fail(e.to_string()))? {
        let Ok(child) = child else { continue };
        let name = child.file_name().to_string_lossy().into_owned();
        if name == ".git" || internal.contains(&real_dir.join(&name)) {
            continue;
        }
        let kind = match child.file_type() {
            Ok(t) if t.is_dir() => Some(ProjectEntryKind::Directory),
            Ok(t) if t.is_file() => Some(ProjectEntryKind::File),
            Ok(t) if t.is_symlink() => {
                symlink_kind(&real_dir.join(&name), &real_root, &ancestors, internal)
            }
            _ => None,
        };
        if let Some(kind) = kind {
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            entries.push(entry(&path, kind));
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    mark_ignored(root, &relative, through_symlink, &mut entries);
    Ok(ProjectListEntriesResult {
        entries,
        truncated: false,
    })
}

fn symlink_kind(
    link: &Path,
    real_root: &Path,
    ancestors: &[PathBuf],
    internal: &InternalPaths,
) -> Option<ProjectEntryKind> {
    let resolved = fs::canonicalize(link).ok()?;
    let inside = resolved.strip_prefix(real_root).ok()?;
    if inside.components().any(|c| c.as_os_str() == ".git") || internal.contains(&resolved) {
        return None;
    }
    let meta = fs::metadata(&resolved).ok()?;
    if meta.is_file() {
        return Some(ProjectEntryKind::File);
    }
    if !meta.is_dir() || ancestors.iter().any(|a| a.starts_with(&resolved)) {
        return None;
    }
    Some(ProjectEntryKind::Directory)
}

/// Labels children Git ignores. Optional: without git or a repository nothing is marked.
fn mark_ignored(root: &Path, relative: &str, through_symlink: bool, entries: &mut [ProjectEntry]) {
    if entries.is_empty() {
        return;
    }
    // Inside a submodule, git answers only from the submodule's own root.
    let mut git_root = String::new();
    let segments: Vec<&str> = relative.split('/').filter(|s| !s.is_empty()).collect();
    for depth in 1..=segments.len() {
        let candidate = segments[..depth].join("/");
        if fs::symlink_metadata(root.join(&candidate).join(".git")).is_err() {
            continue;
        }
        let probe = check_ignore(root, "", &[format!("{candidate}/.git")]);
        if probe.as_ref().and_then(|o| o.code) == Some(128) {
            git_root = candidate;
        }
    }
    let prefix = if git_root.is_empty() {
        String::new()
    } else {
        format!("{git_root}/")
    };
    let dir_in_repo = relative.strip_prefix(&prefix).unwrap_or(relative);
    let pathspec_magic =
        dir_in_repo.starts_with(':') || dir_in_repo.contains(['*', '?', '[', '\\']);
    if entries.len() > IGNORE_CHECK_CHUNK
        && !dir_in_repo.is_empty()
        && !through_symlink
        && !pathspec_magic
        && check_ignore(root, &git_root, &[relative.to_owned()]).and_then(|o| o.code) == Some(0)
    {
        for entry in entries.iter_mut() {
            entry.ignored = Some(true);
        }
        return;
    }
    let mut ignored: HashSet<String> = HashSet::new();
    for chunk in entries.chunks(IGNORE_CHECK_CHUNK) {
        let paths: Vec<String> = chunk.iter().map(|e| e.path.clone()).collect();
        let Some(output) = check_ignore(root, &git_root, &paths) else {
            break;
        };
        if !matches!(output.code, Some(0 | 1)) {
            break;
        }
        for path in output.stdout.split(|&b| b == 0).filter(|p| !p.is_empty()) {
            ignored.insert(format!("{prefix}{}", String::from_utf8_lossy(path)));
        }
    }
    for entry in entries.iter_mut() {
        if ignored.contains(&entry.path) {
            entry.ignored = Some(true);
        }
    }
}

fn check_ignore(root: &Path, git_root: &str, paths: &[String]) -> Option<git::Output> {
    let prefix_len = if git_root.is_empty() {
        0
    } else {
        git_root.len() + 1
    };
    let mut stdin = Vec::new();
    for path in paths {
        stdin.extend_from_slice(path.get(prefix_len..).unwrap_or(path).as_bytes());
        stdin.push(0);
    }
    git::run(
        &root.join(git_root),
        &["check-ignore", "-z", "--stdin"],
        Some(stdin),
        16 * 1024 * 1024,
        GIT_TIMEOUT,
    )
}

/// `projects.listIgnoredFiles`: untracked files Git ignores, without wholly ignored folders such
/// as `node_modules`, at most 200, with their sizes. Links are not followed; the server's
/// internal files are left out. `query` keeps the paths that contain it, case-insensitive,
/// before the cap, so files that sort past it stay reachable (`ignoredFileSearch`).
pub fn list_ignored(
    root: &Path,
    internal: &InternalPaths,
    query: Option<&str>,
) -> ProjectListIgnoredFilesResult {
    let query = query.unwrap_or_default().to_lowercase();
    let empty = ProjectListIgnoredFilesResult {
        files: Vec::new(),
        truncated: false,
    };
    let Some(output) = git::run(
        root,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        None,
        4 * 1024 * 1024,
        GIT_TIMEOUT,
    ) else {
        return empty;
    };
    if output.code != Some(0) || output.truncated {
        return empty;
    }
    let real_root = InternalPaths::real(root);
    let mut paths: Vec<String> = output
        .stdout
        .split(|&b| b == 0)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .filter(|p| !p.is_empty() && !p.ends_with('/') && p.to_lowercase().contains(&query))
        .filter(|p| !internal.contains(&real_root.join(p)))
        .collect();
    paths.sort();
    let truncated = paths.len() > IGNORED_FILES_LIMIT;
    let files = paths
        .into_iter()
        .take(IGNORED_FILES_LIMIT)
        .filter_map(|path| {
            let meta = fs::symlink_metadata(root.join(&path)).ok()?;
            meta.is_file().then_some(ProjectIgnoredFile {
                byte_length: meta.len() as i64,
                path,
            })
        })
        .collect();
    ProjectListIgnoredFilesResult { files, truncated }
}
