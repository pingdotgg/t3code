//! The models one thread may pick (`buildModelOptions` in Conn mobile's `lib/modelOptions.ts`,
//! `serverConfigForCwd`, `resolveProjectProviderInstanceEnabled`), and when to ask the server to
//! scan the thread's workspace for them (`planProviderWorkspaceSnapshotRefresh` in
//! `client-runtime/src/providerSkills.ts`).
//!
//! It narrows [`ServerConfigState`]'s catalog to a thread, so every client's model picker offers
//! the same models: the project's provider switches, a started thread's continuation group, and
//! the models a project's own provider config adds in its workspace.

use conn_contract::{
    ServerProvidersItemItem as Provider, ServerProvidersItemItemWorkspaceSnapshotsItem as Snapshot,
    ServerSettings,
};

use crate::model_preferences::ModelPreferences;
use crate::provider_settings::settings_instance_enabled;
use crate::providers::{ModelCatalog, ProviderGroup, ServerConfigState};
use crate::thread::parse_iso8601_epoch_ms;

/// `PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS`: a snapshot older than this is rescanned.
pub const WORKSPACE_SNAPSHOT_TTL_MS: i64 = 5 * 60_000;
/// `WORKSPACE_SNAPSHOT_RETRY_COOLDOWN_MS`: a failed scan waits this long before the next one.
pub const WORKSPACE_SCAN_RETRY_COOLDOWN_MS: i64 = 10_000;
/// `WORKSPACE_SNAPSHOT_MAX_ATTEMPTS`: a cwd that never scans, such as a deleted worktree, would
/// otherwise retry forever.
pub const WORKSPACE_SCAN_MAX_ATTEMPTS: u32 = 3;

/// The thread a model picker serves.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ThreadModelScope<'a> {
    /// The thread's project; its provider switches apply.
    pub project_id: Option<&'a str>,
    /// The worktree, else the project root: its workspace snapshot's models apply.
    pub cwd: Option<&'a str>,
    /// A started thread's provider instance. Only it and its continuation group stay offered.
    pub locked_instance_id: Option<&'a str>,
}

impl ServerConfigState {
    /// The catalog of what `scope`'s thread may pick (`buildModelOptions`): providers resolved for
    /// its cwd, switched on or off for its project, and narrowed to a started thread's
    /// continuation group. Offer checks go through [`ProviderGroup::offers_models`] and
    /// [`ModelCatalog::offers`].
    #[must_use]
    pub fn thread_catalog(&self, scope: &ThreadModelScope<'_>) -> ModelCatalog {
        let providers = providers_for_cwd(self.providers(), scope.cwd);
        let locked = scope
            .locked_instance_id
            .and_then(|id| providers.iter().find(|provider| provider.instance_id == id));
        let items: Vec<Option<Provider>> = providers
            .iter()
            .filter(|provider| matches_locked_provider(provider, scope.locked_instance_id, locked))
            .map(|provider| {
                let mut provider = provider.clone();
                if let Some(settings) = self.settings() {
                    provider.enabled = project_instance_enabled(
                        settings,
                        scope.project_id,
                        &provider.instance_id,
                        provider.enabled,
                    );
                }
                Some(provider)
            })
            .collect();
        let preferences = self
            .settings()
            .map(ModelPreferences::from_settings)
            .unwrap_or_default();
        ModelCatalog::from_providers(&items).with_preferences(preferences)
    }
}

impl ProviderGroup {
    /// `buildModelOptions` lists a provider's models only when it is on, installed, signed in, and
    /// (for Antigravity) available.
    #[must_use]
    pub fn offers_models(&self) -> bool {
        self.enabled
            && self.installed
            && !self.unauthenticated
            && !(self.driver == "antigravity" && !self.available)
    }
}

impl ModelCatalog {
    /// `canCommitPendingModel`: `instance_id` offers `slug` and the user has not hidden it.
    #[must_use]
    pub fn offers(&self, instance_id: &str, slug: &str) -> bool {
        self.providers
            .iter()
            .filter(|group| group.instance_id == instance_id && group.offers_models())
            .flat_map(|group| group.models.iter())
            .any(|model| model.slug == slug && !self.is_hidden(model))
    }
}

