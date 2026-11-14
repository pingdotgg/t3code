//! Payload limits that the contract's schemas check and the generated Rust types do not: a
//! string's length and pattern, a number's range, a record's number of entries. The table is
//! generated (`limits/generated.rs`, by `tools/gen-upstream.mjs`) from the payload schemas in
//! `packages/contracts/src/rpc.ts`, for the methods it lists.
//!
//! `MethodTable` calls [`check`] before it decodes a payload. A payload over a limit ends the
//! call with a defect, as a schema failure does in the T3 server. The text is ours: it names
//! the limit and the path, not Effect's whole issue tree. A record entry whose key breaks the
//! key's limits is dropped, as Effect's decode drops it (a terminal env key such as `1FOO`).
//! `tools/limits-cases.json` holds the cases; `tools/limits-diff.mjs` runs them through the T3
//! contract's own decode and a test here through [`check`].
//!
//! A length counts UTF-16 code units, as JavaScript's `length` does. The T3 server checks a
//! trimmed string's length after it trims; this check reads the string as sent.

use std::{collections::HashMap, sync::OnceLock};

use regex_automata::meta::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::table::Failure;

mod generated;

/// One schema node's limits, as the generator writes them.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawLimit {
    #[serde(default)]
    fields: HashMap<String, RawLimit>,
    keys: Option<Box<RawLimit>>,
    values: Option<Box<RawLimit>>,
    #[serde(default)]
    variants: HashMap<String, RawLimit>,
    max_length: Option<usize>,
    pattern: Option<String>,
    max_properties: Option<usize>,
    #[serde(default)]
    int: bool,
    minimum: Option<f64>,
    maximum: Option<f64>,
}

struct Limit {
    fields: Vec<(String, Limit)>,
    keys: Option<Box<Limit>>,
    values: Option<Box<Limit>>,
    variants: Vec<(String, Limit)>,
    max_length: Option<usize>,
    pattern: Option<(String, Regex)>,
    max_properties: Option<usize>,
    int: bool,
    minimum: Option<f64>,
    maximum: Option<f64>,
}

impl Limit {
    /// Compiles the patterns. A pattern Rust's regex cannot compile is dropped with a warning;
    /// the test `every_generated_pattern_compiles` keeps that from shipping.
    fn build(raw: RawLimit) -> Self {
        let pattern = raw.pattern.and_then(|source| match Regex::new(&source) {
            Ok(regex) => Some((source, regex)),
            Err(error) => {
                eprintln!("conn-server: payload pattern {source:?} does not compile: {error}");
                None
            }
        });
        let mut fields: Vec<_> = raw
            .fields
            .into_iter()
            .map(|(k, v)| (k, Self::build(v)))
            .collect();
        fields.sort_by(|a, b| a.0.cmp(&b.0));
        let mut variants: Vec<_> = raw
            .variants
            .into_iter()
            .map(|(k, v)| (k, Self::build(v)))
            .collect();
        variants.sort_by(|a, b| a.0.cmp(&b.0));
        Self {
            fields,
            keys: raw.keys.map(|k| Box::new(Self::build(*k))),
            values: raw.values.map(|v| Box::new(Self::build(*v))),
            variants,
            max_length: raw.max_length,
            pattern,
            max_properties: raw.max_properties,
            int: raw.int,
            minimum: raw.minimum,
            maximum: raw.maximum,
        }
    }

