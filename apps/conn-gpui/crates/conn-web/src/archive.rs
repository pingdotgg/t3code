//! Pinned CEF archive metadata, installation layout, cryptographic verification,
//! safe extraction, and macOS helper bundle staging.

use crate::WebError;
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Pinned CEF build version matching `cef = "=156.4.0"` (`156.4.0+156.0.26`).
pub(crate) const CEF_VERSION: &str = "156.0.26+g8ea0c73+chromium-156.0.8078.88";

/// Official CEF binary distribution CDN (Spotify).
pub(crate) const CEF_CDN: &str = "https://cef-builds.spotifycdn.com";

/// Environment variable overriding the root CEF install directory.
pub(crate) const CEF_DIR_ENV: &str = "CONN_GPUI_CEF_DIR";

/// Environment variable overriding the Chromium user profile directory.
pub(crate) const CEF_PROFILE_DIR_ENV: &str = "CONN_GPUI_CEF_PROFILE_DIR";

/// Framework directory name inside the CEF archive's `Release/` directory.
pub(crate) const FRAMEWORK_NAME: &str = "Chromium Embedded Framework.framework";

/// Pseudo-bundle directory wrapping the framework and helper `.app` bundles.
///
/// Using `.bundle` (not `.app`) keeps Finder/LaunchServices from offering it
/// as a launchable application while giving CEF a valid `main_bundle_path`.
pub(crate) const RUNTIME_BUNDLE_NAME: &str = "Conn Web.bundle";

/// Base name for CEF helper app bundles on macOS.
pub(crate) const HELPER_NAME: &str = "Conn Helper";

/// Five helper variants Chromium expects beside the framework on macOS.
pub(crate) const HELPER_KINDS: [(&str, &str); 5] = [
    ("", ""),
    (" (GPU)", ".gpu"),
    (" (Renderer)", ".renderer"),
    (" (Plugin)", ".plugin"),
    (" (Alerts)", ".alerts"),
];

/// Pinned minimal CEF archive for one platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Archive {
    pub(crate) platform: &'static str,
    pub(crate) file: &'static str,
    pub(crate) bytes: u64,
    pub(crate) sha1: &'static str,
    pub(crate) sha256: &'static str,
}

/// Pinned minimal macOS CEF archives (release framework, no samples/debug).
pub(crate) const ARCHIVES: &[Archive] = &[
    Archive {
        platform: "macosarm64",
        file: "cef_binary_156.0.26+g8ea0c73+chromium-156.0.8078.88_macosarm64_minimal.tar.bz2",
        bytes: 134_979_837,
        sha1: "ca4fafe7a9c52d9f28200bb8713971a9662b891c",
        sha256: "6d7936cdd55ef30cf351a6358b2d922becefe87b25a8a8870a2b9ff5af2d39f6",
    },
    Archive {
        platform: "macosx64",
        file: "cef_binary_156.0.26+g8ea0c73+chromium-156.0.8078.88_macosx64_minimal.tar.bz2",
        bytes: 141_699_633,
        sha1: "f0f47aa3cdefa7eea54f2e8c6e73c68b4db125f3",
        sha256: "28b343526664cacb8d855891ce112c62437684b4d9cbdc55fb5a6d7e5eac18fb",
    },
];

impl Archive {
    /// Download URL on the official CEF CDN (`+` percent-encoded as `%2B`).
    pub(crate) fn url(&self) -> String {
        format!("{CEF_CDN}/{}", self.file.replace('+', "%2B"))
    }

    pub(crate) fn pin(&self) -> Pin {
        Pin {
            bytes: self.bytes,
            sha1: self.sha1.to_owned(),
            sha256: self.sha256.to_owned(),
            top: self.file.trim_end_matches(".tar.bz2").to_owned(),
        }
    }
}

/// Returns the CEF CDN platform identifier for the current compile target.
pub(crate) fn current_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macosarm64"),
        ("macos", "x86_64") => Some("macosx64"),
        _ => None,
    }
}

/// Returns the pinned archive for the current platform, if supported.
pub(crate) fn current_archive() -> Option<&'static Archive> {
    let platform = current_platform()?;
    ARCHIVES.iter().find(|archive| archive.platform == platform)
}

