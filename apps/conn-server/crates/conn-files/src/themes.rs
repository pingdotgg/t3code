//! Environment themes (`environmentTheme.ts`): the theme files published in
//! `<state-dir>/themes`, their background images, and publishing one.
//!
//! The rules come from T3: `themes/upstream.json` and `themes/cases.json` are recorded by
//! `tools/gen-theme-cases.mjs`. T3 watches the folder; this server reads it again when a
//! caller asks (`refresh`), and a config subscription asks once a second. A folder whose
//! entries did not change is not read again.

use std::{
    collections::HashSet,
    fs, io,
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::watch;

use conn_support::text::js_trim;

const THEME_FILE_SUFFIX: &str = ".json";
const MAX_THEME_FILES: usize = 32;
/// `6 * THEME_CSS_MAX_LENGTH + 16 * 1024`.
pub const MAX_THEME_FILE_BYTES: u64 = 6 * THEME_CSS_MAX_LENGTH as u64 + 16 * 1024;
const MAX_THEME_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const THEME_BACKGROUND_EXTENSIONS: [&str; 4] = ["webp", "png", "jpg", "jpeg"];
const MAX_THEME_BACKGROUND_BYTES: u64 = 16 * 1024 * 1024;
const THEME_CSS_MAX_LENGTH: usize = 100_000;

const INVALID_ID: &str =
    "is not a valid theme id. Use lowercase letters, digits, and hyphens, and not a built-in name.";
const NOT_PUBLISHED: &str =
    "could not be published. The themes directory may be full or not writable.";

/// What T3's shared theme modules hold, recorded by `gen-theme-cases.mjs`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    /// `THEME_GUIDE`.
    pub guide: String,
    /// `MOBILE_THEME_IDS`.
    pub built_in: Vec<String>,
    /// `MOBILE_DEFAULT_THEME_ID`.
    pub default_id: String,
    /// `UNPUBLISHABLE_THEME_IDS`.
    pub unpublishable: Vec<String>,
}

/// The recorded upstream tables. The test below proves they parse.
pub fn upstream() -> &'static Upstream {
    static UPSTREAM: OnceLock<Upstream> = OnceLock::new();
    UPSTREAM.get_or_init(|| {
        serde_json::from_str(include_str!("themes/upstream.json")).unwrap_or(Upstream {
            guide: String::new(),
            built_in: Vec::new(),
            default_id: String::new(),
            unpublishable: Vec::new(),
        })
    })
}

/// `EnvironmentThemeRefusedError`: `Theme "<id>" <problem>[ Available: <known>.]`.
#[derive(Clone, Debug, PartialEq)]
pub struct Refused {
    pub theme_id: String,
    pub problem: String,
    pub known: Option<Vec<String>>,
}

impl Refused {
    pub fn new(theme_id: &str, problem: impl Into<String>) -> Self {
        Self {
            theme_id: theme_id.to_owned(),
            problem: problem.into(),
            known: None,
        }
    }

    pub fn invalid_id(theme_id: &str) -> Self {
        Self::new(theme_id, INVALID_ID)
    }

    pub fn message(&self) -> String {
        let known = self
            .known
            .as_ref()
            .map(|known| format!(" Available: {}.", known.join(", ")))
            .unwrap_or_default();
        format!("Theme \"{}\" {}{known}", self.theme_id, self.problem)
    }
}

/// `EnvironmentThemeId`: `^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$`.
pub fn is_theme_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    let first_ok = bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    first_ok
        && id.len() <= 48
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !matches!(id, "system" | "light" | "dark")
}

pub fn is_unpublishable(id: &str) -> bool {
    upstream().unpublishable.iter().any(|known| known == id)
}

