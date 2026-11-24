//! Settings → Projects → one project's page: its actions and where its new threads start
//! (`ProjectActionsSettings.tsx`, `ProjectDefaultsSettings.tsx` workspace row,
//! `useProjectScriptSettings.ts`, `projectScripts.ts`, `useT3ProjectFileScripts.ts`).
//!
//! `docs/scope.md` §2 #13 keeps only these two per-project overrides. A project's name, icon,
//! pin, archive, checkouts and removal belong to Orbit (§5.1), so they are not here.
//!
//! Pure and GPUI-free. A change is one `server.updateSettings` patch of
//! `projectSettingsOverrides`, built here so the iOS app sends the same bytes.

use conn_contract::{OrchestrationProjectShell as ProjectShell, ServerSettings};
use serde_json::{Map, Value, json};

/// The longest action id (`MAX_SCRIPT_ID_LENGTH`).
pub const MAX_SCRIPT_ID_CHARS: usize = 24;
/// The most actions a `t3.json` may declare (`T3_PROJECT_FILE_MAX_SCRIPTS`).
pub const MAX_FILE_SCRIPTS: usize = 50;
/// The file whose actions can be imported (`T3_PROJECT_FILE_NAME`).
pub const T3_PROJECT_FILE_NAME: &str = "t3.json";

const ENV_MODE_KEY: &str = "defaultThreadEnvMode";
const SCRIPTS_KEY: &str = "defaultProjectScripts";

/// Where a value comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The device's setting (or, for actions, the project's own stored list).
    Device,
    /// The project's override.
    Project,
}

/// Where new threads can start (`resolveEnvModeLabel`): the value and its label.
pub const ENV_MODES: [(&str, &str); 2] =
    [("local", "Current checkout"), ("worktree", "New worktree")];

/// A project's effective workspace default and actions (`resolveProjectSettings`).
#[derive(Clone, Debug, PartialEq)]
pub struct Defaults {
    /// `local` or `worktree`; `None` when no setting says.
    pub env_mode: Option<String>,
    pub env_mode_source: Source,
    pub scripts: Vec<Script>,
    pub scripts_source: Source,
}

fn overrides_of(root: &Value, project_id: &str) -> Value {
    root.get("projectSettingsOverrides")
        .and_then(|all| all.get(project_id))
        .cloned()
        .unwrap_or(Value::Null)
}

impl Defaults {
    /// Reads the project's override, then the project's own stored actions, then the device.
    #[must_use]
    pub fn of(settings: &ServerSettings, project: &ProjectShell) -> Self {
        let root = serde_json::to_value(settings).unwrap_or(Value::Null);
        let own = overrides_of(&root, &project.id);
        let (env_mode, env_mode_source) = match own.get(ENV_MODE_KEY) {
            Some(value) => (value.clone(), Source::Project),
            None => (
                root.get(ENV_MODE_KEY).cloned().unwrap_or(Value::Null),
                Source::Device,
            ),
        };
        let (scripts, scripts_source) = match own.get(SCRIPTS_KEY) {
            Some(scripts) => (scripts.clone(), Source::Project),
            None => {
                let folded = root.get("projectSettingsFolded") == Some(&json!(true));
                let own_scripts = serde_json::to_value(&project.scripts).unwrap_or(Value::Null);
                if !folded && own_scripts.as_array().is_some_and(|s| !s.is_empty()) {
                    (own_scripts, Source::Device)
                } else {
                    (
                        root.get(SCRIPTS_KEY).cloned().unwrap_or(Value::Null),
                        Source::Device,
                    )
                }
            }
        };
        Self {
            env_mode: env_mode.as_str().map(str::to_owned),
            env_mode_source,
            scripts: scripts
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Script::from_json)
                .collect(),
            scripts_source,
        }
    }
}

/// `server.updateSettings` payload that sets one override of a project, or with `None` makes it
/// follow the device again. An entry left empty becomes `null` and is removed
/// (`planScopedSettingsPatch`, `clearProjectSettingsOverrides`).
#[must_use]
pub fn override_request(
    settings: &ServerSettings,
    project_id: &str,
    key: &str,
    value: Option<Value>,
) -> Value {
    let root = serde_json::to_value(settings).unwrap_or(Value::Null);
    let mut entry = match overrides_of(&root, project_id) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    match value {
        Some(value) => {
            entry.insert(key.to_owned(), value);
        }
        None => {
            entry.remove(key);
        }
    }
    let entry = if entry.is_empty() {
        Value::Null
    } else {
        Value::Object(entry)
    };
    json!({ "patch": { "projectSettingsOverrides": { project_id: entry } } })
}

