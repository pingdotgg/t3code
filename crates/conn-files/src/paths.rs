//! Path rules shared by every file operation: home expansion, lexical resolution, root
//! containment, Git metadata folders and the server's own state. Mirrors
//! `apps/server/src/workspace/WorkspacePaths.ts` and `WorkspaceFileSystem.ts`.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

/// `expandHomePath`: `~` and `~/x` only; `~user` stays as written.
pub fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    match home {
        Some(home) if value == "~" => home.to_owned(),
        Some(home) if value.starts_with("~/") || value.starts_with("~\\") => home.join(&value[2..]),
        _ => PathBuf::from(value),
    }
}

/// Node's `path.resolve(base, value)`: joins unless `value` is absolute, then folds `.` and
/// `..` without touching the disk.
pub fn resolve(base: &Path, value: &Path) -> PathBuf {
    let joined = if value.is_absolute() {
        value.to_owned()
    } else {
        base.join(value)
    };
    normalize(&joined)
}

/// Folds `.` and `..` lexically. `..` never climbs above the root.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() && !path.is_absolute() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        out.push(if path.is_absolute() { "/" } else { "." });
    }
    out
}

/// `resolve` against the process folder, for a client `cwd` that may be relative.
pub fn resolve_cwd(cwd: &str, home: Option<&Path>) -> PathBuf {
    let base = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    resolve(&base, &expand_home(cwd.trim(), home))
}

/// True when `path` is `root` or below it. Both must be resolved the same way.
pub fn is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// `resolveRelativePathWithinRoot`: a relative path that stays strictly below `root` after
/// folding `..`. Returns the absolute path and the `/`-separated relative path.
pub fn resolve_within_root(root: &Path, relative: &str) -> Option<(PathBuf, String)> {
    if relative.is_empty() || Path::new(relative).is_absolute() {
        return None;
    }
    let absolute = resolve(root, Path::new(relative));
    let rest = absolute.strip_prefix(normalize(root)).ok()?;
    if rest.as_os_str().is_empty() {
        return None;
    }
    let relative = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Some((absolute, relative))
}

/// `.git`, as NTFS also spells it. Unix needs only the plain name, but the check is cheap.
pub fn is_git_metadata_name(segment: &str) -> bool {
    let name = segment.split(':').next().unwrap_or_default();
    let name = name.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    name == ".GIT" || name == "GIT~1"
}

/// True when `path` (normalized) is inside a Git folder: a `.git` segment, or a folder Git
/// would read as a repository (`HEAD` with `commondir`, or with `objects` and `refs`). Stops at
/// a linked worktree's `.git` file. An unexpected error leaves the answer unknown.
pub fn in_git_folder(path: &Path) -> io::Result<bool> {
    if path
        .components()
        .any(|c| is_git_metadata_name(&c.as_os_str().to_string_lossy()))
    {
        return Ok(true);
    }
    let exists = |p: PathBuf| match fs::symlink_metadata(&p) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound || is_not_dir(&e) => Ok(None),
        Err(e) => Err(e),
    };
    let mut folder = path.parent();
    while let Some(dir) = folder {
        let head = exists(dir.join("HEAD"))?.is_some();
        if head
            && (exists(dir.join("commondir"))?.is_some()
                || (exists(dir.join("objects"))?.is_some() && exists(dir.join("refs"))?.is_some()))
        {
            return Ok(true);
        }
        if exists(dir.join(".git"))?.is_some_and(|m| m.is_file()) {
            return Ok(false);
        }
        folder = dir.parent();
    }
    Ok(false)
}

pub fn is_not_dir(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotADirectory
}

/// The server's own files: client reads never serve them. That is the whole state folder
/// (sessions, signing key, event store) except the attachment store, plus `/dev/fd`.
#[derive(Clone, Debug)]
pub struct InternalPaths {
    state_dir: PathBuf,
    attachments_dir: PathBuf,
}

impl InternalPaths {
    pub fn new(state_dir: &Path, attachments_dir: &Path) -> Self {
        let real = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| normalize(p));
        Self {
            state_dir: real(state_dir),
            attachments_dir: real(attachments_dir),
        }
    }

    /// `path` must be canonical.
    pub fn contains(&self, path: &Path) -> bool {
        (is_within(path, &self.state_dir) && !is_within(path, &self.attachments_dir))
            || is_within(path, Path::new("/dev/fd"))
    }
}

/// `isNetworkPath`: two leading separators.
pub fn is_network_path(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 2 && matches!(b[0], b'/' | b'\\') && matches!(b[1], b'/' | b'\\')
}

pub fn is_windows_absolute(value: &str) -> bool {
    let b = value.as_bytes();
    value.starts_with("\\\\")
        || (b.len() >= 2
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b.len() == 2 || matches!(b[2], b'/' | b'\\')))
}

pub fn is_explicit_relative(value: &str) -> bool {
    value == "."
        || value == ".."
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with(".\\")
        || value.starts_with("..\\")
}

/// The file system root (`/`) grants nothing as a workspace.
pub fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

/// Lowercased extension with its dot, or `""`.
pub fn extension(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 || name.len() > 1 => name[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_like_node() {
        let root = Path::new("/w/p");
        assert_eq!(
            resolve_within_root(root, "a/b.txt"),
            Some((PathBuf::from("/w/p/a/b.txt"), "a/b.txt".into()))
        );
        assert_eq!(
            resolve_within_root(root, "a/../b"),
            Some((PathBuf::from("/w/p/b"), "b".into()))
        );
        for escape in ["..", "../x", "a/../../x", "/etc/passwd", ".", "", "a/.."] {
            assert_eq!(resolve_within_root(root, escape), None, "{escape}");
        }
        assert_eq!(normalize(Path::new("/../../a")), PathBuf::from("/a"));
        assert_eq!(
            expand_home("~/x", Some(Path::new("/h"))),
            PathBuf::from("/h/x")
        );
        assert_eq!(
            expand_home("~u/x", Some(Path::new("/h"))),
            PathBuf::from("~u/x")
        );
    }

    #[test]
    fn names_git_folders() {
        assert!(is_git_metadata_name(".git"));
        assert!(is_git_metadata_name(".GIT. "));
        assert!(is_git_metadata_name("git~1"));
        assert!(!is_git_metadata_name(".github"));
        assert!(in_git_folder(Path::new("/w/p/.git/config")).unwrap());
        assert_eq!(extension("a/B.PNG"), ".png");
        assert_eq!(extension(".gitignore"), ".gitignore");
        assert_eq!(extension("Makefile"), "");
    }
}