/// Expected size, digests, and top-level directory for an archive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Pin {
    pub(crate) bytes: u64,
    pub(crate) sha1: String,
    pub(crate) sha256: String,
    pub(crate) top: String,
}

/// On-disk layout for the CEF runtime installation.
///
/// Default root: `~/Library/Application Support/conn-gpui/cef`, overridden by
/// `CONN_GPUI_CEF_DIR`. Versioned files live under `<root>/<CEF_VERSION>/`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Layout {
    pub(crate) root: PathBuf,
}

impl Layout {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Resolves the root CEF directory from `CONN_GPUI_CEF_DIR` or
    /// `~/Library/Application Support/conn-gpui/cef`.
    pub(crate) fn default_root() -> Result<PathBuf, WebError> {
        if let Some(dir) = std::env::var_os(CEF_DIR_ENV).filter(|d| !d.is_empty()) {
            return Ok(PathBuf::from(dir));
        }
        let home = std::env::var_os("HOME")
            .filter(|d| !d.is_empty())
            .ok_or_else(|| WebError::Runtime("HOME environment variable is not set".into()))?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("conn-gpui")
            .join("cef"))
    }

    pub(crate) fn version_dir(&self) -> PathBuf {
        self.root.join(CEF_VERSION)
    }

    fn partial_dir(&self) -> PathBuf {
        self.root.join(format!("{CEF_VERSION}.partial"))
    }

    pub(crate) fn runtime_bundle(&self) -> PathBuf {
        self.version_dir().join(RUNTIME_BUNDLE_NAME)
    }

    fn frameworks_in(dir: &Path) -> PathBuf {
        dir.join(RUNTIME_BUNDLE_NAME)
            .join("Contents")
            .join("Frameworks")
    }

    pub(crate) fn framework(&self) -> PathBuf {
        Self::frameworks_in(&self.version_dir()).join(FRAMEWORK_NAME)
    }

    pub(crate) fn framework_binary(&self) -> PathBuf {
        self.framework().join("Chromium Embedded Framework")
    }

    pub(crate) fn marker(&self) -> PathBuf {
        self.version_dir().join("installed.json")
    }

    pub(crate) fn download_file(&self, archive_file: &str) -> PathBuf {
        self.root
            .join("download")
            .join(format!("{archive_file}.part"))
    }

    pub(crate) fn profile(&self) -> PathBuf {
        if let Some(dir) = std::env::var_os(CEF_PROFILE_DIR_ENV).filter(|d| !d.is_empty()) {
            return PathBuf::from(dir);
        }
        self.root.join("profile")
    }

    pub(crate) fn log_file(&self) -> PathBuf {
        self.root.join("cef.log")
    }

    pub(crate) fn helper_executable(&self) -> PathBuf {
        helper_executable_in(&Self::frameworks_in(&self.version_dir()), "")
    }
}

fn helper_executable_in(dir: &Path, suffix: &str) -> PathBuf {
    let name = format!("{HELPER_NAME}{suffix}");
    dir.join(format!("{name}.app"))
        .join("Contents")
        .join("MacOS")
        .join(name)
}

/// Streams a download to `part`, verifying exact byte length, SHA-1, and SHA-256.
pub(crate) fn receive(
    body: &mut dyn Read,
    part: &Path,
    pin: &Pin,
    progress: &mut dyn FnMut(u64),
    cancel: &AtomicBool,
) -> Result<(), WebError> {
    if let Some(dir) = part.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let result = (|| {
        let mut file = std::fs::File::create(part)?;
        let (mut sha1, mut sha256) = (Sha1::new(), Sha256::new());
        let mut buffer = vec![0u8; 256 * 1024];
        let mut received: u64 = 0;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(WebError::Download("download cancelled".into()));
            }
            let n = match body.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(WebError::Download(format!("download stream failed: {e}"))),
            };
            received = received.saturating_add(n as u64);
            if received > pin.bytes {
                return Err(WebError::Integrity(
                    "downloaded archive exceeded expected size".into(),
                ));
            }
            sha1.update(&buffer[..n]);
            sha256.update(&buffer[..n]);
            file.write_all(&buffer[..n])?;
            progress(received);
        }
        if received != pin.bytes {
            return Err(WebError::Download(format!(
                "download truncated ({received} of {} bytes)",
                pin.bytes
            )));
        }
        file.sync_all()?;
        if hex(&sha1.finalize()) != pin.sha1.to_ascii_lowercase()
            || hex(&sha256.finalize()) != pin.sha256.to_ascii_lowercase()
        {
            return Err(WebError::Integrity(
                "downloaded archive digest did not match pinned CEF build".into(),
            ));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(part);
    }
    result
}

