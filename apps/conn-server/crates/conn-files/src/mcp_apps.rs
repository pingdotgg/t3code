//! Bounded HTML snapshots for MCP App cards (`McpAppSnapshot.ts`). Runs on a blocking thread.
use crate::attachments::{AttachmentStore, thread_segment};
use serde_json::{Value, json};

const MAX_HTML_BYTES: usize = 5 * 1024 * 1024;

impl AttachmentStore {
    pub fn snapshot_mcp_app(
        &self,
        thread: &str,
        server: &str,
        tool: &str,
        uri: &str,
        contents: &Value,
    ) -> Result<Option<Value>, String> {
        if !uri.starts_with("ui://") {
            return Ok(None);
        }
        for content in contents.as_array().into_iter().flatten() {
            if content.get("uri").is_some_and(|value| value != uri) {
                continue;
            }
            let mime = content
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .to_ascii_lowercase();
            if mime != "text/html;profile=mcp-app" {
                continue;
            }
            let html = if let Some(text) = content.get("text").and_then(Value::as_str) {
                if text.len() > MAX_HTML_BYTES {
                    return Ok(None);
                }
                text.to_owned()
            } else if let Some(blob) = content.get("blob").and_then(Value::as_str) {
                if blob.len() > MAX_HTML_BYTES.div_ceil(3) * 4 {
                    return Ok(None);
                }
                let Some(bytes) = conn_support::base64::decode(blob) else {
                    continue;
                };
                String::from_utf8_lossy(&bytes).into_owned()
            } else {
                continue;
            };
            if html.len() > MAX_HTML_BYTES {
                return Ok(None);
            }
            if html.trim().is_empty() {
                continue;
            }
            let Some(segment) = thread_segment(thread) else {
                return Ok(None);
            };
            let id = format!("{segment}-{}-html", conn_support::uuid_v4());
            let ui = content.pointer("/_meta/ui").unwrap_or(&Value::Null);
            let csp = sanitize_csp(ui.get("csp").unwrap_or(&Value::Null));
            let document = inject_csp(&html, &csp);
            let path = self.dir().join(format!("{id}.html"));
            if let Err(error) = std::fs::write(&path, document) {
                let _ = std::fs::remove_file(&path);
                return Err(error.to_string());
            }
            let mut reference =
                json!({"attachmentId":id,"server":server,"tool":tool,"resourceUri":uri});
            if csp.as_object().is_some_and(|c| !c.is_empty()) {
                reference["csp"] = csp;
            }
            let mut permissions = json!({});
            for key in ["camera", "microphone", "geolocation", "clipboardWrite"] {
                if ui
                    .get("permissions")
                    .and_then(|p| p.get(key))
                    .is_some_and(|v| v.is_object() || v.is_array())
                {
                    permissions[key] = json!({});
                }
            }
            if permissions.as_object().is_some_and(|p| !p.is_empty()) {
                reference["permissions"] = permissions;
            }
            if let Some(border) = ui.get("prefersBorder").filter(|b| b.is_boolean()) {
                reference["prefersBorder"] = border.clone();
            }
            return Ok(Some(reference));
        }
        Ok(None)
    }
}

