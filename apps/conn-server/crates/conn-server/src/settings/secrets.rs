//! Settings secrets in the T3 server's secret store (`apps/server/src/settingsSecrets.ts`,
//! `serverSettings.ts`): `settings.json` holds `••••••` where a secret is saved (a sensitive
//! environment variable holds `""` and `valueRedacted: true`), and the value lives in
//! `<state>/secrets/<name>.bin`. The names, when a value moves, and what a client sees follow
//! the T3 server, so either server reads the other's state.
//!
//! Nothing here logs a value; errors name the secret, never its value.

use std::{io, path::Path};

use serde_json::{Map, Value, json};

use super::SECRET_REDACTED;
use super::generated::{
    CLOUD_SPEECH, EAS_DEVICE_HOST, PROVIDER_CONFIG, SECRET_PROVIDER_KINDS, SIMLOCK_DEVICE_HOST,
    SOURCE_CONTROL_HOST, TEXT_GENERATOR, USAGE_LIMIT_SOURCE,
};
use conn_support::secret_store;

/// A field secret (in a group's config) or a provider instance's environment variable.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Field,
    Environment,
}

/// One secret slot as `mapSettingsSecrets` sees it.
pub(super) struct Secret {
    /// The store name, `<name>.bin`. Not secret.
    pub name: String,
    pub kind: Kind,
    pub value: String,
    /// The slot says "saved" (`••••••`, or `valueRedacted`), not a value.
    pub redacted: bool,
    pub sensitive: bool,
}

/// What a slot holds after a map: a value, or the saved marker.
pub(super) struct Mapped {
    pub value: String,
    pub redacted: bool,
}

impl Mapped {
    fn keep(secret: &Secret) -> Self {
        Self {
            value: secret.value.clone(),
            redacted: secret.redacted,
        }
    }
}

fn encode(text: &str) -> String {
    conn_support::base64::url_encode(text.as_bytes())
}

fn host_suffix(host: Option<&str>) -> String {
    host.map(|h| format!("-{}", encode(h))).unwrap_or_default()
}

fn listed(
    table: &'static [(&'static str, &'static [&'static str])],
    name: &str,
) -> &'static [&'static str] {
    table
        .iter()
        .find(|(n, _)| *n == name)
        .map_or(&[], |(_, fields)| *fields)
}

/// `{ provider, reference }`: a secret kept by a secret provider, not a secret itself.
pub(super) fn is_secret_reference(value: &Value) -> bool {
    value.get("provider").is_some_and(Value::is_string)
        && value.get("reference").is_some_and(Value::is_string)
}

/// Names a group's slot from the field and, for a field that maps server hosts to secrets,
/// the host (trimmed, lowercase).
type Namer<'a> = &'a dyn Fn(&str, Option<&str>) -> String;

/// What [`walk`] visits.
enum Visit<'a> {
    /// A group's fields, its secret fields, and the namer of its slots.
    Group(
        &'a mut Map<String, Value>,
        &'static [&'static str],
        Namer<'a>,
    ),
    /// A provider instance's id and its environment variables.
    Environment(&'a str, &'a mut Vec<Value>),
}

