//! `projects.readFile`, `projects.writeFile`, `filesystem.getMetadata`, `filesystem.browse`.
//! Behaviour follows `apps/server/src/workspace/WorkspaceFileSystem.ts` and the `browse` part of
//! `WorkspaceEntries.ts`. Every function blocks; callers run them on `spawn_blocking`.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use conn_contract::{
    FilesystemBrowseEntry, FilesystemBrowseError2, FilesystemBrowseError2Failure,
    FilesystemBrowseInput, FilesystemBrowseResult, FilesystemEntryMetadata,
    FilesystemEntryMetadataKind, FilesystemGetMetadataResult, ProjectReadFileError,
    ProjectReadFileErrorFailure as Failure, ProjectReadFileErrorOperation as Operation,
    ProjectReadFileInput, ProjectReadFileResult, ProjectWriteFileError, ProjectWriteFileInput,
    ProjectWriteFileResult, lit,
};

use crate::{
    mime,
    paths::{self, InternalPaths},
};

/// `PROJECT_READ_FILE_MAX_BYTES`.
pub const READ_FILE_MAX_BYTES: u64 = 1024 * 1024;

#[cfg(target_os = "linux")]
pub(crate) mod flags {
    pub(crate) const O_NONBLOCK: i32 = 0o4000;
    pub(crate) const O_NOFOLLOW: i32 = 0o400000;
}
#[cfg(not(target_os = "linux"))]
pub(crate) mod flags {
    // macOS and the BSDs.
    pub(crate) const O_NONBLOCK: i32 = 0x0004;
    pub(crate) const O_NOFOLLOW: i32 = 0x0100;
}

/// Opens for reading without blocking on a FIFO swapped in after a check.
pub fn open_nonblocking(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(flags::O_NONBLOCK);
    options.open(path)
}

/// Why a read or write failed, before it becomes the contract error.
#[derive(Debug)]
pub struct FileFailure {
    pub failure: Failure,
    pub resolved_path: Option<PathBuf>,
    pub resolved_workspace_root: Option<PathBuf>,
    pub operation: Option<(Operation, PathBuf)>,
    pub detail: Option<String>,
}

impl std::fmt::Display for FileFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self.failure)?;
        match &self.detail {
            Some(detail) => write!(f, ": {detail}"),
            None => Ok(()),
        }
    }
}

impl std::error::Error for FileFailure {}

impl FileFailure {
    fn outside_root() -> Self {
        Self::plain(Failure::WorkspacePathOutsideRoot, None)
    }

    fn plain(failure: Failure, resolved: Option<&Path>) -> Self {
        Self {
            failure,
            resolved_path: resolved.map(Path::to_owned),
            resolved_workspace_root: None,
            operation: None,
            detail: None,
        }
    }

    fn op(operation: Operation, resolved: &Path, at: &Path, error: io::Error) -> Self {
        Self {
            failure: Failure::OperationFailed,
            resolved_path: Some(resolved.to_owned()),
            resolved_workspace_root: None,
            operation: Some((operation, at.to_owned())),
            detail: Some(error.to_string()),
        }
    }

    fn escape(root: &Path, resolved: &Path) -> Self {
        Self {
            failure: Failure::ResolvedPathOutsideRoot,
            resolved_path: Some(resolved.to_owned()),
            resolved_workspace_root: Some(root.to_owned()),
            operation: None,
            detail: None,
        }
    }

    fn message(&self, verb: &str, cwd: &str, relative_path: &str) -> String {
        let base = format!("Failed to {verb} workspace file '{relative_path}' in '{cwd}'.");
        match &self.detail {
            Some(detail) => format!("{base} {detail}"),
            None => base,
        }
    }

    pub fn into_read_error(self, cwd: &str, relative_path: &str) -> ProjectReadFileError {
        let message = self.message("read", cwd, relative_path);
        ProjectReadFileError {
            tag: lit::ProjectReadFileError,
            cwd: Some(cwd.to_owned()),
            relative_path: Some(relative_path.to_owned()),
            failure: Some(self.failure),
            resolved_path: self.resolved_path.map(display),
            resolved_workspace_root: self.resolved_workspace_root.map(display),
            operation: self.operation.as_ref().map(|(op, _)| *op),
            operation_path: self.operation.map(|(_, at)| display(at)),
            message,
            cause: None,
        }
    }

