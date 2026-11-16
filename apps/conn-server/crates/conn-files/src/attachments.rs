//! The attachment store: `<state-dir>/attachments/<id><.ext>`, one flat folder. Ids and rules
//! follow `apps/server/src/attachmentStore.ts` and `assets/AttachmentUpload.ts`:
//!
//! - An id is `<thread segment>-<uuid>` or `<thread segment>-<uuid>-<ext>` (generic files keep
//!   their extension in the id). Uploads start as `pending-<uuid>…`; sending a message claims
//!   them for the thread ([`AttachmentStore::claim`]), which copies to a thread id.
//! - Uploads go to a signed URL, then to a `.part` file, and are published by hard link without
//!   replacement, so a stored attachment never changes.
//! - The store is bounded by the sweep: pending uploads older than 24 hours and `.part` files
//!   older than an hour are removed, at most every 15 minutes, when an upload URL is issued.

use std::{
    fs, io,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use conn_contract::{
    AttachmentCreateUploadUrlInput, AttachmentCreateUploadUrlResult, ChatAttachment,
    ChatFileAttachment, ChatImageAttachment, PersistChatAttachmentsError,
    PersistChatAttachmentsInput, lit, support::JsNumber,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{mime, paths, signer::Signer};

pub const UPLOAD_ROUTE_PREFIX: &str = "/api/attachments/upload";
/// `ATTACHMENT_UPLOAD_URL_TTL_MS`.
pub const UPLOAD_URL_TTL_MS: u64 = 10 * 60_000;
/// `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` and `_FILE_BYTES`.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// `PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS`.
pub const MAX_IMAGE_DATA_URL_CHARS: usize = 14_000_000;
pub const PENDING_SEGMENT: &str = "pending";
const PENDING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const PARTIAL_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const SWEEP_INTERVAL_MS: u64 = 15 * 60_000;
const THREAD_SEGMENT_MAX_CHARS: usize = 80;
/// Tried in this order for an id without an extension (`ATTACHMENT_FILENAME_EXTENSIONS`).
const IMAGE_EXTENSIONS: &[&str] = &[
    ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tiff",
    ".webp", ".bin",
];
const UPLOAD_IMAGE_MIME_TYPES: &[&str] = &["image/gif", "image/jpeg", "image/png", "image/webp"];

/// T3's image budget and duplicate check, before copying any pending upload.
pub fn validate_claims(attachments: &[ChatAttachment]) -> Result<(), String> {
    let mut image_bytes = 0_u64;
    let mut ids = std::collections::HashSet::with_capacity(attachments.len());
    for attachment in attachments {
        let (id, mime, size, image) = match attachment {
            ChatAttachment::Image(a) => (&a.id, &a.mime_type, a.size_bytes, true),
            ChatAttachment::File(a) => (&a.id, &a.mime_type, a.size_bytes, false),
            ChatAttachment::Unknown(a) => (&a.id, &a.mime_type, a.size_bytes, false),
        };
        ids.insert(id);
        if image
            || UPLOAD_IMAGE_MIME_TYPES
                .iter()
                .any(|m| mime.eq_ignore_ascii_case(m))
        {
            image_bytes = image_bytes.saturating_add(u64::try_from(size).unwrap_or_default());
        }
    }
    if image_bytes > 80 * 1024 * 1024 {
        return Err("Images can total up to 80 MiB per message or question response. Use smaller images or send fewer at once.".into());
    }
    if ids.len() != attachments.len() {
        return Err("Duplicate attachment ids are not allowed.".into());
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The parts of an attachment id.
#[derive(Debug, PartialEq, Eq)]
pub struct AttachmentId<'a> {
    pub segment: String,
    pub uuid: String,
    pub extension: Option<String>,
    pub raw: &'a str,
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_segment(s: &str) -> bool {
    !s.is_empty()
        && s.split('-').all(|part| {
            !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        })
}

fn is_extension(s: &str) -> bool {
    (1..=10).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Parses `<segment>-<uuid>[-<ext>]`, case-insensitive. Anything else (`/`, `.`, `..`, NUL)
/// is not an id.
pub fn parse_id(id: &str) -> Option<AttachmentId<'_>> {
    let split = |head: &str| -> Option<(String, String)> {
        let uuid = head.get(head.len().checked_sub(36)?..)?;
        let segment = head.get(..head.len() - 36)?.strip_suffix('-')?;
        (is_uuid(uuid) && is_segment(segment))
            .then(|| (segment.to_ascii_lowercase(), uuid.to_ascii_lowercase()))
    };
    if let Some((head, extension)) = id.rsplit_once('-')
        && is_extension(extension)
        && let Some((segment, uuid)) = split(head)
    {
        return Some(AttachmentId {
            segment,
            uuid,
            extension: Some(extension.to_ascii_lowercase()),
            raw: id,
        });
    }
    let (segment, uuid) = split(id)?;
    Some(AttachmentId {
        segment,
        uuid,
        extension: None,
        raw: id,
    })
}

/// `toSafeThreadAttachmentSegment`.
pub fn thread_segment(thread_id: &str) -> Option<String> {
    let mut segment = String::new();
    for c in thread_id.trim().to_lowercase().chars() {
        let c = if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            c
        } else {
            '-'
        };
        if !(c == '-' && segment.ends_with('-')) {
            segment.push(c);
        }
    }
    let segment = segment.trim_matches(['-', '_']);
    let segment: String = segment.chars().take(THREAD_SEGMENT_MAX_CHARS).collect();
    let segment = segment.trim_end_matches(['-', '_']);
    match segment {
        "" => None,
        PENDING_SEGMENT => Some("_pending".into()),
        other => Some(other.to_owned()),
    }
}

/// `attachmentFileExtension`: `.ext` for a generic file, `.bin` when unusable.
pub fn file_extension(name: &str) -> String {
    let extension = paths::extension(name);
    if extension == ".part" || !is_extension(extension.get(1..).unwrap_or_default()) {
        ".bin".into()
    } else {
        extension
    }
}

fn id_suffix(extension: Option<&str>) -> String {
    match extension.map(|e| e.trim_start_matches('.').to_ascii_lowercase()) {
        None => String::new(),
        Some(e) if is_extension(&e) => format!("-{e}"),
        Some(_) => "-bin".into(),
    }
}

fn is_svg(name: &str, mime_type: &str) -> bool {
    let mime_type = mime_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    mime_type == "image/svg+xml"
        || ((mime_type.is_empty()
            || [
                "application/octet-stream",
                "binary/octet-stream",
                "application/unknown",
            ]
            .contains(&mime_type.as_str()))
            && name.to_lowercase().ends_with(".svg"))
}

/// A stored attachment: what a provider needs to hand it to its CLI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachmentFile {
    pub path: PathBuf,
    pub byte_length: u64,
    /// The stored extension, with its dot (`.png`, `.pdf`, `.bin`).
    pub extension: String,
    /// The type the extension names, when a viewer knows it.
    pub mime_type: Option<&'static str>,
}

/// Signed claims of an upload URL. `type` defaults to `image`, as in TypeScript.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadClaims {
    pub version: u8,
    pub kind: String,
    #[serde(default = "image_type", rename = "type")]
    pub kind_of_file: String,
    pub attachment_id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub expires_at: u64,
}

fn image_type() -> String {
    "image".into()
}

/// `attachments.createUploadUrl` input in one shape for both members.
#[derive(Clone, Debug)]
pub struct UploadRequest {
    pub kind: Option<String>,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

impl From<AttachmentCreateUploadUrlInput> for UploadRequest {
    fn from(input: AttachmentCreateUploadUrlInput) -> Self {
        // A negative size becomes 0, which `validate` refuses.
        let size = |bytes: i64| u64::try_from(bytes).unwrap_or(0);
        match input {
            AttachmentCreateUploadUrlInput::Image(image) => Self {
                kind: Some("image".into()),
                name: image.name,
                mime_type: conn_contract::to_json(&image.mime_type)
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                size_bytes: size(image.size_bytes),
            },
            AttachmentCreateUploadUrlInput::File(file) => Self {
                kind: Some("file".into()),
                name: file.name,
                mime_type: file.mime_type,
                size_bytes: size(file.size_bytes),
            },
        }
    }
}

impl UploadRequest {
    /// The contract's checks, which the generated types do not enforce.
    pub fn validate(&self) -> Result<(), String> {
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 255 {
            return Err("name must be 1 to 255 characters".into());
        }
        match self.kind.as_deref() {
            None | Some("image") => {
                if !UPLOAD_IMAGE_MIME_TYPES.contains(&self.mime_type.as_str()) {
                    return Err(format!("unsupported image type '{}'", self.mime_type));
                }
                if !(1..=MAX_IMAGE_BYTES).contains(&self.size_bytes) {
                    return Err("image size must be between 1 byte and 10 MiB".into());
                }
            }
            Some("file") => {
                if self.mime_type.trim().is_empty() || self.mime_type.len() > 100 {
                    return Err("mimeType must be 1 to 100 characters".into());
                }
                if !(1..=MAX_FILE_BYTES).contains(&self.size_bytes) {
                    return Err("file size must be between 1 byte and 50 MiB".into());
                }
            }
            Some(other) => return Err(format!("unknown attachment type '{other}'")),
        }
        Ok(())
    }
}

/// How an upload ended, as the route answers it.
#[derive(Debug, PartialEq, Eq)]
pub enum UploadOutcome {
    Stored,
    Rejected { status: u16, detail: String },
}

#[derive(Debug)]
pub struct AttachmentStore {
    dir: PathBuf,
    last_sweep_ms: Mutex<Option<u64>>,
}

impl AttachmentStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            last_sweep_ms: Mutex::new(None),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The file for a relative name inside the store, or `None` when it would leave it.
    pub(crate) fn path_for(&self, relative: &str) -> Option<PathBuf> {
        let ok = !relative.is_empty()
            && !relative.contains(['/', '\\', '\0'])
            && relative != "."
            && relative != "..";
        ok.then(|| self.dir.join(relative))
    }

    /// **The function providers use.** Maps an attachment id (as a `ChatAttachment.id` carries
    /// it) to its stored file. `None` for an invalid id or a missing file. Blocking (one `stat`
    /// per candidate extension).
    pub fn resolve(&self, attachment_id: &str) -> Option<AttachmentFile> {
        let id = parse_id(attachment_id)?;
        let candidates: Vec<String> = match &id.extension {
            Some(extension) => vec![format!(".{extension}")],
            None => IMAGE_EXTENSIONS.iter().map(|e| (*e).to_owned()).collect(),
        };
        candidates.into_iter().find_map(|extension| {
            let path = self.path_for(&format!("{attachment_id}{extension}"))?;
            let meta = fs::metadata(&path).ok()?;
            meta.is_file().then(|| AttachmentFile {
                byte_length: meta.len(),
                mime_type: mime::host_preview_mime(&extension),
                extension,
                path,
            })
        })
    }

    /// `attachments.createUploadUrl`: a pending id and a signed URL to POST the bytes to.
    pub fn create_upload(
        &self,
        signer: &Signer,
        request: &UploadRequest,
        now_ms: u64,
    ) -> AttachmentCreateUploadUrlResult {
        self.maybe_sweep(now_ms);
        let is_file = request.kind.as_deref() == Some("file");
        let name = if is_file
            && is_svg(&request.name, &request.mime_type)
            && !request.name.to_lowercase().ends_with(".svg")
        {
            format!("{}.svg", request.name)
        } else {
            request.name.clone()
        };
        let extension = is_file.then(|| file_extension(&name));
        let attachment_id = format!(
            "{PENDING_SEGMENT}-{}{}",
            conn_support::uuid_v4(),
            id_suffix(extension.as_deref())
        );
        let expires_at = now_ms + UPLOAD_URL_TTL_MS;
        let token = signer.sign(&UploadClaims {
            version: 1,
            kind: "attachment-upload".into(),
            kind_of_file: if is_file { "file" } else { "image" }.into(),
            attachment_id: attachment_id.clone(),
            name,
            mime_type: request.mime_type.clone(),
            size_bytes: request.size_bytes,
            expires_at,
        });
        AttachmentCreateUploadUrlResult {
            attachment_id,
            relative_url: format!("{UPLOAD_ROUTE_PREFIX}/{token}"),
            expires_at: JsNumber(expires_at as f64),
        }
    }

    /// The claims of a valid, unexpired upload token.
    pub fn verify_upload(&self, signer: &Signer, token: &str, now_ms: u64) -> Option<UploadClaims> {
        let claims: UploadClaims = signer.verify(token)?;
        (claims.version == 1 && claims.kind == "attachment-upload" && claims.expires_at > now_ms)
            .then_some(claims)
    }

    /// Where an upload is written first and where it is published.
    pub fn upload_paths(&self, claims: &UploadClaims) -> Option<(PathBuf, PathBuf)> {
        parse_id(&claims.attachment_id)?;
        let extension = if claims.kind_of_file == "file" {
            file_extension(&claims.name)
        } else {
            mime::image_extension(&claims.mime_type, &claims.name)
        };
        let relative = format!("{}{extension}", claims.attachment_id);
        let part = self.path_for(&format!("{relative}.{}.part", conn_support::uuid_v4()))?;
        Some((part, self.path_for(&relative)?))
    }

    /// Publishes a complete `.part` file without replacing an existing one, then removes the
    /// part. A second upload of the same bytes succeeds; different bytes are a conflict.
    pub fn publish_upload(
        &self,
        part: &Path,
        target: &Path,
        received: u64,
        expected: u64,
    ) -> UploadOutcome {
        let outcome = (|| {
            if received != expected {
                return Ok(UploadOutcome::Rejected {
                    status: 400,
                    detail: format!("Body was {received} bytes, expected {expected}."),
                });
            }
            match fs::hard_link(part, target) {
                Ok(()) => return Ok(UploadOutcome::Stored),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => match copy_new(part, target) {
                    Ok(()) => return Ok(UploadOutcome::Stored),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                },
            }
            let same = fs::metadata(target)?.len() == received
                && sha256_file(part)? == sha256_file(target)?;
            Ok(if same {
                UploadOutcome::Stored
            } else {
                UploadOutcome::Rejected {
                    status: 409,
                    detail: "Attachment already uploaded.".into(),
                }
            })
        })();
        let _ = fs::remove_file(part);
        outcome.unwrap_or_else(|_| UploadOutcome::Rejected {
            status: 500,
            detail: "Failed to persist upload.".into(),
        })
    }

    /// `attachments.delete`: removes a pending upload (and its extracted text). Claimed
    /// attachments belong to their message and stay.
    pub fn delete_pending(&self, attachment_id: &str) {
        if parse_id(attachment_id).is_none_or(|id| id.segment != PENDING_SEGMENT) {
            return;
        }
        if let Some(file) = self.resolve(attachment_id) {
            let _ = fs::remove_file(&file.path);
            let mut text = file.path.into_os_string();
            text.push(".txt");
            let _ = fs::remove_file(text);
        }
    }

    fn maybe_sweep(&self, now_ms: u64) {
        let mut last = crate::lock(&self.last_sweep_ms);
        if last.is_some_and(|at| now_ms.saturating_sub(at) < SWEEP_INTERVAL_MS) {
            return;
        }
        *last = Some(now_ms);
        drop(last);
        self.sweep(SystemTime::now());
    }

    /// Removes pending uploads older than a day and `.part` files older than an hour.
    pub fn sweep(&self, now: SystemTime) -> usize {
        let Ok(read) = fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut deleted = 0;
        for entry in read.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let partial = name.ends_with(".part");
            if !partial {
                let base = name
                    .strip_suffix(".txt")
                    .filter(|b| b.contains('.'))
                    .unwrap_or(&name);
                let id = base.rsplit_once('.').map(|(id, _)| id);
                if id
                    .and_then(parse_id)
                    .is_none_or(|id| id.segment != PENDING_SEGMENT)
                {
                    continue;
                }
            }
            let max_age = if partial {
                PARTIAL_MAX_AGE
            } else {
                PENDING_MAX_AGE
            };
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age > max_age);
            if old && fs::remove_file(entry.path()).is_ok() {
                deleted += 1;
            }
        }
        deleted
    }

    /// `assets.persistChatAttachments`: stores `data:` URL images under ids derived from the
    /// message, so a retry keeps its ids.
    /// `UploadChatImageAttachment`'s checks, which the generated types drop: run before any
    /// payload is decoded or stored. Lengths count UTF-16 units after trimming, as Effect's
    /// `TrimmedNonEmptyString` and `isMaxLength` do.
    pub fn check_persist_input(input: &PersistChatAttachmentsInput) -> Result<(), String> {
        let trimmed_len = |value: &str, max: usize, field: &str| {
            let n = value.trim().encode_utf16().count();
            if n == 0 || n > max {
                Err(format!("{field} must be 1 to {max} characters"))
            } else {
                Ok(())
            }
        };
        for attachment in &input.attachments {
            if let Some(id) = &attachment.id {
                trimmed_len(id, 128, "id")?;
                if !id
                    .trim()
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err("id may hold only letters, digits, '_' and '-'".into());
                }
            }
            trimmed_len(&attachment.name, 255, "name")?;
            trimmed_len(&attachment.mime_type, 100, "mimeType")?;
            let is_image = attachment
                .mime_type
                .trim()
                .get(..6)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("image/"));
            if !is_image {
                return Err(format!(
                    "mimeType must start with image/, not '{}'",
                    attachment.mime_type
                ));
            }
            if !(0..=MAX_IMAGE_BYTES as i64).contains(&attachment.size_bytes) {
                return Err("sizeBytes must be between 0 and 10 MiB".into());
            }
            trimmed_len(&attachment.data_url, MAX_IMAGE_DATA_URL_CHARS, "dataUrl")?;
        }
        Ok(())
    }

    pub fn persist_data_urls(
        &self,
        input: &PersistChatAttachmentsInput,
    ) -> Result<Vec<ChatAttachment>, PersistChatAttachmentsError> {
        let error = |message: String| PersistChatAttachmentsError {
            tag: lit::PersistChatAttachmentsError,
            message,
            cause: None,
        };
        let segment = thread_segment(&input.thread_id)
            .ok_or_else(|| error("Could not allocate an attachment identifier.".into()))?;
        fs::create_dir_all(&self.dir)
            .map_err(|e| error(format!("Could not create the attachment store: {e}")))?;
        let mut stored = Vec::with_capacity(input.attachments.len());
        for (index, attachment) in input.attachments.iter().enumerate() {
            let name = &attachment.name;
            let (_, base64) = parse_base64_data_url(&attachment.data_url)
                .filter(|(m, _)| *m == attachment.mime_type.to_lowercase())
                .ok_or_else(|| error(format!("Attachment {name} has an invalid image payload.")))?;
            let bytes = conn_support::base64::decode(&base64)
                .ok_or_else(|| error(format!("Attachment {name} is not valid base64.")))?;
            if bytes.len() as i64 != attachment.size_bytes {
                return Err(error(format!(
                    "Attachment {name} size does not match its payload."
                )));
            }
            let stable_key = format!(
                "{}:{index}:{}",
                input.message_id,
                conn_support::hex::hex(&Sha256::digest(&bytes))
            );
            let hashed = Sha256::digest(
                serde_json::to_string(&[&input.thread_id, &stable_key])
                    .expect("strings encode")
                    .as_bytes(),
            );
            let h = conn_support::hex::hex(&hashed[..16]);
            let id = format!(
                "{segment}-{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..32]
            );
            let extension = mime::image_extension(&attachment.mime_type, name);
            let path = self
                .path_for(&format!("{id}{extension}"))
                .ok_or_else(|| error("Could not allocate an attachment identifier.".into()))?;
            fs::write(&path, &bytes)
                .map_err(|_| error(format!("Could not persist attachment {name}.")))?;
            stored.push(ChatAttachment::Image(ChatImageAttachment {
                r#type: lit::Image,
                id,
                name: name.clone(),
                mime_type: attachment.mime_type.clone(),
                size_bytes: attachment.size_bytes,
                source: None,
            }));
        }
        Ok(stored)
    }

    /// **For the engine.** Claims a pending upload for a thread when its message is accepted:
    /// copies it to a new thread id and returns the attachment as the message should keep it.
    /// An attachment that is not pending comes back unchanged. The pending file stays for a
    /// retry; the sweep removes it. On failure, call [`AttachmentStore::release`] for the
    /// attachments already claimed.
    pub fn claim(
        &self,
        thread_id: &str,
        attachment: &ChatAttachment,
    ) -> Result<ChatAttachment, String> {
        let (id, name, mime_type, size) = match attachment {
            ChatAttachment::Image(a) => (&a.id, &a.name, &a.mime_type, a.size_bytes),
            ChatAttachment::File(a) => (&a.id, &a.name, &a.mime_type, a.size_bytes),
            ChatAttachment::Unknown(_) => return Ok(attachment.clone()),
        };
        let fail = |reason: &str| format!("Attachment '{name}' cannot be sent: {reason}.");
        let parsed = parse_id(id).ok_or_else(|| fail("invalid attachment id"))?;
        if parsed.segment != PENDING_SEGMENT {
            return Ok(attachment.clone());
        }
        let segment = thread_segment(thread_id).ok_or_else(|| fail("invalid thread id"))?;
        let current = self
            .resolve(id)
            .ok_or_else(|| fail("attachment not found (removed or expired)"))?;
        if current.byte_length as i64 != size {
            return Err(fail("stored size does not match"));
        }
        let expected_extension = match attachment {
            ChatAttachment::File(_) => file_extension(name),
            _ => mime::image_extension(mime_type, name),
        };
        if expected_extension != current.extension {
            return Err(fail("attachment type does not match the upload"));
        }
        let final_id = format!(
            "{segment}-{}{}",
            conn_support::uuid_v4(),
            id_suffix(parsed.extension.as_deref())
        );
        let target = self
            .path_for(&format!("{final_id}{}", current.extension))
            .ok_or_else(|| fail("failed to resolve attachment path"))?;
        copy_new(&current.path, &target).map_err(|_| fail("could not copy the upload"))?;
        let mime_type = mime_type.to_lowercase();
        Ok(match attachment {
            ChatAttachment::File(a) => ChatAttachment::File(ChatFileAttachment {
                id: final_id,
                name: if is_svg(&a.name, &a.mime_type) && !a.name.to_lowercase().ends_with(".svg") {
                    format!("{}.svg", a.name)
                } else {
                    a.name.clone()
                },
                mime_type,
                ..a.clone()
            }),
            ChatAttachment::Image(a) => ChatAttachment::Image(ChatImageAttachment {
                id: final_id,
                mime_type,
                ..a.clone()
            }),
            ChatAttachment::Unknown(_) => unreachable!("returned above"),
        })
    }

    /// Claims a message's uploads together, releasing earlier copies if any claim fails.
    pub fn claim_all(
        &self,
        thread_id: &str,
        attachments: &[ChatAttachment],
    ) -> Result<Vec<ChatAttachment>, String> {
        validate_claims(attachments)?;
        let mut claimed = Vec::with_capacity(attachments.len());
        for attachment in attachments {
            match self.claim(thread_id, attachment) {
                Ok(kept) => claimed.push(kept),
                Err(reason) => {
                    self.release(&claimed);
                    return Err(reason);
                }
            }
        }
        Ok(claimed)
    }

    /// Removes claimed copies of a message that was not accepted.
    pub fn release(&self, claimed: &[ChatAttachment]) {
        for attachment in claimed {
            let id = match attachment {
                ChatAttachment::Image(a) => &a.id,
                ChatAttachment::File(a) => &a.id,
                ChatAttachment::Unknown(_) => continue,
            };
            if parse_id(id).is_some_and(|p| p.segment != PENDING_SEGMENT)
                && let Some(file) = self.resolve(id)
            {
                let _ = fs::remove_file(file.path);
            }
        }
    }
}

fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = fs::File::open(from)?;
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    io::copy(&mut source, &mut target)
        .map(|_| ())
        .inspect_err(|_| {
            let _ = fs::remove_file(to);
        })
}

fn sha256_file(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&chunk[..n]);
    }
}

/// `parseBase64DataUrl`: `data:<mime>;…;base64,<payload>`, whitespace allowed between runs.
pub fn parse_base64_data_url(url: &str) -> Option<(String, String)> {
    let trimmed = url.trim();
    if !trimmed.get(..5)?.eq_ignore_ascii_case("data:") {
        return None;
    }
    let (header, payload) = trimmed[5..].split_once(',')?;
    let parts: Vec<&str> = header
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 || !parts.last()?.eq_ignore_ascii_case("base64") {
        return None;
    }
    let mime_type = parts[0].to_lowercase();
    let mut base64 = String::with_capacity(payload.len());
    for c in payload.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '+' | '/' | '=' => base64.push(c),
            '\r' | '\n' | ' ' => {}
            _ => return None,
        }
    }
    if base64.is_empty() || !base64.len().is_multiple_of(4) {
        return None;
    }
    if let Some(pad) = base64.find('=')
        && (base64.len() - pad > 2 || !base64[pad..].bytes().all(|b| b == b'='))
    {
        return None;
    }
    Some((mime_type, base64))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    #[test]
    fn parses_ids() {
        let id = format!("pending-{UUID}");
        let parsed = parse_id(&id).unwrap();
        assert_eq!(
            (parsed.segment.as_str(), parsed.extension),
            ("pending", None)
        );
        let with_extension = format!("my-thread_1-{UUID}-PDF");
        let parsed = parse_id(&with_extension).unwrap();
        assert_eq!(parsed.segment, "my-thread_1");
        assert_eq!(parsed.extension.as_deref(), Some("pdf"));
        for bad in [
            format!("../{UUID}"),
            format!("a/b-{UUID}"),
            format!("a.b-{UUID}"),
            format!("-{UUID}"),
            format!("a--b-{UUID}"),
            UUID.to_owned(),
            format!("a-{UUID}-toolongextension"),
            "pending-not-a-uuid".into(),
        ] {
            assert_eq!(parse_id(&bad), None, "{bad}");
        }
        assert_eq!(
            thread_segment("  Thread: ABC/def  ").as_deref(),
            Some("thread-abc-def")
        );
        assert_eq!(thread_segment("pending").as_deref(), Some("_pending"));
        assert_eq!(thread_segment("///"), None);
        assert_eq!(file_extension("notes.PDF"), ".pdf");
        assert_eq!(file_extension("x.part"), ".bin");
        assert_eq!(file_extension("Makefile"), ".bin");
    }

    #[test]
    fn parses_data_urls() {
        assert_eq!(
            parse_base64_data_url("data:image/PNG;base64,aGk=\n"),
            Some(("image/png".into(), "aGk=".into()))
        );
        assert_eq!(parse_base64_data_url("data:image/png,aGk="), None);
        assert_eq!(parse_base64_data_url("data:image/png;base64,a=Gk"), None);
        assert_eq!(parse_base64_data_url("data:image/png;base64,a\"Gk"), None);
    }
}
