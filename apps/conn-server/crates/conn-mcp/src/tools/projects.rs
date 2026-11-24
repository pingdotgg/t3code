//! Projects, the environment, and what can run here.

use serde_json::{Value, json};

use super::{Args, Cx, ToolResult, fail, str_arg, u64_arg};

/// A project row as `OrchestrationProject`: every key TS sends, the engine's values on top.
fn project(row: &Value) -> Value {
    let mut out = json!({
        "id": null, "title": null, "workspaceRoot": null, "repositoryIdentity": null,
        "faviconPath": null, "projectIcon": null, "defaultModelSelection": null,
        "defaultThreadEnvMode": null, "autoPull": false, "scripts": [], "pinnedAt": null,
        "archivedAt": null, "createdAt": null, "updatedAt": null, "deletedAt": null,
    });
    if let (Some(out), Some(row)) = (out.as_object_mut(), row.as_object()) {
        for (key, value) in row {
            out.insert(key.clone(), value.clone());
        }
        // The engine's own record of a renamed title; `Project` has no such field.
        out.remove("hasCustomTitle");
    }
    out
}

pub(super) async fn list(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let shell = cx.shell().await?;
    let projects: Vec<&Value> = shell["projects"]
        .as_array()
        .map(|p| p.iter().filter(|p| p["deletedAt"].is_null()).collect())
        .unwrap_or_default();
    let cursor = u64_arg(args, "cursor").unwrap_or(0) as usize;
    // `clampedPositiveInt(100)`: a larger limit is clamped, not refused.
    let limit = u64_arg(args, "limit").map_or(20, |l| l.min(100)) as usize;
    let page: Vec<Value> = projects
        .iter()
        .skip(cursor)
        .take(limit)
        .map(|p| project(p))
        .collect();
    let end = cursor + page.len();
    Ok(json!({
        "projects": page,
        "nextCursor": if end < projects.len() { json!(end) } else { Value::Null },
    }))
}

pub(super) async fn read(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let id = str_arg(args, "projectId").unwrap_or_default();
    let shell = cx.shell().await?;
    shell["projects"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"] == id && p["deletedAt"].is_null()))
        .map(project)
        .ok_or_else(|| fail("invalid_request", "The project was not found."))
}

/// `conn_environment_read`. Preferences are the settings defaults: this server has no
/// settings store.
pub(super) fn environment(cx: &Cx<'_>) -> Value {
    let config = cx.config();
    if let Some(settings) = &config.settings {
        return json!({
            "environmentId": config.environment_id,
            "label": config.label.get(),
            "serverVersion": config.server_version,
            "platform": config.platform,
            "preferences": crate::peers::preferences(&(settings.read)()),
        });
    }
    json!({
        "environmentId": config.environment_id,
        "label": config.label.get(),
        "serverVersion": config.server_version,
        "platform": config.platform,
        "preferences": {
            "newWorktreesStartFromOrigin": true,
            "enableProviderUpdateChecks": true,
            "backgroundActivity": {"profile": "balanced"},
            "sourceControlWritingStyle": {
                "mode": "repo_conventions",
                "followChangeRequestTemplates": true,
                "customInstructions": "",
                "truncated": false,
            },
        },
    })
}

const LISTED_MODEL_LIMIT: usize = 8;
/// `FULL_CATALOG_DRIVERS`: drivers whose current models are all listed.
const FULL_CATALOG_DRIVERS: &[&str] = &["codex", "claudeAgent", "muse", "grok"];

/// `listCapabilityModels` (`OrchestratorMcpService.ts`), without the user's model order,
/// hidden models and favourites, which this server does not keep. A search lists the matching
/// models; otherwise the current (not legacy) ones, all for a full-catalog driver, and the
/// pinned ones (custom, or the caller's own model). Returns the listed models and how many
/// were left out.
fn list_models<'a>(
    provider: &'a Value,
    terms: &[String],
    inherited: Option<&Value>,
) -> (Vec<&'a Value>, usize) {
    let visible: Vec<&Value> = provider["models"]
        .as_array()
        .map(|m| m.iter().collect())
        .unwrap_or_default();
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let provider_text = format!(
        "{} {} {}",
        text(&provider["instanceId"]),
        text(&provider["driver"]),
        text(&provider["displayName"])
    )
    .to_lowercase();
    // Whole ids like "codex-work" and their parts both name the provider.
    let provider_words: Vec<&str> = provider_text
        .split_whitespace()
        .chain(provider_text.split(|c: char| !c.is_alphanumeric()))
        .collect();
    let model_text = |model: &Value| {
        format!(
            "{} {} {}",
            text(&model["slug"]),
            text(&model["name"]),
            text(&model["subProvider"])
        )
        .to_lowercase()
    };
    // Part of a provider word ("agent" in "claudeAgent") names the provider unless a model
    // matches it.
    let model_terms: Vec<&String> = terms
        .iter()
        .filter(|term| {
            !provider_words.contains(&term.as_str())
                && (!provider_text.contains(term.as_str())
                    || visible
                        .iter()
                        .any(|m| model_text(m).contains(term.as_str())))
        })
        .collect();
    if !model_terms.is_empty() {
        let matches: Vec<&Value> = visible
            .iter()
            .copied()
            .filter(|m| {
                let haystack = model_text(m);
                model_terms.iter().all(|t| haystack.contains(t.as_str()))
            })
            .collect();
        let omitted = matches.len().saturating_sub(LISTED_MODEL_LIMIT);
        return (
            matches.into_iter().take(LISTED_MODEL_LIMIT).collect(),
            omitted,
        );
    }
    let full = FULL_CATALOG_DRIVERS.contains(&text(&provider["driver"]).as_str());
    let shown: Vec<&Value> = visible
        .iter()
        .copied()
        .filter(|m| m["isLegacy"] != true)
        .take(if full { usize::MAX } else { LISTED_MODEL_LIMIT })
        .collect();
    let pinned = |m: &Value| {
        m["isCustom"] == true
            || inherited.is_some_and(|i| {
                i["instanceId"] == provider["instanceId"] && i["model"] == m["slug"]
            })
    };
    let listed: Vec<&Value> = visible
        .iter()
        .copied()
        .filter(|m| pinned(m) || shown.iter().any(|s| std::ptr::eq(*s, *m)))
        .collect();
    let omitted = visible.len().saturating_sub(listed.len());
    (listed, omitted)
}