    pub fn into_write_error(self, cwd: &str, relative_path: &str) -> ProjectWriteFileError {
        let message = self.message("write", cwd, relative_path);
        ProjectWriteFileError {
            tag: lit::ProjectWriteFileError,
            cwd: Some(cwd.to_owned()),
            relative_path: Some(relative_path.to_owned()),
            failure: Some(self.failure),
            resolved_path: self.resolved_path.map(display),
            resolved_workspace_root: self.resolved_workspace_root.map(display),
            operation: self.operation.as_ref().map(|(op, _)| *op),
            operation_path: self.operation.map(|(_, at)| display(at)),
            message,
            cause: None,
        }
    }
}

pub fn display(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// Realpath of `path`, or of its nearest existing ancestor with the missing rest appended.
/// A dangling link is an error, never "missing". `exists` reports whether `path` itself exists.
fn realpath_allow_missing(path: &Path) -> io::Result<(PathBuf, bool)> {
    let mut candidate = path.to_owned();
    loop {
        match fs::canonicalize(&candidate) {
            Ok(real) => {
                let rest = path.strip_prefix(&candidate).unwrap_or(Path::new(""));
                let real = if rest.as_os_str().is_empty() {
                    real
                } else {
                    real.join(rest)
                };
                return Ok((real, candidate == path));
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
                if fs::symlink_metadata(&candidate).is_ok() {
                    return Err(error);
                }
                match candidate.parent() {
                    Some(parent) => candidate = parent.to_owned(),
                    None => return Err(error),
                }
            }
        }
    }
}

/// `projects.readFile`. A workspace-relative path stays inside the root, symlinks included. An
/// absolute or `~/` path reads that host file in place, as the TypeScript server does (the call
/// needs `filesystem:read`). The server's own state is never served.
pub fn read_file(
    input: &ProjectReadFileInput,
    home: Option<&Path>,
    internal: &InternalPaths,
) -> Result<ProjectReadFileResult, FileFailure> {
    let allow_missing = input.allow_missing == Some(true);
    let requested = input.relative_path.as_str();
    if paths::is_network_path(requested) {
        return Err(FileFailure::outside_root());
    }
    let host_path = if requested.starts_with("~/") {
        paths::expand_home(requested, home)
    } else {
        PathBuf::from(requested)
    };
    let absent = |relative_path: String| ProjectReadFileResult {
        relative_path,
        contents: String::new(),
        byte_length: 0,
        truncated: false,
        exists: Some(false),
    };

    let (relative_path, real_target) = if host_path.is_absolute() {
        match fs::canonicalize(&host_path) {
            Ok(real) => (requested.to_owned(), real),
            Err(e) if allow_missing && e.kind() == io::ErrorKind::NotFound => {
                return Ok(absent(requested.to_owned()));
            }
            Err(e) => {
                return Err(FileFailure::op(
                    Operation::RealpathTarget,
                    &host_path,
                    &host_path,
                    e,
                ));
            }
        }
    } else {
        let cwd = paths::resolve_cwd(&input.cwd, None);
        let (target, relative) =
            paths::resolve_within_root(&cwd, requested).ok_or_else(FileFailure::outside_root)?;
        let real_root = fs::canonicalize(&cwd)
            .map_err(|e| FileFailure::op(Operation::RealpathWorkspaceRoot, &target, &cwd, e))?;
        let (real, exists) = if allow_missing {
            realpath_allow_missing(&target)
        } else {
            fs::canonicalize(&target).map(|real| (real, true))
        }
        .map_err(|e| FileFailure::op(Operation::RealpathTarget, &target, &target, e))?;
        if !paths::is_within(&real, &real_root) || real == real_root {
            return Err(FileFailure::escape(&real_root, &real));
        }
        if !exists {
            return Ok(absent(relative));
        }
        (relative, real)
    };
    if internal.contains(&real_target) {
        return Err(FileFailure::outside_root());
    }

    let mut file = match open_nonblocking(&real_target) {
        Ok(file) => file,
        Err(e) if allow_missing && e.kind() == io::ErrorKind::NotFound => {
            return Ok(absent(relative_path));
        }
        Err(e) => {
            return Err(FileFailure::op(
                Operation::Open,
                &real_target,
                &real_target,
                e,
            ));
        }
    };
    let meta = file
        .metadata()
        .map_err(|e| FileFailure::op(Operation::Stat, &real_target, &real_target, e))?;
    if !meta.is_file() {
        return Err(FileFailure::plain(Failure::PathNotFile, Some(&real_target)));
    }
    let size = meta.len();
    let mut bytes = Vec::with_capacity(size.min(READ_FILE_MAX_BYTES) as usize);
    (&mut file)
        .take(READ_FILE_MAX_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| FileFailure::op(Operation::Read, &real_target, &real_target, e))?;
    if bytes.contains(&0) {
        return Err(FileFailure::plain(Failure::BinaryFile, Some(&real_target)));
    }
    let truncated = size > READ_FILE_MAX_BYTES;
    if truncated {
        // A streaming decoder drops a character the byte limit split.
        let valid = match std::str::from_utf8(&bytes) {
            Ok(_) => bytes.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => bytes.len(),
        };
        bytes.truncate(valid);
    }
    Ok(ProjectReadFileResult {
        relative_path,
        contents: String::from_utf8_lossy(&bytes).into_owned(),
        byte_length: size as i64,
        truncated,
        exists: None,
    })
}

/// `projects.writeFile`, inside a known workspace only (`known` decides; see
/// [`crate::KnownWorkspaces`]). Existing ancestors are resolved, so creation cannot follow a link
/// out of the root; Git folders are refused; the final open does not follow a swapped-in link.
pub fn write_file(
    input: &ProjectWriteFileInput,
    known: &dyn Fn(&Path) -> bool,
) -> Result<ProjectWriteFileResult, FileFailure> {
    let cwd = paths::resolve_cwd(&input.cwd, None);
    match fs::canonicalize(&cwd) {
        Ok(real_cwd) if known(&real_cwd) => {}
        _ => return Err(FileFailure::outside_root()),
    }
    let (target, relative) = paths::resolve_within_root(&cwd, &input.relative_path)
        .ok_or_else(FileFailure::outside_root)?;
    let real_root = fs::canonicalize(&cwd)
        .map_err(|e| FileFailure::op(Operation::RealpathWorkspaceRoot, &target, &cwd, e))?;
    let segments: Vec<_> = target
        .strip_prefix(paths::normalize(&cwd))
        .unwrap_or(Path::new(""))
        .components()
        .map(|c| c.as_os_str().to_owned())
        .collect();
    let named: PathBuf = std::iter::once(real_root.as_os_str().to_owned())
        .chain(segments.iter().cloned())
        .collect();
    let mut real_target = named.clone();
    for depth in (1..=segments.len()).rev() {
        let candidate: PathBuf = std::iter::once(real_root.as_os_str().to_owned())
            .chain(segments[..depth].iter().cloned())
            .collect();
        match fs::canonicalize(&candidate) {
            Ok(real) => {
                real_target = segments[depth..].iter().fold(real, |p, s| p.join(s));
                break;
            }
            Err(e)
                if e.kind() == io::ErrorKind::NotFound
                    && fs::symlink_metadata(&candidate).is_err() => {}
            Err(e) => {
                return Err(FileFailure::op(
                    Operation::RealpathTarget,
                    &target,
                    &target,
                    e,
                ));
            }
        }
    }
    let in_git = |p: &Path| {
        paths::in_git_folder(p).map_err(|e| FileFailure::op(Operation::Stat, &real_target, p, e))
    };
    if !paths::is_within(&real_target, &real_root)
        || real_target == real_root
        || in_git(&real_target)?
        || in_git(&named)?
    {
        return Err(FileFailure::escape(&real_root, &real_target));
    }
    if let Some(parent) = real_target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| FileFailure::op(Operation::MakeDirectory, &real_target, parent, e))?;
    }
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.custom_flags(flags::O_NOFOLLOW);
    options
        .open(&real_target)
        .and_then(|mut f| f.write_all(input.contents.as_bytes()))
        .map_err(|e| FileFailure::op(Operation::WriteFile, &real_target, &real_target, e))?;
    Ok(ProjectWriteFileResult {
        relative_path: relative,
    })
}