fn is_color(value: &str) -> bool {
    value
        .strip_prefix('#')
        .is_some_and(|hex| matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The key pattern of a colors record: `^[a-zA-Z][a-zA-Z0-9]{0,63}$`.
fn is_color_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && key.len() <= 64
        && bytes.all(|b| b.is_ascii_alphanumeric())
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `TrimmedNonEmptyString` with a maximum length in UTF-16 units: the trimmed text.
fn trimmed(value: &Value, max: usize) -> Option<Value> {
    let text = js_trim(value.as_str()?);
    (!text.is_empty() && utf16_len(text) <= max).then(|| Value::String(text.to_owned()))
}

/// A colors record: keys that miss the pattern are dropped, as Effect's record decode does;
/// every kept value must be a valid role color.
fn colors(value: &Value) -> Option<Value> {
    let mut out = Map::new();
    for (key, value) in value.as_object()? {
        if is_color_key(key) {
            out.insert(key.clone(), trimmed(value, 64)?);
        }
    }
    Some(Value::Object(out))
}

/// `EnvironmentThemeFile` decoded from JSON: unknown keys dropped, texts trimmed. `None`
/// where T3's decode fails.
pub fn decode_theme_file(value: &Value) -> Option<Map<String, Value>> {
    let input = value.as_object()?;
    let mut out = Map::new();
    if let Some(version) = input.get("version") {
        (version.as_f64() == Some(1.0)).then_some(())?;
        out.insert("version".into(), Value::from(1));
    }
    out.insert("name".into(), trimmed(input.get("name")?, 48)?);
    let appearance = input.get("appearance")?.as_str()?;
    matches!(appearance, "light" | "dark").then_some(())?;
    out.insert("appearance".into(), Value::from(appearance));
    for key in ["canvas", "accent"] {
        if let Some(color) = input.get(key) {
            is_color(color.as_str()?).then_some(())?;
            out.insert(key.into(), color.clone());
        }
    }
    if let Some(value) = input.get("colors") {
        out.insert("colors".into(), colors(value)?);
    }
    if let Some(value) = input.get("variants") {
        let variants = value.as_object()?;
        let mut decoded = Map::new();
        for key in ["light", "dark"] {
            if let Some(value) = variants.get(key) {
                decoded.insert(key.into(), colors(value)?);
            }
        }
        out.insert("variants".into(), Value::Object(decoded));
    }
    if let Some(css) = input.get("css") {
        (utf16_len(css.as_str()?) <= THEME_CSS_MAX_LENGTH).then_some(())?;
        out.insert("css".into(), css.clone());
    }
    Some(out)
}

/// `environmentThemeFileHasColors`.
pub fn has_colors(file: &Map<String, Value>) -> bool {
    (file.contains_key("canvas") && file.contains_key("accent"))
        || file
            .get("colors")
            .and_then(Value::as_object)
            .is_some_and(|colors| !colors.is_empty())
}

fn starts_with_ci(text: &[u8], prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn is_css_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r')
}

/// The end (exclusive) of a string that opens at `at` with `quote` and closes on that line.
fn string_end(code: &[u8], at: usize) -> Option<usize> {
    let quote = *code.get(at)?;
    let rest = code.get(at + 1..)?;
    let close = rest
        .iter()
        .position(|&b| b == quote || matches!(b, b'\n' | b'\r' | b'\x0c'))?;
    (rest.get(close) == Some(&quote)).then_some(at + 1 + close + 1)
}

/// `withoutStrings`: the code with its strings removed, keeping `url(` where a quoted url()
/// can load a file. Every pattern byte is ASCII, so a byte scan finds what the regex does.
fn without_strings(code: &str) -> Vec<u8> {
    let code = code.as_bytes();
    let mut out = Vec::with_capacity(code.len());
    let mut at = 0;
    while let Some(&byte) = code.get(at) {
        let rest = code.get(at..).unwrap_or_default();
        if starts_with_ci(rest, "url(") {
            let mut quote_at = at + 4;
            while code.get(quote_at).copied().is_some_and(is_css_space) {
                quote_at += 1;
            }
            match code.get(quote_at) {
                Some(b'"' | b'\'') => {
                    if let Some(end) = string_end(code, quote_at) {
                        let inner = code.get(quote_at + 1..).unwrap_or_default();
                        if !(starts_with_ci(inner, "data:") || inner.first() == Some(&b'#')) {
                            out.extend_from_slice(b"url(");
                        }
                        at = end;
                        continue;
                    }
                }
                _ => {
                    let close = rest.iter().position(|&b| b == b')').unwrap_or(rest.len());
                    out.extend_from_slice(rest.get(..close).unwrap_or_default());
                    at += close;
                    continue;
                }
            }
        } else if matches!(byte, b'"' | b'\'')
            && let Some(end) = string_end(code, at)
        {
            at = end;
            continue;
        }
        out.push(byte);
        at += 1;
    }
    out
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `fetchesOutsideStrings`: `image-set(`, `src(` at a word start, or a `url(` that is not
/// `data:` or `#id`.
fn fetches_outside_strings(code: &[u8]) -> bool {
    (0..code.len()).any(|at| {
        let rest = code.get(at..).unwrap_or_default();
        if starts_with_ci(rest, "image-set(") {
            return true;
        }
        if starts_with_ci(rest, "src(") {
            let boundary = at == 0 || !code.get(at - 1).copied().is_some_and(is_word);
            if boundary {
                return true;
            }
        }
        if starts_with_ci(rest, "url(") {
            let mut next = at + 4;
            while code.get(next).copied().is_some_and(is_css_space) {
                next += 1;
            }
            if matches!(code.get(next), Some(b'"' | b'\'')) {
                next += 1;
            }
            let tail = code.get(next..).unwrap_or_default();
            return !(starts_with_ci(tail, "data:") || tail.first() == Some(&b'#'));
        }
        false
    })
}

/// `themeCssLoadsRemoteFiles`: comments out, then strings out, then `@import` or a fetch.
pub fn css_loads_remote_files(css: &str) -> bool {
    let mut uncommented = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(open) = rest.find("/*") {
        let Some(close) = rest.get(open + 2..).and_then(|after| after.find("*/")) else {
            break;
        };
        uncommented.push_str(rest.get(..open).unwrap_or_default());
        rest = rest.get(open + 2 + close + 2..).unwrap_or_default();
    }
    uncommented.push_str(rest);
    let code = without_strings(&uncommented);
    code.windows(7).any(|w| w.eq_ignore_ascii_case(b"@import")) || fetches_outside_strings(&code)
}

/// `readThemeFileGuarded`: a regular file of at most `max` bytes, read without following a
/// link or blocking on a FIFO, decoded as `TextDecoder` does (BOM dropped, bad bytes replaced).
pub fn read_guarded(path: &Path, max: u64) -> Option<String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(crate::workspace::flags::O_NONBLOCK | crate::workspace::flags::O_NOFOLLOW);
    #[cfg(not(unix))]
    if fs::symlink_metadata(path).ok()?.file_type().is_symlink() {
        return None;
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max).read_to_end(&mut bytes).ok()?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn base36(mut value: u128) -> String {
    let mut digits = Vec::new();
    loop {
        let digit = u32::try_from(value % 36).unwrap_or(0);
        digits.push(char::from_digit(digit, 36).unwrap_or('0'));
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.iter().rev().collect()
}

fn signed_base36(value: i128) -> String {
    let text = base36(value.unsigned_abs());
    if value < 0 { format!("-{text}") } else { text }
}

#[cfg(unix)]
fn revision(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    format!(
        "{}-{}-{}",
        base36(u128::from(meta.ino())),
        base36(u128::from(meta.size())),
        signed_base36(mtime_ns)
    )
}

#[cfg(not(unix))]
fn revision(meta: &fs::Metadata) -> String {
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("0-{}-{}", base36(u128::from(meta.len())), base36(mtime_ns))
}

/// `findThemeBackground`: the first of `<id>.webp|png|jpg|jpeg` that is a regular file (not a
/// link) of at most 16 MiB. `entries` skips names a directory scan did not list.
pub fn find_background(
    dir: &Path,
    theme_id: &str,
    entries: Option<&HashSet<String>>,
) -> Option<(PathBuf, String)> {
    THEME_BACKGROUND_EXTENSIONS.iter().find_map(|extension| {
        let name = format!("{theme_id}.{extension}");
        if entries.is_some_and(|entries| !entries.contains(&name)) {
            return None;
        }
        let path = dir.join(&name);
        let meta = fs::symlink_metadata(&path).ok()?;
        (meta.is_file() && meta.len() <= MAX_THEME_BACKGROUND_BYTES)
            .then(|| (path, revision(&meta)))
    })
}

/// `readPublishedThemes`: the valid themes in `dir`, by file name, within the count and size
/// limits, each `{ id, ...file, background? }`.
pub fn read_published(dir: &Path) -> Vec<Value> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let entries: HashSet<String> = names.iter().cloned().collect();
    let mut themes = Vec::new();
    let mut examined = 0;
    let mut total_bytes = 0;
    for name in &names {
        let Some(id) = name.strip_suffix(THEME_FILE_SUFFIX) else {
            continue;
        };
        if !is_theme_id(id) || is_unpublishable(id) {
            continue;
        }
        examined += 1;
        if examined > MAX_THEME_FILES {
            break;
        }
        let Some(raw) = read_guarded(&dir.join(name), MAX_THEME_FILE_BYTES) else {
            continue;
        };
        if js_trim(&raw).is_empty() {
            continue;
        }
        let Some(file) = serde_json::from_str::<Value>(&raw)
            .ok()
            .as_ref()
            .and_then(decode_theme_file)
        else {
            continue;
        };
        if !has_colors(&file) {
            continue;
        }
        total_bytes += raw.len();
        if total_bytes > MAX_THEME_TOTAL_BYTES {
            break;
        }
        let mut theme = Map::new();
        theme.insert("id".into(), Value::from(id));
        theme.extend(file);
        if let Some((_, revision)) = find_background(dir, id, Some(&entries)) {
            theme.insert("background".into(), Value::from(revision));
        }
        themes.push(Value::Object(theme));
    }
    themes
}

/// What is published now; `seq` grows with each change.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub seq: u64,
    pub themes: Arc<Vec<Value>>,
}

impl Snapshot {
    pub fn ids(&self) -> Vec<String> {
        self.themes
            .iter()
            .filter_map(|theme| theme["id"].as_str().map(str::to_owned))
            .collect()
    }
}

#[derive(Default)]
struct State {
    snapshot: Snapshot,
    /// The listing the snapshot was read from: name, inode, size, change time.
    listing: Option<Vec<(String, u64, u64, i128)>>,
}

/// The themes folder of one server. Cheap to clone.
#[derive(Clone)]
pub struct Themes {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    /// Held only to read or swap the snapshot, never across file reads.
    state: Mutex<State>,
    /// One folder read at a time, so an older read never replaces a newer one.
    reading: Mutex<()>,
    changes: watch::Sender<u64>,
    /// `publishSemaphore`: one publish-and-select at a time.
    publish: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for Themes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Themes")
            .field("dir", &self.inner.dir)
            .finish_non_exhaustive()
    }
}

#[cfg(unix)]
fn listing_entry(name: String, meta: &fs::Metadata) -> (String, u64, u64, i128) {
    use std::os::unix::fs::MetadataExt;
    let ctime = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
    let mtime = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    (name, meta.ino(), meta.size(), ctime ^ (mtime << 1))
}

#[cfg(not(unix))]
fn listing_entry(name: String, meta: &fs::Metadata) -> (String, u64, u64, i128) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as i128);
    (name, 0, meta.len(), mtime)
}

