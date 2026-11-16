//! T3's pinned Chrome release: lazy, streamed, verified, atomically installed.
use crate::Error;
use serde::Deserialize;
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

#[derive(Debug, Deserialize)]
pub(crate) struct Spec {
    pub scripts: Scripts,
    #[serde(rename = "viewportLimits")]
    pub viewport_limits: serde_json::Value,
    #[serde(rename = "editingCommands")]
    pub editing_commands: std::collections::HashMap<String, serde_json::Value>,
    #[serde(rename = "errorTemplates")]
    pub error_templates: std::collections::HashMap<String, String>,
    #[serde(rename = "nonWebSchemes")]
    pub non_web_schemes: Vec<String>,
    pub keys: std::collections::HashMap<String, serde_json::Value>,
    pub version: String,
    pub profiles: Vec<serde_json::Value>,
    pub presets: Vec<serde_json::Value>,
    pub archives: std::collections::HashMap<String, Archive>,
    #[serde(rename = "tabArgs")]
    pub tab_args: Vec<String>,
    #[serde(rename = "persistentArgs")]
    pub persistent_args: Vec<String>,
    pub html: HtmlSpec,
    #[serde(rename = "rootError")]
    pub root_error: String,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Scripts {
    pub snapshot: String,
    pub sensitive: String,
    pub dotted: String,
    pub mask: String,
    pub recorders: std::collections::HashMap<String, String>,
}
#[derive(Debug, Deserialize)]
pub(crate) struct HtmlSpec {
    #[serde(rename = "fakeIpTemplate")]
    pub fake_ip_template: String,
    #[serde(rename = "defaultWidth")]
    pub default_width: u64,
    pub fragments: std::collections::HashMap<String, String>,
    pub settle: String,
    pub measure: String,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Archive {
    bytes: u64,
    sha256: String,
}

pub(crate) fn spec() -> Result<Spec, Error> {
    serde_json::from_str(include_str!("spec.json")).map_err(super::err)
}

type Completed = Option<Result<PathBuf, Error>>;
/// One installation per server. No browser or network connection exists until requested.
#[derive(Debug)]
pub struct Installer {
    base: PathBuf,
    pending: Mutex<Option<watch::Receiver<Completed>>>,
    downloaded: Arc<AtomicU64>,
    unpacking: Arc<AtomicBool>,
}
impl Installer {
    pub fn new(base: PathBuf) -> Self {
        Self {
            base,
            pending: Mutex::new(None),
            downloaded: Arc::default(),
            unpacking: Arc::default(),
        }
    }
    /// The same base/tools/platform/version path as T3; never discovers system Chrome.
    pub async fn executable(&self) -> Result<PathBuf, Error> {
        let spec = spec()?;
        let platform = match std::env::consts::ARCH {
            "x86_64" => "linux64",
            "aarch64" => "linux-arm64",
            arch => {
                return Err(Error(format!(
                    "T3's headless browser is not available on linux-{arch}: Chrome for Testing has no headless shell for it."
                )));
            }
        };
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
        let mut pending = if let Some(pending) = guard.as_ref() {
            let finished = pending.borrow().clone();
            if let Some(result) = finished {
                *guard = None;
                return result;
            }
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

fn failure(detail: &str) -> Error {
    Error(format!(
        "T3 could not install its headless browser: {detail} Try again."
    ))
}

async fn install(
    folder: PathBuf,
    platform: &str,
    spec: Spec,
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
    if std::env::var_os("CONN_NETWORK_LOG").is_some() {
        return Err(failed());
    }
    let tcp = tokio::net::TcpStream::connect(("storage.googleapis.com", 443))
        .await
        .map_err(|_| failed())?;
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let name =
        rustls::pki_types::ServerName::try_from("storage.googleapis.com").map_err(super::err)?;
    let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
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
    if zip.len() > 256 {
        return Err(failure(
            "The archive contains an unexpected or unsafe entry.",
        ));
    }
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(super::err)?;
        let relative = entry
            .enclosed_name()
            .and_then(|p| p.strip_prefix(&prefix).ok().map(Path::to_path_buf))
            .ok_or_else(|| failure("The archive contains an unexpected or unsafe entry."))?;
        let mode = entry.unix_mode().unwrap_or_default();
        if !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) || entry.encrypted() {
            return Err(failure(
                "The archive contains an unexpected or unsafe entry.",
            ));
        }
        total = total.saturating_add(entry.size());
        if total > 512 * 1024 * 1024 {
            return Err(failure(
                "The archive contains an unexpected or unsafe entry.",
            ));
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
    #[tokio::test]
    async fn finds_only_the_pinned_install_without_download_or_host_discovery() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("conn-preview-install-{}", conn_support::uuid_v4()));
        let path = root
            .join("tools/chrome-headless-shell/linux64")
            .join(spec().unwrap().version)
            .join("chrome-headless-shell");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "fixture browser").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            Installer::new(root.clone()).executable().await.unwrap(),
            path
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
