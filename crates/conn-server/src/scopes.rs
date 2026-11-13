//! The auth scope each RPC method needs, from `RPC_REQUIRED_SCOPES` in
//! `apps/server/src/auth/RpcAuthorization.ts` and `CLIENT_GUARDED_RPC_SCOPES` in
//! `packages/contracts/src/clientRpcPermissions.ts`.
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
const SOURCE_CONTROL_WRITE: &str = "source-control:write";

/// Every method of the contract with the scope it needs, sorted by tag. Entries of the
/// methods in [`from_payload`] are the scope T3 lists first; the payload decides the real one.
const SCOPES: &[(&str, &str)] = &[
    ("agentSessions.import", "orchestration:operate"),
    ("agentSessions.scan", "orchestration:read"),
    ("annotations.create", "preview:operate"),
    ("annotations.remove", "preview:operate"),
    ("annotations.subscribe", "orchestration:read"),
    ("assets.createUrl", "orchestration:read"),
    ("assets.persistChatAttachments", "orchestration:operate"),
    ("attachments.createUploadUrl", "orchestration:operate"),
    ("attachments.delete", "orchestration:operate"),
    ("cloud.getRelayClientStatus", "relay:read"),
    ("cloud.installRelayClient", "relay:write"),
    ("credentials.fillForSite", "preview:operate"),
    ("credentials.listForSite", "preview:operate"),
    ("device.action", "orchestration:operate"),
    ("device.close", "orchestration:operate"),
    ("device.configure", "settings:write"),
    ("device.detail", "orchestration:read"),
    ("device.easAccount", "settings:write"),
    ("device.list", "orchestration:read"),
    ("device.open", "orchestration:operate"),
    ("device.shutdown", "orchestration:operate"),
    ("device.simlockIdentity", "settings:write"),
    ("device.testHost", "settings:write"),
    ("filesystem.browse", "filesystem:read"),
    ("filesystem.getMetadata", "filesystem:read"),
    ("git.preparePullRequestThread", "source-control:write"),
    ("git.resolvePullRequest", "orchestration:read"),
    ("git.runStackedAction", "source-control:write"),
    ("guestShare.create", "access:write"),
    ("mcpApps.callTool", "orchestration:operate"),
    ("mcpApps.readResource", "orchestration:read"),
    ("mcpApps.toolInfo", "orchestration:read"),
    ("mcpApps.updateModelContext", "orchestration:operate"),
    ("orchestration.dispatchCommand", "orchestration:operate"),
    ("orchestration.forceStopThread", "orchestration:operate"),
    (
        "orchestration.getArchivedShellSnapshot",
        "orchestration:read",
    ),
    ("orchestration.getFullThreadDiff", "orchestration:read"),
    ("orchestration.getNativeChildWork", "orchestration:read"),
    ("orchestration.getOlderSettledThreads", "orchestration:read"),
    ("orchestration.getThreadFamily", "orchestration:read"),
    ("orchestration.getThreadLinkMetadata", "orchestration:read"),
    ("orchestration.getThreadProjection", "orchestration:read"),
    ("orchestration.getThreadTitles", "orchestration:read"),
    ("orchestration.getTurnDiff", "orchestration:read"),
    ("orchestration.getTurnItem", "orchestration:read"),
    ("orchestration.getWorkflowScript", "orchestration:read"),
    ("orchestration.getWorktreeThreadIds", "orchestration:read"),
    ("orchestration.launchThread", "orchestration:operate"),
    ("orchestration.searchThread", "orchestration:read"),
    ("orchestration.searchThreadStream", "orchestration:read"),
    ("orchestration.searchThreads", "orchestration:read"),
    ("orchestration.stopWorkflow", "orchestration:operate"),
    ("orchestration.subscribeCommandOutput", "orchestration:read"),
    (
        "orchestration.subscribePromptSuggestion",
        "orchestration:read",
    ),
    ("orchestration.subscribeShell", "orchestration:read"),
    ("orchestration.subscribeThread", "orchestration:read"),
    ("panels.requests", "preview:operate"),
    ("panels.respond", "preview:operate"),
    ("peerLinks.answerRequest", "access:write"),
    ("peerLinks.link", "access:write"),
    ("peerLinks.list", "access:read"),
    ("peerLinks.unlink", "access:write"),
    ("preview.adjust", "preview:operate"),
    ("preview.clearProfile", "preview:operate"),
    ("preview.close", "preview:operate"),
    ("preview.desktopRegister", "preview:operate"),
    ("preview.desktopRequests", "preview:operate"),
    ("preview.desktopRespond", "preview:operate"),
    ("preview.list", "orchestration:read"),
    ("preview.open", "preview:operate"),
    ("preview.reportProfiles", "preview:operate"),
    ("preview.reportStatus", "preview:operate"),
    ("preview.resize", "preview:operate"),
    ("preview.stopLocalServer", "terminal:operate"),
    ("projectClone.cancel", "source-control:write"),
    ("projectClone.retry", "source-control:write"),
    ("projectClone.start", "source-control:write"),
    ("projects.createFromThread", "orchestration:operate"),
    ("projects.createNew", "orchestration:operate"),
    ("projects.ensureScratch", "orchestration:operate"),
    ("projects.listEntries", "filesystem:read"),
    ("projects.listIgnoredFiles", "filesystem:read"),
    ("projects.mutate", "orchestration:operate"),
    ("projects.readFile", "filesystem:read"),
    ("projects.searchContents", "filesystem:read"),
    ("projects.searchEntries", "filesystem:read"),
    ("projects.writeFile", "filesystem:write"),
    ("provider.auth.cancel", "providers:manage"),
    ("provider.auth.complete", "providers:manage"),
    ("provider.auth.logout", "providers:manage"),
    ("provider.auth.removeMethod", "providers:manage"),
    ("provider.auth.respond", "providers:manage"),
    ("provider.auth.start", "providers:manage"),
    ("provider.auth.subscribe", "providers:manage"),
    ("provider.chatgpt.handoff.subscribe", "providers:manage"),
    ("provider.chatgpt.import-profile", "providers:manage"),
    ("provider.chatgpt.reconnect-profile", "providers:manage"),
    ("provider.consumeResetCredit", "providers:manage"),
    ("provider.install.cancel", "providers:manage"),
    ("provider.install.remove", "providers:manage"),
    ("provider.install.start", "providers:manage"),
    ("provider.install.subscribe", "orchestration:read"),
    ("provider.uploadFeedback", "orchestration:operate"),
    ("pullRequests.activity", "orchestration:read"),
    ("pullRequests.changeBreakdown", "orchestration:read"),
    ("pullRequests.checks", "orchestration:read"),
    ("pullRequests.comment", "source-control:write"),
    ("pullRequests.detail", "orchestration:read"),
    ("pullRequests.diffFileContents", "orchestration:read"),
    ("pullRequests.filesViewed", "orchestration:read"),
    ("pullRequests.filterOptions", "orchestration:read"),
    ("pullRequests.generateReviewGuide", "orchestration:operate"),
    ("pullRequests.invalidate", "orchestration:read"),
    ("pullRequests.labelCandidates", "orchestration:read"),
    ("pullRequests.linkedThreads", "orchestration:read"),
    ("pullRequests.list", "orchestration:read"),
    ("pullRequests.listStats", "orchestration:read"),
    ("pullRequests.preview", "orchestration:read"),
    ("pullRequests.replyToThread", "source-control:write"),
    ("pullRequests.reportState", "orchestration:read"),
    ("pullRequests.requestReviewers", "source-control:write"),
    ("pullRequests.reviewGuide", "orchestration:read"),
    ("pullRequests.reviewerCandidates", "orchestration:read"),
    ("pullRequests.routing", "orchestration:read"),
    ("pullRequests.routingIdentity", "orchestration:read"),
    ("pullRequests.runAction", "source-control:write"),
    ("pullRequests.setFilesViewed", "source-control:write"),
    ("pullRequests.setLabels", "source-control:write"),
    ("pullRequests.setReaction", "source-control:write"),
    ("pullRequests.setThreadResolution", "source-control:write"),
    ("pullRequests.stack", "orchestration:read"),
    ("pullRequests.submitReview", "source-control:write"),
    ("pullRequests.subscribeRefreshes", "orchestration:read"),
    ("pullRequests.summary", "orchestration:read"),
    ("pullRequests.threadComments", "orchestration:read"),
    ("pullRequests.update", "source-control:write"),
    ("pullRequests.updateComment", "source-control:write"),
    ("review.getBranchCommits", "filesystem:read"),
    ("review.getDiffFileContents", "filesystem:read"),
    ("review.getDiffPreview", "filesystem:read"),
    ("scheduledTasks.delete", "orchestration:operate"),
    ("scheduledTasks.getWebhookDelivery", "orchestration:operate"),
    (
        "scheduledTasks.listWebhookDeliveries",
        "orchestration:operate",
    ),
    ("scheduledTasks.rotateWebhookToken", "orchestration:operate"),
    ("scheduledTasks.runNow", "orchestration:operate"),
    ("scheduledTasks.setEnabled", "orchestration:operate"),
    ("scheduledTasks.subscribe", "orchestration:read"),
    ("scheduledTasks.upsert", "orchestration:operate"),
    ("secrets.answerRequest", "orchestration:operate"),
    ("server.acceptAcpRegistryUrlAuth", "providers:manage"),
    ("server.checkOtlpEndpoint", "settings:write"),
    ("server.checkSecretSource", "settings:write"),
    ("server.commitDesktopUpdate", "environment:maintain"),
    ("server.deleteAcpRegistrySession", "orchestration:operate"),
    ("server.disableAcpRegistryProvider", "providers:manage"),
    ("server.discoverSourceControl", "orchestration:read"),
    ("server.getConfig", "orchestration:read"),
    ("server.getDatabaseStorage", "orchestration:read"),
    ("server.getHostResources", "orchestration:read"),
    ("server.getNpmRelease", "orchestration:read"),
    ("server.getProcessDiagnostics", "diagnostics:read"),
    ("server.getProcessResourceHistory", "diagnostics:read"),
    ("server.getResourceTelemetryHistory", "diagnostics:read"),
    ("server.getStorageCleanupReport", "orchestration:read"),
    ("server.getTraceDiagnostics", "diagnostics:read"),
    ("server.getUsageSummary", "diagnostics:read"),
    ("server.importAcpRegistrySession", "orchestration:operate"),
    ("server.listAcpRegistryProviders", "orchestration:read"),
    ("server.listAcpRegistrySessions", "orchestration:read"),
    ("server.listTextGeneratorModels", "settings:write"),
    ("server.logoutAcpRegistry", "providers:manage"),
    ("server.prepareAcpRegistryAgent", "providers:manage"),
    ("server.prepareTriage", "orchestration:operate"),
    ("server.probe", "orchestration:read"),
    ("server.reclaimDatabaseSpace", "environment:maintain"),
    ("server.refreshProviders", "orchestration:read"),
    ("server.refreshUsageRates", "diagnostics:read"),
    ("server.removeKeybinding", "settings:write"),
    ("server.reportClientActivity", "orchestration:read"),
    ("server.restart", "environment:maintain"),
    ("server.retryResourceTelemetry", "diagnostics:read"),
    ("server.runStorageCleanup", "settings:write"),
    ("server.searchAcpRegistry", "orchestration:read"),
    ("server.setAcpRegistryProvider", "providers:manage"),
    ("server.signalProcess", "environment:maintain"),
    (
        "server.uninstallAcpRegistryManagedBinary",
        "providers:manage",
    ),
    ("server.updateProvider", "providers:manage"),
    ("server.updateServer", "environment:maintain"),
    ("server.updateServerWithProgress", "environment:maintain"),
    ("server.updateSettings", "settings:write"),
    ("server.upsertKeybinding", "settings:write"),
    ("shell.openInEditor", "orchestration:operate"),
    ("sourceControl.appAccess", "orchestration:read"),
    ("sourceControl.cloneRepository", "source-control:write"),
    ("sourceControl.lookupRepository", "orchestration:read"),
    ("sourceControl.publishRepository", "source-control:write"),
    ("sourceControl.signInCancel", "settings:write"),
    ("sourceControl.signInStart", "settings:write"),
    ("sourceControl.signInWait", "settings:write"),
    ("sourceControl.star", "source-control:write"),
    ("sourceControl.starred", "orchestration:read"),
    ("subscribeAuthAccess", "access:read"),
    ("subscribeDeviceState", "orchestration:read"),
    ("subscribeDiscoveredLocalServers", "orchestration:read"),
    ("subscribePreviewEvents", "orchestration:read"),
    ("subscribeProjectClones", "orchestration:read"),
    ("subscribeResourceTelemetry", "diagnostics:read"),
    ("subscribeServerConfig", "orchestration:read"),
    ("subscribeServerLifecycle", "orchestration:read"),
    ("subscribeTerminalMetadata", "terminal:read"),
    ("subscribeVcsBranch", "orchestration:read"),
    ("subscribeVcsStatus", "orchestration:read"),
    ("subscribeWorktreeSetup", "orchestration:read"),
    ("terminal.attach", "terminal:operate"),
    ("terminal.clear", "terminal:operate"),
    ("terminal.close", "terminal:operate"),
    ("terminal.observe", "terminal:read"),
    ("terminal.open", "terminal:operate"),
    ("terminal.resize", "terminal:operate"),
    ("terminal.write", "terminal:operate"),
    ("testLogins.list", "settings:write"),
    ("testLogins.remove", "settings:write"),
    ("testLogins.reveal", "settings:write"),
    ("testLogins.save", "settings:write"),
    ("testLogins.update", "settings:write"),
    ("vcs.createRef", "source-control:write"),
    ("vcs.createWorktree", "source-control:write"),
    ("vcs.init", "source-control:write"),
    ("vcs.listRefs", "orchestration:read"),
    ("vcs.pull", "source-control:write"),
    ("vcs.refreshBranch", "orchestration:read"),
    ("vcs.refreshStatus", "orchestration:read"),
    ("vcs.removeWorktree", "source-control:write"),
    ("vcs.switchRef", "source-control:write"),
    ("worktreeSetup.cancel", "orchestration:operate"),
];

