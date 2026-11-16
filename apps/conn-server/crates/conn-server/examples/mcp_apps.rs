//! Offline differential runner for the MCP App helpers and stored documents.
use conn_provider::mcp_apps;
use serde_json::{Value, json};
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--state-dir") {
        return Err("pass --state-dir <temp folder>".into());
    }
    let dir = std::path::PathBuf::from(args.next().ok_or("missing state dir")?);
    std::fs::create_dir_all(&dir)?;
    let store = conn_files::AttachmentStore::new(dir);
    let mut text = String::new();
    io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_string(&mut text)?;
    let cases: Vec<Value> = serde_json::from_str(&text)?;
    let mut results = Vec::new();
    for case in cases {
        let result = match case.get("kind").and_then(Value::as_str) {
            Some("reference") => mcp_apps::app_reference(case.get("item").unwrap_or(&Value::Null))
                .unwrap_or(Value::Null),
            Some("tool") => mcp_apps::claude_tool(
                case.get("tool").unwrap_or(&Value::Null),
                case.get("rules").filter(|v| !v.is_null()),
            ),
            Some("call") => mcp_apps::call_result(case.get("value").unwrap_or(&Value::Null)),
            Some("bootstrap") => json!(conn_files::mcp_apps::bootstrap(
                case.get("html").and_then(Value::as_str).unwrap_or_default()
            )),
            Some("visibility") => {
                json!(mcp_apps::callable(case.get("meta").unwrap_or(&Value::Null)))
            }
            Some("snapshot") => {
                let uri = case
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or("ui://app");
                match store.snapshot_mcp_app(
                    "thread",
                    "server",
                    "tool",
                    uri,
                    case.get("contents").unwrap_or(&Value::Null),
                )? {
                    Some(mut reference) => {
                        let id = reference
                            .get("attachmentId")
                            .and_then(Value::as_str)
                            .ok_or("no attachment id")?;
                        let asset = store.resolve(id).ok_or("missing attachment")?;
                        let html = std::fs::read_to_string(asset.path)?;
                        reference
                            .as_object_mut()
                            .ok_or("invalid reference")?
                            .remove("attachmentId");
                        json!({"reference":reference,"html":html})
                    }
                    None => Value::Null,
                }
            }
            _ => return Err("unknown App case".into()),
        };
        results.push(result);
    }
    println!("{}", json!(results));
    Ok(())
}
