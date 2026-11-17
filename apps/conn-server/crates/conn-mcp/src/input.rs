//! Decode-time rules generated from T3's schemas, including nested checks and trim transforms.

use std::sync::OnceLock;

use conn_support::input::Rules;
use serde_json::Value;

use crate::tools::Args;

const RULES: &str = include_str!("thread-inputs.json");

fn compiled() -> Result<&'static Rules, String> {
    static COMPILED: OnceLock<Result<Rules, String>> = OnceLock::new();
    COMPILED
        .get_or_init(|| Rules::parse(RULES))
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn check(name: &str, args: &mut Args) -> Result<(), String> {
    let rules = compiled()?;
    let mut value = Value::Object(std::mem::take(args));
    let result = rules.check(name, &mut value).map_err(|error| {
        let mut text = error.expected.map_or_else(
            || "Missing key".to_owned(),
            |expected| format!("Expected {expected}"),
        );
        if !error.path.is_empty() {
            text.push_str(&format!("\n  at {}", error.path));
        }
        text
    });
    if let Value::Object(decoded) = value {
        *args = decoded;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
    #[test]
    fn every_generated_rule_compiles() {
        assert!(
            super::compiled().is_ok(),
            "generated input patterns must compile"
        );
    }
}