/// `resolveProjectProviderInstanceEnabled`: the project's own switch wins, then the machine's
/// instance setting. A server that sends no `providerInstances` keeps `snapshot_enabled`.
#[must_use]
pub fn project_instance_enabled(
    settings: &ServerSettings,
    project_id: Option<&str>,
    instance_id: &str,
    snapshot_enabled: bool,
) -> bool {
    let project_override = project_id.and_then(|project_id| {
        settings
            .project_settings_overrides
            .as_ref()?
            .get(project_id)?
            .provider_instances
            .as_ref()?
            .get(instance_id)?
            .enabled
    });
    match project_override {
        Some(enabled) => enabled,
        None if settings.provider_instances.is_some() => {
            settings_instance_enabled(settings, instance_id)
        }
        None => snapshot_enabled,
    }
}

/// `matchesLockedProvider`: a started thread keeps its instance and may move to another account of
/// its driver in the same continuation group. Without a group, any account of the driver but
/// Antigravity's.
fn matches_locked_provider(
    provider: &Provider,
    locked_instance_id: Option<&str>,
    locked: Option<&Provider>,
) -> bool {
    let Some(locked_id) = locked_instance_id else {
        return true;
    };
    if provider.instance_id == locked_id {
        return true;
    }
    let Some(locked) = locked else {
        return false;
    };
    if provider.driver != locked.driver {
        return false;
    }
    match locked.continuation.as_ref() {
        Some(group) => provider
            .continuation
            .as_ref()
            .is_some_and(|candidate| candidate.group_key == group.group_key),
        None => provider.driver != "antigravity",
    }
}

/// The provider's workspace snapshot for `cwd`.
#[must_use]
pub fn workspace_snapshot<'a>(provider: &'a Provider, cwd: &str) -> Option<&'a Snapshot> {
    provider
        .workspace_snapshots
        .as_ref()?
        .iter()
        .find(|snapshot| snapshot.cwd == cwd)
}

/// `isProviderWorkspaceSnapshotPending`: the server is still discovering its commands or models.
#[must_use]
pub fn workspace_snapshot_pending(snapshot: &Snapshot) -> bool {
    snapshot.slash_commands_pending == Some(true) || snapshot.models_pending == Some(true)
}

/// `isProviderWorkspaceSnapshotCurrent`: checked within [`WORKSPACE_SNAPSHOT_TTL_MS`].
#[must_use]
pub fn workspace_snapshot_current(snapshot: &Snapshot, now_ms: i64) -> bool {
    parse_iso8601_epoch_ms(&snapshot.checked_at)
        .is_some_and(|checked| now_ms - checked < WORKSPACE_SNAPSHOT_TTL_MS)
}

fn complete_snapshot<'a>(provider: Option<&'a Provider>, cwd: &str) -> Option<&'a Snapshot> {
    provider
        .and_then(|provider| workspace_snapshot(provider, cwd))
        .filter(|snapshot| !workspace_snapshot_pending(snapshot))
}

/// `resolveProvidersForCwd`: a provider whose snapshot for `cwd` lists models offers those, so a
/// project's own provider config shows its models. Other providers are unchanged.
#[must_use]
pub fn providers_for_cwd(providers: &[Provider], cwd: Option<&str>) -> Vec<Provider> {
    providers
        .iter()
        .map(|provider| {
            let models = cwd
                .and_then(|cwd| workspace_snapshot(provider, cwd))
                .and_then(|snapshot| snapshot.models.clone());
            match models {
                Some(models) => Provider {
                    models,
                    ..provider.clone()
                },
                None => provider.clone(),
            }
        })
        .collect()
}

/// `ProviderWorkspaceSnapshotRefreshState`: one provider and cwd's scan history.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WorkspaceScanState {
    /// When the last scan was requested. A request inside the TTL is not repeated.
    pub requested_at_ms: Option<i64>,
    /// A failed scan is not retried before this time.
    pub retry_not_before_ms: Option<i64>,
    /// Failed scans within the current request TTL.
    pub failed_attempts: u32,
    pub had_snapshot: bool,
    /// The server published a partial snapshot and is still discovering.
    pub snapshot_pending: bool,
}

/// [`plan_workspace_scan`]'s answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkspaceScanPlan {
    pub state: WorkspaceScanState,
    /// Ask the server to scan now; `state.requested_at_ms` marks the request.
    pub refresh: bool,
    /// While the server still discovers, plan again at this time.
    pub recheck_at_ms: Option<i64>,
}