/// Every field group and every provider environment, as `mapSecretFieldGroups` walks them,
/// with the T3 server's store name for each slot.
fn walk(settings: &mut Map<String, Value>, visit: &mut dyn FnMut(Visit<'_>)) {
    for (name, value) in settings.iter_mut() {
        match (name.as_str(), value) {
            ("cloudSpeechCredentials", Value::Object(fields)) => {
                visit(Visit::Group(fields, CLOUD_SPEECH, &|field, _| {
                    format!("voice-cloud-{field}")
                }));
            }
            ("providerInstances", Value::Object(instances)) => {
                for (id, instance) in instances.iter_mut() {
                    let Value::Object(instance) = instance else {
                        continue;
                    };
                    let driver = instance
                        .get("driver")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if let Some(Value::Object(config)) = instance.get_mut("config") {
                        visit(Visit::Group(
                            config,
                            listed(PROVIDER_CONFIG, &driver),
                            &|field, host| {
                                format!(
                                    "provider-config-{}-{}-{}{}",
                                    encode(id),
                                    encode(&driver),
                                    encode(field),
                                    host_suffix(host)
                                )
                            },
                        ));
                    }
                    if let Some(Value::Array(variables)) = instance.get_mut("environment") {
                        visit(Visit::Environment(id, variables));
                    }
                }
            }
            ("sourceControlHosts", Value::Object(hosts)) => {
                for (kind, fields) in hosts.iter_mut() {
                    if let Value::Object(fields) = fields {
                        visit(Visit::Group(
                            fields,
                            listed(SOURCE_CONTROL_HOST, kind),
                            &|field, host| {
                                format!(
                                    "source-control-{}-{}{}",
                                    encode(kind),
                                    encode(field),
                                    host_suffix(host)
                                )
                            },
                        ));
                    }
                }
            }
            ("usageLimitSources", Value::Object(entries)) => {
                for (id, fields) in entries.iter_mut() {
                    if let Value::Object(fields) = fields {
                        visit(Visit::Group(fields, USAGE_LIMIT_SOURCE, &|field, host| {
                            if field == "managementKey" && host.is_none() {
                                format!("usage-limit-source-{}", encode(id))
                            } else {
                                format!(
                                    "usage-limit-source-{}-{}{}",
                                    encode(id),
                                    encode(field),
                                    host_suffix(host)
                                )
                            }
                        }));
                    }
                }
            }
            ("textGenerators", Value::Object(entries)) => {
                for (id, fields) in entries.iter_mut() {
                    if let Value::Object(fields) = fields {
                        visit(Visit::Group(fields, TEXT_GENERATOR, &|field, host| {
                            format!(
                                "text-generator-{}-{}{}",
                                encode(id),
                                encode(field),
                                host_suffix(host)
                            )
                        }));
                    }
                }
            }
            (list @ ("easDeviceHosts" | "simlockDeviceHosts"), Value::Array(hosts)) => {
                // Its own prefix: an EAS and a Simlock host may share an id.
                let (fields_of, prefix) = if list == "easDeviceHosts" {
                    (EAS_DEVICE_HOST, "device-host")
                } else {
                    (SIMLOCK_DEVICE_HOST, "simlock-device-host")
                };
                for fields in hosts.iter_mut() {
                    if let Value::Object(fields) = fields {
                        let id = fields
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        visit(Visit::Group(fields, fields_of, &|field, host| {
                            format!(
                                "{prefix}-{}-{}{}",
                                encode(&id),
                                encode(field),
                                host_suffix(host)
                            )
                        }));
                    }
                }
            }
            _ => {}
        }
    }
}

/// `mapSettingsSecrets`: maps every literal secret (field values per server host, and each
/// provider environment variable). References to a secret provider stay as they are. A
/// mapped slot that is `redacted` holds the marker.
pub(super) fn map_secrets(settings: &mut Map<String, Value>, f: &mut dyn FnMut(&Secret) -> Mapped) {
    walk(settings, &mut |visit| match visit {
        Visit::Group(fields, secret_fields, name) => {
            for field in secret_fields {
                let Some(slot) = fields.get_mut(*field) else {
                    continue;
                };
                let mut one = |host: Option<&str>, value: &str| {
                    let mapped = f(&Secret {
                        name: name(field, host),
                        kind: Kind::Field,
                        value: value.to_owned(),
                        redacted: value == SECRET_REDACTED,
                        sensitive: true,
                    });
                    json!(if mapped.redacted {
                        SECRET_REDACTED.to_owned()
                    } else {
                        mapped.value
                    })
                };
                if is_secret_reference(slot) {
                    continue;
                }
                match slot {
                    Value::String(value) => {
                        let value = value.clone();
                        *slot = one(None, &value);
                    }
                    Value::Object(hosts) => {
                        // `writeSecretFieldValues`: references keep their place, string
                        // values are mapped, other entries drop; hosts are trimmed, lowercase.
                        let mut next = Map::new();
                        for (host, entry) in hosts.iter() {
                            let host = host.trim().to_lowercase();
                            match entry {
                                Value::String(value) => {
                                    let mapped = one(Some(&host), value);
                                    next.insert(host, mapped);
                                }
                                entry if is_secret_reference(entry) => {
                                    next.insert(host, entry.clone());
                                }
                                _ => {}
                            }
                        }
                        *hosts = next;
                    }
                    _ => {}
                }
            }
        }
        Visit::Environment(id, variables) => {
            for variable in variables.iter_mut() {
                let Value::Object(variable) = variable else {
                    continue;
                };
                let value_redacted = variable.remove("valueRedacted") == Some(Value::Bool(true));
                let value = variable.get("value").cloned().unwrap_or(Value::Null);
                if is_secret_reference(&value) {
                    continue;
                }
                let name = variable
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mapped = f(&Secret {
                    name: format!("provider-env-{}-{}", encode(id), encode(name)),
                    kind: Kind::Environment,
                    value: value.as_str().unwrap_or_default().to_owned(),
                    redacted: value_redacted,
                    sensitive: variable.get("sensitive") == Some(&Value::Bool(true)),
                });
                variable.insert("value".into(), json!(mapped.value));
                if mapped.redacted {
                    variable.insert("valueRedacted".into(), json!(true));
                }
            }
        }
    });
}

/// `mapSettingsSecretValues`: maps each value a secret field holds, literal or reference,
/// with its slot's name. Environment variables stay as they are.
pub(super) fn map_field_values(
    settings: &mut Map<String, Value>,
    f: &mut dyn FnMut(&Value, &str) -> Option<Value>,
) {
    walk(settings, &mut |visit| {
        let Visit::Group(fields, secret_fields, name) = visit else {
            return;
        };
        {
            for field in secret_fields {
                let Some(slot) = fields.get_mut(*field) else {
                    continue;
                };
                let mut one = |value: &mut Value, host: Option<&str>| {
                    if (value.is_string() || is_secret_reference(value))
                        && let Some(next) = f(value, &name(field, host))
                    {
                        *value = next;
                    }
                };
                match slot {
                    Value::Object(_) if !is_secret_reference(slot) => {
                        if let Value::Object(hosts) = slot {
                            for (host, entry) in hosts.iter_mut() {
                                one(entry, Some(&host.trim().to_lowercase()));
                            }
                        }
                    }
                    _ => one(slot, None),
                }
            }
        }
    });
}

/// `withEchoedSecretReferences`: a client shown a reference as `••••••` sends the marker
/// back; the slot keeps its reference.
pub(super) fn restore_echoed_references(
    current: &Map<String, Value>,
    next: &mut Map<String, Value>,
) {
    let mut references: Vec<(String, Value)> = Vec::new();
    let mut current = current.clone();
    map_field_values(&mut current, &mut |value, name| {
        if is_secret_reference(value) {
            references.push((name.to_owned(), value.clone()));
        }
        None
    });
    if references.is_empty() {
        return;
    }
    map_field_values(next, &mut |value, name| {
        if value != SECRET_REDACTED {
            return None;
        }
        references
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, reference)| reference.clone())
    });
}

