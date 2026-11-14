//! A [`ProviderHost`] that serves an agent's file callbacks inside a session's roots, as T3's
//! `AntigravityClientFiles.ts` does: every symlink resolved before the containment check, text
//! files of at most 8 MiB, UTF-8 without NUL bytes, ACP's 1-based `line` and `limit` in lines.
//! Terminals are not offered. Blocking file work runs on `spawn_blocking`.

use std::path::{Path, PathBuf};

use conn_provider::{BoxFuture, HostError, HostResult, ProviderHost, ReadTextFile, WriteTextFile};

/// `CLIENT_FILE_MAX_BYTES`.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// File callbacks limited to `roots`.
#[derive(Clone, Debug)]
pub struct RootedFiles {
    roots: Vec<PathBuf>,
}

impl RootedFiles {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        Self { roots }
    }
}

/// `resolveClientFilePath`: the real path, with links in every existing component resolved,
/// and refused when it is outside every root.
fn resolve(roots: &[PathBuf], request: &Path) -> HostResult<PathBuf> {
    let outside = || {
        HostError::InvalidParams(format!(
            "Path '{}' is outside the session workspace.",
            request.display()
        ))
    };
    if !request.is_absolute() {
        return Err(outside());
    }
    // Canonicalize the deepest existing ancestor, so a link above missing folders cannot escape.
    let mut candidate = request.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let real = loop {
        if let Ok(real) = std::fs::canonicalize(&candidate) {
            break missing
                .iter()
                .rev()
                .fold(real, |path, part| path.join(part));
        }
        // Walk up only past entries that do not exist, never a dangling link.
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return Err(outside());
        }
        let (Some(parent), Some(name)) = (candidate.parent(), candidate.file_name()) else {
            return Err(outside());
        };
        missing.push(name.to_owned());
        candidate = parent.to_path_buf();
    };
    let inside = roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        real.starts_with(&root)
    });
    if inside { Ok(real) } else { Err(outside()) }
}

fn read(roots: &[PathBuf], request: &ReadTextFile) -> HostResult<String> {
    let shown = request.path.display();
    let path = resolve(roots, &request.path)?;
    let info = std::fs::metadata(&path)
        .map_err(|_| HostError::ResourceNotFound(format!("File '{shown}' not found.")))?;
    if !info.is_file() || info.len() > MAX_BYTES {
        return Err(HostError::InvalidParams(format!(
            "File '{shown}' is not a readable text file under {MAX_BYTES} bytes."
        )));
    }
    let bytes = std::fs::read(&path)
        .map_err(|_| HostError::Internal(format!("Could not read '{shown}'.")))?;
    let text = String::from_utf8(bytes).map_err(|_| {
        HostError::InvalidParams(format!("File '{shown}' is not a UTF-8 text file."))
    })?;
    if text.contains('\0') {
        return Err(HostError::InvalidParams(format!(
            "File '{shown}' contains binary data."
        )));
    }
    if request.line.is_none() && request.limit.is_none() {
        return Ok(text);
    }
    let start = request.line.unwrap_or(1).saturating_sub(1) as usize;
    let lines = text.split('\n').skip(start);
    let lines: Vec<&str> = match request.limit {
        Some(limit) => lines.take(limit as usize).collect(),
        None => lines.collect(),
    };
    Ok(lines.join("\n"))
}

fn write(roots: &[PathBuf], request: &WriteTextFile) -> HostResult<()> {
    let path = resolve(roots, &request.path)?;
    std::fs::write(&path, &request.content)
        .map_err(|_| HostError::Internal(format!("Could not write '{}'.", request.path.display())))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(HostError::Internal(format!("file task failed: {e}"))))
}

impl ProviderHost for RootedFiles {
    fn read_text_file(&self, request: ReadTextFile) -> BoxFuture<'_, HostResult<String>> {
        let roots = self.roots.clone();
        Box::pin(blocking(move || read(&roots, &request)))
    }

    fn write_text_file(&self, request: WriteTextFile) -> BoxFuture<'_, HostResult<()>> {
        let roots = self.roots.clone();
        Box::pin(blocking(move || write(&roots, &request)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn dir(name: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("conn-host-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(path.join("root")).unwrap();
        Dir(std::fs::canonicalize(&path).unwrap())
    }

    fn read_req(path: PathBuf, line: Option<u32>, limit: Option<u32>) -> ReadTextFile {
        ReadTextFile { path, line, limit }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn files_stay_inside_the_roots() {
        let d = dir("roots");
        let root = d.0.join("root");
        std::fs::write(root.join("a.txt"), "one\ntwo\nthree").unwrap();
        std::fs::write(d.0.join("secret.txt"), "no").unwrap();
        std::os::unix::fs::symlink(d.0.join("secret.txt"), root.join("link.txt")).unwrap();
        let host = RootedFiles::new(vec![root.clone()]);

        assert_eq!(
            host.read_text_file(read_req(root.join("a.txt"), None, None))
                .await,
            Ok("one\ntwo\nthree".into())
        );
        assert_eq!(
            host.read_text_file(read_req(root.join("a.txt"), Some(2), Some(1)))
                .await,
            Ok("two".into())
        );
        // A link that leads out, `..`, and a relative path are refused.
        for path in [
            root.join("link.txt"),
            root.join("../secret.txt"),
            PathBuf::from("a.txt"),
        ] {
            let error = host.read_text_file(read_req(path, None, None)).await;
            assert!(
                matches!(error, Err(HostError::InvalidParams(_))),
                "{error:?}"
            );
        }
        assert!(matches!(
            host.read_text_file(read_req(root.join("missing.txt"), None, None))
                .await,
            Err(HostError::ResourceNotFound(_))
        ));
        std::fs::write(root.join("bin"), b"a\0b").unwrap();
        assert!(matches!(
            host.read_text_file(read_req(root.join("bin"), None, None))
                .await,
            Err(HostError::InvalidParams(_))
        ));

        host.write_text_file(WriteTextFile {
            path: root.join("new/b.txt"),
            content: "x".into(),
        })
        .await
        .expect_err("the parent folder does not exist");
        host.write_text_file(WriteTextFile {
            path: root.join("b.txt"),
            content: "written".into(),
        })
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("b.txt")).unwrap(),
            "written"
        );
        assert_eq!(
            host.create_terminal(conn_provider::CreateTerminal {
                command: "true".into(),
                args: vec![],
                env: vec![],
                cwd: None,
                output_byte_limit: None,
            })
            .await,
            Err(HostError::MethodNotFound)
        );
    }
}