/// `planProviderWorkspaceSnapshotRefresh`: whether a picker looking at `cwd` should ask the server
/// to scan `provider` there. A missing, pending or expired snapshot scans, at most once per TTL,
/// and a failed scan waits out its cooldown.
#[must_use]
pub fn plan_workspace_scan(
    previous: WorkspaceScanState,
    provider: Option<&Provider>,
    cwd: &str,
    now_ms: i64,
) -> WorkspaceScanPlan {
    let complete = complete_snapshot(provider, cwd);
    let pending = provider
        .and_then(|provider| workspace_snapshot(provider, cwd))
        .is_some_and(workspace_snapshot_pending);
    // Losing a snapshot lifts both the TTL and the cooldown, so the scan happens at once.
    let lost = previous.had_snapshot && complete.is_none();
    let requested_at_ms = if lost { None } else { previous.requested_at_ms };
    let retry_not_before_ms = previous
        .retry_not_before_ms
        .filter(|retry| !lost && now_ms < *retry);
    let expired = |requested: i64| now_ms - requested >= WORKSPACE_SNAPSHOT_TTL_MS;
    let state = WorkspaceScanState {
        requested_at_ms,
        retry_not_before_ms,
        failed_attempts: if lost || requested_at_ms.is_some_and(expired) {
            0
        } else {
            previous.failed_attempts
        },
        had_snapshot: complete.is_some(),
        snapshot_pending: pending,
    };
    let current = complete.is_some_and(|snapshot| workspace_snapshot_current(snapshot, now_ms));
    let refresh = requested_at_ms.is_none_or(expired) && !current && retry_not_before_ms.is_none();
    if refresh {
        return WorkspaceScanPlan {
            state: WorkspaceScanState {
                requested_at_ms: Some(now_ms),
                ..state
            },
            refresh: true,
            recheck_at_ms: None,
        };
    }
    WorkspaceScanPlan {
        state,
        refresh: false,
        recheck_at_ms: if pending { retry_not_before_ms } else { None },
    }
}

/// `failProviderWorkspaceSnapshotRefresh`: a scan that failed, or ended without a complete
/// snapshot, cools down before the next. After the last attempt the request marker stays, so only
/// the TTL or a lost snapshot lets another scan through.
#[must_use]
pub fn fail_workspace_scan(
    state: WorkspaceScanState,
    requested_at_ms: i64,
    now_ms: i64,
    cooldown_ms: i64,
) -> WorkspaceScanState {
    // A newer request, or a lost snapshot, already superseded this one.
    if state.requested_at_ms != Some(requested_at_ms) {
        return state;
    }
    let failed_attempts = state.failed_attempts + 1;
    if failed_attempts >= WORKSPACE_SCAN_MAX_ATTEMPTS {
        return WorkspaceScanState {
            failed_attempts,
            ..state
        };
    }
    WorkspaceScanState {
        requested_at_ms: None,
        retry_not_before_ms: (cooldown_ms != 0).then_some(now_ms + cooldown_ms),
        failed_attempts,
        ..state
    }
}

