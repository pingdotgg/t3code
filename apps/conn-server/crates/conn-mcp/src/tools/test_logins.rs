//! Test-login metadata for the calling agent; secrets only enter the shared secret store.

use super::{Args, Cx, ToolError, ToolResult, internal, str_arg};
use conn_contract::{SaveTestLoginInput, TestLoginSummaryCreatedBy, from_json, to_json};
use conn_features::test_logins::TestLogins;
use serde_json::{Value, json};

fn store<'a>(cx: &'a Cx<'_>) -> Result<&'a TestLogins, ToolError> {
    cx.config()
        .test_logins
        .as_ref()
        .ok_or_else(|| super::fail("capability_denied", "Test logins are not supported."))
}
pub(super) async fn save(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_thread("This tool")?;
    cx.writing_caller().await?;
    let input: SaveTestLoginInput = from_json(Value::Object(args.clone())).map_err(internal)?;
    store(cx)?
        .save(input, TestLoginSummaryCreatedBy::Agent)
        .await
        .map(|s| to_json(&s))
        .map_err(|e| ToolError::Message(e.to_string()))
}
pub(super) async fn request(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_thread("This tool")?;
    let Some(host) = host(str_arg(args, "domain").unwrap_or_default()) else {
        return Ok(json!({"items":[]}));
    };
    let list = store(cx)?
        .list()
        .await
        .map_err(|e| ToolError::Message(e.to_string()))?;
    let items: Vec<_> = list.items.into_iter()
        .filter(|login| self::host(&login.url).as_deref() == Some(&host))
        .map(|login| {
            let title = if login.label.is_empty() { &login.username } else { &login.label };
            json!({"id":login.id,"title":title,"urls":[login.url],"username":login.username,"source":"test"})
        }).collect();
    Ok(json!({"items":items}))
}
fn host(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(&if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    })
    .ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(host.strip_prefix("www.").unwrap_or(&host).to_owned())
}
