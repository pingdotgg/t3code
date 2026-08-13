//! Desktop-control MCP server for Windows and Linux.
//!
//! The macOS half of this feature is a Swift package (`native/t3-desktop-mcp`)
//! built on the Accessibility API. This crate covers the other two platforms
//! and speaks the identical MCP dialect — same tool names, same argument shapes,
//! same tool text — so a model needs no per-platform knowledge.
//!
//! Transport is newline-delimited JSON-RPC over stdio, which is what the MCP
//! stdio transport expects. stdout carries protocol only; anything diagnostic
//! goes to stderr so it cannot corrupt a response.

mod apps;
mod browser;
mod capture;
mod platform;
mod tools;

use std::io::{self, BufRead, Write};

use base64::Engine as _;
use serde_json::{Value, json};

use platform::{Desktop, DesktopError, Point, ScrollDirection};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "t3-desktop";
const SERVER_VERSION: &str = "0.1.0";

fn main() {
    // Chrome spawns this same binary as its native messaging host; in that mode
    // the process is a relay, not a server.
    if std::env::args().nth(1).as_deref() == Some("native-host") {
        if let Err(error) = browser::run_native_host() {
            eprintln!("t3-desktop-mcp: native host stopped: {error}");
        }
        return;
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    // A backend failure must not kill the process: `initialize` and `tools/list`
    // still have to answer so the client can surface a useful error, and the
    // reason is far more actionable than a closed pipe.
    let mut desktop = match platform::backend() {
        Ok(backend) => Some(backend),
        Err(error) => {
            eprintln!("t3-desktop-mcp: desktop backend unavailable: {error}");
            None
        }
    };
    let mut browser = browser::BrowserBridge::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("t3-desktop-mcp: stdin closed: {error}");
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("t3-desktop-mcp: ignoring malformed JSON: {error}");
                continue;
            }
        };

        // Notifications carry no id and must never be answered.
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = request.get("params").cloned().unwrap_or(json!({}));

        let outcome = dispatch(&method, &params, desktop.as_deref_mut(), &mut browser);
        let response = match outcome {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(error) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": error.0, "message": error.1 }
            }),
        };

        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

/// A JSON-RPC level failure: the request itself was unusable.
struct RpcError(i64, String);

fn method_not_found(method: &str) -> RpcError {
    RpcError(-32601, format!("unknown method '{method}'"))
}

fn dispatch(
    method: &str,
    params: &Value,
    desktop: Option<&mut (dyn Desktop + '_)>,
    browser: &mut browser::BrowserBridge,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
        })),
        "tools/list" => Ok(json!({ "tools": tools::tool_defs() })),
        "tools/call" => Ok(call_tool(params, desktop, browser)),
        // Ping is part of the base protocol and some clients probe with it.
        "ping" => Ok(json!({})),
        other => Err(method_not_found(other)),
    }
}

/// Tool failures are reported inside the result as `isError`, not as JSON-RPC
/// errors, so the model reads them as feedback and can retry differently.
fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({
        "isError": is_error,
        "content": [{ "type": "text", "text": text.into() }]
    })
}

