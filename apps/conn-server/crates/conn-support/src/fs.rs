//! A file write that readers never see half done.

use std::{
    fs, io,
    io::Write,
    path::{Path, PathBuf},
};

/// Writes `bytes` through a temp file next to `path`, then renames it into place, so readers
/// never see half a file. Creates the parent folder. On Unix the file gets `mode`.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    write_atomic_to(&tmp, path, bytes, mode)
}

/// Writes `bytes` to `tmp` with `mode`, syncs, and renames it to `path`. The caller picks a
/// temp name no other writer uses, in the same folder.
pub fn write_atomic_to(tmp: &Path, path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(tmp)?;
    // `mode` applies only to a new file, under the umask; set it on the open file as well.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(tmp, path)
}

/// [`write_atomic`] with a file only the owner can read (0600).
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(path, bytes, 0o600)
}

/// The file a chain of symlinks at `path` ends in (`resolveSymlinkTarget`,
/// `packages/shared/src/symlink.ts`), so an atomic rename replaces the target and keeps the
/// link. A relative link resolves from the folder the link really lives in. The target may not
/// exist yet. Fails on a cycle or a chain longer than 40 links.
pub fn resolve_symlink_target(path: &Path) -> io::Result<PathBuf> {
    const MAX_HOPS: usize = 40;
    let mut current = std::path::absolute(path)?;
    for _ in 0..=MAX_HOPS {
        let link = match fs::read_link(&current) {
            Ok(link) => link,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::InvalidInput =>
            {
                return Ok(current);
            }
            Err(error) => return Err(error),
        };
        let Some(dir) = current.parent() else {
            return Ok(current);
        };
        let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned());
        current = dir.join(link);
    }
    Err(io::Error::other("too many levels of symbolic links"))
}

#[cfg(test)]
mod tests {
    use super::{resolve_symlink_target, write_atomic, write_private};
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn resolves_relative_absolute_and_dangling_links() {
        let dir = std::env::temp_dir().join(format!("conn-support-link-{}", std::process::id()));
        let real = fs::canonicalize({
            fs::create_dir_all(dir.join("dotfiles")).expect("folders");
            &dir
        })
        .expect("real dir");
        let target = real.join("dotfiles/file.json");
        std::os::unix::fs::symlink("dotfiles/file.json", dir.join("relative")).expect("link");
        std::os::unix::fs::symlink(dir.join("relative"), dir.join("chain")).expect("link");
        assert_eq!(
            resolve_symlink_target(&dir.join("relative")).expect("relative"),
            target
        );
        assert_eq!(
            resolve_symlink_target(&dir.join("chain")).expect("chain"),
            target
        );
        assert_eq!(
            resolve_symlink_target(&dir.join("plain.json")).expect("no link"),
            dir.join("plain.json")
        );
        std::os::unix::fs::symlink("loop", dir.join("loop")).expect("link");
        assert!(resolve_symlink_target(&dir.join("loop")).is_err());
        fs::remove_dir_all(dir).expect("clean up");
    }

    #[test]
    fn replaces_the_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("conn-support-fs-{}", std::process::id()));
        let path = dir.join("nested").join("state.json");
        write_atomic(&path, b"one", 0o644).expect("first write");
        write_atomic(&path, b"two", 0o644).expect("second write");
        assert_eq!(fs::read(&path).expect("read"), b"two");
        let names: Vec<_> = fs::read_dir(path.parent().expect("parent"))
            .expect("list")
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert_eq!(names.len(), 1, "only the file itself: {names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            write_private(&path, b"secret").expect("private write");
            let mode = fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "owner only");
        }
        fs::remove_dir_all(dir).expect("clean up");
    }
}
