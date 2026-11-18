//! The auth scope each RPC method needs. The table is generated (`scopes/generated.rs`, by
//! `tools/gen-upstream.mjs`) from `RPC_REQUIRED_SCOPES` in
//! `apps/server/src/auth/RpcAuthorization.ts` and `CLIENT_GUARDED_RPC_SCOPES` in
//! `packages/contracts/src/clientRpcPermissions.ts`. The rules that read the payload stay by
//! hand in [`from_payload`]; a test holds their list to the T3 server's.
//!
//! [`STRICTER`] is a short hand-written list of methods that need more than the T3 server
//! asks: deliberate differences, each with its reason. A test holds each entry to a superset of
//! the generated scope, so it can only add a need.
//!
//! `MethodTable` refuses to register a method without an entry here and checks the scope
//! before every call, so a handler cannot skip the decision. T3 leaves no method unguarded:
//! `server.probe` and the connect-time streams need `orchestration:read` like the rest.

use serde_json::{Map, Value, json};

use crate::{
    auth,
    table::{CallContext, Failure},
};

const ORCHESTRATION_READ: &str = "orchestration:read";
const ORCHESTRATION_OPERATE: &str = "orchestration:operate";
const FILESYSTEM_READ: &str = "filesystem:read";
const SETTINGS_WRITE: &str = "settings:write";
const PROVIDERS_MANAGE: &str = "providers:manage";
const ACCESS_WRITE: &str = "access:write";
const SOURCE_CONTROL_WRITE: &str = "source-control:write";
const FILESYSTEM_WRITE: &str = "filesystem:write";

mod generated;

use generated::{ACCESS_SETTINGS, PAYLOAD_RULES, PROVIDER_SETTINGS, SCOPES};

/// The methods [`from_payload`] decides. A test checks this list against the T3 server's own
/// (`generated::PAYLOAD_RULES`), so a new or dropped payload rule upstream fails the build.
#[cfg(test)]
const HAND_PAYLOAD_RULES: [&str; 9] = [
    "assets.createUrl",
    "device.easAccount",
    "device.simlockIdentity",
    "git.preparePullRequestThread",
    "git.runStackedAction",
    "projects.mutate",
    "server.listTextGeneratorModels",
    "server.retryResourceTelemetry",
    "server.updateSettings",
];

/// Methods that need more scopes than the T3 server asks, on purpose. Each entry lists every
/// scope the method needs, its generated scope included.
const STRICTER: &[(&str, &[&str])] = &[
    // A clone creates a folder and its parents at any path the caller names, such as
    // `~/.ssh`: a filesystem write. The T3 server asks only `source-control:write`.
    (
        "sourceControl.cloneRepository",
        &[SOURCE_CONTROL_WRITE, FILESYSTEM_WRITE],
    ),
];

/// Whether `tag` has an entry.
pub fn is_declared(tag: &str) -> bool {
    SCOPES.binary_search_by_key(&tag, |(t, _)| t).is_ok()
}

/// Fails with `EnvironmentAuthorizationError` unless the call's session holds every scope the
/// method needs. A call without a session (tests, fixtures) passes.
///
/// # Panics
///
/// When `tag` has no entry; the method table checks that when a handler registers.
#[expect(
    clippy::panic_in_result_fn,
    reason = "a tag without an entry is a bug that the method table rules out at start"
)]
pub fn check(tag: &str, ctx: &CallContext, payload: &Value) -> Result<(), Failure> {
    let Some(principal) = &ctx.principal else {
        return Ok(());
    };
    let stricter = STRICTER.iter().find(|(t, _)| *t == tag);
    let missing = match (stricter, from_payload(tag, payload)) {
        (Some((_, scopes)), _) => scopes.iter().copied().find(|s| !principal.has_scope(s)),
        (None, Some(scopes)) => scopes.into_iter().find(|s| !principal.has_scope(s)),
        (None, None) => {
            let (_, scope) = SCOPES[SCOPES
                .binary_search_by_key(&tag, |(t, _)| t)
                .unwrap_or_else(|_| panic!("`{tag}` has no entry in the scope table"))];
            (!principal.has_scope(scope)).then_some(scope)
        }
    };
    match missing {
        Some(scope) => Err(Failure::Fail(json!({
            "_tag": "EnvironmentAuthorizationError",
            "message": format!("The authenticated token is missing required scope: {scope}."),
            "requiredScope": auth::legacy_parent(scope),
            "requiredPermission": scope,
        }))),
        None => Ok(()),
    }
}

