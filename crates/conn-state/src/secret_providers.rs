//! Settings → Secrets: the secret providers an environment reads values from
//! (`SecretsSettings.tsx`, `SecretProviderDialog.tsx`, `SecretProviderDialog.logic.ts`,
//! `SecretsSettings.logic.ts`, `RedactedSensitiveText.tsx`).
//!
//! Pure and GPUI-free. Every write is a `server.updateSettings` payload that sets or removes
//! one `secretProviders` entry, built here so the iOS app sends the same bytes.

use conn_contract::{ServerSettings, ServerSettingsSecretProvidersValue as SecretProviderConfig};
use serde_json::{Map, Value, json};

use crate::provider_settings::{ONE_PASSWORD_KIND, driver_def};

/// The longest provider name (`SecretProviderLabel`).
pub const NAME_MAX_CHARS: usize = 64;
/// The longest provider id (`SecretProviderSlug`).
const ID_MAX_CHARS: usize = 64;
/// The longest 1Password account (`OnePasswordAccount`).
pub const ACCOUNT_MAX_CHARS: usize = 253;

/// What a secret provider entry is to this client (`classifySecretProvider`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClassifiedProvider {
    OnePassword {
        account: String,
    },
    /// An unknown kind, or a config that no longer decodes: shown read-only, removal stays.
    Unsupported,
}

/// The 1Password account of `config` when it is a valid one.
#[must_use]
pub fn classify(config: &SecretProviderConfig) -> ClassifiedProvider {
    if config.kind != ONE_PASSWORD_KIND {
        return ClassifiedProvider::Unsupported;
    }
    config
        .config
        .as_ref()
        .and_then(|c| c.get("account"))
        .and_then(Value::as_str)
        .filter(|account| account_issue(account).is_none())
        .map_or(ClassifiedProvider::Unsupported, |account| {
            ClassifiedProvider::OnePassword {
                account: account.to_owned(),
            }
        })
}

/// Why `account` is not a 1Password account, or `None` (`OnePasswordAccount`: it goes to the
/// `op` CLI as an argument, so it never starts with `-`).
fn account_issue(account: &str) -> Option<&'static str> {
    let mut chars = account.chars();
    let valid = account.chars().count() <= ACCOUNT_MAX_CHARS
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    (!valid)
        .then_some("1Password account must be a shorthand, sign-in address, or ID with no spaces.")
}

/// A stable, readable id from a name, so adding a provider under the same name again restores
/// the variables that read from it (`secretProviderIdFromName`).
#[must_use]
pub fn provider_id_from_name(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut gap = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c);
        } else {
            gap = true;
        }
    }
    let slug: String = slug.chars().take(ID_MAX_CHARS).collect();
    let slug = slug.trim_end_matches('-').to_owned();
    slug.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        .then_some(slug)
}

/// The two fields of the Add and Edit form.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub name: String,
    pub account: String,
}

impl Draft {
    /// The form of an existing entry.
    #[must_use]
    pub fn of(config: &SecretProviderConfig) -> Self {
        Self {
            name: config.label.clone(),
            account: match classify(config) {
                ClassifiedProvider::OnePassword { account } => account,
                ClassifiedProvider::Unsupported => String::new(),
            },
        }
    }
}

/// Whether the form adds an entry or replaces one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Add,
    Edit(String),
}

/// What blocks a save, one message per field.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Issues {
    pub name: Option<String>,
    pub account: Option<String>,
}

/// A secret provider entry ready to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub account: String,
}

/// The entry a form adds or replaces, or every field that blocks it (`secretProviderFromDraft`).
///
/// # Errors
///
/// The messages Conn shows under the fields.
pub fn entry_from_draft(
    draft: &Draft,
    existing_ids: &[String],
    target: &Target,
) -> Result<Entry, Issues> {
    let label = draft.name.trim();
    let account = draft.account.trim();
    let mut issues = Issues::default();
    let mut id = None;
    if label.is_empty() {
        issues.name = Some("Enter a name.".to_owned());
    } else if label.chars().count() > NAME_MAX_CHARS {
        issues.name = Some(format!("Use {NAME_MAX_CHARS} characters or fewer."));
    } else {
        id = match target {
            Target::Edit(id) => Some(id.clone()),
            Target::Add => provider_id_from_name(label),
        };
        match (&id, target) {
            (None, _) => {
                issues.name = Some("The name needs at least one letter or digit.".to_owned());
            }
            (Some(id), Target::Add) if existing_ids.contains(id) => {
                issues.name = Some("A secret provider with this name exists.".to_owned());
            }
            _ => {}
        }
    }
    if account.is_empty() {
        issues.account = Some("Enter the 1Password account.".to_owned());
    } else if let Some(issue) = account_issue(account) {
        issues.account = Some(issue.to_owned());
    }
    match id {
        Some(id) if issues == Issues::default() => Ok(Entry {
            id,
            label: label.to_owned(),
            account: account.to_owned(),
        }),
        _ => Err(issues),
    }
}

