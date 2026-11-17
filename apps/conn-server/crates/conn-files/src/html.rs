//! HTML render publication without starting a browser. All calls block; use `spawn_blocking`.

use std::{collections::HashMap, fs, io::Read, path::Path, sync::OnceLock};

use regex_automata::meta::Regex;
use serde::{Deserialize, Serialize};

use crate::{Files, attachments, paths};

const MAX_PAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

macro_rules! pattern {
    ($source:literal) => {{
        static RE: OnceLock<Option<Regex>> = OnceLock::new();
        RE.get_or_init(|| {
            Regex::builder()
                .configure(
                    Regex::config()
                        .hybrid_cache_capacity(64 * 1024)
                        .dfa_size_limit(Some(64 * 1024)),
                )
                .build($source)
                .ok()
        })
        .as_ref()
        .ok_or_else(store_error)?
    }};
}

/// A page rejected before publication, or an attachment that could not be saved.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum HtmlError {
    #[error("{0}")]
    Invalid(String),
    #[error("The HTML render could not be saved.")]
    Store,
}

impl HtmlError {
    fn file(path: &str) -> Self {
        Self::Invalid(format!(
            "{path} is not a readable HTML document. Pass an absolute path to a regular .html file that starts with <!doctype html> or <html>, or pass html instead."
        ))
    }
}

/// The render reference carried by a provider tool result and read by clients.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub attachment_id: String,
    pub title: String,
    pub height: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    markup: String,
    min_height: i64,
    max_height: i64,
    max_title_length: usize,
}

fn bootstrap() -> Result<&'static Bootstrap, HtmlError> {
    static DATA: OnceLock<Option<Bootstrap>> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(include_str!("html-bootstrap.json")).ok())
        .as_ref()
        .ok_or_else(store_error)
}

/// Reads a canonical, single-link HTML document without following a swapped-in link or FIFO.
pub fn read_source(files: &Files, path: &str) -> Result<String, HtmlError> {
    let unreadable = || HtmlError::file(path);
    if !Path::new(path).is_absolute() || paths::is_network_path(path) {
        return Err(unreadable());
    }
    let real = fs::canonicalize(path).map_err(|_| unreadable())?;
    if !matches!(
        paths::extension(&real.to_string_lossy()).as_str(),
        ".html" | ".htm"
    ) || files.internal.contains(&real)
    {
        return Err(unreadable());
    }
    let before = fs::symlink_metadata(&real).map_err(|_| unreadable())?;
    if !before.is_file() {
        return Err(unreadable());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            crate::workspace::flags::O_NOFOLLOW | crate::workspace::flags::O_NONBLOCK,
        );
    }
    let file = options.open(&real).map_err(|_| unreadable())?;
    let info = file.metadata().map_err(|_| unreadable())?;
    let after = fs::symlink_metadata(&real).map_err(|_| unreadable())?;
    if !info.is_file() || !after.is_file() || fs::canonicalize(&real).ok().as_ref() != Some(&real) {
        return Err(unreadable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if info.nlink() != 1
            || info.ino() == 0
            || (info.dev(), info.ino()) != (before.dev(), before.ino())
            || (info.dev(), info.ino()) != (after.dev(), after.ino())
        {
            return Err(unreadable());
        }
    }
    if info.len() > MAX_PAGE_BYTES as u64 {
        return Err(HtmlError::Invalid(format!(
            "{path} is {}; a page must be at most 25.0 MiB.",
            mib(info.len() as usize)
        )));
    }
    let mut bytes = Vec::with_capacity(info.len() as usize);
    file.take(info.len())
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !pattern!(r"(?i)^\s*<(?:!doctype\s+html|html)[\s>]")
        .is_match(text.trim_start_matches(js_whitespace))
    {
        return Err(unreadable());
    }
    Ok(text)
}

/// Prepares an inline page with T3's bootstrap and validated, inlined local images.
pub fn prepare(source: &str) -> Result<String, HtmlError> {
    reject_viewport_height(source)?;
    let (html, missing) = inline_images(&inject_bootstrap(source)?)?;
    if !missing.is_empty() {
        return Err(HtmlError::Invalid(format!(
            "These local images could not be read: {}. Use absolute paths to existing image files, or remove them.",
            missing.join(", ")
        )));
    }
    Ok(html)
}

/// Prepares a draft page and reports unreadable local images without losing the draft.
pub fn prepare_preview(source: &str) -> Result<(String, Vec<String>), HtmlError> {
    reject_viewport_height(source)?;
    inline_images(&inject_bootstrap(source)?)
}