fn image_result(png: Vec<u8>, caption: String) -> Value {
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    json!({
        "isError": false,
        "content": [
            { "type": "text", "text": caption },
            { "type": "image", "data": encoded, "mimeType": "image/png" }
        ]
    })
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn arg_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn arg_f64(args: &Value, key: &str) -> Option<f64> {
    args.get(key).and_then(Value::as_f64)
}

/// Parse an `e12`-style element id into its numeric handle.
fn element_id(raw: &str) -> Result<u32, DesktopError> {
    raw.trim()
        .trim_start_matches(['e', 'E'])
        .parse::<u32>()
        .map_err(|_| {
            DesktopError::new(format!(
                "'{raw}' is not an element id — pass one from get_app_state, like e12"
            ))
        })
}

/// Resolve the element-or-coordinates pair the pointer tools accept.
fn point_from(args: &Value, element_key: &str, x_key: &str, y_key: &str) -> Result<Point, DesktopError> {
    if let Some(raw) = arg_str(args, element_key) {
        return Ok(Point::Element(element_id(raw)?));
    }
    match (arg_f64(args, x_key), arg_f64(args, y_key)) {
        (Some(x), Some(y)) => Ok(Point::Screen(x, y)),
        _ => Err(DesktopError::new(format!(
            "provide {element_key} from get_app_state, or both {x_key} and {y_key}"
        ))),
    }
}

fn call_tool(
    params: &Value,
    desktop: Option<&mut (dyn Desktop + '_)>,
    browser: &mut browser::BrowserBridge,
) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    if let Some(rest) = name.strip_prefix("browser_") {
        return match browser.call(rest, &args) {
            Ok(text) => text_result(text, false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }

    // Display listing needs no accessibility backend, so answer it even when the
    // backend failed to start — it helps diagnose a headless session.
    if name == "list_displays" {
        return match capture::list_displays() {
            Ok(text) => text_result(text, false),
            Err(error) => text_result(format!("error: {error}"), true),
        };
    }

    let Some(desktop) = desktop else {
        return text_result(
            "error: the desktop backend is unavailable on this host — see stderr for the reason",
            true,
        );
    };

    match run_desktop_tool(&name, &args, desktop) {
        Ok(value) => value,
        Err(error) => text_result(format!("error: {error}"), true),
    }
}

fn run_desktop_tool(
    name: &str,
    args: &Value,
    desktop: &mut dyn Desktop,
) -> Result<Value, DesktopError> {
    let text = match name {
        "list_apps" => desktop.list_apps()?,
        "get_app_state" => {
            let app = arg_str(args, "app")
                .ok_or_else(|| DesktopError::new("missing required argument 'app'"))?;
            let max_depth = arg_i64(args, "max_depth").unwrap_or(18).clamp(1, 60) as usize;
            let max_elements = arg_i64(args, "max_elements").unwrap_or(800).clamp(1, 5000) as usize;
            desktop.get_app_state(app, max_depth, max_elements)?
        }
        "activate_app" => {
            let app = arg_str(args, "app")
                .ok_or_else(|| DesktopError::new("missing required argument 'app'"))?;
            desktop.activate_app(app)?
        }
        "click" => {
            let count = arg_i64(args, "click_count").unwrap_or(1).clamp(1, 3) as u32;
            desktop.click(point_from(args, "element_id", "x", "y")?, count)?
        }
        "right_click" => desktop.right_click(point_from(args, "element_id", "x", "y")?)?,
        "drag" => {
            let from = point_from(args, "from_element_id", "from_x", "from_y")?;
            let to = point_from(args, "to_element_id", "to_x", "to_y")?;
            desktop.drag(from, to)?
        }
        "type_text" => {
            let text = arg_str(args, "text")
                .ok_or_else(|| DesktopError::new("missing required argument 'text'"))?;
            let element = arg_str(args, "element_id").map(element_id).transpose()?;
            desktop.type_text(text, element)?
        }
        "press_key" => {
            let key = arg_str(args, "key")
                .ok_or_else(|| DesktopError::new("missing required argument 'key'"))?;
            let modifiers: Vec<String> = args
                .get("modifiers")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            desktop.press_key(key, &modifiers)?
        }
        "scroll" => {
            let direction = ScrollDirection::parse(arg_str(args, "direction").unwrap_or("down"))?;
            let amount = arg_i64(args, "amount").unwrap_or(5).clamp(1, 100) as i32;
            let element = arg_str(args, "element_id").map(element_id).transpose()?;
            desktop.scroll(direction, amount, element)?
        }
        "set_value" => {
            let element = element_id(
                arg_str(args, "element_id")
                    .ok_or_else(|| DesktopError::new("missing required argument 'element_id'"))?,
            )?;
            let value = arg_str(args, "value")
                .ok_or_else(|| DesktopError::new("missing required argument 'value'"))?;
            desktop.set_value(element, value)?
        }
        "select_text" => {
            let element = element_id(
                arg_str(args, "element_id")
                    .ok_or_else(|| DesktopError::new("missing required argument 'element_id'"))?,
            )?;
            let start = arg_i64(args, "start").unwrap_or(0).max(0) as usize;
            let length = arg_i64(args, "length").filter(|value| *value >= 0).map(|v| v as usize);
            desktop.select_text(element, start, length)?
        }
        "screenshot" => {
            let max_width = arg_i64(args, "max_width")
                .unwrap_or(capture::DEFAULT_MAX_WIDTH as i64)
                .clamp(0, 8000) as u32;
            if let Some(display) = arg_i64(args, "display") {
                let index = usize::try_from(display).map_err(|_| {
                    DesktopError::new("display index must be zero or greater")
                })?;
                let png = capture::capture_display(index, max_width)?;
                return Ok(image_result(png, format!("display {index}")));
            }
            let app = arg_str(args, "app").ok_or_else(|| {
                DesktopError::new("provide 'app' to capture a window, or 'display' for a whole screen")
            })?;
            let pid = desktop.resolve_pid(app)?;
            let (png, title) = capture::capture_app_window(pid, max_width)?;
            return Ok(image_result(png, format!("{app} — \"{title}\"")));
        }
        other => {
            return Err(DesktopError::new(format!("unknown tool '{other}'")));
        }
    };
    Ok(text_result(text, false))
}

#[cfg(test)]
mod tests {
    use super::{element_id, point_from, text_result};
    use crate::platform::Point;
    use serde_json::json;

    #[test]
    fn element_ids_accept_the_advertised_form() {
        assert_eq!(element_id("e12").unwrap(), 12);
        assert_eq!(element_id("E7").unwrap(), 7);
        // Bare numbers are tolerated because models often drop the prefix.
        assert_eq!(element_id("3").unwrap(), 3);
        assert!(element_id("button").is_err());
    }

    #[test]
    fn a_bad_element_id_names_the_tool_that_produces_them() {
        let message = element_id("nope").unwrap_err().0;
        assert!(message.contains("get_app_state"), "unhelpful: {message}");
    }

    #[test]
    fn points_prefer_element_ids_over_coordinates() {
        let args = json!({ "element_id": "e5", "x": 10.0, "y": 20.0 });
        assert!(matches!(
            point_from(&args, "element_id", "x", "y").unwrap(),
            Point::Element(5)
        ));
    }

    #[test]
    fn points_fall_back_to_coordinates() {
        let args = json!({ "x": 10.5, "y": 20.5 });
        match point_from(&args, "element_id", "x", "y").unwrap() {
            Point::Screen(x, y) => assert_eq!((x, y), (10.5, 20.5)),
            other => panic!("expected screen coordinates, got {other:?}"),
        }
    }

    #[test]
    fn a_lone_coordinate_is_rejected_rather_than_guessed() {
        // Clicking at (x, 0) because y was forgotten would be worse than an error.
        let args = json!({ "x": 10.0 });
        assert!(point_from(&args, "element_id", "x", "y").is_err());
    }

    #[test]
    fn tool_errors_are_reported_in_band() {
        let result = text_result("error: nope", true);
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["type"], json!("text"));
    }
}