/// One listed model: its id, its name when it differs, and its options as
/// `capabilityModelOption` gives them (ids, allowed values, the default).
fn listed_model(model: &Value) -> Value {
    let slug = model["slug"].as_str().unwrap_or_default();
    let name = model["name"].as_str().unwrap_or(slug);
    let mut entry = json!({ "id": slug });
    if !name.eq_ignore_ascii_case(slug) {
        entry["label"] = json!(name);
    }
    let options: Vec<Value> = model["capabilities"]["optionDescriptors"]
        .as_array()
        .map(|d| d.iter().map(model_option).collect())
        .unwrap_or_default();
    if !options.is_empty() {
        entry["options"] = json!(options);
    }
    entry
}

/// `capabilityModelOption` with `getProviderOptionCurrentValue` for no selection.
fn model_option(descriptor: &Value) -> Value {
    let boolean = descriptor["type"] == "boolean";
    let values = if boolean {
        json!([false, true])
    } else {
        json!(
            descriptor["options"]
                .as_array()
                .map(|o| o.iter().map(|c| c["id"].clone()).collect::<Vec<_>>())
                .unwrap_or_default()
        )
    };
    let current = &descriptor["currentValue"];
    let default = if boolean {
        current.is_boolean().then(|| current.clone())
    } else if current.as_str().is_some_and(|v| !v.is_empty()) {
        Some(current.clone())
    } else {
        descriptor["options"].as_array().and_then(|o| {
            o.iter()
                .find(|c| c["isDefault"] == true)
                .map(|c| c["id"].clone())
        })
    };
    let mut option = json!({ "id": descriptor["id"], "values": values });
    if let Some(default) = default {
        option["default"] = default;
    }
    option
}

/// `orchestrator_capabilities`: the providers that can run a delegated task here.
pub(super) async fn capabilities(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let limits = cx.limits().await?;
    let own = cx.caller_projection().await?;
    let inherited = own.as_ref().map(|p| p["thread"]["modelSelection"].clone());
    let terms: Vec<String> = str_arg(args, "search")
        .unwrap_or_default()
        .to_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let providers: Vec<Value> = (cx.config().providers)()
        .iter()
        .filter(|p| p["enabled"] != false)
        .map(|provider| {
            let (listed, omitted) = list_models(provider, &terms, inherited.as_ref());
            let listed: Vec<Value> = listed.into_iter().map(listed_model).collect();
            let ready = provider["status"] == "ready" && provider["installed"] != false;
            let mut entry = json!({
                "providerInstanceId": provider["instanceId"],
                "driverKind": provider["driver"],
                "displayName": provider["displayName"],
                "models": listed,
                "canRunChildTask": ready,
                "canRunCrossProviderChildTask": ready,
                "constraints": if ready { json!([]) } else { json!(["Provider is not ready."]) },
            });
            if omitted > 0 {
                entry["omittedModels"] = json!(omitted);
            }
            entry
        })
        .collect();
    Ok(json!({
        "parentThreadId": cx.caller_thread_id(),
        "inheritedProviderInstanceId": inherited.as_ref().map_or(Value::Null, |m| m["instanceId"].clone()),
        "inheritedModel": inherited.as_ref().map_or(Value::Null, |m| m["model"].clone()),
        "inheritedOptions": [],
        "runtimeMode": limits.runtime_mode,
        "interactionMode": limits.interaction_mode,
        "providers": providers,
        "features": {
            "appOwnedSubagents": true,
            "asyncPolling": true,
            "cancellation": true,
            "batchThreadCreation": false,
            "threadManagement": true,
            "incrementalThreadRead": true,
            "scheduledTasks": false,
            "maxBatchThreads": 0,
        },
    }))
}