/// The scopes of the methods whose need depends on the payload, as `requiredScopesForRpcCall`
/// computes them. `None` for every other method, and for a payload too malformed to read: the
/// table scope applies and decoding then fails the call.
fn from_payload(tag: &str, payload: &Value) -> Option<Vec<&'static str>> {
    // A rule the T3 server dropped no longer applies, even before the hand code follows.
    if !PAYLOAD_RULES.contains(&tag) {
        return None;
    }
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(match tag {
        "server.retryResourceTelemetry" => vec!["environment:maintain", "diagnostics:read"],
        "assets.createUrl" => {
            let resource = &payload["resource"];
            let host_file = match text(resource, "_tag").as_deref() {
                Some("workspace-file" | "media-file" | "draft-workspace-file") => true,
                Some("native-app-icon") => {
                    text(&resource["app"], "_tag").as_deref() == Some("app-path")
                }
                _ => false,
            };
            vec![if host_file {
                FILESYSTEM_READ
            } else {
                ORCHESTRATION_READ
            }]
        }
        "server.updateSettings" => {
            let no_patch = Map::new();
            let patch = payload["patch"].as_object().unwrap_or(&no_patch);
            let mut scopes = settings_scopes(patch);
            if payload.get("providerInstanceMutation").is_some() {
                if patch.is_empty() {
                    scopes = vec![PROVIDERS_MANAGE];
                } else if !scopes.contains(&PROVIDERS_MANAGE) {
                    scopes.push(PROVIDERS_MANAGE);
                }
            }
            scopes
        }
        // Project scripts run on the host, so changing them takes settings authority too.
        "projects.mutate" => {
            let mut scopes = vec![ORCHESTRATION_OPERATE];
            if text(payload, "type").as_deref() != Some("project.delete")
                && payload.get("scripts").is_some()
            {
                scopes.push(SETTINGS_WRITE);
            }
            scopes
        }
        // These send the credential they are given to a URL the caller names, as a saved
        // setting would (`containsSecretReference`).
        "device.simlockIdentity" | "device.easAccount" | "server.listTextGeneratorModels"
            if contains_secret_reference(payload) =>
        {
            vec![SETTINGS_WRITE, PROVIDERS_MANAGE]
        }
        "git.preparePullRequestThread"
            if text(payload, "mode").as_deref() == Some("worktree")
                && payload.get("threadId").is_some() =>
        {
            vec![SOURCE_CONTROL_WRITE, ORCHESTRATION_OPERATE]
        }
        "git.runStackedAction"
            if payload.get("threadId").is_some()
                && matches!(
                    text(payload, "action").as_deref(),
                    Some("create_pr" | "commit_push_pr")
                ) =>
        {
            vec![SOURCE_CONTROL_WRITE, ORCHESTRATION_READ]
        }
        _ => return None,
    })
}

/// `containsSecretReference`: a `{ provider, reference }` anywhere in the payload.
fn contains_secret_reference(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            (map.get("provider").is_some_and(Value::is_string)
                && map.get("reference").is_some_and(Value::is_string))
                || map.values().any(contains_secret_reference)
        }
        Value::Array(items) => items.iter().any(contains_secret_reference),
        _ => false,
    }
}

