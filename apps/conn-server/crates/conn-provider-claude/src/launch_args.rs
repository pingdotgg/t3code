//! The instance's `launchArgs`, as `makeClaudeQueryOptions` applies them
//! (`ClaudeAdapterV2.ts` 2023-2259, `parseCliArgs` and `tokenizeCliArgs` in
//! `packages/shared/src/cliArgs.ts`, `claudeLaunchArgDirectories` in `ClaudeSkills.ts`).
//!
//! Six flags are taken out: `--add-dir` (every value, to `additionalDirectories`),
//! `--permission-mode`, `--dangerously-skip-permissions`, `--append-system-prompt` and
//! `--append-system-prompt-file` (to the system prompt's `append`), and `--settings` (inline
//! JSON or a file, beneath T3's own settings). Every other flag goes to the SDK's `extraArgs`
//! in the order T3's object holds it: first appearance, last value.
//!
//! The order of keys reaches the CLI as bytes (`--settings` text, argv), and `serde_json`
//! sorts keys, so the values here keep their order ([`Json`]) and are written with
//! [`crate::ordered::raw`].

use std::fmt::Write as _;
use std::path::PathBuf;

use conn_provider_support::instance::expand_home;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// `parseCliArgs(...).flags`: name and value (`None`: no value), in a JavaScript object's
/// order (a repeated flag keeps its first place and takes the last value).
pub fn parse_flags(args: &str) -> Vec<(String, Option<String>)> {
    let tokens = crate::launch_args::tokenize(args);
    let mut flags: Vec<(String, Option<String>)> = Vec::new();
    let mut set = |name: &str, value: Option<String>| {
        if let Some(slot) = flags.iter_mut().find(|(k, _)| k == name) {
            slot.1 = value;
        } else {
            flags.push((name.to_owned(), value));
        }
    };
    let mut i = 0;
    while let Some(token) = tokens.get(i) {
        if token == "--" {
            break;
        }
        if let Some(rest) = token.strip_prefix("--") {
            if let Some((name, value)) = rest.split_once('=') {
                set(name, Some(value.to_owned()));
            } else {
                match tokens.get(i + 1) {
                    Some(next) if !next.starts_with("--") => {
                        set(rest, Some(next.clone()));
                        i += 1;
                    }
                    _ => set(rest, None),
                }
            }
        }
        i += 1;
    }
    flags
}

/// `tokenizeCliArgs`.
pub fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
                quoted = true;
            } else if c == '\\' && q == '"' {
                match chars.peek() {
                    Some(&n) if matches!(n, '"' | '\\' | '$' | '`') => {
                        current.push(n);
                        chars.next();
                    }
                    _ => current.push(c),
                }
            } else {
                current.push(c);
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            quoted = true;
        } else if c.is_whitespace() {
            if !current.is_empty() || quoted {
                tokens.push(std::mem::take(&mut current));
                quoted = false;
            }
        } else if c == '\\' {
            match chars.peek() {
                Some(&n) if n.is_whitespace() || n == '\'' || n == '"' => {
                    current.push(n);
                    chars.next();
                }
                _ => current.push(c),
            }
        } else {
            current.push(c);
        }
    }
    if !current.is_empty() || quoted {
        tokens.push(current);
    }
    tokens
}

/// `claudeLaunchArgDirectories`: every `--add-dir` value (repeatable and variadic).
pub fn add_dirs(args: &str) -> Vec<String> {
    let mut dirs = Vec::new();
    let mut collecting = false;
    for token in tokenize(args) {
        if token == "--" {
            break;
        }
        if token == "--add-dir" {
            collecting = true;
        } else if let Some(dir) = token.strip_prefix("--add-dir=") {
            dirs.push(dir.to_owned());
            collecting = false;
        } else if token.starts_with('-') {
            collecting = false;
        } else if collecting {
            dirs.push(token);
        }
    }
    dirs
}

/// The flags `makeClaudeQueryOptions` takes out of `extraArgs`.
const TAKEN: [&str; 6] = [
    "add-dir",
    "permission-mode",
    "dangerously-skip-permissions",
    "append-system-prompt",
    "append-system-prompt-file",
    "settings",
];

/// What the launch arguments give one query.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Applied {
    /// `extraArgs` before T3 adds `thinking-display`.
    pub extra_args: Vec<(String, Option<String>)>,
    /// `--permission-mode` with a value.
    pub permission_mode: Option<String>,
    /// `--dangerously-skip-permissions` with no value or `true`.
    pub skip_permissions: bool,
    /// File text (one trailing newline trimmed), then the inline text; empty ones left out.
    pub append: Vec<String>,
    /// `--settings`, read as a JSON object, keys in order.
    pub settings: Option<Vec<(String, Json)>>,
    /// `--add-dir` values, after the cwd and the attachments folder.
    pub add_dirs: Vec<String>,
}

