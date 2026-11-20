//! Generated schema rules shared by RPC payload limits and MCP input decoding.

use std::{collections::HashMap, sync::Arc};

use regex_automata::meta::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Rule {
    // RPC leaves type checking to contract decode; MCP supplies a kind and decodes here.
    kind: Option<String>,
    expected: String,
    optional: bool,
    null_as_omitted: bool,
    trim: bool,
    from_record: bool,
    literal: Value,
    fields: Vec<Field>,
    keys: Option<Box<Rule>>,
    values: Option<Box<Rule>>,
    items: Option<Box<Rule>>,
    members: Vec<Rule>,
    variants: HashMap<String, Rule>,
    discriminator: Option<String>,
    checks: Vec<Check>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Field {
    key: String,
    rule: Rule,
}

#[derive(Debug, Deserialize)]
struct Check {
    expected: String,
    #[serde(flatten)]
    test: Test,
    #[serde(skip)]
    pattern: Option<Arc<Pattern>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "id", rename_all_fields = "camelCase")]
enum Test {
    #[serde(rename = "nonBlank")]
    NonBlank,
    #[serde(rename = "isTrimmed")]
    Trimmed,
    #[serde(rename = "isMinLength")]
    MinLength { min_length: usize },
    #[serde(rename = "isMaxLength")]
    MaxLength { max_length: usize },
    #[serde(rename = "isMaxProperties")]
    MaxProperties { max_properties: usize },
    #[serde(rename = "isInt")]
    Int,
    #[serde(rename = "isGreaterThanOrEqualTo")]
    Minimum { minimum: f64 },
    #[serde(rename = "isLessThanOrEqualTo")]
    Maximum { maximum: f64 },
    #[serde(rename = "isBetween")]
    Between { minimum: f64, maximum: f64 },
    #[serde(rename = "isPattern")]
    Pattern { source: String, flags: String },
    #[serde(rename = "maxArea")]
    MaxArea { max_area: u64 },
}

/// A schema failure before the caller applies its wire error format.
#[derive(Debug)]
pub struct Problem {
    pub expected: Option<String>,
    pub path: String,
}

impl Problem {
    fn expected(expected: String, path: &str) -> Self {
        Self {
            expected: Some(expected),
            path: path.to_owned(),
        }
    }
}

/// A fixed generated table; only its patterns are compiled and retained.
#[derive(Debug)]
pub struct Rules(HashMap<String, Rule>);

impl Rules {
    /// Parses generated rules and compiles every pattern, failing on invalid generated data.
    pub fn parse(source: &str) -> Result<Self, String> {
        let mut rules: HashMap<String, Rule> =
            serde_json::from_str(source).map_err(|e| e.to_string())?;
        fn compile(
            rule: &mut Rule,
            patterns: &mut HashMap<(String, String), Arc<Pattern>>,
        ) -> Result<(), String> {
            for check in &mut rule.checks {
                if let Test::Pattern { source, flags } = &check.test {
                    let key = (source.clone(), flags.clone());
                    let pattern = if let Some(pattern) = patterns.get(&key) {
                        Arc::clone(pattern)
                    } else {
                        let pattern = Arc::new(Pattern::compile(source, flags)?);
                        patterns.insert(key, Arc::clone(&pattern));
                        pattern
                    };
                    check.pattern = Some(pattern);
                }
            }
            for field in &mut rule.fields {
                compile(&mut field.rule, patterns)?;
            }
            for child in rule
                .keys
                .iter_mut()
                .chain(rule.values.iter_mut())
                .chain(rule.items.iter_mut())
            {
                compile(child, patterns)?;
            }
            for child in rule.members.iter_mut().chain(rule.variants.values_mut()) {
                compile(child, patterns)?;
            }
            Ok(())
        }
        let mut patterns = HashMap::new();
        for rule in rules.values_mut() {
            compile(rule, &mut patterns)?;
        }
        Ok(Self(rules))
    }

    /// Normalizes and checks a value. Names absent from the generated table pass unchanged.
    pub fn check(&self, name: &str, value: &mut Value) -> Result<(), Problem> {
        match self.0.get(name) {
            Some(rule) => rule.decode(value, ""),
            None => Ok(()),
        }
    }
}

impl Rule {
    fn fits(&self, value: &Value) -> bool {
        match self.kind.as_deref() {
            None | Some("Unknown") => true,
            Some("String") => value.is_string(),
            Some("Number") => value.is_number(),
            Some("Boolean") => value.is_boolean(),
            // JSON numbers compare as JavaScript numbers: `1.0` is the literal `1`.
            Some("Literal") => match (self.literal.as_f64(), value.as_f64()) {
                (Some(literal), Some(number)) => literal == number,
                _ => self.literal == *value,
            },
            Some("Null") => value.is_null(),
            Some("Arrays") => value.is_array() || (self.from_record && value.is_object()),
            Some("Objects") => {
                value.is_object()
                    && self
                        .fields
                        .iter()
                        .filter(|f| matches!(f.key.as_str(), "type" | "_tag"))
                        .all(|f| value.get(&f.key).is_none_or(|v| f.rule.fits(v)))
            }
            Some("Union") => self.members.iter().any(|m| m.fits(value)),
            _ => false,
        }
    }

