//! T3's pinned Chrome release: lazy, streamed, verified, atomically installed.
use crate::Error;
use crate::spec::{Archive, Spec, spec};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, watch};

fn chrome_platform(os: &str, arch: &str) -> Result<&'static str, Error> {
    spec()?.platforms.get(&format!("{os}-{arch}")).map(String::as_str).ok_or_else(|| Error(format!(
        "T3's headless browser is not available on {os}-{arch}: Chrome for Testing has no headless shell for it."
    )))
}

fn prune(root: &Path, version: &str) {
    let Ok(spec) = spec() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let previous = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name != version && !name.starts_with('.'))
        .max_by_key(|name| {
            name.split('.')
                .filter_map(|n| n.parse::<u64>().ok())
                .collect::<Vec<_>>()
        });
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == version || Some(name.as_ref()) == previous.as_deref() {
            continue;
        }
        if name.starts_with(".install-")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .is_none_or(|modified| {
                    modified.elapsed().unwrap_or_default()
                        < Duration::from_millis(spec.staging_stale_after_ms)
                })
        {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// A configured browser never falls through to the development installer.
#[derive(Debug, Clone, thiserror::Error)]
pub enum ExecutableError {
    #[error("Configured browser {}: {reason}. No runtime download will be attempted.", path.display())]
    ConfiguredBrowser { path: PathBuf, reason: String },
    #[error(transparent)]
    Install(#[from] Error),
}
impl From<ExecutableError> for Error {
    fn from(error: ExecutableError) -> Self {
        Self(error.to_string())
    }
}

type Completed = Option<Result<PathBuf, Error>>;
/// One installation per server. No browser or network connection exists until requested.
#[derive(Debug)]
pub struct Installer {
    base: PathBuf,
    browser_path: Option<PathBuf>,
    pending: Mutex<Option<watch::Receiver<Completed>>>,
    downloaded: Arc<AtomicU64>,
    unpacking: Arc<AtomicBool>,
}
impl Installer {
    pub fn new(base: PathBuf) -> Self {
        // Orbit supplies a shared browser; T3 has no host path override.
        Self::with_browser_path(
            base,
            std::env::var_os("CONN_SERVER_BROWSER_PATH").map(PathBuf::from),
        )
    }
    fn with_browser_path(base: PathBuf, browser_path: Option<PathBuf>) -> Self {
        Self {
            base,
            browser_path,
            pending: Mutex::new(None),
            downloaded: Arc::default(),
            unpacking: Arc::default(),
        }
    }
    /// Prefers the configured pinned browser; otherwise uses T3's lazy cache, never PATH.
    pub async fn executable(&self) -> Result<PathBuf, ExecutableError> {
        if let Some(path) = &self.browser_path {
            return configured_browser(path.clone()).await;
        }
        self.development_executable()
            .await
            .map_err(ExecutableError::Install)
    }
    async fn development_executable(&self) -> Result<PathBuf, Error> {
        let spec = spec()?;
        let platform = chrome_platform(std::env::consts::OS, std::env::consts::ARCH)?;
        let folder = self
            .base
            .join("tools/chrome-headless-shell")
            .join(platform)
            .join(&spec.version);
        let executable = folder.join("chrome-headless-shell");
        let path = executable.clone();
        if tokio::task::spawn_blocking(move || {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
        .await
        .map_err(super::err)?
        {
            return Ok(executable);
        }
        let total = spec
            .archives
            .get(platform)
            .ok_or_else(|| Error("The pinned Chrome archive is missing.".into()))?
            .bytes;
        let mut guard = self.pending.lock().await;
        let completed = guard.as_ref().and_then(|pending| pending.borrow().clone());
        if let Some(result) = completed {
            *guard = None;
            if result.is_ok() {
                return result;
            }
            // A new caller retries; T3 replays the previous failure once before retrying.
        }
        let mut pending = if let Some(pending) = guard.as_ref() {
            pending.clone()
        } else {
            let (tx, rx) = watch::channel(None);
            self.downloaded.store(0, Ordering::Relaxed);
            self.unpacking.store(false, Ordering::Relaxed);
            let downloaded = self.downloaded.clone();
            let unpacking = self.unpacking.clone();
            let platform = platform.to_owned();
            tokio::spawn(async move {
                let result = install(folder, &platform, spec, downloaded, unpacking).await;
                let _ = tx.send(Some(result));
            });
            *guard = Some(rx.clone());
            rx
        };
        drop(guard);
        let result = tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Some(result) = pending.borrow().as_ref() {
                    return result.clone();
                }
                pending.changed().await.map_err(super::err)?;
            }
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                let progress = if self.unpacking.load(Ordering::Relaxed) {
                    "unpacking".into()
                } else {
                    format!(
                        "{} of {} MB downloaded",
                        (self.downloaded.load(Ordering::Relaxed) + 500_000) / 1_000_000,
                        (total + 500_000) / 1_000_000
                    )
                };
                Err(Error(format!(
                    "T3 is installing its headless browser ({progress}). Try again in a minute."
                )))
            }
        }
    }
}

async fn configured_browser(path: PathBuf) -> Result<PathBuf, ExecutableError> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncReadExt;
    let fail = |reason: String| ExecutableError::ConfiguredBrowser {
        path: path.clone(),
        reason,
    };
    if !path.is_absolute() {
        return Err(fail("the path must be absolute".into()));
    }
    let info = tokio::fs::metadata(&path)
        .await
        .map_err(|error| fail(format!("cannot read the executable: {error}")))?;
    if !info.is_file() || info.permissions().mode() & 0o111 == 0 {
        return Err(fail("the path is not an executable file".into()));
    }
    let mut command = tokio::process::Command::new(&path);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = tokio::task::spawn_blocking(move || command.spawn())
        .await
        .map_err(|error| fail(error.to_string()))?
        .map_err(|error| fail(format!("cannot start --version: {error}")))?;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| fail("the version pipe is missing".into()))?;
        let mut bytes = Vec::new();
        stdout
            .take(1025)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| fail(error.to_string()))?;
        let status = child
            .wait()
            .await
            .map_err(|error| fail(error.to_string()))?;
        Ok::<_, ExecutableError>((status, bytes))
    })
    .await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    let (status, bytes) = result.map_err(|_| fail("the --version probe timed out".into()))??;
    if !status.success() || bytes.len() > 1024 {
        return Err(fail(
            "--version failed; check the executable and its shared libraries".into(),
        ));
    }
    let version = &spec()?.version;
    let reported = String::from_utf8_lossy(&bytes);
    if reported.split_whitespace().last() != Some(version.as_str()) {
        return Err(fail(format!(
            "expected chrome-headless-shell {version}, got {:?}",
            reported.trim()
        )));
    }
    Ok(path)
}

