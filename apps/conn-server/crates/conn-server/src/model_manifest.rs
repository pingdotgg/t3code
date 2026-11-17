//! `userdata/model-manifest.json`, written as the T3 server's `ModelManifest.ts` writes it:
//! the model catalog fetched from T3 Code's repository, cached on disk with the time of the
//! fetch. Orbit's task turns read it to check a model before they start a thread.
//!
//! When: at start and on a 5-minute tick, a refresh fetches unless the cached manifest is
//! younger than an hour or the last try is younger than 5 minutes, and only while the setting
//! `enableProviderUpdateChecks` (default on) allows it. What: the fetched manifest, kept only
//! when it decodes as T3's schema and is not older (`updatedAt`) than the newest one this
//! server knows (the bundled one, or the cache), written atomically as
//! `{"fetchedAtMs":<ms>,"manifest":<manifest>}`. The URL, the times and the bundled
//! `updatedAt` are generated from the Conn monorepo (`tools/gen-upstream.mjs`).
//!
//! The server reads no model from the manifest itself; it only keeps the file as T3 keeps it.
//!
//! **Test seam:** `CONN_MODEL_MANIFEST_URL`, read once at start. Unset: T3's URL. `off`, empty,
//! not Unicode, or anything that is not an `http://` or `https://` URL: the server never
//! fetches (no refresh task starts). Any other value: fetch from there instead, as from a
//! loopback stub in `orbit-flow.mjs`. Every check starts servers with `off`
//! (`tools/sealed-env.mjs`, `tools/check.sh`).

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::Value;

use crate::environment::Environment;

#[path = "model_manifest/generated.rs"]
mod generated;

pub use generated::MODEL_MANIFEST_URL;
use generated::{BUNDLED_UPDATED_AT, FETCH_TIMEOUT_MS, MANIFEST_RETRY_MS, MANIFEST_TTL_MS};

pub const FILE_NAME: &str = "model-manifest.json";
/// The test seam's variable (see the module text).
pub const URL_VARIABLE: &str = "CONN_MODEL_MANIFEST_URL";

/// Where a refresh fetches from, if anywhere.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// Never fetch.
    Off,
    Url(String),
}

/// The source the seam's value names: T3's URL only when the variable is not set at all.
pub fn source(value: Option<&OsStr>) -> Source {
    let Some(value) = value else {
        return Source::Url(MODEL_MANIFEST_URL.to_owned());
    };
    match value.to_str() {
        Some(url) if url.starts_with("http://") || url.starts_with("https://") => {
            Source::Url(url.to_owned())
        }
        _ => Source::Off,
    }
}
/// How often the refresh is asked; the TTL and the retry wait decide whether it fetches.
const TICK: Duration = Duration::from_secs(5 * 60);
/// The manifest is about 30 KB; anything far larger is not one.
const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;

/// What a refresh remembers between ticks: three numbers.
#[derive(Debug, Default)]
pub struct State {
    disk_loaded: bool,
    /// `updatedAt` of the newest manifest known: the bundled one or the cache.
    current_updated_at_ms: i64,
    fetched_at_ms: Option<i64>,
    last_attempt_ms: Option<i64>,
}

/// Starts the refresh on the runtime (once now, then on every tick), from the source the
/// process environment names.
pub fn start(state_dir: PathBuf, environment: Arc<Environment>) {
    start_from(
        source(std::env::var_os(URL_VARIABLE).as_deref()),
        state_dir,
        environment,
    );
}

/// [`start`] with the source given. With [`Source::Off`] nothing starts; returns whether a
/// refresh task runs.
pub fn start_from(source: Source, state_dir: PathBuf, environment: Arc<Environment>) -> bool {
    if source == Source::Off {
        return false;
    }
    tokio::spawn(async move {
        let mut state = State::default();
        loop {
            let enabled = environment
                .settings
                .raw()
                .get("enableProviderUpdateChecks")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            refresh(
                &mut state,
                &state_dir,
                &source,
                enabled,
                i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX),
            )
            .await;
            tokio::time::sleep(TICK).await;
        }
    });
    true
}

