//! Thread titles through a text generator, as `ThreadTitleRegenerationService.ts` and
//! `TextGeneration.generateThreadTitle` make them. The engine decides when (the first message
//! of a thread launched with `generateTitle`, or `regenerateTitle`) and applies the answer;
//! this part chooses the model, builds the prompt, calls the generator and reads the reply.
//!
//! The model is the `textGenerationModelSelection` setting, or the thread's project override.
//! When it names a text generator, the prompt goes to that generator's API. When it names an
//! agent provider instance (Codex by default), the prompt goes to that provider's own CLI or
//! SDK through [`Provider::generate_text`], as T3's `TextGeneration` hands it to the instance's
//! `textGeneration` (Codex: `codex exec`). A provider without text generation fails the
//! request without a call: an initial title keeps its seed and a regenerate reports
//! [`AGENT_TITLES_NOT_SERVED`]. T3's fallback to another provider when the chosen one is
//! unusable (`fallbackTextGenerationModelSelection`) is not built.

use std::{path::PathBuf, sync::Arc, time::Duration};

use conn_engine::{BoxFuture, TitleGenerator, TitleKind, TitleMessage, TitleRequest};
use conn_provider::TextGenerationRequest;
use serde_json::{Map, Value};

use super::{
    TextGenerators,
    prompts::{self, Attachment, Message, TitlePromptInput},
};

/// What a regenerate reports when the title model is an agent provider.
pub const AGENT_TITLES_NOT_SERVED: &str = "This server generates titles only with a text generator. Choose one as the title model in Settings.";
/// `DEFAULT_TEXT_GENERATION_MODEL` belongs to the default instance, `codex`; neither is a text
/// generator, so the model name is never sent.
const DEFAULT_INSTANCE: &str = "codex";
/// `Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") })` for a first title.
const INITIAL_RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(4)];

/// Generates thread titles for the engine.
pub struct Titles {
    generators: Arc<TextGenerators>,
    retry_delays: Vec<Duration>,
    /// The agent provider instances a title model can name.
    providers: conn_provider::ProviderSet,
    /// T3's attachment store, where a title's image attachments are read from.
    attachments_dir: Option<PathBuf>,
}

impl std::fmt::Debug for Titles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Titles")
            .field("generators", &self.generators)
            .field("providers", &self.providers.len())
            .finish_non_exhaustive()
    }
}

impl Titles {
    pub fn new(generators: Arc<TextGenerators>) -> Self {
        Self {
            generators,
            retry_delays: INITIAL_RETRY_DELAYS.to_vec(),
            providers: conn_provider::ProviderSet::default(),
            attachments_dir: None,
        }
    }

    /// Lets a title model name an agent provider instance.
    pub fn with_providers(
        mut self,
        providers: impl Into<conn_provider::ProviderSet>,
        attachments_dir: Option<PathBuf>,
    ) -> Self {
        self.providers = providers.into();
        self.attachments_dir = attachments_dir;
        self
    }

    /// Other waits between the tries of a first title, for tests.
    #[cfg(test)]
    pub(crate) fn with_retry_delays(mut self, delays: &[Duration]) -> Self {
        self.retry_delays = delays.to_vec();
        self
    }
}

/// Whether a selection's instance is on (`resolveTextGenerationSelectionEnabled`).
pub(crate) fn selection_enabled(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
    instance_id: &str,
) -> bool {
    if let Some(generator) = settings
        .get("textGenerators")
        .and_then(|g| g.get(instance_id))
    {
        return generator.get("enabled") != Some(&Value::Bool(false));
    }
    crate::settings::provider_instance_enabled(settings, project_id, instance_id)
}

pub(crate) fn project_override<'a>(
    settings: &'a Map<String, Value>,
    project_id: Option<&str>,
    key: &str,
) -> Option<&'a Value> {
    settings
        .get("projectSettingsOverrides")
        .and_then(|o| o.get(project_id?))
        .and_then(|o| o.get(key))
}

/// `resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection`, as
/// `(instanceId, model)`.
pub fn title_selection(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
) -> (String, String) {
    let (instance, model, _) = title_model_selection(settings, project_id);
    (instance, model)
}

/// The same selection, with the whole stored value (its options: effort, service tier).
pub fn title_model_selection(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
) -> (String, String, Value) {
    let read = |selection: &Value| {
        Some((
            selection.get("instanceId")?.as_str()?.to_owned(),
            selection.get("model")?.as_str()?.to_owned(),
            selection.clone(),
        ))
    };
    if let Some(selection) = project_override(settings, project_id, "textGenerationModelSelection")
        .and_then(read)
        .filter(|(instance, _, _)| selection_enabled(settings, project_id, instance))
    {
        return selection;
    }
    settings
        .get("textGenerationModelSelection")
        .and_then(read)
        .unwrap_or_else(|| {
            (
                DEFAULT_INSTANCE.to_owned(),
                String::new(),
                serde_json::json!({"instanceId": DEFAULT_INSTANCE, "model": ""}),
            )
        })
}

/// The image attachments of the request's messages that the prompt names, as saved files
/// (`materializeImageAttachments`: absolute paths to existing files, in prompt order).
fn image_paths(
    request: &TitleRequest,
    input: &TitlePromptInput,
    dir: Option<&std::path::Path>,
) -> Vec<PathBuf> {
    let messages: Vec<&TitleMessage> = match &request.kind {
        TitleKind::Initial { message } => vec![message],
        TitleKind::Regenerate { messages, .. } => messages.iter().collect(),
    };
    input
        .attachments
        .iter()
        .filter_map(|wanted| {
            messages
                .iter()
                .flat_map(|m| m.attachments.iter())
                .find(|a| a.get("id").and_then(Value::as_str) == Some(wanted.id.as_str()))
        })
        .filter(|a| a.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|a| conn_provider_support::attachments::saved_path(dir, a))
        .filter(|path| path.is_absolute())
        .collect()
}