/// Payload that sets the project's workspace default (`local` or `worktree`), or with `None`
/// makes it follow the device.
#[must_use]
pub fn env_mode_request(settings: &ServerSettings, project_id: &str, mode: Option<&str>) -> Value {
    override_request(
        settings,
        project_id,
        ENV_MODE_KEY,
        mode.filter(|m| ENV_MODES.iter().any(|(value, _)| value == m))
            .map(|m| json!(m)),
    )
}

// --- a project's actions ----------------------------------------------------------------------

/// The icons an action can have.
pub const SCRIPT_ICONS: [(&str, &str); 6] = [
    ("play", "Play"),
    ("test", "Test"),
    ("lint", "Lint"),
    ("configure", "Configure"),
    ("build", "Build"),
    ("debug", "Debug"),
];

/// An action of a project (`ProjectScript`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Script {
    pub id: String,
    pub name: String,
    pub command: String,
    pub icon: String,
    pub run_on_worktree_create: bool,
    /// `async: false`: the agent waits for the setup to finish.
    pub wait_for_setup: bool,
    pub run_on_settle: bool,
    pub stop_on_settle: bool,
    pub preview_url: Option<String>,
    pub auto_open_preview: bool,
}

impl Script {
    #[must_use]
    pub fn from_json(value: &Value) -> Option<Self> {
        let flag = |key: &str| value.get(key).and_then(Value::as_bool) == Some(true);
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        let run_on_worktree_create = flag("runOnWorktreeCreate");
        Some(Self {
            id: text("id")?,
            name: text("name")?,
            command: text("command")?,
            icon: text("icon").unwrap_or_else(|| "play".to_owned()),
            run_on_worktree_create,
            wait_for_setup: run_on_worktree_create
                && value.get("async").and_then(Value::as_bool) == Some(false),
            run_on_settle: flag("runOnSettle"),
            stop_on_settle: flag("stopOnSettle"),
            preview_url: text("previewUrl"),
            auto_open_preview: flag("autoOpenPreview"),
        })
    }

    /// `buildProjectScript`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".to_owned(), json!(self.id));
        out.insert("name".to_owned(), json!(self.name));
        out.insert("command".to_owned(), json!(self.command));
        out.insert("icon".to_owned(), json!(self.icon));
        out.insert(
            "runOnWorktreeCreate".to_owned(),
            json!(self.run_on_worktree_create),
        );
        if self.run_on_worktree_create && self.wait_for_setup {
            out.insert("async".to_owned(), json!(false));
        }
        if self.run_on_settle {
            out.insert("runOnSettle".to_owned(), json!(true));
        }
        if self.stop_on_settle {
            out.insert("stopOnSettle".to_owned(), json!(true));
        }
        if let Some(url) = &self.preview_url {
            out.insert("previewUrl".to_owned(), json!(url));
            out.insert("autoOpenPreview".to_owned(), json!(self.auto_open_preview));
        }
        Value::Object(out)
    }

    /// What the editor's form starts with for a new action.
    #[must_use]
    pub fn blank() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            icon: "play".to_owned(),
            run_on_worktree_create: false,
            wait_for_setup: false,
            run_on_settle: false,
            stop_on_settle: false,
            preview_url: None,
            auto_open_preview: false,
        }
    }
}

/// What `Save` of the action form finds wrong, or the action.
///
/// # Errors
///
/// Conn's messages: `Name is required.`, `Command is required.`
pub fn script_from_form(
    id: &str,
    mut form: Script,
    preview_url: &str,
) -> Result<Script, &'static str> {
    form.name = form.name.trim().to_owned();
    form.command = form.command.trim().to_owned();
    if form.name.is_empty() {
        return Err("Name is required.");
    }
    if form.command.is_empty() {
        return Err("Command is required.");
    }
    let url = preview_url.trim();
    form.preview_url = (!url.is_empty()).then(|| url.to_owned());
    form.auto_open_preview = form.preview_url.is_some() && form.auto_open_preview;
    form.wait_for_setup = form.run_on_worktree_create && form.wait_for_setup;
    id.clone_into(&mut form.id);
    Ok(form)
}