/// `requiredScopesForServerSettingsPatch`: a patch needs the scope of every domain it changes.
fn settings_scopes(patch: &Map<String, Value>) -> Vec<&'static str> {
    let is_provider_key = |key: &String| PROVIDER_SETTINGS.contains(&key.as_str());
    let is_access_key = |key: &String| ACCESS_SETTINGS.contains(&key.as_str());
    let changes_providers = patch.keys().any(is_provider_key);
    let changes_access = patch.keys().any(is_access_key);
    // Removing a secret provider also clears the settings fields that read from it.
    let removes_secret_provider = patch
        .get("secretProviders")
        .and_then(Value::as_object)
        .is_some_and(|entries| entries.values().any(Value::is_null));
    let changes_settings = removes_secret_provider
        || patch
            .keys()
            .any(|k| !is_provider_key(k) && !is_access_key(k));
    let mut scopes = Vec::new();
    if changes_settings || (!changes_providers && !changes_access) {
        scopes.push(SETTINGS_WRITE);
    }
    if changes_providers {
        scopes.push(PROVIDERS_MANAGE);
    }
    if changes_access {
        scopes.push(ACCESS_WRITE);
    }
    scopes
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::auth::Principal;

    fn ctx(scopes: &[&str]) -> CallContext {
        CallContext {
            principal: Some(Arc::new(Principal {
                session_id: "me".into(),
                subject: "test".into(),
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                expires_at_ms: u64::MAX,
            })),
            ..CallContext::default()
        }
    }

    fn denied(scopes: &[&str], tag: &str, payload: Value) -> Option<Value> {
        match check(tag, &ctx(scopes), &payload) {
            Err(Failure::Fail(error)) => Some(error),
            Ok(()) => None,
            Err(other) => panic!("expected a typed failure, got {other:?}"),
        }
    }

    #[test]
    fn scopes_are_checked_with_the_legacy_parent() {
        assert!(denied(&["settings:write"], "server.upsertKeybinding", json!({})).is_none());
        let error = denied(
            &["orchestration:read"],
            "server.upsertKeybinding",
            json!({}),
        )
        .unwrap();
        assert_eq!(error["_tag"], "EnvironmentAuthorizationError");
        assert_eq!(error["requiredScope"], "orchestration:operate");
        assert_eq!(error["requiredPermission"], "settings:write");
        let none = check("subscribeAuthAccess", &CallContext::default(), &json!({}));
        assert_eq!(none, Ok(()));
    }

    #[test]
    fn some_scopes_depend_on_the_payload() {
        let read = ["orchestration:read"];
        let provider_patch = json!({"patch": {"providerInstances": {}}});
        let error = denied(
            &["settings:write"],
            "server.updateSettings",
            provider_patch.clone(),
        );
        assert_eq!(error.unwrap()["requiredPermission"], "providers:manage");
        assert!(
            denied(
                &["providers:manage"],
                "server.updateSettings",
                provider_patch
            )
            .is_none()
        );
        let mixed = json!({"patch": {"providerInstances": {}, "enableAgentBrowserAccess": true}});
        let error = denied(&["providers:manage"], "server.updateSettings", mixed);
        assert_eq!(error.unwrap()["requiredPermission"], "settings:write");

        // T3 Connect device approval is access, not settings.
        let access = json!({"patch": {"requireConnectDeviceApproval": true}});
        let error = denied(&["settings:write"], "server.updateSettings", access.clone());
        assert_eq!(error.unwrap()["requiredPermission"], "access:write");
        assert!(denied(&["access:write"], "server.updateSettings", access).is_none());
        let mixed = json!({"patch": {"requireConnectDeviceApproval": true, "enableAgentBrowserAccess": true}});
        let error = denied(&["access:write"], "server.updateSettings", mixed);
        assert_eq!(error.unwrap()["requiredPermission"], "settings:write");

        let media = json!({"resource": {"_tag": "media-file", "path": "/etc/hosts"}});
        let error = denied(&read, "assets.createUrl", media).unwrap();
        assert_eq!(error["requiredPermission"], "filesystem:read");
        let favicon = json!({"resource": {"_tag": "project-favicon", "cwd": "/a"}});
        assert!(denied(&read, "assets.createUrl", favicon).is_none());

        let operate = ["orchestration:operate"];
        let scripts = json!({"type": "project.update", "scripts": []});
        let error = denied(&operate, "projects.mutate", scripts).unwrap();
        assert_eq!(error["requiredPermission"], "settings:write");
        assert!(
            denied(
                &operate,
                "projects.mutate",
                json!({"type": "project.delete"})
            )
            .is_none()
        );
    }

    /// The table binary-searches by tag. Both this table and the contract are generated
    /// from the same Conn commit, so they list the same methods; when they do not, one
    /// generator ran without the other.
    #[test]
    fn every_method_of_the_contract_has_a_scope() {
        assert!(
            SCOPES.windows(2).all(|pair| pair[0].0 < pair[1].0),
            "sorted by tag"
        );
        for method in conn_contract::methods() {
            assert!(
                is_declared(&method.tag),
                "`{}` has no scope: run tools/gen-upstream.mjs",
                method.tag
            );
        }
        assert_eq!(
            SCOPES.len(),
            conn_contract::methods().len(),
            "scopes/generated.rs and the contract come from different Conn commits: \
             run tools/gen-upstream.mjs"
        );
    }

    /// A stricter rule only adds scopes, and a clone needs a filesystem write.
    #[test]
    fn stricter_rules_add_to_the_generated_scope() {
        for (tag, scopes) in STRICTER {
            let generated = SCOPES
                .iter()
                .find(|(t, _)| t == tag)
                .map(|(_, s)| *s)
                .unwrap_or_else(|| panic!("`{tag}` is not a method"));
            assert!(scopes.contains(&generated), "`{tag}` drops {generated}");
            assert!(
                !PAYLOAD_RULES.contains(tag),
                "`{tag}` has a payload rule too"
            );
        }
        let clone = "sourceControl.cloneRepository";
        let error = denied(&["source-control:write"], clone, json!({})).unwrap();
        assert_eq!(error["_tag"], "EnvironmentAuthorizationError");
        assert_eq!(error["requiredPermission"], "filesystem:write");
        assert_eq!(error["requiredScope"], "orchestration:operate");
        let error = denied(&["filesystem:write"], clone, json!({})).unwrap();
        assert_eq!(error["requiredPermission"], "source-control:write");
        assert!(
            denied(
                &["source-control:write", "filesystem:write"],
                clone,
                json!({})
            )
            .is_none()
        );
    }

    /// A payload rule the T3 server adds or drops must be followed in [`from_payload`].
    #[test]
    fn the_hand_payload_rules_follow_the_t3_server() {
        let mut generated = PAYLOAD_RULES.to_vec();
        generated.sort_unstable();
        assert_eq!(
            HAND_PAYLOAD_RULES.to_vec(),
            generated,
            "the T3 server's payload-dependent scope rules changed: follow \
             requiredScopesForRpcCall and clientRpcRequiredScopes in from_payload"
        );
        // Each hand rule answers for a payload that has none of the optional parts.
        for tag in HAND_PAYLOAD_RULES {
            assert!(is_declared(tag), "`{tag}`");
        }
    }

    #[test]
    fn caller_selected_secret_consumers_need_settings_and_provider_authority() {
        for method in [
            "device.easAccount",
            "device.simlockIdentity",
            "server.listTextGeneratorModels",
        ] {
            assert_eq!(
                from_payload(
                    method,
                    &json!({"nested": [{"provider": "vault", "reference": "token"}]})
                ),
                Some(vec![SETTINGS_WRITE, PROVIDERS_MANAGE])
            );
            assert_eq!(
                from_payload(method, &json!({"credential": "literal"})),
                None
            );
            assert_eq!(from_payload(method, &json!({"provider": "vault"})), None);
        }
    }

    /// The table `serve.rs` builds registers without a missing entry.
    #[test]
    fn the_served_table_registers_only_declared_methods() {
        let dir = std::env::temp_dir().join(format!("conn-server-scopes-{}", auth::random_hex(6)));
        let environment =
            crate::environment::Environment::load(&dir, None, dir.clone(), Default::default())
                .unwrap();
        let engine = conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(
            dir.join("engine.sqlite"),
        ))
        .unwrap();
        let deps = crate::methods::Deps {
            engine: Some(Arc::new(engine)),
            environment: Some(Arc::new(environment)),
            files: Some(Arc::new(conn_files::Files::open(&dir).unwrap())),
            ..Default::default()
        };
        let table = crate::method_table(&deps);
        assert!(table.get("server.probe").is_some());
        // The T3 server checks a scope inside these handlers, outside the table (the bump
        // report lists new ones). Serving one means applying that rule in the handler.
        const IN_HANDLER: &[(&str, &str)] = &[("requiredScopeForDeviceList", "device.list")];
        for &(rule, tag) in IN_HANDLER {
            if generated::IN_HANDLER_RULES.contains(&rule) {
                assert!(
                    table.get(tag).is_none(),
                    "`{tag}` is served: apply {rule} in its handler, then change this test"
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
