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
    let limit = u64_arg(args, "limit").unwrap_or(20) as usize;
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

/// `t3_environment_read`. Preferences are the settings defaults: this server has no
/// settings store.
pub(super) fn environment(cx: &Cx<'_>) -> Value {
    let config = cx.config();
    json!({
        "environmentId": config.environment_id,
        "label": config.label,
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
            let models: Vec<&Value> = provider["models"]
                .as_array()
                .map(|m| m.iter().collect())
                .unwrap_or_default();
            let matching: Vec<&&Value> = models
                .iter()
                .filter(|model| {
                    let haystack = format!(
                        "{} {}",
                        model["slug"].as_str().unwrap_or_default(),
                        model["name"].as_str().unwrap_or_default()
                    )
                    .to_lowercase();
                    terms.iter().all(|term| haystack.contains(term))
                })
                .collect();
            let listed: Vec<Value> = matching
                .iter()
                .take(LISTED_MODEL_LIMIT)
                .map(|model| {
                    let slug = model["slug"].as_str().unwrap_or_default();
                    let name = model["name"].as_str().unwrap_or(slug);
                    let mut entry = json!({ "id": slug });
                    if !name.eq_ignore_ascii_case(slug) {
                        entry["label"] = json!(name);
                    }
                    entry
                })
                .collect();
            let omitted = matching.len().saturating_sub(listed.len());
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

/// A provider entry for `instance_id`, from `ServerConfig.providers`.
pub(super) fn provider(cx: &Cx<'_>, instance_id: &str) -> Option<Value> {
    (cx.config().providers)()
        .into_iter()
        .find(|p| p["instanceId"] == instance_id)
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
