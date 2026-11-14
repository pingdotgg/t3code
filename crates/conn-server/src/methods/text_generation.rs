//! `server.listTextGeneratorModels`: the models of a saved or an unsaved text generator, with
//! an optional one-prompt test (`TextGenerators.ts`). The client's "Add text generator" wizard
//! needs it to save. `crate::text_generation` holds the service.
//!
//! A deliberate difference from the T3 server: an unsaved config that carries the redaction
//! marker as its key gets the saved key only when the caller holds `providers:manage`, the
//! scope that changes text generators. Otherwise the server sends no key. The T3 server fills
//! the saved key in for any `settings:write` caller, whatever host the config names
//! (`TextGenerators.ts:133-138`), so that caller can send the key to a host of its choice.

use conn_contract::{ListTextGeneratorModelsInput, SettingsSecretValue, TextGeneratorError, lit};

use super::Deps;
use crate::{
    settings::SECRET_REDACTED,
    table::{CallContext, Failure, MethodTable},
};

/// The scope that may change text generators, and so may use a saved key with a new host.
const PROVIDERS_MANAGE: &str = "providers:manage";

/// Replaces the marker in an unsaved config with no key, unless the caller may change text
/// generators. A call without a session (tests, fixtures) keeps the marker, as scope checks
/// pass it.
fn withhold_saved_key(ctx: &CallContext, input: &mut ListTextGeneratorModelsInput) {
    let may_use_saved_key = ctx
        .principal
        .as_ref()
        .is_none_or(|p| p.has_scope(PROVIDERS_MANAGE));
    if may_use_saved_key {
        return;
    }
    if let Some(config) = &mut input.config
        && matches!(&config.api_key, Some(SettingsSecretValue::String(key)) if key == SECRET_REDACTED)
    {
        config.api_key = Some(SettingsSecretValue::String(String::new()));
    }
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(generators) = deps.text_generators.clone() else {
        return;
    };
    table.unary(
        "server.listTextGeneratorModels",
        move |ctx, mut input: ListTextGeneratorModelsInput| {
            let generators = generators.clone();
            withhold_saved_key(&ctx, &mut input);
            async move {
                // `TextGeneratorBaseUrl` refuses these at decode, before the handler.
                if let Some(config) = &input.config
                    && !crate::text_generation::valid_base_url(&config.base_url)
                {
                    return Err(Failure::die(
                        "invalid payload for `server.listTextGeneratorModels`: baseUrl must be an http or https URL without credentials, query or fragment",
                    ));
                }
                generators
                    .list_models(input)
                    .await
                    .map(|result| conn_contract::to_json(&result))
                    .map_err(|detail| {
                        Failure::fail(&TextGeneratorError {
                            tag: lit::TextGeneratorError,
                            detail,
                        })
                    })
            }
        },
    );
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{Value, json};

    use super::*;
    use crate::{
        auth::Principal,
        table::Handler,
        text_generation::tests::{Stub, fixture},
    };

    fn caller(scopes: &[&str]) -> CallContext {
        CallContext {
            principal: Some(Arc::new(Principal {
                session_id: "s".into(),
                subject: "u".into(),
                scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
                expires_at_ms: u64::MAX,
            })),
            ..CallContext::default()
        }
    }

    /// The edit form's Check after a changed host: the config names a new host and keeps the
    /// marker for the key.
    fn check_with_marker(base: &str) -> Value {
        json!({"id": "router", "config": {
            "kind": "openaiCompatible", "baseUrl": format!("{base}/new/v1"),
            "apiKey": SECRET_REDACTED, "enabled": true,
        }})
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_saved_key_goes_only_to_a_caller_who_may_change_generators() {
        let saved = Stub::start(|_| (200, json!({"data": []}).to_string())).await;
        let other = Stub::start(|_| (200, json!({"data": [{"id": "m"}]}).to_string())).await;
        let f = fixture(
            "scope",
            json!({"textGenerators": {"router": {
                "kind": "openaiCompatible", "baseUrl": format!("{}/v1", saved.base),
                "apiKey": "saved-key",
            }}}),
        );
        let deps = Deps {
            text_generators: Some(Arc::new(f.generators)),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let Some(Handler::Unary(handler)) = table.get("server.listTextGeneratorModels") else {
            panic!("not registered")
        };

        // `settings:write` alone may call the method, but gets no saved key.
        handler(caller(&["settings:write"]), check_with_marker(&other.base))
            .await
            .unwrap();
        let sent = other.taken();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].path, "/new/v1/models");
        assert_eq!(sent[0].header("authorization"), None, "no key");

        // The owner's Check after a changed host keeps working.
        let owner = caller(&["settings:write", "providers:manage"]);
        let result = handler(owner.clone(), check_with_marker(&other.base))
            .await
            .unwrap();
        assert_eq!(result["models"][0]["id"], "m");
        let sent = other.taken();
        assert_eq!(sent[0].header("authorization"), Some("Bearer saved-key"));

        // A typed key is the caller's own, so it is sent for either caller.
        let mut typed = check_with_marker(&other.base);
        typed["config"]["apiKey"] = json!("typed-key");
        handler(caller(&["settings:write"]), typed).await.unwrap();
        assert_eq!(
            other.taken()[0].header("authorization"),
            Some("Bearer typed-key")
        );
        assert!(saved.taken().is_empty());
    }
}