fn file_hashes(file: &mut std::fs::File) -> io::Result<(u64, String, String)> {
    let (mut sha1, mut sha256) = (Sha1::new(), Sha256::new());
    let mut buffer = vec![0u8; 256 * 1024];
    let mut len = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        len = len.saturating_add(n as u64);
        sha1.update(&buffer[..n]);
        sha256.update(&buffer[..n]);
    }
    Ok((len, hex(&sha1.finalize()), hex(&sha256.finalize())))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

/// Verifies `archive` on disk from a single file handle, extracts only the CEF
/// framework into a `.partial` staging directory, writes `installed.json`, and
/// atomically renames into `<root>/<CEF_VERSION>/`.
pub(crate) fn install_from_file(
    archive: &Path,
    pin: &Pin,
    layout: &Layout,
) -> Result<(), WebError> {
    let mut file = std::fs::File::open(archive)?;
    let (len, sha1, sha256) = file_hashes(&mut file)?;
    if len != pin.bytes
        || sha1 != pin.sha1.to_ascii_lowercase()
        || sha256 != pin.sha256.to_ascii_lowercase()
    {
        return Err(WebError::Integrity(
            "archive digest did not match pinned CEF build".into(),
        ));
    }
    file.seek(SeekFrom::Start(0))?;
    let partial = layout.partial_dir();
    if partial.exists() {
        std::fs::remove_dir_all(&partial)?;
    }
    std::fs::create_dir_all(&partial)?;
    let result = unpack_framework(file, pin, &Layout::frameworks_in(&partial)).and_then(|()| {
        let marker = serde_json::json!({
            "version": CEF_VERSION,
            "sha256": pin.sha256.to_ascii_lowercase(),
        });
        std::fs::write(partial.join("installed.json"), marker.to_string())?;
        Ok(())
    });
    if let Err(err) = result {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(err);
    }
    let dir = layout.version_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::rename(&partial, &dir)?;
    Ok(())
}

/// Returns `true` when the pinned CEF version is installed and its framework
/// binary is present on disk.
pub(crate) fn is_installed(layout: &Layout, pin: &Pin) -> bool {
    let Ok(text) = std::fs::read_to_string(layout.marker()) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    marker["version"] == CEF_VERSION
        && marker["sha256"].as_str() == Some(&pin.sha256.to_ascii_lowercase())
        && layout.framework_binary().is_file()
}

fn framework_path(entry: &Path, top: &str) -> Result<Option<PathBuf>, WebError> {
    let mut parts = Vec::new();
    for component in entry.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_owned()),
            Component::CurDir => {}
            _ => {
                return Err(WebError::Integrity(format!(
                    "archive entry escapes root: {}",
                    entry.display()
                )));
            }
        }
    }
    let [first, release, framework, rest @ ..] = parts.as_slice() else {
        return Ok(None);
    };
    if first.to_str() != Some(top) || release != "Release" || framework != FRAMEWORK_NAME {
        return Ok(None);
    }
    Ok(Some(rest.iter().collect()))
}