/// One refresh (`ModelManifest.refresh`). Returns whether it wrote the file.
pub async fn refresh(
    state: &mut State,
    state_dir: &Path,
    source: &Source,
    enabled: bool,
    now_ms: i64,
) -> bool {
    let Source::Url(url) = source else {
        return false;
    };
    let path = state_dir.join(FILE_NAME);
    if !state.disk_loaded {
        state.disk_loaded = true;
        state.current_updated_at_ms = updated_at_ms(BUNDLED_UPDATED_AT);
        let read = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || std::fs::read_to_string(path)).await
        };
        if let Ok(Ok(text)) = read
            && let Some((fetched_at, updated)) = decode_cache(&text)
            && updated >= state.current_updated_at_ms
        {
            state.current_updated_at_ms = updated;
            state.fetched_at_ms = Some(fetched_at);
        }
    }
    // Times from before a clock rollback count as expired.
    let within =
        |since: Option<i64>, window: i64| since.is_some_and(|s| now_ms >= s && now_ms - s < window);
    if within(state.fetched_at_ms, MANIFEST_TTL_MS)
        || within(state.last_attempt_ms, MANIFEST_RETRY_MS)
    {
        return false;
    }
    if !enabled {
        return false;
    }
    state.last_attempt_ms = Some(now_ms);
    let request =
        conn_source_control::http::HttpRequest::new(conn_source_control::http::Method::Get, url)
            .timeout(Duration::from_millis(FETCH_TIMEOUT_MS));
    let Ok(response) = conn_source_control::http::send_following_redirects(request).await else {
        return false;
    };
    if !(200..300).contains(&response.status)
        || response.truncated
        || response.body.len() > MAX_MANIFEST_BYTES
    {
        return false;
    }
    let text = String::from_utf8_lossy(&response.body);
    let Some(updated) = decode_manifest_text(&text) else {
        return false;
    };
    // A stale CDN copy is refused as a stale disk cache is.
    if updated < state.current_updated_at_ms {
        return false;
    }
    let Some(manifest) = compact_json(&text) else {
        return false;
    };
    state.current_updated_at_ms = updated;
    state.fetched_at_ms = Some(now_ms);
    let contents = cache_text(now_ms, &manifest);
    let written = tokio::task::spawn_blocking(move || {
        conn_support::fs::write_atomic(&path, contents.as_bytes(), 0o644)
    })
    .await;
    matches!(written, Ok(Ok(())))
}

/// The cache file's text: `JSON.stringify({fetchedAtMs, manifest})`.
pub fn cache_text(fetched_at_ms: i64, compact_manifest: &str) -> String {
    format!("{{\"fetchedAtMs\":{fetched_at_ms},\"manifest\":{compact_manifest}}}")
}

/// A cache file's `fetchedAtMs` and its manifest's `updatedAt`, when it decodes.
fn decode_cache(text: &str) -> Option<(i64, i64)> {
    let value: Value = serde_json::from_str(text).ok()?;
    let fetched = value.get("fetchedAtMs")?.as_f64()?;
    if !fetched.is_finite() {
        return None;
    }
    let updated = decode_manifest(value.get("manifest")?)?;
    // `fetchedAtMs` is a whole number of milliseconds in every file T3 writes.
    Some((fetched as i64, updated))
}

/// Decodes a manifest's text; its `updatedAt` in ms when it is one.
pub fn decode_manifest_text(text: &str) -> Option<i64> {
    decode_manifest(&serde_json::from_str(text).ok()?)
}

fn non_blank(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.trim().is_empty())
}

fn optional(value: &Value, key: &str, check: impl Fn(&Value) -> bool) -> bool {
    value.get(key).is_none_or(check)
}

/// `ModelManifestSchema`: the fields and references T3 checks. Returns `updatedAt` in ms
/// (0 when absent or not a date, as `manifestUpdatedAtMs`).
fn decode_manifest(manifest: &Value) -> Option<i64> {
    let fields = manifest.as_object()?;
    if fields.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    if !optional(manifest, "updatedAt", Value::is_string)
        || !optional(manifest, "compatibility", Value::is_array)
    {
        return None;
    }
    let current = fields.get("currentModels")?.as_object()?;
    let lists_of_strings = current.values().all(|list| {
        list.as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    });
    if !lists_of_strings {
        return None;
    }
    if let Some(providers) = fields.get("providers") {
        for catalog in providers.as_object()?.values() {
            if !provider_catalog_is_valid(catalog) {
                return None;
            }
        }
    }
    Some(
        fields
            .get("updatedAt")
            .and_then(Value::as_str)
            .map_or(0, updated_at_ms),
    )
}

