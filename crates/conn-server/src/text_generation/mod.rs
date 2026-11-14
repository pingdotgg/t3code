//! Text generators: the user's own model APIs with a key saved in settings
//! (`apps/server/src/textGeneration/TextGenerators.ts`). They generate text, such as thread
//! titles; they cannot run agents. They are not agent providers: the server never calls Claude
//! or Codex itself, and nothing here reads an agent provider's settings or credentials.
//!
//! - [`TextGenerators::list_models`] serves `server.listTextGeneratorModels`.
//! - [`TextGenerators::run`] sends one prompt for a feature such as [`title`].
//!
//! The key: settings keep it (`textGenerators.<id>.apiKey`, see `settings.rs`). When settings
//! hold the redaction marker, the key is in the T3 server's secret store
//! (`<state-dir>/secrets/text-generator-<id>-apiKey.bin`, names in base64url), where a T3 server
//! moved it; it is read from there, as `materializeSettingsSecrets` does. A key named by a
//! secret provider (`{provider, reference}`) cannot be read: this server runs no secret
//! provider. The key exists only in the request's header ([`conn_source_control::Secret`]).

pub mod citations;
pub mod drivers;
pub mod js;
pub mod prompts;
pub mod title;

use std::{collections::VecDeque, sync::Mutex};

use conn_contract::{
    ListTextGeneratorModelsInput, ListTextGeneratorModelsResult, TextGeneratorModel, to_json,
};
use conn_source_control::Secret;
use serde_json::{Map, Value};

use crate::settings::SECRET_REDACTED;
pub use drivers::{Connection, Kind, RequestError};

/// Model lists kept, one per generator id; the oldest goes first. The T3 server keeps one per
/// id without a cap.
const MAX_CACHED_LISTS: usize = 32;

type ReadSettings = Box<dyn Fn() -> Map<String, Value> + Send + Sync>;

struct CachedModels {
    id: String,
    /// The whole stored config, so a changed URL or key never serves another API's list.
    config: Value,
    models: Vec<TextGeneratorModel>,
}

pub struct TextGenerators {
    settings: ReadSettings,
    cache: Mutex<VecDeque<CachedModels>>,
}

impl std::fmt::Debug for TextGenerators {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextGenerators").finish_non_exhaustive()
    }
}

/// `generatorLabel`: the label, else the host the base URL names, else a fixed text.
pub fn generator_label(config: &Value) -> String {
    if let Some(label) = config.get("label").and_then(Value::as_str)
        && !label.is_empty()
    {
        return label.to_owned();
    }
    config
        .get("baseUrl")
        .and_then(Value::as_str)
        .and_then(url_host)
        .unwrap_or_else(|| "The model API".to_owned())
}

/// `new URL(baseUrl).host` for an http or https URL: lower case, without a default port.
fn url_host(url: &str) -> Option<String> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let lower = authority.to_ascii_lowercase();
    let host = match (scheme.as_str(), lower.rsplit_once(':')) {
        ("https", Some((host, "443"))) | ("http", Some((host, "80"))) => host.to_owned(),
        _ => lower,
    };
    (!host.is_empty()).then_some(host)
}

