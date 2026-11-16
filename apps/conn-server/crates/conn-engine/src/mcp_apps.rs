//! Thread App requests stay on the session that produced the item, without starting a turn.
use crate::{EngineError, engine::Inner};
use conn_contract::{ProviderThread, from_json};
use conn_provider::{
    ProviderError,
    mcp_apps::{self, Operation, Request},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::sync::Arc;

type Result<T> = std::result::Result<T, EngineError<Value>>;

fn fail(thread: &str, reason: &str) -> EngineError<Value> {
    EngineError::Rejected(json!({"_tag":"McpAppRequestError", "threadId":thread, "reason":reason}))
}

fn with_cause(mut error: EngineError<Value>, name: &str, message: String) -> EngineError<Value> {
    if let EngineError::Rejected(value) = &mut error {
        value["cause"] = json!({"name":name,"message":message});
    }
    error
}

fn adapter_error(
    thread: &str,
    driver: &str,
    operation: &str,
    error: ProviderError,
) -> EngineError<Value> {
    if matches!(error, ProviderError::Unsupported { .. }) {
        return fail(thread, "provider-unsupported");
    }
    if matches!(error, ProviderError::SessionStopped) {
        return with_cause(
            fail(thread, "session-stopped"),
            "ProviderAdapterSessionStoppedError",
            format!("No running {driver} session owns this thread."),
        );
    }
    let detail = match error {
        ProviderError::Protocol { detail } => detail,
        _ => match (driver, operation) {
            ("codex", "list") => "Failed to list Codex MCP tools.",
            ("codex", "call") => "Codex MCP tool call failed.",
            ("codex", _) => "Codex MCP resource read failed.",
            (_, "list") => "Failed to list Claude MCP tools.",
            (_, "call") => "Claude MCP tool call failed.",
            _ => "Claude MCP resource read failed.",
        }
        .into(),
    };
    with_cause(
        fail(thread, "request-failed"),
        "ProviderAdapterProtocolError",
        format!("{driver} provider protocol error: {detail}."),
    )
}

impl Inner {
    pub(crate) async fn capture_app_event(
        &self,
        live: &crate::runner::LiveThread,
        event: conn_provider::ProviderEvent,
    ) -> conn_provider::ProviderEvent {
        use conn_provider::ProviderEvent;
        let (turn_item, source) = match event {
            ProviderEvent::McpAppCapture { turn_item, source } => (turn_item, Some(source)),
            ProviderEvent::TurnItemUpdated { turn_item } => (turn_item, None),
            other => return other,
        };
        if !matches!(&turn_item, conn_contract::TurnItem::DynamicTool(_)) {
            return ProviderEvent::TurnItemUpdated { turn_item };
        }
        let mut item = conn_contract::to_json(&turn_item);
        let original_output = item.get("output").cloned().unwrap_or(Value::Null);
        if item
            .get("toolName")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("mcp__"))
            && mcp_apps::output_app_reference(&original_output).is_some()
        {
            item["output"] = json!({"result":original_output});
        }
        let status = item.get("status").and_then(Value::as_str);
        let failed = status == Some("failed");
        if status != Some("completed") && !(failed && source.is_some()) {
            return ProviderEvent::TurnItemUpdated {
                turn_item: from_json(item).unwrap_or(turn_item),
            };
        }
        if let Some(host) = &self.host {
            let capture = async {
                let source = match source {
                    Some(source) => source,
                    None => live.session().mcp_app_source(item.clone()).await.ok()??,
                };
                let thread = item.get("threadId")?.as_str()?.to_owned();
                let tid = thread.clone();
                let ptid = item.get("providerThreadId")?.as_str()?.to_owned();
                let provider_thread = self
                    .db(move |s| {
                        let tx = s.tx()?;
                        let row = tx.entity(&tid, "providerThreads", &ptid)?;
                        tx.rollback();
                        Ok::<_, String>(row)
                    })
                    .await
                    .ok()??;
                let provider_thread = from_json(provider_thread).ok()?;
                let read = live
                    .session()
                    .read_mcp_app_document(Request {
                        provider_thread,
                        server: source.server.clone(),
                        operation: Operation::ReadResource {
                            uri: source.resource_uri.clone(),
                        },
                    })
                    .await
                    .ok()?;
                Some((thread, source, read.get("contents")?.clone()))
            };
            if let Ok(Some((thread, source, contents))) =
                tokio::time::timeout(std::time::Duration::from_secs(20), capture).await
                && let Ok(Some(reference)) = host.snapshot_mcp_app(thread, source, contents).await
            {
                let mut result = mcp_apps::call_result(&original_output);
                if failed {
                    result["isError"] = json!(true);
                }
                item["output"] = json!({"t3McpApp":reference,"result":result});
            }
        }
        ProviderEvent::TurnItemUpdated {
            turn_item: from_json(item).unwrap_or(turn_item),
        }
    }

    pub(crate) async fn mcp_app_request(
        self: &Arc<Self>,
        method: &str,
        input: Value,
    ) -> Result<Value> {
        let thread = input
            .get("threadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let item_id = input
            .get("itemId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let tid = thread.clone();
        let iid = item_id.clone();
        let item = self
            .db(move |s| s.turn_item(&tid, &iid))
            .await
            .map_err(|_: String| fail(&thread, "request-failed"))?
            .ok_or_else(|| fail(&thread, "not-an-app"))?;
        let app = mcp_apps::app_reference(&item).ok_or_else(|| fail(&thread, "not-an-app"))?;
        let provider_thread_id = item
            .get("providerThreadId")
            .and_then(Value::as_str)
            .ok_or_else(|| fail(&thread, "not-an-app"))?
            .to_owned();
        if method == "mcpApps.updateModelContext" {
            return self.update_app_context(&thread, item_id, app, input).await;
        }
        let tid = thread.clone();
        let row = self
            .db(move |s| {
                let tx = s.tx()?;
                let row = tx.entity(&tid, "providerThreads", &provider_thread_id)?;
                tx.rollback();
                Ok(row)
            })
            .await
            .map_err(|_: String| fail(&thread, "request-failed"))?
            .ok_or_else(|| fail(&thread, "session-stopped"))?;
        let provider_thread: ProviderThread =
            from_json(row).map_err(|_| fail(&thread, "request-failed"))?;
        let driver = &provider_thread.driver;
        let session_id = provider_thread
            .provider_session_id
            .as_ref()
            .ok_or_else(|| fail(&thread, "session-stopped"))?;
        let live = crate::lock(&self.live)
            .values()
            .find(|live| live.session().provider_session_id().as_str() == session_id)
            .cloned()
            .ok_or_else(|| fail(&thread, "session-stopped"))?;
        let server = app
            .get("server")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let request = |operation| Request {
            provider_thread: provider_thread.clone(),
            server: server.clone(),
            operation,
        };
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(method, "mcpApps.callTool" | "mcpApps.toolInfo") {
            let tools = live
                .session()
                .mcp_app_request(request(Operation::ListTools))
                .await
                .map_err(|e| adapter_error(&thread, driver.as_str(), "list", e))?;
            let tool = tools
                .as_array()
                .into_iter()
                .flatten()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name));
            let callable = tool
                .is_some_and(|tool| mcp_apps::callable(tool.get("_meta").unwrap_or(&Value::Null)));
            if method == "mcpApps.toolInfo" {
                let mut result = json!({"callable":callable,"readOnly":tool.and_then(|t| t.pointer("/annotations/readOnlyHint")) == Some(&Value::Bool(true))});
                if let Some(tool) = tool {
                    result["tool"] = tool.clone();
                    if let Some(title) =
                        tool.pointer("/annotations/title").filter(|v| v.is_string())
                    {
                        result["title"] = title.clone();
                    }
                }
                return Ok(result);
            }
            if !callable {
                return Err(fail(&thread, "tool-not-callable"));
            }
        }
        let operation = if method == "mcpApps.callTool" {
            Operation::CallTool {
                tool: name.to_owned(),
                arguments: input.get("arguments").cloned().unwrap_or_else(|| json!({})),
            }
        } else {
            Operation::ReadResource {
                uri: input
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            }
        };
        live.session()
            .mcp_app_request(request(operation))
            .await
            .map_err(|e| {
                adapter_error(
                    &thread,
                    driver.as_str(),
                    if method == "mcpApps.callTool" {
                        "call"
                    } else {
                        "read"
                    },
                    e,
                )
            })
    }

    async fn update_app_context(
        &self,
        source: &str,
        item_id: String,
        app: Value,
        input: Value,
    ) -> Result<Value> {
        let conversation = input
            .get("conversationThreadId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let tid = conversation.clone();
        let ancestor = source.to_owned();
        let descendant = self
            .db(move |s| {
                let tx = s.tx()?;
                let mut current = Some(tid);
                let mut seen = std::collections::HashSet::new();
                while let Some(id) = current {
                    if id == ancestor {
                        tx.rollback();
                        return Ok(true);
                    }
                    if seen.len() >= 16_384 || !seen.insert(id.clone()) {
                        break;
                    }
                    let row = tx.thread(&id)?.ok_or("Thread not found")?;
                    current = if row
                        .pointer("/lineage/relationshipToParent")
                        .and_then(Value::as_str)
                        == Some("fork")
                    {
                        row.pointer("/lineage/parentThreadId")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    } else {
                        None
                    };
                }
                tx.rollback();
                Ok(false)
            })
            .await
            .map_err(|_: String| fail(source, "request-failed"))?;
        if !descendant {
            return Err(fail(source, "not-an-app"));
        }
        let mut texts = Vec::new();
        for block in input
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                return Err(fail(source, "unsupported-content"));
            }
            texts.push(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| fail(source, "unsupported-content"))?
                    .to_owned(),
            );
        }
        if let Some(structured) = input.get("structuredContent") {
            texts.push(structured.to_string());
        }
        let text = texts.join("\n");
        if text.len() > 16 * 1024 {
            return Err(with_cause(
                fail(source, "request-failed"),
                "Error",
                "Model context is too large.".into(),
            ));
        }
        let updated = conn_support::time::iso_from_ms(self.clock.now_millis());
        self.db(move |s| {
            let tx = s.tx()?;
            let count: i64 = tx.conn().query_row("SELECT COUNT(*) FROM mcp_app_model_context WHERE thread_id=?1 AND item_id<>?2",params![conversation,item_id],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !text.trim().is_empty() && count >= 256 {return Err("Too many App context entries.".into());}
            let result = if text.trim().is_empty() {
                tx.conn().execute("DELETE FROM mcp_app_model_context WHERE thread_id=?1 AND item_id=?2", params![conversation,item_id])
            } else {
                tx.conn().execute("INSERT INTO mcp_app_model_context(thread_id,item_id,server,tool,text,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(thread_id,item_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at",
                    params![conversation,item_id,app.get("server").and_then(Value::as_str),app.get("tool").and_then(Value::as_str),text,updated])
            };
            result.map_err(|e|e.to_string())?;
            tx.commit(None)?;
            Ok(())
        }).await.map_err(|_: String| fail(source,"request-failed"))?;
        Ok(Value::Null)
    }

    pub(crate) async fn app_context(
        &self,
        thread: String,
    ) -> std::result::Result<Vec<conn_provider::AppContextEntry>, String> {
        self.db(move |s| {
            let tx = s.tx()?;
            let result = {
                let mut query = tx.conn().prepare("SELECT c.item_id,c.text FROM mcp_app_model_context c WHERE c.thread_id=?1 AND EXISTS (SELECT 1 FROM entities i LEFT JOIN entities r ON r.thread_id=i.thread_id AND r.kind='runs' AND r.id=json_extract(i.body,'$.runId') WHERE i.kind='turnItems' AND i.id=c.item_id AND (json_extract(r.body,'$.status') IS NOT 'rolled_back' OR r.thread_id<>c.thread_id)) ORDER BY c.updated_at,c.item_id LIMIT 256").map_err(|e|e.to_string())?;
                query.query_map([thread], |row| {
                    let item: String = row.get(0)?;
                    let key: String = item.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c,'_'|'.'|'-') {c} else {'_'}).collect();
                    Ok(conn_provider::AppContextEntry {key:format!("mcp_app_{key}"), text:row.get(1)?})
                }).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?
            };
            tx.rollback();
            Ok(result)
        }).await
    }
}
