//! Tool schemas, kept byte-compatible with the macOS Swift server's `toolDefs`.
//!
//! A model that learned the tools on one platform must not have to relearn them
//! on another, so the names, argument shapes and descriptions are deliberately
//! identical. Behavioural differences belong in the tool text, not the schema.

use serde_json::{Value, json};

pub fn tool_defs() -> Value {
    json!([
        {
            "name": "list_apps",
            "description": "List running applications with their bundle id, pid, window count, and which is frontmost. Note that one app can have several running instances and only some may own windows.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "get_app_state",
            "description": "Read an app's accessibility tree as an indented outline. Interactive elements are prefixed with an id like [e12] that you pass to click/type_text/scroll. Call this before interacting, and again after the UI changes, since ids are per-snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": { "type": "string", "description": "App name, bundle id, or pid" },
                    "max_depth": { "type": "integer", "description": "Max tree depth (default 18)" },
                    "max_elements": { "type": "integer", "description": "Max elements to emit (default 800)" }
                },
                "required": ["app"]
            }
        },
        {
            "name": "click",
            "description": "Click an element by element_id (preferred, uses the accessibility press action) or at absolute screen coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "string", "description": "Element id from get_app_state, e.g. e12" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "click_count": { "type": "integer", "description": "1 for single, 2 for double-click" }
                }
            }
        },
        {
            "name": "type_text",
            "description": "Type literal text into the focused element, optionally focusing element_id first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "element_id": { "type": "string", "description": "Focus this element before typing" }
                },
                "required": ["text"]
            }
        },
        {
            "name": "press_key",
            "description": "Press a named key with optional modifiers, e.g. key='s' modifiers=['ctrl'] to save, or key='return'.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string" },
                    "modifiers": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Any of cmd, shift, alt, ctrl, fn. cmd maps to the Windows/Super key off macOS."
                    }
                },
                "required": ["key"]
            }
        },
        {
            "name": "scroll",
            "description": "Scroll up, down, left, or right, optionally positioning the cursor over element_id first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                    "amount": { "type": "integer", "description": "Scroll lines (default 5)" },
                    "element_id": { "type": "string" }
                }
            }
        },
        {
            "name": "activate_app",
            "description": "Bring an app to the foreground.",
            "inputSchema": {
                "type": "object",
                "properties": { "app": { "type": "string" } },
                "required": ["app"]
            }
        },
        {
            "name": "screenshot",
            "description": "Capture the app's largest window as a PNG image. Prefer get_app_state for interaction, which is cheaper and gives clickable element ids; use a screenshot when you need to see rendered content the accessibility tree does not describe, such as canvas or video.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": { "type": "string", "description": "App name, bundle id, or pid" },
                    "display": { "type": "integer", "description": "Capture a whole display by index (see list_displays) instead of an app window" },
                    "max_width": { "type": "integer", "description": "Downscale to this width in pixels (default 1400)" }
                }
            }
        },
        {
            "name": "list_displays",
            "description": "List every attached display with its index, resolution and position, for use with screenshot(display: N).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "right_click",
            "description": "Right-click (secondary click) an element or screen position to open a context menu.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" }
                }
            }
        },
        {
            "name": "drag",
            "description": "Press at one point, drag, and release at another. Accepts element ids or coordinates on each end.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from_element_id": { "type": "string" },
                    "to_element_id": { "type": "string" },
                    "from_x": { "type": "number" },
                    "from_y": { "type": "number" },
                    "to_x": { "type": "number" },
                    "to_y": { "type": "number" }
                }
            }
        },
        {
            "name": "set_value",
            "description": "Replace a text field's contents directly. More reliable than select-all-then-type for long values, though some fields reject it and need click + type_text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "string" },
                    "value": { "type": "string" }
                },
                "required": ["element_id", "value"]
            }
        },
        {
            "name": "select_text",
            "description": "Select a character range inside a text element. Defaults to selecting from 'start' to the end of the value.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "element_id": { "type": "string" },
                    "start": { "type": "integer", "description": "Start offset (default 0)" },
                    "length": { "type": "integer", "description": "Characters to select (default: to end)" }
                },
                "required": ["element_id"]
            }
        },
        {
            "name": "browser_open_tab",
            "description": "Open a URL in a new background tab inside the agent's own labelled tab group, in the user's signed-in Chrome. The user keeps browsing their tabs undisturbed. Returns a tab_id for browser_snapshot / browser_click.",
            "inputSchema": {
                "type": "object",
                "properties": { "url": { "type": "string", "description": "URL to open (default about:blank)" } }
            }
        },
        {
            "name": "browser_list_tabs",
            "description": "List the tabs in the agent's own Chrome window, marking the active one.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "browser_select_tab",
            "description": "Make one of the agent's tabs the visible one. Does not affect the user's tabs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "description": "From browser_list_tabs" },
                    "index": { "type": "integer", "description": "1-based index, fallback mode only" }
                }
            }
        },
        {
            "name": "browser_close_tab",
            "description": "Close one of the agent's tabs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer", "description": "From browser_list_tabs" },
                    "index": { "type": "integer", "description": "1-based index, fallback mode only" }
                }
            }
        },
        {
            "name": "browser_snapshot",
            "description": "List the interactive elements on a page in one of the agent's tabs, with indices to pass to browser_click. Works on a background tab, so the user can be looking at something else.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": { "type": "integer", "description": "From browser_open_tab or browser_list_tabs" } },
                "required": ["tab_id"]
            }
        },
        {
            "name": "browser_click",
            "description": "Click in one of the agent's tabs, by element index from browser_snapshot or by page coordinates. Works on a background tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer" },
                    "index": { "type": "integer", "description": "Element index from browser_snapshot" },
                    "x": { "type": "number" },
                    "y": { "type": "number" }
                },
                "required": ["tab_id"]
            }
        },
        {
            "name": "browser_type",
            "description": "Type text into the focused field of one of the agent's tabs. Click the field first.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": { "type": "integer" }, "text": { "type": "string" } },
                "required": ["tab_id", "text"]
            }
        },
        {
            "name": "browser_press_key",
            "description": "Press Enter, Tab, Escape or Backspace in one of the agent's tabs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_id": { "type": "integer" },
                    "key": { "type": "string", "enum": ["Enter", "Tab", "Escape", "Backspace"] }
                },
                "required": ["tab_id", "key"]
            }
        },
        {
            "name": "browser_close_all_tabs",
            "description": "Close every tab the agent opened and remove its tab group. Call this when finished with the browser so no empty group is left in the user's tab strip.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "browser_navigate",
            "description": "Point one of the agent's tabs at a different URL.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": { "type": "integer" }, "url": { "type": "string" } },
                "required": ["tab_id", "url"]
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::tool_defs;

    /// The macOS server advertises exactly these 23 tools. Drifting apart would
    /// silently give a model different capabilities per platform.
    #[test]
    fn advertises_the_macos_tool_surface() {
        let defs = tool_defs();
        let names: Vec<&str> = defs
            .as_array()
            .expect("tool defs are an array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool has a name"))
            .collect();

        assert_eq!(names.len(), 23, "tool count drifted from the macOS server");
        for expected in [
            "list_apps",
            "get_app_state",
            "click",
            "type_text",
            "press_key",
            "scroll",
            "activate_app",
            "screenshot",
            "list_displays",
            "right_click",
            "drag",
            "set_value",
            "select_text",
            "browser_open_tab",
            "browser_list_tabs",
            "browser_select_tab",
            "browser_close_tab",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_press_key",
            "browser_close_all_tabs",
            "browser_navigate",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
    }

    #[test]
    fn every_tool_declares_an_object_input_schema() {
        for tool in tool_defs().as_array().expect("tool defs are an array") {
            let schema = &tool["inputSchema"];
            assert_eq!(
                schema["type"].as_str(),
                Some("object"),
                "{} has a non-object input schema",
                tool["name"]
            );
            assert!(
                schema["properties"].is_object(),
                "{} is missing properties",
                tool["name"]
            );
        }
    }
}