/// `TextGeneratorBaseUrl`: http or https, no credentials, no query, no fragment, at most
/// 2,048 characters. The contract checks it when it decodes a config; the generated types
/// do not, so the method checks it here.
pub fn valid_base_url(url: &str) -> bool {
    let url = url.trim();
    if url.is_empty() || js::len16(url) > 2048 || url.contains(['?', '#']) {
        return false;
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
        && !authority.is_empty()
        && !authority.contains('@')
}

/// Why a key could not be read: `SettingsSecretUnresolvedError.message`.
fn unresolved(settings: &Map<String, Value>, provider: &str) -> RequestError {
    let label = settings
        .get("secretProviders")
        .and_then(|p| p.get(provider))
        .and_then(|p| p.get("label"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .unwrap_or(provider);
    RequestError(format!(
        "Could not read the credential from the secret provider \"{label}\". Unlock or fix it in Settings, then try again."
    ))
}

impl TextGenerators {
    /// `settings` reads the settings with their secrets (`SettingsStore::raw`, which reads
    /// the secret store).
    pub fn new(settings: impl Fn() -> Map<String, Value> + Send + Sync + 'static) -> Self {
        Self {
            settings: Box::new(settings),
            cache: Mutex::new(VecDeque::new()),
        }
    }

    /// Reads the server's own settings and its state folder.
    pub fn for_environment(environment: std::sync::Arc<crate::environment::Environment>) -> Self {
        Self::new(move || environment.settings.raw())
    }

    /// The stored settings, secrets included.
    pub fn settings(&self) -> Map<String, Value> {
        (self.settings)()
    }

    /// `textGeneratorForSelection`: the saved config under `id`, if `id` names a generator.
    pub fn config(&self, id: &str) -> Option<Value> {
        (self.settings)()
            .get("textGenerators")
            .and_then(|g| g.get(id))
            .filter(|c| c.is_object())
            .cloned()
    }

    /// `connect`: the config's connection with its key read.
    async fn connect(&self, config: &Value) -> Result<Connection, RequestError> {
        let label = generator_label(config);
        let invalid = || RequestError(format!("{label} returned a reply T3 Code couldn't read."));
        let kind = config
            .get("kind")
            .and_then(Value::as_str)
            .and_then(Kind::parse)
            .ok_or_else(invalid)?;
        let base_url = config
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|u| valid_base_url(u))
            .ok_or_else(invalid)?
            .trim()
            .to_owned();
        let api_key = match config.get("apiKey") {
            None | Some(Value::Null) => Secret::new(""),
            Some(Value::String(key)) => Secret::new(key.clone()),
            Some(reference) => {
                let provider = reference
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                return Err(unresolved(&(self.settings)(), provider));
            }
        };
        Ok(Connection {
            kind,
            base_url,
            api_key,
            label,
        })
    }

    /// Sends `prompt` to the generator `id` with `model`. `None` when `id` names no text
    /// generator; the error is the detail of a `TextGenerationError`.
    pub async fn run(&self, id: &str, model: &str, prompt: &str) -> Option<Result<String, String>> {
        let config = self.config(id)?;
        let label = generator_label(&config);
        if config.get("enabled") == Some(&Value::Bool(false)) {
            return Some(Err(format!(
                "{label} is off. Turn it on in Settings \u{2192} Providers."
            )));
        }
        let result = match self.connect(&config).await {
            Ok(connection) => connection.generate(model, prompt).await,
            Err(error) => Err(error),
        };
        Some(result.map_err(|e| e.0))
    }

    /// `listModels`: the models a saved or an unsaved config reaches, with an optional test.
    pub async fn list_models(
        &self,
        input: ListTextGeneratorModelsInput,
    ) -> Result<ListTextGeneratorModelsResult, String> {
        let saved = self.config(&input.id);
        let config = match input.config.as_ref().map(to_json) {
            None => saved.clone(),
            Some(mut unsaved) => {
                if unsaved.get("apiKey").and_then(Value::as_str) == Some(SECRET_REDACTED) {
                    let key = saved
                        .as_ref()
                        .and_then(|s| s.get("apiKey"))
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new()));
                    if let Some(fields) = unsaved.as_object_mut() {
                        fields.insert("apiKey".into(), key);
                    }
                }
                Some(unsaved)
            }
        };
        let Some(config) = config else {
            return Err("That text generator no longer exists.".to_owned());
        };
        // Checking unsaved settings, or testing, must reach the API rather than trust the cache.
        let fresh = input.config.is_some() || input.test == Some(true);
        if !fresh && input.refresh != Some(true) {
            let cache = crate::lock(&self.cache);
            if let Some(hit) = cache
                .iter()
                .find(|c| c.id == input.id && c.config == config)
            {
                return Ok(ListTextGeneratorModelsResult {
                    models: hit.models.clone(),
                    tested_model: None,
                });
            }
        }
        let connection = self.connect(&config).await.map_err(|e| e.0)?;
        let models = connection.list_models().await.map_err(|e| e.0)?;
        if input.test == Some(true) {
            // An explicit test sends one tiny request: some APIs list models without checking
            // the key.
            let model = input.model.clone().or_else(|| {
                models
                    .iter()
                    .find(|m| is_small_model(&m.id))
                    .or_else(|| models.first())
                    .map(|m| m.id.clone())
            });
            let Some(model) = model else {
                return Err(format!(
                    "{} lists no models to test with.",
                    connection.label
                ));
            };
            connection
                .generate(&model, "Reply with OK.")
                .await
                .map_err(|e| e.0)?;
            return Ok(ListTextGeneratorModelsResult {
                models,
                tested_model: Some(model),
            });
        }
        let mut cache = crate::lock(&self.cache);
        cache.retain(|c| c.id != input.id);
        if cache.len() >= MAX_CACHED_LISTS {
            cache.pop_front();
        }
        cache.push_back(CachedModels {
            id: input.id.clone(),
            config,
            models: models.clone(),
        });
        Ok(ListTextGeneratorModelsResult {
            models,
            tested_model: None,
        })
    }
}

/// `/haiku|mini|flash|nano/i`.
fn is_small_model(id: &str) -> bool {
    let id = id.to_lowercase();
    ["haiku", "mini", "flash", "nano"]
        .iter()
        .any(|word| id.contains(word))
}

#[cfg(test)]
mod tests;
