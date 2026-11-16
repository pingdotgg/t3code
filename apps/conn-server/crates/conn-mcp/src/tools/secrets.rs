//! `request_secret`: a status-only card on the calling run, with one-use ref or file delivery.

use conn_contract::from_json;
use conn_engine::Engine;
use conn_features::secrets::{SecretError, SecretRequests, terminal, turn_item, unsaved_note};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

use super::{Args, Cx, ToolResult, encode, fail, str_arg, u64_arg};

struct Card {
    engine: Arc<dyn Engine>,
    cancel: Option<Value>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Card {
    async fn close(&mut self) -> Result<(), String> {
        if let Some(command) = self.cancel.clone() {
            self.engine.record_secret_request(command).await?;
            self.cancel = None;
        }
        Ok(())
    }
}
impl Drop for Card {
    fn drop(&mut self) {
        if let Some(command) = self.cancel.take() {
            let engine = self.engine.clone();
            let permit = self.permit.take();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = engine.record_secret_request(command).await;
            });
        }
    }
}
fn error(e: SecretError) -> super::ToolError {
    fail("orchestration_error", e.message())
}

pub(super) async fn request(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let args = decode(args)?;
    let args = &args;
    let caller = cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    let records = cx.projection(&caller.thread_id).await?;
    let run = records
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|r| {
            !terminal(r.get("status").and_then(Value::as_str))
                && r.get("status").and_then(Value::as_str) != Some("queued")
        })
        .max_by_key(|r| r.get("ordinal").and_then(Value::as_i64).unwrap_or_default())
        .filter(|r| {
            r.get("rootNodeId").is_some_and(Value::is_string)
                && r.get("providerInstanceId").and_then(Value::as_str)
                    == Some(&caller.provider_instance_id)
        })
        .ok_or_else(|| {
            fail(
                "parent_not_active",
                "Asking for a secret requires an active run owned by this MCP provider session.",
            )
        })?;
    let secrets = cx
        .config()
        .secrets
        .as_ref()
        .ok_or_else(|| fail("capability_denied", "Secret requests are not supported."))?;
    let permit = secrets.reserve().map_err(error)?;
    let key = Cx::request_key(args);
    if let Some(value) = str_arg(args, "value") {
        if str_arg(args, "delivery") == Some("secretRef") {
            return Err(fail(
                "invalid_request",
                "A pasted `value` is saved as a file. Leave out `delivery: \"secretRef\"`.",
            ));
        }
        let file = secrets
            .save_pasted(
                &caller.thread_id,
                &cx.caller.namespace(),
                &key,
                value.to_owned(),
            )
            .await
            .map_err(error)?;
        return Ok(json!({"status":"saved", "file":file}));
    }
    let item_id = format!(
        "turn-item:secret-request:{}:{}",
        encode(&caller.thread_id),
        encode(&key)
    );
    let mut command = json!({"commandId":cx.stable_id("command", "secret-pending", &key), "threadId":caller.thread_id,
        "runId":run.get("id"), "nodeId":run.get("rootNodeId"), "turnItemId":item_id,
        "label":str_arg(args, "label"), "reason":str_arg(args, "reason"), "secretStatus":"pending"});
    if let Some(fields) = command.as_object_mut() {
        for field in ["url", "placeholder"] {
            if let Some(value) = args.get(field) {
                fields.insert(field.into(), value.clone());
            }
        }
        if str_arg(args, "delivery") == Some("file") {
            fields.insert("delivery".into(), json!("file"));
        }
    }
    let mut cancelled = command.clone();
    if let Some(fields) = cancelled.as_object_mut() {
        fields.insert(
            "commandId".into(),
            json!(cx.stable_id("command", "secret-cancelled", &key)),
        );
        fields.insert("secretStatus".into(), json!("cancelled"));
    }
    let mut card = Card {
        engine: cx.config().engine.clone(),
        cancel: Some(cancelled),
        permit: Some(permit),
    };
    cx.engine()
        .record_secret_request(command)
        .await
        .map_err(|e| {
            fail(
                "orchestration_error",
                format!("Could not record the secret request: {e}"),
            )
        })?;
    let input = from_json(json!({"threadId":caller.thread_id})).map_err(super::internal)?;
    let mut stream = cx
        .engine()
        .subscribe_thread(input)
        .await
        .map_err(|_| fail("orchestration_error", "Unable to read the secret request."))?;
    let deadline = tokio::time::Instant::now()
        + Duration::from_millis(u64_arg(args, "timeoutMs").unwrap_or(600_000).min(3_600_000));
    let status = loop {
        let projection = cx.projection(&caller.thread_id).await?;
        if let Some(state) = card_status(&projection, &item_id).filter(|s| *s != "pending") {
            break state.to_owned();
        }
        let running = run
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| conn_features::secrets::run(&projection, id));
        if running.is_none_or(|r| terminal(r.get("status").and_then(Value::as_str))) {
            card.close().await.map_err(super::internal)?;
            break "cancelled".into();
        }
        match tokio::time::timeout_at(deadline, stream.recv()).await {
            Err(_) => {
                card.close().await.map_err(super::internal)?;
                let projection = cx.projection(&caller.thread_id).await?;
                break card_status(&projection, &item_id)
                    .filter(|s| matches!(*s, "saved" | "declined"))
                    .unwrap_or("timed_out")
                    .to_owned();
            }
            Ok(Some(Ok(_))) => {}
            Ok(_) => {
                return Err(fail(
                    "orchestration_error",
                    "Unable to read the secret request.",
                ));
            }
        }
    };
    card.cancel = None;
    if status != "saved" {
        return Ok(json!({"status":status,"note":unsaved_note(&status)}));
    }
    deliver(
        secrets,
        &caller.thread_id,
        &item_id,
        str_arg(args, "delivery"),
    )
    .await
}

fn card_status<'a>(projection: &'a Value, id: &str) -> Option<&'a str> {
    turn_item(projection, id)?.get("secretStatus")?.as_str()
}
async fn deliver(
    secrets: &SecretRequests,
    thread: &str,
    item: &str,
    delivery: Option<&str>,
) -> ToolResult {
    if delivery == Some("file") {
        return Ok(
            json!({"status":"saved", "file":secrets.save_to_file(thread, item).await.map_err(error)?}),
        );
    }
    let reference = secrets.saved_ref(thread, item).await.map_err(error)?.ok_or_else(|| fail("orchestration_error", "The user saved the secret, but it could not be read. Ask again with a new clientRequestId."))?;
    Ok(json!({"status":"saved", "secretRef":reference}))
}

fn decode(input: &Args) -> Result<Args, super::ToolError> {
    let mut args = input.clone();
    super::trim_non_blank(&mut args, &["label", "reason", "url", "placeholder"])?;
    if str_arg(&args, "value") == Some("") {
        return Err(super::ToolError::InvalidParams(
            "Expected a non-empty string\n  at [\"value\"]".into(),
        ));
    }
    if let Some(url) = str_arg(&args, "url") {
        let valid = url::Url::parse(url)
            .ok()
            .is_some_and(|u| matches!(u.scheme(), "http" | "https") && u.has_host());
        if !valid {
            return Err(super::ToolError::InvalidParams(
                "Expected an http(s) URL\n  at [\"url\"]".into(),
            ));
        }
    }
    Ok(args)
}
