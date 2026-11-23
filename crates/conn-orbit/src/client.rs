//! Orbit's Conn Tasks reads over any Gateway transport.
//!
//! Port of `packages/client-runtime/src/orbitGateway/tasksClient.ts` (plus the `environments`
//! read of `client.ts`). Results carry Conn's error reasons and messages, so the panel can show
//! the same notices.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

use super::gateway::{GatewayRequest, GatewayTransport, OrbitGateway};
use super::tasks::{
    OrbitEnvironment, TaskDetail, TaskInsights, TaskInsightsQuery, TasksListQuery, TasksPage,
    decode_environments, decode_error_envelope, decode_task_detail, decode_task_insights,
    decode_tasks_page,
};

/// Unified classification for Orbit Gateway errors across Tasks, Profile, Fleet, and Thread Start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OrbitErrorReason {
    /// 403 `peer.identity_unknown`: this device is not an active Orbit Node.
    NotANode,
    /// 403 `node_access.required`: no access edge, or it was revoked.
    AccessRequired,
    /// 409 `extension.disabled`: the Conn or Tasks extension is off.
    ExtensionDisabled,
    /// 404: requested resource (task, environment, reservation, profile) was not found.
    NotFound,
    /// No transport, timeout, or the Gateway did not answer.
    Unreachable,
    /// The Gateway answered something this contract does not describe.
    InvalidResponse,
    /// 409 `conn.settings_version_conflict`: profile settings conflicted with a newer version.
    VersionConflict,
    /// 404/405: this Gateway build does not support the requested operation.
    Unsupported,
    /// Another Gateway error with a code/message (e.g. admission refusal, pairing error).
    Gateway,
}

/// Why a Tasks read failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TasksErrorReason {
    /// 403 `peer.identity_unknown`: this device is not an active Orbit Node.
    NotANode,
    /// 403 `node_access.required`: no access edge, or it was revoked.
    AccessRequired,
    /// 409 `extension.disabled`: the Conn or Tasks extension is off.
    ExtensionDisabled,
    /// 404 `http.404`: no such task, or a subtask id.
    NotFound,
    /// No transport, or the Gateway did not answer.
    Unreachable,
    /// The Gateway answered something this contract does not describe.
    InvalidResponse,
}

impl From<TasksErrorReason> for OrbitErrorReason {
    fn from(reason: TasksErrorReason) -> Self {
        match reason {
            TasksErrorReason::NotANode => Self::NotANode,
            TasksErrorReason::AccessRequired => Self::AccessRequired,
            TasksErrorReason::ExtensionDisabled => Self::ExtensionDisabled,
            TasksErrorReason::NotFound => Self::NotFound,
            TasksErrorReason::Unreachable => Self::Unreachable,
            TasksErrorReason::InvalidResponse => Self::InvalidResponse,
        }
    }
}

/// A failed read, with the message to show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TasksError {
    pub reason: TasksErrorReason,
    pub message: String,
}

pub type TasksResult<T> = Result<T, TasksError>;

/// Realtime notices only invalidate; the read that follows is authoritative.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TasksInvalidation {
    List,
    Task(i64),
}

impl TasksInvalidation {
    /// Whether a view of `task_id` must read again.
    pub fn touches(self, task_id: i64) -> bool {
        match self {
            Self::List => true,
            Self::Task(id) => id == task_id,
        }
    }
}

const ERROR_REASONS: [(u16, &str, TasksErrorReason); 4] = [
    (403, "peer.identity_unknown", TasksErrorReason::NotANode),
    (
        403,
        "node_access.required",
        TasksErrorReason::AccessRequired,
    ),
    (
        409,
        "extension.disabled",
        TasksErrorReason::ExtensionDisabled,
    ),
    (404, "http.404", TasksErrorReason::NotFound),
];

/// The Tasks client. Cheap to clone; clones share the transport and the invalidation channel.
#[derive(Clone)]
pub struct OrbitTasksClient {
    transport: Arc<dyn GatewayTransport>,
    invalidations: broadcast::Sender<TasksInvalidation>,
}

impl std::fmt::Debug for OrbitTasksClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrbitTasksClient").finish_non_exhaustive()
    }
}

impl OrbitTasksClient {
    pub fn new(transport: Arc<dyn GatewayTransport>) -> Self {
        let (invalidations, _) = broadcast::channel(64);
        Self {
            transport,
            invalidations,
        }
    }