/// `server.updateSettings` payload that sets one provider.
#[must_use]
pub fn set_request(entry: &Entry) -> Value {
    json!({
        "patch": {
            "secretProviders": {
                entry.id.as_str(): {
                    "kind": ONE_PASSWORD_KIND,
                    "label": entry.label,
                    "config": { "account": entry.account },
                },
            },
        },
    })
}

/// `server.updateSettings` payload that removes one provider. The server unsets what read from
/// it (`withoutRemovedSecretProviderReferences`).
#[must_use]
pub fn remove_request(id: &str) -> Value {
    json!({ "patch": { "secretProviders": { id: Value::Null } } })
}

/// `server.checkSecretSource` payload: asks the server to resolve one committed reference.
#[must_use]
pub fn check_request(provider: &str, reference: &str) -> Value {
    json!({ "source": { "provider": provider, "reference": reference } })
}

/// The answer of `server.checkSecretSource`: `Ok` when it resolved, else Conn's detail text
/// (`SecretCheckButton`).
///
/// # Errors
///
/// The `detail` of a `Failed` answer, or a note for an answer this client does not know.
pub fn check_outcome(result: &Value) -> Result<(), String> {
    match result.get("_tag").and_then(Value::as_str) {
        Some("Resolved") => Ok(()),
        Some("Failed") => Err(result
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("The secret did not resolve.")
            .to_owned()),
        _ => Err("Could not reach the server".to_owned()),
    }
}

/// What reads from a secret provider, one readable name per field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretUse {
    pub id: String,
    pub label: String,
}

fn is_reference_of(value: &Value, provider: &str) -> bool {
    value.as_object().is_some_and(|o| {
        o.get("provider").and_then(Value::as_str) == Some(provider)
            && o.get("reference").is_some_and(Value::is_string)
    })
}

/// `camelCase` as `Camel case`.
fn humanize(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
            out.extend(c.to_lowercase());
        } else if i == 0 {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Every reference to `provider` in `owner`'s fields: the field name, and the key of the map it
/// sits in (`tokens` by host) when it sits in one.
fn references_in(owner: &Value, provider: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    for (field, value) in owner.as_object().into_iter().flatten() {
        if is_reference_of(value, provider) {
            out.push((field.clone(), None));
        } else if let Value::Object(entries) = value {
            for (key, entry) in entries {
                if is_reference_of(entry, provider) {
                    out.push((field.clone(), Some(key.clone())));
                }
            }
        }
    }
    out
}

fn source_control_label(kind: &str) -> String {
    match kind {
        "github" => "GitHub".to_owned(),
        "gitlab" => "GitLab".to_owned(),
        "bitbucket" => "Bitbucket".to_owned(),
        "azure-devops" | "azureDevOps" => "Azure DevOps".to_owned(),
        "forgejo" => "Forgejo".to_owned(),
        other => humanize(other),
    }
}

fn voice_label(provider: &str) -> &str {
    match provider {
        "openai" => "OpenAI",
        "xai" => "Grok Voice Transcribe",
        "openrouter" => "OpenRouter",
        other => other,
    }
}

fn owner_use(id: String, owner: &str, found: Vec<(String, Option<String>)>) -> Vec<SecretUse> {
    found
        .into_iter()
        .map(|(field, key)| {
            let tail = key.clone().unwrap_or_else(|| humanize(&field));
            SecretUse {
                id: format!("{id}:{field}:{}", key.unwrap_or_default()),
                label: format!("{owner} \u{b7} {tail}"),
            }
        })
        .collect()
}

/// What reads from secret provider `provider_id`, one readable name per field, in settings
/// order: provider instances (config fields and variables), source control hosts, usage limit
/// sources, text generators, device hosts and voice credentials (`secretProviderUses`).
#[must_use]
pub fn secret_provider_uses(settings: &ServerSettings, provider_id: &str) -> Vec<SecretUse> {
    let Ok(Value::Object(root)) = serde_json::to_value(settings) else {
        return Vec::new();
    };
    let empty = Map::new();
    let section = |name: &str| root.get(name).and_then(Value::as_object).unwrap_or(&empty);
    let mut uses = Vec::new();

    for (instance_id, instance) in section("providerInstances") {
        let driver = instance
            .get("driver")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let def = driver_def(driver);
        let owner = instance
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .or_else(|| def.map(|def| def.label))
            .unwrap_or(instance_id);
        if let Some(Value::Object(config)) = instance.get("config") {
            for (field, value) in config {
                if is_reference_of(value, provider_id) {
                    let title = def
                        .and_then(|def| def.fields.iter().find(|f| f.key == field))
                        .map_or_else(|| humanize(field), |f| f.title.to_owned());
                    uses.push(SecretUse {
                        id: format!("provider:{instance_id}:{field}:"),
                        label: format!("{owner} \u{b7} {title}"),
                    });
                }
            }
        }
        for variable in instance
            .get("environment")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let reads = [variable.get("secret"), variable.get("value")]
                .into_iter()
                .flatten()
                .any(|v| is_reference_of(v, provider_id));
            if let (true, Some(name)) = (reads, variable.get("name").and_then(Value::as_str)) {
                uses.push(SecretUse {
                    id: format!("provider:{instance_id}:env:{name}"),
                    label: format!("{owner} \u{b7} {name}"),
                });
            }
        }
    }
    for (kind, host) in section("sourceControlHosts") {
        let found = references_in(host, provider_id);
        uses.extend(owner_use(
            format!("source-control:{kind}"),
            &source_control_label(kind),
            found,
        ));
    }
    for (id, source) in section("usageLimitSources") {
        let owner = ["label", "url"]
            .iter()
            .find_map(|k| source.get(k).and_then(Value::as_str))
            .unwrap_or(id);
        uses.extend(owner_use(
            format!("usage-limit:{id}"),
            owner,
            references_in(source, provider_id),
        ));
    }
    for (id, generator) in section("textGenerators") {
        let owner = ["label", "baseUrl"]
            .iter()
            .find_map(|k| generator.get(k).and_then(Value::as_str))
            .unwrap_or(id);
        uses.extend(owner_use(
            format!("text-generator:{id}"),
            owner,
            references_in(generator, provider_id),
        ));
    }
    for (prefix, name) in [("eas", "easDeviceHosts"), ("simlock", "simlockDeviceHosts")] {
        for host in root
            .get(name)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = host.get("id").and_then(Value::as_str).unwrap_or_default();
            let owner = host.get("label").and_then(Value::as_str).unwrap_or(id);
            uses.extend(owner_use(
                format!("{prefix}:{id}"),
                owner,
                references_in(host, provider_id),
            ));
        }
    }
    for (provider, credential) in section("cloudSpeechCredentials") {
        if is_reference_of(credential, provider_id) {
            uses.push(SecretUse {
                id: format!("voice:{provider}"),
                label: format!("Voice \u{b7} {}", voice_label(provider)),
            });
        }
    }
    uses
}

