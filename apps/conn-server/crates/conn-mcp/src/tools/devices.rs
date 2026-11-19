//! `device_list`, `device_open`, `device_screenshot` and `device_close` (`toolkits/device`):
//! simulators an agent drives through the `agent-device` command `device_open` returns. The
//! logic is `conn_devices::tool_api`; this file checks the caller and renders the answers.

use super::{Args, Cx, ToolError, ToolResult};
use conn_devices::{DeviceError, tool_api};
use serde_json::Value;

fn message(error: DeviceError) -> ToolError {
    ToolError::Message(error.message())
}

pub(super) async fn call(cx: &Cx<'_>, name: &str, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?.clone();
    if matches!(name, "device_open" | "device_close") {
        cx.writing_caller().await?;
    }
    let devices = match (&cx.config().devices, caller.device) {
        (Some(devices), true) => devices.clone(),
        _ => return Err(denied(name)),
    };
    let args = Value::Object(args.clone());
    match name {
        "device_list" => tool_api::device_list(&devices, &caller.thread_id, &args)
            .await
            .map_err(message),
        "device_open" => tool_api::device_open(&devices, &caller.thread_id, &args)
            .await
            .map_err(message),
        "device_close" => tool_api::device_close(&devices, &caller.thread_id, &args)
            .await
            .map_err(message),
        _ => match tool_api::device_screenshot(&devices, &caller.thread_id, &args).await {
            Ok((mut metadata, data)) => {
                metadata["screenshot"]["data"] = Value::String(data);
                Ok(metadata)
            }
            Err(error) => Err(ToolError::Image {
                tag: error.tag(),
                operation: "screenshot",
                message: tool_api::screenshot_failure_text(&error),
            }),
        },
    }
}

fn denied(name: &str) -> ToolError {
    let error = DeviceError::tool(tool_api::ACCESS_OFF);
    if name == "device_screenshot" {
        return ToolError::Image {
            tag: error.tag(),
            operation: "screenshot",
            message: error.message(),
        };
    }
    message(error)
}