fn valid_domain(domain: &str) -> bool {
    if domain.len() > 256 {
        return false;
    }
    let Some((scheme, host)) = domain.split_once("://") else {
        return false;
    };
    if !["http", "https", "ws", "wss"]
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
    {
        return false;
    }
    let host = host.strip_prefix("*.").unwrap_or(host);
    let host = if let Some((host, port)) = host.split_once(':') {
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        host
    } else {
        host
    };
    host.split('.').all(|label| {
        !label.is_empty()
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

fn sanitize_csp(value: &Value) -> Value {
    let mut csp = json!({});
    for key in [
        "connectDomains",
        "resourceDomains",
        "frameDomains",
        "baseUriDomains",
    ] {
        let domains: Vec<&str> = value
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|d| valid_domain(d))
            .take(32)
            .collect();
        if !domains.is_empty() {
            csp[key] = json!(domains);
        }
    }
    csp
}

fn inject_csp(html: &str, csp: &Value) -> String {
    let list = |key| {
        csp.get(key)
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    };
    let resources = list("resourceDomains");
    let fallback = |key| {
        let v = list(key);
        if v.is_empty() { "'none'".into() } else { v }
    };
    let directives = [
        "default-src 'none'".into(),
        format!("script-src 'unsafe-inline' {resources}")
            .trim()
            .into(),
        format!("style-src 'unsafe-inline' {resources}")
            .trim()
            .into(),
        format!("img-src data: blob: {resources}").trim().into(),
        format!("font-src data: {resources}").trim().into(),
        format!("media-src data: blob: {resources}").trim().into(),
        format!("connect-src {}", fallback("connectDomains")),
        format!("frame-src blob: {}", list("frameDomains"))
            .trim()
            .into(),
        "object-src 'none'".into(),
        format!("base-uri {}", fallback("baseUriDomains")),
        "form-action 'none'".into(),
    ];
    let policy = directives
        .join("; ")
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;");
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{policy}\">");
    let trimmed = html.trim_start_matches('\u{feff}').trim_start();
    let doctype_end = if trimmed
        .get(..9)
        .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"))
    {
        trimmed
            .find('>')
            .map(|end| html.len() - trimmed.len() + end + 1)
    } else {
        None
    };
    if let Some(end) = doctype_end
        && let Some((prefix, rest)) = html.split_at_checked(end)
    {
        return format!("{prefix}{meta}{rest}");
    }
    format!("<!doctype html>{meta}{html}")
}

pub fn bootstrap(html: &str) -> String {
    let trimmed = html.trim_start_matches('\u{feff}').trim_start();
    let doctype = trimmed
        .get(..9)
        .is_some_and(|s| s.eq_ignore_ascii_case("<!doctype"));
    let end = if doctype {
        trimmed
            .find('>')
            .map_or(0, |end| html.len() - trimmed.len() + end + 1)
    } else {
        0
    };
    let after = html.get(end..).unwrap_or_default();
    let after = after.trim_start();
    let offset = if after.starts_with("<meta http-equiv=\"Content-Security-Policy\"") {
        after
            .find('>')
            .map_or(end, |end| html.len() - after.len() + end + 1)
    } else {
        end
    };
    let (prefix, rest) = html.split_at_checked(offset).unwrap_or(("", html));
    let document_type = if doctype { "" } else { "<!doctype html>" };
    format!(
        "{document_type}{prefix}{}{rest}",
        crate::mcp_app_bootstrap::BOOTSTRAP
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_is_sandboxed_bounded_and_keeps_the_resource_policy() {
        let dir =
            std::env::temp_dir().join(format!("conn-mcp-app-snapshot-{}", conn_support::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = AttachmentStore::new(dir.clone());
        let contents = json!([{"uri":"ui://app","mimeType":" TEXT/HTML ; profile=mcp-app", "text":"<!doctype html><h1>Hello</h1>","_meta":{"ui":{"csp":{"connectDomains":["https://example.com","*","https://evil/path"]},"permissions":{"camera":{}},"prefersBorder":true}}}]);
        let reference = store
            .snapshot_mcp_app("t", "server", "tool", "ui://app", &contents)
            .unwrap()
            .unwrap();
        assert_eq!(
            reference["csp"]["connectDomains"],
            json!(["https://example.com"])
        );
        assert_eq!(reference["permissions"], json!({"camera":{}}));
        let asset = store
            .resolve(reference["attachmentId"].as_str().unwrap())
            .unwrap();
        let html = std::fs::read_to_string(asset.path).unwrap();
        assert!(html.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
        assert!(html.contains("connect-src https://example.com"));
        assert!(html.contains("script-src 'unsafe-inline';"));
        let oversized =
            json!([{"mimeType":"text/html;profile=mcp-app","text":"x".repeat(MAX_HTML_BYTES+1)}]);
        assert!(
            store
                .snapshot_mcp_app("t", "s", "t", "ui://app", &oversized)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .snapshot_mcp_app("t", "s", "t", "ui://other", &contents)
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .snapshot_mcp_app("t", "s", "t", "https://app", &contents)
                .unwrap()
                .is_none()
        );
        let blob = json!([{"mimeType":"text/html;profile=mcp-app","blob":conn_support::base64::encode(b"<h1>blob</h1>")}]);
        assert!(
            store
                .snapshot_mcp_app("t", "s", "t", "ui://app", &blob)
                .unwrap()
                .is_some()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
