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
//! `server.refreshProviders` asks too, as in T3: `modelCatalogOnly` (an opened model picker)
//! refetches a manifest older than 5 minutes and probes the providers when it changed;
//! `refreshModels` fetches at once (no TTL, no retry wait; the setting still decides).
//!
//! An accepted manifest also goes to the providers (`conn_provider::LiveManifest`): Codex
//! classifies its models with it, as T3's drivers read `ModelCatalog.current`.
//!
//! **Test seam:** `CONN_MODEL_MANIFEST_URL`, read once at start. Unset: T3's URL. `off`, empty,
//! not Unicode, or anything that is not an `http://` or `https://` URL: the server never
//! fetches (no refresh task starts). Any other value: fetch from there instead, as from a
//! loopback stub in `orbit-flow.mjs`. Every check starts servers with `off`
//! (`tools/sealed-env.mjs`, `tools/check.sh`).

use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use serde_json::Value;

use crate::environment::Environment;

#[path = "model_manifest/generated.rs"]
mod generated;

pub use generated::MODEL_MANIFEST_URL;
use generated::{
    BUNDLED_UPDATED_AT, FETCH_TIMEOUT_MS, MANIFEST_ON_DEMAND_TTL_MS, MANIFEST_RETRY_MS,
    MANIFEST_TTL_MS,
};

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

/// What a refresh remembers between ticks.
#[derive(Debug, Default)]
pub struct State {
    disk_loaded: bool,
    /// `updatedAt` of the newest manifest known: the bundled one or the cache.
    current_updated_at_ms: i64,
    fetched_at_ms: Option<i64>,
    last_attempt_ms: Option<i64>,
    /// Where an accepted manifest goes: the providers classify their models with it.
    pub live: conn_provider::LiveManifest,
}

/// When a refresh fetches.
#[derive(Clone, Copy, Debug)]
pub enum Window {
    /// When the last fetch is older than this and the last try older than the retry wait.
    Ttl(i64),
    /// Now (`forceRefresh`, before an explicit model refresh). The setting still decides.
    Force,
}

/// The manifest this server keeps. The tick and `server.refreshProviders` share it; its lock
/// is T3's refresh semaphore, so one fetch runs at a time.
#[derive(Debug)]
pub struct ModelManifest {
    source: Source,
    state_dir: PathBuf,
    environment: Arc<Environment>,
    state: tokio::sync::Mutex<State>,
    /// `updatedAt` of the newest manifest known, readable without waiting on a fetch.
    current_updated_at_ms: AtomicI64,
    /// `updatedAt` of the manifest the last full probe pass started with (T3's
    /// `probedManifestUpdatedAt`). The providers start on the bundled manifest.
    probed_updated_at_ms: AtomicI64,
}

impl ModelManifest {
    /// From the source the process environment names (see the module text).
    pub fn new(
        state_dir: PathBuf,
        environment: Arc<Environment>,
        live: conn_provider::LiveManifest,
    ) -> Arc<Self> {
        Self::with_source(
            source(std::env::var_os(URL_VARIABLE).as_deref()),
            state_dir,
            environment,
            live,
        )
    }

    /// `live` receives each manifest this server accepts.
    pub fn with_source(
        source: Source,
        state_dir: PathBuf,
        environment: Arc<Environment>,
        live: conn_provider::LiveManifest,
    ) -> Arc<Self> {
        let bundled = updated_at_ms(BUNDLED_UPDATED_AT);
        Arc::new(Self {
            source,
            state_dir,
            environment,
            state: tokio::sync::Mutex::new(State {
                live,
                ..State::default()
            }),
            current_updated_at_ms: AtomicI64::new(bundled),
            probed_updated_at_ms: AtomicI64::new(bundled),
        })
    }

    /// Starts the refresh on the runtime: once now, then on every tick. With [`Source::Off`]
    /// nothing starts; returns whether a refresh task runs.
    pub fn start(self: &Arc<Self>) -> bool {
        if self.source == Source::Off {
            return false;
        }
        let manifest = self.clone();
        tokio::spawn(async move {
            loop {
                manifest.refresh(Window::Ttl(MANIFEST_TTL_MS)).await;
                tokio::time::sleep(TICK).await;
            }
        });
        true
    }

