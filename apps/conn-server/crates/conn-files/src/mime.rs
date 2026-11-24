//! Extension and header tables: which files a viewer may preview, and as what. Mirrors
//! `packages/shared/src/{mediaPreview,filePreview,video,imageDimensions,projectFavicon}.ts` and
//! `apps/server/src/{imageMime,workspace/fileHeaderMimeType}.ts`.

const IMAGE: &[(&str, &str)] = &[
    (".avif", "image/avif"),
    (".bmp", "image/bmp"),
    (".heic", "image/heic"),
    (".heif", "image/heif"),
    (".gif", "image/gif"),
    (".ico", "image/x-icon"),
    (".jpeg", "image/jpeg"),
    (".jpg", "image/jpeg"),
    (".png", "image/png"),
    (".svg", "image/svg+xml"),
    (".tif", "image/tiff"),
    (".tiff", "image/tiff"),
    (".webp", "image/webp"),
];
const VIDEO: &[(&str, &str)] = &[
    (".avi", "video/x-msvideo"),
    (".m4v", "video/mp4"),
    (".mkv", "video/x-matroska"),
    (".mov", "video/quicktime"),
    (".mp4", "video/mp4"),
    (".ogv", "video/ogg"),
    (".webm", "video/webm"),
];
const AUDIO: &[(&str, &str)] = &[
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
    (".ogg", "audio/ogg"),
    (".oga", "audio/ogg"),
    (".flac", "audio/flac"),
    (".aac", "audio/aac"),
    (".m4a", "audio/mp4"),
    (".opus", "audio/ogg"),
    (".aiff", "audio/aiff"),
    (".webm-audio", "audio/webm"),
    (".weba", "audio/webm"),
];
const BROWSER: &[(&str, &str)] = &[
    (".htm", "text/html"),
    (".html", "text/html"),
    (".pdf", "application/pdf"),
];
const FONT: &[(&str, &str)] = &[
    (".ttf", "font/ttf"),
    (".otf", "font/otf"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
];
const BINARY: &[(&str, &str)] = &[
    (".zip", "application/zip"),
    (".jar", "application/java-archive"),
    (".tar", "application/x-tar"),
    (".gz", "application/gzip"),
    (".tgz", "application/gzip"),
    (".sqlite", "application/vnd.sqlite3"),
    (".sqlite3", "application/vnd.sqlite3"),
    (".db", "application/vnd.sqlite3"),
];
const OFFICE: &[(&str, &str)] = &[
    (
        ".docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    (
        ".xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    (
        ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    (".odt", "application/vnd.oasis.opendocument.text"),
    (".ods", "application/vnd.oasis.opendocument.spreadsheet"),
    (".odp", "application/vnd.oasis.opendocument.presentation"),
    (".rtf", "application/rtf"),
    (".epub", "application/epub+zip"),
    (".ipynb", "application/x-ipynb+json"),
];
/// Extra types an HTML preview may load next to the page (`PREVIEW_ASSET_EXTENSIONS`).
const PAGE_DEPENDENCY: &[&str] = &[
    ".htm", ".html", ".pdf", ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp",
    ".m4v", ".mp4", ".ogv", ".webm", ".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus",
    ".wav", ".css", ".js", ".mjs", ".otf", ".ttf", ".woff", ".woff2",
];

fn lookup(table: &[(&str, &'static str)], extension: &str) -> Option<&'static str> {
    let extension = extension.to_ascii_lowercase();
    table
        .iter()
        .find(|(e, _)| *e == extension)
        .map(|(_, mime)| *mime)
}

fn valid_extension(extension: &str) -> bool {
    extension.len() > 1
        && extension.starts_with('.')
        && extension[1..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `hostPreviewMimeTypeFromExtension`: the type a host file is served as, or `None` when no
/// viewer previews it.
pub fn host_preview_mime(extension: &str) -> Option<&'static str> {
    if !valid_extension(extension) {
        return None;
    }
    [IMAGE, VIDEO, AUDIO, BROWSER, FONT, BINARY, OFFICE]
        .iter()
        .find_map(|table| lookup(table, extension))
}

pub fn is_image_path(path: &str) -> bool {
    lookup(IMAGE, &crate::paths::extension(path)).is_some()
}

pub fn is_audio_path(path: &str) -> bool {
    lookup(AUDIO, &crate::paths::extension(path)).is_some()
}

pub fn is_video_path(path: &str) -> bool {
    lookup(VIDEO, &crate::paths::extension(path)).is_some()
}

/// `isWorkspacePreviewEntryPath`: browser documents, images, fonts, office and archives.
pub fn is_workspace_preview_path(path: &str) -> bool {
    let extension = crate::paths::extension(path);
    [IMAGE, BROWSER, FONT, BINARY, OFFICE]
        .iter()
        .any(|table| lookup(table, &extension).is_some())
}

pub fn is_page_dependency(path: &str) -> bool {
    PAGE_DEPENDENCY.contains(&crate::paths::extension(path).as_str())
}

/// `isProjectFaviconPath`: images plus `.icns`.
pub fn is_favicon_path(path: &str) -> bool {
    is_image_path(path) || crate::paths::extension(path) == ".icns"
}

/// A `Content-Type` guess for a served file, from its extension.
pub fn content_type(path: &str) -> &'static str {
    let extension = crate::paths::extension(path);
    host_preview_mime(&extension)
        .or(match extension.as_str() {
            ".css" => Some("text/css; charset=utf-8"),
            ".js" | ".mjs" => Some("text/javascript; charset=utf-8"),
            ".json" => Some("application/json"),
            ".txt" | ".md" => Some("text/plain; charset=utf-8"),
            _ => None,
        })
        .unwrap_or("application/octet-stream")
}

/// `inferImageExtension`: the stored extension of an uploaded image.
pub fn image_extension(mime_type: &str, file_name: &str) -> String {
    let from_mime = match mime_type.to_ascii_lowercase().as_str() {
        "image/avif" => ".avif",
        "image/bmp" => ".bmp",
        "image/gif" => ".gif",
        "image/heic" => ".heic",
        "image/heif" => ".heif",
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/png" => ".png",
        "image/svg+xml" => ".svg",
        "image/tiff" => ".tiff",
        "image/webp" => ".webp",
        "image/x-icon" | "image/vnd.microsoft.icon" => ".ico",
        _ => "",
    };
    if !from_mime.is_empty() {
        return from_mime.into();
    }
    let extension = crate::paths::extension(file_name.trim());
    let safe = [
        ".avif", ".bmp", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg", ".png", ".svg",
        ".tiff", ".webp",
    ];
    if extension.len() <= 9 && safe.contains(&extension.as_str()) {
        extension
    } else {
        ".bin".into()
    }
}

/// `fileHeaderMimeType`: a type for an extensionless file, from its first bytes.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8], at: usize| bytes.get(at..at + sig.len()) == Some(sig);
    if starts(b"\x89PNG\r\n\x1a\n", 0) {
        return Some("image/png");
    }
    if starts(b"\xff\xd8\xff", 0) {
        return Some("image/jpeg");
    }
    if starts(b"PK\x03\x04", 0) {
        return Some("application/zip");
    }
    if starts(b"RIFF", 0) && starts(b"WEBP", 8) {
        return Some("image/webp");
    }
    if starts(b"GIF87a", 0) || starts(b"GIF89a", 0) {
        return Some("image/gif");
    }
    if starts(b"%PDF-", 0) {
        return Some("application/pdf");
    }
    if starts(b"SQLite format 3\0", 0) {
        return Some("application/vnd.sqlite3");
    }
    if !starts(b"#!", 0) {
        return None;
    }
    let line = bytes.split(|&b| b == b'\n').next().unwrap_or_default();
    let line = String::from_utf8_lossy(line);
    let word = |w: &str| {
        line.split(|c: char| !(c.is_alphanumeric() || c == '.' || c == '_'))
            .any(|token| token == w || (w == "python" && token.starts_with("python")))
    };
    if word("python") {
        Some("text/x-python")
    } else if word("node") || word("nodejs") {
        Some("text/javascript")
    } else if word("ruby") {
        Some("text/x-ruby")
    } else if ["sh", "bash", "zsh", "fish"].iter().any(|w| word(w)) {
        Some("text/x-shellscript")
    } else {
        None
    }
}

/// Bytes read from a file's start to find its image size (`IMAGE_DIMENSIONS_HEADER_BYTES`).
pub const IMAGE_HEADER_BYTES: usize = 256 * 1024;

/// `readImageDimensions`: PNG, GIF, WebP and JPEG (with EXIF rotation).
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = png(bytes)
        .or_else(|| gif(bytes))
        .or_else(|| webp(bytes))
        .or_else(|| jpeg(bytes))?;
    (w > 0 && h > 0).then_some((w, h))
}

fn be16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}
fn le16(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn png(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || &b[..4] != b"\x89PNG" || &b[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(b[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(b[20..24].try_into().ok()?);
    Some((w, h))
}

fn gif(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 10 || &b[..4] != b"GIF8" {
        return None;
    }
    Some((le16(b, 6)?, le16(b, 8)?))
}

fn webp(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 16 || &b[..4] != b"RIFF" || &b[8..12] != b"WEBP" {
        return None;
    }
    match &b[12..16] {
        b"VP8 " if b.len() >= 30 => Some((le16(b, 26)? & 0x3fff, le16(b, 28)? & 0x3fff)),
        b"VP8L" if b.len() >= 25 => {
            let packed = u32::from_le_bytes(b[21..25].try_into().ok()?);
            Some(((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1))
        }
        b"VP8X" if b.len() >= 30 => {
            let n =
                |i: usize| u32::from(b[i]) | u32::from(b[i + 1]) << 8 | u32::from(b[i + 2]) << 16;
            Some((n(24) + 1, n(27) + 1))
        }
        _ => None,
    }
}

fn jpeg(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[0] != 0xff || b[1] != 0xd8 {
        return None;
    }
    let mut offset = 2;
    let mut rotated = false;
    while offset + 9 <= b.len() {
        if b[offset] != 0xff {
            return None;
        }
        let marker = b[offset + 1];
        if marker == 0xff {
            offset += 1;
            continue;
        }
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let h = be16(b, offset + 5)?;
            let w = be16(b, offset + 7)?;
            return Some(if rotated { (h, w) } else { (w, h) });
        }
        if marker == 0xd9 || marker == 0xda {
            return None;
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            offset += 2;
            continue;
        }
        let length = be16(b, offset + 2)? as usize;
        if marker == 0xe1 && !rotated {
            rotated = exif_swaps_axes(b, offset + 4, offset + 2 + length);
        }
        offset += 2 + length;
    }
    None
}

fn exif_swaps_axes(b: &[u8], start: usize, end: usize) -> bool {
    let end = end.min(b.len());
    if end < start + 14 || &b[start..start + 4] != b"Exif" {
        return false;
    }
    let tiff = start + 6;
    let little = match &b[tiff..tiff + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let u16_at = |i: usize| -> Option<u32> {
        if i + 2 > end {
            return None;
        }
        if little { le16(b, i) } else { be16(b, i) }
    };
    let u32_at = |i: usize| -> Option<usize> {
        if i + 4 > end {
            return None;
        }
        let bytes: [u8; 4] = b[i..i + 4].try_into().ok()?;
        Some(if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        } as usize)
    };
    let Some(ifd) = u32_at(tiff + 4).map(|o| tiff + o) else {
        return false;
    };
    let Some(count) = u16_at(ifd) else {
        return false;
    };
    for i in 0..count as usize {
        let entry = ifd + 2 + i * 12;
        if u16_at(entry) == Some(0x0112) {
            return matches!(u16_at(entry + 8), Some(5..=8));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions() {
        assert_eq!(host_preview_mime(".PNG"), Some("image/png"));
        assert_eq!(host_preview_mime(".mp4"), Some("video/mp4"));
        assert_eq!(host_preview_mime(".rs"), None);
        assert!(is_workspace_preview_path("docs/a.pdf"));
        assert!(!is_workspace_preview_path("src/a.ts"));
        assert!(is_favicon_path("Resources/AppIcon.icns"));
        assert_eq!(image_extension("image/png", "x"), ".png");
        assert_eq!(image_extension("image/x-unknown", "a.WEBP"), ".webp");
        assert_eq!(image_extension("text/plain", "a.txt"), ".bin");
        assert_eq!(sniff(b"#!/usr/bin/env python3\n"), Some("text/x-python"));
        assert_eq!(sniff(b"%PDF-1.4"), Some("application/pdf"));
    }

    /// `PREVIEW_ASSET_EXTENSIONS` in the T3 server's `AssetAccess.ts`, plus the browser
    /// documents it spreads in: a change there fails here.
    #[test]
    fn page_dependencies_follow_the_t3_server() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        let read = |path: &str| std::fs::read_to_string(root.join(path)).unwrap();
        let literals = |text: &str| -> Vec<String> {
            text.split('"')
                .skip(1)
                .step_by(2)
                .filter(|s| s.starts_with('.'))
                .map(str::to_owned)
                .collect()
        };
        let shared = read("packages/shared/src/filePreview.ts");
        let browser = shared
            .split("WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .unwrap();
        let access = read("apps/server/src/assets/AssetAccess.ts");
        let set = access
            .split("PREVIEW_ASSET_EXTENSIONS = new Set([")
            .nth(1)
            .and_then(|rest| rest.split("]);").next())
            .unwrap();
        assert!(set.contains("...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS"));
        let mut expected = literals(browser);
        expected.extend(literals(set));
        assert_eq!(PAGE_DEPENDENCY, expected);
    }

    #[test]
    fn reads_image_sizes() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&3u32.to_be_bytes());
        png.extend_from_slice(&2u32.to_be_bytes());
        assert_eq!(image_dimensions(&png), Some((3, 2)));
        let gif = b"GIF89a\x05\x00\x07\x00";
        assert_eq!(image_dimensions(gif), Some((5, 7)));
        // SOF0 frame: height 4, width 6.
        let jpeg = [
            0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x04, 0x00, 0x06, 0x03,
        ];
        assert_eq!(image_dimensions(&jpeg), Some((6, 4)));
        assert_eq!(image_dimensions(b"nope"), None);
    }
}