/// `redactServerSettingsForClient` for a client without `secretReferences`: a saved
/// secret shows `••••••`, a sensitive variable shows `""` with `valueRedacted`, and a
/// reference shows the marker.
pub(super) fn redact(settings: &mut Map<String, Value>) {
    super::retain_supported_hosts(settings);
    map_secrets(settings, &mut |secret| {
        if secret.sensitive {
            Mapped {
                value: String::new(),
                redacted: secret.redacted || !secret.value.is_empty(),
            }
        } else {
            Mapped {
                value: secret.value.clone(),
                redacted: false,
            }
        }
    });
    map_field_values(settings, &mut |value, _| {
        is_secret_reference(value).then(|| json!(SECRET_REDACTED))
    });
    // `withoutUnknownSecretProviderConfigs`: a kind this server does not know shows no config.
    if let Some(Value::Object(providers)) = settings.get_mut("secretProviders") {
        for entry in providers.values_mut() {
            let known = entry
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(|kind| SECRET_PROVIDER_KINDS.contains(&kind));
            if !known && let Value::Object(entry) = entry {
                entry.remove("config");
            }
        }
    }
}

/// A change to the store that a save makes.
pub(super) struct Change {
    pub name: String,
    /// The value to write; `None` removes the secret.
    pub write: Option<Vec<u8>>,
}