    /// One refresh, with the setting `enableProviderUpdateChecks` (default on) and the clock.
    /// Returns whether it wrote the file.
    pub async fn refresh(&self, window: Window) -> bool {
        let mut state = self.state.lock().await;
        self.refresh_locked(&mut state, window).await
    }

    async fn refresh_locked(&self, state: &mut State, window: Window) -> bool {
        let enabled = self
            .environment
            .settings
            .raw()
            .get("enableProviderUpdateChecks")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let now = i64::try_from(conn_support::time::now_ms()).unwrap_or(i64::MAX);
        let wrote = refresh_with(state, &self.state_dir, &self.source, enabled, now, window).await;
        if state.disk_loaded {
            self.current_updated_at_ms
                .store(state.current_updated_at_ms, Ordering::Relaxed);
        }
        wrote
    }

    /// T3's `refreshOnDemand`, for an opened model picker: refetch a manifest older than
    /// `MANIFEST_ON_DEMAND_TTL_MS`. Returns the `updatedAt` of the manifest now known.
    pub async fn refresh_on_demand(&self) -> i64 {
        let mut state = self.state.lock().await;
        self.refresh_locked(&mut state, Window::Ttl(MANIFEST_ON_DEMAND_TTL_MS))
            .await;
        self.current_updated_at()
    }

    /// `updatedAt` of the newest manifest known (T3's `manifestService.current`).
    pub fn current_updated_at(&self) -> i64 {
        self.current_updated_at_ms.load(Ordering::Relaxed)
    }

    /// `updatedAt` of the manifest the last full probe pass started with.
    pub fn probed_updated_at(&self) -> i64 {
        self.probed_updated_at_ms.load(Ordering::Relaxed)
    }

    /// Records the manifest a full probe pass started with, once the pass has ended.
    pub fn set_probed(&self, updated_at_ms: i64) {
        self.probed_updated_at_ms
            .store(updated_at_ms, Ordering::Relaxed);
    }
}

/// One refresh on the hourly window (`ModelManifest.refresh`). Returns whether it wrote the
/// file.
pub async fn refresh(
    state: &mut State,
    state_dir: &Path,
    source: &Source,
    enabled: bool,
    now_ms: i64,
) -> bool {
    let window = Window::Ttl(MANIFEST_TTL_MS);
    refresh_with(state, state_dir, source, enabled, now_ms, window).await
}

/// One refresh (`ModelManifest.refresh(force, ttlMs)`). Returns whether it wrote the file.
pub async fn refresh_with(
    state: &mut State,
    state_dir: &Path,
    source: &Source,
    enabled: bool,
    now_ms: i64,
    window: Window,
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
            && let Some((fetched_at, updated, manifest)) = decode_cache(&text)
            && updated >= state.current_updated_at_ms
        {
            state.current_updated_at_ms = updated;
            state.fetched_at_ms = Some(fetched_at);
            state.live.set(manifest);
        }
    }
    // Times from before a clock rollback count as expired.
    let within =
        |since: Option<i64>, window: i64| since.is_some_and(|s| now_ms >= s && now_ms - s < window);
    if let Window::Ttl(ttl) = window
        && (within(state.fetched_at_ms, ttl) || within(state.last_attempt_ms, MANIFEST_RETRY_MS))
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
    if let Ok(value) = serde_json::from_str(&text) {
        state.live.set(value);
    }
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

/// A cache file's `fetchedAtMs`, its manifest's `updatedAt` and the manifest, when it decodes.
fn decode_cache(text: &str) -> Option<(i64, i64, Value)> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    let fetched = value.get("fetchedAtMs")?.as_f64()?;
    if !fetched.is_finite() {
        return None;
    }
    let updated = decode_manifest(value.get("manifest")?)?;
    // `fetchedAtMs` is a whole number of milliseconds in every file T3 writes.
    Some((fetched as i64, updated, value.get_mut("manifest")?.take()))
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
    let policies_ok = |policies: &Value| {
        policies
            .as_array()
            .is_some_and(|policies| policies.iter().all(compatibility_policy_is_valid))
    };
    if !optional(manifest, "updatedAt", Value::is_string)
        || !optional(manifest, "compatibility", policies_ok)
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
    if !conn_provider_claude::catalog::manifest_adapters_are_valid(manifest) {
        return None;
    }
    Some(
        fields
            .get("updatedAt")
            .and_then(Value::as_str)
            .map_or(0, updated_at_ms),
    )
}

