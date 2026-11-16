//! Webhook tasks: a request to `/api/hooks/<task id>/<token>` runs the task with a prompt
//! filled in from the request. Behaviour follows `apps/server/src/scheduledTasks/` in the T3
//! server (`webhookRoute.ts`, `ScheduledTaskService.ts`, `webhookTemplate.ts`,
//! `webhookFilter.ts`, `webhookVerification.ts`, `webhookDedupe.ts`); `README.md` lists where
//! it differs.
//!
//! What a delivery holds while it waits: its rendered prompt (at most 120,000 characters) in
//! one parked task, at most [`MAX_QUEUED_PER_TASK`] per task. The rate windows hold at most
//! 60 times per task. The delivery log and the replay keys live in SQLite on disk
//! (`store.rs`), opened per call.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use conn_contract::{
    ScheduledTask, ScheduledTaskSchedule, ScheduledTaskScheduleWebhook,
    ScheduledTaskUpsertScheduleWebhook, ScheduledTaskWebhookDelivery,
    ScheduledTaskWebhookDeliverySummary, ScheduledTaskWebhookEndpoint,
    ScheduledTaskWebhookSignature, from_json,
};
use serde_json::Value;

use super::{ScheduledTasks, TaskError, Trigger, schedule::format_iso};

pub mod filter;
pub mod store;
pub mod template;
pub mod verify;

use template::{WebhookRequest, render_webhook_prompt};

/// `WEBHOOK_ROUTE_PREFIX`.
pub const ROUTE_PREFIX: &str = "/api/hooks";
/// `WEBHOOK_MAX_BODY_BYTES`: the largest body the route reads.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// `WEBHOOK_RATE_LIMIT_PER_MINUTE`: runs a task may start in a minute, and also the
/// requests that may fail validation in a minute before the rest are refused unread.
pub const RATE_LIMIT_PER_MINUTE: usize = 60;
/// `WEBHOOK_MAX_QUEUED_PER_TASK`.
pub const MAX_QUEUED_PER_TASK: usize = 20;
const DEDUPE_LOG_PER_MINUTE: usize = 10;
const FILTERED_LOG_PER_MINUTE: usize = 10;
/// `WEBHOOK_DELIVERY_LOG_BODY_LIMIT` (bytes) and `_PROMPT_LIMIT` (UTF-16 units).
const LOG_BODY_LIMIT: usize = 64 * 1024;
const LOG_PROMPT_LIMIT: usize = 64 * 1024;
/// `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` (UTF-16 units).
pub const MAX_PROMPT_CHARS: usize = 120_000;
/// `LEGACY_DELIVERY_OUTCOMES`: what a client that predates the newer outcomes decodes.
const LEGACY_OUTCOMES: [&str; 6] = [
    "accepted",
    "dispatch_failed",
    "rejected_signature",
    "disabled",
    "rate_limited",
    "expired",
];
const MINUTE_MS: i64 = 60_000;

/// A webhook task's URL token and signing secret, stored with the task (T3: the
/// `webhook_token` and `webhook_secret` columns of its row, in clear text).
#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Credentials {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &"<redacted>")
            .field("has_secret", &self.secret.is_some())
            .finish()
    }
}

/// `webhookEndpoint`: what clients see of a webhook task's URL. No relay here, so `url` is
/// `null`; the path works directly.
pub fn endpoint(task_id: &str, credentials: &Credentials) -> ScheduledTaskWebhookEndpoint {
    ScheduledTaskWebhookEndpoint {
        path: format!(
            "{ROUTE_PREFIX}/{}/{}",
            conn_support::ids::encode_component(task_id),
            credentials.token
        ),
        url: None,
        has_secret: credentials.secret.is_some(),
    }
}

/// `newWebhookToken`: 32 random bytes, base64url.
pub fn new_token() -> Result<String, TaskError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| TaskError::new("Could not generate webhook token.", None))?;
    Ok(conn_support::base64::url_encode(&bytes))
}

/// One minute of times, and whether the first refusal in it was logged (`RateWindow`).
#[derive(Debug, Default)]
struct RateWindow {
    accepted: Vec<(i64, u64)>,
    rejected_logged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Allowed,
    FirstRejected,
    Rejected,
}

