//! Batch top-level creation in the calling thread's checkout, recorded in its timeline.

use serde_json::{Value, json};

use super::{Args, Cx, ToolResult, encode, fail, internal, threads};
use crate::view;

pub(super) async fn create(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("create_threads")?;
    cx.writing_caller().await?;
    let parent = cx.projection(&caller.thread_id).await?;
    let run = view::active_run(&parent)
        .filter(|r| {
            !r["rootNodeId"].is_null() && r["providerInstanceId"] == caller.provider_instance_id
        })
        .ok_or_else(|| {
            fail(
                "parent_not_active",
                "Thread creation requires an active run owned by this MCP provider session.",
            )
        })?;
    let key = Cx::request_key(args);
    let requests = args
        .get("threads")
        .and_then(Value::as_array)
        .ok_or_else(|| internal("missing threads"))?;
    let mut created = Vec::with_capacity(requests.len());
    for (index, request) in requests.iter().enumerate() {
        let command_id = format!("{}:{index}", cx.stable_id("command", "create-thread", &key));
        let thread_id = format!(
            "thread:mcp:{}:{}:{index}",
            encode(&cx.caller.namespace()),
            encode(&key)
        );
        let message_id = format!(
            "message:mcp:{}:{}:{index}",
            encode(&cx.caller.namespace()),
            encode(&key)
        );
        let accepted = cx
            .engine()
            .has_receipt(&command_id)
            .await
            .map_err(internal)?;
        let mut target = request.get("target").cloned().unwrap_or_else(|| json!({}));
        if accepted {
            target["providerInstanceId"] =
                cx.projection(&thread_id).await?["thread"]["modelSelection"]["instanceId"].clone();
        }
        let selection = match resolve_target(cx, &parent["thread"], &target, accepted) {
            Err(super::ToolError::Failure {
                code: "provider_unavailable" | "model_unavailable",
                ..
            }) if let Some(refresh) = &cx.config().refresh_provider
                && (target["providerInstanceId"].is_string()
                    || !target["driverKind"].is_string()) =>
            {
                let id = target["providerInstanceId"]
                    .as_str()
                    .or_else(|| parent["thread"]["modelSelection"]["instanceId"].as_str())
                    .unwrap_or_default();
                refresh(id.to_owned()).await;
                resolve_target(cx, &parent["thread"], &target, accepted)?
            }
            result => result?,
        };
        let mut runtime = threads::resolve_runtime_mode(
            parent["thread"]["runtimeMode"]
                .as_str()
                .unwrap_or("approval-required"),
            request["runtimeMode"].as_str(),
        )?;
        if let Some(provider) = (cx.config().providers)()
            .iter()
            .find(|p| p["instanceId"] == selection["instanceId"])
            && let Some(supported) = provider["supportedRuntimeModes"]
                .as_array()
                .filter(|s| !s.is_empty())
            && !supported.iter().any(|m| *m == runtime)
        {
            if request["runtimeMode"]
                .as_str()
                .is_some_and(|m| m != "inherit")
            {
                return Err(fail(
                    "invalid_request",
                    format!(
                        "Provider {} does not offer runtime mode {runtime}, so it would run as approval-required. Use one of: {}.",
                        selection["instanceId"].as_str().unwrap_or_default(),
                        supported
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
            runtime = supported
                .iter()
                .filter_map(Value::as_str)
                .filter(|m| super::runtime_rank(m) <= super::runtime_rank(&runtime))
                .max_by_key(|m| super::runtime_rank(m))
                .unwrap_or("approval-required")
                .to_owned();
        }
        let interaction = threads::resolve_interaction_mode(
            parent["thread"]["interactionMode"]
                .as_str()
                .unwrap_or("default"),
            request["interactionMode"].as_str(),
        )?;
        assert_project_enabled(cx, &parent["thread"], accepted, &selection)?;
        let mut command = json!({
            "type":"thread.create", "commandId":command_id, "threadId":thread_id,
            "projectId":parent["thread"]["projectId"],
            "title":title(&parent["thread"], request, index), "modelSelection":selection,
            "runtimeMode":runtime, "interactionMode":interaction,
            "branch":parent["thread"]["branch"], "worktreePath":parent["thread"]["worktreePath"],
            "createdBy":"agent", "creationSource":"mcp",
        });
        if let Some(prompt) = request["prompt"].as_str() {
            command["initialMessage"] = json!({"senderThreadId":caller.thread_id,"messageId":message_id,"text":prompt,"attachments":[]});
        }
        if let Some(origin) = parent["thread"].get("linkOrigin") {
            command["linkOrigin"] = origin.clone();
        }
        cx.dispatch(command).await.map_err(|e| {
            indexed_dispatch_error(e, &format!("Unable to create thread {}", index + 1))
        })?;
        let created_run = cx
            .engine()
            .created_run_status(&command_id)
            .await
            .map_err(internal)?;
        let mut projection = cx.projection(&thread_id).await?;
        if created_run.is_none()
            && let Some(prompt) = request["prompt"].as_str()
        {
            let dispatch_id = format!(
                "{}:{index}",
                cx.stable_id("command", "dispatch-thread", &key)
            );
            assert_project_enabled(
                cx,
                &parent["thread"],
                cx.engine()
                    .has_receipt(&dispatch_id)
                    .await
                    .map_err(internal)?,
                &projection["thread"]["modelSelection"],
            )?;
            cx.dispatch(json!({
                "type":"message.dispatch", "commandId":dispatch_id,
                "threadId":thread_id,"messageId":message_id,"text":prompt,"attachments":[],
                "senderThreadId":caller.thread_id,"modelSelection":projection["thread"]["modelSelection"],
                "dispatchMode":{"type":"start_immediately"},"createdBy":"agent","creationSource":"mcp",
            })).await.map_err(|e| indexed_dispatch_error(e, &format!("Unable to start thread {}", index + 1)))?;
            projection = cx.projection(&thread_id).await?;
        }
        let child_run = projection["runs"].as_array().and_then(|runs| runs.last());
        cx.dispatch(json!({
            "type":"thread.created.record", "commandId":format!("{}:{index}",cx.stable_id("command","record-created-thread",&key)),
            "parentThreadId":caller.thread_id,"parentRunId":run["id"],"parentNodeId":run["rootNodeId"],
            "targetThreadId":thread_id,"targetRunId":child_run.map(|r| &r["id"]),
        })).await.map_err(|e| indexed_dispatch_error(e, &format!("Unable to record thread {} in the parent timeline", index + 1)))?;
        let thread = &projection["thread"];
        created.push(json!({
            "threadId":thread_id,"link":cx.link(&thread_id,thread["title"].as_str().unwrap_or_default()),
            "runId":child_run.map(|r| &r["id"]),"status":child_run.map_or(json!("idle"),|r|r["status"].clone()),
            "title":thread["title"],"createdBy":thread["createdBy"],"creationSource":thread["creationSource"],
            "providerInstanceId":thread["modelSelection"]["instanceId"],"model":thread["modelSelection"]["model"],
        }));
    }
    Ok(json!({"threads":created}))
}

fn assert_project_enabled(
    cx: &Cx<'_>,
    parent: &Value,
    accepted: bool,
    selection: &Value,
) -> Result<(), super::ToolError> {
    let instance = selection["instanceId"].as_str().unwrap_or_default();
    let project = parent["projectId"].as_str().unwrap_or_default();
    if !accepted && !cx.engine().provider_instance_enabled(project, instance) {
        return Err(fail(
            "invalid_request",
            format!("Provider instance \"{instance}\" is disabled for project {project}."),
        ));
    }
    Ok(())
}

fn indexed_dispatch_error(error: super::ToolError, prefix: &str) -> super::ToolError {
    match error {
        super::ToolError::Failure { message, .. } => {
            fail("orchestration_error", format!("{prefix}: {message}"))
        }
        other => other,
    }
}

fn title(parent: &Value, request: &Value, index: usize) -> String {
    let detail = request["title"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            request["prompt"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        });
    let Some(detail) = detail else {
        return format!(
            "{} thread {}",
            parent["title"].as_str().unwrap_or_default(),
            index + 1
        );
    };
    if detail.encode_utf16().count() <= 80 {
        return detail.to_owned();
    }
    let prefix = conn_support::text::utf16_prefix(detail, 77);
    format!("{prefix}...")
}

fn resolve_target(cx: &Cx<'_>, parent: &Value, target: &Value, accepted: bool) -> ToolResult {
    let inherited = &parent["modelSelection"];
    let providers = (cx.config().providers)();
    let requested_driver = target["driverKind"].as_str();
    let inherited_id = inherited["instanceId"].as_str().unwrap_or_default();
    let instance = if let Some(instance) = target["providerInstanceId"].as_str() {
        instance
    } else if let Some(driver) = requested_driver {
        let candidates: Vec<_> = providers.iter().filter(|p| p["driver"] == driver).collect();
        if candidates.is_empty() {
            return Err(fail(
                "provider_unavailable",
                format!("No V2 provider adapter is registered for driver {driver}."),
            ));
        }
        let healthy: Vec<_> = candidates
            .into_iter()
            .filter(|p| constraints(p).is_empty())
            .collect();
        healthy
            .iter()
            .copied()
            .filter(|p| {
                accepted
                    || cx.engine().provider_instance_enabled(
                        parent["projectId"].as_str().unwrap_or_default(),
                        p["instanceId"].as_str().unwrap_or_default(),
                    )
            })
            .min_by_key(|p| usize::from(p["instanceId"] != inherited_id))
            .and_then(|p| p["instanceId"].as_str())
            .ok_or_else(|| {
                fail(
                    "provider_unavailable",
                    if healthy.is_empty() {
                        format!("No available V2 provider instance for driver {driver}.")
                    } else {
                        format!("No instance of driver {driver} is enabled for this project.")
                    },
                )
            })?
    } else {
        inherited_id
    };
    let provider = providers
        .iter()
        .find(|p| p["instanceId"] == instance)
        .ok_or_else(|| {
            fail(
                "provider_unavailable",
                format!("Provider instance {instance} is not registered."),
            )
        })?;
    if let Some(driver) = requested_driver
        && provider["driver"] != driver
    {
        return Err(fail(
            "invalid_request",
            format!(
                "Provider instance {instance} uses driver {}, not {driver}.",
                provider["driver"].as_str().unwrap_or_default()
            ),
        ));
    }
    let constraints = constraints(provider);
    if !constraints.is_empty() {
        return Err(fail(
            "provider_unavailable",
            format!(
                "Provider {instance} cannot run a child task: {}",
                constraints.join(" ")
            ),
        ));
    }
    let models = provider["models"].as_array().map_or(&[][..], Vec::as_slice);
    let model = target["model"]
        .as_str()
        .or_else(|| {
            (instance == inherited_id)
                .then(|| inherited["model"].as_str())
                .flatten()
        })
        .or_else(|| models.first().and_then(|m| m["slug"].as_str()))
        .ok_or_else(|| {
            fail(
                "model_unavailable",
                format!("Provider {instance} has no model available for inheritance."),
            )
        })?;
    let advertised = advertised_model(models, model);
    if target["model"].is_string() && !models.is_empty() && advertised.is_none() {
        return Err(fail(
            "model_unavailable",
            format!(
                "Model {model} is not advertised by provider {instance}. {}",
                models_hint(models, model)
            ),
        ));
    }
    let descriptors = advertised.and_then(|m| m["capabilities"]["optionDescriptors"].as_array());
    let inherited_model = inherited["model"].as_str().unwrap_or_default();
    let canonical = |m| {
        advertised_model(models, m)
            .and_then(|m| m["slug"].as_str())
            .unwrap_or(m)
    };
    let mut options: Option<Vec<Value>> = (instance == inherited_id
        && canonical(inherited_model) == canonical(model))
    .then(|| inherited["options"].as_array().cloned())
    .flatten();
    if let (Some(options), Some(descriptors)) = (&mut options, descriptors) {
        options.retain(|o| descriptors.iter().any(|d| d["id"] == o["id"]));
    }
    if let Some(requested) = target.get("options") {
        let requested: Vec<Value> = match requested {
            Value::Array(list) => list.clone(),
            Value::Object(map) => map
                .iter()
                .map(|(id, value)| json!({"id":id,"value":value}))
                .collect(),
            _ => return Err(fail("invalid_request", "Invalid model options.")),
        };
        let mut problems = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for selection in &requested {
            let id = selection["id"].as_str().unwrap_or_default();
            if !seen.insert(id) {
                problems.push(format!("Option {id} was specified more than once."));
                continue;
            }
            let Some(descriptors) = descriptors else {
                continue;
            };
            let Some(descriptor) = descriptors.iter().find(|d| d["id"] == id) else {
                let known = descriptors
                    .iter()
                    .filter_map(|d| d["id"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                problems.push(format!(
                    "Unknown option {id}; supported options: {}.",
                    if known.is_empty() { "none" } else { &known }
                ));
                continue;
            };
            if descriptor["type"] == "boolean" && !selection["value"].is_boolean() {
                problems.push(format!("Option {id} expects a boolean value."));
            } else if descriptor["type"] == "select"
                && !descriptor["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["id"] == selection["value"])
            {
                let choices = descriptor["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["id"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                problems.push(format!("Option {id} must be one of: {choices}."));
            }
        }
        if !problems.is_empty() {
            return Err(fail(
                "invalid_request",
                format!(
                    "Model {model} on provider {instance} rejected options: {}",
                    problems.join(" ")
                ),
            ));
        }
        if requested.is_empty() {
            options = Some(Vec::new());
        }
        for option in requested {
            let options = options.get_or_insert_default();
            if let Some(previous) = options.iter_mut().find(|o| o["id"] == option["id"]) {
                *previous = option;
            } else {
                options.push(option);
            }
        }
    }
    let mut selection = json!({"instanceId":instance,"model":model});
    if let Some(options) = options {
        selection["options"] = json!(options);
    }
    Ok(selection)
}

fn constraints(provider: &Value) -> Vec<&str> {
    if provider["enabled"] == false {
        return vec!["Provider instance is disabled."];
    }
    let mut constraints = Vec::new();
    if provider["installed"] == false {
        constraints.push("Provider executable is not installed.");
    }
    if matches!(provider["status"].as_str(), Some("error" | "disabled")) {
        constraints.push(
            provider["message"]
                .as_str()
                .unwrap_or("Provider driver is unavailable."),
        );
    }
    if provider["auth"]["status"] == "unauthenticated" {
        constraints.push("Provider is not authenticated.");
    }
    constraints
}

fn advertised_model<'a>(models: &'a [Value], model: &str) -> Option<&'a Value> {
    models.iter().find(|m| m["slug"] == model).or_else(|| {
        models.iter().find(|m| {
            m["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|alias| alias.eq_ignore_ascii_case(model))
        })
    })
}

fn models_hint(models: &[Value], requested: &str) -> String {
    let tail = |s: &str| s.rsplit('/').next().unwrap_or_default().to_lowercase();
    let close: Vec<_> = models
        .iter()
        .filter_map(|m| m["slug"].as_str())
        .filter(|m| tail(m) == tail(requested))
        .take(8)
        .collect();
    if !close.is_empty() {
        return format!("Did you mean {}?", close.join(", "));
    }
    let mut sorted: Vec<_> = models.iter().collect();
    sorted.sort_by_key(|m| usize::from(m["isLegacy"] == true));
    let listed = sorted
        .iter()
        .take(8)
        .filter_map(|m| m["slug"].as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let omitted = models.len().saturating_sub(8);
    format!(
        "Advertised models: {listed}{}.",
        if omitted > 0 {
            format!(" and {omitted} more; orchestrator_capabilities with search finds them")
        } else {
            String::new()
        }
    )
}