const REDACTED_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// A stand-in with the same shape as `value` and the same letters every time, shown until the
/// account is revealed (`redactedPlaceholder`, FNV-1a and a murmur finalizer on 32 bits).
#[must_use]
pub fn redacted_placeholder(value: &str) -> String {
    let mut state = 0x811c_9dc5_u32.cast_signed();
    for unit in value.encode_utf16() {
        state ^= i32::from(unit);
        state = state.wrapping_mul(0x0100_0193);
    }
    value
        .chars()
        .map(|c| {
            if matches!(c, '@' | '.' | '-' | '_') {
                return c;
            }
            state = (state ^ (state.cast_unsigned() >> 13).cast_signed())
                .wrapping_mul(0x85eb_ca6b_u32.cast_signed());
            state = (state ^ (state.cast_unsigned() >> 16).cast_signed())
                .wrapping_mul(0xc2b2_ae35_u32.cast_signed());
            let index = state.unsigned_abs() as usize % REDACTED_ALPHABET.len();
            REDACTED_ALPHABET.get(index).map_or('x', |b| char::from(*b))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(kind: &str, account: &str) -> SecretProviderConfig {
        serde_json::from_value(
            json!({ "kind": kind, "label": "Work", "config": { "account": account } }),
        )
        .expect("config")
    }

    #[test]
    fn classifies_only_valid_one_password_accounts() {
        assert_eq!(
            classify(&config("one_password", "my.1password.com")),
            ClassifiedProvider::OnePassword {
                account: "my.1password.com".to_owned()
            }
        );
        for bad in [
            config("one_password", "-flag"),
            config("one_password", "has space"),
            config("vault", "x"),
        ] {
            assert_eq!(classify(&bad), ClassifiedProvider::Unsupported, "{bad:?}");
        }
    }

    #[test]
    fn ids_come_from_names_the_way_conn_slugs_them() {
        assert_eq!(
            provider_id_from_name("1Password"),
            Some("1password".to_owned())
        );
        assert_eq!(
            provider_id_from_name("  My  Work -- Vault!"),
            Some("my-work-vault".to_owned())
        );
        assert_eq!(provider_id_from_name("***"), None);
        assert_eq!(
            provider_id_from_name(&"a".repeat(80)).map(|s| s.len()),
            Some(64)
        );
    }

    #[test]
    fn a_draft_names_every_field_that_blocks_it() {
        let add = |name: &str, account: &str, existing: &[&str]| {
            entry_from_draft(
                &Draft {
                    name: name.to_owned(),
                    account: account.to_owned(),
                },
                &existing.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
                &Target::Add,
            )
        };
        assert_eq!(
            add(" ", "", &[]),
            Err(Issues {
                name: Some("Enter a name.".to_owned()),
                account: Some("Enter the 1Password account.".to_owned()),
            })
        );
        assert_eq!(
            add("!!", "ok", &[]).unwrap_err().name.as_deref(),
            Some("The name needs at least one letter or digit.")
        );
        assert_eq!(
            add("Work", "ok", &["work"]).unwrap_err().name.as_deref(),
            Some("A secret provider with this name exists.")
        );
        assert!(add("Work", "has space", &[]).unwrap_err().account.is_some());
        let entry = add(" Work vault ", " my.1password.com ", &["other"]).expect("valid");
        assert_eq!(
            entry,
            Entry {
                id: "work-vault".to_owned(),
                label: "Work vault".to_owned(),
                account: "my.1password.com".to_owned()
            }
        );
        // Editing keeps the id, so renaming never orphans the variables that read from it.
        let edited = entry_from_draft(
            &Draft {
                name: "Renamed".to_owned(),
                account: "a.b".to_owned(),
            },
            &["work-vault".to_owned()],
            &Target::Edit("work-vault".to_owned()),
        )
        .expect("valid edit");
        assert_eq!(edited.id, "work-vault");
    }

    #[test]
    fn requests_set_or_remove_one_entry() {
        let entry = Entry {
            id: "work".to_owned(),
            label: "Work".to_owned(),
            account: "a.b".to_owned(),
        };
        assert_eq!(
            set_request(&entry),
            json!({ "patch": { "secretProviders": { "work": { "kind": "one_password", "label": "Work", "config": { "account": "a.b" } } } } })
        );
        assert_eq!(
            remove_request("work"),
            json!({ "patch": { "secretProviders": { "work": null } } })
        );
    }

    #[test]
    fn uses_name_what_reads_from_a_provider() {
        let settings: ServerSettings = serde_json::from_value(json!({
            "providerInstances": {
                "oc": {
                    "driver": "opencode",
                    "displayName": "Work OpenCode",
                    "config": { "serverPassword": { "provider": "work", "reference": "op://v/i/f" }, "binaryPath": "x" },
                    "environment": [
                        { "name": "API_KEY", "value": "", "sensitive": true, "secret": { "provider": "work", "reference": "op://v/i/k" } },
                        { "name": "OTHER", "value": "x", "sensitive": false },
                        { "name": "ELSEWHERE", "value": "", "sensitive": true, "secret": { "provider": "home", "reference": "op://v/i/k" } }
                    ]
                }
            },
            "sourceControlHosts": { "github": { "tokens": { "github.com": { "provider": "work", "reference": "op://v/gh/token" } } } },
            "cloudSpeechCredentials": { "openai": { "provider": "work", "reference": "op://v/ai/key" } }
        }))
        .expect("settings");
        let labels: Vec<String> = secret_provider_uses(&settings, "work")
            .into_iter()
            .map(|u| u.label)
            .collect();
        assert_eq!(labels.len(), 4, "{labels:?}");
        assert!(
            labels.contains(&"Work OpenCode \u{b7} API_KEY".to_owned()),
            "{labels:?}"
        );
        assert!(
            labels.contains(&"GitHub \u{b7} github.com".to_owned()),
            "{labels:?}"
        );
        assert!(
            labels.contains(&"Voice \u{b7} OpenAI".to_owned()),
            "{labels:?}"
        );
        assert!(secret_provider_uses(&settings, "gone").is_empty());
    }

    #[test]
    fn a_check_resolves_or_says_why_not() {
        assert_eq!(
            check_request("work", "op://v/i/f"),
            json!({ "source": { "provider": "work", "reference": "op://v/i/f" } })
        );
        assert_eq!(check_outcome(&json!({ "_tag": "Resolved" })), Ok(()));
        assert_eq!(
            check_outcome(&json!({ "_tag": "Failed", "detail": "item not found" })),
            Err("item not found".to_owned())
        );
        assert_eq!(
            check_outcome(&json!({})),
            Err("Could not reach the server".to_owned())
        );
    }

    #[test]
    fn the_redacted_stand_in_keeps_the_shape_and_matches_conn() {
        // Values from `redactedPlaceholder` in RedactedSensitiveText.tsx.
        assert_eq!(redacted_placeholder("my.1password.com"), "9u.xknfjcab9.sde");
        assert_eq!(redacted_placeholder("Work_acct-1"), "n62z_qf3t-5");
        assert_eq!(redacted_placeholder("ab"), "y3");
    }
}
