//! MCP elicitations as approval prompts (`CodexMcpElicitation.ts` in T3's `apps/server`).
//!
//! Codex asks the client through `mcpServer/elicitation/request` when an MCP server needs the
//! user, for example to let an app use a connector. T3 shows a form elicitation as an approval
//! with the app's name and the persistence choices the server offers, and answers with the
//! form's matching option. A URL elicitation, or a form whose required fields an approval
//! cannot fill, is declined. The functions here read the request params as Codex sends them.

use serde_json::{Map, Value, json};

/// T3's `describeMcpElicitation`: the app name and the approval options to show.
pub(crate) fn describe(params: &Value) -> (String, Vec<Value>) {
    let meta = metadata(&params["_meta"]);
    let field = |value: &Value| value.as_str().map(str::to_owned);
    let from_message = params["message"].as_str().and_then(app_from_message);
    let app_name = meta
        .and_then(|m| {
            field(&m["app_name"])
                .or_else(|| field(&m["appName"]))
                .or_else(|| field(&m["app"]))
                .or_else(|| field(&m["target"]["app"]))
                .or_else(|| field(&m["target"]["name"]))
                .or_else(|| field(&m["tool_params"]["app_name"]))
                .or_else(|| field(&m["tool_params"]["app"]))
        })
        .or(from_message)
        .or_else(|| {
            meta.and_then(|m| field(&m["connector_name"]).or_else(|| field(&m["connectorName"])))
        })
        .unwrap_or_else(|| params["serverName"].as_str().unwrap_or_default().to_owned());

    // Insertion order does not matter: the options below come in a fixed order. A later
    // label replaces an earlier one, as `Map.set` does.
    let mut session: Option<String> = None;
    let mut always: Option<String> = None;
    let mut set = |decision: Persist, label: String| match decision {
        Persist::Session => session = Some(label),
        Persist::Always => always = Some(label),
    };
    if let Some(meta) = meta {
        let persist: Vec<&str> = match &meta["persist"] {
            Value::String(value) => vec![value.as_str()],
            Value::Array(values) => values.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        for value in persist {
            if let Some(decision) = persistence(value) {
                set(decision, String::new());
            }
        }
        if meta["allowPersistentApproval"] == true {
            set(Persist::Always, String::new());
        }
    }
    if let Some(form) = form(params) {
        for (key, field) in properties(form) {
            for (value, label) in field_options(field) {
                if let Some(decision) = persistence(&value) {
                    set(decision, label.unwrap_or_default());
                }
            }
            if field["type"] == "boolean" && is_persistence_field(key, field) {
                set(
                    Persist::Always,
                    field["title"].as_str().unwrap_or_default().to_owned(),
                );
            }
        }
    }

    let accepts = |decision: &str| response(params, decision)["action"] == "accept";
    let mut options = vec![
        json!({"decision": "cancel", "label": "Cancel"}),
        json!({"decision": "decline", "label": "Decline"}),
    ];
    if let Some(label) = session.filter(|_| accepts("acceptForSession")) {
        let label = if label.is_empty() {
            "Always allow this session".to_owned()
        } else {
            label
        };
        options.push(json!({"decision": "acceptForSession", "label": label}));
    }
    if let Some(label) = always.filter(|_| accepts("acceptAlways")) {
        let label = if label.is_empty() {
            "Always allow".to_owned()
        } else {
            label
        };
        options.push(json!({"decision": "acceptAlways", "label": label}));
    }
    options.push(json!({"decision": "accept", "label": "Approve"}));
    (app_name, options)
}

/// T3's `toMcpElicitationResponse`: the reply for an approval decision.
pub(crate) fn response(params: &Value, decision: &str) -> Value {
    if decision == "decline" || decision == "cancel" {
        return json!({ "action": decision });
    }
    // T3 cannot answer these itself. `decline` reads as the user's refusal, and Codex's browser
    // plugin saves it as a thread-wide site denial; `cancel` leaves no saved decision.
    if params["mode"] == "url" {
        return json!({"action": "cancel"});
    }
    let persist = match decision {
        "acceptForSession" => Some("session"),
        "acceptAlways" => Some("always"),
        _ => None,
    };
    let form = form(params);
    let mut content = Map::new();
    for (key, field) in form.map(properties).into_iter().flatten() {
        let chosen = field_options(field)
            .into_iter()
            .find(|(value, _)| match persist {
                Some(_) => persistence(value).map(Persist::decision) == Some(decision),
                None => is_once(value.trim()) && persistence(value).is_none(),
            });
        if let Some((value, _)) = chosen {
            content.insert(key.clone(), json!(value));
        } else if field["type"] == "boolean" && is_persistence_field(key, field) {
            content.insert(key.clone(), json!(decision == "acceptAlways"));
        } else if !field["default"].is_null() {
            content.insert(key.clone(), field["default"].clone());
        }
    }
    let missing = form
        .and_then(|f| f["required"].as_array())
        .is_some_and(|required| {
            required
                .iter()
                .filter_map(Value::as_str)
                .any(|key| !content.contains_key(key))
        });
    if missing {
        return json!({"action": "cancel"});
    }
    let mut reply = json!({"action": "accept"});
    if let Some(persist) = persist {
        reply["_meta"] = json!({ "persist": persist });
    }
    if form.is_some() {
        reply["content"] = Value::Object(content);
    }
    reply
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Persist {
    Session,
    Always,
}

impl Persist {
    fn decision(self) -> &'static str {
        match self {
            Self::Session => "acceptForSession",
            Self::Always => "acceptAlways",
        }
    }
}

/// `mcpElicitationPersistenceDecision`.
fn persistence(value: &str) -> Option<Persist> {
    let value = value.to_lowercase();
    if value.contains("session") {
        Some(Persist::Session)
    } else if ["always", "permanent", "forever", "persistent"]
        .iter()
        .any(|word| value.contains(word))
    {
        Some(Persist::Always)
    } else {
        None
    }
}

/// `isMcpElicitationPersistenceField`.
fn is_persistence_field(key: &str, field: &Value) -> bool {
    persistence(key).is_some()
        || key.to_lowercase() == "persist"
        || persistence(field["title"].as_str().unwrap_or_default()).is_some()
        || persistence(field["description"].as_str().unwrap_or_default()).is_some()
}

/// `^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$`,
/// ignoring case.
fn is_once(value: &str) -> bool {
    let value = value.to_lowercase();
    let separators = |s: &str| {
        s.trim_start_matches(|c: char| c == '_' || c == '-' || c.is_whitespace())
            .to_owned()
    };
    ["once", "accept", "approve", "allow"].iter().any(|word| {
        let Some(rest) = value.strip_prefix(word) else {
            return false;
        };
        if rest.is_empty() {
            return true;
        }
        let rest = separators(rest);
        if let Some(after) = rest.strip_prefix("once") {
            return after.is_empty() || separators(after) == "only";
        }
        rest.strip_prefix("this")
            .is_some_and(|after| separators(after) == "time")
    })
}

/// `Allow ChatGPT to use <app>?`.
fn app_from_message(message: &str) -> Option<String> {
    const PREFIX: &str = "allow chatgpt to use ";
    let head = message.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let app = message.get(PREFIX.len()..)?.strip_suffix('?')?;
    (!app.is_empty() && !app.contains('\n')).then(|| app.to_owned())
}

/// The options of a form field (`mcpElicitationFieldOptions`): `oneOf`, else `enum` with
/// `enumNames` as labels.
fn field_options(field: &Value) -> Vec<(String, Option<String>)> {
    if let Some(one_of) = field["oneOf"].as_array() {
        return one_of
            .iter()
            .filter_map(|o| {
                Some((
                    o["const"].as_str()?.to_owned(),
                    o["title"].as_str().map(str::to_owned),
                ))
            })
            .collect();
    }
    field["enum"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, value)| {
            let label = field["enumNames"]
                .get(i)
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some((value.as_str()?.to_owned(), label))
        })
        .collect()
}