fn provider_catalog_is_valid(catalog: &Value) -> bool {
    let Some(profiles) = catalog.get("profiles").and_then(Value::as_object) else {
        return false;
    };
    if !profiles.values().all(Value::is_object) {
        return false;
    }
    let Some(models) = catalog.get("models").and_then(Value::as_array) else {
        return false;
    };
    let mut slugs: Vec<&str> = Vec::with_capacity(models.len());
    for model in models {
        let fields_ok = model.is_object()
            && non_blank(&model["slug"])
            && non_blank(&model["name"])
            && optional(model, "shortName", non_blank)
            && optional(model, "subProvider", non_blank)
            && optional(model, "aliases", |a| {
                a.as_array().is_some_and(|a| a.iter().all(non_blank))
            })
            && matches!(model["status"].as_str(), Some("current" | "legacy"))
            && optional(model, "releasedAt", Value::is_string)
            && optional(model, "profile", non_blank);
        if !fields_ok {
            return false;
        }
        let slug = model["slug"].as_str().unwrap_or_default();
        if slugs.contains(&slug) {
            return false;
        }
        slugs.push(slug);
        if let Some(profile) = model["profile"].as_str()
            && !profiles.contains_key(profile)
        {
            return false;
        }
    }
    match catalog.get("defaults") {
        None => true,
        Some(defaults) => {
            defaults.is_object()
                && optional(defaults, "chat", |chat| {
                    non_blank(chat) && chat.as_str().is_some_and(|c| slugs.contains(&c))
                })
        }
    }
}

/// `Date.parse` for the forms a manifest uses: an RFC 3339 time or a plain date (UTC).
/// Anything else counts as 0, as `NaN` does in `manifestUpdatedAtMs`.
pub fn updated_at_ms(text: &str) -> i64 {
    if let Ok(ts) = text.parse::<jiff::Timestamp>() {
        return ts.as_millisecond();
    }
    if let Ok(date) = text.parse::<jiff::civil::Date>()
        && let Ok(zoned) = date.to_zoned(jiff::tz::TimeZone::UTC)
    {
        return zoned.timestamp().as_millisecond();
    }
    0
}