fn normalize_script_id(value: &str) -> String {
    let mut cleaned = String::new();
    let mut gap = false;
    for c in value.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !cleaned.is_empty() {
                cleaned.push('-');
            }
            gap = false;
            cleaned.push(c);
        } else {
            gap = true;
        }
    }
    if cleaned.is_empty() {
        return "script".to_owned();
    }
    let cut: String = cleaned.chars().take(MAX_SCRIPT_ID_CHARS).collect();
    let cut = cut.trim_end_matches('-').to_owned();
    if cut.is_empty() {
        "script".to_owned()
    } else {
        cut
    }
}

/// `nextProjectScriptId`: the name as an id, with `-2`, `-3`... when taken.
#[must_use]
pub fn next_script_id(name: &str, existing: &[String]) -> String {
    let base = normalize_script_id(name);
    if !existing.contains(&base) {
        return base;
    }
    for suffix in 2..10_000_usize {
        let candidate = format!("{base}-{suffix}");
        let candidate = if candidate.chars().count() <= MAX_SCRIPT_ID_CHARS {
            candidate
        } else {
            let keep = MAX_SCRIPT_ID_CHARS
                .saturating_sub(suffix.to_string().len() + 1)
                .max(1);
            format!("{}-{suffix}", base.chars().take(keep).collect::<String>())
        };
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    base
}

/// `releaseClaimedRoles`: saving an action that runs on worktree creation or on settle takes
/// that role from the others, which keep their other settings.
#[must_use]
pub fn release_claimed_roles(other: &Script, saved: &Script) -> Script {
    let mut next = other.clone();
    if saved.run_on_worktree_create && other.run_on_worktree_create {
        next.run_on_worktree_create = false;
        next.wait_for_setup = false;
    }
    if saved.run_on_settle && other.run_on_settle {
        next.run_on_settle = false;
    }
    next
}

/// The actions after saving `saved`: it replaces the one with its id (or goes last), and the
/// others lose the roles it claims (`submit`).
#[must_use]
pub fn scripts_after_save(current: &[Script], saved: &Script, is_new: bool) -> Vec<Script> {
    let mut next: Vec<Script> = current
        .iter()
        .map(|s| {
            if s.id == saved.id {
                saved.clone()
            } else {
                release_claimed_roles(s, saved)
            }
        })
        .collect();
    if is_new {
        next.push(saved.clone());
    }
    next
}

/// The actions without `id` (`Delete action`).
#[must_use]
pub fn scripts_after_delete(current: &[Script], id: &str) -> Vec<Script> {
    current.iter().filter(|s| s.id != id).cloned().collect()
}

/// `server.updateSettings` payload of a project's actions.
#[must_use]
pub fn scripts_request(settings: &ServerSettings, project_id: &str, scripts: &[Script]) -> Value {
    override_request(
        settings,
        project_id,
        SCRIPTS_KEY,
        Some(Value::Array(scripts.iter().map(Script::to_json).collect())),
    )
}

/// `server.updateSettings` payload that makes a project follow the device's actions again
/// (`onResetOverride`).
#[must_use]
pub fn scripts_reset_request(settings: &ServerSettings, project_id: &str) -> Value {
    override_request(settings, project_id, SCRIPTS_KEY, None)
}

// --- t3.json ----------------------------------------------------------------------------------

/// What a checkout's `t3.json` holds (`useT3ProjectFileState`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileState {
    /// No `t3.json`, or one too large to read.
    Missing,
    /// It exists and fails to parse, so every action it declares is ignored.
    Invalid,
    Valid(Vec<Script>),
}

/// One pass over `text` outside strings: `step` sees each character and the rest, and says how
/// many characters to skip and what to keep.
fn outside_strings(
    text: &str,
    mut step: impl FnMut(&[char], usize) -> (usize, Option<char>),
) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut in_string = false;
    while let Some(&c) = chars.get(i) {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(&next) = chars.get(i + 1) {
                    out.push(next);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
        } else {
            let (skip, keep) = step(&chars, i);
            out.extend(keep);
            i += skip.max(1);
        }
    }
    out
}

