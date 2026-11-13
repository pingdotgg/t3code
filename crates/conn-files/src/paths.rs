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

/// The server's own files: no file method, listing, search or asset URL serves them.
///
/// The base is the T3 server's set (`auth/serverInternalPaths.ts`): `secrets/`, files directly
/// in the state folder whose name holds `.sqlite` (the event store and its journal), and
/// `/dev/fd`. Two more hold what T3 keeps inside its SQLite file or should not show:
/// `auth.json` (session and pairing-link hashes; T3 keeps them in `state.sqlite`) and
/// `terminals/` (terminal scrollback). Everything else in the state folder reads as any host
/// file does, as in T3; that includes thread worktrees under `<state-dir>/worktrees`.
#[derive(Clone, Debug)]
pub struct InternalPaths {
    state_dir: PathBuf,
    secrets_dir: PathBuf,
    terminals_dir: PathBuf,
    auth_file: PathBuf,
}

/// Folder and file names inside the state folder that [`InternalPaths`] refuses. Written by
/// `signer.rs`, `conn-server`'s terminal methods and its auth store.
pub const SECRETS_DIR: &str = "secrets";
pub const TERMINALS_DIR: &str = "terminals";
pub const AUTH_FILE: &str = "auth.json";

impl InternalPaths {
    pub fn new(state_dir: &Path) -> Self {
        let state_dir = fs::canonicalize(state_dir).unwrap_or_else(|_| normalize(state_dir));
        Self {
            secrets_dir: state_dir.join(SECRETS_DIR),
            terminals_dir: state_dir.join(TERMINALS_DIR),
            auth_file: state_dir.join(AUTH_FILE),
            state_dir,
        }
    }

    /// `path` must be canonical (or, during a walk that follows no links, below a canonical
    /// root).
    pub fn contains(&self, path: &Path) -> bool {
        is_within(path, &self.secrets_dir)
            || is_within(path, &self.terminals_dir)
            || path == self.auth_file
            || (path.parent() == Some(self.state_dir.as_path())
                && path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().contains(".sqlite")))
            || is_within(path, Path::new("/dev/fd"))
    }

    /// The canonical form of `path`, when it exists; the lexical form otherwise.
    pub fn real(path: &Path) -> PathBuf {
        fs::canonicalize(path).unwrap_or_else(|_| normalize(path))
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

    #[test]
    fn internal_paths_are_the_t3_set_plus_auth_and_terminals() {
        let internal = InternalPaths::new(Path::new("/nonexistent/state"));
        let s = Path::new("/nonexistent/state");
        for refused in [
            s.join("secrets"),
            s.join("secrets/asset-signing-key"),
            s.join("engine.sqlite"),
            s.join("engine.sqlite-wal"),
            s.join("server-owner.sqlite"),
            s.join("auth.json"),
            s.join("terminals/t.log"),
            PathBuf::from("/dev/fd/3"),
        ] {
            assert!(internal.contains(&refused), "{refused:?}");
        }
        for served in [
            s.to_path_buf(),
            s.join("worktrees/p/t3-1/a.rs"),
            s.join("worktrees/p/t3-1/db.sqlite"),
            s.join("attachments/x.png"),
            s.join("settings.json"),
            s.join("keybindings.json"),
            PathBuf::from("/nonexistent/statefoo/secrets"),
        ] {
            assert!(!internal.contains(&served), "{served:?}");
        }
    }
}
