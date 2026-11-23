//! Pure Rust formatting, validation, and draft conversion for agent scheduled tasks and webhooks.
//!
//! Mirrors Conn's `scheduledTasksSettings.logic.ts` and `ScheduledTasksSettings.tsx` so both
//! desktop and future iOS clients share deterministic scheduling rules with zero UI dependencies.

use conn_contract::{
    ModelSelection, OrchestrationV2RunWorkspacePreparationExistingWorktree,
    OrchestrationV2RunWorkspacePreparationRoot, OrchestrationV2RunWorkspacePreparationWorktree,
    OrchestrationV2ThreadLaunchWorkspaceStrategy, ProviderInteractionMode, RuntimeMode,
    ScheduledTask, ScheduledTaskSchedule, ScheduledTaskScheduleFixedTime,
    ScheduledTaskScheduleInterval, ScheduledTaskScheduleOnce, ScheduledTaskScheduleWebhookDedupe,
    ScheduledTaskUpsertInput, ScheduledTaskUpsertSchedule, ScheduledTaskUpsertScheduleWebhook,
    ScheduledTaskUpsertScheduleWebhookSignature, ScheduledTaskWebhookEndpoint,
    ScheduledTaskWebhookSignatureEncoding, lit,
};

/// Maximum allowed webhook delivery age limit in minutes (matches `@t3tools/contracts`).
pub const MAX_WEBHOOK_DELIVERY_AGE_MINUTES: i64 = 1_440;
/// Minimum allowed webhook coalesce window in seconds.
pub const MIN_WEBHOOK_COALESCE_WINDOW_SECONDS: i64 = 10;
/// Maximum allowed webhook coalesce window in seconds.
pub const MAX_WEBHOOK_COALESCE_WINDOW_SECONDS: i64 = 3_600;

/// Default HMAC signature header for webhook tasks (GitHub-style default in Conn).
pub const DEFAULT_WEBHOOK_SIGNATURE_HEADER: &str = "x-hub-signature-256";
/// Default HMAC signature prefix for webhook tasks.
pub const DEFAULT_WEBHOOK_SIGNATURE_PREFIX: &str = "sha256=";

const WEEKDAY_LABELS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// High-level schedule mode chosen in the task editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleMode {
    FixedTime,
    Interval,
    Once,
    Webhook,
}

impl ScheduleMode {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::FixedTime => "Fixed time",
            Self::Interval => "Interval",
            Self::Once => "Once",
            Self::Webhook => "Webhook",
        }
    }
}

/// Workspace strategy chosen in the task editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceMode {
    Worktree,
    Root,
    ExistingWorktree,
}

impl WorkspaceMode {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Worktree => "Create a new worktree",
            Self::Root => "Use the project checkout",
            Self::ExistingWorktree => "Use a specific checkout",
        }
    }
}

/// Editable form state for creating or updating a [`ScheduledTask`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledTaskDraft {
    pub editing_id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub schedule_mode: ScheduleMode,
    pub interval_minutes: String,
    pub time_of_day: String,
    /// RFC 3339 / ISO-8601 timestamp for one-shot tasks.
    pub run_at: String,
    /// Selected weekdays (`0` = Sun .. `6` = Sat). Empty or all 7 means daily.
    pub weekdays: Vec<i64>,
    pub project_id: String,
    pub workspace_mode: WorkspaceMode,
    pub base_ref: String,
    pub start_from_origin: bool,
    pub existing_worktree_path: String,
    pub instance_id: Option<String>,
    pub model: String,
    pub runtime_mode: RuntimeMode,
    pub interaction_mode: ProviderInteractionMode,
    pub signature_enabled: bool,
    pub signature_header: String,
    pub signature_encoding: ScheduledTaskWebhookSignatureEncoding,
    pub signature_prefix: String,
    /// Write-only secret; empty preserves an existing server-side secret on edit.
    pub signature_secret: String,
    pub max_delivery_age_minutes: String,
    pub replay_key: String,
    pub coalesce_key: String,
    pub coalesce_window_seconds: String,
}