    /// A client for the live Gateway at `https://gateway.orbit`.
    pub fn live() -> Result<Self, super::gateway::GatewayError> {
        Ok(Self::new(Arc::new(OrbitGateway::new()?)))
    }

    /// The transport, for the realtime follower.
    pub fn transport(&self) -> Arc<dyn GatewayTransport> {
        Arc::clone(&self.transport)
    }

    async fn read<T>(
        &self,
        request: GatewayRequest,
        decode: fn(&Value) -> Option<T>,
    ) -> TasksResult<T> {
        let path = request.path.clone();
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|cause| TasksError {
                reason: TasksErrorReason::Unreachable,
                message: format!("The Orbit Gateway did not answer: {cause}"),
            })?;
        let json = serde_json::from_str::<Value>(&response.body).unwrap_or(Value::Null);
        if !(200..300).contains(&response.status) {
            let envelope = decode_error_envelope(&json);
            let reason = ERROR_REASONS
                .iter()
                .find(|(status, code, _)| {
                    *status == response.status
                        && envelope.as_ref().is_some_and(|(found, _)| found == code)
                })
                .map_or(TasksErrorReason::Unreachable, |(_, _, reason)| *reason);
            return Err(TasksError {
                reason,
                message: envelope.map_or_else(
                    || format!("The Orbit Gateway answered {}.", response.status),
                    |(_, message)| message,
                ),
            });
        }
        decode(&json).ok_or_else(|| TasksError {
            reason: TasksErrorReason::InvalidResponse,
            message: format!("The Orbit Gateway sent an unexpected {path} response."),
        })
    }

    /// `GET /conn/tasks`: one page of the board, newest first.
    pub async fn list_tasks(&self, query: &TasksListQuery) -> TasksResult<TasksPage> {
        let mut request = GatewayRequest::get("/tasks");
        if let Some(project) = query.project {
            request = request.with_query("project", project.to_string());
        }
        if let Some(instance) = query.instance {
            request = request.with_query("instance", instance.to_string());
        }
        if let Some(status) = query.status {
            request = request.with_query("status", status.as_str());
        }
        if let Some(limit) = query.limit {
            request = request.with_query("limit", limit.to_string());
        }
        if let Some(cursor) = &query.cursor {
            request = request.with_query("cursor", cursor.clone());
        }
        self.read(request, decode_tasks_page).await
    }

    /// Every page of the board, following `next_cursor` (at most `max_pages` pages).
    pub async fn list_all_tasks(
        &self,
        query: &TasksListQuery,
        max_pages: usize,
    ) -> TasksResult<TasksPage> {
        let mut all = self.list_tasks(query).await?;
        let mut pages = 1;
        while let Some(cursor) = all.next_cursor.take()
            && pages < max_pages
        {
            let next = TasksListQuery {
                cursor: Some(cursor),
                ..query.clone()
            };
            let page = self.list_tasks(&next).await?;
            all.tasks.extend(page.tasks);
            all.skipped += page.skipped;
            all.next_cursor = page.next_cursor;
            pages += 1;
        }
        Ok(all)
    }

    /// `GET /conn/tasks/{task}`.
    pub async fn get_task(&self, task_id: i64) -> TasksResult<TaskDetail> {
        self.read(
            GatewayRequest::get(format!("/tasks/{task_id}")),
            decode_task_detail,
        )
        .await
    }

    /// `GET /api/v1/task-insights`: outside the Conn routes.
    pub async fn get_task_insights(&self, query: TaskInsightsQuery) -> TasksResult<TaskInsights> {
        let mut request = GatewayRequest::get("/task-insights")
            .at_root()
            .with_query("period", query.period.as_str());
        if let Some(project) = query.project {
            request = request.with_query("project_id", project.to_string());
        }
        self.read(request, decode_task_insights).await
    }

    /// `GET /conn/environments`: the Conn servers this Node may pair with.
    pub async fn environments(&self) -> TasksResult<Vec<OrbitEnvironment>> {
        self.read(GatewayRequest::get("/environments"), decode_environments)
            .await
    }

    /// Tells subscribers to read again: a Reverb notice, a reconnect, or a poll tick.
    pub fn invalidate(&self, target: TasksInvalidation) {
        // No subscriber is fine: nothing is shown that could go stale.
        let _ = self.invalidations.send(target);
    }

    /// Invalidations from now on. A lagged receiver should treat the gap as `List`.
    pub fn subscribe(&self) -> broadcast::Receiver<TasksInvalidation> {
        self.invalidations.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::super::gateway::{BoxFuture, GatewayError, GatewayResponse};
    use super::super::tasks::{AgentRole, AgentState, InsightsPeriod, SubtaskStatus};
    use super::*;

    struct Canned {
        status: u16,
        body: String,
        seen: Mutex<Vec<GatewayRequest>>,
    }

    impl Canned {
        fn new(status: u16, body: Value) -> Arc<Self> {
            Arc::new(Self {
                status,
                body: body.to_string(),
                seen: Mutex::new(Vec::new()),
            })
        }

        fn seen(&self) -> Vec<GatewayRequest> {
            self.seen
                .lock()
                .map(|seen| seen.clone())
                .unwrap_or_default()
        }
    }

    impl GatewayTransport for Canned {
        fn send(
            &self,
            request: GatewayRequest,
        ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            if let Ok(mut seen) = self.seen.lock() {
                seen.push(request);
            }
            let response = GatewayResponse {
                status: self.status,
                body: self.body.clone(),
            };
            Box::pin(async move { Ok(response) })
        }
    }

    struct Down;

    impl GatewayTransport for Down {
        fn send(&self, _: GatewayRequest) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
            Box::pin(async { Err(GatewayError::Network("ECONNREFUSED".to_owned())) })
        }
    }

    fn row() -> Value {
        json!({
            "id": 5753,
            "title": "Executor slice 4",
            "status": "running",
            "attention": null,
            "project": { "id": 78, "slug": "orbit", "name": "Orbit", "code": "ORB" },
            "workspace": {
                "instance_id": 3599, "name": "task-5753", "status": "active",
                "power_state": "running", "node": { "id": 9, "name": "beast" },
                "branch": "task-5753",
                "conn_environment_id": "a5bf17aa-d514-4c78-a644-edf55dba343f"
            },
            "pull_request": {
                "number": 3982, "url": "https://github.com/hardimpactdev/orbit/pull/3982",
                "state": "open"
            },
            "subtask_counts": {
                "total": 3, "todo": 1, "running": 1, "completed": 1, "failed": 0, "cancelled": 0
            },
            "created_at": "2026-11-17T11:30:00+00:00",
            "updated_at": "2026-11-17T16:11:09+00:00",
            "last_activity_at": "2026-11-17T16:11:09+00:00"
        })
    }

    fn with(mut base: Value, extra: Value) -> Value {
        if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
            base.extend(extra);
        }
        base
    }

    fn detail() -> Value {
        with(
            row(),
            json!({
                "brief": "markdown",
                "execution": { "implementer_mode": "per_subtask" },
                "metrics": {
                    "duration_ms": 16544479, "tokens": null, "lines_added": 120, "lines_deleted": 4
                },
                "subtasks": [
                    {
                        "id": 5755, "position": 2, "title": "Second", "brief": "b",
                        "deliverables": [], "status": "running", "attention": null,
                        "current_implementer_agent_id": 2570,
                        "metrics": {
                            "duration_ms": 60000, "tokens": null, "lines_added": 9, "lines_deleted": 1
                        }
                    },
                    {
                        "id": 5754, "position": 1, "title": "First", "brief": "a",
                        "deliverables": [{ "id": "proof", "type": "command", "description": "d" }],
                        "status": "completed", "attention": null,
                        "current_implementer_agent_id": 2568,
                        "metrics": {
                            "duration_ms": null, "tokens": null, "lines_added": null,
                            "lines_deleted": null
                        }
                    }
                ],
                "agents": [
                    {
                        "id": 2570, "role": "implementer", "subtask_ids": [5755], "current": true,
                        "attempt": 1, "provider": "claude", "model": "claude-opus-5-5",
                        "effort": "medium", "state": "working", "needs_input": false,
                        "created_at": "2026-11-17T15:00:00+00:00",
                        "observed_at": "2026-11-17T15:48:59+00:00",
                        "conn": {
                            "environment_id": "a5bf17aa-d514-4c78-a644-edf55dba343f",
                            "thread_id": "orbit:2c2312ee-9b57-4e54-90f5-71e2e95dda17"
                        }
                    },
                    {
                        "id": 2568, "role": "implementer", "subtask_ids": [5754], "current": true,
                        "attempt": 1, "provider": "codex", "model": null, "effort": null,
                        "state": null, "needs_input": false,
                        "created_at": "2026-11-17T14:00:00+00:00", "observed_at": null, "conn": null
                    }
                ]
            }),
        )
    }

    fn live_page() -> Value {
        json!({
            "data": [{
                "id": 5776,
                "title": "Conn Tasks panel read contract (item 11)",
                "status": "completed",
                "attention": null,
                "project": { "id": 78, "slug": "orbit", "name": "Orbit", "code": "ORB" },
                "workspace": null,
                "pull_request": {
                    "number": 3989, "url": "https://github.com/hardimpactdev/orbit/pull/3989",
                    "state": "merged"
                },
                "subtask_counts": {
                    "total": 1, "todo": 0, "running": 0, "completed": 1, "failed": 0, "cancelled": 0
                },
                "created_at": "2026-11-17T16:15:39+00:00",
                "updated_at": "2026-11-17T18:25:27+00:00",
                "last_activity_at": "2026-11-17T18:13:09+00:00",
                "deployed_at": null,
                "pr_opened_at": "2026-11-17T17:00:00+00:00"
            }],
            "meta": { "next_cursor": "5458" }
        })
    }

    fn client(transport: Arc<dyn GatewayTransport>) -> OrbitTasksClient {
        OrbitTasksClient::new(transport)
    }

    #[tokio::test]
    async fn decodes_a_live_page_and_passes_its_cursor_back_unchanged() {
        let transport = Canned::new(200, live_page());
        let client = client(transport.clone());
        let query = TasksListQuery {
            project: Some(78),
            limit: Some(50),
            ..TasksListQuery::default()
        };
        let page = client.list_tasks(&query).await.expect("page");
        let seen = transport.seen();
        assert_eq!(seen[0].path, "/tasks");
        assert_eq!(
            seen[0]
                .query
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect::<Vec<_>>(),
            vec![("limit", "50"), ("project", "78")]
        );
        assert_eq!(page.next_cursor.as_deref(), Some("5458"));
        assert_eq!(page.skipped, 0);
        let task = &page.tasks[0];
        assert_eq!(task.id, 5776);
        assert_eq!(task.pull_request.as_ref().map(|pr| pr.number), Some(3989));
        assert_eq!(task.workspace, None);
        assert_eq!(
            (task.subtask_counts.total, task.subtask_counts.completed),
            (1, 1)
        );
        let next = TasksListQuery {
            cursor: page.next_cursor.clone(),
            ..query
        };
        client.list_tasks(&next).await.expect("second page");
        assert_eq!(
            transport.seen()[1].query.get("cursor").map(String::as_str),
            Some("5458")
        );
    }

    #[tokio::test]
    async fn orders_subtasks_and_never_passes_subtask_lines() {
        let task = client(Canned::new(200, json!({ "data": detail() })))
            .get_task(5753)
            .await
            .expect("task");
        assert_eq!(
            task.implementer_mode(),
            super::super::tasks::ImplementerMode::PerSubtask
        );
        assert_eq!(task.metrics.duration_ms, Some(16_544_479.0));
        assert_eq!(task.metrics.lines_added, Some(120.0));
        let subtasks: Vec<_> = task
            .subtasks
            .iter()
            .map(|sub| (sub.id, sub.metrics.duration_ms, sub.metrics.lines_added))
            .collect();
        assert_eq!(
            subtasks,
            vec![(5754, None, None), (5755, Some(60_000.0), None)]
        );
        assert_eq!(
            task.agents[0].conn.as_ref().map(|c| c.thread_id.as_str()),
            Some("orbit:2c2312ee-9b57-4e54-90f5-71e2e95dda17")
        );
        assert_eq!(task.agents[1].conn, None);
    }

    #[tokio::test]
    async fn maps_gateway_errors_to_reasons() {
        for (status, code, reason) in [
            (403, "peer.identity_unknown", TasksErrorReason::NotANode),
            (
                403,
                "node_access.required",
                TasksErrorReason::AccessRequired,
            ),
            (
                409,
                "extension.disabled",
                TasksErrorReason::ExtensionDisabled,
            ),
            (404, "http.404", TasksErrorReason::NotFound),
            (500, "server.error", TasksErrorReason::Unreachable),
        ] {
            let body = json!({ "status": status, "error": { "code": code, "message": "Refused.", "details": {} } });
            let client = client(Canned::new(status, body));
            let expected = TasksError {
                reason,
                message: "Refused.".to_owned(),
            };
            assert_eq!(
                client.list_tasks(&TasksListQuery::default()).await,
                Err(expected.clone())
            );
            assert_eq!(client.get_task(1).await.map(|_| ()), Err(expected));
        }
    }

    #[tokio::test]
    async fn reports_a_failed_transport_and_an_off_contract_body() {
        let down = client(Arc::new(Down));
        let error = down.list_tasks(&TasksListQuery::default()).await.err();
        assert_eq!(
            error.as_ref().map(|e| e.reason),
            Some(TasksErrorReason::Unreachable)
        );
        assert_eq!(
            error.map(|e| e.message).as_deref(),
            Some("The Orbit Gateway did not answer: ECONNREFUSED")
        );
        let odd = client(Canned::new(200, json!({ "data": { "id": 1 } })));
        let error = odd.list_tasks(&TasksListQuery::default()).await.err();
        assert_eq!(
            error.as_ref().map(|e| e.reason),
            Some(TasksErrorReason::InvalidResponse)
        );
        assert_eq!(
            error.map(|e| e.message).as_deref(),
            Some("The Orbit Gateway sent an unexpected /tasks response.")
        );
        let plain = client(Canned::new(503, json!("unavailable")));
        assert_eq!(
            plain.get_task(1).await.err().map(|e| e.message).as_deref(),
            Some("The Orbit Gateway answered 503.")
        );
    }

    #[tokio::test]
    async fn reads_insights_below_api_v1_and_leaves_out_what_orbit_does_not_report() {
        let summary =
            json!({ "tasks": 31, "merged": 22, "tokens": 941_600_000, "lead_time_ms": 15_120_000 });
        let body = json!({
            "data": {
                "period": "7d",
                "current": with(summary.clone(), json!({ "pr_first_pass": "0.5", "pr_merge_wait_ms": 3_600_000 })),
                "previous": {},
                "weekly": [{ "week_start": "2026-11-09", "tokens_per_merged_pr": null }, { "week": 1 }],
                "daily": [{
                    "date": "2026-11-18", "merged": 3, "not_merged": 1, "lead_time_ms": 600,
                    "review_rounds": "2"
                }],
                "breakdowns": { "model": [{ "key": "gpt-5.5", "label": "gpt-5.5", "merged": 4 }] }
            }
        });
        let transport = Canned::new(200, body);
        let insights = client(transport.clone())
            .get_task_insights(TaskInsightsQuery {
                period: InsightsPeriod::Week,
                project: Some(78),
            })
            .await
            .expect("insights");
        let seen = &transport.seen()[0];
        assert_eq!(seen.path, "/task-insights");
        assert!(seen.root);
        assert_eq!(seen.query.get("period").map(String::as_str), Some("7d"));
        assert_eq!(seen.query.get("project_id").map(String::as_str), Some("78"));
        assert_eq!(insights.period, InsightsPeriod::Week);
        assert_eq!(insights.current.merged, Some(22.0));
        assert_eq!(insights.current.lead_time_ms, Some(15_120_000.0));
        assert_eq!(insights.current.pr_first_pass, None);
        assert_eq!(insights.current.pr_merge_wait_ms, Some(3_600_000.0));
        assert_eq!(insights.previous.merged, None);
        assert_eq!(insights.weekly.len(), 1);
        assert_eq!(insights.weekly[0].tokens_per_merged_pr, None);
        assert_eq!(insights.daily.len(), 1);
        assert_eq!(insights.daily[0].merged, 3.0);
        assert_eq!(insights.daily[0].values.merged, Some(3.0));
        assert_eq!(insights.daily[0].values.lead_time_ms, Some(600.0));
        assert_eq!(insights.daily[0].values.review_rounds, None);
        assert!(insights.hourly.is_empty());
        assert_eq!(insights.by_model[0].merged, Some(4.0));
        assert_eq!(insights.by_model[0].lead_time_ms, None);

        let day = client(Canned::new(
            200,
            json!({ "data": {
                "period": "24h", "current": summary, "previous": {}, "daily": [],
                "hourly": [{ "hour": "2026-11-19T10:00:00+00:00", "merged": 2, "not_merged": 0 }, { "hour": 1 }]
            }}),
        ))
        .get_task_insights(TaskInsightsQuery {
            period: InsightsPeriod::Day,
            project: None,
        })
        .await
        .expect("day");
        assert_eq!(day.hourly.len(), 1);
        assert_eq!(day.hourly[0].values.merged, Some(2.0));

        let failing = client(Canned::new(
            500,
            json!({ "error": { "code": "gateway.unhandled", "message": "Not completed." } }),
        ));
        assert_eq!(
            failing
                .get_task_insights(TaskInsightsQuery {
                    period: InsightsPeriod::Month,
                    project: None
                })
                .await
                .err(),
            Some(TasksError {
                reason: TasksErrorReason::Unreachable,
                message: "Not completed.".to_owned()
            })
        );
    }

    #[tokio::test]
    async fn skips_list_rows_off_the_contract() {
        let pr = with(row()["pull_request"].clone(), json!({ "state": "draft" }));
        let body = json!({ "data": [
            with(row(), json!({ "id": 1, "status": "blocked" })),
            row(),
            with(row(), json!({ "id": 2, "attention": { "kind": "escalation", "question": null, "reason": null } })),
            with(row(), json!({ "id": 3, "pull_request": pr })),
        ]});
        let page = client(Canned::new(200, body))
            .list_tasks(&TasksListQuery::default())
            .await
            .expect("page");
        assert_eq!(
            page.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![5753]
        );
        assert_eq!(page.skipped, 3);
    }

    #[tokio::test]
    async fn degrades_an_unknown_subtask_or_agent_literal_to_that_item() {
        let mut data = detail();
        let escalation = json!({ "kind": "escalation", "question": null, "reason": null });
        data["subtasks"][0]["status"] = json!("paused");
        data["subtasks"][0]["attention"] = escalation.clone();
        data["subtasks"][1]["attention"] = escalation;
        data["agents"][0]["role"] = json!("planner");
        data["agents"][0]["state"] = json!("sleeping");
        let task = client(Canned::new(200, json!({ "data": data })))
            .get_task(5753)
            .await
            .expect("task");
        let subtasks: Vec<_> = task
            .subtasks
            .iter()
            .map(|s| (s.id, s.status, s.attention.clone()))
            .collect();
        assert_eq!(
            subtasks,
            vec![
                (5754, SubtaskStatus::Unknown, None),
                (5755, SubtaskStatus::Unknown, None)
            ]
        );
        let agents: Vec<_> = task
            .agents
            .iter()
            .map(|a| (a.id, a.role, a.state))
            .collect();
        assert_eq!(
            agents,
            vec![
                (2570, AgentRole::Unknown, Some(AgentState::Unknown)),
                (2568, AgentRole::Implementer, None)
            ]
        );
    }

    #[tokio::test]
    async fn tells_subscribers_to_read_again_until_they_leave() {
        let client = client(Canned::new(200, json!({})));
        let mut receiver = client.subscribe();
        client.invalidate(TasksInvalidation::Task(5753));
        assert_eq!(
            receiver.recv().await.ok(),
            Some(TasksInvalidation::Task(5753))
        );
        drop(receiver);
        client.invalidate(TasksInvalidation::List);
        let mut late = client.subscribe();
        assert!(late.try_recv().is_err());
    }

    #[tokio::test]
    async fn reads_environments() {
        let body = json!({ "data": [{
            "environment_id": "env-1", "label": "beast", "url": "https://x", "status": "registered",
            "power_state": "stopped", "instance_id": 3, "project_name": "  "
        }]});
        let environments = client(Canned::new(200, body))
            .environments()
            .await
            .expect("list");
        assert_eq!(
            environments[0].power_state,
            Some(super::super::tasks::PowerState::Stopped)
        );
        assert_eq!(environments[0].project_name, None);
        let bad = client(Canned::new(200, json!({ "data": [{ "label": "x" }] })));
        assert_eq!(
            bad.environments().await.err().map(|e| e.reason),
            Some(TasksErrorReason::InvalidResponse)
        );
    }
}
