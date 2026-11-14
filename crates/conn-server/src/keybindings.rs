//! `keybindings.json`, as `apps/server/src/keybindings.ts` keeps it: a JSON array of
//! `{key, command, when?}` rules, seeded with the defaults on first start and backfilled with
//! defaults added later. Clients get the rules compiled (`ResolvedKeybindingRule`): the key
//! parsed into a shortcut, `when` parsed into an expression tree, defaults whose command the
//! file overrides left out.
//!
//! The defaults come from `keybindings.defaults.json`, generated from `packages/shared` by
//! `tools/gen-keybindings.mjs`. The parser follows `packages/shared/src/keybindings.ts`.

use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

use conn_support::fs::write_atomic;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, serde::Serialize)]
pub struct Rule {
    pub key: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Deserialize)]
struct LateDefault {
    id: String,
    alongside: Rule,
    rule: Rule,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Defaults {
    max_count: usize,
    max_when_depth: usize,
    defaults: Vec<Rule>,
    late: Vec<LateDefault>,
}

fn defaults() -> &'static Defaults {
    static DEFAULTS: OnceLock<Defaults> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        serde_json::from_str(include_str!("../keybindings.defaults.json"))
            .expect("keybindings.defaults.json is valid")
    })
}

/// `ServerUpsertKeybindingResult`: the compiled rules and the problems found in the file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub keybindings: Vec<Value>,
    pub issues: Vec<Value>,
}

impl Snapshot {
    pub fn to_json(&self) -> Value {
        json!({ "keybindings": self.keybindings, "issues": self.issues })
    }
}

pub struct KeybindingsStore {
    path: PathBuf,
    snapshot: Mutex<Snapshot>,
    revision: watch::Sender<u64>,
}

