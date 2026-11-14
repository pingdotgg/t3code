//! A file write that readers never see half done.

use std::{fs, io, io::Write, path::Path};

/// Writes `bytes` through a temp file next to `path`, then renames it into place, so readers
/// never see half a file. Creates the parent folder. On Unix the file gets `mode`.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(tmp, path)
}

/// [`write_atomic`] with a file only the owner can read (0600).
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic(path, bytes, 0o600)
}

#[cfg(test)]
mod tests {
    use super::{write_atomic, write_private};
    use std::fs;

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
