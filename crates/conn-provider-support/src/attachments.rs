//! Chat attachments as T3 stores and describes them to a provider CLI.
//!
//! - [`relative_path`]: `attachmentRelativePath` (`attachmentStore.ts`): `<id><ext>` inside
//!   the attachments folder.
//! - [`prompt_text`]: `providerMessageTextWithAttachmentPaths` (`attachmentPrompt.ts`) without
//!   the captured-window context: the message text, then one line per attachment with its
//!   saved path.
//! - [`is_native_image`]: `isProviderNativeImageAttachment`, the images a provider gets inline.
//! - [`base64`]: standard base64 with padding, for inline images.
//!
//! Values are the contract's `ChatAttachment` as JSON, so callers need no generated type.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// `PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES`.
const NATIVE_IMAGE_TYPES: &[&str] = &["image/gif", "image/jpeg", "image/png", "image/webp"];

const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("image/avif", ".avif"),
    ("image/bmp", ".bmp"),
    ("image/gif", ".gif"),
    ("image/heic", ".heic"),
    ("image/heif", ".heif"),
    ("image/jpeg", ".jpg"),
    ("image/jpg", ".jpg"),
    ("image/png", ".png"),
    ("image/svg+xml", ".svg"),
    ("image/tiff", ".tiff"),
    ("image/webp", ".webp"),
];

const SAFE_IMAGE_EXTENSIONS: &[&str] = &[
    ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tiff",
    ".webp",
];

/// Documents whose text T3 extracts next to them as `<path>.txt` (`DocumentText.ts`).
const EXTRACTED_TEXT_EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf", "epub", "ipynb",
];

fn extension_of(name: &str, max: usize) -> Option<String> {
    let (_, ext) = name.trim().rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= max && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| format!(".{ext}"))
}

fn text<'a>(attachment: &'a Value, key: &str) -> &'a str {
    attachment.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `attachmentRelativePath`: `<id><ext>`, or `None` for an unsafe id or unknown type.
pub fn relative_path(attachment: &Value) -> Option<String> {
    let id = text(attachment, "id");
    let safe_id = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe_id {
        return None;
    }
    let name = text(attachment, "name");
    let mime = text(attachment, "mimeType").to_ascii_lowercase();
    let extension = match text(attachment, "type") {
        "image" => IMAGE_EXTENSIONS
            .iter()
            .find(|(m, _)| *m == mime)
            .map(|(_, e)| (*e).to_owned())
            .or_else(|| {
                extension_of(name, 8).filter(|e| SAFE_IMAGE_EXTENSIONS.contains(&e.as_str()))
            })
            .unwrap_or_else(|| ".bin".into()),
        "file" => extension_of(name, 10)
            .filter(|e| e != ".part")
            .unwrap_or_else(|| ".bin".into()),
        _ => return None,
    };
    Some(format!("{id}{extension}"))
}

/// The saved file of an attachment inside `dir`.
pub fn saved_path(dir: Option<&Path>, attachment: &Value) -> Option<PathBuf> {
    Some(dir?.join(relative_path(attachment)?))
}

/// `isProviderNativeImageAttachment`.
pub fn is_native_image(attachment: &Value) -> bool {
    text(attachment, "type") == "image"
        && NATIVE_IMAGE_TYPES.contains(&text(attachment, "mimeType").to_ascii_lowercase().as_str())
}

/// `DocumentText.resolveExtractedTextPath`: `<path>.txt` for a document whose text exists.
fn extracted_text_path(path: &Path) -> Option<PathBuf> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !EXTRACTED_TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let mut text = path.as_os_str().to_owned();
    text.push(".txt");
    let text = PathBuf::from(text);
    text.is_file().then_some(text)
}

/// The message text with one line per attachment, as `providerMessageTextWithAttachmentPaths`
/// builds it. Images' captured-window context (snap-shot sources) is not added.
pub fn prompt_text(text: &str, attachments: &[Value], dir: Option<&Path>) -> String {
    let mut prompt = text.to_owned();
    for attachment in attachments {
        let kind = self::text(attachment, "type");
        let name = self::text(attachment, "name");
        let line = match saved_path(dir, attachment) {
            Some(path) => {
                let extracted = extracted_text_path(&path)
                    .map(|t| format!(" (text extracted to: {})", t.display()))
                    .unwrap_or_default();
                format!(
                    "[Attached {kind} \"{name}\" is saved at: {}{extracted}]",
                    path.display()
                )
            }
            None => format!(
                "[Attached {kind} \"{name}\" is unavailable: could not resolve a saved path for attachment '{}'.]",
                self::text(attachment, "id")
            ),
        };
        prompt = if prompt.is_empty() {
            line
        } else {
            format!("{prompt}\n\n{line}")
        };
    }
    prompt
}

/// Standard base64 with padding. Small enough not to need a dependency.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = b(0) << 16 | b(1) << 8 | b(2);
        for i in 0..4 {
            if i <= chunk.len() {
                let index = (n >> (18 - 6 * i) & 63) as usize;
                out.push(char::from(TABLE.get(index).copied().unwrap_or(b'A')));
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn paths_follow_the_attachment_store() {
        let image = json!({"type": "image", "id": "a-1", "name": "x.PNG", "mimeType": "image/png"});
        assert_eq!(relative_path(&image).as_deref(), Some("a-1.png"));
        let odd = json!({"type": "image", "id": "b", "name": "x.heic", "mimeType": "image/x"});
        assert_eq!(relative_path(&odd).as_deref(), Some("b.heic"));
        let file =
            json!({"type": "file", "id": "c", "name": "notes.part", "mimeType": "text/plain"});
        assert_eq!(relative_path(&file).as_deref(), Some("c.bin"));
        let unsafe_id = json!({"type": "file", "id": "../x", "name": "a.txt"});
        assert_eq!(relative_path(&unsafe_id), None);
    }

    #[test]
    fn the_prompt_lists_every_attachment() {
        let dir = Path::new("/att");
        let attachments = [
            json!({"type": "image", "id": "i", "name": "p.png", "mimeType": "image/png"}),
            json!({"type": "file", "id": "../bad", "name": "n.txt", "mimeType": "text/plain"}),
        ];
        assert_eq!(
            prompt_text("Look", &attachments, Some(dir)),
            "Look\n\n[Attached image \"p.png\" is saved at: /att/i.png]\n\n[Attached file \"n.txt\" is unavailable: could not resolve a saved path for attachment '../bad'.]"
        );
        assert!(is_native_image(&attachments[0]));
        assert!(!is_native_image(&attachments[1]));
        assert_eq!(prompt_text("", &[], Some(dir)), "");
    }
}