impl std::fmt::Debug for KeybindingsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeybindingsStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl KeybindingsStore {
    /// Seeds or backfills the file with the defaults, then loads it.
    pub fn open(path: PathBuf) -> Self {
        if let Err(error) = sync_defaults(&path) {
            eprintln!(
                "conn-server: could not sync default keybindings into {}: {error}",
                path.display()
            );
        }
        let snapshot = load(&path);
        Self {
            path,
            snapshot: Mutex::new(snapshot),
            revision: watch::Sender::new(0),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.revision.subscribe()
    }

    /// `server.upsertKeybinding`: replaces the same rule (or `replace`), appends the new one.
    pub fn upsert(&self, input: Value) -> Result<Snapshot, Value> {
        let rule = rule_from(&input).ok_or_else(|| self.error("invalid keybinding rule"))?;
        if compile(&rule).is_none() {
            return Err(self.error("invalid keybinding rule"));
        }
        let replace = input.get("replace").and_then(rule_from);
        self.rewrite(|entries| {
            entries.retain(|entry| {
                let Some(existing) = entry_rule(entry) else {
                    return true;
                };
                !same_rule(&existing, &rule)
                    && !replace.as_ref().is_some_and(|r| same_rule(&existing, r))
            });
            entries.push(serde_json::to_value(&rule).expect("rule serializes"));
            let max = defaults().max_count;
            if entries.len() > max {
                entries.drain(..entries.len() - max);
            }
        })
    }

    /// `server.removeKeybinding`.
    pub fn remove(&self, input: Value) -> Result<Snapshot, Value> {
        let target = rule_from(&input).ok_or_else(|| self.error("invalid keybinding rule"))?;
        self.rewrite(|entries| {
            entries.retain(|entry| !entry_rule(entry).is_some_and(|r| same_rule(&r, &target)));
        })
    }

    /// Edits the raw entries (keeping ones this build cannot read), saves, reloads, notifies.
    fn rewrite(&self, edit: impl FnOnce(&mut Vec<Value>)) -> Result<Snapshot, Value> {
        let mut snapshot = self.lock();
        let mut entries = match read_entries(&self.path) {
            Ok(entries) => entries.unwrap_or_default(),
            Err(_) => return Err(self.error("expected JSON array")),
        };
        edit(&mut entries);
        write_entries(&self.path, &entries)
            .map_err(|_| self.error("failed to write keybindings config"))?;
        *snapshot = load(&self.path);
        let result = snapshot.clone();
        drop(snapshot);
        self.revision.send_modify(|r| *r += 1);
        Ok(result)
    }

    /// `KeybindingsConfigError`.
    fn error(&self, detail: &str) -> Value {
        json!({
            "_tag": "KeybindingsConfigError",
            "configPath": self.path.display().to_string(),
            "detail": detail,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Snapshot> {
        crate::lock(&self.snapshot)
    }
}

fn rule_from(value: &Value) -> Option<Rule> {
    let key = value.get("key")?.as_str()?.trim();
    let command = value.get("command")?.as_str()?.trim();
    if key.is_empty() || key.len() > 64 || command.is_empty() {
        return None;
    }
    let when = match value.get("when") {
        None | Some(Value::Null) => None,
        Some(Value::String(when)) if !when.trim().is_empty() => Some(when.trim().to_owned()),
        Some(_) => return None,
    };
    Some(Rule {
        key: key.to_owned(),
        command: command.to_owned(),
        when,
    })
}

/// A file entry this build understands, or `None` (kept as it is on write).
fn entry_rule(entry: &Value) -> Option<Rule> {
    rule_from(entry).filter(|rule| compile(rule).is_some())
}

/// `keybindingRuleIdentity`: same command, same parsed shortcut, same parsed condition.
fn same_rule(left: &Rule, right: &Rule) -> bool {
    identity(left) == identity(right)
}

fn identity(rule: &Rule) -> (String, Value, Value) {
    let shortcut = parse_shortcut(&rule.key).unwrap_or_else(|| json!(rule.key));
    let when = match &rule.when {
        Some(when) => parse_when(when).unwrap_or_else(|| json!(when)),
        None => Value::Null,
    };
    (rule.command.clone(), shortcut, when)
}

/// Shortcut and condition, for spotting a default that would collide with a custom rule.
fn shortcut_context(rule: &Rule) -> Option<(Value, Option<String>)> {
    Some((parse_shortcut(&rule.key)?, rule.when.clone()))
}

/// `Ok(None)` when the file does not exist.
fn read_entries(path: &Path) -> io::Result<Option<Vec<Value>>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(Value::Array(entries)) => Ok(Some(entries)),
            Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidData, "not an array")),
            Err(error) => Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn write_entries(path: &Path, entries: &[Value]) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(entries).expect("entries serialize");
    text.push('\n');
    write_atomic(path, text.as_bytes(), 0o644)
}

fn migrations_path(path: &Path) -> PathBuf {
    path.with_file_name("keybindings-migrations")
}

/// `syncDefaultKeybindingsOnStartup`.
fn sync_defaults(path: &Path) -> io::Result<()> {
    let data = defaults();
    let migrations_file = migrations_path(path);
    let applied: HashSet<String> = fs::read_to_string(&migrations_file)
        .map(|text| {
            text.lines()
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let pending: Vec<&LateDefault> = data
        .late
        .iter()
        .filter(|l| !applied.contains(&l.id))
        .collect();
    let record = |ids: Vec<String>| -> io::Result<()> {
        let mut all: Vec<String> = applied.iter().cloned().collect();
        all.sort();
        for id in ids {
            if !all.contains(&id) {
                all.push(id);
            }
        }
        write_atomic(
            &migrations_file,
            format!("{}\n", all.join("\n")).as_bytes(),
            0o644,
        )
    };

    let Some(entries) = read_entries(path)? else {
        let rules: Vec<Value> = data
            .defaults
            .iter()
            .map(|r| serde_json::to_value(r).expect("rule serializes"))
            .collect();
        write_entries(path, &rules)?;
        if !pending.is_empty() {
            record(data.late.iter().map(|l| l.id.clone()).collect())?;
        }
        return Ok(());
    };
    let custom: Vec<Rule> = entries.iter().filter_map(entry_rule).collect();
    if custom.len() != entries.len() {
        // A file with problems is left as it is, as the TypeScript server does.
        return Ok(());
    }
    let commands: HashSet<&str> = custom.iter().map(|r| r.command.as_str()).collect();
    let contexts: Vec<_> = custom.iter().filter_map(shortcut_context).collect();
    let mut missing: Vec<Rule> = data
        .defaults
        .iter()
        .filter(|rule| !commands.contains(rule.command.as_str()))
        .filter(|rule| shortcut_context(rule).is_none_or(|c| !contexts.contains(&c)))
        .cloned()
        .collect();
    for late in &pending {
        let alongside = custom.iter().any(|r| same_rule(r, &late.alongside));
        let taken = shortcut_context(&late.rule).is_some_and(|c| contexts.contains(&c));
        if alongside && !taken {
            missing.push(late.rule.clone());
        }
    }
    let slots = data.max_count.saturating_sub(custom.len());
    let skipped: Vec<Rule> = missing.split_off(slots.min(missing.len()));
    if !missing.is_empty() {
        // Defaults go first so custom rules win overlapping conditions.
        let mut next: Vec<Value> = missing
            .iter()
            .map(|r| serde_json::to_value(r).expect("rule serializes"))
            .collect();
        next.extend(entries);
        write_entries(path, &next)?;
    }
    let settled: Vec<String> = pending
        .iter()
        .filter(|l| !skipped.contains(&l.rule))
        .map(|l| l.id.clone())
        .collect();
    if !settled.is_empty() {
        record(settled)?;
    }
    Ok(())
}

/// `loadConfigStateFromDisk`: the file's rules compiled and merged over the defaults.
fn load(path: &Path) -> Snapshot {
    let entries = match read_entries(path) {
        Ok(entries) => entries.unwrap_or_default(),
        Err(error) => {
            return Snapshot {
                keybindings: merge_with_defaults(Vec::new()),
                issues: vec![json!({
                    "kind": "keybindings.malformed-config",
                    "message": format!("expected JSON array ({error})"),
                })],
            };
        }
    };
    let mut compiled = Vec::new();
    let mut issues = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match rule_from(entry).and_then(|rule| compile(&rule).map(|c| (rule, c))) {
            Some((_, resolved)) => compiled.push(resolved),
            None => issues.push(json!({
                "kind": "keybindings.invalid-entry",
                "index": index,
                "message": "invalid keybinding rule",
            })),
        }
    }
    let max = defaults().max_count;
    if compiled.len() > max {
        compiled.drain(..compiled.len() - max);
    }
    Snapshot {
        keybindings: merge_with_defaults(compiled),
        issues,
    }
}

/// `mergeWithDefaultKeybindings`.
fn merge_with_defaults(custom: Vec<Value>) -> Vec<Value> {
    let defaults: Vec<Value> = defaults().defaults.iter().filter_map(compile).collect();
    if custom.is_empty() {
        return defaults;
    }
    let overridden: HashSet<&str> = custom
        .iter()
        .filter_map(|b| b["command"].as_str())
        .collect();
    let mut merged: Vec<Value> = defaults
        .iter()
        .filter(|b| {
            !b["command"]
                .as_str()
                .is_some_and(|c| overridden.contains(c))
        })
        .cloned()
        .collect();
    merged.extend(custom.iter().cloned());
    let max = self::defaults().max_count;
    if merged.len() > max {
        merged.drain(..merged.len() - max);
    }
    merged
}

/// `compileResolvedKeybindingRule`.
pub fn compile(rule: &Rule) -> Option<Value> {
    let shortcut = parse_shortcut(&rule.key)?;
    match &rule.when {
        Some(when) => Some(json!({
            "command": rule.command,
            "shortcut": shortcut,
            "whenAst": parse_when(when)?,
        })),
        None => Some(json!({ "command": rule.command, "shortcut": shortcut })),
    }
}

/// `parseKeybindingShortcut`.
pub fn parse_shortcut(value: &str) -> Option<Value> {
    let lower = value.to_lowercase();
    let mut tokens: Vec<String> = lower.split('+').map(|t| t.trim().to_owned()).collect();
    let mut trailing_empty = 0;
    while tokens.last().is_some_and(String::is_empty) {
        trailing_empty += 1;
        tokens.pop();
    }
    if trailing_empty > 0 {
        tokens.push("+".into());
    }
    if tokens.is_empty() || tokens.iter().any(String::is_empty) {
        return None;
    }
    let (mut meta, mut ctrl, mut shift, mut alt, mut modifier) =
        (false, false, false, false, false);
    let mut key: Option<String> = None;
    for token in tokens {
        match token.as_str() {
            "cmd" | "meta" => meta = true,
            "ctrl" | "control" => ctrl = true,
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            "mod" => modifier = true,
            _ => {
                if key.is_some() {
                    return None;
                }
                key = Some(match token.as_str() {
                    "space" => " ".into(),
                    "esc" => "escape".into(),
                    _ => token,
                });
            }
        }
    }
    Some(json!({
        "key": key?,
        "metaKey": meta,
        "ctrlKey": ctrl,
        "shiftKey": shift,
        "altKey": alt,
        "modKey": modifier,
    }))
}

#[derive(Debug, PartialEq)]
enum Token {
    And,
    Or,
    Not,
    Open,
    Close,
    Name(String),
}

fn tokenize(expression: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut rest = expression;
    while let Some(c) = rest.chars().next() {
        if c.is_whitespace() {
            rest = &rest[c.len_utf8()..];
        } else if let Some(r) = rest.strip_prefix("&&") {
            tokens.push(Token::And);
            rest = r;
        } else if let Some(r) = rest.strip_prefix("||") {
            tokens.push(Token::Or);
            rest = r;
        } else if c == '!' || c == '(' || c == ')' {
            tokens.push(match c {
                '!' => Token::Not,
                '(' => Token::Open,
                _ => Token::Close,
            });
            rest = &rest[1..];
        } else if c.is_ascii_alphabetic() || c == '_' {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
                .unwrap_or(rest.len());
            tokens.push(Token::Name(rest[..end].to_owned()));
            rest = &rest[end..];
        } else {
            return None;
        }
    }
    Some(tokens)
}

/// `parseKeybindingWhenExpression`: `||` over `&&` over `!`, with parentheses.
pub fn parse_when(expression: &str) -> Option<Value> {
    let tokens = tokenize(expression)?;
    if tokens.is_empty() {
        return None;
    }
    let mut parser = WhenParser {
        tokens: &tokens,
        index: 0,
        max_depth: defaults().max_when_depth,
    };
    let ast = parser.or(0)?;
    (parser.index == tokens.len()).then_some(ast)
}

struct WhenParser<'a> {
    tokens: &'a [Token],
    index: usize,
    max_depth: usize,
}

impl WhenParser<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn primary(&mut self, depth: usize) -> Option<Value> {
        if depth > self.max_depth {
            return None;
        }
        match self.peek()? {
            Token::Name(name) => {
                let node = json!({ "type": "identifier", "name": name });
                self.index += 1;
                Some(node)
            }
            Token::Open => {
                self.index += 1;
                let node = self.or(depth + 1)?;
                if self.peek() != Some(&Token::Close) {
                    return None;
                }
                self.index += 1;
                Some(node)
            }
            _ => None,
        }
    }