/// Settings keys that need `providers:manage`; any other key needs `settings:write`.
const PROVIDER_SETTINGS: [&str; 5] = [
    "providers",
    "providerInstances",
    "usageLimitSources",
    "textGenerators",
    "secretProviders",
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
pub fn check(tag: &str, ctx: &CallContext, payload: &Value) -> Result<(), Failure> {
    let Some(principal) = &ctx.principal else {
        return Ok(());
    };
    let missing = match from_payload(tag, payload) {
        Some(scopes) => scopes.into_iter().find(|s| !principal.has_scope(s)),
        None => {
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

/// `requiredScopesForServerSettingsPatch`: a patch needs the scope of every domain it changes.
fn settings_scopes(patch: &Map<String, Value>) -> Vec<&'static str> {
    let is_provider_key = |key: &String| PROVIDER_SETTINGS.contains(&key.as_str());
    let changes_providers = patch.keys().any(is_provider_key);
    // Removing a secret provider also clears the settings fields that read from it.
    let removes_secret_provider = patch
        .get("secretProviders")
        .and_then(Value::as_object)
        .is_some_and(|entries| entries.values().any(Value::is_null));
    let changes_settings = removes_secret_provider || patch.keys().any(|k| !is_provider_key(k));
    let mut scopes = Vec::new();
    if changes_settings || !changes_providers {
        scopes.push(SETTINGS_WRITE);
    }
    if changes_providers {
        scopes.push(PROVIDERS_MANAGE);
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
        let mixed = json!({"patch": {"providerInstances": {}, "enableAssistantStreaming": true}});
        let error = denied(&["providers:manage"], "server.updateSettings", mixed);
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

    /// Registration needs a scope for every method a handler may register, and the table
    /// binary-searches by tag.
    #[test]
    fn every_method_of_the_contract_has_a_scope() {
        assert!(
            SCOPES.windows(2).all(|pair| pair[0].0 < pair[1].0),
            "sorted by tag"
        );
        for method in conn_contract::methods() {
            assert!(is_declared(&method.tag), "`{}` has no scope", method.tag);
        }
        assert_eq!(
            SCOPES.len(),
            conn_contract::methods().len(),
            "stale entries"
        );
    }

    /// The table `serve.rs` builds registers without a missing entry.
    #[test]
    fn the_served_table_registers_only_declared_methods() {
        let dir = std::env::temp_dir().join(format!("conn-server-scopes-{}", auth::random_hex(6)));
        let environment = crate::environment::Environment::load(&dir, None, dir.clone()).unwrap();
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
        std::fs::remove_dir_all(dir).unwrap();
    }
}