/// `filesystem.getMetadata`: absolute host paths (or `~/`), in request order; `None` for a
/// missing, unreadable, relative, network or server-internal path.
pub fn get_metadata(
    requested: &[String],
    home: Option<&Path>,
    internal: &InternalPaths,
) -> FilesystemGetMetadataResult {
    let mut cache: HashMap<&str, Option<FilesystemEntryMetadata>> = HashMap::new();
    let entries = requested
        .iter()
        .map(|path| {
            cache
                .entry(path.as_str())
                .or_insert_with(|| metadata_for(path, home, internal))
                .clone()
        })
        .collect();
    FilesystemGetMetadataResult { entries }
}

fn metadata_for(
    requested: &str,
    home: Option<&Path>,
    internal: &InternalPaths,
) -> Option<FilesystemEntryMetadata> {
    let path = paths::expand_home(requested, home);
    if !path.is_absolute() || paths::is_network_path(requested) {
        return None;
    }
    let meta = fs::metadata(&path).ok()?;
    let real = fs::canonicalize(&path).unwrap_or_else(|_| paths::normalize(&path));
    if internal.contains(&real) {
        return None;
    }
    let kind = |kind| {
        Some(FilesystemEntryMetadata {
            kind,
            byte_length: None,
            mime_type: None,
        })
    };
    if meta.is_dir() {
        return kind(FilesystemEntryMetadataKind::Directory);
    }
    if !meta.is_file() {
        return kind(FilesystemEntryMetadataKind::Other);
    }
    let mut mime_type = None;
    if paths::extension(requested).is_empty() && meta.len() > 0 {
        mime_type = open_nonblocking(&path).ok().and_then(|mut file| {
            if !file.metadata().ok()?.is_file() {
                return None;
            }
            let mut header = [0u8; 512];
            let n = file.read(&mut header).ok()?;
            mime::sniff(&header[..n]).map(str::to_owned)
        });
    }
    Some(FilesystemEntryMetadata {
        kind: FilesystemEntryMetadataKind::File,
        byte_length: Some(meta.len() as i64),
        mime_type,
    })
}

