//! Presentation data which the plain transcript does not carry.
use conn_contract::{OrchestrationV2TurnItemDynamicTool, OrchestrationV2TurnItemUserMessage};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum FeedDetail {
    Message {
        sender: Option<String>,
        thread: Option<String>,
        environment: Option<String>,
        reviews: Vec<ReviewExcerpt>,
    },
    Html {
        attachment: String,
        title: String,
        height: u32,
    },
    Mcp {
        thread: String,
        attachment: String,
        title: String,
    },
    Task(Value),
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewExcerpt {
    pub context_id: String,
    pub file_path: String,
    pub range_label: String,
    pub text: String,
    pub diff: String,
}

pub(crate) fn message_detail(item: &OrchestrationV2TurnItemUserMessage) -> Option<FeedDetail> {
    let reviews: Vec<_> = item
        .context
        .iter()
        .flat_map(|c| &c.records)
        .filter(|r| r["kind"] == "review-comment")
        .filter_map(|r| serde_json::from_value(r.clone()).ok())
        .collect();
    let linked = item.linked_sender.as_ref();
    (linked.is_some() || item.sender_thread_id.is_some() || !reviews.is_empty()).then(|| {
        FeedDetail::Message {
            sender: linked.map(|s| s.title.clone()),
            thread: linked
                .map(|s| s.thread_id.clone())
                .or_else(|| item.sender_thread_id.clone()),
            environment: linked.map(|s| s.environment_id.clone()),
            reviews,
        }
    })
}

pub(crate) fn tool_detail(item: &OrchestrationV2TurnItemDynamicTool) -> Option<FeedDetail> {
    let name = item.tool_name.as_deref()?;
    let output = item.output.as_ref()?.as_ref()?;
    read_receipt(&item.thread_id, name, output, 0)
}

fn read_receipt(thread: &str, name: &str, output: &Value, depth: u8) -> Option<FeedDetail> {
    if depth > 5
        || output["_tag"] == "OrchestratorMcpFailure"
        || output["isError"] == true
        || output["is_error"] == true
        || !output["error"].is_null()
    {
        return None;
    }
    if let Some(text) = output.as_str() {
        if text.len() > 65536 {
            return None;
        }
        return read_receipt(thread, name, &serde_json::from_str(text).ok()?, depth + 1);
    }
    if let Some(nested) = output
        .get("structuredContent")
        .or_else(|| output.get("content"))
    {
        return read_receipt(thread, name, nested, depth + 1);
    }
    if let Some(blocks) = output.as_array() {
        return blocks
            .iter()
            .take(16)
            .find_map(|b| read_receipt(thread, name, b.get("text")?, depth + 1));
    }
    if let Some(app) = output.get("t3McpApp") {
        let server = app["server"].as_str()?;
        let tool = app["tool"].as_str()?;
        if (name == format!("{server}.{tool}") || name == format!("mcp__{server}__{tool}"))
            && app["resourceUri"].as_str()?.starts_with("ui://")
        {
            return Some(FeedDetail::Mcp {
                thread: thread.to_owned(),
                attachment: asset_id(app)?,
                title: format!("{server} · {tool}"),
            });
        }
    }
    if matches!(
        name,
        "html_render"
            | "conn.html_render"
            | "t3-code.html_render"
            | "mcp__conn__html_render"
            | "mcp__t3-code__html_render"
            | "execute"
    ) {
        let html = output.get("htmlRender")?;
        return Some(FeedDetail::Html {
            attachment: asset_id(html)?,
            title: html["title"].as_str()?.to_owned(),
            height: html["height"].as_u64()?.clamp(80, 2000) as u32,
        });
    }
    let name = name
        .to_ascii_lowercase()
        .replace("mcp__", "")
        .replace("__", ".")
        .replace(['/', ':', ' '], ".")
        .replace('_', "-");
    if name == "orbit.task-create" {
        let row = output.get("orbitTask").or_else(|| output.get("data"))?;
        row.get("id")?.as_i64()?;
        row.get("title")?.as_str()?;
        let mut card = serde_json::Map::new();
        for key in [
            "id",
            "title",
            "status",
            "attention",
            "project",
            "workspace",
            "pull_request",
            "subtask_counts",
            "created_at",
            "updated_at",
            "last_activity_at",
        ] {
            if let Some(v) = row.get(key) {
                card.insert(key.to_owned(), v.clone());
            }
        }
        return Some(FeedDetail::Task(Value::Object(card)));
    }
    None
}

fn asset_id(value: &Value) -> Option<String> {
    value["attachmentId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn embedded_cards_require_matching_tool_and_asset() {
        let app = json!({"t3McpApp":{"attachmentId":"stored","server":"orbit","tool":"queue","resourceUri":"ui://queue"}});
        assert!(matches!(
            read_receipt("source-thread", "orbit.queue", &app, 0),
            Some(FeedDetail::Mcp { thread, .. }) if thread == "source-thread"
        ));
        assert!(read_receipt("source-thread", "other.queue", &app, 0).is_none());
        assert!(
            read_receipt(
                "source-thread",
                "orbit.queue",
                &json!({"isError":true,"structuredContent":app}),
                0
            )
            .is_none()
        );
        let html = json!({"htmlRender":{"attachmentId":"stored","title":"Summary","height":5000}});
        assert!(matches!(
            read_receipt(
                "source-thread",
                "mcp__conn__html_render",
                &json!({"content":[{"text":html.to_string()}]}),
                0
            ),
            Some(FeedDetail::Html { height: 2000, .. })
        ));
        assert!(read_receipt("source-thread", "random", &html, 0).is_none());
    }
}