/// Drops `//` and `/* */` comments, then trailing commas (`fromLenientJson`).
fn lenient_json(text: &str) -> String {
    let uncommented = outside_strings(text, |chars, i| match (chars[i], chars.get(i + 1)) {
        ('/', Some('/')) => {
            let end = chars[i..]
                .iter()
                .position(|&c| c == '\n')
                .unwrap_or(chars.len() - i);
            (end, None)
        }
        ('/', Some('*')) => {
            let end = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j] == '*' && chars[j + 1] == '/')
                .map_or(chars.len() - i, |j| j + 2 - i);
            (end, None)
        }
        (c, _) => (1, Some(c)),
    });
    outside_strings(&uncommented, |chars, i| {
        if chars[i] != ',' {
            return (1, Some(chars[i]));
        }
        let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
        (1, (!matches!(next, Some('}' | ']'))).then_some(','))
    })
}

fn file_script(value: &Value) -> Option<Script> {
    let object = value.as_object()?;
    let text = |key: &str| -> Option<Option<String>> {
        match object.get(key) {
            None => Some(None),
            Some(Value::String(s)) if !s.trim().is_empty() => Some(Some(s.trim().to_owned())),
            Some(_) => None,
        }
    };
    let flag = |key: &str| -> Option<Option<bool>> {
        match object.get(key) {
            None => Some(None),
            Some(Value::Bool(b)) => Some(Some(*b)),
            Some(_) => None,
        }
    };
    let icon = match object.get("icon") {
        None => "play".to_owned(),
        Some(Value::String(s)) if SCRIPT_ICONS.iter().any(|(id, _)| id == s) => s.clone(),
        Some(_) => return None,
    };
    let run_on_worktree_create = flag("runOnWorktreeCreate")?.unwrap_or(false);
    let preview_url = text("previewUrl")?;
    Some(Script {
        id: String::new(),
        name: text("name")??,
        command: text("command")??,
        icon,
        run_on_worktree_create,
        wait_for_setup: run_on_worktree_create && flag("async")? == Some(false),
        run_on_settle: flag("runOnSettle")?.unwrap_or(false),
        stop_on_settle: flag("stopOnSettle")?.unwrap_or(false),
        auto_open_preview: preview_url.is_some() && flag("autoOpenPreview")?.unwrap_or(false),
        preview_url,
    })
}

/// `parseT3ProjectFile` of `contents`, as far as actions go. Any bad action makes the file
/// invalid, as the schema does.
#[must_use]
pub fn parse_file(contents: &str) -> FileState {
    let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&lenient_json(contents)) else {
        return FileState::Invalid;
    };
    let scripts = match file.get("scripts") {
        None => return FileState::Valid(Vec::new()),
        Some(Value::Array(scripts)) if scripts.len() <= MAX_FILE_SCRIPTS => scripts,
        Some(_) => return FileState::Invalid,
    };
    scripts
        .iter()
        .map(file_script)
        .collect::<Option<Vec<_>>>()
        .map_or(FileState::Invalid, FileState::Valid)
}

/// The file's actions the project does not have yet: same command or same name, ignoring case,
/// counts as there (`importableScripts`).
#[must_use]
pub fn importable<'a>(file: &'a [Script], current: &[Script]) -> Vec<&'a Script> {
    file.iter()
        .filter(|candidate| {
            !current.iter().any(|script| {
                script.command == candidate.command
                    || script.name.to_lowercase() == candidate.name.to_lowercase()
            })
        })
        .collect()
}

