//! One stored MCP app. Its server and turn item are bound before WebKit receives a host.
use crate::{ConnCore, FfiError};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(uniffi::Object)]
pub struct ThreadMcpApp {
    core: Arc<ConnCore>,
    thread: String,
    item: String,
    payload: String,
}

impl std::fmt::Debug for ThreadMcpApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThreadMcpApp")
            .field("item", &self.item)
            .finish_non_exhaustive()
    }
}

fn invalid(message: &str) -> FfiError {
    FfiError::InvalidInput {
        message: message.into(),
    }
}

#[uniffi::export]
impl ConnCore {
    pub async fn thread_mcp_app(
        self: Arc<Self>,
        thread: String,
        item: String,
        attachment: String,
    ) -> Result<Arc<ThreadMcpApp>, FfiError> {
        let result = self
            .call_json(
                "orchestration.getTurnItem",
                json!({"threadId":thread,"itemId":item}),
            )
            .await?;
        let call = &result["item"];
        let app = &call["output"]["t3McpApp"];
        if call["type"] != "dynamic_tool"
            || call["id"] != item
            || call["threadId"] != thread
            || app["attachmentId"] != attachment
        {
            return Err(invalid("The source app has changed"));
        }
        let payload =
            json!({"arguments":call["input"], "result":call["output"]["result"]}).to_string();
        Ok(Arc::new(ThreadMcpApp {
            core: self,
            thread,
            item,
            payload,
        }))
    }
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct FfiMcpToolInfo {
    pub read_only: bool,
    pub title: String,
}

#[uniffi::export]
impl ThreadMcpApp {
    pub fn tool_payload(&self) -> String {
        self.payload.clone()
    }

    pub async fn tool_info(&self, name: String) -> Result<FfiMcpToolInfo, FfiError> {
        let info = self
            .core
            .call_json(
                "mcpApps.toolInfo",
                json!({"threadId":self.thread,"itemId":self.item,"name":name}),
            )
            .await?;
        if info["callable"] != true {
            return Err(invalid("This app cannot call that tool"));
        }
        Ok(FfiMcpToolInfo {
            read_only: info["readOnly"] == true,
            title: info["title"].as_str().unwrap_or(&name).to_owned(),
        })
    }

    pub async fn call_tool(
        &self,
        name: String,
        arguments: String,
        confirmed: bool,
    ) -> Result<String, FfiError> {
        if !self.tool_info(name.clone()).await?.read_only && !confirmed {
            return Err(invalid("This tool needs confirmation"));
        }
        let args: serde_json::Map<String, Value> =
            serde_json::from_str(&arguments).map_err(|_| invalid("Invalid tool arguments"))?;
        self.core
            .call_json(
                "mcpApps.callTool",
                json!({"threadId":self.thread,"itemId":self.item,"name":name,"arguments":args}),
            )
            .await
            .map(|result| result.to_string())
    }

    pub async fn read_resource(&self, uri: String) -> Result<String, FfiError> {
        self.core
            .call_json(
                "mcpApps.readResource",
                json!({"threadId":self.thread,"itemId":self.item,"uri":uri}),
            )
            .await
            .map(|result| result.to_string())
    }
}