/// Saves one finished render under the thread's attachment id. No page or browser stays open.
pub fn publish(
    files: &Files,
    thread_id: &str,
    source: &str,
    title: &str,
    height: i64,
) -> Result<Reference, HtmlError> {
    let html = prepare(source)?;
    let limits = bootstrap()?;
    let segment = attachments::thread_segment(thread_id).ok_or_else(store_error)?;
    let attachment_id = format!("{segment}-{}-html", conn_support::uuid_v4());
    let path = files
        .attachments
        .path_for(&format!("{attachment_id}.html"))
        .ok_or_else(store_error)?;
    let result = (|| {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(html.as_bytes())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
        return Err(store_error());
    }
    let title = title.trim_matches(js_whitespace);
    let title = String::from_utf16_lossy(
        &title
            .encode_utf16()
            .take(limits.max_title_length)
            .collect::<Vec<_>>(),
    );
    Ok(Reference {
        attachment_id,
        title: if title.is_empty() {
            "HTML".into()
        } else {
            title
        },
        height: height.clamp(limits.min_height, limits.max_height),
    })
}

/// Deletes a released HTML page only when the id belongs to its recorded owner.
pub fn cleanup(files: &Files, thread_id: &str, attachment_id: &str) -> std::io::Result<()> {
    let Some(id) = attachments::parse_id(attachment_id) else {
        return Ok(());
    };
    if id.extension.as_deref() != Some("html")
        || attachments::thread_segment(thread_id).as_deref() != Some(id.segment.as_str())
    {
        return Ok(());
    }
    let Some(path) = files.attachments.path_for(&format!("{attachment_id}.html")) else {
        return Ok(());
    };
    match fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn store_error() -> HtmlError {
    HtmlError::Store
}
fn mib(bytes: usize) -> String {
    format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
}
fn page_size(bytes: usize) -> Result<(), HtmlError> {
    if bytes > MAX_PAGE_BYTES {
        Err(HtmlError::Invalid(format!(
            "With its images inlined the page is {}; the limit is 25.0 MiB. Use smaller images.",
            mib(bytes)
        )))
    } else {
        Ok(())
    }
}

fn reject_viewport_height(source: &str) -> Result<(), HtmlError> {
    let css = pattern!(
        r#"(?is)<!--[\s\S]*?(?:-->|$)|<style(?-u:\b)[^>]*(?:>|$)([\s\S]*?)(?:</style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))"#
    );
    let unit = pattern!(r"(?i)(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)[sld]?vh");
    for capture in css.captures_iter(source) {
        let Some(span) = (1..=4).find_map(|index| capture.get_group(index)) else {
            continue;
        };
        let Some(text) = source.get(span.start..span.end) else {
            continue;
        };
        for found in unit.find_iter(text) {
            let before = text
                .get(..found.start())
                .and_then(|s| s.chars().next_back());
            let after = text.get(found.end()..).and_then(|s| s.chars().next());
            if before.is_some_and(|c| c.is_ascii_alphanumeric() || "_.+/".contains(c))
                || after.is_some_and(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
            {
                continue;
            }
            let found = text.get(found.range()).unwrap_or_default();
            return Err(HtmlError::Invalid(format!(
                "The page uses a viewport height unit ({found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights."
            )));
        }
    }
    Ok(())
}

fn blank_non_markup(html: &str) -> Result<String, HtmlError> {
    let raw_open = pattern!(
        r"(?is)<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)(?-u:\b)|<plaintext(?-u:\b)"
    );
    let mut bytes = html.as_bytes().to_vec();
    let mut at = 0;
    while let Some(tail) = html.get(at..) {
        let Some(capture) = raw_open.captures_iter(tail).next() else {
            break;
        };
        let Some(full) = capture.get_match() else {
            break;
        };
        let start = at + full.start();
        let end = if let Some(tag) = capture
            .get_group(1)
            .and_then(|span| tail.get(span.start..span.end))
        {
            let rest = html.get(at + full.end()..).unwrap_or_default();
            pattern!(
                r"(?i)</(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\s*>"
            )
            .captures_iter(rest)
            .find_map(|closing| {
                let name = closing
                    .get_group(1)
                    .and_then(|span| rest.get(span.start..span.end))?;
                name.eq_ignore_ascii_case(tag)
                    .then(|| {
                        closing
                            .get_match()
                            .map(|matched| at + full.end() + matched.end())
                    })
                    .flatten()
            })
            .unwrap_or(html.len())
        } else if tail
            .get(full.range())
            .is_some_and(|s| s.to_ascii_lowercase().starts_with("<plaintext"))
        {
            html.len()
        } else {
            at + full.end()
        };
        if let Some(blank) = bytes.get_mut(start..end) {
            blank.fill(b' ');
        }
        at = end;
    }
    let scan = String::from_utf8_lossy(&bytes);
    let mut depth: usize = 0;
    let mut start = 0;
    let mut spans = Vec::new();
    for capture in pattern!(r"(?i)<(/?)template(?:\s[^>]*)?/?>").captures_iter(scan.as_ref()) {
        let Some(full) = capture.get_match() else {
            continue;
        };
        let closing = capture
            .get_group(1)
            .is_some_and(|span| span.end > span.start);
        if !closing {
            if depth == 0 {
                start = full.start();
            }
            depth += 1;
        } else if depth > 0 {
            depth -= 1;
            if depth == 0 {
                spans.push(start..full.end());
            }
        }
    }
    if depth > 0 {
        spans.push(start..html.len());
    }
    for span in spans {
        if let Some(blank) = bytes.get_mut(span) {
            blank.fill(b' ');
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn inject_bootstrap(html: &str) -> Result<String, HtmlError> {
    let scan = blank_non_markup(html)?;
    let mut markup = String::new();
    let first = scan.get(..scan.len().min(4096)).unwrap_or(&scan);
    if !pattern!(r"(?i)<meta\s[^>]*charset").is_match(first) {
        markup.push_str("<meta charset=\"utf-8\">");
    }
    if !pattern!(r#"(?i)<meta\s[^>]*name\s*=\s*["']?viewport"#).is_match(&scan) {
        markup.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
    }
    markup.push_str(&bootstrap()?.markup);
    if let Some(head) = pattern!(r#"(?i)<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>"#).find(&scan) {
        return Ok(insert(html, head.end(), &markup));
    }
    if let Some(root) = pattern!(r#"(?i)<html(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>"#).find(&scan) {
        return Ok(insert(html, root.end(), &format!("<head>{markup}</head>")));
    }
    let trimmed = html.trim_start_matches(js_whitespace);
    if let Some(doctype) = pattern!(r"(?i)^<!doctype[^>]*>").find(trimmed) {
        return Ok(insert(
            html,
            html.len() - trimmed.len() + doctype.end(),
            &format!("<head>{markup}</head>"),
        ));
    }
    Ok(format!("<!doctype html><head>{markup}</head>{html}"))
}

fn insert(source: &str, at: usize, inserted: &str) -> String {
    format!(
        "{}{inserted}{}",
        source.get(..at).unwrap_or_default(),
        source.get(at..).unwrap_or_default()
    )
}

struct ImageRef<'a> {
    start: usize,
    end: usize,
    path: &'a str,
}

fn image_references(html: &str) -> Result<Vec<ImageRef<'_>>, HtmlError> {
    let re = pattern!(
        r#"(?i)"((?:/|[a-z]:[\\/])[^"\r\n]*?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))"|'((?:/|[a-z]:[\\/])[^'\r\n]*?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))'|`((?:/|[a-z]:[\\/])[^`\r\n]*?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))`|url\(\s*((?:/|[a-z]:[\\/])[^\s"'`()]*?\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico))\s*\)"#
    );
    Ok(re
        .captures_iter(html)
        .filter_map(|capture| {
            let span = (1..=4).find_map(|index| capture.get_group(index))?;
            let path = html.get(span.start..span.end)?;
            let prefix = if path.starts_with('/') { 1 } else { 3 };
            let stem_length = path
                .rsplit_once('.')
                .map(|(stem, _)| stem.encode_utf16().count())
                .unwrap_or_default();
            if path.starts_with("//") || stem_length.saturating_sub(prefix) > 2048 {
                return None;
            }
            Some(ImageRef {
                start: span.start,
                end: span.end,
                path,
            })
        })
        .collect())
}

fn image_mime(path: &str) -> Option<&'static str> {
    Some(
        match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => return None,
        },
    )
}

fn inline_images(html: &str) -> Result<(String, Vec<String>), HtmlError> {
    inline_images_with_metadata(html, |path| {
        fs::metadata(path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len() as usize)
    })
}

fn inline_images_with_metadata(
    html: &str,
    mut metadata: impl FnMut(&str) -> Option<usize>,
) -> Result<(String, Vec<String>), HtmlError> {
    let refs = image_references(html)?;
    let mut files = Vec::new();
    let mut known = HashMap::new();
    for reference in &refs {
        if known.contains_key(reference.path) {
            continue;
        }
        let path = if reference.path.as_bytes().get(1) == Some(&b':') {
            reference.path.replace("\\\\", "\\")
        } else {
            reference.path.to_owned()
        };
        let size = Path::new(&path)
            .is_absolute()
            .then(|| metadata(&path))
            .flatten();
        if let Some(size) = size
            && size > MAX_IMAGE_BYTES
        {
            return Err(image_size(reference.path, size));
        }
        known.insert(reference.path, size);
        files.push((reference.path, path, size));
    }
    let projected = refs.iter().fold(html.len(), |total, reference| {
        known
            .get(reference.path)
            .copied()
            .flatten()
            .map_or(total, |size| {
                total + data_prefix(reference.path).len() + size.div_ceil(3) * 4
                    - reference.path.len()
            })
    });
    page_size(projected)?;
    let mut missing = Vec::new();
    let mut images = HashMap::new();
    let mut read_bytes = 0;
    for (reference, path, size) in files {
        let bytes = size.and_then(|_| {
            let mut bytes = Vec::new();
            // Metadata can change. Refuse a swapped-in FIFO before opening.
            let file = crate::workspace::open_nonblocking(Path::new(&path)).ok()?;
            if !file.metadata().ok()?.is_file() {
                return None;
            }
            file.take((MAX_IMAGE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .ok()?;
            Some(bytes)
        });
        let Some(bytes) = bytes.filter(|bytes| is_image(bytes)) else {
            missing.push(reference);
            continue;
        };
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(image_size(reference, bytes.len()));
        }
        read_bytes += bytes.len().div_ceil(3) * 4;
        page_size(read_bytes)?;
        images.insert(
            reference,
            format!(
                "{}{}",
                data_prefix(reference),
                conn_support::base64::encode(&bytes)
            ),
        );
    }
    let mut result = String::with_capacity(projected);
    let mut cursor = 0;
    for reference in refs {
        let Some(uri) = images.get(reference.path) else {
            continue;
        };
        result.push_str(html.get(cursor..reference.start).unwrap_or_default());
        result.push_str(uri);
        cursor = reference.end;
    }
    result.push_str(html.get(cursor..).unwrap_or_default());
    page_size(result.len())?;
    Ok((result, missing.into_iter().map(str::to_owned).collect()))
}

fn image_size(path: &str, size: usize) -> HtmlError {
    HtmlError::Invalid(format!(
        "{path} is {}; each local image must be at most 10.0 MiB.",
        mib(size)
    ))
}
fn data_prefix(path: &str) -> String {
    format!(
        "data:{};base64,",
        image_mime(path).unwrap_or("application/octet-stream")
    )
}

fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF8")
        || bytes.starts_with(b"\0\0\x01\0")
        || (bytes.starts_with(b"BM") && bytes.get(6..10) == Some(b"\0\0\0\0"))
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
        || (bytes.get(4..8) == Some(b"ftyp")
            && matches!(bytes.get(8..12), Some(b"avif" | b"avis" | b"mif1")))
        || svg_root(&String::from_utf8_lossy(
            bytes.get(..bytes.len().min(4096)).unwrap_or_default(),
        ))
}

fn svg_root(source: &str) -> bool {
    let mut rest = source.trim_start_matches(js_whitespace);
    loop {
        let token = if rest.starts_with("<?") {
            "?>"
        } else if rest.starts_with("<!--") {
            "-->"
        } else if rest
            .get(..9)
            .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))
        {
            let Some(end) = doctype_end(rest) else {
                return false;
            };
            rest = rest
                .get(end..)
                .unwrap_or_default()
                .trim_start_matches(js_whitespace);
            continue;
        } else {
            return rest
                .strip_prefix("<svg")
                .and_then(|s| s.chars().next())
                .is_some_and(|c| " \t\r\n/>".contains(c));
        };
        let Some(at) = rest.find(token) else {
            return false;
        };
        rest = rest
            .get(at + token.len()..)
            .unwrap_or_default()
            .trim_start_matches(js_whitespace);
    }
}

fn doctype_end(text: &str) -> Option<usize> {
    let mut at = 9;
    let mut subset = false;
    while let Some(tail) = text.get(at..) {
        let c = tail.chars().next()?;
        if c == '\'' || c == '"' {
            at += c.len_utf8();
            at += text.get(at..)?.find(c)? + c.len_utf8();
        } else if subset && (tail.starts_with("<!--") || tail.starts_with("<?")) {
            let token = if tail.starts_with("<!--") {
                "-->"
            } else {
                "?>"
            };
            at += tail.find(token)? + token.len();
        } else {
            match c {
                '[' => subset = true,
                ']' => subset = false,
                '>' if !subset => return Some(at + 1),
                _ => {}
            }
            at += c.len_utf8();
        }
    }
    None
}

fn js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn windows_images_are_missing_without_a_filesystem_probe() {
        let mut probes = 0;
        let result = super::inline_images_with_metadata("<img src='c:/foo.png'>", |_| {
            probes += 1;
            None
        });
        assert_eq!(probes, 0);
        assert_eq!(result.unwrap().1, vec!["c:/foo.png"]);
    }
}
