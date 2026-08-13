//! Agent-owned Chrome tabs.
//!
//! On macOS this is a native-messaging host: Chrome spawns the server in
//! `native-host` mode and the two halves meet over a local socket, so the agent
//! drives its own tab group while the user keeps browsing untouched.
//!
//! The Windows and Linux hosts are not wired up yet. The tools stay advertised
//! so the surface matches macOS, and each call explains precisely what is
//! missing rather than failing in a way a model would misread as "the page had
//! no such element".

use serde_json::Value;

pub struct BrowserBridge {
    connected: bool,
}

impl BrowserBridge {
    pub fn new() -> Self {
        Self { connected: false }
    }

    /// Dispatch a `browser_*` call. `command` has the `browser_` prefix stripped.
    pub fn call(&mut self, command: &str, _args: &Value) -> Result<String, String> {
        if !self.connected {
            return Err(format!(
                "browser_{command} needs the T3 Code Chrome extension, which is not connected on \
                 this platform yet. Use the desktop tools instead: activate_app(\"Google Chrome\") \
                 then get_app_state to read the window and click to interact."
            ));
        }
        Err(format!("browser_{command} is not implemented"))
    }
}

impl Default for BrowserBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::BrowserBridge;
    use serde_json::json;

    #[test]
    fn an_unconnected_bridge_points_at_the_working_alternative() {
        let mut bridge = BrowserBridge::new();
        let error = bridge.call("open_tab", &json!({})).unwrap_err();

        // A model that reads this should know to fall back, not retry blindly.
        assert!(error.contains("browser_open_tab"), "names the tool: {error}");
        assert!(error.contains("get_app_state"), "offers a path: {error}");
    }
}
