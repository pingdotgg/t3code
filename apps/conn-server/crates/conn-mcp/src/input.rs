//! Decode-time rules generated from T3's schemas, including nested checks and trim transforms.

use std::{collections::HashMap, sync::OnceLock};

use regex_automata::meta::Regex;
use serde_json::{Value, json};

use crate::tools::Args;

const RULES: &str = include_str!("thread-inputs.json");
static COMPILED: OnceLock<Result<Rules, String>> = OnceLock::new();
struct Rules {
    schemas: Value,
    patterns: HashMap<String, Regex>,
}

fn pattern(check: &Value) -> String {
    let source = check["source"]
        .as_str()
        .unwrap_or_default()
        .replace("\\/", "/");
    let flags = check["flags"].as_str().unwrap_or_default();
    if flags.is_empty() {
        source
    } else {
        format!("(?{flags}){source}")
    }
}

fn compiled() -> Result<&'static Rules, String> {
    COMPILED
        .get_or_init(|| {
            fn collect(value: &Value, patterns: &mut HashMap<String, Regex>) -> Result<(), String> {
                if value["id"] == "isPattern" {
                    let source = pattern(value);
                    let regex = Regex::new(&source)
                        .map_err(|e| format!("Invalid generated pattern: {e}"))?;
                    patterns.insert(source, regex);
                }
                match value {
                    Value::Array(items) => {
                        for item in items {
                            collect(item, patterns)?;
                        }
                    }
                    Value::Object(fields) => {
                        for item in fields.values() {
                            collect(item, patterns)?;
                        }
                    }
                    _ => {}
                }
                Ok(())
            }
            let schemas: Value = serde_json::from_str(RULES).map_err(|e| e.to_string())?;
            let mut patterns = HashMap::new();
            collect(&schemas, &mut patterns)?;
            Ok(Rules { schemas, patterns })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn check(name: &str, args: &mut Args) -> Result<(), String> {
    let rules = compiled()?;
    let Some(rule) = rules.schemas.get(name) else {
        return Ok(());
    };
    let mut value = Value::Object(std::mem::take(args));
    let result = decode(rule, &mut value, "", &rules.patterns);
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

fn decode(
    rule: &Value,
    value: &mut Value,
    path: &str,
    patterns: &HashMap<String, Regex>,
) -> Result<(), String> {
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
            match decode(member, &mut candidate, path, patterns) {
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
        *value = json!(js_trim(s));
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
            if child["optional"] == true
                && (!object.contains_key(key)
                    || (child["nullAsOmitted"] == true
                        && object.get(key).is_some_and(Value::is_null)))
            {
                object.remove(key);
                continue;
            }
            let at = format!("{path}[{}]", json!(key));
            let Some(value) = object.get_mut(key) else {
                return Err(format!("Missing key\n  at {at}"));
            };
            decode(child, value, &at, patterns)?;
        }
        if let Some(values) = rule.get("values") {
            for (key, value) in object.iter_mut() {
                decode(values, value, &format!("{path}[{}]", json!(key)), patterns)?;
            }
        } else {
            object.retain(|key, _| fields(rule).any(|f| f["key"] == key.as_str()));
        }
    }
    if let (Some(items), Some(item)) = (value.as_array_mut(), rule.get("items")) {
        for (index, value) in items.iter_mut().enumerate() {
            decode(item, value, &format!("{path}[{index}]"), patterns)?;
        }
    }
    for check in rule["checks"].as_array().into_iter().flatten() {
        let length = value
            .as_str()
            .map(|s| s.encode_utf16().count())
            .or_else(|| value.as_array().map(Vec::len));
        let valid = match check["id"].as_str().unwrap_or_default() {
            "nonBlank" => value.as_str().is_some_and(|s| !s.trim().is_empty()),
            "isTrimmed" => value.as_str().is_some_and(|s| s == js_trim(s)),
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
            "isPattern" => patterns
                .get(&pattern(check))
                .is_some_and(|re| value.as_str().is_some_and(|s| re.is_match(s))),
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

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trimmed_check_uses_javascript_whitespace() {
        for (domain, allowed) in [
            ("\u{feff}example.test", false),
            ("example.test\u{feff}", false),
            ("\u{0085}example.test", true),
            ("example.test\u{0085}", true),
        ] {
            let mut args = serde_json::from_value(json!({"domain":domain})).unwrap();
            assert_eq!(
                check("request_credentials", &mut args).is_ok(),
                allowed,
                "{domain:?}"
            );
        }
    }
}