/// The webhook state a service holds in memory: one entry per webhook task, each bounded.
#[derive(Debug, Default)]
pub(super) struct State {
    /// The token and secret of each webhook task, written with the task list.
    pub(super) credentials: StdMutex<HashMap<String, Credentials>>,
    rate: StdMutex<HashMap<String, RateWindow>>,
    rejected: StdMutex<HashMap<String, RateWindow>>,
    dedupe_log: StdMutex<HashMap<String, Vec<i64>>>,
    filtered_log: StdMutex<HashMap<String, Vec<i64>>>,
    /// Deliveries accepted and not yet run, by task id and creation time.
    queued: StdMutex<HashMap<String, usize>>,
    /// One run at a time per task (`webhookPermit`).
    permits: StdMutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    next_reservation: std::sync::atomic::AtomicU64,
}

fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl State {
    fn reservation(&self) -> u64 {
        self.next_reservation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// `takeRateSlot`: a sliding one-minute window.
    fn take_slot(
        windows: &StdMutex<HashMap<String, RateWindow>>,
        id: &str,
        now: i64,
        reservation: u64,
    ) -> Slot {
        let mut windows = lock(windows);
        let window = windows.entry(id.to_owned()).or_default();
        window.accepted.retain(|(at, _)| now - at < MINUTE_MS);
        if window.accepted.len() >= RATE_LIMIT_PER_MINUTE {
            let first = !window.rejected_logged;
            window.rejected_logged = true;
            return if first {
                Slot::FirstRejected
            } else {
                Slot::Rejected
            };
        }
        window.accepted.push((now, reservation));
        window.rejected_logged = false;
        Slot::Allowed
    }

    fn refund_rejection(&self, id: &str, reservation: u64) {
        if let Some(window) = lock(&self.rejected).get_mut(id) {
            window.accepted.retain(|(_, r)| *r != reservation);
        }
    }

    fn run_window_full(&self, id: &str, now: i64) -> bool {
        lock(&self.rate).get(id).is_some_and(|w| {
            w.accepted
                .iter()
                .filter(|(at, _)| now - at < MINUTE_MS)
                .count()
                >= RATE_LIMIT_PER_MINUTE
        })
    }

    /// A one-minute log budget (`takeDedupeLogSlot`, `takeFilteredLogSlot`).
    fn take_log_slot(
        windows: &StdMutex<HashMap<String, Vec<i64>>>,
        id: &str,
        now: i64,
        limit: usize,
    ) -> bool {
        let mut windows = lock(windows);
        let recent = windows.entry(id.to_owned()).or_default();
        recent.retain(|at| now - at < MINUTE_MS);
        if recent.len() >= limit {
            return false;
        }
        recent.push(now);
        true
    }

    fn permit(&self, id: &str) -> Arc<tokio::sync::Semaphore> {
        lock(&self.permits)
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone()
    }

    /// `forgetWebhookTask`: a deleted task's windows, queue count and permit.
    pub(super) fn forget(&self, id: &str) {
        lock(&self.rate).remove(id);
        lock(&self.rejected).remove(id);
        lock(&self.dedupe_log).remove(id);
        lock(&self.filtered_log).remove(id);
        lock(&self.permits).remove(id);
        let prefix = format!("{id}\u{0}");
        lock(&self.queued).retain(|key, _| !key.starts_with(&prefix));
    }
}

/// A queue place held from admission until the run ends.
struct QueuePlace {
    service: ScheduledTasks,
    key: String,
}

impl Drop for QueuePlace {
    fn drop(&mut self) {
        let mut queued = lock(&self.service.inner.hooks.queued);
        if let Some(count) = queued.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                queued.remove(&self.key);
            }
        }
    }
}

