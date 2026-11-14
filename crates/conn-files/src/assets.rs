//! `assets.createUrl` and the `GET /api/assets/<token>/<name>` route behind it. A URL is a
//! signed, expiring claim on one file (or, for an HTML page, on the page's folder for its
//! scripts and images), so the route needs no bearer token, as in
//! `apps/server/src/assets/AssetAccess.ts`. Every claim is checked again when served: the file
//! must still resolve to the same place, inside its root.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use conn_contract::{
    AssetAttachmentNotFoundError, AssetCreateUrlResult, AssetImageDimensions,
    AssetPreviewTypeValidationError, AssetProjectFaviconInspectionError,
    AssetProjectFaviconNotFoundError, AssetResource, AssetResourceAttachmentDisposition,
    AssetSourceControlMediaUrlValidationError, AssetWorkspaceAssetInspectionError,
    AssetWorkspaceAssetNotFoundError, AssetWorkspaceContextNotFoundError,
    AssetWorkspacePathValidationError, AssetWorkspaceRootNormalizationError, AssetsCreateUrlError,
    lit, support::JsNumber,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    Files, attachments, mime,
    paths::{self, InternalPaths},
    workspace,
};

pub const ROUTE_PREFIX: &str = "/api/assets";
const TOKEN_TTL_MS: u64 = 60 * 60 * 1000;
const FAVICON_BUCKET_MS: u64 = 30 * 60 * 1000;
const HTML_ATTACHMENT_BUCKET_MS: u64 = 30 * 60 * 1000;
pub const FAVICON_FALLBACK_MARKER: &str = "project-favicon-missing";
const FAVICON_ICNS_MIN_SIZE: u32 = 96;
const FAVICON_MAX_BYTES: u64 = 4 * 1024 * 1024;
const DIMENSION_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".gif", ".webp"];

const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
    ".idea/icon.svg",
    "Resources/AppIcon.icns",
    "AppIcon.icns",
];
const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

/// What a signed asset URL grants.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Claims {
    /// An HTML page's folder: the page and the scripts, styles and images next to it.
    WorkspaceFile {
        workspace_root: String,
        base_relative_path: String,
        expires_at: u64,
    },
    WorkspaceFileExact {
        workspace_root: String,
        relative_path: String,
        expires_at: u64,
    },
    /// A host file, pinned to its device and inode.
    MediaFileExact {
        file_path: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        download: bool,
        device: String,
        inode: String,
        expires_at: u64,
    },
    Attachment {
        attachment_id: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        download: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        file_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        expires_at: u64,
    },
    ProjectFavicon {
        workspace_root: String,
        relative_path: Option<String>,
        expires_at: u64,
    },
    ProjectFaviconExternal {
        file_path: String,
        expires_at: u64,
    },
    /// Native app icons come from the desktop host; a headless server has none.
    NativeAppIcon {
        expires_at: u64,
    },
}

impl Claims {
    fn expires_at(&self) -> u64 {
        match self {
            Claims::WorkspaceFile { expires_at, .. }
            | Claims::WorkspaceFileExact { expires_at, .. }
            | Claims::MediaFileExact { expires_at, .. }
            | Claims::Attachment { expires_at, .. }
            | Claims::ProjectFavicon { expires_at, .. }
            | Claims::ProjectFaviconExternal { expires_at, .. }
            | Claims::NativeAppIcon { expires_at } => *expires_at,
        }
    }
}

/// What the caller knows about where a resource lives, looked up from the engine.
#[derive(Clone, Debug, Default)]
pub struct AssetContext {
    /// The thread's worktree or project root, for `workspace-file`, `media-file` and
    /// `tool-output-image`; the draft's `cwd` for `draft-workspace-file`.
    pub workspace_root: Option<String>,
    /// The project's `faviconPath` override, for `project-favicon`.
    pub project_favicon_path: Option<String>,
}

/// A file or bytes the asset route sends.
#[derive(Debug)]
pub enum Served {
    File {
        path: PathBuf,
        download: bool,
        file_name: Option<String>,
        mime_type: Option<String>,
        /// Device and inode the open file must still have.
        identity: Option<(u64, u64)>,
    },
    Bytes {
        bytes: Vec<u8>,
        mime_type: &'static str,
    },
}

struct Finalized {
    claims: Claims,
    file_name: String,
    image_dimensions: Option<(u32, u32)>,
    file_revision: Option<String>,
}