/// Every entry that can change what is published, with what changes when it is rewritten.
/// `None` when the folder cannot be listed.
fn listing(dir: &Path) -> Option<Vec<(String, u64, u64, i128)>> {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().into_string().ok()?;
            let relevant = name.ends_with(THEME_FILE_SUFFIX)
                || THEME_BACKGROUND_EXTENSIONS
                    .iter()
                    .any(|extension| name.ends_with(&format!(".{extension}")));
            relevant.then_some(())?;
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            Some(listing_entry(name, &meta))
        })
        .collect();
    entries.sort();
    Some(entries)
}

impl Themes {
    /// The folder `<state-dir>/themes`, created when missing.
    pub fn open(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        Self {
            inner: Arc::new(Inner {
                dir,
                state: Mutex::default(),
                reading: Mutex::new(()),
                changes: watch::Sender::new(0),
                publish: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.inner.changes.subscribe()
    }

    /// The last snapshot read, without touching the folder.
    pub fn current(&self) -> Snapshot {
        self.lock().snapshot.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Reads the folder again when its listing changed, and notifies subscribers when the
    /// published themes did. Blocking.
    pub fn refresh(&self) -> Snapshot {
        let _reading = self
            .inner
            .reading
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let listing = listing(&self.inner.dir);
        {
            let state = self.lock();
            if listing.is_some() && state.listing == listing {
                return state.snapshot.clone();
            }
        }
        let themes = read_published(&self.inner.dir);
        let mut state = self.lock();
        state.listing = listing;
        if *state.snapshot.themes != themes {
            state.snapshot = Snapshot {
                seq: state.snapshot.seq + 1,
                themes: Arc::new(themes),
            };
            self.inner.changes.send_replace(state.snapshot.seq);
        }
        state.snapshot.clone()
    }

    /// Holds the publish lock: one publish-and-select at a time.
    pub async fn lock_publish(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.publish.lock().await
    }

    /// `publish`: writes `file` as `<id>.json` and proves it is served without pushing another
    /// theme out. Returns what undoes it. Callers hold [`Self::lock_publish`]. Blocking.
    pub fn publish(&self, theme_id: &str, file: &Map<String, Value>) -> Result<Revert, Refused> {
        if is_unpublishable(theme_id) {
            return Err(Refused::invalid_id(theme_id));
        }
        if !has_colors(file) {
            return Err(Refused::new(
                theme_id,
                "has no colors. Give canvas and accent, or at least one color role.",
            ));
        }
        if file
            .get("css")
            .and_then(Value::as_str)
            .is_some_and(css_loads_remote_files)
        {
            return Err(Refused::new(
                theme_id,
                "has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.",
            ));
        }
        let contents = serde_json::to_string_pretty(file)
            .map_err(|_| Refused::new(theme_id, NOT_PUBLISHED))?;
        if contents.len() as u64 > MAX_THEME_FILE_BYTES {
            return Err(Refused::new(
                theme_id,
                format!("is larger than {MAX_THEME_FILE_BYTES} bytes."),
            ));
        }
        let destination = self
            .inner
            .dir
            .join(format!("{theme_id}{THEME_FILE_SUFFIX}"));
        let previous = read_guarded(&destination, MAX_THEME_FILE_BYTES);
        if previous.is_none() && fs::symlink_metadata(&destination).is_ok() {
            return Err(Refused::new(
                theme_id,
                "would replace a file that could not be backed up. Use another theme id.",
            ));
        }
        let served_before = self.refresh().ids();
        let revert = Revert {
            themes: self.clone(),
            destination: destination.clone(),
            previous,
        };
        fs::create_dir_all(&self.inner.dir)
            .and_then(|()| replace(&destination, &contents))
            .map_err(|_| Refused::new(theme_id, NOT_PUBLISHED))?;
        let served = self.refresh().ids();
        if served.iter().any(|id| id == theme_id)
            && served_before.iter().all(|id| served.contains(id))
        {
            return Ok(revert);
        }
        revert.run();
        Err(Refused::new(theme_id, NOT_PUBLISHED))
    }
}

/// Writes through a staging file created exclusively, then renames it over `destination`.
fn replace(destination: &Path, contents: &str) -> io::Result<()> {
    use std::io::Write;
    let mut staging = destination.as_os_str().to_owned();
    staging.push(format!(".staging-{}", std::process::id()));
    let staging = PathBuf::from(staging);
    let _ = fs::remove_file(&staging);
    let result = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .and_then(|mut file| file.write_all(contents.as_bytes()))
        .and_then(|()| fs::rename(&staging, destination));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

/// Puts back what a publish replaced, so a failed apply does not take a working theme away.
#[derive(Debug)]
pub struct Revert {
    themes: Themes,
    destination: PathBuf,
    previous: Option<String>,
}

impl Revert {
    /// Blocking.
    pub fn run(self) {
        let _ = match &self.previous {
            None => fs::remove_file(&self.destination).or_else(|e| {
                if e.kind() == io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(e)
                }
            }),
            Some(previous) => replace(&self.destination, previous),
        };
        self.themes.refresh();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    enum Case {
        File {
            raw: String,
            decoded: Option<String>,
            #[serde(default)]
            encoded: Option<String>,
            #[serde(default, rename = "hasColors")]
            has_colors: Option<bool>,
        },
        Id {
            id: String,
            valid: bool,
            unpublishable: bool,
        },
        Css {
            css: String,
            loads: bool,
        },
    }

    #[test]
    fn upstream_tables_parse() {
        let upstream = upstream();
        assert!(upstream.guide.contains("themesDir"));
        assert!(upstream.built_in.contains(&upstream.default_id));
        assert!(is_unpublishable(&upstream.default_id));
    }

    /// T3's own decode, encode and checks (`gen-theme-cases.mjs`).
    #[test]
    fn matches_the_recorded_t3_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("themes/cases.json")).unwrap();
        let mut checked = 0;
        for case in cases {
            match case {
                Case::File {
                    raw,
                    decoded,
                    encoded,
                    has_colors: colors,
                } => {
                    // T3 parses after TextDecoder; a BOM there fails JSON.parse.
                    let ours = if raw.starts_with('\u{feff}') {
                        None
                    } else {
                        serde_json::from_str::<Value>(&raw)
                            .ok()
                            .as_ref()
                            .and_then(decode_theme_file)
                    };
                    if raw.contains("\\ud800") {
                        // serde_json refuses a lone surrogate that JSON.parse keeps.
                        assert!(decoded.is_some());
                        continue;
                    }
                    let expected: Option<Value> =
                        decoded.as_deref().map(|d| serde_json::from_str(d).unwrap());
                    assert_eq!(ours.clone().map(Value::Object), expected, "{raw}");
                    if let (Some(ours), Some(encoded)) = (ours, encoded) {
                        let ours_text = serde_json::to_string_pretty(&ours).unwrap();
                        assert_eq!(ours_text.len(), encoded.len(), "{raw}");
                        let theirs: Value = serde_json::from_str(&encoded).unwrap();
                        assert_eq!(Value::Object(ours.clone()), theirs, "{raw}");
                        assert_eq!(Some(has_colors(&ours)), colors, "{raw}");
                    }
                }
                Case::Id {
                    id,
                    valid,
                    unpublishable,
                } => {
                    assert_eq!(is_theme_id(&id), valid, "{id}");
                    assert_eq!(is_unpublishable(&id), unpublishable, "{id}");
                }
                Case::Css { css, loads } => {
                    assert_eq!(css_loads_remote_files(&css), loads, "{css:?}");
                }
            }
            checked += 1;
        }
        assert!(checked > 100);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "conn-themes-{name}-{}-{}",
            std::process::id(),
            conn_support::uuid_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn night() -> Map<String, Value> {
        decode_theme_file(&serde_json::json!({
            "name": " Night ", "appearance": "dark", "canvas": "#101010", "accent": "#ff8800"
        }))
        .unwrap()
    }

    #[test]
    fn publishes_reads_and_reverts() {
        let dir = temp_dir("publish");
        let themes = Themes::open(dir.clone());
        let mut rx = themes.subscribe();
        assert!(themes.refresh().themes.is_empty());
        let revert = themes.publish("night", &night()).unwrap();
        assert!(rx.has_changed().unwrap());
        rx.mark_unchanged();
        let snapshot = themes.current();
        assert_eq!(snapshot.ids(), vec!["night"]);
        assert_eq!(snapshot.themes[0]["name"], "Night");
        assert!(snapshot.themes[0].get("background").is_none());
        fs::write(dir.join("night.png"), b"png").unwrap();
        let with_background = themes.refresh();
        assert!(with_background.themes[0]["background"].is_string());
        assert!(rx.has_changed().unwrap());
        revert.run();
        assert!(themes.current().themes.is_empty());
        assert!(!dir.join("night.json").exists());
        assert!(find_background(&dir, "night", None).is_some());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_what_t3_refuses() {
        let dir = temp_dir("refuse");
        let themes = Themes::open(dir.clone());
        let message = |r: Result<Revert, Refused>| r.err().unwrap().message();
        assert_eq!(
            message(themes.publish("grove", &night())),
            format!("Theme \"grove\" {INVALID_ID}")
        );
        let mut plain = night();
        plain.remove("accent");
        assert!(message(themes.publish("plain", &plain)).ends_with("at least one color role."));
        let mut remote = night();
        remote.insert("css".into(), Value::from("@import 'x';"));
        assert!(message(themes.publish("remote", &remote)).contains("loads files"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/nowhere", dir.join("linked.json")).unwrap();
            assert!(message(themes.publish("linked", &night())).contains("backed up"));
        }
        // A file past the count limit is not served, so the publish is undone.
        for n in 0..MAX_THEME_FILES {
            fs::write(
                dir.join(format!("a{n:02}.json")),
                serde_json::to_string(&night()).unwrap(),
            )
            .unwrap();
        }
        assert!(message(themes.publish("zz", &night())).contains("could not be published"));
        assert!(!dir.join("zz.json").exists());
        assert_eq!(themes.current().themes.len(), MAX_THEME_FILES);
        fs::remove_dir_all(dir).unwrap();
    }
}