/// Whether a scan's reply brought a usable snapshot: complete, and current or newer than the one
/// held when the scan started (a new server timestamp proves progress even when the client clock
/// runs ahead).
#[must_use]
pub fn workspace_scan_refreshed(
    before: Option<&Provider>,
    after: Option<&Provider>,
    cwd: &str,
    now_ms: i64,
) -> bool {
    let Some(snapshot) = complete_snapshot(after, cwd) else {
        return false;
    };
    let previous = before
        .and_then(|provider| workspace_snapshot(provider, cwd))
        .map(|snapshot| snapshot.checked_at.as_str());
    workspace_snapshot_current(snapshot, now_ms) || previous != Some(snapshot.checked_at.as_str())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// 2026-11-19T00:00:00Z.
    const DAY: i64 = 1_795_046_400_000;
    /// 12:00 that day, so snapshots a few TTLs older stay on the same date.
    const NOON: i64 = DAY + 12 * 60 * 60_000;

    fn iso(ms: i64) -> String {
        let minutes = (ms - DAY) / 60_000;
        format!("2026-11-19T{:02}:{:02}:00Z", minutes / 60, minutes % 60)
    }

    fn provider_json(id: &str, driver: &str, extra: Value) -> Value {
        let mut value = json!({
            "instanceId": id,
            "driver": driver,
            "enabled": true,
            "installed": true,
            "status": "ready",
            "auth": { "status": "authenticated" },
            "checkedAt": "2026-11-19T00:00:00Z",
            "models": [{ "slug": "model-a", "name": "Model A", "isCustom": false }],
        });
        if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, field) in extra {
                target.insert(key.clone(), field.clone());
            }
        }
        value
    }

    /// The recorded server-config snapshot with `providers`, and `settings` merged into its
    /// settings.
    fn state_with(providers: Vec<Value>, settings: Value) -> ServerConfigState {
        let mut snapshot: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/server-config-snapshot.json"
        ))
        .expect("fixture is JSON");
        snapshot["config"]["providers"] = Value::Array(providers);
        // Like mobile's tests, a provider's own `enabled` counts unless a test configures instances.
        if let Some(target) = snapshot["config"]["settings"].as_object_mut() {
            target.remove("providerInstances");
        }
        if let (Some(target), Some(extra)) = (
            snapshot["config"]["settings"].as_object_mut(),
            settings.as_object(),
        ) {
            for (key, field) in extra {
                target.insert(key.clone(), field.clone());
            }
        }
        let mut state = ServerConfigState::new();
        state.apply(serde_json::from_value(snapshot).expect("snapshot decodes"));
        state
    }

    fn offered(catalog: &ModelCatalog) -> Vec<&str> {
        catalog
            .providers
            .iter()
            .filter(|group| group.offers_models())
            .map(|group| group.instance_id.as_str())
            .collect()
    }

    fn provider(value: Value) -> Provider {
        serde_json::from_value(value).expect("provider decodes")
    }

    // modelOptions.test.ts: "hides an instance the project disables even though the machine
    // enables it".
    #[test]
    fn a_project_switch_hides_a_provider_the_machine_enables() {
        let state = state_with(
            vec![provider_json(
                "codex_work",
                "codex",
                json!({ "displayName": "Codex Work" }),
            )],
            json!({
                "providerInstances": { "codex_work": { "driver": "codex", "enabled": true } },
                "projectSettingsOverrides": {
                    "project-a": { "providerInstances": { "codex_work": { "enabled": false } } },
                },
            }),
        );
        let in_project = state.thread_catalog(&ThreadModelScope {
            project_id: Some("project-a"),
            ..ThreadModelScope::default()
        });
        assert!(
            offered(&in_project).is_empty(),
            "the project turned the provider off"
        );
        assert!(
            !in_project.offers("codex_work", "model-a"),
            "Save on the project-disabled model is refused"
        );
        let elsewhere = state.thread_catalog(&ThreadModelScope::default());
        assert_eq!(
            offered(&elsewhere),
            ["codex_work"],
            "other projects keep it"
        );
        assert!(
            elsewhere.offers("codex_work", "model-a"),
            "and may save its model"
        );
    }

    // "hides a machine-disabled instance for a project with no override, even though another
    // project's keep-alive left it running".
    #[test]
    fn a_machine_switch_applies_where_the_project_has_none() {
        let state = state_with(
            vec![provider_json("codex_work", "codex", json!({}))],
            json!({
                "providerInstances": { "codex_work": { "driver": "codex", "enabled": false } },
                "projectSettingsOverrides": {
                    "project-b": { "providerInstances": { "codex_work": { "enabled": true } } },
                },
            }),
        );
        let scope = ThreadModelScope {
            project_id: Some("project-a"),
            ..ThreadModelScope::default()
        };
        assert!(
            offered(&state.thread_catalog(&scope)).is_empty(),
            "project-a inherits the machine's off switch"
        );
        let other = ThreadModelScope {
            project_id: Some("project-b"),
            ..ThreadModelScope::default()
        };
        assert_eq!(
            offered(&state.thread_catalog(&other)),
            ["codex_work"],
            "project-b turned it back on"
        );
    }

    // modelOptions.test.ts: "keeps accounts in the continuation group and excludes other
    // providers".
    #[test]
    fn a_started_thread_keeps_its_continuation_group() {
        let shared = json!({ "continuation": { "groupKey": "shared" } });
        let state = state_with(
            vec![
                provider_json("codex", "codex", shared.clone()),
                provider_json("codex_work", "codex", shared.clone()),
                provider_json(
                    "codex_other",
                    "codex",
                    json!({ "continuation": { "groupKey": "other" } }),
                ),
                provider_json("claude", "claudeAgent", shared),
            ],
            json!({}),
        );
        let catalog = state.thread_catalog(&ThreadModelScope {
            locked_instance_id: Some("codex"),
            ..ThreadModelScope::default()
        });
        assert_eq!(
            offered(&catalog),
            ["codex", "codex_work"],
            "the group's accounts only"
        );
        assert!(
            catalog.offers("codex_work", "model-a"),
            "the sibling account may be saved"
        );
        assert!(
            !catalog.offers("claude", "model-a"),
            "another driver may not"
        );
    }

    // "matches the web driver fallback without moving unknown Antigravity history".
    #[test]
    fn without_a_group_any_account_of_the_driver_but_antigravitys() {
        let state = state_with(
            vec![
                provider_json("codex", "codex", json!({})),
                provider_json("codex_work", "codex", json!({})),
                provider_json("google", "antigravity", json!({})),
                provider_json("google_work", "antigravity", json!({})),
            ],
            json!({}),
        );
        let codex = ThreadModelScope {
            locked_instance_id: Some("codex"),
            ..ThreadModelScope::default()
        };
        assert_eq!(
            offered(&state.thread_catalog(&codex)),
            ["codex", "codex_work"],
            "codex accounts move"
        );
        let google = ThreadModelScope {
            locked_instance_id: Some("google"),
            ..ThreadModelScope::default()
        };
        assert_eq!(
            offered(&state.thread_catalog(&google)),
            ["google"],
            "Antigravity stays put"
        );
    }

    // providerSkills.test.ts: "lists a project's own models only for that project".
    #[test]
    fn a_workspace_snapshot_adds_models_for_its_cwd_only() {
        let snapshot = json!({ "workspaceSnapshots": [{
            "cwd": "/workspace/project-a",
            "checkedAt": "2026-11-19T00:00:00Z",
            "slashCommands": [],
            "skills": [],
            "models": [{ "slug": "uni/medium-gpt", "name": "Medium GPT", "isCustom": false }],
        }] });
        let state = state_with(vec![provider_json("codex", "codex", snapshot)], json!({}));
        let slugs = |cwd| {
            state
                .thread_catalog(&ThreadModelScope {
                    cwd,
                    ..ThreadModelScope::default()
                })
                .providers[0]
                .models
                .iter()
                .map(|model| model.slug.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            slugs(Some("/workspace/project-a")),
            ["uni/medium-gpt"],
            "the cwd's own catalog"
        );
        assert_eq!(
            slugs(Some("/workspace/project-b")),
            ["model-a"],
            "another cwd keeps the provider's"
        );
        assert_eq!(slugs(None), ["model-a"], "no cwd keeps the provider's");
    }

    fn with_snapshot(checked_at_ms: i64, models_pending: bool) -> Provider {
        provider(provider_json(
            "codex",
            "codex",
            json!({ "workspaceSnapshots": [{
                "cwd": "/w",
                "checkedAt": iso(checked_at_ms),
                "slashCommands": [],
                "skills": [],
                "modelsPending": models_pending,
            }] }),
        ))
    }

    #[test]
    fn scans_a_missing_pending_or_expired_snapshot_once_per_ttl() {
        let now = NOON;
        let absent = provider(provider_json("codex", "codex", json!({})));
        let first = plan_workspace_scan(WorkspaceScanState::default(), Some(&absent), "/w", now);
        assert!(first.refresh, "no snapshot for the cwd scans");
        let again = plan_workspace_scan(first.state, Some(&absent), "/w", now + 1_000);
        assert!(!again.refresh, "a request inside the TTL is not repeated");
        let later = plan_workspace_scan(
            first.state,
            Some(&absent),
            "/w",
            now + WORKSPACE_SNAPSHOT_TTL_MS,
        );
        assert!(later.refresh, "the TTL lets the next request through");

        let fresh = with_snapshot(now - 60_000, false);
        assert!(
            !plan_workspace_scan(WorkspaceScanState::default(), Some(&fresh), "/w", now).refresh,
            "a complete current snapshot needs no scan"
        );
        let pending = with_snapshot(now - 60_000, true);
        assert!(
            plan_workspace_scan(WorkspaceScanState::default(), Some(&pending), "/w", now).refresh,
            "a pending snapshot scans"
        );
        let expired = with_snapshot(now - WORKSPACE_SNAPSHOT_TTL_MS, false);
        assert!(
            plan_workspace_scan(WorkspaceScanState::default(), Some(&expired), "/w", now).refresh,
            "an expired snapshot scans"
        );
        assert!(
            plan_workspace_scan(WorkspaceScanState::default(), None, "/w", now).refresh,
            "a provider list that has not arrived yet scans once it does"
        );
    }

    #[test]
    fn failed_scans_cool_down_and_stop_after_three_attempts() {
        let now = NOON;
        let absent = provider(provider_json("codex", "codex", json!({})));
        let mut plan = plan_workspace_scan(WorkspaceScanState::default(), Some(&absent), "/w", now);
        let mut clock = now;
        for attempt in 1..=WORKSPACE_SCAN_MAX_ATTEMPTS {
            assert!(plan.refresh, "attempt {attempt} scans");
            let requested = plan.state.requested_at_ms.expect("a request is marked");
            let failed = fail_workspace_scan(
                plan.state,
                requested,
                clock,
                WORKSPACE_SCAN_RETRY_COOLDOWN_MS,
            );
            assert_eq!(failed.failed_attempts, attempt, "the failure counts");
            let cooling = plan_workspace_scan(failed, Some(&absent), "/w", clock + 1_000);
            assert!(!cooling.refresh, "a failed scan waits out its cooldown");
            clock += WORKSPACE_SCAN_RETRY_COOLDOWN_MS;
            plan = plan_workspace_scan(failed, Some(&absent), "/w", clock);
        }
        assert!(
            !plan.refresh,
            "after the last attempt no scan until the TTL"
        );
        let after_ttl = plan_workspace_scan(
            plan.state,
            Some(&absent),
            "/w",
            plan.state.requested_at_ms.expect("the last request stays") + WORKSPACE_SNAPSHOT_TTL_MS,
        );
        assert!(after_ttl.refresh, "the TTL resets the attempts");
        assert_eq!(after_ttl.state.failed_attempts, 0, "the count starts over");
    }

    #[test]
    fn a_pending_snapshot_rechecks_when_its_cooldown_ends() {
        let now = NOON;
        let pending = with_snapshot(now - 60_000, true);
        let plan = plan_workspace_scan(WorkspaceScanState::default(), Some(&pending), "/w", now);
        let requested = plan.state.requested_at_ms.expect("requested");
        let failed =
            fail_workspace_scan(plan.state, requested, now, WORKSPACE_SCAN_RETRY_COOLDOWN_MS);
        let waiting = plan_workspace_scan(failed, Some(&pending), "/w", now + 1_000);
        assert_eq!(
            waiting.recheck_at_ms,
            Some(now + WORKSPACE_SCAN_RETRY_COOLDOWN_MS),
            "a pending scan looks again when the cooldown ends"
        );
    }

    #[test]
    fn a_reply_counts_only_with_a_complete_new_or_current_snapshot() {
        let now = NOON;
        let old = with_snapshot(now - 2 * WORKSPACE_SNAPSHOT_TTL_MS, false);
        let newer = with_snapshot(now - WORKSPACE_SNAPSHOT_TTL_MS, false);
        let pending = with_snapshot(now, true);
        assert!(
            workspace_scan_refreshed(None, Some(&with_snapshot(now, false)), "/w", now),
            "a current snapshot"
        );
        assert!(
            workspace_scan_refreshed(Some(&old), Some(&newer), "/w", now),
            "a newer server timestamp"
        );
        assert!(
            !workspace_scan_refreshed(Some(&old), Some(&old), "/w", now),
            "the same stale snapshot"
        );
        assert!(
            !workspace_scan_refreshed(None, Some(&pending), "/w", now),
            "still pending"
        );
        assert!(
            !workspace_scan_refreshed(None, None, "/w", now),
            "no provider in the reply"
        );
    }
}