fn not_found(resource: &AssetResource, checked: Option<&Path>) -> AssetsCreateUrlError {
    AssetsCreateUrlError::AssetWorkspaceAssetNotFoundError(AssetWorkspaceAssetNotFoundError {
        tag: lit::AssetWorkspaceAssetNotFoundError,
        resource: resource.clone(),
        checked_path: checked.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn preview_type(resource: &AssetResource) -> AssetsCreateUrlError {
    AssetsCreateUrlError::AssetPreviewTypeValidationError(AssetPreviewTypeValidationError {
        tag: lit::AssetPreviewTypeValidationError,
        resource: resource.clone(),
    })
}

fn inspection(resource: &AssetResource, cause: String) -> AssetsCreateUrlError {
    AssetsCreateUrlError::AssetWorkspaceAssetInspectionError(AssetWorkspaceAssetInspectionError {
        tag: lit::AssetWorkspaceAssetInspectionError,
        resource: resource.clone(),
        cause: json!({ "message": cause }),
    })
}

pub fn context_not_found(resource: &AssetResource) -> AssetsCreateUrlError {
    AssetsCreateUrlError::AssetWorkspaceContextNotFoundError(AssetWorkspaceContextNotFoundError {
        tag: lit::AssetWorkspaceContextNotFoundError,
        resource: resource.clone(),
    })
}

fn root_normalization(resource: &AssetResource, root: &str) -> AssetsCreateUrlError {
    AssetsCreateUrlError::AssetWorkspaceRootNormalizationError(
        AssetWorkspaceRootNormalizationError {
            tag: lit::AssetWorkspaceRootNormalizationError,
            resource: resource.clone(),
            cause: json!({ "message": format!("Workspace root does not exist: {root}") }),
        },
    )
}

/// `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`, `None` on a malformed escape or invalid UTF-8.
pub fn decode_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn dimensions_of(path: &Path) -> Option<(u32, u32)> {
    let file = workspace::open_nonblocking(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut header = Vec::new();
    file.take(mime::IMAGE_HEADER_BYTES as u64)
        .read_to_end(&mut header)
        .ok()?;
    mime::image_dimensions(&header)
}

/// A canonical regular file that is not the server's own.
fn canonical_file(path: &Path, internal: &InternalPaths) -> Option<PathBuf> {
    let real = fs::canonicalize(path).ok()?;
    let meta = fs::metadata(&real).ok()?;
    (meta.is_file() && !internal.contains(&real)).then_some(real)
}

/// A canonical regular file strictly inside the canonical root.
fn canonical_workspace_file(
    root: &Path,
    relative: &str,
    internal: &InternalPaths,
) -> Option<PathBuf> {
    let (absolute, _) = paths::resolve_within_root(root, relative)?;
    let real_root = fs::canonicalize(root).ok()?;
    let real = canonical_file(&absolute, internal)?;
    (real != real_root && real.starts_with(&real_root)).then_some(real)
}

#[cfg(unix)]
fn identity(meta: &fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(unix)]
fn revision(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    let ns = |s: i64, n: i64| i128::from(s) * 1_000_000_000 + i128::from(n);
    format!(
        "{}:{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.size(),
        ns(meta.mtime(), meta.mtime_nsec()),
        ns(meta.ctime(), meta.ctime_nsec())
    )
}

impl Files {
    /// `assets.createUrl`. Blocking.
    pub fn create_asset_url(
        &self,
        resource: &AssetResource,
        context: &AssetContext,
        now_ms: u64,
    ) -> Result<AssetCreateUrlResult, AssetsCreateUrlError> {
        let mut expires_at = now_ms + TOKEN_TTL_MS;
        let mut source_path = None;
        let finalized = match resource {
            AssetResource::MediaFile(media) => {
                let mut requested = paths::expand_home(&media.path, self.home.as_deref());
                if !requested.is_absolute() {
                    let root = self.asset_root(resource, context.workspace_root.as_deref())?;
                    requested = paths::resolve(&root, &requested);
                }
                let download = media.disposition.is_some();
                self.finalize_media(
                    resource,
                    &requested,
                    context.workspace_root.as_deref(),
                    download,
                    None,
                    expires_at,
                )?
            }
            AssetResource::WorkspaceFile(file) => {
                let root = self.asset_root(resource, context.workspace_root.as_deref())?;
                self.finalize_workspace(resource, &root, &file.path, false, expires_at)?
            }
            AssetResource::DraftWorkspaceFile(draft) => {
                let root = context.workspace_root.as_deref().unwrap_or(&draft.cwd);
                let host = if draft.path.starts_with("~/") {
                    paths::expand_home(&draft.path, self.home.as_deref())
                } else {
                    PathBuf::from(&draft.path)
                };
                if host.is_absolute() {
                    self.finalize_media(resource, &host, Some(root), false, None, expires_at)?
                } else {
                    let root = self.asset_root(resource, Some(root))?;
                    self.finalize_workspace(resource, &root, &draft.path, true, expires_at)?
                }
            }
            AssetResource::Attachment(attachment) => {
                let Some(file) = self.attachments.resolve(&attachment.attachment_id) else {
                    return Err(AssetsCreateUrlError::AssetAttachmentNotFoundError(
                        AssetAttachmentNotFoundError {
                            tag: lit::AssetAttachmentNotFoundError,
                            resource: resource.clone(),
                        },
                    ));
                };
                let extension =
                    attachments::parse_id(&attachment.attachment_id).and_then(|id| id.extension);
                let generic = extension.is_some();
                let video_mime = attachment
                    .mime_type
                    .as_deref()
                    .map(|m| m.split(';').next().unwrap_or_default().trim().to_owned())
                    .filter(|m| is_inline_video_mime(m));
                let inline_mime = match (attachment.disposition, &extension) {
                    (Some(AssetResourceAttachmentDisposition::Inline), Some(e)) => {
                        inline_preview_mime(e)
                    }
                    _ => None,
                };
                let image_dimensions = (!generic)
                    .then(|| {
                        fs::canonicalize(&file.path)
                            .ok()
                            .and_then(|p| dimensions_of(&p))
                    })
                    .flatten();
                let mime_type = inline_mime
                    .map(str::to_owned)
                    .or_else(|| video_mime.clone())
                    .or_else(|| attachment.mime_type.clone());
                Finalized {
                    claims: Claims::Attachment {
                        attachment_id: attachment.attachment_id.clone(),
                        download: generic && video_mime.is_none() && inline_mime.is_none(),
                        file_name: attachment.file_name.clone(),
                        mime_type,
                        expires_at,
                    },
                    file_name: attachment
                        .file_name
                        .clone()
                        .unwrap_or_else(|| paths::file_name(&file.path)),
                    image_dimensions,
                    file_revision: None,
                }
            }
            AssetResource::ProjectFavicon(favicon) => {
                let (finalized, source) = self.finalize_favicon(
                    resource,
                    &favicon.cwd,
                    context.project_favicon_path.as_deref(),
                    expires_at,
                )?;
                source_path = source;
                finalized
            }
            AssetResource::NativeAppIcon(_) => Finalized {
                claims: Claims::NativeAppIcon { expires_at },
                file_name: "native-app-icon.png".into(),
                image_dimensions: None,
                file_revision: None,
            },
            // Tool output images live in turn items this server does not record yet.
            AssetResource::ToolOutputImage(_) => return Err(not_found(resource, None)),
            // Fetching a host's private media needs its credentials; callers refuse first.
            AssetResource::GithubMedia(_) => {
                return Err(AssetsCreateUrlError::AssetGitHubMediaUrlValidationError(
                    AssetSourceControlMediaUrlValidationError {
                        tag: lit::AssetGitHubMediaUrlValidationError,
                    },
                ));
            }
        };
        let mut claims = finalized.claims;
        match &mut claims {
            Claims::ProjectFavicon { expires_at: e, .. }
            | Claims::ProjectFaviconExternal { expires_at: e, .. } => {
                *e = (now_ms / FAVICON_BUCKET_MS + 2) * FAVICON_BUCKET_MS;
                expires_at = *e;
            }
            Claims::Attachment {
                expires_at: e,
                mime_type: Some(m),
                ..
            } if m == "text/html" => {
                *e = e.div_ceil(HTML_ATTACHMENT_BUCKET_MS) * HTML_ATTACHMENT_BUCKET_MS;
                expires_at = *e;
            }
            _ => {}
        }
        let token = self.signer.sign(&claims);
        Ok(AssetCreateUrlResult {
            relative_url: format!(
                "{ROUTE_PREFIX}/{token}/{}",
                encode_component(&finalized.file_name)
            ),
            expires_at: JsNumber(expires_at as f64),
            source_path,
            image_dimensions: finalized.image_dimensions.map(|(width, height)| {
                AssetImageDimensions {
                    width: width.into(),
                    height: height.into(),
                }
            }),
            file_revision: finalized.file_revision,
        })
    }

    fn asset_root(
        &self,
        resource: &AssetResource,
        root: Option<&str>,
    ) -> Result<PathBuf, AssetsCreateUrlError> {
        let root = root.ok_or_else(|| context_not_found(resource))?;
        let resolved = paths::resolve_cwd(root, self.home.as_deref());
        if resolved.is_dir() {
            Ok(resolved)
        } else {
            Err(root_normalization(resource, &resolved.to_string_lossy()))
        }
    }

    fn finalize_media(
        &self,
        resource: &AssetResource,
        requested: &Path,
        workspace_root: Option<&str>,
        download: bool,
        expected: Option<&Path>,
        expires_at: u64,
    ) -> Result<Finalized, AssetsCreateUrlError> {
        let requested_text = requested.to_string_lossy();
        // Only the thread's own project may sit on a network share.
        if paths::is_network_path(&requested_text)
            && workspace_root.is_none_or(|root| {
                !paths::normalize(requested).starts_with(paths::normalize(Path::new(root)))
            })
        {
            return Err(not_found(resource, Some(requested)));
        }
        let requested = paths::normalize(requested);
        let real = canonical_file(&requested, &self.internal)
            .filter(|real| expected.is_none_or(|e| e == real))
            .ok_or_else(|| not_found(resource, Some(&requested)))?;
        let extension = paths::extension(&real.to_string_lossy());
        if !download && mime::host_preview_mime(&extension).is_none() {
            return Err(preview_type(resource));
        }
        let file =
            workspace::open_nonblocking(&real).map_err(|e| inspection(resource, e.to_string()))?;
        let meta = file
            .metadata()
            .map_err(|e| inspection(resource, e.to_string()))?;
        if !meta.is_file() {
            return Err(not_found(resource, Some(&requested)));
        }
        drop(file);
        let (device, inode) = identity(&meta);
        Ok(Finalized {
            image_dimensions: DIMENSION_EXTENSIONS
                .contains(&extension.as_str())
                .then(|| dimensions_of(&real))
                .flatten(),
            file_revision: Some(revision(&meta)),
            file_name: paths::file_name(&real),
            claims: Claims::MediaFileExact {
                file_path: real.to_string_lossy().into_owned(),
                download,
                device: device.to_string(),
                inode: inode.to_string(),
                expires_at,
            },
        })
    }

    fn finalize_workspace(
        &self,
        resource: &AssetResource,
        root: &Path,
        requested: &str,
        draft: bool,
        expires_at: u64,
    ) -> Result<Finalized, AssetsCreateUrlError> {
        let relative = if Path::new(requested).is_absolute() {
            Path::new(requested)
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| requested.to_owned())
        } else {
            requested.to_owned()
        };
        let Some((_, relative)) = paths::resolve_within_root(root, &relative) else {
            return Err(AssetsCreateUrlError::AssetWorkspacePathValidationError(
                AssetWorkspacePathValidationError {
                    tag: lit::AssetWorkspacePathValidationError,
                    resource: resource.clone(),
                    cause: json!({ "message": "Workspace file path must be relative to the project root." }),
                },
            ));
        };
        let draft_media =
            draft && (mime::is_audio_path(&relative) || mime::is_video_path(&relative));
        if !draft_media && !mime::is_workspace_preview_path(&relative) {
            return Err(preview_type(resource));
        }
        let real = canonical_workspace_file(root, &relative, &self.internal)
            .ok_or_else(|| not_found(resource, None))?;
        if draft_media {
            return self.finalize_media(
                resource,
                &real,
                None,
                false,
                Some(&real.clone()),
                expires_at,
            );
        }
        let real_root = fs::canonicalize(root).map_err(|e| inspection(resource, e.to_string()))?;
        let extension = paths::extension(&relative);
        let workspace_root = real_root.to_string_lossy().into_owned();
        let claims = if extension == ".html" || extension == ".htm" {
            let base = relative
                .rsplit_once('/')
                .map_or(".", |(dir, _)| dir)
                .to_owned();
            Claims::WorkspaceFile {
                workspace_root,
                base_relative_path: base,
                expires_at,
            }
        } else {
            Claims::WorkspaceFileExact {
                workspace_root,
                relative_path: relative.clone(),
                expires_at,
            }
        };
        Ok(Finalized {
            claims,
            file_name: relative.rsplit('/').next().unwrap_or(&relative).to_owned(),
            image_dimensions: DIMENSION_EXTENSIONS
                .contains(&extension.as_str())
                .then(|| dimensions_of(&real))
                .flatten(),
            file_revision: None,
        })
    }

    fn finalize_favicon(
        &self,
        resource: &AssetResource,
        cwd: &str,
        override_path: Option<&str>,
        expires_at: u64,
    ) -> Result<(Finalized, Option<String>), AssetsCreateUrlError> {
        let root = paths::resolve_cwd(cwd, self.home.as_deref());
        if !root.is_dir() {
            return Err(root_normalization(resource, &root.to_string_lossy()));
        }
        let found = resolve_favicon(&root, override_path);
        let external = match (&found, override_path) {
            (Some(found), Some(o)) => {
                Path::new(o).is_absolute()
                    && paths::normalize(found) == paths::normalize(Path::new(o))
            }
            _ => false,
        };
        let relative = found
            .as_ref()
            .filter(|_| !external)
            .and_then(|f| f.strip_prefix(&root).ok())
            .map(|p| p.to_string_lossy().into_owned());
        let source = if external {
            found.as_ref().map(|f| f.to_string_lossy().into_owned())
        } else {
            relative.clone()
        };
        if let Some(source) = &source
            && !mime::is_favicon_path(source)
        {
            return Err(preview_type(resource));
        }
        let canonical = match &source {
            Some(source) if external => canonical_file(Path::new(source), &self.internal),
            Some(source) => canonical_workspace_file(&root, source, &self.internal),
            None => None,
        };
        if source.is_some() && canonical.is_none() {
            return Err(AssetsCreateUrlError::AssetProjectFaviconNotFoundError(
                AssetProjectFaviconNotFoundError {
                    tag: lit::AssetProjectFaviconNotFoundError,
                    resource: resource.clone(),
                },
            ));
        }
        let claims = match (&canonical, external) {
            (Some(file), true) => Claims::ProjectFaviconExternal {
                file_path: file.to_string_lossy().into_owned(),
                expires_at,
            },
            _ => Claims::ProjectFavicon {
                workspace_root: fs::canonicalize(&root)
                    .unwrap_or(root)
                    .to_string_lossy()
                    .into_owned(),
                relative_path: relative,
                expires_at,
            },
        };
        let file_name = match (&source, &canonical) {
            (Some(source), Some(file)) => {
                let mut bytes = Vec::new();
                fs::File::open(file)
                    .and_then(|f| f.take(FAVICON_MAX_BYTES).read_to_end(&mut bytes))
                    .map_err(|e| {
                        AssetsCreateUrlError::AssetProjectFaviconInspectionError(
                            AssetProjectFaviconInspectionError {
                                tag: lit::AssetProjectFaviconInspectionError,
                                resource: resource.clone(),
                                cause: json!({ "message": e.to_string() }),
                            },
                        )
                    })?;
                let name = source.rsplit(['/', '\\']).next().unwrap_or(source);
                format!(
                    "v{}-{name}",
                    conn_support::hex::hex(&Sha256::digest(&bytes))
                )
            }
            _ => FAVICON_FALLBACK_MARKER.into(),
        };
        Ok((
            Finalized {
                claims,
                file_name,
                image_dimensions: None,
                file_revision: None,
            },
            source,
        ))
    }

    /// Resolves a `GET /api/assets/<token>/<name>` request. `None` answers 404. Blocking.
    pub fn resolve_asset(&self, token: &str, name: &str, now_ms: u64) -> Option<Served> {
        let claims: Claims = self.signer.verify(token)?;
        if claims.expires_at() <= now_ms {
            return None;
        }
        let file = |path: PathBuf| Served::File {
            path,
            download: false,
            file_name: None,
            mime_type: None,
            identity: None,
        };
        match claims {
            Claims::Attachment {
                attachment_id,
                download,
                file_name,
                mime_type,
                ..
            } => {
                let stored = self.attachments.resolve(&attachment_id)?;
                Some(Served::File {
                    path: stored.path,
                    download,
                    file_name,
                    mime_type,
                    identity: None,
                })
            }
            Claims::ProjectFavicon {
                workspace_root,
                relative_path,
                ..
            } => {
                let path = canonical_workspace_file(
                    Path::new(&workspace_root),
                    &relative_path?,
                    &self.internal,
                )?;
                favicon_asset(path)
            }
            Claims::ProjectFaviconExternal { file_path, .. } => {
                let path = canonical_file(Path::new(&file_path), &self.internal)?;
                (path == Path::new(&file_path)).then_some(())?;
                favicon_asset(path)
            }
            Claims::NativeAppIcon { .. } => None,
            Claims::MediaFileExact {
                file_path,
                download,
                device,
                inode,
                ..
            } => {
                let path = PathBuf::from(&file_path);
                if decode_component(name)? != paths::file_name(&path) {
                    return None;
                }
                let real = canonical_file(&path, &self.internal)?;
                if real != path {
                    return None;
                }
                let mime_type = if download {
                    "application/octet-stream"
                } else {
                    mime::host_preview_mime(&paths::extension(&file_path))?
                };
                Some(Served::File {
                    file_name: download.then(|| paths::file_name(&real)),
                    path: real,
                    download,
                    mime_type: Some(mime_type.to_owned()),
                    identity: Some((device.parse().ok()?, inode.parse().ok()?)),
                })
            }
            Claims::WorkspaceFileExact {
                workspace_root,
                relative_path,
                ..
            } => {
                if decode_component(name)? != relative_path.rsplit('/').next()? {
                    return None;
                }
                canonical_workspace_file(Path::new(&workspace_root), &relative_path, &self.internal)
                    .map(file)
            }
            Claims::WorkspaceFile {
                workspace_root,
                base_relative_path,
                ..
            } => {
                let decoded = decode_component(name)?;
                let hidden = decoded
                    .split(['/', '\\'])
                    .any(|s| s.is_empty() || s == "." || s == ".." || s.starts_with('.'));
                if hidden || decoded.contains('\0') || !mime::is_page_dependency(&decoded) {
                    return None;
                }
                let joined = if base_relative_path == "." {
                    decoded
                } else {
                    format!("{base_relative_path}/{decoded}")
                };
                canonical_workspace_file(Path::new(&workspace_root), &joined, &self.internal)
                    .map(file)
            }
        }
    }
}

/// Browsers cannot draw `.icns`; serve its embedded PNG.
fn favicon_asset(path: PathBuf) -> Option<Served> {
    if paths::extension(&path.to_string_lossy()) != ".icns" {
        return Some(Served::File {
            path,
            download: false,
            file_name: None,
            mime_type: None,
            identity: None,
        });
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .ok()?
        .take(16 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    extract_icns_png(&bytes, FAVICON_ICNS_MIN_SIZE).map(|bytes| Served::Bytes {
        bytes,
        mime_type: "image/png",
    })
}

/// `extractIcnsPng`: the smallest PNG at least `min_size` wide, else the largest.
pub fn extract_icns_png(bytes: &[u8], min_size: u32) -> Option<Vec<u8>> {
    let u32_at = |i: usize| {
        bytes
            .get(i..i + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    };
    if u32_at(0)? != 0x6963_6e73 {
        return None;
    }
    let end = (u32_at(4)? as usize).min(bytes.len());
    let mut best: Option<(&[u8], u32)> = None;
    let mut offset = 8;
    while offset + 8 <= end {
        let length = u32_at(offset + 4)? as usize;
        if length < 8 || offset + length > end {
            break;
        }
        let entry = &bytes[offset + 8..offset + length];
        offset += length;
        if !entry.starts_with(b"\x89PNG") {
            continue;
        }
        let Some((width, _)) = mime::image_dimensions(entry) else {
            continue;
        };
        let better = match best {
            None => true,
            Some((_, w)) if w < min_size => width > w,
            Some((_, w)) => width >= min_size && width < w,
        };
        if better {
            best = Some((entry, width));
        }
    }
    best.map(|(png, _)| png.to_vec())
}

fn is_inline_video_mime(mime_type: &str) -> bool {
    let Some((kind, sub)) = mime_type.split_once('/') else {
        return false;
    };
    kind.eq_ignore_ascii_case("video")
        && !sub.is_empty()
        && sub
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$&^.+-_".contains(&b))
}

fn inline_preview_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        "html" | "htm" => Some("text/html"),
        other => mime::host_preview_mime(&format!(".{other}")),
    }
}

/// Finds a project icon: the override, well-known files, then `<link rel="icon">` in an HTML
/// or root route source. Each call looks again; nothing is cached.
pub fn resolve_favicon(root: &Path, override_path: Option<&str>) -> Option<PathBuf> {
    let existing = |relative: &str, absolute_ok: bool| -> Option<PathBuf> {
        let path = if absolute_ok && Path::new(relative).is_absolute() {
            PathBuf::from(relative)
        } else {
            paths::resolve_within_root(root, relative)?.0
        };
        fs::metadata(&path).ok()?.is_file().then_some(path)
    };
    if let Some(found) = override_path.and_then(|o| existing(o, true)) {
        return Some(found);
    }
    if let Some(found) = FAVICON_CANDIDATES.iter().find_map(|c| existing(c, false)) {
        return Some(found);
    }
    ICON_SOURCE_FILES.iter().find_map(|source| {
        let (path, _) = paths::resolve_within_root(root, source)?;
        let mut text = String::new();
        fs::File::open(path)
            .ok()?
            .take(1024 * 1024)
            .read_to_string(&mut text)
            .ok()?;
        let href = icon_href(&text)?;
        let clean = href.trim().trim_start_matches('/');
        existing(&format!("public/{clean}"), false).or_else(|| existing(clean, false))
    })
}

/// The `href` of the first `<link rel="icon">` (or `shortcut icon`), or of a `{ rel: "icon",
/// href: "…" }` object in a route file.
fn icon_href(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("<link") {
        let start = from + at;
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        let tag = &source[start..end];
        let tag_lower = &lower[start..end];
        if [
            "rel=\"icon\"",
            "rel='icon'",
            "rel=\"shortcut icon\"",
            "rel='shortcut icon'",
        ]
        .iter()
        .any(|r| tag_lower.contains(r))
            && let Some(href) = attribute(tag, tag_lower, "href=")
        {
            return Some(href);
        }
        from = end;
    }
    for run in source.split('}') {
        let run_lower = run.to_ascii_lowercase();
        let compact: String = run_lower.chars().filter(|c| !c.is_whitespace()).collect();
        if [
            "rel:\"icon\"",
            "rel:'icon'",
            "rel:\"shortcuticon\"",
            "rel:'shortcuticon'",
        ]
        .iter()
        .any(|r| compact.contains(r))
            && let Some(href) = attribute(run, &run_lower, "href:")
        {
            return Some(href);
        }
    }
    None
}

fn attribute(text: &str, lower: &str, key: &str) -> Option<String> {
    let at = lower.find(key)? + key.len();
    let rest = text[at..].trim_start();
    let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let value: String = rest[1..]
        .chars()
        .take_while(|c| *c != quote && *c != '?')
        .collect();
    (!value.is_empty()).then_some(value)
}

/// How a served file is offered to the browser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Shown in place, when its type is safe to render.
    Inline,
    /// Saved as a file, never rendered.
    Download,
}

/// `assetResponseHeaders`: what a served file's response carries. HTML and SVG get a sandbox
/// CSP; downloads become `attachment`s of a type that cannot render as a document.
pub fn response_headers(
    path: &Path,
    disposition: Disposition,
    file_name: Option<&str>,
    mime_type: Option<&str>,
) -> Vec<(&'static str, String)> {
    const SVG_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    const HTML_CSP: &str = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
    let lower = path.to_string_lossy().to_lowercase();
    let inline = mime_type.map(|m| m.split(';').next().unwrap_or_default().trim().to_owned());
    let mut headers = vec![
        ("cache-control", "private, max-age=3600".to_owned()),
        ("x-content-type-options", "nosniff".to_owned()),
    ];
    if disposition == Disposition::Download {
        headers.push(("content-disposition", download_disposition(file_name)));
        headers.push((
            "content-security-policy",
            "default-src 'none'; sandbox".into(),
        ));
        let safe = mime_type.filter(|m| is_safe_download_mime(m));
        headers.push((
            "content-type",
            safe.unwrap_or("application/octet-stream").to_owned(),
        ));
        return headers;
    }
    match inline.as_deref() {
        Some(m)
            if is_token_mime(m)
                && (m.to_ascii_lowercase().starts_with("audio/")
                    || m.to_ascii_lowercase().starts_with("video/")) =>
        {
            headers.push(("content-type", m.to_owned()));
        }
        Some(m) if m.eq_ignore_ascii_case("application/pdf") => {
            headers.push(("content-type", "application/pdf".into()));
        }
        Some(m) if m.eq_ignore_ascii_case("text/html") => {
            headers.push(("content-type", "text/html; charset=utf-8".into()));
            headers.push(("content-security-policy", HTML_CSP.into()));
        }
        _ if lower.ends_with(".html") || lower.ends_with(".htm") => {
            headers.push(("content-type", "text/html; charset=utf-8".into()));
            headers.push(("content-security-policy", HTML_CSP.into()));
        }
        _ => {
            headers.push(("content-type", mime::content_type(&lower).to_owned()));
            if lower.ends_with(".svg") {
                headers.push(("content-security-policy", SVG_CSP.into()));
            }
        }
    }
    headers
}

fn is_token_mime(m: &str) -> bool {
    let token = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^.+-_".contains(&b))
    };
    m.split_once('/').is_some_and(|(a, b)| token(a) && token(b))
}

fn is_safe_download_mime(m: &str) -> bool {
    let lower = m.trim().to_ascii_lowercase();
    is_token_mime(m) && lower != "text/html" && !lower.contains("/xml") && !lower.ends_with("+xml")
}

/// `downloadContentDisposition`.
pub fn download_disposition(file_name: Option<&str>) -> String {
    let Some(name) = file_name else {
        return "attachment".into();
    };
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_control() || c == '"' || c == '\\' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let ascii: String = sanitized
        .chars()
        .map(|c| if (' '..='~').contains(&c) { c } else { '_' })
        .collect();
    if ascii == sanitized {
        format!("attachment; filename=\"{ascii}\"")
    } else {
        format!(
            "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
            encode_component(&sanitized)
        )
    }
}

/// A single `Range: bytes=a-b` against a file of `size` bytes: `Ok(Some((offset, len)))`,
/// `Ok(None)` to send the whole file, `Err(Unsatisfiable)` for 416.
/// A `Range` no byte of the file satisfies.
#[derive(Debug, PartialEq, Eq)]
pub struct Unsatisfiable;

pub fn byte_range(header: &str, size: u64) -> Result<Option<(u64, u64)>, Unsatisfiable> {
    let Some(spec) = header
        .trim()
        .strip_prefix("bytes=")
        .or_else(|| header.trim().strip_prefix("BYTES="))
    else {
        return Ok(None);
    };
    let Some((first, last)) = spec.split_once('-') else {
        return Ok(None);
    };
    let parse = |s: &str| -> Result<Option<u64>, ()> {
        if s.is_empty() {
            Ok(None)
        } else if s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse().map(Some).map_err(|_| ())
        } else {
            Err(())
        }
    };
    let (Ok(first), Ok(last)) = (parse(first), parse(last)) else {
        return Ok(None);
    };
    if first.is_none() && last.is_none() {
        return Ok(None);
    }
    if let (Some(f), Some(l)) = (first, last)
        && l < f
    {
        return Ok(None);
    }
    if size == 0 || first.is_some_and(|f| f >= size) || (first.is_none() && last == Some(0)) {
        return Err(Unsatisfiable);
    }
    let start = match (first, last) {
        (Some(f), _) => f,
        (None, Some(l)) if l >= size => 0,
        (None, Some(l)) => size - l,
        (None, None) => 0,
    };
    let end = match (first, last) {
        (Some(_), Some(l)) if l < size => l,
        _ => size - 1,
    };
    Ok(Some((start, end - start + 1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_round_trip_with_kebab_kinds() {
        let claims = Claims::WorkspaceFileExact {
            workspace_root: "/w".into(),
            relative_path: "a.png".into(),
            expires_at: 5,
        };
        let value = serde_json::to_value(&claims).unwrap();
        assert_eq!(value["kind"], "workspace-file-exact");
        assert_eq!(value["relativePath"], "a.png");
        assert_eq!(serde_json::from_value::<Claims>(value).unwrap(), claims);
    }

    #[test]
    fn encodes_names_and_ranges() {
        assert_eq!(encode_component("a b/ü.png"), "a%20b%2F%C3%BC.png");
        assert_eq!(
            decode_component("a%20b%2F%C3%BC.png").as_deref(),
            Some("a b/ü.png")
        );
        assert_eq!(decode_component("%zz"), None);
        assert_eq!(byte_range("bytes=0-9", 100), Ok(Some((0, 10))));
        assert_eq!(byte_range("bytes=-10", 100), Ok(Some((90, 10))));
        assert_eq!(byte_range("bytes=90-", 100), Ok(Some((90, 10))));
        assert_eq!(byte_range("bytes=100-", 100), Err(Unsatisfiable));
        assert_eq!(byte_range("items=1-2", 100), Ok(None));
        assert_eq!(
            download_disposition(Some("rä\"p.pdf")),
            "attachment; filename=\"r__p.pdf\"; filename*=UTF-8''r%C3%A4_p.pdf"
        );
    }

    #[test]
    fn finds_icon_links() {
        assert_eq!(
            icon_href(r#"<head><link rel="stylesheet" href="a.css"><link rel="icon" href="/fav.png?v=2"></head>"#).as_deref(),
            Some("/fav.png")
        );
        assert_eq!(
            icon_href(r#"links: [{ rel: "icon", href: "/logo.svg" }]"#).as_deref(),
            Some("/logo.svg")
        );
        assert_eq!(icon_href("<link rel=\"icon\">"), None);
    }
}