impl ScheduledTaskDraft {
    /// Creates a new draft with Conn's default schedule (weekdays at 09:00, new worktree).
    #[must_use]
    pub fn new_default(
        project_id: impl Into<String>,
        instance_id: Option<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            editing_id: None,
            title: String::new(),
            prompt: String::new(),
            enabled: true,
            schedule_mode: ScheduleMode::FixedTime,
            interval_minutes: "15".to_owned(),
            time_of_day: "09:00".to_owned(),
            run_at: String::new(),
            weekdays: vec![1, 2, 3, 4, 5],
            project_id: project_id.into(),
            workspace_mode: WorkspaceMode::Worktree,
            base_ref: "main".to_owned(),
            start_from_origin: true,
            existing_worktree_path: String::new(),
            instance_id,
            model: model.into(),
            runtime_mode: RuntimeMode::FullAccess,
            interaction_mode: ProviderInteractionMode::Default,
            signature_enabled: false,
            signature_header: DEFAULT_WEBHOOK_SIGNATURE_HEADER.to_owned(),
            signature_encoding: ScheduledTaskWebhookSignatureEncoding::Hex,
            signature_prefix: DEFAULT_WEBHOOK_SIGNATURE_PREFIX.to_owned(),
            signature_secret: String::new(),
            max_delivery_age_minutes: String::new(),
            replay_key: String::new(),
            coalesce_key: String::new(),
            coalesce_window_seconds: String::new(),
        }
    }

    /// Populates an editor draft from an existing [`ScheduledTask`].
    #[must_use]
    pub fn from_task(task: &ScheduledTask) -> Self {
        let mut draft = Self::new_default(
            task.project_id.clone(),
            extract_model_instance(&task.model_selection),
            extract_model_slug(&task.model_selection),
        );
        draft.editing_id = Some(task.id.clone());
        draft.title.clone_from(&task.title);
        draft.prompt.clone_from(&task.prompt);
        draft.enabled = task.enabled;
        draft.runtime_mode = task.runtime_mode;
        draft.interaction_mode = task.interaction_mode;

        match &task.workspace_strategy {
            OrchestrationV2ThreadLaunchWorkspaceStrategy::Root(_) => {
                draft.workspace_mode = WorkspaceMode::Root;
            }
            OrchestrationV2ThreadLaunchWorkspaceStrategy::Worktree(w) => {
                draft.workspace_mode = WorkspaceMode::Worktree;
                draft.base_ref.clone_from(&w.base_ref);
                draft.start_from_origin = w.start_from_origin.unwrap_or(false);
            }
            OrchestrationV2ThreadLaunchWorkspaceStrategy::ExistingWorktree(w) => {
                draft.workspace_mode = WorkspaceMode::ExistingWorktree;
                draft.existing_worktree_path.clone_from(&w.worktree_path);
            }
        }

        match &task.schedule {
            ScheduledTaskSchedule::FixedTime(fixed) => {
                draft.schedule_mode = ScheduleMode::FixedTime;
                draft.time_of_day.clone_from(&fixed.time_of_day);
                draft.weekdays = match &fixed.weekdays {
                    Some(days) if !days.is_empty() => days.clone(),
                    _ => vec![0, 1, 2, 3, 4, 5, 6],
                };
            }
            ScheduledTaskSchedule::Interval(interval) => {
                draft.schedule_mode = ScheduleMode::Interval;
                let mins = (interval.every_ms / 60_000).max(1);
                draft.interval_minutes = mins.to_string();
            }
            ScheduledTaskSchedule::Once(once) => {
                draft.schedule_mode = ScheduleMode::Once;
                draft.run_at.clone_from(&once.run_at);
            }
            ScheduledTaskSchedule::Webhook(webhook) => {
                draft.schedule_mode = ScheduleMode::Webhook;
                if let Some(sig) = &webhook.signature {
                    draft.signature_enabled = true;
                    draft.signature_header.clone_from(&sig.header);
                    draft.signature_encoding = sig.encoding;
                    draft.signature_prefix.clone_from(&sig.prefix);
                }
                if let Some(Some(max_age)) = webhook.max_delivery_age_minutes {
                    draft.max_delivery_age_minutes = max_age.to_string();
                }
                if let Some(dedupe) = &webhook.dedupe {
                    if let Some(replay) = &dedupe.replay_key {
                        draft.replay_key.clone_from(replay);
                    }
                    if let Some(coalesce) = &dedupe.coalesce_key {
                        draft.coalesce_key.clone_from(coalesce);
                    }
                    if let Some(window) = dedupe.coalesce_window_seconds {
                        draft.coalesce_window_seconds = window.to_string();
                    }
                }
            }
        }
        draft
    }
}