    fn decode(&self, value: &mut Value, path: &str) -> Result<(), Problem> {
        if self.kind.as_deref() == Some("Unknown") {
            return Ok(());
        }
        if self.kind.as_deref() == Some("Union") {
            let mut first_error = None;
            for member in self.members.iter().filter(|m| m.fits(value)) {
                let mut candidate = value.clone();
                match member.decode(&mut candidate, path) {
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
            return Err(
                first_error.unwrap_or_else(|| Problem::expected(self.expected.clone(), path))
            );
        }
        if !self.fits(value) {
            return Err(Problem::expected(self.expected.clone(), path));
        }
        if let Some(tag) = value
            .get(self.discriminator.as_deref().unwrap_or("_tag"))
            .and_then(Value::as_str)
            && let Some(variant) = self.variants.get(tag)
        {
            return variant.decode(value, path);
        }
        if self.trim
            && let Some(text) = value.as_str()
        {
            let trimmed = crate::text::js_trim(text);
            if trimmed.len() != text.len() {
                *value = json!(trimmed);
            }
        }
        if self.from_record
            && let Some(map) = value.as_object()
        {
            *value = Value::Array(
                map.iter()
                    .map(|(id, value)| json!({"id":id,"value":value}))
                    .collect(),
            );
        }
        // RPC checks array bounds before visiting items; MCP checks the decoded items first.
        if self.kind.is_none() && value.is_array() {
            self.checks(value, path)?;
        }
        if let Some(object) = value.as_object_mut() {
            for Field { key, rule } in &self.fields {
                if rule.optional
                    && (!object.contains_key(key)
                        || (rule.null_as_omitted && object.get(key).is_some_and(Value::is_null)))
                {
                    object.remove(key);
                    continue;
                }
                let at = format!("{path}[{}]", json!(key));
                match object.get_mut(key) {
                    Some(value) => rule.decode(value, &at)?,
                    None if self.kind.is_some() => {
                        return Err(Problem {
                            expected: None,
                            path: at,
                        });
                    }
                    None => {}
                }
            }
        }
        if value.is_object() {
            for check in self
                .checks
                .iter()
                .filter(|c| matches!(c.test, Test::MaxArea { .. }))
            {
                check.validate(value, path, self.kind.is_none())?;
            }
        }
        if let Some(object) = value.as_object_mut() {
            if let Some(keys) = &self.keys {
                object.retain(|key, _| keys.checks(&json!(key), "").is_ok());
            }
            if let Some(rule) = &self.values {
                for (key, value) in object.iter_mut() {
                    rule.decode(value, &format!("{path}[{}]", json!(key)))?;
                }
            } else if self.kind.is_some() {
                object.retain(|key, _| self.fields.iter().any(|f| f.key == *key));
            }
        }
        if let (Some(values), Some(rule)) = (value.as_array_mut(), &self.items) {
            for (index, value) in values.iter_mut().enumerate() {
                let step = if self.kind.is_none() {
                    json!(index.to_string())
                } else {
                    json!(index)
                };
                rule.decode(value, &format!("{path}[{step}]"))?;
            }
        }
        if self.kind.is_some() || !value.is_array() {
            self.checks(value, path)?;
        }
        Ok(())
    }

    fn checks(&self, value: &Value, path: &str) -> Result<(), Problem> {
        for check in self
            .checks
            .iter()
            .filter(|c| !matches!(c.test, Test::MaxArea { .. }))
        {
            check.validate(value, path, self.kind.is_none())?;
        }
        Ok(())
    }
}

impl Check {
    fn validate(&self, value: &Value, path: &str, limits_only: bool) -> Result<(), Problem> {
        let length = value
            .as_str()
            .map(|s| s.encode_utf16().count())
            .or_else(|| value.as_array().map(Vec::len));
        let number = value.as_f64();
        let valid = match &self.test {
            Test::NonBlank => value.as_str().is_none_or(|s| {
                if limits_only {
                    !s.is_empty()
                } else {
                    !crate::text::js_trim(s).is_empty()
                }
            }),
            Test::Trimmed => value.as_str().is_some_and(|s| s == crate::text::js_trim(s)),
            Test::MinLength { min_length } => length.is_none_or(|n| n >= *min_length),
            Test::MaxLength { max_length } => length.is_none_or(|n| n <= *max_length),
            Test::MaxProperties { max_properties } => {
                value.as_object().is_none_or(|v| v.len() <= *max_properties)
            }
            Test::Int => number.is_none_or(|n| n.fract() == 0.0),
            Test::Minimum { minimum } => number.is_none_or(|n| n >= *minimum),
            Test::Maximum { maximum } => number.is_none_or(|n| n <= *maximum),
            Test::Between { minimum, maximum } => {
                number.is_none_or(|n| n >= *minimum && n <= *maximum)
            }
            Test::Pattern { .. } => value
                .as_str()
                .is_none_or(|s| self.pattern.as_ref().is_some_and(|p| p.is_match(s))),
            Test::MaxArea { max_area } => value
                .get("width")
                .and_then(Value::as_u64)
                .zip(value.get("height").and_then(Value::as_u64))
                .is_none_or(|(w, h)| w.saturating_mul(h) <= *max_area),
        };
        if valid {
            return Ok(());
        }
        let expected = if limits_only {
            self.expected.replace(
                "{length}",
                &length
                    .or_else(|| value.as_object().map(serde_json::Map::len))
                    .unwrap_or(0)
                    .to_string(),
            )
        } else {
            self.expected.clone()
        };
        Err(Problem::expected(expected, path))
    }
}

#[derive(Debug)]
struct Pattern {
    allow: Regex,
    deny: Option<Regex>,
}

impl Pattern {
    fn compile(source: &str, flags: &str) -> Result<Self, String> {
        let source = source.replace("\\/", "/");
        let flags = flags.replace('u', "");
        let prefix = if flags.is_empty() {
            String::new()
        } else {
            format!("(?{flags})")
        };
        let compile = |s: &str| {
            Regex::new(&format!("{prefix}{s}"))
                .map_err(|e| format!("Invalid generated pattern: {e}"))
        };
        // Rust has no lookaround; T3 theme ids use a leading negative lookahead.
        if let Some(rest) = source.strip_prefix("^(?!")
            && let Some(end) = group_end(rest)
        {
            let negated = rest.get(..end).unwrap_or_default();
            let after = rest.get(end + 1..).unwrap_or_default();
            return Ok(Self {
                allow: compile(&format!("^{after}"))?,
                deny: Some(compile(&format!("^(?:{negated})"))?),
            });
        }
        Ok(Self {
            allow: compile(&source)?,
            deny: None,
        })
    }

    fn is_match(&self, text: &str) -> bool {
        self.allow.is_match(text) && !self.deny.as_ref().is_some_and(|deny| deny.is_match(text))
    }
}

fn group_end(source: &str) -> Option<usize> {
    let (mut depth, mut escaped, mut class) = (1usize, false, false);
    for (index, c) in source.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '[' if !class => class = true,
            ']' if class => class = false,
            '(' if !class => depth += 1,
            ')' if !class => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leading_negative_lookahead_refuses_what_it_names() {
        let pattern = Pattern::compile(
            "^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$",
            "",
        )
        .unwrap();
        for ok in ["ocean", "dark-blue", "lightning", "s"] {
            assert!(pattern.is_match(ok), "{ok}");
        }
        for refused in ["system", "light", "dark", "Dark", "-x", ""] {
            assert!(!pattern.is_match(refused), "{refused}");
        }
        let flagged = Pattern::compile("^(?!dark$)[a-z]+$", "i").unwrap();
        assert!(flagged.is_match("OCEAN"));
        assert!(!flagged.is_match("DARK"));
        assert!(
            Pattern::compile("^a\\/b.$", "imsu")
                .unwrap()
                .is_match("A/b\n")
        );
    }

    #[test]
    fn normalization_and_utf16_checks_share_the_rule_format() {
        let check = json!({"id":"isMaxLength","maxLength":2,"expected":"two units"});
        let rules = Rules::parse(
            &json!({
                "rpc":{"trim":true,"checks":[check]},
                "mcp":{"kind":"String","trim":true,"checks":[check]}
            })
            .to_string(),
        )
        .unwrap();
        for name in ["rpc", "mcp"] {
            let mut value = json!("\u{feff} 😀 \u{feff}");
            assert!(rules.check(name, &mut value).is_ok());
            assert_eq!(value, json!("😀"));
            let error = rules.check(name, &mut json!("😀x")).unwrap_err();
            assert_eq!(error.expected.as_deref(), Some("two units"));
        }
        assert!(rules.check("rpc", &mut json!(false)).is_ok());
        assert!(rules.check("mcp", &mut json!(false)).is_err());
    }

    #[test]
    fn a_number_literal_matches_every_spelling_of_its_value() {
        let rules = Rules::parse(
            &json!({"version":{"kind":"Literal","expected":"1","literal":1,"checks":[]}})
                .to_string(),
        )
        .unwrap();
        let mut spelled: Value = serde_json::from_str("1.0").unwrap();
        assert!(rules.check("version", &mut spelled).is_ok());
        assert!(rules.check("version", &mut json!(1)).is_ok());
        assert!(rules.check("version", &mut json!(2)).is_err());
        assert!(rules.check("version", &mut json!("1")).is_err());
    }
}