/// Applies `args` for a query in `cwd`. Reads the append and settings files: blocking, call it
/// off the runtime thread. A value the CLI would refuse is an error, as in T3 (these flags
/// never reach the CLI, so it cannot refuse them itself).
pub fn apply(args: &str, cwd: Option<&str>) -> Result<Applied, String> {
    if args.is_empty() {
        return Ok(Applied::default());
    }
    let flags = parse_flags(args);
    let flag = |name: &str| {
        flags
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    let mut applied = Applied {
        extra_args: flags
            .iter()
            .filter(|(k, _)| !TAKEN.contains(&k.as_str()))
            .cloned()
            .collect(),
        permission_mode: flag("permission-mode").flatten(),
        skip_permissions: match flag("dangerously-skip-permissions") {
            Some(None) => true,
            Some(Some(v)) => v == "true",
            None => false,
        },
        add_dirs: add_dirs(args),
        ..Applied::default()
    };
    // `readClaudeAppendSystemPromptFile`.
    if flag("append-system-prompt") == Some(None) {
        return Err(missing_value("--append-system-prompt"));
    }
    let file_text = match flag("append-system-prompt-file") {
        None => None,
        Some(None) => return Err(missing_value("--append-system-prompt-file")),
        Some(Some(file)) if file.is_empty() => {
            return Err(missing_value("--append-system-prompt-file"));
        }
        Some(Some(file)) => {
            let path = resolve(cwd, &file);
            Some(std::fs::read_to_string(&path).map_err(|e| {
                format!(
                    "Could not read the --append-system-prompt-file file {}: {e}",
                    path.display()
                )
            })?)
        }
    };
    if let Some(text) = file_text {
        let text = text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(&text)
            .to_owned();
        if !text.is_empty() {
            applied.append.push(text);
        }
    }
    if let Some(Some(text)) = flag("append-system-prompt")
        && !text.is_empty()
    {
        applied.append.push(text);
    }
    // `readClaudeLaunchArgSettings`.
    if let Some(value) = flag("settings") {
        let trimmed = value.as_deref().map(str::trim).unwrap_or_default();
        if trimmed.is_empty() {
            return Err("The --settings launch argument needs a value.".into());
        }
        let (text, path) = if trimmed.starts_with('{') {
            (trimmed.to_owned(), None)
        } else {
            let path = resolve(cwd, trimmed);
            let text = std::fs::read_to_string(&path).map_err(|e| {
                format!("Could not read the --settings file {}: {e}", path.display())
            })?;
            (text, Some(path))
        };
        // Never the text itself in an error: it may hold a secret.
        let failed = || match &path {
            Some(path) => format!(
                "The --settings file {} is not a JSON object.",
                path.display()
            ),
            None => "The --settings launch argument is not a JSON object.".to_owned(),
        };
        match parse_lenient(&text) {
            Some(Json::Object(entries)) => applied.settings = Some(entries),
            _ => return Err(failed()),
        }
    }
    Ok(applied)
}

fn missing_value(flag: &str) -> String {
    format!("The {flag} launch argument needs a value.")
}

/// `path.resolve(cwd ?? ".", expandHomePath(value))`.
fn resolve(cwd: Option<&str>, value: &str) -> PathBuf {
    let expanded = PathBuf::from(expand_home(value));
    if expanded.is_absolute() {
        return expanded;
    }
    let base = cwd.map_or_else(
        || std::env::current_dir().unwrap_or_default(),
        PathBuf::from,
    );
    crate::launch::absolute(&base.join(expanded).to_string_lossy())
}

/// A JSON value that keeps the order of object keys.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// JSON text as `JSON.stringify` writes it.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Number(n) => {
                // `JSON.stringify(1.0)` is `1`.
                match n.as_f64() {
                    Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9.0e15 => {
                        let _ = write!(out, "{}", f as i64);
                    }
                    _ => {
                        let _ = write!(out, "{n}");
                    }
                }
            }
            Self::String(s) => out.push_str(&serde_json::Value::String(s.clone()).to_string()),
            Self::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Self::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::Value::String(key.clone()).to_string());
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }

    /// From a `serde_json` value (its keys come sorted).
    pub fn from_value(value: &serde_json::Value) -> Self {
        use serde_json::Value;
        match value {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(*b),
            Value::Number(n) => Self::Number(n.clone()),
            Value::String(s) => Self::String(s.clone()),
            Value::Array(items) => Self::Array(items.iter().map(Self::from_value).collect()),
            Value::Object(map) => Self::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), Self::from_value(v)))
                    .collect(),
            ),
        }
    }
}