fn unpack_framework(file: std::fs::File, pin: &Pin, dest: &Path) -> Result<(), WebError> {
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(io::BufReader::new(file)));
    let root = dest.join(FRAMEWORK_NAME);
    let mut files = 0usize;
    let entries = tar
        .entries()
        .map_err(|e| WebError::Integrity(format!("failed to read tar archive: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| WebError::Integrity(format!("failed to read tar entry: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| WebError::Integrity(format!("invalid tar entry path: {e}")))?
            .into_owned();
        let Some(inside) = framework_path(&path, &pin.top)? else {
            continue;
        };
        let out = root.join(&inside);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else if kind.is_file() {
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut target = std::fs::File::create(&out)?;
            io::copy(&mut entry, &mut target)?;
            set_mode(&out, entry.header().mode().unwrap_or(0o644));
            files += 1;
        } else if kind.is_symlink() || kind.is_hard_link() {
            return Err(WebError::Integrity(format!(
                "unexpected link in CEF framework: {}",
                inside.display()
            )));
        } else {
            return Err(WebError::Integrity(format!(
                "unsupported entry type in CEF archive: {}",
                path.display()
            )));
        }
    }
    if files == 0 {
        return Err(WebError::Integrity(
            "CEF archive contained no framework files".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

/// Stages the five macOS helper `.app` bundles beside the CEF framework using
/// `binary` (the host executable itself, which dispatches subprocesses via
/// `crate::maybe_run_subprocess()`).
///
/// Re-signs each helper `.app` bundle ad-hoc on macOS so a signed host binary
/// (whose embedded CodeDirectory seals the host's `Info.plist`) is not killed
/// with `SIGKILL (Code Signature Invalid)` when launched inside a helper bundle
/// with a different `Info.plist`.
///
/// Reuses existing bundles when `binary`'s SHA-256 and `bundle_id` are unchanged.
pub(crate) fn make_helpers(
    layout: &Layout,
    binary: &Path,
    bundle_id: &str,
) -> Result<PathBuf, WebError> {
    // The stamp names the binary by its size and modification time, so a start that finds the
    // helpers current reads and hashes nothing (the dev binary alone is over 100 MB).
    let stamped = binary_stamp(binary, bundle_id)?;
    let stamp = layout.version_dir().join("helpers.stamp");
    let dir = Layout::frameworks_in(&layout.version_dir());
    let all_there = HELPER_KINDS
        .iter()
        .all(|(suffix, _)| helper_executable_in(&dir, suffix).is_file());
    if all_there && std::fs::read_to_string(&stamp).is_ok_and(|s| s == stamped) {
        return Ok(layout.helper_executable());
    }
    let bytes = std::fs::read(binary)?;
    let web_bundle_id = format!("{bundle_id}.web");
    let contents = layout.runtime_bundle().join("Contents");
    std::fs::create_dir_all(&contents)?;
    std::fs::write(
        contents.join("Info.plist"),
        runtime_bundle_plist(&web_bundle_id),
    )?;
    // Each helper is a copy of the binary that is signed ad hoc, about a second apiece, so they
    // are made side by side.
    let results: Vec<Result<(), WebError>> = std::thread::scope(|scope| {
        let handles: Vec<_> = HELPER_KINDS
            .iter()
            .map(|(suffix, id_end)| {
                let (bytes, dir, web_bundle_id) = (&bytes, &dir, &web_bundle_id);
                scope.spawn(move || make_helper(bytes, dir, web_bundle_id, suffix, id_end))
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| Err(WebError::Runtime("helper build panicked".into())))
            })
            .collect()
    });
    for result in results {
        result?;
    }
    std::fs::write(&stamp, &stamped)?;
    Ok(layout.helper_executable())
}

/// Names `binary` for the helpers stamp: size, modification time and bundle id.
fn binary_stamp(binary: &Path, bundle_id: &str) -> Result<String, WebError> {
    let meta = std::fs::metadata(binary)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    Ok(format!("v3\n{}\n{modified}\n{bundle_id}", meta.len()))
}

/// Writes one helper app: the binary, its `Info.plist`, and an ad-hoc signature.
fn make_helper(
    bytes: &[u8],
    dir: &Path,
    web_bundle_id: &str,
    suffix: &str,
    id_end: &str,
) -> Result<(), WebError> {
    let name = format!("{HELPER_NAME}{suffix}");
    let exe = helper_executable_in(dir, suffix);
    let helper_macos_dir = exe
        .parent()
        .ok_or_else(|| WebError::Runtime("invalid helper executable path".into()))?;
    let helper_contents_dir = helper_macos_dir
        .parent()
        .ok_or_else(|| WebError::Runtime("invalid helper Contents path".into()))?;
    let helper_app_dir = helper_contents_dir
        .parent()
        .ok_or_else(|| WebError::Runtime("invalid helper .app path".into()))?;
    std::fs::create_dir_all(helper_macos_dir)?;
    let fresh = exe.with_extension("new");
    std::fs::write(&fresh, bytes)?;
    set_mode(&fresh, 0o755);
    std::fs::rename(&fresh, &exe)?;
    std::fs::write(
        helper_contents_dir.join("Info.plist"),
        helper_plist(&name, &format!("{web_bundle_id}.helper{id_end}")),
    )?;
    ad_hoc_sign_helper(helper_app_dir)
}

#[cfg(target_os = "macos")]
fn ad_hoc_sign_helper(helper_app_dir: &Path) -> Result<(), WebError> {
    let output = std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(helper_app_dir)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(WebError::Runtime(format!(
            "codesign failed for {}: {}",
            helper_app_dir.display(),
            stderr.trim()
        )));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn ad_hoc_sign_helper(_helper_app_dir: &Path) -> Result<(), WebError> {
    Ok(())
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn runtime_bundle_plist(bundle_id: &str) -> String {
    let bundle_id = xml_escape(bundle_id);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>{bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Conn Web</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
"#
    )
}

fn helper_plist(name: &str, bundle_id: &str) -> String {
    let (name, bundle_id) = (xml_escape(name), xml_escape(bundle_id));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>{name}</string>
  <key>CFBundleExecutable</key><string>{name}</string>
  <key>CFBundleIdentifier</key><string>{bundle_id}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>{name}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>LSFileQuarantineEnabled</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><string>1</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_url_encodes_plus_signs() {
        let url = ARCHIVES[0].url();
        assert!(
            url.contains("%2B"),
            "expected percent-encoded plus signs in {url}"
        );
        assert!(
            !url.contains('+'),
            "raw plus sign should be encoded in {url}"
        );
    }

    #[test]
    fn framework_path_rejects_traversal() {
        let res = framework_path(Path::new("../escape/file"), "top");
        assert!(res.is_err(), "expected traversal path to be rejected");
    }

    #[test]
    fn framework_path_extracts_relative_subpath() -> Result<(), WebError> {
        let path = format!("top/Release/{FRAMEWORK_NAME}/Chromium Embedded Framework");
        let extracted = framework_path(Path::new(&path), "top")?;
        let expected = Some(PathBuf::from("Chromium Embedded Framework"));
        if extracted != expected {
            return Err(WebError::Runtime(format!(
                "expected relative framework binary path {expected:?}, got {extracted:?}"
            )));
        }
        Ok(())
    }

    #[test]
    fn receive_and_install_roundtrip_with_synthetic_archive() -> Result<(), WebError> {
        let temp_root =
            std::env::temp_dir().join(format!("conn-web-archive-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_root);
        std::fs::create_dir_all(&temp_root)?;

        // Build a synthetic tar.bz2 containing a fake framework binary.
        let top = "cef_test_minimal";
        let payload = b"fake-cef-binary";
        let mut compressed = Vec::new();
        {
            let encoder = bzip2::write::BzEncoder::new(&mut compressed, bzip2::Compression::fast());
            let mut tar_builder = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_size(payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            let entry_path = format!("{top}/Release/{FRAMEWORK_NAME}/Chromium Embedded Framework");
            tar_builder.append_data(&mut header, entry_path, &payload[..])?;
            let encoder = tar_builder.into_inner()?;
            encoder.finish()?;
        }

        let pin = Pin {
            bytes: compressed.len() as u64,
            sha1: hex(&Sha1::digest(&compressed)),
            sha256: hex(&Sha256::digest(&compressed)),
            top: top.to_owned(),
        };
        let layout = Layout::new(&temp_root);
        let part = layout.download_file("test.tar.bz2");
        let cancel = AtomicBool::new(false);
        let mut last_received = 0u64;
        receive(
            &mut compressed.as_slice(),
            &part,
            &pin,
            &mut |n| last_received = n,
            &cancel,
        )?;
        if last_received != compressed.len() as u64 {
            let _ = std::fs::remove_dir_all(&temp_root);
            return Err(WebError::Runtime(format!(
                "expected full download byte count {}, got {last_received}",
                compressed.len()
            )));
        }
        install_from_file(&part, &pin, &layout)?;
        if !is_installed(&layout, &pin) {
            let _ = std::fs::remove_dir_all(&temp_root);
            return Err(WebError::Runtime(
                "expected installed marker and framework binary".into(),
            ));
        }
        let _ = std::fs::remove_dir_all(&temp_root);
        Ok(())
    }
}