/// The JSON text without the white space between tokens, in its own key order, as
/// `JSON.stringify` writes a value it parsed. `None` when it is not JSON.
pub fn compact_json(text: &str) -> Option<String> {
    serde_json::from_str::<serde::de::IgnoredAny>(text).ok()?;
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut escaped = false;
    for c in text.chars() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if !c.is_ascii_whitespace() {
            out.push(c);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn manifest(updated_at: &str) -> String {
        format!(
            r#"{{
  "version": 1,
  "updatedAt": "{updated_at}",
  "currentModels": {{ "codex": ["gpt-x"] }},
  "providers": {{
    "codex": {{
      "defaults": {{ "chat": "gpt-x" }},
      "profiles": {{ "p": {{}} }},
      "models": [{{ "slug": "gpt-x", "name": "GPT X", "aliases": ["x"], "status": "current", "profile": "p" }}]
    }}
  }}
}}"#
        )
    }

    /// One HTTP answer from a local server, for `count` requests.
    fn serve_once(body: String, count: usize) -> (String, std::thread::JoinHandle<usize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/model-manifest.json",
            listener.local_addr().unwrap()
        );
        let handle = std::thread::spawn(move || {
            let mut served = 0;
            for stream in listener.incoming().take(count) {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
                served += 1;
            }
            served
        });
        (url, handle)
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("conn-manifest-{name}-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_real_url_is_used_only_when_the_seam_is_not_set() {
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(source(None), Source::Url(MODEL_MANIFEST_URL.to_owned()));
        for off in [
            "off",
            "",
            "OFF",
            "file:///tmp/x",
            "raw.githubusercontent.com",
        ] {
            assert_eq!(source(Some(OsStr::new(off))), Source::Off, "{off}");
        }
        assert_eq!(source(Some(OsStr::from_bytes(b"\xff"))), Source::Off);
        assert_eq!(
            source(Some(OsStr::new("http://127.0.0.1:9/m.json"))),
            Source::Url("http://127.0.0.1:9/m.json".into())
        );
    }

    /// With the seam off no code path reaches the network: no task starts, and a refresh
    /// called anyway makes no attempt, whatever the times and the setting say.
    #[tokio::test(flavor = "current_thread")]
    async fn off_never_fetches() {
        let dir = temp_dir("off");
        let environment = Arc::new(
            crate::environment::Environment::load(&dir, None, dir.clone(), Default::default())
                .unwrap(),
        );
        assert!(!start_from(Source::Off, dir.clone(), environment));
        let mut state = State::default();
        for now in [0, 1, MANIFEST_TTL_MS * 10] {
            assert!(!refresh(&mut state, &dir, &Source::Off, true, now).await);
        }
        assert_eq!(state.last_attempt_ms, None);
        assert!(!state.disk_loaded);
        assert!(!dir.join(FILE_NAME).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn compact_json_keeps_order_and_strings() {
        assert_eq!(
            compact_json("{ \"b\" : [1, 2],\n \"a\": \"x y \\\" z\" }").unwrap(),
            r#"{"b":[1,2],"a":"x y \" z"}"#
        );
        assert!(compact_json("{nope").is_none());
    }

    #[test]
    fn decoding_follows_t3s_schema() {
        assert!(decode_manifest_text(&manifest("2030-01-02T00:00:00.000Z")).is_some());
        let duplicate = manifest("2030-01-02").replace(
            r#""models": ["#,
            r#""models": [{ "slug": "gpt-x", "name": "Dup", "status": "legacy" }, "#,
        );
        assert!(decode_manifest_text(&duplicate).is_none());
        let missing_profile =
            manifest("2030-01-02").replace(r#""profile": "p""#, r#""profile": "q""#);
        assert!(decode_manifest_text(&missing_profile).is_none());
        assert!(decode_manifest_text(r#"{"version": 2, "currentModels": {}}"#).is_none());
        assert_eq!(
            decode_manifest_text(r#"{"version": 1, "currentModels": {}}"#),
            Some(0)
        );
        assert_eq!(updated_at_ms("1970-01-02"), 86_400_000);
        assert_eq!(updated_at_ms("not a date"), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refresh_writes_the_cache_once_an_hour_and_only_when_enabled() {
        let dir = temp_dir("refresh");
        let (url, server) = serve_once(manifest("2999-01-01T00:00:00.000Z"), 1);
        let mut state = State::default();
        // Off: no fetch, no file.
        assert!(
            !refresh(
                &mut state,
                &dir,
                &Source::Url(url.clone()),
                false,
                1_000_000
            )
            .await
        );
        assert!(!dir.join(FILE_NAME).exists());
        assert!(refresh(&mut state, &dir, &Source::Url(url.clone()), true, 1_000_000).await);
        let written = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert!(
            written.starts_with(r#"{"fetchedAtMs":1000000,"manifest":{"version":1,"updatedAt""#)
        );
        assert_eq!(server.join().unwrap(), 1);
        // Within the hour nothing is fetched (the server above is gone).
        assert!(
            !refresh(
                &mut state,
                &dir,
                &Source::Url(url.clone()),
                true,
                1_000_000 + MANIFEST_TTL_MS - 1
            )
            .await
        );
        // A new process reads the cache and its fetch time.
        let mut fresh = State::default();
        assert!(!refresh(&mut fresh, &dir, &Source::Url(url.clone()), true, 1_000_500).await);
        assert_eq!(fresh.fetched_at_ms, Some(1_000_000));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_older_or_invalid_manifest_is_not_written() {
        let dir = temp_dir("older");
        let (url, server) = serve_once(manifest("2000-01-01T00:00:00.000Z"), 1);
        let mut state = State::default();
        assert!(!refresh(&mut state, &dir, &Source::Url(url.clone()), true, 5).await);
        assert_eq!(server.join().unwrap(), 1);
        assert!(!dir.join(FILE_NAME).exists());
        // The failed try holds the next one off for the retry wait.
        assert!(!refresh(&mut state, &dir, &Source::Url(url.clone()), true, 6).await);
        let (url, server) = serve_once("{\"version\":1}".into(), 1);
        let mut state = State::default();
        assert!(!refresh(&mut state, &dir, &Source::Url(url.clone()), true, 5).await);
        assert_eq!(server.join().unwrap(), 1);
        assert!(!dir.join(FILE_NAME).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