    /// The first broken limit in `value`, with its path, or `None`. Values of another JSON
    /// type than the limit expects pass: decode reports those.
    ///
    /// A record entry whose key breaks the key's limits is removed, not refused: Effect's
    /// `Schema.Record` decode drops such an entry and never reads its value. The entry count
    /// is checked after that, as Effect checks it on the decoded record.
    fn problem(&self, value: &mut Value, path: &mut Vec<String>) -> Option<String> {
        match value {
            Value::String(text) => self.text_problem(text, path),
            Value::Number(number) => self.number_problem(number.as_f64()?, path),
            Value::Object(map) => {
                if let Some(Value::String(tag)) = map.get("_tag")
                    && let Some((_, variant)) = self.variants.iter().find(|(t, _)| t == tag)
                {
                    return variant.problem(value, path);
                }
                for (name, limit) in &self.fields {
                    if let Some(field) = map.get_mut(name) {
                        path.push(name.clone());
                        let found = limit.problem(field, path);
                        path.pop();
                        if found.is_some() {
                            return found;
                        }
                    }
                }
                if let Some(keys) = &self.keys {
                    map.retain(|key, _| keys.text_problem(key, &[]).is_none());
                }
                if let Some(values) = &self.values {
                    for (key, field) in map.iter_mut() {
                        path.push(key.clone());
                        let found = values.problem(field, path);
                        path.pop();
                        if found.is_some() {
                            return found;
                        }
                    }
                }
                match self.max_properties {
                    Some(max) if map.len() > max => Some(at(
                        format!("a value with at most {max} entries, got {}", map.len()),
                        path,
                    )),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn text_problem(&self, text: &str, path: &[String]) -> Option<String> {
        if let Some(max) = self.max_length {
            let length = text.encode_utf16().count();
            if length > max {
                return Some(at(
                    format!("a value with a length of at most {max}, got {length}"),
                    path,
                ));
            }
        }
        if let Some((source, regex)) = &self.pattern
            && !regex.is_match(text)
        {
            return Some(at(format!("a string matching the RegExp {source}"), path));
        }
        None
    }

    fn number_problem(&self, n: f64, path: &[String]) -> Option<String> {
        if self.int && n.fract() != 0.0 {
            return Some(at("an integer".to_owned(), path));
        }
        if let Some(min) = self.minimum
            && n < min
        {
            return Some(at(format!("a value greater than or equal to {min}"), path));
        }
        if let Some(max) = self.maximum
            && n > max
        {
            return Some(at(format!("a value less than or equal to {max}"), path));
        }
        None
    }
}

fn at(expected: String, path: &[String]) -> String {
    let mut text = format!("expected {expected}");
    if !path.is_empty() {
        text.push_str(" at ");
        for step in path {
            text.push('[');
            text.push_str(&Value::String(step.clone()).to_string());
            text.push(']');
        }
    }
    text
}

fn table() -> &'static HashMap<String, Limit> {
    static TABLE: OnceLock<HashMap<String, Limit>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let raw: HashMap<String, RawLimit> = match serde_json::from_str(generated::LIMITS) {
            Ok(raw) => raw,
            Err(error) => {
                eprintln!("conn-server: the generated payload limits do not parse: {error}");
                HashMap::new()
            }
        };
        raw.into_iter().map(|(k, v)| (k, Limit::build(v))).collect()
    })
}

/// Checks `payload` against the limits of method `tag`, and drops the record entries that
/// Effect's decode would drop. A method without limits passes unchanged.
pub fn check(tag: &str, payload: &mut Value) -> Result<(), Failure> {
    let Some(limit) = table().get(tag) else {
        return Ok(());
    };
    match limit.problem(payload, &mut Vec::new()) {
        Some(problem) => Err(Failure::die(format!(
            "invalid payload for `{tag}`: {problem}"
        ))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    #[test]
    fn every_generated_pattern_compiles() {
        let raw: HashMap<String, RawLimit> =
            serde_json::from_str(generated::LIMITS).expect("generated limits parse");
        fn walk(limit: &RawLimit) {
            if let Some(source) = &limit.pattern {
                Regex::new(source).expect("pattern compiles");
            }
            limit.fields.values().for_each(walk);
            limit.variants.values().for_each(walk);
            limit.keys.iter().for_each(|k| walk(k));
            limit.values.iter().for_each(|v| walk(v));
        }
        raw.values().for_each(walk);
        assert!(raw.contains_key("terminal.open") && raw.contains_key("assets.createUrl"));
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        tag: String,
        payload: Value,
        ok: bool,
        #[serde(default)]
        after: Option<serde_json::Map<String, Value>>,
    }

    /// The cases `tools/limits-diff.mjs` decodes with the T3 contract's own schemas.
    #[test]
    fn cases_agree_with_the_contract() {
        #[derive(Deserialize)]
        struct Cases {
            cases: Vec<Case>,
        }
        let Cases { cases } =
            serde_json::from_str(include_str!("../tools/limits-cases.json")).expect("cases parse");
        assert!(cases.len() > 30);
        for mut case in cases {
            let result = check(&case.tag, &mut case.payload);
            assert_eq!(result.is_ok(), case.ok, "{}: {result:?}", case.name);
            for (key, expected) in case.after.iter().flatten() {
                assert_eq!(
                    &case.payload[key], expected,
                    "{}: `{key}` after the check",
                    case.name
                );
            }
        }
    }

    #[test]
    fn the_failure_names_the_limit_and_the_path() {
        let problem = |tag: &str, mut payload: Value| {
            table()
                .get(tag)
                .and_then(|l| l.problem(&mut payload, &mut Vec::new()))
        };
        let long = json!({ "resource": { "_tag": "workspace-file", "threadId": "t", "path": "a".repeat(1025) } });
        let text = problem("assets.createUrl", long).expect("over the limit");
        assert_eq!(
            text,
            r#"expected a value with a length of at most 1024, got 1025 at ["resource"]["path"]"#
        );
        let env = json!({ "threadId": "t", "terminalId": "d", "cwd": "/", "env": { "A": "v".repeat(8193) } });
        let text = problem("terminal.open", env).expect("over the limit");
        assert!(text.ends_with(r#"at ["env"]["A"]"#), "{text}");
        let mut over =
            json!({ "resource": { "_tag": "attachment", "attachmentId": "a".repeat(257) } });
        assert!(matches!(
            check("assets.createUrl", &mut over),
            Err(Failure::Die(_))
        ));
    }

    #[test]
    fn a_method_without_limits_passes_and_wrong_types_are_left_to_decode() {
        assert!(check("server.probe", &mut json!({ "x": "y".repeat(100_000) })).is_ok());
        assert!(check("terminal.open", &mut json!({ "cols": "wide", "env": 3 })).is_ok());
    }
}