/// The action an import adds, with its id, as `Import scripts` saves it.
#[must_use]
pub fn imported(file_script: &Script, existing_ids: &[String]) -> Script {
    Script {
        id: next_script_id(&file_script.name, existing_ids),
        ..file_script.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(extra: Value) -> ProjectShell {
        let mut base = json!({
            "id": "p1", "title": "Conn", "workspaceRoot": "/w/conn",
            "defaultModelSelection": null, "scripts": [],
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
            "deletedAt": null
        });
        base.as_object_mut()
            .expect("object")
            .extend(extra.as_object().expect("object").clone());
        serde_json::from_value(base).expect("project")
    }

    fn settings(extra: Value) -> ServerSettings {
        serde_json::from_value(extra).expect("settings")
    }

    #[test]
    fn defaults_follow_the_project_override_then_the_device() {
        let device = settings(json!({
            "defaultThreadEnvMode": "local",
            "defaultProjectScripts": [{ "id": "dev", "name": "Dev", "command": "npm run dev", "icon": "play", "runOnWorktreeCreate": false }],
            "projectSettingsOverrides": { "p1": { "defaultThreadEnvMode": "worktree" } }
        }));
        let defaults = Defaults::of(&device, &project(json!({})));
        assert_eq!(defaults.env_mode.as_deref(), Some("worktree"));
        assert_eq!(defaults.env_mode_source, Source::Project);
        assert_eq!(defaults.scripts.len(), 1);
        assert_eq!(defaults.scripts_source, Source::Device);
        let other = Defaults::of(&device, &project(json!({ "id": "p2" })));
        assert_eq!(other.env_mode.as_deref(), Some("local"));
        assert_eq!(other.env_mode_source, Source::Device);
    }

    #[test]
    fn a_projects_own_stored_actions_come_before_the_devices() {
        let stored = project(json!({ "scripts": [
            { "id": "t", "name": "Test", "command": "make test", "icon": "test", "runOnWorktreeCreate": false }
        ] }));
        let device = settings(json!({
            "defaultProjectScripts": [{ "id": "dev", "name": "Dev", "command": "x", "icon": "play", "runOnWorktreeCreate": false }],
        }));
        let defaults = Defaults::of(&device, &stored);
        assert_eq!(defaults.scripts[0].id, "t");
        let folded = settings(json!({
            "projectSettingsFolded": true,
            "defaultProjectScripts": [{ "id": "dev", "name": "Dev", "command": "x", "icon": "play", "runOnWorktreeCreate": false }],
        }));
        assert_eq!(Defaults::of(&folded, &stored).scripts[0].id, "dev");
        let own = settings(json!({
            "projectSettingsOverrides": { "p1": { "defaultProjectScripts": [] } },
        }));
        let defaults = Defaults::of(&own, &stored);
        assert!(defaults.scripts.is_empty());
        assert_eq!(defaults.scripts_source, Source::Project);
    }

    #[test]
    fn an_override_is_set_or_cleared_and_an_empty_entry_goes() {
        let device = settings(json!({
            "projectSettingsOverrides": { "p1": { "defaultThreadEnvMode": "worktree", "defaultAutoPull": true } }
        }));
        assert_eq!(
            env_mode_request(&device, "p1", Some("local")),
            json!({ "patch": { "projectSettingsOverrides": { "p1": { "defaultThreadEnvMode": "local", "defaultAutoPull": true } } } })
        );
        assert_eq!(
            env_mode_request(&device, "p1", None),
            json!({ "patch": { "projectSettingsOverrides": { "p1": { "defaultAutoPull": true } } } }),
            "other overrides stay"
        );
        assert_eq!(
            env_mode_request(&device, "p1", Some("elsewhere")),
            env_mode_request(&device, "p1", None),
            "an unknown mode is not written"
        );
        let only = settings(
            json!({ "projectSettingsOverrides": { "p1": { "defaultThreadEnvMode": "worktree" } } }),
        );
        assert_eq!(
            env_mode_request(&only, "p1", None),
            json!({ "patch": { "projectSettingsOverrides": { "p1": null } } })
        );
    }

    #[test]
    fn actions_get_ids_roles_and_checks_as_in_conn() {
        assert_eq!(next_script_id("Run dev server!", &[]), "run-dev-server");
        assert_eq!(next_script_id("Dev", &["dev".to_owned()]), "dev-2");
        assert_eq!(next_script_id("!!!", &[]), "script");
        assert_eq!(
            next_script_id(&"x".repeat(40), &[]).len(),
            MAX_SCRIPT_ID_CHARS
        );

        let mut form = Script::blank();
        assert_eq!(
            script_from_form("a", form.clone(), ""),
            Err("Name is required.")
        );
        form.name = " Setup ".to_owned();
        assert_eq!(
            script_from_form("a", form.clone(), ""),
            Err("Command is required.")
        );
        form.command = "npm i".to_owned();
        form.run_on_worktree_create = true;
        form.wait_for_setup = true;
        form.auto_open_preview = true;
        let setup = script_from_form("setup", form, " ").expect("valid");
        assert_eq!(setup.name, "Setup");
        assert!(setup.wait_for_setup);
        assert!(!setup.auto_open_preview, "no preview url, nothing to open");
        assert_eq!(
            setup.to_json(),
            json!({ "id": "setup", "name": "Setup", "command": "npm i", "icon": "play", "runOnWorktreeCreate": true, "async": false })
        );
        assert_eq!(Script::from_json(&setup.to_json()), Some(setup.clone()));

        let mut old = Script::blank();
        old.id = "old".to_owned();
        old.name = "Old".to_owned();
        old.command = "make".to_owned();
        old.run_on_worktree_create = true;
        old.run_on_settle = true;
        old.preview_url = Some("http://localhost:3000".to_owned());
        let next = scripts_after_save(&[old], &setup, true);
        assert_eq!(next.len(), 2);
        assert!(
            !next[0].run_on_worktree_create,
            "the new setup action took the role"
        );
        assert!(
            next[0].run_on_settle,
            "but not the settle role it did not claim"
        );
        assert_eq!(
            next[0].preview_url.as_deref(),
            Some("http://localhost:3000")
        );
        assert_eq!(next[1].id, "setup");
        let edited = scripts_after_save(
            &next,
            &Script {
                name: "Renamed".to_owned(),
                ..setup
            },
            false,
        );
        assert_eq!(edited.len(), 2);
        assert_eq!(edited[1].name, "Renamed");
        let device = settings(json!({}));
        assert_eq!(
            scripts_request(&device, "p1", &edited[..1])["patch"]["projectSettingsOverrides"]["p1"]
                ["defaultProjectScripts"][0]["id"],
            "old"
        );
        assert_eq!(scripts_after_delete(&edited, "old").len(), 1);
        assert_eq!(
            scripts_reset_request(&settings(json!({})), "p1"),
            json!({ "patch": { "projectSettingsOverrides": { "p1": null } } })
        );
    }

    #[test]
    fn a_t3_json_is_read_leniently_and_a_bad_action_voids_it() {
        let text = r#"{
            // shared actions
            "$schema": "https://t3.codes/schema/t3.json",
            "scripts": [
                { "name": " Dev ", "command": "npm run dev", "icon": "build",
                  "previewUrl": "http://localhost:5173", "autoOpenPreview": true, },
                { "name": "Setup", "command": "npm i", "runOnWorktreeCreate": true, "async": false },
                /* last */
            ],
        }"#;
        let FileState::Valid(scripts) = parse_file(text) else {
            panic!("valid");
        };
        assert_eq!(scripts.len(), 2);
        assert_eq!(scripts[0].name, "Dev");
        assert_eq!(scripts[0].icon, "build");
        assert!(scripts[0].auto_open_preview);
        assert!(scripts[1].wait_for_setup);
        assert_eq!(
            parse_file(r#"{ "scripts": [{ "name": "x", "command": "" }] }"#),
            FileState::Invalid
        );
        assert_eq!(
            parse_file(r#"{ "scripts": [{ "name": "x", "command": "y", "icon": "nope" }] }"#),
            FileState::Invalid
        );
        assert_eq!(parse_file("{ not json"), FileState::Invalid);
        assert_eq!(parse_file("{}"), FileState::Valid(vec![]));
        assert_eq!(
            parse_file(r#"{ "scripts": [{ "name": "a//b", "command": "echo \"// x\"" }] }"#),
            FileState::Valid(vec![Script {
                name: "a//b".to_owned(),
                command: "echo \"// x\"".to_owned(),
                ..Script::blank()
            }]),
            "comment markers inside strings stay"
        );
    }

    #[test]
    fn an_import_offers_only_actions_the_project_lacks() {
        let FileState::Valid(file) = parse_file(
            r#"{ "scripts": [
                { "name": "Dev", "command": "npm run dev" },
                { "name": "Lint", "command": "npm run lint" },
                { "name": "Other", "command": "make" }
            ] }"#,
        ) else {
            panic!("valid");
        };
        let mut have_name = Script::blank();
        have_name.id = "d".to_owned();
        have_name.name = "dev".to_owned();
        have_name.command = "different".to_owned();
        let mut have_command = Script::blank();
        have_command.id = "l".to_owned();
        have_command.name = "Run lint".to_owned();
        have_command.command = "npm run lint".to_owned();
        let offered = importable(&file, &[have_name, have_command]);
        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].name, "Other");
        let added = imported(offered[0], &["other".to_owned()]);
        assert_eq!(added.id, "other-2");
        assert_eq!(added.command, "make");
    }
}