/// The first ready provider and its first model: a client's default when the project has none.
pub(super) fn default_model_selection(cx: &Cx<'_>) -> Option<Value> {
    (cx.config().providers)()
        .into_iter()
        .find(|p| p["status"] == "ready" && p["enabled"] != false)
        .and_then(|p| {
            let model = p["models"][0]["slug"].as_str()?.to_owned();
            Some(json!({"instanceId": p["instanceId"], "model": model}))
        })
}

// ---- conn_project_create, conn_project_update, conn_project_delete, conn_project_clone ----------
// (`apps/server/src/mcp/toolkits/project/handlers.ts`), on the engine's `projects.*` calls.

/// `unavailable`: a failure the caller cannot act on.
fn unavailable() -> super::ToolError {
    fail(
        "orchestration_error",
        "The operation could not be completed.",
    )
}

/// `projectFailure`: a `ProjectMutationError`'s cause, as the toolkit words it.
fn project_failure(error: conn_engine::EngineError<Value>) -> super::ToolError {
    let conn_engine::EngineError::Rejected(error) = error else {
        return unavailable();
    };
    let cause = &error["cause"];
    match cause["_tag"].as_str() {
        Some("ProjectInvalidError") => fail(
            "invalid_request",
            cause["message"].as_str().unwrap_or_default().to_owned(),
        ),
        Some("ProjectNotFoundError") => fail("invalid_request", "The project was not found."),
        Some("ProjectConflictError") => fail(
            "invalid_request",
            "The workspace is already registered to a project.",
        ),
        Some("ProjectNotEmptyError") => fail(
            "invalid_request",
            "The project is not empty; force=true is required to delete it.",
        ),
        _ => unavailable(),
    }
}

/// `newCommandId`.
fn command_id() -> String {
    format!("mcp:{}", conn_support::uuid_v4())
}

impl super::Cx<'_> {
    async fn mutate_project(&self, input: Value) -> ToolResult {
        self.engine()
            .call("projects.mutate", input)
            .await
            .map(|row| project(&row))
            .map_err(project_failure)
    }
}

pub(super) async fn create(cx: &super::Cx<'_>, args: &Args) -> ToolResult {
    // Linked work may bring the repository it works in; a registered folder is still refused.
    cx.environment_writer_from_links().await?;
    let Some(root) = args.get("workspaceRoot") else {
        // Only updates record model defaults; refuse defaults creation would drop.
        if [
            "scripts",
            "createWorkspaceRootIfMissing",
            "defaultModelSelection",
        ]
        .iter()
        .any(|key| args.contains_key(*key))
        {
            return Err(fail(
                "invalid_request",
                "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with conn_project_update.",
            ));
        }
        let created = cx
            .engine()
            .call(
                "projects.createNew",
                json!({"name": args.get("title").cloned().unwrap_or(Value::Null)}),
            )
            .await
            .map_err(|error| match error {
                conn_engine::EngineError::Rejected(error) => fail(
                    "orchestration_error",
                    error["message"].as_str().unwrap_or_default().to_owned(),
                ),
                conn_engine::EngineError::Internal(_) => unavailable(),
            })?;
        let shell = cx.shell().await.map_err(|_| unavailable())?;
        let mut row = shell["projects"]
            .as_array()
            .and_then(|p| p.iter().find(|p| p["id"] == created["projectId"]))
            .map(project)
            .ok_or_else(unavailable)?;
        if let Some(error) = created.get("commitError").filter(|e| e.is_string()) {
            row["commitError"] = error.clone();
        }
        return Ok(row);
    };
    let id = command_id();
    let mut input = args.clone();
    input.remove("environmentId");
    input.insert("workspaceRoot".into(), root.clone());
    input.insert("type".into(), json!("project.create"));
    input.insert("commandId".into(), json!(id));
    input.insert("projectId".into(), json!(id));
    cx.mutate_project(Value::Object(input)).await
}

pub(super) async fn update(cx: &super::Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let mut input = args.clone();
    input.remove("environmentId");
    input.insert("type".into(), json!("project.update"));
    input.insert("commandId".into(), json!(command_id()));
    cx.mutate_project(Value::Object(input)).await
}