fn failure(detail: &str) -> Error {
    Error(format!(
        "T3 could not install its headless browser: {detail} Try again."
    ))
}

async fn install(
    folder: PathBuf,
    platform: &str,
    spec: &'static Spec,
    progress: Arc<AtomicU64>,
    unpacking: Arc<AtomicBool>,
) -> Result<PathBuf, Error> {
    let parent = folder
        .parent()
        .ok_or_else(|| failure("Could not save the browser in T3's home directory."))?;
    let staging = parent.join(format!(".install-{}", conn_support::uuid_v4()));
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|_| failure("Could not save the browser in T3's home directory."))?;
    let zip_path = staging.join("download.zip");
    let result = async {
        let archive = spec.archives.get(platform).ok_or_else(|| failure("The archive is missing."))?;
        let path = format!("/chrome-for-testing-public/{}/{platform}/chrome-headless-shell-{platform}.zip", spec.version);
        tokio::time::timeout(Duration::from_secs(15*60), download(&path, &zip_path, archive, &progress)).await.map_err(|_| failure("The download from storage.googleapis.com failed. Check this machine's network access."))??;
        unpacking.store(true, Ordering::Relaxed);
        let output = staging.join("browser");
        let destination = folder.clone();
        let platform = platform.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), Error> {
            extract(&zip_path, &output, &platform)?;
            if destination.exists() { std::fs::remove_dir_all(&destination).map_err(super::err)?; }
            std::fs::rename(output, destination).map_err(super::err)
        }).await.map_err(super::err)??;
        let root = parent.to_path_buf();
        tokio::task::spawn_blocking(move || prune(&root, &spec.version)).await.map_err(super::err)?;
        Ok(folder.join("chrome-headless-shell"))
    }.await;
    let _ = tokio::fs::remove_dir_all(staging).await;
    result
}