impl std::fmt::Debug for Change {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Change")
            .field("name", &self.name)
            .field("write", &self.write.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// `persistSettingsSecrets`: turns `next` (the file form after a patch) into what the file
/// stores, and lists the store changes. A new value moves to the store and the slot holds the
/// marker; a marker keeps the stored value (and moves an inline value `current` still has); an
/// empty or non-sensitive slot removes its stored value; a slot that is gone removes its value.
pub(super) fn persist(current: &Map<String, Value>, next: &mut Map<String, Value>) -> Vec<Change> {
    let mut previous: Vec<String> = Vec::new();
    let mut inline: Vec<(String, String)> = Vec::new();
    let mut scratch = current.clone();
    map_secrets(&mut scratch, &mut |secret| {
        if secret.sensitive {
            previous.push(secret.name.clone());
            if !secret.redacted && !secret.value.is_empty() {
                inline.push((secret.name.clone(), secret.value.clone()));
            }
        }
        Mapped::keep(secret)
    });
    restore_echoed_references(current, next);
    let mut changes: Vec<Change> = Vec::new();
    let mut next_names: Vec<String> = Vec::new();
    let mut kept: Vec<String> = Vec::new();
    let mut written: Vec<String> = Vec::new();
    let mut inline_writes: Vec<Change> = Vec::new();
    map_secrets(next, &mut |secret| {
        if !secret.sensitive {
            changes.push(Change {
                name: secret.name.clone(),
                write: None,
            });
            return Mapped {
                value: secret.value.clone(),
                redacted: false,
            };
        }
        if secret.redacted {
            kept.push(secret.name.clone());
            next_names.push(secret.name.clone());
            if let Some((_, value)) = inline.iter().find(|(n, _)| *n == secret.name)
                && !inline_writes.iter().any(|c| c.name == secret.name)
            {
                inline_writes.push(Change {
                    name: secret.name.clone(),
                    write: Some(value.as_bytes().to_vec()),
                });
            }
            return Mapped {
                value: String::new(),
                redacted: true,
            };
        }
        if secret.value.is_empty() {
            changes.push(Change {
                name: secret.name.clone(),
                write: None,
            });
            return Mapped {
                value: String::new(),
                redacted: false,
            };
        }
        next_names.push(secret.name.clone());
        written.push(secret.name.clone());
        changes.push(Change {
            name: secret.name.clone(),
            write: Some(secret.value.as_bytes().to_vec()),
        });
        Mapped {
            value: String::new(),
            redacted: true,
        }
    });
    // A legacy inline value moves to the store only when no slot in this save replaces it.
    changes.extend(
        inline_writes
            .into_iter()
            .filter(|change| !written.contains(&change.name)),
    );
    for name in previous {
        if next_names.contains(&name) || changes.iter().any(|c| c.name == name) {
            continue;
        }
        changes.push(Change { name, write: None });
    }
    // A redacted slot still claims its stored secret, so a duplicate slot must not remove it.
    changes.retain(|change| change.write.is_some() || !kept.contains(&change.name));
    changes
}

/// Applies `changes` in order. On a failure, every change made so far is undone (the old
/// value written back, or removed), and the error names the operation and the secret.
pub(super) fn apply(dir: &Path, changes: &[Change]) -> Result<Undo, (&'static str, io::Error)> {
    let mut undo = Undo(Vec::new());
    for change in changes {
        let previous = match secret_store::read(dir, &change.name) {
            Ok(previous) => previous,
            Err(error) => {
                undo.run(dir);
                return Err(("read-secret", error));
            }
        };
        undo.0.push(Change {
            name: change.name.clone(),
            write: previous,
        });
        let (operation, result) = match &change.write {
            Some(value) => (
                "write-secret",
                secret_store::write(dir, &change.name, value),
            ),
            None => ("remove-secret", secret_store::remove(dir, &change.name)),
        };
        if let Err(error) = result {
            undo.run(dir);
            return Err((operation, error));
        }
    }
    Ok(undo)
}

/// What [`apply`] changed, to undo when the settings file cannot be written after it.
pub(super) struct Undo(Vec<Change>);

impl Undo {
    pub(super) fn run(self, dir: &Path) {
        for change in self.0.into_iter().rev() {
            let result = match &change.write {
                Some(value) => secret_store::write(dir, &change.name, value),
                None => secret_store::remove(dir, &change.name),
            };
            if result.is_err() {
                eprintln!(
                    "conn-server: failed to roll back settings secret {}",
                    change.name
                );
            }
        }
    }
}

/// `moveInlineSettingsSecrets`, at start: each field secret held in the file moves to the
/// store and the slot holds the marker. A value that cannot be stored stays inline. Returns
/// whether any moved.
pub(super) fn move_inline(dir: &Path, settings: &mut Map<String, Value>) -> bool {
    let mut pending: Vec<(String, String)> = Vec::new();
    let mut scratch = settings.clone();
    map_secrets(&mut scratch, &mut |secret| {
        if secret.kind == Kind::Field && !secret.redacted && !secret.value.is_empty() {
            pending.push((secret.name.clone(), secret.value.clone()));
        }
        Mapped::keep(secret)
    });
    let mut moved: Vec<String> = Vec::new();
    for (name, value) in pending {
        match secret_store::write(dir, &name, value.as_bytes()) {
            Ok(()) => moved.push(name),
            Err(_) => eprintln!(
                "conn-server: failed to move a settings secret into the secret store ({name})"
            ),
        }
    }
    if moved.is_empty() {
        return false;
    }
    map_secrets(settings, &mut |secret| {
        if moved.contains(&secret.name) {
            Mapped {
                value: String::new(),
                redacted: true,
            }
        } else {
            Mapped::keep(secret)
        }
    });
    true
}

/// `materializeSettingsSecrets`: the settings with each saved secret read from the store (a
/// missing file reads as `""`). A variable keeps `valueRedacted` beside its value, as in T3.
pub(super) fn materialize(
    dir: &Path,
    settings: &Map<String, Value>,
) -> Result<Map<String, Value>, (String, io::Error)> {
    let mut wanted: Vec<String> = Vec::new();
    let mut scratch = settings.clone();
    map_secrets(&mut scratch, &mut |secret| {
        if secret.sensitive && secret.redacted && !wanted.contains(&secret.name) {
            wanted.push(secret.name.clone());
        }
        Mapped::keep(secret)
    });
    let mut stored: Vec<(String, String)> = Vec::with_capacity(wanted.len());
    for name in wanted {
        match secret_store::read(dir, &name) {
            Ok(bytes) => {
                let value = bytes
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                stored.push((name, value));
            }
            Err(error) => return Err((name, error)),
        }
    }
    let mut materialized = settings.clone();
    map_secrets(&mut materialized, &mut |secret| {
        let use_store = secret.sensitive && secret.redacted;
        Mapped {
            value: if use_store {
                stored
                    .iter()
                    .find(|(n, _)| *n == secret.name)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default()
            } else {
                secret.value.clone()
            },
            redacted: use_store && secret.kind == Kind::Environment,
        }
    });
    Ok(materialized)
}