/// Sets `key` in an ordered object: in place when present (as a spread keeps a key's first
/// place), else at the end.
pub fn set(entries: &mut Vec<(String, Json)>, key: &str, value: Json) {
    if let Some(slot) = entries.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    } else {
        entries.push((key.to_owned(), value));
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_i64<E>(self, n: i64) -> Result<Json, E> {
                Ok(Json::Number(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<Json, E> {
                Ok(Json::Number(n.into()))
            }
            fn visit_f64<E>(self, n: f64) -> Result<Json, E> {
                Ok(serde_json::Number::from_f64(n).map_or(Json::Null, Json::Number))
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::String(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut entries: Vec<(String, Json)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    // `JSON.parse` keeps the last value of a repeated key in its first place.
                    set(&mut entries, &key, value);
                }
                Ok(Json::Object(entries))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// `fromLenientJson`: comments and trailing commas outside strings are dropped first.
pub fn parse_lenient(text: &str) -> Option<Json> {
    serde_json::from_str(&strip_lenient(text)).ok()
}

fn strip_lenient(input: &str) -> String {
    // Comments become a space; strings stay as they are.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                let mut escaped = false;
                for s in chars.by_ref() {
                    out.push(s);
                    if escaped {
                        escaped = false;
                    } else if s == '\\' {
                        escaped = true;
                    } else if s == '"' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                while chars.peek().is_some_and(|&n| n != '\r' && n != '\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                let mut closed = false;
                for s in chars.by_ref() {
                    if prev == '*' && s == '/' {
                        closed = true;
                        break;
                    }
                    prev = s;
                }
                if closed {
                    out.push(' ');
                } else {
                    // An unclosed block is no comment to the regex: keep it, so the parse fails.
                    out.push_str("/*");
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas before `}` or `]`, outside strings.
    let mut result = String::with_capacity(out.len());
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            result.push(c);
            let mut escaped = false;
            for s in chars.by_ref() {
                result.push(s);
                if escaped {
                    escaped = false;
                } else if s == '\\' {
                    escaped = true;
                } else if s == '"' {
                    break;
                }
            }
        } else if c == ',' {
            let rest: String = chars.clone().collect();
            let next = rest.trim_start().chars().next();
            if !matches!(next, Some('}' | ']')) {
                result.push(c);
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_follow_parse_cli_args() {
        let flags = parse_flags("--model x --verbose --model=y -p --debug api --x=1 -- --late");
        assert_eq!(
            flags,
            [
                ("model".to_owned(), Some("y".to_owned())),
                ("verbose".to_owned(), None),
                ("debug".to_owned(), Some("api".to_owned())),
                ("x".to_owned(), Some("1".to_owned())),
            ]
        );
        assert_eq!(
            add_dirs("--add-dir a b --add-dir=c -v d --add-dir e"),
            ["a", "b", "c", "e"]
        );
    }

    #[test]
    fn takes_t3s_flags_out() {
        let applied = apply(
            r#"--verbose --permission-mode plan --append-system-prompt "be brief" --add-dir /x --settings '{"b":1, /* c */ "a":{"z":2,"y":3},}' --debug"#,
            Some("/tmp"),
        )
        .unwrap();
        assert_eq!(
            applied.extra_args,
            [("verbose".to_owned(), None), ("debug".to_owned(), None)]
        );
        assert_eq!(applied.permission_mode.as_deref(), Some("plan"));
        assert_eq!(applied.append, ["be brief"]);
        assert_eq!(applied.add_dirs, ["/x"]);
        let settings = Json::Object(applied.settings.unwrap());
        assert_eq!(settings.to_text(), r#"{"b":1,"a":{"z":2,"y":3}}"#);
        assert!(apply("--append-system-prompt", None).is_err());
        assert!(apply("--settings ''", None).is_err());
        let secret = apply("--settings '{\"key\": \"sk-secret\"'", None).unwrap_err();
        assert!(!secret.contains("sk-secret"), "{secret}");
        assert!(
            apply("--dangerously-skip-permissions", None)
                .unwrap()
                .skip_permissions
        );
    }
}