/// `threadTitleInstructions`, with the project's override.
pub fn title_instructions(
    settings: &Map<String, Value>,
    project_id: Option<&str>,
) -> Option<String> {
    project_override(settings, project_id, "threadTitleInstructions")
        .or_else(|| settings.get("threadTitleInstructions"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn attachment(value: &Value) -> Attachment {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Attachment {
        id: text("id"),
        name: text("name"),
        mime_type: text("mimeType"),
        size_bytes: value.get("sizeBytes").cloned().unwrap_or(Value::Null),
    }
}

fn message(source: &TitleMessage) -> Message {
    Message {
        role: source.role.clone(),
        text: source.text.clone(),
        attachments: source.attachments.iter().map(attachment).collect(),
    }
}

/// The prompt input for a request (`ThreadTitleRegenerationService.execute`).
pub fn prompt_input(
    request: &TitleRequest,
    instructions: Option<String>,
) -> Result<TitlePromptInput, String> {
    let (text, attachments, previous_title) = match &request.kind {
        TitleKind::Initial { message: first } => {
            let first = message(first);
            let text = if prompts::is_attachment_only_bootstrap_prompt(&first.text) {
                String::new()
            } else {
                first.text
            };
            (text, first.attachments, None)
        }
        TitleKind::Regenerate {
            previous_title,
            messages,
        } => {
            let messages: Vec<Message> = messages.iter().map(message).collect();
            let (text, attachments) = prompts::format_thread_title_context(&messages);
            (text, attachments, Some(previous_title.clone()))
        }
    };
    if text.is_empty() && attachments.is_empty() {
        return Err("This thread has no messages to title yet.".to_owned());
    }
    Ok(TitlePromptInput {
        message: text,
        project_title: request.project_title.clone(),
        previous_title,
        attachments,
        instructions,
    })
}

enum Attempt {
    Done(String),
    /// Retried for a first title.
    Failed(String),
    /// Not retried: nothing was sent.
    NotServed,
}

impl Titles {
    /// The reply's title, sanitized, or why it cannot be one.
    fn accept(text: &str, label: &str) -> Attempt {
        let Some(reply) = prompts::decode_title_reply(text) else {
            return Attempt::Failed(format!("{label} returned invalid structured output."));
        };
        let title = prompts::sanitize_thread_title(&reply.title);
        // Some models echo the output schema's key instead of a title.
        if title.to_lowercase() == "title" {
            return Attempt::Failed(
                "The model returned the placeholder title \"title\".".to_owned(),
            );
        }
        Attempt::Done(title)
    }

    /// One title: the prompt, and up to three tries for a first title.
    pub async fn title(&self, request: TitleRequest) -> Result<String, String> {
        let settings = self.generators.settings();
        let project_id = request.project_id.as_deref();
        let (instance, _model, selection) = title_model_selection(&settings, project_id);
        let input = prompt_input(&request, title_instructions(&settings, project_id))?;
        let prompt = prompts::thread_title_prompt(&input);
        let initial = matches!(request.kind, TitleKind::Initial { .. });
        let delays: &[Duration] = if initial { &self.retry_delays } else { &[] };
        let mut delays = delays.iter();
        // A text generator answers when the selection names one; else the agent provider.
        let agent = self.generators.config(&instance).is_none();
        let images = if agent {
            let dir = self.attachments_dir.clone();
            let request = request.clone();
            let input = input.clone();
            tokio::task::spawn_blocking(move || image_paths(&request, &input, dir.as_deref()))
                .await
                .unwrap_or_default()
                .into_iter()
                .collect()
        } else {
            Vec::new()
        };
        let cwd = request.cwd.clone().unwrap_or_else(|| {
            std::env::current_dir()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".to_owned())
        });
        loop {
            let model_selection = conn_contract::from_json(selection.clone())
                .map_err(|_| "The title model selection is not valid.".to_owned())?;
            let request = TextGenerationRequest {
                operation: "generateThreadTitle".into(),
                cwd: cwd.clone(),
                prompt: prompt.clone(),
                output_schema: prompts::TITLE_OUTPUT_SCHEMA.into(),
                model_selection,
                image_paths: images.clone(),
                timeout: None,
                investigate: false,
            };
            let attempt = match super::generate(&self.generators, &self.providers, request).await {
                Ok(Some((text, label))) => Self::accept(&text, &label),
                Ok(None) => Attempt::NotServed,
                Err(detail) => Attempt::Failed(detail),
            };
            match attempt {
                Attempt::Done(title) => return Ok(title),
                Attempt::NotServed => return Err(AGENT_TITLES_NOT_SERVED.to_owned()),
                Attempt::Failed(detail) => match delays.next() {
                    Some(delay) => tokio::time::sleep(*delay).await,
                    None => return Err(detail),
                },
            }
        }
    }
}

impl TitleGenerator for Titles {
    fn generate(&self, request: TitleRequest) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(self.title(request))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_title_waits_as_t3_between_tries() {
        assert_eq!(
            INITIAL_RETRY_DELAYS,
            [Duration::from_secs(2), Duration::from_secs(4)]
        );
    }
}