/// `ProviderCompatibilityPolicy`: a driver, version ranges T3 can read, known statuses, and a
/// recommended version that lies in the recommended range and in a supported range.
fn compatibility_policy_is_valid(policy: &Value) -> bool {
    let range = |value: &Value| value.as_str().is_some_and(version_range_is_valid);
    let stable = |value: &Value| {
        value.as_str().map(str::trim).is_some_and(|v| {
            let parts: Vec<&str> = v.split('.').collect();
            parts.len() == 3 && parts.iter().all(|p| is_digits(p))
        })
    };
    let Some(ranges) = policy.get("ranges").and_then(Value::as_array) else {
        return false;
    };
    let ranges_ok = ranges.iter().all(|entry| {
        range(&entry["range"])
            && matches!(
                entry["status"].as_str(),
                Some("unknown" | "supported" | "graceful" | "unsupported" | "broken")
            )
    });
    let shape_ok = policy.is_object()
        && non_blank(&policy["driver"])
        && range(&policy["t3CodeRange"])
        && optional(policy, "recommendedRange", range)
        && optional(policy, "recommendedVersion", stable)
        && ranges_ok;
    if !shape_ok {
        return false;
    }
    let Some(version) = policy["recommendedVersion"].as_str().map(str::trim) else {
        return true;
    };
    let in_recommended = policy["recommendedRange"]
        .as_str()
        .is_none_or(|r| satisfies_range(version, r.trim()));
    let first = ranges.iter().find(|entry| {
        entry["range"]
            .as_str()
            .is_some_and(|r| satisfies_range(version, r.trim()))
    });
    in_recommended && first.is_some_and(|entry| entry["status"] == "supported")
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// A comparator token: an optional operator, an optional `v`, and one to three numbers.
/// Returns the operator and the numbers as written.
fn comparator(token: &str) -> Option<(&str, Vec<&str>)> {
    let operator = ["^", ">=", "<=", ">", "<", "="]
        .into_iter()
        .find(|op| token.starts_with(op))
        .unwrap_or("");
    let rest = token.get(operator.len()..)?;
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    let numbers: Vec<&str> = rest.split('.').collect();
    (numbers.len() <= 3 && numbers.iter().all(|n| is_digits(n))).then_some((operator, numbers))
}

/// T3's `VersionRange` check: `||` groups of whitespace-separated comparators.
fn version_range_is_valid(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.split("||").all(|group| {
            let group = group.trim();
            !group.is_empty() && group.split_whitespace().all(|t| comparator(t).is_some())
        })
}

/// `satisfiesSemverRange` for a version T3 accepts as stable (`major.minor.patch`).
fn satisfies_range(version: &str, range: &str) -> bool {
    let parse = |numbers: &[&str]| -> Option<[u64; 3]> {
        let mut parts = [0u64; 3];
        for (slot, number) in parts.iter_mut().zip(numbers) {
            *slot = number.parse().ok()?;
        }
        Some(parts)
    };
    let version_parts: Vec<&str> = version.trim_start_matches('v').split('.').collect();
    let Some(version) = parse(&version_parts) else {
        return false;
    };
    range.split("||").any(|group| {
        let tokens: Vec<&str> = group.split_whitespace().collect();
        !tokens.is_empty()
            && tokens.iter().all(|token| {
                let Some((operator, numbers)) = comparator(token) else {
                    return false;
                };
                let Some(target) = parse(&numbers) else {
                    return false;
                };
                let compared = version.cmp(&target);
                match operator {
                    "^" if compared.is_lt() => false,
                    "^" if target[0] > 0 || numbers.len() < 2 => version[0] == target[0],
                    "^" if target[1] > 0 || numbers.len() < 3 => {
                        version[0] == 0 && version[1] == target[1]
                    }
                    "^" => version[0] == 0 && version[1] == 0 && version[2] == target[2],
                    ">=" => compared.is_ge(),
                    ">" => compared.is_gt(),
                    "<=" => compared.is_le(),
                    "<" => compared.is_lt(),
                    _ => compared.is_eq(),
                }
            })
    })
}

fn provider_catalog_is_valid(catalog: &Value) -> bool {
    let Some(profiles) = catalog.get("profiles").and_then(Value::as_object) else {
        return false;
    };
    let profiles_ok = profiles.values().all(|profile| {
        profile.is_object() && optional(profile, "capabilities", capabilities_are_valid)
    });
    if !profiles_ok {
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

/// `ModelCapabilities`: the config's wire type (`ServerProvider.models[].capabilities`), with
/// T3's non-blank names. A profile that fails this would break `server.getConfig`.
fn capabilities_are_valid(capabilities: &Value) -> bool {
    type Capabilities = conn_contract::ServerProvidersItemItemModelsItemCapabilities;
    if conn_contract::from_json::<Capabilities>(capabilities.clone()).is_err() {
        return false;
    }
    let names = |item: &Value| {
        non_blank(&item["id"])
            && non_blank(&item["label"])
            && optional(item, "description", non_blank)
    };
    capabilities
        .get("optionDescriptors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .all(|descriptor| {
            names(descriptor)
                && descriptor["options"]
                    .as_array()
                    .is_none_or(|options| options.iter().all(names))
                && optional(descriptor, "currentValue", |v| {
                    v.is_boolean() || non_blank(v)
                })
                && optional(descriptor, "promptInjectedValues", |values| {
                    values.as_array().is_some_and(|v| v.iter().all(non_blank))
                })
        })
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
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};

    pub(crate) fn manifest(updated_at: &str) -> String {
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
    pub(crate) fn serve_once(
        body: String,
        count: usize,
    ) -> (String, std::thread::JoinHandle<usize>) {
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
        let manifest =
            ModelManifest::with_source(Source::Off, dir.clone(), environment, Default::default());
        assert!(!manifest.start());
        assert!(!manifest.refresh(Window::Force).await);
        let bundled = updated_at_ms(BUNDLED_UPDATED_AT);
        assert_eq!(manifest.refresh_on_demand().await, bundled);
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

    /// T3's `refreshOnDemand` and `forceRefresh`: an opened model picker refetches a manifest
    /// older than 5 minutes though the hour has not passed, and reports a change once; an
    /// explicit model refresh fetches through both windows.
    #[tokio::test(flavor = "current_thread")]
    async fn on_demand_and_forced_refreshes_use_their_own_windows() {
        let dir = temp_dir("on-demand");
        let (url, server) = serve_once(manifest("2999-01-01T00:00:00.000Z"), 1);
        let source = Source::Url(url);
        let mut state = State::default();
        let t0 = 1_000_000;
        assert!(refresh(&mut state, &dir, &source, true, t0).await);
        assert_eq!(server.join().unwrap(), 1);
        // The accepted manifest reaches the providers.
        assert!(state.live.provider_catalog("codex").is_some());
        let on_demand = Window::Ttl(MANIFEST_ON_DEMAND_TTL_MS);
        // Within 5 minutes the picker fetches nothing (the server above is gone).
        let soon = t0 + MANIFEST_ON_DEMAND_TTL_MS - 1;
        assert!(!refresh_with(&mut state, &dir, &source, true, soon, on_demand).await);
        // Past 5 minutes it fetches, though the hourly refresh would not.
        let (url, server) = serve_once(manifest("2999-06-01T00:00:00.000Z"), 1);
        let source = Source::Url(url);
        let later = t0 + MANIFEST_ON_DEMAND_TTL_MS;
        assert!(!refresh(&mut state, &dir, &source, true, later).await);
        assert!(refresh_with(&mut state, &dir, &source, true, later, on_demand).await);
        assert_eq!(server.join().unwrap(), 1);
        // Forced: inside both windows, but not when the setting is off.
        let (url, server) = serve_once(manifest("2999-07-01T00:00:00.000Z"), 1);
        let source = Source::Url(url);
        assert!(!refresh_with(&mut state, &dir, &source, false, later + 1, Window::Force).await);
        assert!(refresh_with(&mut state, &dir, &source, true, later + 1, Window::Force).await);
        assert_eq!(server.join().unwrap(), 1);
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

    /// T3's bundled manifest, with `updatedAt` set.
    fn bundled_manifest(updated_at: &str) -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../server/src/provider/model-manifest.json"
        );
        let mut manifest: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        manifest["updatedAt"] = Value::from(updated_at);
        manifest
    }

    /// `ModelManifestSchema` decodes each profile's `capabilities` as `ModelCapabilities`. A
    /// fetched manifest whose Claude profile breaks that contract is refused, the last valid
    /// one stays, and its Claude models still decode as the config's wire type.
    #[tokio::test(flavor = "current_thread")]
    async fn an_invalid_profile_keeps_the_last_valid_manifest() {
        let dir = temp_dir("invalid-profile");
        let valid = bundled_manifest("2999-01-01T00:00:00.000Z");
        let mut invalid = bundled_manifest("2999-06-01T00:00:00.000Z");
        let profiles = invalid["providers"]["claudeAgent"]["profiles"]
            .as_object_mut()
            .unwrap();
        for profile in profiles.values_mut() {
            profile["capabilities"] =
                serde_json::json!({"optionDescriptors": [{"id": "effort", "type": "select"}]});
        }
        assert!(decode_manifest(&invalid).is_none());
        let mut state = State::default();
        let (url, server) = serve_once(valid.to_string(), 1);
        assert!(refresh(&mut state, &dir, &Source::Url(url), true, 1).await);
        assert_eq!(server.join().unwrap(), 1);
        let kept = state.live.provider_catalog("claudeAgent");
        let (url, server) = serve_once(invalid.to_string(), 1);
        let later = 1 + MANIFEST_RETRY_MS;
        let window = Window::Force;
        assert!(!refresh_with(&mut state, &dir, &Source::Url(url), true, later, window).await);
        assert_eq!(server.join().unwrap(), 1);
        assert_eq!(state.live.provider_catalog("claudeAgent"), kept);
        for model in conn_provider_claude::catalog::current_provider_models(&state.live, 0) {
            let decoded: Result<conn_contract::ServerProvidersItemItemModelsItem, _> =
                conn_contract::from_json(model.clone());
            assert!(decoded.is_ok(), "{model}");
        }
        // A cache file with the invalid manifest is not read either.
        std::fs::write(dir.join(FILE_NAME), cache_text(later, &invalid.to_string())).unwrap();
        let mut fresh = State::default();
        let off = Source::Url("http://127.0.0.1:9/m.json".into());
        assert!(!refresh(&mut fresh, &dir, &off, false, later).await);
        assert_eq!(fresh.live.provider_catalog("claudeAgent"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Port of `providerCompatibility.test.ts` "rejects invalid ranges and recommendations
    /// outside the first supported match", and of `semver.test.ts` "matches supported range
    /// groups".
    #[test]
    fn compatibility_policies_follow_t3s_schema() {
        let policy = serde_json::json!({
            "driver": "codex", "t3CodeRange": ">=0.0.0",
            "recommendedVersion": "2.0.0", "recommendedRange": ">=2.0.0 <3.0.0",
            "ranges": [
                {"range": "<1.0.0", "status": "broken"},
                {"range": ">=1.0.0 <1.5.0", "status": "unsupported"},
                {"range": ">=1.5.0 <2.0.0", "status": "graceful"},
                {"range": ">=2.0.0 <3.0.0", "status": "supported"}]
        });
        assert!(compatibility_policy_is_valid(&policy));
        let with = |key: &str, value: Value| {
            let mut changed = policy.clone();
            changed[key] = value;
            changed
        };
        let prefixed = serde_json::json!({
            "driver": "codex", "t3CodeRange": ">=v0.0.42 <v0.1",
            "recommendedVersion": "2.0.0", "recommendedRange": "^v2",
            "ranges": [{"range": ">=v2.0 <v3", "status": "supported"}]
        });
        assert!(compatibility_policy_is_valid(&prefixed));
        let mut first_broken = policy.clone();
        first_broken["ranges"].as_array_mut().unwrap().insert(
            0,
            serde_json::json!({"range": ">=0.0.0", "status": "broken"}),
        );
        for invalid in [
            with("t3CodeRange", "*".into()),
            with("recommendedVersion", "3.0.0".into()),
            with(
                "ranges",
                serde_json::json!([{"range": ">=2.0.0 garbage", "status": "supported"}]),
            ),
            with("recommendedVersion", "2.0.0; echo unsafe".into()),
            first_broken,
            with(
                "ranges",
                serde_json::json!([{"range": ">=2.0.0", "status": "fine"}]),
            ),
        ] {
            assert!(!compatibility_policy_is_valid(&invalid), "{invalid}");
        }
        let range = "^22.16 || ^23.11 || >=24.10";
        for (version, expected) in [
            ("22.16.0", true),
            ("23.11.1", true),
            ("24.10.0", true),
            ("22.15.9", false),
            ("23.10.9", false),
            ("24.9.9", false),
        ] {
            assert_eq!(satisfies_range(version, range), expected, "{version}");
        }
        assert!(satisfies_range("0.2.5", "^0.2"));
        assert!(!satisfies_range("0.3.0", "^0.2"));
        assert!(satisfies_range("0.0.3", "^0.0.3"));
        assert!(!satisfies_range("0.0.4", "^0.0.3"));
    }

    /// `ModelManifestSchema` checks the Claude adapters (`hasValidClaudeManifestAdapters`)
    /// and the compatibility policies. A newer fetched manifest that fails either is refused:
    /// the last valid one stays in memory and in the cache file.
    #[tokio::test(flavor = "current_thread")]
    async fn an_invalid_adapter_or_policy_keeps_the_last_valid_manifest() {
        let mut bad_version = bundled_manifest("2999-06-01T00:00:00.000Z");
        bad_version["providers"]["claudeAgent"]["models"][0]["adapter"] =
            serde_json::json!({"claudeCode": {"minVersion": "not a version"}});
        let mut inverted = bundled_manifest("2999-06-01T00:00:00.000Z");
        inverted["providers"]["claudeAgent"]["models"][0]["adapter"] = serde_json::json!({"claudeCode": {"minVersion": "3.0.0", "maxVersionExclusive": "2.0.0"}});
        let mut not_an_object = bundled_manifest("2999-06-01T00:00:00.000Z");
        not_an_object["providers"]["claudeAgent"]["models"][0]["adapter"] =
            serde_json::json!({"claudeCode": false});
        let mut bad_profile = bundled_manifest("2999-06-01T00:00:00.000Z");
        let profile = bad_profile["providers"]["claudeAgent"]["profiles"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        profile["adapter"] = serde_json::json!({"claudeCode": {"effortMap": {"high": 3}}});
        let mut bad_policy = bundled_manifest("2999-06-01T00:00:00.000Z");
        bad_policy["compatibility"][0]["recommendedVersion"] = "0.1.0".into();
        let valid = bundled_manifest("2999-01-01T00:00:00.000Z");
        assert!(decode_manifest(&valid).is_some());
        for invalid in [
            bad_version,
            inverted,
            not_an_object,
            bad_profile,
            bad_policy,
        ] {
            assert!(decode_manifest(&invalid).is_none(), "accepted");
            let dir = temp_dir("invalid-adapter");
            let mut state = State::default();
            let (url, server) = serve_once(valid.to_string(), 1);
            assert!(refresh(&mut state, &dir, &Source::Url(url), true, 1).await);
            assert_eq!(server.join().unwrap(), 1);
            let kept = state.live.provider_catalog("claudeAgent");
            let cached = std::fs::read_to_string(dir.join(FILE_NAME)).unwrap();
            let (url, server) = serve_once(invalid.to_string(), 1);
            let later = 1 + MANIFEST_RETRY_MS;
            let window = Window::Force;
            assert!(!refresh_with(&mut state, &dir, &Source::Url(url), true, later, window).await);
            assert_eq!(server.join().unwrap(), 1);
            assert_eq!(state.live.provider_catalog("claudeAgent"), kept);
            assert_eq!(
                std::fs::read_to_string(dir.join(FILE_NAME)).unwrap(),
                cached
            );
            // A cache file holding it is not read either.
            std::fs::write(dir.join(FILE_NAME), cache_text(later, &invalid.to_string())).unwrap();
            let mut fresh = State::default();
            let off = Source::Url("http://127.0.0.1:9/m.json".into());
            assert!(!refresh(&mut fresh, &dir, &off, false, later).await);
            assert_eq!(fresh.live.provider_catalog("claudeAgent"), None);
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }
}