/// Formats a human-readable summary of a [`ScheduledTaskSchedule`] matching Conn's `scheduleLabel`.
#[must_use]
pub fn schedule_label(schedule: &ScheduledTaskSchedule) -> String {
    match schedule {
        ScheduledTaskSchedule::Webhook(_) => "On webhook".to_owned(),
        ScheduledTaskSchedule::Once(once) => format!("Once, {}", once.run_at),
        ScheduledTaskSchedule::Interval(interval) => {
            if interval.every_ms % 60_000 == 0 {
                format!("Every {} min", interval.every_ms / 60_000)
            } else {
                let secs = (interval.every_ms + 500) / 1000;
                format!("Every {secs} sec")
            }
        }
        ScheduledTaskSchedule::FixedTime(fixed) => {
            let days = match fixed.weekdays.as_deref() {
                None | Some([]) => "Daily".to_owned(),
                Some(wd) if wd.len() == 7 => "Daily".to_owned(),
                Some(wd) if wd.len() == 5 && wd.iter().all(|&d| (1..=5).contains(&d)) => {
                    "Weekdays".to_owned()
                }
                Some(wd) => {
                    let mut names = Vec::with_capacity(wd.len());
                    for &d in wd {
                        if let Ok(idx) = usize::try_from(d)
                            && let Some(name) = WEEKDAY_LABELS.get(idx)
                        {
                            names.push(*name);
                        }
                    }
                    if names.is_empty() {
                        "Daily".to_owned()
                    } else {
                        names.join(", ")
                    }
                }
            };
            format!("{days} at {}", fixed.time_of_day)
        }
    }
}

/// Formats a webhook delivery outcome label matching Conn's `webhookDeliveryLabel`.
#[must_use]
pub fn webhook_delivery_label(outcome: &str, pending_window: Option<bool>) -> String {
    if outcome == "accepted" {
        return if pending_window == Some(true) {
            "Opened window".to_owned()
        } else {
            "Ran".to_owned()
        };
    }
    match outcome {
        "dispatch_failed" => "Run failed".to_owned(),
        "duplicate" => "Duplicate".to_owned(),
        "coalesced" => "Coalesced".to_owned(),
        "filtered" => "Filtered".to_owned(),
        "rejected_signature" => "Bad signature".to_owned(),
        "disabled" => "Task paused".to_owned(),
        "rate_limited" => "Rate limited".to_owned(),
        "expired" => "Too old".to_owned(),
        other => other.replace('_', " "),
    }
}

/// Resolves the full webhook URL for a task from its endpoint descriptor and connected server URL.
#[must_use]
pub fn resolve_webhook_url(
    endpoint: &ScheduledTaskWebhookEndpoint,
    server_http_base_url: Option<&str>,
) -> Option<String> {
    if let Some(url) = endpoint
        .url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(url.to_owned());
    }
    let base = server_http_base_url?.trim().trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    let path = endpoint.path.trim();
    if path.is_empty() {
        return None;
    }
    if path.starts_with('/') {
        Some(format!("{base}{path}"))
    } else {
        Some(format!("{base}/{path}"))
    }
}

/// Extracts the model slug string from a contract [`ModelSelection`].
#[must_use]
pub fn extract_model_slug(selection: &ModelSelection) -> String {
    selection
        .model
        .as_str()
        .map(ToOwned::to_owned)
        .unwrap_or_default()
}

/// Extracts the provider/instance id string from a contract [`ModelSelection`].
#[must_use]
pub fn extract_model_instance(selection: &ModelSelection) -> Option<String> {
    selection
        .instance_id
        .as_ref()
        .and_then(|inner| inner.as_ref())
        .and_then(|v| v.as_str())
        .or_else(|| {
            selection
                .provider
                .as_ref()
                .and_then(|inner| inner.as_ref())
                .and_then(|v| v.as_str())
        })
        .map(ToOwned::to_owned)
}