async fn download(
    path: &str,
    target: &Path,
    archive: &Archive,
    progress: &AtomicU64,
) -> Result<(), Error> {
    use http_body_util::{BodyExt, Empty};
    use hyper::{Request, body::Bytes};
    use hyper_util::rt::TokioIo;
    use tokio::io::AsyncWriteExt;
    let failed = || {
        failure(
            "The download from storage.googleapis.com failed. Check this machine's network access.",
        )
    };
    if cfg!(test) || std::env::var_os("CONN_NETWORK_LOG").is_some() {
        return Err(failed());
    }
    let tcp = tokio::net::TcpStream::connect(("storage.googleapis.com", 443))
        .await
        .map_err(|_| failed())?;
    let config = conn_support::tls::client_config().map_err(super::err)?;
    let name =
        rustls::pki_types::ServerName::try_from("storage.googleapis.com").map_err(super::err)?;
    let tls = tokio_rustls::TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|_| failed())?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .map_err(|_| failed())?;
    let connection = tokio::spawn(async move {
        let _ = connection.await;
    });
    let result = async {
        let request = Request::builder()
            .uri(path)
            .header("host", "storage.googleapis.com")
            .header("connection", "close")
            .body(Empty::<Bytes>::new())
            .map_err(super::err)?;
        let response = sender.send_request(request).await.map_err(|_| failed())?;
        if !response.status().is_success() {
            return Err(failed());
        }
        if let Some(bytes) = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            && bytes != archive.bytes
        {
            return Err(failure(
                "The download size did not match the pinned release.",
            ));
        }
        let mut body = response.into_body();
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .await
            .map_err(super::err)?;
        let mut hash = Sha256::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| failed())?;
            if let Ok(data) = frame.into_data() {
                let bytes =
                    progress.fetch_add(data.len() as u64, Ordering::Relaxed) + data.len() as u64;
                if bytes > archive.bytes {
                    return Err(failure("The download was larger than the pinned release."));
                }
                hash.update(&data);
                file.write_all(&data).await.map_err(super::err)?;
            }
        }
        if progress.load(Ordering::Relaxed) != archive.bytes
            || conn_support::hex::hex(&hash.finalize()) != archive.sha256
        {
            return Err(failure(
                "The download failed its size or SHA-256 check. Nothing was installed.",
            ));
        }
        file.flush().await.map_err(super::err)
    }
    .await;
    connection.abort();
    result
}

