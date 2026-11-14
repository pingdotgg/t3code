//! Thread titles through a text generator, as `ThreadTitleRegenerationService.ts` and
//! `TextGeneration.generateThreadTitle` make them. The engine decides when (the first message
//! of a thread launched with `generateTitle`, or `regenerateTitle`) and applies the answer;
//! this part chooses the model, builds the prompt, calls the generator and reads the reply.
//!
//! The model is the `textGenerationModelSelection` setting, or the thread's project override.
//! When it names a text generator, the prompt goes to that generator's API. When it names an
//! agent provider (Codex by default, or Claude), the T3 server asks that provider's CLI or SDK;
//! this server does not, and the request fails without a call: an initial title keeps its seed
//! and a regenerate reports [`AGENT_TITLES_NOT_SERVED`].

use std::{sync::Arc, time::Duration};

use conn_engine::{BoxFuture, TitleGenerator, TitleKind, TitleMessage, TitleRequest};
use serde_json::{Map, Value};

use super::{
    TextGenerators, generator_label,
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
#[derive(Debug)]
pub struct Titles {
    generators: Arc<TextGenerators>,
    retry_delays: Vec<Duration>,
}

impl Titles {
    pub fn new(generators: Arc<TextGenerators>) -> Self {
        Self {
            generators,
            retry_delays: INITIAL_RETRY_DELAYS.to_vec(),
        }
    }

    /// Other waits between the tries of a first title, for tests.
    #[cfg(test)]
    pub(crate) fn with_retry_delays(mut self, delays: &[Duration]) -> Self {
        self.retry_delays = delays.to_vec();
        self
    }
}

/// Whether a selection's instance is on (`resolveTextGenerationSelectionEnabled`, without the
/// project's own provider switches).
fn selection_enabled(settings: &Map<String, Value>, instance_id: &str) -> bool {
    if let Some(generator) = settings
        .get("textGenerators")
        .and_then(|g| g.get(instance_id))
    {
        return generator.get("enabled") != Some(&Value::Bool(false));
    }
    settings
        .get("providerInstances")
        .and_then(|p| p.get(instance_id))
        .and_then(|i| i.get("enabled"))
        != Some(&Value::Bool(false))
}

fn project_override<'a>(
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
    let read = |selection: &Value| {
        Some((
            selection.get("instanceId")?.as_str()?.to_owned(),
            selection.get("model")?.as_str()?.to_owned(),
        ))
    };
    if let Some(selection) = project_override(settings, project_id, "textGenerationModelSelection")
        .and_then(read)
        .filter(|(instance, _)| selection_enabled(settings, instance))
    {
        return selection;
    }
    settings
        .get("textGenerationModelSelection")
        .and_then(read)
        .unwrap_or_else(|| (DEFAULT_INSTANCE.to_owned(), String::new()))
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
    async fn attempt(&self, instance: &str, model: &str, prompt: &str) -> Attempt {
        let Some(result) = self.generators.run(instance, model, prompt).await else {
            return Attempt::NotServed;
        };
        let text = match result {
            Ok(text) => text,
            Err(detail) => return Attempt::Failed(detail),
        };
        let label = self
            .generators
            .config(instance)
            .map_or_else(|| "The model API".to_owned(), |c| generator_label(&c));
        let Some(reply) = prompts::decode_title_reply(&text) else {
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
        let (instance, model) = title_selection(&settings, project_id);
        let input = prompt_input(&request, title_instructions(&settings, project_id))?;
        let prompt = prompts::thread_title_prompt(&input);
        let initial = matches!(request.kind, TitleKind::Initial { .. });
        let delays: &[Duration] = if initial { &self.retry_delays } else { &[] };
        let mut delays = delays.iter();
        loop {
            match self.attempt(&instance, &model, &prompt).await {
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