/// Validates `draft` and builds a typed [`ScheduledTaskUpsertInput`] ready for
/// `scheduledTasks.upsert`.
///
/// # Errors
///
/// Returns a user-facing validation message when required fields or schedule parameters are invalid.
pub fn build_upsert_input(draft: &ScheduledTaskDraft) -> Result<ScheduledTaskUpsertInput, String> {
    let title = draft.title.trim();
    if title.is_empty() {
        return Err("Add a task title.".to_owned());
    }
    let prompt = draft.prompt.trim();
    if prompt.is_empty() {
        return Err("Add a prompt for the agent to run.".to_owned());
    }
    let project_id = draft.project_id.trim();
    if project_id.is_empty() {
        return Err("Select a project for this scheduled task.".to_owned());
    }
    let model_slug = draft.model.trim();
    if model_slug.is_empty() {
        return Err("Choose a model slug (for example, claude-sonnet-4-6).".to_owned());
    }

    let schedule = build_upsert_schedule(draft)?;
    let workspace_strategy = match draft.workspace_mode {
        WorkspaceMode::Root => OrchestrationV2ThreadLaunchWorkspaceStrategy::Root(
            OrchestrationV2RunWorkspacePreparationRoot {
                r#type: lit::Root,
                branch: None,
            },
        ),
        WorkspaceMode::Worktree => {
            let base_ref = draft.base_ref.trim();
            if base_ref.is_empty() {
                return Err("Enter a base branch for the new worktree (e.g. main).".to_owned());
            }
            OrchestrationV2ThreadLaunchWorkspaceStrategy::Worktree(
                OrchestrationV2RunWorkspacePreparationWorktree {
                    r#type: lit::Worktree,
                    base_ref: base_ref.to_owned(),
                    branch: None,
                    start_from_origin: Some(draft.start_from_origin),
                },
            )
        }
        WorkspaceMode::ExistingWorktree => {
            let path = draft.existing_worktree_path.trim();
            if path.is_empty() {
                return Err("Enter the path to the existing worktree checkout.".to_owned());
            }
            OrchestrationV2ThreadLaunchWorkspaceStrategy::ExistingWorktree(
                OrchestrationV2RunWorkspacePreparationExistingWorktree {
                    r#type: lit::ExistingWorktree,
                    worktree_path: path.to_owned(),
                    branch: None,
                },
            )
        }
    };

    let instance_id = draft
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| serde_json::Value::String(s.to_owned()));

    let model_selection = ModelSelection {
        provider: instance_id.clone().map(Some),
        instance_id: instance_id.map(Some),
        model: serde_json::Value::String(model_slug.to_owned()),
        options: None,
    };

    Ok(ScheduledTaskUpsertInput {
        id: draft.editing_id.clone(),
        require_existing: None,
        command_id: None,
        title: title.to_owned(),
        prompt: prompt.to_owned(),
        enabled: draft.enabled,
        schedule,
        project_id: project_id.to_owned(),
        thread_id: None,
        thread_mode: None,
        workspace_strategy,
        model_selection,
        runtime_mode: draft.runtime_mode,
        interaction_mode: draft.interaction_mode,
        created_by: None,
        creation_source: None,
    })
}

