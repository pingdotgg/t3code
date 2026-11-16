//! Commit message generation using the configured writer.
use super::Deps;
use super::git::manager;
use crate::table::Failure;
use conn_contract::GitRunStackedActionInput;
use conn_vcs::commit;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
pub(super) async fn generate(
    deps: &Deps,
    input: &GitRunStackedActionInput,
    branch: Option<&str>,
    context: &commit::Context,
    feature: bool,
) -> Result<(String, String, Option<String>), Failure> {
    use crate::text_generation::{prompts, title};
    let Some(generators) = &deps.text_generators else {
        return Err(manager(&input.cwd, "Failed to get server settings."));
    };
    let settings = generators.settings();
    let project = super::git::project_id(
        deps,
        &input.cwd,
        input.thread_id.as_deref(),
        input.project_id.as_deref(),
    )
    .await;
    let selection = title::project_override(
        &settings,
        project.as_deref(),
        "sourceControlWriterModelSelection",
    )
    .or_else(|| settings.get("sourceControlWriterModelSelection"))
    .filter(|s| !s.is_null())
    .filter(|s| {
        s.get("instanceId")
            .and_then(Value::as_str)
            .is_some_and(|id| {
                title::selection_enabled(&settings, project.as_deref(), id)
                    && (generators.config(id).is_some() || deps.providers.get(id).is_some())
            })
    });
    let (instance, _model, selection) = if let Some(selection) = selection {
        (
            selection
                .get("instanceId")
                .and_then(Value::as_str)
                .unwrap_or("codex")
                .to_owned(),
            selection
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            selection.clone(),
        )
    } else {
        title::title_model_selection(&settings, project.as_deref())
    };
    let style = title::project_override(&settings, project.as_deref(), "sourceControlWritingStyle")
        .or_else(|| settings.get("sourceControlWritingStyle"));
    let mode = style
        .and_then(|s| s.get("mode"))
        .and_then(Value::as_str)
        .unwrap_or("repo_conventions");
    let policy = if mode == "conventional_commits" {
        prompts::COMMIT_POLICIES
            .first()
            .copied()
            .unwrap_or_default()
            .to_owned()
    } else if mode == "custom" {
        style
            .and_then(|s| s.get("customInstructions"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        let mut policy = prompts::COMMIT_POLICIES
            .get(1)
            .copied()
            .unwrap_or_default()
            .to_owned();
        let subjects = conn_vcs::process::GitCommand::new(
            "GitManager.readRecentCommitSubjects",
            Path::new(&input.cwd),
            [
                "log",
                "-n",
                "20",
                "--no-merges",
                "--no-show-signature",
                "--pretty=format:%s",
            ],
        )
        .text()
        .await
        .unwrap_or_default();
        if !subjects.trim().is_empty() {
            policy.push_str("\n\nRecent commit subjects from this repository:\n");
            policy.push_str(subjects.trim());
        }
        let cwd = PathBuf::from(&input.cwd);
        let claude = deps
            .providers
            .get(&instance)
            .is_some_and(|p| p.driver() == "claudeAgent");
        let instructions = tokio::task::spawn_blocking(move || {
            let read = |name| {
                let Ok(root) = std::fs::canonicalize(&cwd) else {
                    return String::new();
                };
                let Ok(path) = std::fs::canonicalize(cwd.join(name)) else {
                    return String::new();
                };
                if !path.starts_with(root) {
                    return String::new();
                }
                let Ok(metadata) = std::fs::metadata(&path) else {
                    return String::new();
                };
                if !metadata.is_file() || metadata.len() > 20_000 {
                    return String::new();
                }
                std::fs::read_to_string(path)
                    .unwrap_or_default()
                    .trim()
                    .to_owned()
            };
            let agents = read("AGENTS.md");
            let other = if claude {
                read("CLAUDE.md")
            } else {
                String::new()
            };
            (agents, other)
        })
        .await
        .unwrap_or_default();
        if !instructions.0.trim().is_empty() {
            policy.push_str("\n\nLocal AGENTS.md:\n");
            policy.push_str(instructions.0.trim());
        }
        if !instructions.1.trim().is_empty() && instructions.1 != instructions.0 {
            policy.push_str("\n\nLocal CLAUDE.md:\n");
            policy.push_str(instructions.1.trim());
        }
        policy
    };
    let prompt =
        prompts::commit_message_prompt(branch, &context.summary, &context.patch, &policy, feature);
    let error = |detail: String| {
        Failure::Fail(
            json!({"_tag":"TextGenerationError","operation":"generateCommitMessage","detail":detail}),
        )
    };
    let request = conn_provider::TextGenerationRequest {
        operation: "generateCommitMessage".into(),
        cwd: input.cwd.clone(),
        prompt,
        output_schema: prompts::COMMIT_SCHEMAS
            .get(usize::from(feature))
            .copied()
            .unwrap_or_default()
            .into(),
        model_selection: conn_contract::from_json(selection).map_err(|e| error(e.to_string()))?,
        image_paths: vec![],
        timeout: None,
    };
    let (text, label) = crate::text_generation::generate(generators, &deps.providers, request)
        .await
        .map_err(error)?
        .ok_or_else(|| error("The selected provider does not support text generation.".into()))?;
    let value: Value = serde_json::from_str(&prompts::extract_json_object(&text))
        .map_err(|_| error(format!("{label} returned invalid structured output.")))?;
    let subject = value
        .get("subject")
        .and_then(Value::as_str)
        .ok_or_else(|| error("The model API returned invalid structured output.".into()))?
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .trim();
    let mut subject = subject.to_owned();
    if mode == "conventional_commits" {
        subject = lowercase_description(&subject);
    }
    let mut subject = crate::text_generation::js::slice16(&subject, 0, 72)
        .trim_end()
        .to_owned();
    if subject.is_empty() {
        subject = "Update project files".into();
    }
    let body = value
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| error("The model API returned invalid structured output.".into()))?
        .trim()
        .to_owned();
    Ok((
        subject,
        body,
        value
            .get("branch")
            .and_then(Value::as_str)
            .map(str::to_owned),
    ))
}

fn lowercase_description(subject: &str) -> String {
    let kind_end = subject
        .find(|c: char| !c.is_ascii_lowercase())
        .unwrap_or(subject.len());
    if kind_end == 0 {
        return subject.into();
    }
    let mut rest = subject.get(kind_end..).unwrap_or_default();
    if let Some(scope) = rest.strip_prefix('(') {
        let Some((scope, suffix)) = scope.split_once(')') else {
            return subject.into();
        };
        if scope.contains('\n') {
            return subject.into();
        }
        rest = suffix;
    }
    rest = rest.strip_prefix('!').unwrap_or(rest);
    let Some(description) = rest.strip_prefix(": ") else {
        return subject.into();
    };
    if !description.starts_with(|c: char| c.is_ascii_uppercase()) {
        return subject.into();
    }
    let word_end = description
        .char_indices()
        .skip(1)
        .find(|(_, c)| !c.is_ascii_lowercase())
        .map_or(description.len(), |(i, _)| i);
    if description
        .get(word_end..)
        .is_some_and(|s| s.starts_with(|c: char| c.is_ascii_alphanumeric()))
    {
        return subject.into();
    }
    let start = subject.len() - description.len();
    format!(
        "{}{}{}",
        subject.get(..start).unwrap_or_default(),
        description
            .get(..word_end)
            .unwrap_or_default()
            .to_ascii_lowercase(),
        description.get(word_end..).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text_generation::{TextGenerators, tests::Stub};
    use std::sync::Arc;
    #[test]
    fn conventional_prefix_and_whole_word_match_t3() {
        for (input, expected) in [
            ("feat(scope: detail): Word", "feat(scope: detail): word"),
            ("feat(scope)): Word", "feat(scope)): Word"),
            ("feat(): A thing", "feat(): a thing"),
            ("feat: URL value", "feat: URL value"),
            ("Feat: Word", "Feat: Word"),
            ("feat: Word2", "feat: Word2"),
        ] {
            assert_eq!(lowercase_description(input), expected);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn project_writer_generates_with_its_style_and_normalizes_the_subject() {
        let replies = std::sync::Arc::new(std::sync::Mutex::new(
            [
                "feat: Add support.",
                "feat: GitHub login",
                "feat: A thing",
                "Anything: Word",
                "feat(scope)!: Word",
                "feat: A1 thing",
            ]
            .into_iter(),
        ));
        let stub=Stub::start(move |_| { let subject = replies.lock().unwrap().next().unwrap(); (200,json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"subject":subject,"body":" details "}).to_string()}}]}).to_string()) }).await;
        let config = json!({"textGenerators":{"router":{"kind":"openaiCompatible","baseUrl":format!("{}/v1",stub.base)}},"projectSettingsOverrides":{"p":{"sourceControlWriterModelSelection":{"instanceId":"router","model":"test-model"},"sourceControlWritingStyle":{"mode":"conventional_commits"}}}});
        let settings = config.as_object().unwrap().clone();
        let deps = Deps {
            text_generators: Some(Arc::new(TextGenerators::new(move || settings.clone()))),
            ..Deps::default()
        };
        let input = conn_contract::from_json(
            json!({"cwd":"/unused","actionId":"a","action":"commit","projectId":"p"}),
        )
        .unwrap();
        let (subject, body, _) = generate(
            &deps,
            &input,
            Some("feature/x"),
            &commit::Context {
                summary: "M file".into(),
                patch: "+change".into(),
            },
            false,
        )
        .await
        .unwrap();
        assert_eq!(subject, "feat: add support");
        for expected in [
            "feat: GitHub login",
            "feat: a thing",
            "Anything: Word",
            "feat(scope)!: word",
            "feat: A1 thing",
        ] {
            let (subject, _, _) = generate(
                &deps,
                &input,
                None,
                &commit::Context {
                    summary: "M file".into(),
                    patch: "+x".into(),
                },
                false,
            )
            .await
            .unwrap();
            assert_eq!(subject, expected);
        }

        assert_eq!(body, "details");
        let calls = stub.taken();
        let body: Value = serde_json::from_str(&calls.first().unwrap().body).unwrap();
        assert_eq!(body["model"], "test-model");
        assert!(body.to_string().contains("Use Conventional Commits"));
    }
    #[tokio::test(flavor = "current_thread")]
    async fn disabled_writer_falls_back_to_the_title_generator() {
        let stub=Stub::start(|_|(200,json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"subject\":\"Fallback\",\"body\":\"\"}"}}]}).to_string())).await;
        let settings = json!({"textGenerationModelSelection":{"instanceId":"router","model":"fallback"},"textGenerators":{"router":{"kind":"openaiCompatible","baseUrl":format!("{}/v1",stub.base)}},"sourceControlWritingStyle":{"mode":"custom"}}).as_object().unwrap().clone();
        for provider in [
            json!({"driver":"codex","config":{"enabled":false}}),
            json!({"driver":"grok"}),
        ] {
            let mut settings = settings.clone();
            settings.insert("providerInstances".into(), json!({"writer":provider}));
            settings.insert(
                "sourceControlWriterModelSelection".into(),
                json!({"instanceId":"writer","model":"wrong"}),
            );
            let providers: Vec<Arc<dyn conn_provider::Provider>> =
                vec![crate::text_generation::tests::titles::AgentProvider::new(
                    "writer",
                    "codex",
                    Some(json!({"subject":"Wrong","body":""})),
                )];
            let deps = Deps {
                text_generators: Some(Arc::new(TextGenerators::new(move || settings.clone()))),
                providers: providers.into(),
                ..Deps::default()
            };
            let input =
                conn_contract::from_json(json!({"cwd":"/unused","actionId":"a","action":"commit"}))
                    .unwrap();
            let (subject, _, _) = generate(
                &deps,
                &input,
                None,
                &commit::Context {
                    summary: "M file".into(),
                    patch: "+x".into(),
                },
                false,
            )
            .await
            .unwrap();
            assert_eq!(subject, "Fallback");
        }
    }
}
