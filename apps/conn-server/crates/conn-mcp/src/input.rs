//! Decode-time rules generated from T3's schemas, including nested checks and trim transforms.

use serde_json::{Value, json};

use crate::tools::Args;

const RULES: &str = include_str!("thread-inputs.json");

pub(crate) fn check(name: &str, args: &mut Args) -> Result<(), String> {
    let rules: Value = serde_json::from_str(RULES).map_err(|e| e.to_string())?;
    let Some(rule) = rules.get(name) else {
        return Ok(());
    };
    let mut value = Value::Object(std::mem::take(args));
    let result = decode(rule, &mut value, "");
    if let Value::Object(decoded) = value {
        *args = decoded;
    }
    result
}

fn problem(expected: &str, path: &str) -> String {
    if path.is_empty() {
        format!("Expected {expected}")
    } else {
        format!("Expected {expected}\n  at {path}")
    }
}

fn fields(rule: &Value) -> impl Iterator<Item = &Value> {
    rule["fields"].as_array().into_iter().flatten()
}

fn fits(rule: &Value, value: &Value) -> bool {
    match rule["kind"].as_str().unwrap_or_default() {
        "String" => value.is_string(),
        "Number" => value.is_number(),
        "Boolean" => value.is_boolean(),
        "Literal" => rule["literal"] == *value,
        "Null" => value.is_null(),
        "Arrays" => value.is_array() || (rule["fromRecord"] == true && value.is_object()),
        "Objects" => {
            value.is_object()
                && fields(rule)
                    .filter(|f| matches!(f["key"].as_str(), Some("type" | "_tag")))
                    .all(|f| {
                        value
                            .get(f["key"].as_str().unwrap_or_default())
                            .is_none_or(|v| fits(&f["rule"], v))
                    })
        }
        "Union" => rule["members"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|r| fits(r, value)),
        _ => false,
    }
}

fn decode(rule: &Value, value: &mut Value, path: &str) -> Result<(), String> {
    let expected = rule["expected"].as_str().unwrap_or("a valid value");
    if rule["kind"] == "Union" {
        let mut first_error = None;
        for member in rule["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| fits(m, value))
        {
            let mut candidate = value.clone();
            match decode(member, &mut candidate, path) {
                Ok(()) => {
                    *value = candidate;
                    return Ok(());
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        return Err(first_error.unwrap_or_else(|| problem(expected, path)));
    }
    if !fits(rule, value) {
        return Err(problem(expected, path));
    }
    if rule["trim"] == true
        && let Some(s) = value.as_str()
    {
        *value = json!(
            s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        );
    }
    if rule["fromRecord"] == true
        && let Some(map) = value.as_object()
    {
        *value = Value::Array(
            map.iter()
                .map(|(id, value)| json!({"id":id,"value":value}))
                .collect(),
        );
    }
    if let Some(object) = value.as_object_mut() {
        for field in fields(rule) {
            let key = field["key"].as_str().unwrap_or_default();
            let child = &field["rule"];
            if child["optional"] == true && object.get(key).is_none_or(Value::is_null) {
                object.remove(key);
                continue;
            }
            let at = format!("{path}[{}]", json!(key));
            let Some(value) = object.get_mut(key) else {
                return Err(format!("Missing key\n  at {at}"));
            };
            decode(child, value, &at)?;
        }
        if let Some(values) = rule.get("values") {
            for (key, value) in object.iter_mut() {
                decode(values, value, &format!("{path}[{}]", json!(key)))?;
            }
        } else {
            object.retain(|key, _| fields(rule).any(|f| f["key"] == key.as_str()));
        }
    }
    if let (Some(items), Some(item)) = (value.as_array_mut(), rule.get("items")) {
        for (index, value) in items.iter_mut().enumerate() {
            decode(item, value, &format!("{path}[{index}]"))?;
        }
    }
    for check in rule["checks"].as_array().into_iter().flatten() {
        let length = value
            .as_str()
            .map(|s| s.encode_utf16().count())
            .or_else(|| value.as_array().map(Vec::len));
        let valid = match check["id"].as_str().unwrap_or_default() {
            "nonBlank" => value.as_str().is_some_and(|s| !s.trim().is_empty()),
            "isMinLength" => {
                length.is_some_and(|n| n as u64 >= check["minLength"].as_u64().unwrap_or(0))
            }
            "isMaxLength" => {
                length.is_some_and(|n| n as u64 <= check["maxLength"].as_u64().unwrap_or(u64::MAX))
            }
            "isInt" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
            "isGreaterThanOrEqualTo" => value
                .as_f64()
                .is_some_and(|n| n >= check["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY)),
            "isLessThanOrEqualTo" => value
                .as_f64()
                .is_some_and(|n| n <= check["maximum"].as_f64().unwrap_or(f64::INFINITY)),
            "isPattern" => {
                let source = check["source"].as_str().unwrap_or_default();
                let flags = check["flags"].as_str().unwrap_or_default();
                let source = source.replace("\\/", "/");
                let pattern = if flags.is_empty() {
                    source
                } else {
                    format!("(?{flags}){source}")
                };
                let re = regex_automata::meta::Regex::new(&pattern)
                    .map_err(|e| format!("Invalid generated pattern: {e}"))?;
                value.as_str().is_some_and(|s| re.is_match(s))
            }
            other => return Err(format!("Unknown generated input check {other}")),
        };
        if !valid {
            return Err(problem(
                check["expected"].as_str().unwrap_or("a valid value"),
                path,
            ));
        }
    }
    Ok(())
}