fn build_upsert_schedule(
    draft: &ScheduledTaskDraft,
) -> Result<ScheduledTaskUpsertSchedule, String> {
    match draft.schedule_mode {
        ScheduleMode::Interval => {
            let mins: i64 = draft.interval_minutes.trim().parse().map_err(|_| {
                "Interval must be a whole number of minutes (at least 1).".to_owned()
            })?;
            if mins < 1 {
                return Err("Interval must be at least 1 minute.".to_owned());
            }
            Ok(ScheduledTaskUpsertSchedule::Interval(
                ScheduledTaskScheduleInterval {
                    r#type: lit::Interval,
                    every_ms: mins * 60_000,
                },
            ))
        }
        ScheduleMode::FixedTime => {
            let time = draft.time_of_day.trim();
            if !is_valid_hh_mm(time) {
                return Err("Time of day must use 24-hour HH:MM format (e.g. 09:00).".to_owned());
            }
            let mut weekdays = draft.weekdays.clone();
            weekdays.sort_unstable();
            weekdays.dedup();
            weekdays.retain(|&d| (0..=6).contains(&d));
            let weekdays_opt = if weekdays.is_empty() || weekdays.len() == 7 {
                None
            } else {
                Some(weekdays)
            };
            Ok(ScheduledTaskUpsertSchedule::FixedTime(
                ScheduledTaskScheduleFixedTime {
                    r#type: lit::FixedTime,
                    time_of_day: time.to_owned(),
                    weekdays: weekdays_opt,
                },
            ))
        }
        ScheduleMode::Once => {
            let run_at = draft.run_at.trim();
            if run_at.is_empty() || !run_at.contains('T') {
                return Err(
                    "Enter an ISO-8601 run time (for example, 2026-12-01T09:00:00Z).".to_owned(),
                );
            }
            Ok(ScheduledTaskUpsertSchedule::Once(
                ScheduledTaskScheduleOnce {
                    r#type: lit::Once,
                    run_at: run_at.to_owned(),
                },
            ))
        }
        ScheduleMode::Webhook => {
            let max_age_str = draft.max_delivery_age_minutes.trim();
            let max_delivery_age_minutes = if max_age_str.is_empty() {
                Some(None)
            } else {
                let mins: i64 = max_age_str.parse().map_err(|_| {
                    format!(
                        "Max delivery age must be whole minutes from 1 to {MAX_WEBHOOK_DELIVERY_AGE_MINUTES}."
                    )
                })?;
                if !(1..=MAX_WEBHOOK_DELIVERY_AGE_MINUTES).contains(&mins) {
                    return Err(format!(
                        "Max delivery age must be between 1 and {MAX_WEBHOOK_DELIVERY_AGE_MINUTES} minutes."
                    ));
                }
                Some(Some(mins))
            };

            let coalesce_window_str = draft.coalesce_window_seconds.trim();
            let coalesce_window_seconds = if coalesce_window_str.is_empty() {
                None
            } else {
                let secs: i64 = coalesce_window_str.parse().map_err(|_| {
                    format!(
                        "Coalesce window must be whole seconds from {MIN_WEBHOOK_COALESCE_WINDOW_SECONDS} to {MAX_WEBHOOK_COALESCE_WINDOW_SECONDS}."
                    )
                })?;
                if !(MIN_WEBHOOK_COALESCE_WINDOW_SECONDS..=MAX_WEBHOOK_COALESCE_WINDOW_SECONDS)
                    .contains(&secs)
                {
                    return Err(format!(
                        "Coalesce window must be between {MIN_WEBHOOK_COALESCE_WINDOW_SECONDS} and {MAX_WEBHOOK_COALESCE_WINDOW_SECONDS} seconds."
                    ));
                }
                Some(secs)
            };

            let signature = if draft.signature_enabled {
                let header = draft.signature_header.trim();
                if header.is_empty() {
                    return Err(
                        "Enter a signature header name (e.g. x-hub-signature-256).".to_owned()
                    );
                }
                let secret = draft.signature_secret.trim();
                Some(Some(ScheduledTaskUpsertScheduleWebhookSignature {
                    header: header.to_owned(),
                    encoding: draft.signature_encoding,
                    prefix: draft.signature_prefix.clone(),
                    secret: if secret.is_empty() {
                        None
                    } else {
                        Some(secret.to_owned())
                    },
                    secret_ref: None,
                }))
            } else {
                Some(None)
            };

            let replay_key = non_empty_trimmed(&draft.replay_key);
            let coalesce_key = non_empty_trimmed(&draft.coalesce_key);

            Ok(ScheduledTaskUpsertSchedule::Webhook(
                ScheduledTaskUpsertScheduleWebhook {
                    r#type: lit::Webhook,
                    signature,
                    max_delivery_age_minutes,
                    dedupe: Some(ScheduledTaskScheduleWebhookDedupe {
                        replay_key,
                        coalesce_key,
                        coalesce_window_seconds,
                    }),
                    filters: None,
                },
            ))
        }
    }
}

fn non_empty_trimmed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn is_valid_hh_mm(value: &str) -> bool {
    let Some((hh, mm)) = value.split_once(':') else {
        return false;
    };
    if hh.len() != 2 || mm.len() != 2 {
        return false;
    }
    let Ok(hour) = hh.parse::<u8>() else {
        return false;
    };
    let Ok(minute) = mm.parse::<u8>() else {
        return false;
    };
    hour <= 23 && minute <= 59
}

#[cfg(test)]
mod tests {
    use conn_contract::{ScheduledTaskScheduleWebhook, ScheduledTaskWebhookSignature};

    use super::*;