/// A request the route read, before any check.
pub struct Delivery {
    pub hook_id: String,
    pub token: String,
    pub method: String,
    pub query: String,
    /// Lowercase names, in arrival order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl std::fmt::Debug for Delivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Delivery")
            .field("hook_id", &self.hook_id)
            .field("method", &self.method)
            .field("body_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}

/// `WebhookTriggerResult`: what the route answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriggerResult {
    /// 202, with the outcome: `accepted`, `duplicate`, `prompt_too_long` or `filtered`.
    Accepted {
        delivery_id: String,
        outcome: &'static str,
    },
    NotFound,
    RejectedSignature,
    Disabled,
    /// `rate_limited` or `queue_full`.
    RateLimited(&'static str),
    Expired,
}

/// `TextDecoder().decode`: UTF-8 with replacement, a leading byte order mark dropped.
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// The length of an incomplete UTF-8 sequence at the end of `bytes` (0 when none), which a
/// streaming decode holds back instead of replacing.
fn incomplete_tail(bytes: &[u8]) -> usize {
    for back in 1..=3usize.min(bytes.len()) {
        let Some(&byte) = bytes.len().checked_sub(back).and_then(|i| bytes.get(i)) else {
            return 0;
        };
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let needed = match byte {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0,
        };
        return if needed > back { back } else { 0 };
    }
    0
}

/// `deliveryRequestBody`: the body as logged, at most 64 KiB, a character split by the limit
/// dropped.
fn logged_body(body: &[u8]) -> (String, bool) {
    if body.len() <= LOG_BODY_LIMIT {
        return (decode_text(body), false);
    }
    let head = body.get(..LOG_BODY_LIMIT).unwrap_or(body);
    let keep = head.len() - incomplete_tail(head);
    (decode_text(head.get(..keep).unwrap_or(head)), true)
}

/// The length of `text` in UTF-16 units, as JavaScript counts it.
fn js_length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, limit)` in UTF-16 units; a surrogate pair the limit splits is dropped (JS
/// keeps half a pair, which no JSON client decodes back).
fn js_prefix(text: &str, limit: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > limit {
            return text.get(..index).unwrap_or(text);
        }
    }
    text
}

/// A JSON object in the given order (headers keep their arrival order in the log).
fn ordered_object(entries: &[(String, String)]) -> String {
    let mut out = String::from("{");
    for (index, (name, value)) in entries.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&Value::String(name.clone()).to_string());
        out.push(':');
        out.push_str(&Value::String(value.clone()).to_string());
    }
    out.push('}');
    out
}

/// `key` in `webhookDedupe.ts`: SHA-256 of the raw rendered template, or `""` when a
/// placeholder is missing or the result is empty.
fn dedupe_key(template: Option<&str>, request: &WebhookRequest) -> String {
    let Some(template) = template else {
        return String::new();
    };
    let rendered = render_webhook_prompt(template, request, "", true);
    if !rendered.missing.is_empty() || rendered.prompt.is_empty() {
        return String::new();
    }
    conn_support::hex::hex(&conn_support::hmac::sha256(rendered.prompt.as_bytes()))
}

fn random_frame_id() -> Result<String, TaskError> {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes)
        .map_err(|_| TaskError::new("Could not generate frame id.", None))?;
    Ok(conn_support::hex::hex(&bytes))
}

/// The request a log write records.
#[derive(Clone, Copy)]
struct Logged<'a> {
    task_id: &'a str,
    delivery_id: &'a str,
    received_at: &'a str,
    request: &'a WebhookRequest,
    body: &'a [u8],
}

/// What a log write records beside the outcome.
#[derive(Default)]
struct LogDetails {
    signature_verified: bool,
    missing: Vec<String>,
    rendered_prompt: Option<String>,
    error: Option<String>,
}

/// The upsert's webhook part: the schedule as stored and the credentials to keep.
pub(super) struct WebhookSave {
    pub schedule: ScheduledTaskSchedule,
    pub credentials: Credentials,
}

/// `upsert` for a webhook schedule: lowercases the signature header, keeps stored dedupe and
/// filters a client left out, keeps the token, and takes a new secret or keeps the stored
/// one. `existing` is the stored task and its credentials.
pub(super) async fn prepare_save(
    request: &super::UpsertInput,
    task_id: &str,
    existing: Option<(&ScheduledTask, Option<&Credentials>)>,
    secrets: Option<&crate::secrets::SecretRequests>,
) -> Result<WebhookSave, super::Failure> {
    let input: ScheduledTaskUpsertScheduleWebhook = from_json(request.schedule.clone())
        .map_err(|e| super::Failure::Invalid(format!("Invalid schedule: {e}")))?;
    check_schedule(&input)?;
    let stored_schedule = existing.and_then(|(task, _)| match &task.schedule {
        ScheduledTaskSchedule::Webhook(webhook) => Some(webhook),
        _ => None,
    });
    let signature = input.signature.clone().flatten();
    if let Some(dedupe) = input
        .dedupe
        .as_ref()
        .or_else(|| stored_schedule.and_then(|s| s.dedupe.as_ref()))
        && dedupe.coalesce_key.is_some()
    {
        return Err(TaskError::new(
            "This server does not coalesce webhook deliveries yet. Remove the coalesce key.",
            Some(task_id),
        )
        .into());
    }
    let filters = input
        .filters
        .clone()
        .or_else(|| stored_schedule.and_then(|s| s.filters.clone()))
        .filter(|f| !f.is_empty());
    let schedule = ScheduledTaskSchedule::Webhook(ScheduledTaskScheduleWebhook {
        r#type: Default::default(),
        signature: signature.as_ref().map(|s| ScheduledTaskWebhookSignature {
            header: s.header.to_lowercase(),
            encoding: s.encoding,
            prefix: s.prefix.clone(),
        }),
        max_delivery_age_minutes: Some(input.max_delivery_age_minutes.flatten()),
        dedupe: input
            .dedupe
            .or_else(|| stored_schedule.and_then(|s| s.dedupe.clone())),
        filters,
    });
    let stored = existing.and_then(|(_, credentials)| credentials);
    let token = match stored {
        Some(stored) => stored.token.clone(),
        None => new_token().map_err(|e| TaskError::new(e.message, Some(task_id)))?,
    };
    let secret = match &signature {
        None => None,
        Some(signature) => {
            let provided = match &signature.secret_ref {
                None => signature.secret.clone(),
                Some(reference) => {
                    let consumed = match secrets {
                        Some(secrets) => secrets.consume(reference, &request.project_id).await,
                        None => Err(crate::secrets::SecretError("ref_unavailable")),
                    };
                    match consumed {
                        Ok(value) => Some(value),
                        Err(_)
                            if request.command_id.is_some()
                                && stored.is_some_and(|s| s.secret.is_some()) =>
                        {
                            None
                        }
                        Err(error) => {
                            return Err(TaskError::new(error.message(), Some(task_id)).into());
                        }
                    }
                }
            };
            provided.or_else(|| stored.and_then(|s| s.secret.clone()))
        }
    };
    if signature.is_some() && secret.is_none() {
        return Err(TaskError::new(
            "A webhook signature check needs a signing secret.",
            Some(task_id),
        )
        .into());
    }
    Ok(WebhookSave {
        schedule,
        credentials: Credentials { token, secret },
    })
}

/// The contract's checks on a webhook schedule that the generated types do not hold. A
/// schedule that fails one is a defect, as Effect answers a payload that does not decode.
fn check_schedule(input: &ScheduledTaskUpsertScheduleWebhook) -> Result<(), super::Failure> {
    let invalid = |what: &str| Err(super::Failure::Invalid(format!("Invalid schedule: {what}")));
    if let Some(Some(signature)) = &input.signature {
        if signature.header.trim().is_empty() || signature.header.trim() != signature.header {
            return invalid("signature.header must be a trimmed, non-empty string");
        }
        if signature
            .secret
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.trim() != s)
        {
            return invalid("signature.secret must be a trimmed, non-empty string");
        }
    }
    if let Some(Some(minutes)) = input.max_delivery_age_minutes
        && !(1..=24 * 60).contains(&minutes)
    {
        return invalid("maxDeliveryAgeMinutes must be between 1 and 1440");
    }
    if let Some(dedupe) = &input.dedupe {
        for template in [&dedupe.replay_key, &dedupe.coalesce_key]
            .into_iter()
            .flatten()
        {
            if !is_dedupe_template(template) {
                return invalid("a dedupe key must be placeholders only");
            }
        }
        if let Some(seconds) = dedupe.coalesce_window_seconds
            && !(10..=3600).contains(&seconds)
        {
            return invalid("coalesceWindowSeconds must be between 10 and 3600");
        }
    }
    if let Some(filters) = &input.filters {
        if filters.len() > 16 {
            return invalid("at most 16 filters");
        }
        for filter in filters {
            let (path, values) = match filter {
                conn_contract::ScheduledTaskWebhookFilter::Equals(f) => (&f.path, None),
                conn_contract::ScheduledTaskWebhookFilter::In(f) => (&f.path, Some(&f.value)),
                conn_contract::ScheduledTaskWebhookFilter::Exists(f) => (&f.path, None),
            };
            let root_ok = ["body", "headers", "query"].iter().any(|root| {
                path.strip_prefix(root)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
            });
            if path.trim() != path || path.is_empty() || !root_ok {
                return invalid("a filter path starts with body, headers or query");
            }
            if let Some(values) = values {
                let ok_value = |v: &String| {
                    !v.is_empty()
                        && !v.contains(',')
                        && v.chars().next().is_some_and(|c| !c.is_whitespace())
                        && v.chars().last().is_some_and(|c| !c.is_whitespace())
                };
                if values.is_empty() || !values.iter().all(ok_value) {
                    return invalid("an `in` filter needs values without commas");
                }
            }
        }
    }
    Ok(())
}

/// `isWebhookDedupeTemplate`: one or more placeholders of `body`, `headers`, `query` paths or
/// `request`, and no other braces.
pub fn is_dedupe_template(template: &str) -> bool {
    let mut rest = template;
    let mut found = 0;
    let mut remainder = String::new();
    while let Some(open) = rest.find("{{") {
        let (before, after_open) = rest.split_at(open);
        let inner_start = after_open.get(2..).unwrap_or("");
        let Some(close) = inner_start.find("}}") else {
            remainder.push_str(rest);
            rest = "";
            break;
        };
        let inner = inner_start.get(..close).unwrap_or("");
        if !inner.contains(['{', '}']) && placeholder_ok(inner.trim()) && !inner.trim().is_empty() {
            remainder.push_str(before);
            found += 1;
            rest = inner_start.get(close + 2..).unwrap_or("");
        } else {
            remainder.push_str(before);
            remainder.push_str("{{");
            rest = inner_start;
        }
    }
    remainder.push_str(rest);
    found > 0 && !remainder.contains("{{") && !remainder.contains("}}")
}

/// `(body|headers|query)(\.[^{}.\s]+)*|request`, with no whitespace inside.
fn placeholder_ok(expression: &str) -> bool {
    if expression == "request" {
        return true;
    }
    let mut parts = expression.split('.');
    let root = parts.next().unwrap_or("");
    matches!(root, "body" | "headers" | "query")
        && parts
            .all(|p| !p.is_empty() && !p.contains(['{', '}']) && !p.contains(char::is_whitespace))
}

impl ScheduledTasks {
    fn hooks(&self) -> &State {
        &self.inner.hooks
    }

    fn hooks_db(&self) -> PathBuf {
        self.inner.hooks_db.clone()
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Path) -> store::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        let path = self.hooks_db();
        tokio::task::spawn_blocking(move || work(&path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }

    /// `rotateWebhookToken`: a new URL token; the old URL stops working at once.
    pub async fn rotate_webhook_token(&self, id: &str) -> Result<ScheduledTask, TaskError> {
        let mut tasks = self.inner.tasks.lock().await;
        let Some(index) = tasks.iter().position(|t| t.id == id) else {
            return Err(TaskError::new("Schedule task not found.", Some(id)));
        };
        let mut next_tasks = tasks.clone();
        let Some(task) = next_tasks.get_mut(index) else {
            return Err(TaskError::new("Schedule task not found.", Some(id)));
        };
        if !matches!(task.schedule, ScheduledTaskSchedule::Webhook(_)) {
            return Err(TaskError::new(
                "Only webhook tasks have a URL token.",
                Some(id),
            ));
        }
        let token = new_token().map_err(|e| TaskError::new(e.message, Some(id)))?;
        let previous = lock(&self.hooks().credentials).get(id).cloned();
        let credentials = Credentials {
            token,
            secret: previous.as_ref().and_then(|c| c.secret.clone()),
        };
        task.webhook = Some(endpoint(id, &credentials));
        task.updated_at = format_iso(self.now());
        let rotated = task.clone();
        lock(&self.hooks().credentials).insert(id.to_owned(), credentials);
        if let Err(error) = self
            .save(&next_tasks, "Could not rotate webhook token.", Some(id))
            .await
        {
            let mut credentials = lock(&self.hooks().credentials);
            match previous {
                Some(previous) => credentials.insert(id.to_owned(), previous),
                None => credentials.remove(id),
            };
            return Err(error);
        }
        *tasks = next_tasks;
        drop(tasks);
        self.notify_changed();
        Ok(rotated)
    }

    /// `listWebhookDeliveries`: newest first. A client that does not say it decodes any
    /// outcome sees only the outcomes older clients know.
    pub async fn list_webhook_deliveries(
        &self,
        id: &str,
        accept_any_outcome: bool,
    ) -> Result<Vec<ScheduledTaskWebhookDeliverySummary>, TaskError> {
        let owned = id.to_owned();
        let rows = self
            .blocking(move |db| store::list(db, &owned))
            .await
            .map_err(|_| TaskError::new("Could not list webhook deliveries.", Some(id)))?;
        Ok(rows
            .iter()
            .filter(|row| accept_any_outcome || LEGACY_OUTCOMES.contains(&row.outcome.as_str()))
            .map(summary)
            .collect())
    }

    /// `getWebhookDelivery`: one logged request with its headers, body and prompt.
    pub async fn get_webhook_delivery(
        &self,
        id: &str,
        delivery_id: &str,
        accept_any_outcome: bool,
    ) -> Result<ScheduledTaskWebhookDelivery, TaskError> {
        let (task, delivery) = (id.to_owned(), delivery_id.to_owned());
        let row = self
            .blocking(move |db| store::get(db, &task, &delivery))
            .await
            .map_err(|_| TaskError::new("Could not load webhook delivery.", Some(id)))?;
        let Some(row) =
            row.filter(|row| accept_any_outcome || LEGACY_OUTCOMES.contains(&row.outcome.as_str()))
        else {
            return Err(TaskError::new("Webhook delivery not found.", Some(id)));
        };
        let summary = summary(&row);
        Ok(ScheduledTaskWebhookDelivery {
            id: summary.id,
            task_id: summary.task_id,
            received_at: summary.received_at,
            method: summary.method,
            content_type: summary.content_type,
            body_bytes: summary.body_bytes,
            outcome: summary.outcome,
            signature_verified: summary.signature_verified,
            pending_window: summary.pending_window,
            missing_fields: summary.missing_fields,
            error: summary.error,
            query: row.query.clone(),
            headers: headers_of(&row),
            body: row.body.clone(),
            body_truncated: row.body_truncated,
            rendered_prompt: row.rendered_prompt.clone(),
        })
    }

    /// Drops a deleted task's deliveries, keys and in-memory state.
    pub(super) async fn forget_webhooks(&self, id: &str) {
        self.hooks().forget(id);
        let owned = id.to_owned();
        if let Err(error) = self
            .blocking(move |db| store::delete_task(db, &owned))
            .await
        {
            eprintln!("scheduled tasks: could not remove the webhook deliveries of {id}: {error}");
        }
    }

    async fn log(
        &self,
        logged: &Logged<'_>,
        outcome: &str,
        details: LogDetails,
    ) -> Result<(), TaskError> {
        let Logged {
            task_id,
            delivery_id,
            received_at,
            request,
            body,
        } = *logged;
        // Require the task to exist, so a delete cannot leave deliveries behind.
        if self.find(task_id).await.is_none() {
            return Ok(());
        }
        let (logged, truncated) = logged_body(body);
        let row = store::DeliveryRow {
            delivery_id: delivery_id.to_owned(),
            task_id: task_id.to_owned(),
            received_at: received_at.to_owned(),
            method: request.method.clone(),
            query: template::redact_query(&request.query),
            headers_json: ordered_object(&template::redact_headers(&request.headers)),
            body: logged,
            body_bytes: i64::try_from(body.len()).unwrap_or(i64::MAX),
            body_truncated: truncated,
            outcome: outcome.to_owned(),
            signature_verified: details.signature_verified,
            missing_fields_json: Value::from(details.missing).to_string(),
            rendered_prompt: details
                .rendered_prompt
                .map(|p| js_prefix(&p, LOG_PROMPT_LIMIT).to_owned()),
            error: details.error,
        };
        self.blocking(move |db| store::record(db, &row))
            .await
            .map_err(|_| TaskError::new("Could not record webhook delivery.", Some(task_id)))
    }

    async fn release_replay(&self, delivery_id: &str) {
        let owned = delivery_id.to_owned();
        let _ = self
            .blocking(move |db| store::release_replay(db, &owned))
            .await;
    }

    async fn mark_delivery_failed(&self, delivery_id: &str, message: &str) {
        let (owned, message) = (delivery_id.to_owned(), message.to_owned());
        let _ = self
            .blocking(move |db| store::mark_failed(db, &owned, &message))
            .await;
    }

    /// `triggerWebhook`: checks a request in T3's order and starts the run. A wrong token
    /// and an unknown hook look the same, and neither is logged.
    pub async fn trigger_webhook(&self, delivery: Delivery) -> Result<TriggerResult, TaskError> {
        let Some(task) = self.find(&delivery.hook_id).await else {
            return Ok(TriggerResult::NotFound);
        };
        let credentials = lock(&self.hooks().credentials).get(&task.id).cloned();
        let Some(credentials) =
            credentials.filter(|c| verify::constant_time_equals(&delivery.token, &c.token))
        else {
            return Ok(TriggerResult::NotFound);
        };
        let ScheduledTaskSchedule::Webhook(schedule) = task.schedule.clone() else {
            return Ok(TriggerResult::NotFound);
        };
        let now = self.now();
        // No relay here: a request is received when it arrives, so it is never too old.
        let received_at = format_iso(now);
        let delivery_id = format!("delivery:{}", conn_support::uuid_v4());
        let request = WebhookRequest {
            method: delivery.method.clone(),
            path: format!(
                "{ROUTE_PREFIX}/{}",
                conn_support::ids::encode_component(&delivery.hook_id)
            ),
            query: delivery.query.clone(),
            headers: delivery.headers.clone(),
            body_text: decode_text(&delivery.body),
        };
        let body = &delivery.body;
        let hooks = self.hooks();
        let logged = Logged {
            task_id: &task.id,
            delivery_id: &delivery_id,
            received_at: &received_at,
            request: &request,
            body,
        };
        let log = |outcome: &'static str, details: LogDetails| self.log(&logged, outcome, details);
        let signed = schedule.signature.is_some();

        // Floods are refused before the signature work and before rejection-log writes.
        let rejection = hooks.reservation();
        match State::take_slot(&hooks.rejected, &task.id, now, rejection) {
            Slot::Allowed => {}
            slot => {
                if slot == Slot::FirstRejected {
                    log("rate_limited", LogDetails::default()).await?;
                }
                return Ok(TriggerResult::RateLimited("rate_limited"));
            }
        }
        if !task.enabled {
            log("disabled", LogDetails::default()).await?;
            return Ok(TriggerResult::Disabled);
        }
        if let Some(signature) = &schedule.signature {
            let verified = credentials.secret.as_deref().is_some_and(|secret| {
                verify::verify_webhook_signature(signature, secret, &delivery.headers, body)
            });
            if !verified {
                log("rejected_signature", LogDetails::default()).await?;
                return Ok(TriggerResult::RejectedSignature);
            }
        }
        if let Some(failed) =
            filter::find_failed_webhook_filter(schedule.filters.as_deref().unwrap_or(&[]), &request)
        {
            if State::take_log_slot(&hooks.filtered_log, &task.id, now, FILTERED_LOG_PER_MINUTE) {
                log(
                    "filtered",
                    LogDetails {
                        signature_verified: signed,
                        error: Some(filter::describe_failed_webhook_filter(&failed)),
                        ..LogDetails::default()
                    },
                )
                .await?;
            }
            hooks.refund_rejection(&task.id, rejection);
            return Ok(TriggerResult::Accepted {
                delivery_id,
                outcome: "filtered",
            });
        }
        let replay_template = schedule.dedupe.as_ref().and_then(|d| d.replay_key.clone());
        if schedule.dedupe.is_none() && hooks.run_window_full(&task.id, now) {
            if State::take_slot(&hooks.rate, &task.id, now, hooks.reservation())
                == Slot::FirstRejected
            {
                log("rate_limited", LogDetails::default()).await?;
            }
            return Ok(TriggerResult::RateLimited("rate_limited"));
        }
        let replay_key = dedupe_key(replay_template.as_deref(), &request);
        let has_key = |key: String| {
            let task_id = task.id.clone();
            self.blocking(move |db| store::has_replay_key(db, &task_id, &key, now))
        };
        let dedupe_error = || TaskError::new("Could not persist webhook dedupe state.", None);
        if schedule.dedupe.is_some()
            && has_key(replay_key.clone())
                .await
                .map_err(|_| dedupe_error())?
        {
            if State::take_log_slot(&hooks.dedupe_log, &task.id, now, DEDUPE_LOG_PER_MINUTE) {
                log(
                    "duplicate",
                    LogDetails {
                        signature_verified: signed,
                        ..LogDetails::default()
                    },
                )
                .await?;
            }
            hooks.refund_rejection(&task.id, rejection);
            return Ok(TriggerResult::Accepted {
                delivery_id,
                outcome: "duplicate",
            });
        }
        let rendered = render_webhook_prompt(&task.prompt, &request, &random_frame_id()?, false);
        // Providers trim the prompt before they check it.
        if js_length(rendered.prompt.trim()) > MAX_PROMPT_CHARS {
            log(
                "dispatch_failed",
                LogDetails {
                    signature_verified: signed,
                    missing: rendered.missing.clone(),
                    rendered_prompt: Some(rendered.prompt.clone()),
                    error: Some(store::PROMPT_TOO_LONG.to_owned()),
                },
            )
            .await?;
            self.release_replay(&delivery_id).await;
            return Ok(TriggerResult::Accepted {
                delivery_id,
                outcome: "prompt_too_long",
            });
        }
        hooks.refund_rejection(&task.id, rejection);
        // Admission: the queue bound, then a run slot, then the replay key.
        let queue_key = format!("{}\u{0}{}", task.id, task.created_at);
        let admitted = {
            let mut queued = lock(&hooks.queued);
            if queued.get(&queue_key).copied().unwrap_or(0) >= MAX_QUEUED_PER_TASK {
                Err(None)
            } else {
                match State::take_slot(&hooks.rate, &task.id, now, hooks.reservation()) {
                    Slot::Allowed => {
                        *queued.entry(queue_key.clone()).or_insert(0) += 1;
                        Ok(())
                    }
                    slot => Err(Some(slot)),
                }
            }
        };
        match admitted {
            Ok(()) => {}
            Err(None) => return Ok(TriggerResult::RateLimited("queue_full")),
            Err(Some(slot)) => {
                if slot == Slot::FirstRejected {
                    log("rate_limited", LogDetails::default()).await?;
                }
                return Ok(TriggerResult::RateLimited("rate_limited"));
            }
        }
        let place = QueuePlace {
            service: self.clone(),
            key: queue_key,
        };
        // Checked and claimed in one transaction, so two requests with one key run once.
        if !replay_key.is_empty() {
            let (task_id, key, id) = (task.id.clone(), replay_key.clone(), delivery_id.clone());
            let claimed = self
                .blocking(move |db| store::claim_replay_key(db, &task_id, &key, &id, now))
                .await
                .map_err(|_| dedupe_error())?;
            if !claimed {
                drop(place);
                return Ok(TriggerResult::Accepted {
                    delivery_id,
                    outcome: "duplicate",
                });
            }
        }
        if let Err(error) = log(
            "accepted",
            LogDetails {
                signature_verified: signed,
                missing: rendered.missing.clone(),
                rendered_prompt: Some(rendered.prompt.clone()),
                error: None,
            },
        )
        .await
        {
            self.release_replay(&delivery_id).await;
            return Err(error);
        }
        // The run owns its queue place until it ends.
        let service = self.clone();
        let (run_delivery, prompt) = (delivery_id.clone(), rendered.prompt);
        tokio::spawn(async move {
            let _place = place;
            let permit = service.hooks().permit(&task.id);
            let Ok(_permit) = permit.acquire_owned().await else {
                return;
            };
            service
                .run_webhook_delivery(task, &run_delivery, prompt)
                .await;
        });
        Ok(TriggerResult::Accepted {
            delivery_id,
            outcome: "accepted",
        })
    }

    /// `runWebhookDelivery`: runs the task with the delivery's prompt. A delivery whose task
    /// was deleted, replaced, changed or paused meanwhile is skipped; a run that did not
    /// start gives its replay key back.
    async fn run_webhook_delivery(&self, task: ScheduledTask, delivery_id: &str, prompt: String) {
        let skipped = match self.find(&task.id).await {
            None => Some("The task was deleted before this delivery ran."),
            Some(active) if active.created_at != task.created_at => {
                Some("The task was replaced before this delivery ran.")
            }
            Some(active) if !matches!(active.schedule, ScheduledTaskSchedule::Webhook(_)) => {
                Some("The task's trigger changed before this delivery ran.")
            }
            Some(active) if !active.enabled => {
                Some("The task was paused before this delivery ran.")
            }
            Some(_) => None,
        };
        if let Some(reason) = skipped {
            self.mark_delivery_failed(delivery_id, reason).await;
            self.release_replay(delivery_id).await;
            return;
        }
        let run = super::WebhookRun {
            delivery_id: delivery_id.to_owned(),
            prompt,
        };
        match self.run_task(task, Trigger::Webhook, Some(&run)).await {
            Ok(outcome) if outcome.thread_id.is_some() => {}
            Ok(_) | Err(_) => {
                self.mark_delivery_failed(delivery_id, "The run failed to start.")
                    .await;
                self.release_replay(delivery_id).await;
            }
        }
    }
}

fn headers_of(row: &store::DeliveryRow) -> std::collections::BTreeMap<String, String> {
    serde_json::from_str(&row.headers_json).unwrap_or_default()
}

fn summary(row: &store::DeliveryRow) -> ScheduledTaskWebhookDeliverySummary {
    let headers = headers_of(row);
    ScheduledTaskWebhookDeliverySummary {
        id: row.delivery_id.clone(),
        task_id: row.task_id.clone(),
        received_at: row.received_at.clone(),
        method: row.method.clone(),
        content_type: headers.get("content-type").cloned(),
        body_bytes: row.body_bytes,
        outcome: row.outcome.clone(),
        signature_verified: row.signature_verified,
        // No coalescing windows here, so a delivery is never pending in one.
        pending_window: Some(false),
        missing_fields: serde_json::from_str(&row.missing_fields_json).unwrap_or_default(),
        error: row.error.clone(),
    }
}

#[cfg(test)]
mod tests;
