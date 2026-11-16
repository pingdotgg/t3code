use std::io::{self, Read};

use conn_engine::tool_output::{
    compact_dynamic_tool_output, html_render_from_tool_item, mcp_app_from_tool_item,
    resolve_t3_mcp_tool_id,
};
use serde_json::{Value, json};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(8 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let cases: Vec<Value> = serde_json::from_str(&input)?;
    let results: Vec<_> = cases
        .iter()
        .map(|item| {
            json!({
                "id": item.get("toolName").and_then(Value::as_str).and_then(resolve_t3_mcp_tool_id),
                "compact": compact_dynamic_tool_output(item.get("output").unwrap_or(&Value::Null)),
                "html": html_render_from_tool_item(item),
                "app": mcp_app_from_tool_item(item),
            })
        })
        .collect();
    println!("{}", serde_json::to_string(&results)?);
    Ok(())
}