fn properties(form: &Value) -> impl Iterator<Item = (&String, &Value)> {
    form["properties"].as_object().into_iter().flatten()
}

fn nullable_string(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || v.is_string())
}

fn nullable_strings(value: Option<&Value>) -> bool {
    value
        .is_none_or(|v| v.is_null() || v.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
}

/// `_meta` when it has T3's metadata shape; a field of another type makes T3 ignore all of it.
fn metadata(meta: &Value) -> Option<&Value> {
    let object = meta.as_object()?;
    let strings = [
        "app",
        "app_name",
        "appName",
        "connector_name",
        "connectorName",
    ]
    .iter()
    .all(|key| nullable_string(object.get(*key)));
    let allow = object
        .get("allowPersistentApproval")
        .is_none_or(|v| v.is_null() || v.is_boolean());
    let persist = object
        .get("persist")
        .is_none_or(|v| v.is_null() || v.is_string() || nullable_strings(Some(v)));
    let nested = |key: &str, fields: &[&str]| {
        object.get(key).is_none_or(|v| {
            v.is_null()
                || v.as_object()
                    .is_some_and(|o| fields.iter().all(|f| nullable_string(o.get(*f))))
        })
    };
    (strings
        && allow
        && persist
        && nested("target", &["app", "name"])
        && nested("tool_params", &["app", "app_name"]))
    .then_some(meta)
}

/// The requested form when it has T3's form shape and the mode is not `url`.
fn form(params: &Value) -> Option<&Value> {
    if params["mode"] == "url" {
        return None;
    }
    let schema = &params["requestedSchema"];
    let object = schema.as_object()?;
    let fields_ok = object.get("properties").is_none_or(|p| {
        p.as_object().is_some_and(|fields| {
            fields.values().all(|field| {
                let Some(f) = field.as_object() else {
                    return false;
                };
                ["type", "title", "description"]
                    .iter()
                    .all(|key| nullable_string(f.get(*key)))
                    && nullable_strings(f.get("enum"))
                    && nullable_strings(f.get("enumNames"))
                    && f.get("oneOf").is_none_or(|v| {
                        v.is_null()
                            || v.as_array().is_some_and(|options| {
                                options.iter().all(|o| {
                                    o["const"].is_string() && nullable_string(o.get("title"))
                                })
                            })
                    })
            })
        })
    });
    let required_ok = nullable_strings(object.get("required"));
    (fields_ok && required_ok).then_some(schema)
}

#[cfg(test)]
mod tests {
    //! T3's `CodexMcpElicitation.test.ts`, case for case.
    use super::*;

    fn request() -> Value {
        json!({
            "mode": "form",
            "message": "Allow ChatGPT to use Safari?",
            "serverName": "computer-use",
            "threadId": "provider-thread-1",
            "turnId": "turn-1",
            "_meta": {"app_name": "Safari", "persist": ["session", "always"]},
            "requestedSchema": {
                "type": "object",
                "properties": {"approval": {"type": "string", "oneOf": [
                    {"const": "once", "title": "Allow once"},
                    {"const": "session", "title": "Allow for this session"},
                    {"const": "always", "title": "Always allow Safari"}
                ]}},
                "required": ["approval"]
            }
        })
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn preserves_the_app_name_and_advertised_persistence_choices() {
        let (app, options) = describe(&request());
        assert_eq!(app, "Safari");
        assert_eq!(
            options,
            [
                json!({"decision": "cancel", "label": "Cancel"}),
                json!({"decision": "decline", "label": "Decline"}),
                json!({"decision": "acceptForSession", "label": "Allow for this session"}),
                json!({"decision": "acceptAlways", "label": "Always allow Safari"}),
                json!({"decision": "accept", "label": "Approve"}),
            ]
        );
    }

    #[test]
    fn returns_the_accepted_form_option_to_codex() {
        assert_eq!(
            response(&request(), "accept"),
            json!({"action": "accept", "content": {"approval": "once"}})
        );
    }

    #[test]
    fn returns_session_scoped_approval_in_the_mcp_response() {
        assert_eq!(
            response(&request(), "acceptForSession"),
            json!({"action": "accept", "_meta": {"persist": "session"}, "content": {"approval": "session"}})
        );
    }

    #[test]
    fn returns_persistent_approval_in_the_mcp_response() {
        assert_eq!(
            response(&request(), "acceptAlways"),
            json!({"action": "accept", "_meta": {"persist": "always"}, "content": {"approval": "always"}})
        );
    }

    #[test]
    fn supports_boolean_permanent_approval_fields() {
        let boolean = with(
            with(request(), "_meta", json!({"app_name": "Safari"})),
            "requestedSchema",
            json!({"type": "object", "properties": {"always": {"type": "boolean", "title": "Always allow Safari"}}}),
        );
        assert!(
            describe(&boolean)
                .1
                .iter()
                .any(|o| o["decision"] == "acceptAlways")
        );
        assert_eq!(
            response(&boolean, "acceptAlways"),
            json!({"action": "accept", "_meta": {"persist": "always"}, "content": {"always": true}})
        );
    }

    #[test]
    fn preserves_valid_nullable_form_fields_and_persistence_choices() {
        let nullable = with(
            with(
                request(),
                "_meta",
                json!({"app_name": null, "appName": "Safari", "connector_name": null,
                    "persist": null, "target": null, "tool_params": null}),
            ),
            "requestedSchema",
            json!({"type": "object", "properties": {"approval": {"type": "string", "title": null,
                "description": null, "default": null, "enum": ["once", "always"], "enumNames": null}},
                "required": ["approval"]}),
        );
        let (app, options) = describe(&nullable);
        assert_eq!(app, "Safari");
        assert!(options.iter().any(|o| o["decision"] == "acceptAlways"));
        assert_eq!(
            response(&nullable, "acceptAlways"),
            json!({"action": "accept", "_meta": {"persist": "always"}, "content": {"approval": "always"}})
        );
    }

    #[test]
    fn cancels_required_form_fields_that_an_approval_prompt_cannot_collect() {
        let input = with(
            request(),
            "requestedSchema",
            json!({"type": "object", "properties": {"email": {"type": "string", "format": "email"}},
                "required": ["email"]}),
        );
        assert_eq!(response(&input, "accept"), json!({"action": "cancel"}));
    }

    #[test]
    fn does_not_approve_url_elicitations_without_opening_their_url() {
        let url = json!({"mode": "url", "message": "Finish signing in to continue.",
            "serverName": "computer-use", "threadId": "provider-thread-1", "turnId": "turn-1",
            "elicitationId": "sign-in-1", "url": "https://example.com/authorize"});
        // `cancel`, not `decline`: Codex's browser plugin saves a decline as a site denial.
        assert_eq!(response(&url, "accept"), json!({"action": "cancel"}));
    }

    #[test]
    fn omits_persistence_choices_that_cannot_satisfy_required_fields() {
        let once_only = with(
            request(),
            "requestedSchema",
            json!({"type": "object", "properties": {"approval": {"type": "string", "enum": ["once"]}},
                "required": ["approval"]}),
        );
        assert_eq!(
            describe(&once_only).1,
            [
                json!({"decision": "cancel", "label": "Cancel"}),
                json!({"decision": "decline", "label": "Decline"}),
                json!({"decision": "accept", "label": "Approve"}),
            ]
        );
    }

    #[test]
    fn the_once_pattern_matches_as_t3s_regex() {
        for yes in [
            "once",
            "Accept",
            "allow once",
            "approve_this-time",
            "allow once only",
            "acceptonce",
        ] {
            assert!(is_once(yes), "{yes}");
        }
        for no in [
            "session",
            "allow forever",
            "once more",
            "allowed",
            "this time",
        ] {
            assert!(!is_once(no), "{no}");
        }
    }

    #[test]
    fn the_app_name_comes_from_the_message_when_the_metadata_has_none() {
        let plain = with(request(), "_meta", json!({}));
        assert_eq!(describe(&plain).0, "Safari");
        let neither = with(
            with(request(), "_meta", Value::Null),
            "message",
            json!("Hi"),
        );
        assert_eq!(describe(&neither).0, "computer-use");
    }
}