pub(super) async fn delete(cx: &super::Cx<'_>, args: &Args) -> ToolResult {
    cx.environment_writer().await?;
    let id = str_arg(args, "projectId").unwrap_or_default();
    let shell = cx.shell().await.map_err(|_| unavailable())?;
    let root = shell["projects"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"] == id && p["deletedAt"].is_null()))
        .map(|p| p["workspaceRoot"].clone());
    if let Some(root) = root {
        let scratch = cx
            .engine()
            .call("projects.isScratchRoot", json!({"workspaceRoot": root}))
            .await
            .unwrap_or(Value::Bool(false));
        if scratch == true {
            return Err(fail(
                "invalid_request",
                "\"No project\" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.",
            ));
        }
    }
    let mut input = json!({"type": "project.delete", "commandId": command_id(), "projectId": id});
    if let Some(force) = args.get("force") {
        input["force"] = force.clone();
    }
    cx.mutate_project(input).await
}

pub(super) async fn clone(cx: &super::Cx<'_>, args: &Args) -> ToolResult {
    // An existing destination is never adopted, so linked work may clone.
    cx.environment_writer_from_links().await?;
    let Some(host) = cx.config().clone_repository.clone() else {
        return Err(unavailable());
    };
    let mut input = args.clone();
    input.remove("environmentId");
    host(Value::Object(input)).await.map_err(|error| {
        fail(
            "orchestration_error",
            error["detail"]
                .as_str()
                .or_else(|| error["message"].as_str())
                .unwrap_or("The operation could not be completed.")
                .to_owned(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude() -> Value {
        let effort = json!({"id": "effort", "label": "Reasoning", "type": "select", "options": [
            {"id": "low", "label": "Low"}, {"id": "medium", "label": "Medium", "isDefault": true}]});
        let thinking =
            json!({"id": "thinking", "label": "Thinking", "type": "boolean", "currentValue": true});
        let model = |slug: &str, name: &str, legacy: bool, option: &Value| {
            json!({"slug": slug, "name": name, "isCustom": false, "isLegacy": legacy,
                   "capabilities": {"optionDescriptors": [option]}})
        };
        let mut models = vec![
            model("claude-sonnet-5-5", "Claude Sonnet 5.5", false, &effort),
            model("claude-haiku-5-5", "Claude Haiku 5.5", false, &effort),
        ];
        for i in 0..9 {
            models.push(model(
                &format!("claude-opus-4-{i}"),
                &format!("Claude Opus 4.{i}"),
                true,
                &effort,
            ));
        }
        models.push(model(
            "claude-haiku-4-5",
            "Claude Haiku 4.5",
            true,
            &thinking,
        ));
        json!({"instanceId": "claudeAgent", "driver": "claudeAgent", "displayName": "Claude",
               "models": models})
    }

    fn ids(listed: &[&Value]) -> Vec<String> {
        listed
            .iter()
            .filter_map(|m| m["slug"].as_str().map(str::to_owned))
            .collect()
    }

    /// The T3 server lists a full-catalog driver's current models and leaves the legacy ones
    /// out, counted in `omittedModels`; a caller's own legacy model stays listed.
    #[test]
    fn legacy_models_are_left_out_unless_pinned_or_searched() {
        let provider = claude();
        let (listed, omitted) = list_models(&provider, &[], None);
        assert_eq!(
            ids(&listed),
            ["claude-sonnet-5-5", "claude-haiku-5-5"],
            "current models only"
        );
        assert_eq!(omitted, 10, "the ten legacy models are counted");

        let own = json!({"instanceId": "claudeAgent", "model": "claude-haiku-4-5"});
        let (listed, omitted) = list_models(&provider, &[], Some(&own));
        assert!(
            ids(&listed).contains(&"claude-haiku-4-5".to_owned()),
            "the caller's model is pinned"
        );
        assert_eq!(omitted, 9, "one fewer left out");

        // "claude" names the provider, so only "haiku" and "4.5" search the models.
        let terms = ["claude".to_owned(), "haiku".to_owned(), "4.5".to_owned()];
        let (listed, omitted) = list_models(&provider, &terms, None);
        assert_eq!(
            ids(&listed),
            ["claude-haiku-4-5"],
            "a search finds a legacy model"
        );
        assert_eq!(omitted, 0, "nothing else matches");
    }

    #[test]
    fn listed_models_carry_their_options_and_defaults() {
        let provider = claude();
        let haiku = provider["models"][1].clone();
        assert_eq!(
            listed_model(&haiku),
            json!({"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5",
                   "options": [{"id": "effort", "values": ["low", "medium"], "default": "medium"}]}),
            "a select lists its choices and its default"
        );
        let legacy = provider["models"][11].clone();
        assert_eq!(
            listed_model(&legacy)["options"],
            json!([{"id": "thinking", "values": [false, true], "default": true}]),
            "a boolean lists both values and its current value"
        );
    }
}