fn extract(zip_path: &Path, output: &Path, platform: &str) -> Result<(), Error> {
    let file = std::fs::File::open(zip_path).map_err(super::err)?;
    let mut zip = zip::ZipArchive::new(file).map_err(super::err)?;
    let prefix = format!("chrome-headless-shell-{platform}/");
    let mut executable = false;
    let mut total = 0u64;
    let unsafe_entry = || failure("The archive contains an unexpected or unsafe entry.");
    if zip.len() > 256 {
        return Err(unsafe_entry());
    }
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(super::err)?;
        let relative = entry
            .enclosed_name()
            .and_then(|p| p.strip_prefix(&prefix).ok().map(Path::to_path_buf))
            .ok_or_else(unsafe_entry)?;
        let mode = entry.unix_mode().unwrap_or_default();
        if !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) || entry.encrypted() {
            return Err(unsafe_entry());
        }
        total = total.saturating_add(entry.size());
        if total > 512 * 1024 * 1024 {
            return Err(unsafe_entry());
        }
        let path = output.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(path).map_err(super::err)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(super::err)?;
        }
        let mut dest = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(super::err)?;
        use std::io::Read;
        let size = entry.size();
        let written = std::io::copy(&mut entry.take(size.saturating_add(1)), &mut dest)
            .map_err(super::err)?;
        if written != size {
            return Err(failure("The archive entry exceeded its expected size."));
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o777))
            .map_err(super::err)?;
        if relative == Path::new("chrome-headless-shell") {
            executable = true;
        }
    }
    if !executable {
        return Err(failure(
            "The archive does not contain chrome-headless-shell.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn installed_fixture(root: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = root
            .join("tools/chrome-headless-shell")
            .join(chrome_platform(std::env::consts::OS, std::env::consts::ARCH).unwrap())
            .join(&spec().unwrap().version)
            .join("chrome-headless-shell");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "fixture browser").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    fn version_fixture(path: &Path, version: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(
            path,
            format!("#!/bin/sh\nprintf '%s\\n' 'Google Chrome for Testing {version}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[tokio::test]
    async fn configured_browser_precedes_the_development_cache() {
        let root = std::env::temp_dir().join(format!(
            "conn-preview-configured-{}",
            conn_support::uuid_v4()
        ));
        installed_fixture(&root);
        let browser = root.join("shared browser");
        version_fixture(&browser, &spec().unwrap().version);
        let installer = Installer::with_browser_path(root.clone(), Some(browser.clone()));
        assert_eq!(installer.executable().await.unwrap(), browser);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn configured_browser_errors_are_typed_and_never_use_a_cached_or_downloaded_browser() {
        let root = std::env::temp_dir().join(format!(
            "conn-preview-config-error-{}",
            conn_support::uuid_v4()
        ));
        let cached = installed_fixture(&root);
        let wrong = root.join("wrong-version");
        version_fixture(&wrong, "1.2.3.4");
        for browser in [root.join("missing"), wrong] {
            let installer = Installer::with_browser_path(root.clone(), Some(browser.clone()));
            let error = installer.executable().await.unwrap_err();
            assert!(
                matches!(&error, ExecutableError::ConfiguredBrowser { path, .. } if path == &browser)
            );
            assert!(error.to_string().contains("No runtime download"));
            assert!(installer.pending.lock().await.is_none());
        }
        tokio::fs::remove_dir_all(cached.parent().unwrap())
            .await
            .unwrap();
        let installer = Installer::with_browser_path(root.clone(), Some(root.join("missing")));
        assert!(matches!(
            installer.executable().await,
            Err(ExecutableError::ConfiguredBrowser { .. })
        ));
        assert!(
            !root
                .join("tools/chrome-headless-shell")
                .join(chrome_platform(std::env::consts::OS, std::env::consts::ARCH).unwrap())
                .join(&spec().unwrap().version)
                .exists()
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[test]
    fn archive_extraction_rejects_traversal_and_requires_the_pinned_executable() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-archive-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&root).unwrap();
        for (name, accepted) in [
            ("chrome-headless-shell-linux64/chrome-headless-shell", true),
            ("chrome-headless-shell-linux64/../../escape", false),
            ("chrome-headless-shell-linux64/other", false),
        ] {
            let archive = root.join("browser.zip");
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
            writer
                .start_file(
                    name,
                    zip::write::SimpleFileOptions::default().unix_permissions(0o755),
                )
                .unwrap();
            writer.write_all(b"fixture browser").unwrap();
            writer.finish().unwrap();
            let output = root.join("output");
            assert_eq!(
                extract(&archive, &output, "linux64").is_ok(),
                accepted,
                "{name}"
            );
            assert!(!root.join("escape").exists());
            let _ = std::fs::remove_dir_all(output);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn platform_matches_t3_for_both_operating_systems_and_architectures() {
        for (os, arch, wanted) in [
            ("linux", "x86_64", "linux64"),
            ("linux", "aarch64", "linux-arm64"),
            ("macos", "x86_64", "mac-x64"),
            ("macos", "aarch64", "mac-arm64"),
        ] {
            assert_eq!(chrome_platform(os, arch).unwrap(), wanted);
        }
        assert!(chrome_platform("freebsd", "x86_64").is_err());
        assert!(chrome_platform("linux", "riscv64").is_err());
    }
    #[tokio::test]
    async fn failed_installs_allow_the_next_caller_to_retry() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-retry-{}", conn_support::uuid_v4()));
        let installer = Installer::new(root.clone());
        let (_tx, rx) = watch::channel(Some(Err(Error("previous failure".into()))));
        *installer.pending.lock().await = Some(rx);
        assert_ne!(
            installer.executable().await.unwrap_err().to_string(),
            "previous failure"
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }
    #[test]
    fn pruning_keeps_current_newest_previous_and_recent_staging() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-prune-{}", conn_support::uuid_v4()));
        for name in ["10", "9", "8", ".install-recent", ".install-stale"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let file = std::fs::File::open(root.join(".install-stale")).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::UNIX_EPOCH))
            .unwrap();
        prune(&root, "10");
        for name in ["10", "9", ".install-recent"] {
            assert!(root.join(name).exists());
        }
        for name in ["8", ".install-stale"] {
            assert!(!root.join(name).exists(), "{name}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn finds_only_the_pinned_install_without_download_or_host_discovery() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-install-{}", conn_support::uuid_v4()));
        let path = installed_fixture(&root);
        assert_eq!(
            Installer::new(root.clone()).executable().await.unwrap(),
            path
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
