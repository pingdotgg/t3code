//! The T3 server's secret store (`apps/server/src/auth/ServerSecretStore.ts`): one file per
//! secret, `<dir>/<name>.bin`, the folder 0700 and each file 0600. Either server reads what
//! the other wrote.
//!
//! Blocking file work: call it from a blocking thread. No function here logs, and no error
//! carries a secret's value; an error names the secret (names are not secret).

use std::{fs, io, path::Path, path::PathBuf};

/// Whether `name` can name a file in the store: the T3 server's names are fixed prefixes,
/// base64url parts and dashes, so anything else (a path separator, a dot) is refused.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn path(dir: &Path, name: &str) -> io::Result<PathBuf> {
    if valid_name(name) {
        Ok(dir.join(format!("{name}.bin")))
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a secret store name",
        ))
    }
}

/// Makes the folder and sets it to 0700, as the T3 store does when it starts.
pub fn ensure_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The secret's bytes, or `None` when there is no such file (`get`).
pub fn read(dir: &Path, name: &str) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path(dir, name)?) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Writes the secret through a temp file and a rename, 0600 (`set`).
pub fn write(dir: &Path, name: &str, value: &[u8]) -> io::Result<()> {
    ensure_dir(dir)?;
    let target = path(dir, name)?;
    // A name per write, as T3's `<name>.bin.<uuid>.tmp`, so two writers never share one.
    let tmp = dir.join(format!("{name}.bin.{}.tmp", crate::uuid_v4()));
    let result = crate::fs::write_atomic_to(&tmp, &target, value, 0o600);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Removes the secret; a missing file is not an error (`remove`).
pub fn remove(dir: &Path, name: &str) -> io::Result<()> {
    match fs::remove_file(path(dir, name)?) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("conn-secret-store-{tag}-{}", std::process::id()))
    }

    #[test]
    fn writes_reads_and_removes_with_private_modes() {
        let root = dir("rw");
        let store = root.join("secrets");
        assert_eq!(read(&store, "a-b_C").expect("read"), None);
        write(&store, "a-b_C", b"one").expect("write");
        write(&store, "a-b_C", b"two").expect("rewrite");
        assert_eq!(read(&store, "a-b_C").expect("read"), Some(b"two".to_vec()));
        let names: Vec<_> = fs::read_dir(&store)
            .expect("list")
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert_eq!(names, ["a-b_C.bin"], "no temp file stays");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).expect("metadata").permissions().mode() & 0o777;
            assert_eq!(mode(&store), 0o700);
            assert_eq!(mode(&store.join("a-b_C.bin")), 0o600);
        }
        remove(&store, "a-b_C").expect("remove");
        remove(&store, "a-b_C").expect("remove again");
        assert_eq!(read(&store, "a-b_C").expect("read"), None);
        fs::remove_dir_all(root).expect("clean up");
    }

    #[test]
    fn refuses_names_that_leave_the_folder() {
        let store = dir("names");
        for name in ["", "../x", "a/b", ".hidden", "a.b"] {
            assert!(write(&store, name, b"x").is_err(), "{name:?}");
            assert!(read(&store, name).is_err(), "{name:?}");
        }
        let _ = fs::remove_dir_all(store);
    }
}