    #[test]
    fn formats_schedule_labels_matching_conn() {
        assert_eq!(
            schedule_label(&ScheduledTaskSchedule::Webhook(
                ScheduledTaskScheduleWebhook {
                    r#type: lit::Webhook,
                    signature: None,
                    max_delivery_age_minutes: None,
                    dedupe: None,
                    filters: None,
                }
            )),
            "On webhook"
        );
        assert_eq!(
            schedule_label(&ScheduledTaskSchedule::Interval(
                ScheduledTaskScheduleInterval {
                    r#type: lit::Interval,
                    every_ms: 900_000,
                }
            )),
            "Every 15 min"
        );
        assert_eq!(
            schedule_label(&ScheduledTaskSchedule::FixedTime(
                ScheduledTaskScheduleFixedTime {
                    r#type: lit::FixedTime,
                    time_of_day: "09:00".to_owned(),
                    weekdays: Some(vec![1, 2, 3, 4, 5]),
                }
            )),
            "Weekdays at 09:00"
        );
        assert_eq!(
            schedule_label(&ScheduledTaskSchedule::FixedTime(
                ScheduledTaskScheduleFixedTime {
                    r#type: lit::FixedTime,
                    time_of_day: "08:30".to_owned(),
                    weekdays: Some(vec![1, 3, 5]),
                }
            )),
            "Mon, Wed, Fri at 08:30"
        );
        assert_eq!(
            schedule_label(&ScheduledTaskSchedule::FixedTime(
                ScheduledTaskScheduleFixedTime {
                    r#type: lit::FixedTime,
                    time_of_day: "22:00".to_owned(),
                    weekdays: None,
                }
            )),
            "Daily at 22:00"
        );
    }

    #[test]
    fn formats_webhook_delivery_labels_and_urls() {
        assert_eq!(webhook_delivery_label("accepted", None), "Ran");
        assert_eq!(
            webhook_delivery_label("accepted", Some(true)),
            "Opened window"
        );
        assert_eq!(
            webhook_delivery_label("rejected_signature", None),
            "Bad signature"
        );
        assert_eq!(
            webhook_delivery_label("dispatch_failed", None),
            "Run failed"
        );

        let local = ScheduledTaskWebhookEndpoint {
            path: "/api/webhooks/abc".to_owned(),
            url: None,
            has_secret: true,
        };
        assert_eq!(
            resolve_webhook_url(&local, Some("http://127.0.0.1:3891/")),
            Some("http://127.0.0.1:3891/api/webhooks/abc".to_owned())
        );

        let public = ScheduledTaskWebhookEndpoint {
            path: "/api/webhooks/abc".to_owned(),
            url: Some("https://relay.example.com/wh/abc".to_owned()),
            has_secret: false,
        };
        assert_eq!(
            resolve_webhook_url(&public, Some("http://127.0.0.1:3891")),
            Some("https://relay.example.com/wh/abc".to_owned())
        );
    }

    #[test]
    fn builds_and_validates_upsert_inputs() {
        let mut draft = ScheduledTaskDraft::new_default(
            "proj-1",
            Some("claudeAgent".to_owned()),
            "claude-sonnet-4-6",
        );
        assert!(build_upsert_input(&draft).is_err());

        draft.title = "Morning triage".to_owned();
        draft.prompt = "Summarize open PRs".to_owned();
        let input = build_upsert_input(&draft).expect("valid fixed-time draft");
        assert_eq!(input.title, "Morning triage");
        assert_eq!(input.project_id, "proj-1");
        assert!(matches!(
            input.schedule,
            ScheduledTaskUpsertSchedule::FixedTime(ref f) if f.time_of_day == "09:00" && f.weekdays == Some(vec![1, 2, 3, 4, 5])
        ));

        draft.schedule_mode = ScheduleMode::Webhook;
        draft.signature_enabled = true;
        draft.signature_secret = "top-secret".to_owned();
        draft.coalesce_window_seconds = "5".to_owned();
        assert!(build_upsert_input(&draft).is_err());

        draft.coalesce_window_seconds = "60".to_owned();
        let webhook_input = build_upsert_input(&draft).expect("valid webhook draft");
        assert!(matches!(
            webhook_input.schedule,
            ScheduledTaskUpsertSchedule::Webhook(ref w)
                if w.signature.as_ref().and_then(|s| s.as_ref()).is_some_and(|sig| sig.header == DEFAULT_WEBHOOK_SIGNATURE_HEADER)
                    && w.dedupe.as_ref().and_then(|d| d.coalesce_window_seconds) == Some(60)
        ));

        let _ = ScheduledTaskWebhookSignature {
            header: "x-sig".to_owned(),
            encoding: ScheduledTaskWebhookSignatureEncoding::Hex,
            prefix: "sha256=".to_owned(),
        };
    }
}
