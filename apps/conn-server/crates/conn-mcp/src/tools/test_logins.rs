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
    cx.require_preview()?;
    let input: SaveTestLoginInput = from_json(Value::Object(args.clone())).map_err(internal)?;
    store(cx)?
        .save(input, TestLoginSummaryCreatedBy::Agent)
        .await
        .map(|s| to_json(&s))
        .map_err(|e| ToolError::Message(e.to_string()))
}
pub(super) async fn request(cx: &Cx<'_>, args: &Args) -> ToolResult {
    cx.require_preview()?;
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
    let value = conn_support::text::js_trim(value);
    if value.is_empty() {
        return None;
    }
    let explicit = value.split_once("://").is_some_and(|(scheme, _)| {
        let mut chars = scheme.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    let parsed = url::Url::parse(&if explicit {
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

/// `STATUS_MESSAGES` (`CredentialAutofill.ts`).
fn status_message(status: &str) -> &'static str {
    match status {
        "filled" => "Filled. The value is not shown to you.",
        "denied" => "The user did not approve this fill. Do not retry unless the user asks.",
        "tab_unavailable" => {
            "The tab has no page loaded. Open the sign-in page with preview_navigate first."
        }
        "origin_mismatch" => {
            "The tab's site does not match the item's saved website, so nothing was filled. Navigate to the item's site or ask the user to fix the saved URL."
        }
        "field_not_found" => {
            "No matching input is visible on the page. Navigate to the sign-in step that shows it, or pass a CSS selector."
        }
        "not_editable" => {
            "The input cannot take this value. Passwords only go into masked password inputs."
        }
        "item_not_found" => "No login with this id. Call request_credentials first.",
        "no_value" => "This item has no value for that field.",
        "provider_unavailable" => "The password manager is unavailable.",
        _ => "The page did not accept the value.",
    }
}

fn fill_result(status: &str) -> Value {
    json!({"status": status, "message": status_message(status)})
}

/// `fill_credential` (`CredentialAutofill.fill`): checks the tab's origin against the saved
/// test login, then has the browser insert one value. Returns a status, never the value.
pub(super) async fn fill(cx: &Cx<'_>, args: &Args) -> ToolResult {
    let caller = cx.require_thread("This tool")?.clone();
    cx.writing_caller().await?;
    cx.require_preview()?;
    let Some(preview) = cx.config().preview.clone() else {
        return Err(ToolError::Message(
            include_str!("../preview-unavailable.txt").to_owned(),
        ));
    };
    let store = store(cx)?;
    let Ok(list) = store.list().await else {
        return Ok(json!({"status": "provider_unavailable",
            "message": "T3 Code could not read or save its test logins."}));
    };
    let item = str_arg(args, "itemId").unwrap_or_default();
    let Some(login) = list.items.into_iter().find(|login| login.id == item) else {
        return Ok(fill_result("item_not_found"));
    };
    let page = preview.status(
        &caller.thread_id,
        &caller.provider_session_id,
        str_arg(args, "tabId"),
    );
    let (Some(url), Some(tab)) = (
        page["url"].as_str().filter(|u| !u.is_empty()),
        page["tabId"].as_str().filter(|t| !t.is_empty()),
    ) else {
        return Ok(fill_result("tab_unavailable"));
    };
    if page["available"] != true {
        return Ok(fill_result("tab_unavailable"));
    }
    let saved = vec![login.url.clone()];
    let Some(origin) = conn_features::test_logins::origin::matching_origin(&saved, url) else {
        let hosts = conn_features::test_logins::origin::parse_saved_url(&login.url)
            .map(|target| target.host)
            .unwrap_or_else(|| "no website".to_owned());
        return Ok(json!({"status": "origin_mismatch",
            "message": format!("{} Saved for: {hosts}.", status_message("origin_mismatch"))}));
    };
    let field = str_arg(args, "field").unwrap_or_default();
    let expression = conn_preview::credential_field_expression(field, str_arg(args, "selector"))
        .map_err(|error| ToolError::Message(error.to_string()))?;
    let value = match field {
        "username" => Some(login.username.clone()),
        _ => match store.reveal(&login.id).await {
            Ok(secrets) if field == "otp" => secrets
                .otp_secret
                .as_deref()
                .and_then(conn_features::test_logins::totp::parse_totp_setup)
                .map(|setup| {
                    conn_features::test_logins::totp::totp_code(
                        &setup,
                        conn_support::time::now_ms(),
                    )
                }),
            Ok(secrets) => Some(secrets.password),
            Err(error) => {
                return Ok(json!({"status": "provider_unavailable", "message": error.to_string()}));
            }
        },
    };
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(fill_result("no_value"));
    };
    let filled = preview
        .invoke(
            &caller.thread_id,
            &caller.provider_session_id,
            "credentialFill",
            json!({"tabId": tab, "initiator": "agent", "field": field, "expectedOrigin": origin,
                "fieldExpression": expression, "value": value}),
        )
        .await
        .map_err(|error| ToolError::Message(error.to_string()))?;
    let status = filled["status"].as_str().unwrap_or("insert_failed");
    Ok(fill_result(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bare_host_with_scheme_in_query_matches() {
        assert_eq!(
            host("myapp.test/login?next=https://myapp.test").as_deref(),
            Some("myapp.test")
        );
        assert_eq!(
            host("myapp.test/#https://myapp.test").as_deref(),
            Some("myapp.test")
        );
        assert_eq!(
            host("HTTPS://WWW.myapp.test/login").as_deref(),
            Some("myapp.test")
        );
        assert_eq!(host("ftp://myapp.test"), None);
        assert_eq!(host("\u{0085}myapp.test"), None);
    }
}
