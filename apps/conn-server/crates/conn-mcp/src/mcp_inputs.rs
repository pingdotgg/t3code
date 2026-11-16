//! The panel tools' Effect string transformations are absent from their advertised JSON schema.
use serde_json::{Map, Value};

const PANEL_NAME_UNITS: usize = 200;
const PANEL_TEXT_UNITS: usize = 8192;

pub fn decode(name: &str, input: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    if !matches!(name, "mcp_call" | "mcp_connect") {
        return Err("unknown MCP panel tool".into());
    }
    let (tool, order) = crate::catalog::tool(name).ok_or("unknown panel tool")?;
    let mut args = input.clone();
    crate::catalog::check_arguments(name, &tool["inputSchema"], &order, &mut args)?;
    for key in order {
        let Some(value) = args.get_mut(&key) else {
            continue;
        };
        if matches!(key.as_str(), "tool" | "server" | "name" | "url" | "command") {
            let text = value.as_str().ok_or("Expected string")?;
            let text = text
                .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
            let max = if matches!(key.as_str(), "url" | "command") {
                PANEL_TEXT_UNITS
            } else {
                PANEL_NAME_UNITS
            };
            let problem = if text.is_empty() {
                Some("Expected a non-blank string".to_owned())
            } else if text.encode_utf16().count() > max {
                Some(format!("Expected a value with a length of at most {max}"))
            } else {
                None
            };
            if let Some(problem) = problem {
                return Err(format!("{problem}\n  at [{}]", Value::String(key)));
            }
            *value = Value::String(text.to_owned());
        } else if matches!(key.as_str(), "headers" | "env") {
            for (entry, text) in value.as_object().ok_or("Expected object")? {
                let problem = match text.as_str() {
                    None => Some("Expected string"),
                    Some(text) if text.encode_utf16().count() > PANEL_TEXT_UNITS => {
                        Some("Expected a value with a length of at most 8192")
                    }
                    _ => None,
                };
                if let Some(problem) = problem {
                    return Err(format!(
                        "{problem}\n  at [{}][{}]",
                        Value::String(key.clone()),
                        Value::String(entry.clone())
                    ));
                }
            }
        }
    }
    Ok(args)
}