/// `filesystem.browse`: folders whose name starts with the last segment of `partialPath`, for
/// the "add project" path picker. Absolute and `~` paths browse the host; `./x` needs `cwd`.
pub fn browse(
    input: &FilesystemBrowseInput,
    home: Option<&Path>,
) -> Result<FilesystemBrowseResult, Box<FilesystemBrowseError2>> {
    let partial = input.partial_path.as_str();
    let error = |failure, parent: Option<&Path>, missing: bool, platform: Option<&str>| {
        let cwd = input
            .cwd
            .as_deref()
            .map(|c| format!(" from '{c}'"))
            .unwrap_or_default();
        Box::new(FilesystemBrowseError2 {
            tag: lit::FilesystemBrowseError,
            partial_path: Some(partial.to_owned()),
            cwd: input.cwd.clone(),
            failure: Some(failure),
            parent_path: parent.map(|p| display(p.to_owned())),
            platform: platform.map(str::to_owned),
            path_missing: missing.then_some(true),
            message: format!("Failed to browse filesystem path '{partial}'{cwd}."),
            cause: None,
        })
    };
    if paths::is_windows_absolute(partial) {
        return Err(error(
            FilesystemBrowseError2Failure::WindowsPathUnsupported,
            None,
            false,
            Some(std::env::consts::OS),
        ));
    }
    let resolved = if !paths::is_explicit_relative(partial) {
        paths::resolve(Path::new("/"), &paths::expand_home(partial, home))
    } else {
        let Some(cwd) = input.cwd.as_deref() else {
            return Err(error(
                FilesystemBrowseError2Failure::CurrentProjectRequired,
                None,
                false,
                None,
            ));
        };
        paths::resolve(&paths::resolve_cwd(cwd, home), Path::new(partial))
    };
    let ends_with_separator = partial.ends_with('/') || partial.ends_with('\\') || partial == "~";
    let (parent, prefix) = if ends_with_separator {
        (resolved, String::new())
    } else {
        (
            resolved.parent().map_or(resolved.clone(), Path::to_owned),
            paths::file_name(&resolved),
        )
    };
    let read = match fs::read_dir(&parent) {
        Ok(read) => Some(read),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => None,
        Err(e) => {
            return Err(error(
                FilesystemBrowseError2Failure::ReadDirectoryFailed,
                Some(&parent),
                e.kind() == io::ErrorKind::NotFound,
                None,
            ));
        }
    };
    let show_hidden = ends_with_separator || prefix.starts_with('.');
    let lower_prefix = prefix.to_lowercase();
    let mut entries: Vec<FilesystemBrowseEntry> = read
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.to_lowercase().starts_with(&lower_prefix)
                && (show_hidden || !name.starts_with('.')))
            .then(|| FilesystemBrowseEntry {
                full_path: display(parent.join(&name)),
                name,
            })
        })
        .collect();
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(FilesystemBrowseResult {
        parent_path: display(parent),
        entries,
    })
}
