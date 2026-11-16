//! Images and files in a user message, as `makeClaudeUserMessageWithAttachments` sends them.
//!
//! Every attachment gets a line in the text with its saved path (`attachmentPrompt.ts`), so
//! Claude can read it with its tools; the attachments folder is passed with `--add-dir`.
//! Images of a type the API takes are also sent inline as base64 blocks, before the text, while
//! the session's budget lasts. Paths follow T3's attachment store (`attachmentStore.ts`):
//! `<dir>/<id><ext>`.
//!
//! Differences: PDFs stay path-only (T3 embeds one only when its strict page scanner
//! succeeds), the captured-window context of snap-shot images is not added, and the budget
//! lives in memory, so it starts over after a restart.

use std::path::{Path, PathBuf};

use conn_contract::{ChatAttachment, to_json};
use serde_json::{Value, json};

/// `CLAUDE_ATTACHMENT_MAX_BYTES`: inline bytes one session may send, base64 included.
pub const BUDGET_BYTES: u64 = 28 * 1024 * 1024;

const SUPPORTED_IMAGES: &[&str] = &["image/gif", "image/jpeg", "image/png", "image/webp"];

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

fn extension_of(name: &str, max: usize) -> Option<String> {
    let (_, ext) = name.trim().rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    (!ext.is_empty() && ext.len() <= max && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .then(|| format!(".{ext}"))
}

/// `attachmentRelativePath`.
pub fn relative_path(attachment: &Value) -> Option<String> {
    let id = attachment.get("id")?.as_str()?;
    let safe_id = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !safe_id {
        return None;
    }
    let name = attachment.get("name").and_then(Value::as_str).unwrap_or("");
    let mime = attachment
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = match attachment.get("type")?.as_str()? {
        "image" => IMAGE_EXTENSIONS
            .iter()
            .find(|(m, _)| *m == mime)
            .map(|(_, e)| e.to_string())
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

/// The user message content for a turn or steer: a plain string without attachments, else
/// image blocks followed by the text block.
pub fn prompt_content(
    text: &str,
    attachments: &[ChatAttachment],
    dir: Option<&Path>,
    budget_used: &mut u64,
) -> Value {
    if attachments.is_empty() {
        return json!(text);
    }
    let mut prompt = text.to_string();
    let mut blocks = Vec::new();
    for attachment in attachments {
        let value = to_json(attachment);
        let kind = value["type"].as_str().unwrap_or("file");
        let name = value["name"].as_str().unwrap_or("");
        let path: Option<PathBuf> = dir.zip(relative_path(&value)).map(|(d, r)| d.join(r));
        let line = match &path {
            Some(path) => format!(
                "[Attached {kind} \"{name}\" is saved at: {}]",
                path.display()
            ),
            None => format!(
                "[Attached {kind} \"{name}\" is unavailable: could not resolve a saved path for attachment '{}'.]",
                value["id"].as_str().unwrap_or("")
            ),
        };
        prompt = if prompt.is_empty() {
            line
        } else {
            format!("{prompt}\n\n{line}")
        };
        let mime = value["mimeType"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase();
        if kind != "image" || !SUPPORTED_IMAGES.contains(&mime.as_str()) {
            continue;
        }
        let Some(path) = path else {
            continue;
        };
        // The budget is checked on the file size, before the file is read.
        let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) else {
            continue;
        };
        if *budget_used + 4 * size.div_ceil(3) + 128 > BUDGET_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let cost = 4 * (bytes.len() as u64).div_ceil(3) + 128;
        if *budget_used + cost > BUDGET_BYTES {
            continue;
        }
        *budget_used += cost;
        blocks.push(json!({
            "type": "image",
            "source": {"type": "base64", "media_type": mime, "data": conn_support::base64::encode(&bytes)},
        }));
    }
    if !prompt.is_empty() {
        blocks.push(json!({"type": "text", "text": prompt}));
    }
    Value::Array(blocks)
}
#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::from_json;

    #[test]
    fn paths_follow_the_attachment_store() {
        let image = json!({"type": "image", "id": "t-1", "name": "a.PNG", "mimeType": "image/png", "sizeBytes": 1});
        assert_eq!(relative_path(&image).as_deref(), Some("t-1.png"));
        let file = json!({"type": "file", "id": "t-2", "name": "notes.Md", "mimeType": "text/markdown", "sizeBytes": 1});
        assert_eq!(relative_path(&file).as_deref(), Some("t-2.md"));
        let odd =
            json!({"type": "file", "id": "t-3", "name": "x.part", "mimeType": "x", "sizeBytes": 1});
        assert_eq!(relative_path(&odd).as_deref(), Some("t-3.bin"));
        let traversal =
            json!({"type": "file", "id": "../x", "name": "a", "mimeType": "x", "sizeBytes": 1});
        assert_eq!(relative_path(&traversal), None);
    }

    #[test]
    fn images_go_inline_before_the_text_with_every_path_listed() {
        let dir = std::env::temp_dir().join(format!("conn-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t-1.png"), b"png").unwrap();
        std::fs::write(dir.join("t-2.txt"), b"hello").unwrap();
        let attachments: Vec<ChatAttachment> = from_json(json!([
            {"type": "image", "id": "t-1", "name": "red.png", "mimeType": "image/png", "sizeBytes": 3},
            {"type": "file", "id": "t-2", "name": "a.txt", "mimeType": "text/plain", "sizeBytes": 5},
        ]))
        .unwrap();
        let mut used = 0;
        let content = prompt_content("Look", &attachments, Some(&dir), &mut used);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["data"], "cG5n");
        let text = content[1]["text"].as_str().unwrap();
        assert!(text.starts_with("Look\n\n[Attached image \"red.png\" is saved at: "));
        assert!(text.contains("[Attached file \"a.txt\" is saved at: "));
        assert_eq!(used, 4 + 128);
        assert_eq!(
            prompt_content("plain", &[], None, &mut used),
            json!("plain")
        );
    }
}