    fn unary(&mut self, depth: usize) -> Option<Value> {
        let mut nots = 0;
        while self.peek() == Some(&Token::Not) {
            self.index += 1;
            nots += 1;
            if nots > self.max_depth {
                return None;
            }
        }
        let mut node = self.primary(depth)?;
        for _ in 0..nots {
            node = json!({ "type": "not", "node": node });
        }
        Some(node)
    }

    fn and(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.unary(depth)?;
        while self.peek() == Some(&Token::And) {
            self.index += 1;
            let right = self.unary(depth)?;
            left = json!({ "type": "and", "left": left, "right": right });
        }
        Some(left)
    }

    fn or(&mut self, depth: usize) -> Option<Value> {
        let mut left = self.and(depth)?;
        while self.peek() == Some(&Token::Or) {
            self.index += 1;
            let right = self.and(depth)?;
            left = json!({ "type": "or", "left": left, "right": right });
        }
        Some(left)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("conn-keys-{}", crate::auth::random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        (dir.join("keybindings.json"), dir)
    }

    #[test]
    fn compiles_the_defaults_exactly_as_typescript_does() {
        let expected: Value =
            serde_json::from_str(include_str!("../keybindings.resolved.json")).unwrap();
        let ours: Vec<Value> = defaults().defaults.iter().filter_map(compile).collect();
        assert_eq!(Value::Array(ours), expected);
    }

    #[test]
    fn parses_shortcuts_and_conditions() {
        assert_eq!(
            parse_shortcut("mod+shift++").unwrap(),
            json!({ "key": "+", "metaKey": false, "ctrlKey": false, "shiftKey": true, "altKey": false, "modKey": true })
        );
        assert_eq!(parse_shortcut("Esc").unwrap()["key"], "escape");
        assert!(parse_shortcut("ctrl+a+b").is_none());
        assert!(parse_shortcut("ctrl").is_none());
        assert_eq!(
            parse_when("a || !(b && c.d)").unwrap(),
            json!({ "type": "or", "left": { "type": "identifier", "name": "a" }, "right": { "type": "not", "node": {
                "type": "and", "left": { "type": "identifier", "name": "b" }, "right": { "type": "identifier", "name": "c.d" } } } })
        );
        assert!(parse_when("a &&").is_none());
        assert!(parse_when("(a").is_none());
        assert!(parse_when("a $ b").is_none());
    }

    #[test]
    fn seeds_the_file_and_overrides_defaults_by_command() {
        let (path, dir) = temp_file();
        let store = KeybindingsStore::open(path.clone());
        let seeded: Vec<Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(seeded.len(), defaults().defaults.len());
        assert!(migrations_path(&path).exists());
        let before = store.snapshot();
        assert!(before.issues.is_empty());
        let revision = store.subscribe();

        let after = store
            .upsert(json!({ "key": "mod+shift+y", "command": "sidebar.toggle", "replace": { "key": "mod+b", "command": "sidebar.toggle" } }))
            .unwrap();
        assert!(revision.has_changed().unwrap());
        let toggles: Vec<&Value> = after
            .keybindings
            .iter()
            .filter(|b| b["command"] == "sidebar.toggle")
            .collect();
        assert_eq!(toggles.len(), 1);
        assert_eq!(toggles[0]["shortcut"]["key"], "y");

        let removed = store
            .remove(json!({ "key": "mod+shift+y", "command": "sidebar.toggle" }))
            .unwrap();
        assert!(
            !removed
                .keybindings
                .iter()
                .any(|b| b["command"] == "sidebar.toggle" && b["shortcut"]["key"] == "y")
        );
        assert!(
            store
                .upsert(json!({ "key": "a+b+c", "command": "x" }))
                .is_err()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_unreadable_entries_and_reports_them() {
        let (path, dir) = temp_file();
        fs::write(
            &path,
            r#"[{"key":"mod+k","command":"commandPalette.toggle"},{"key":"","command":"x"}]"#,
        )
        .unwrap();
        let store = KeybindingsStore::open(path.clone());
        let snapshot = store.snapshot();
        assert_eq!(
            snapshot.issues,
            vec![
                json!({ "kind": "keybindings.invalid-entry", "index": 1, "message": "invalid keybinding rule" })
            ]
        );
        store
            .upsert(json!({ "key": "mod+j", "command": "terminal.toggle" }))
            .unwrap();
        let saved: Vec<Value> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        // The bad entry is kept; a file with problems gets no backfill.
        assert_eq!(saved.len(), 3);
        assert_eq!(saved[1], json!({ "key": "", "command": "x" }));
        fs::write(&path, "{").unwrap();
        let broken = KeybindingsStore::open(path).snapshot();
        assert_eq!(broken.issues[0]["kind"], "keybindings.malformed-config");
        assert_eq!(broken.keybindings.len(), defaults().defaults.len());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn backfills_missing_defaults_without_shortcut_conflicts() {
        let (path, dir) = temp_file();
        // A custom rule takes mod+b for another command: the sidebar default is skipped.
        fs::write(&path, r#"[{"key":"mod+b","command":"terminal.toggle"}]"#).unwrap();
        let _ = KeybindingsStore::open(path.clone());
        let saved: Vec<Rule> = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            !saved
                .iter()
                .any(|r| r.command == "sidebar.toggle" && r.key == "mod+b")
        );
        assert_eq!(saved.last().unwrap().key, "mod+b");
        assert!(saved.len() > 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
