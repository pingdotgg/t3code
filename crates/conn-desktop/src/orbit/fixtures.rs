//! Offline Tasks data, in the Gateway's wire form so it runs through the real decoder.
//!
//! Port of `apps/web/src/orbit/tasks/orbitTasksFixtures.ts`. Use [`FixtureTransport`] with
//! [`OrbitTasksClient::new`](super::client::OrbitTasksClient::new) to render the panel offline,
//! or to show each error scenario.

use serde_json::{Value, json};

use super::gateway::{BoxFuture, GatewayError, GatewayRequest, GatewayResponse, GatewayTransport};
use super::insights::{format_iso_ms, parse_date_ms};
use super::tasks::{
    InsightsPeriod, TaskDetail, TaskInsights, TaskSummary, decode_task_detail,
    decode_task_insights, decode_tasks_page,
};

const ENV: &str = "a5bf17aa-d514-4c78-a644-edf55dba343f";
const AT: &str = "2026-11-17T16:11:09+00:00";

/// What the fixture Gateway answers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum FixtureScenario {
    #[default]
    Default,
    Empty,
    NotANode,
    AccessRequired,
    ExtensionDisabled,
    Unreachable,
}

impl FixtureScenario {
    pub const ALL: [Self; 6] = [
        Self::Default,
        Self::Empty,
        Self::NotANode,
        Self::AccessRequired,
        Self::ExtensionDisabled,
        Self::Unreachable,
    ];

    /// Conn's scenario name, as in `conn:orbit-tasks-fixture`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Empty => "empty",
            Self::NotANode => "not-a-node",
            Self::AccessRequired => "access-required",
            Self::ExtensionDisabled => "extension-disabled",
            Self::Unreachable => "unreachable",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|scenario| scenario.name() == name)
    }
}

/// Changes to task 482, for tests and demos.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FixtureOverrides {
    /// `(environment_id, thread_id)` for every agent of task 482.
    pub conversation: Option<(String, String)>,
    /// `(number, url)` of task 482's pull request.
    pub pull_request: Option<(i64, String)>,
    pub tokens: Option<f64>,
    /// Answers the insights read the way the Gateway did before Orbit 6040.
    pub insights_failure: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkspaceKind {
    None,
    Running,
    Stopped,
    NoConn,
    Removed,
}

#[derive(Clone, Copy)]
struct FixtureInput {
    id: i64,
    title: &'static str,
    status: &'static str,
    subtasks: &'static [&'static str],
    /// `(kind, question, reason)`.
    attention: Option<(&'static str, Option<&'static str>, Option<&'static str>)>,
    workspace: Option<WorkspaceKind>,
    pr: Option<(i64, Option<&'static str>)>,
    duration_minutes: Option<i64>,
    lines: Option<(i64, i64)>,
    /// Future Orbit mode; Orbit runs every task per subtask today.
    shared: bool,
    /// Subtask positions (1-based) whose first implementer attempt was replaced.
    replaced: &'static [usize],
    /// Subtask positions that went through a review.
    reviewed: &'static [usize],
}

const BASE: FixtureInput = FixtureInput {
    id: 0,
    title: "",
    status: "backlog",
    subtasks: &[],
    attention: None,
    workspace: None,
    pr: None,
    duration_minutes: None,
    lines: None,
    shared: false,
    replaced: &[],
    reviewed: &[],
};

const FIXTURES: [FixtureInput; 10] = [
    FixtureInput {
        id: 520,
        title: "Offline drafts on iOS",
        status: "backlog",
        ..BASE
    },
    FixtureInput {
        id: 510,
        title: "Keyboard shortcuts for the Tasks panel",
        status: "todo",
        subtasks: &["todo", "todo"],
        ..BASE
    },
    FixtureInput {
        id: 482,
        title: "Image attachments in the composer",
        status: "running",
        subtasks: &["completed", "running", "todo", "todo"],
        reviewed: &[1],
        pr: Some((1931, Some("open"))),
        duration_minutes: Some(38),
        lines: Some((610, 88)),
        ..BASE
    },
    FixtureInput {
        id: 470,
        title: "Thread search across environments",
        status: "reviewing",
        subtasks: &["completed", "completed", "reviewing"],
        reviewed: &[1, 2, 3],
        pr: Some((1902, Some("open"))),
        duration_minutes: Some(71),
        lines: Some((902, 140)),
        ..BASE
    },
    FixtureInput {
        id: 465,
        title: "Usage limits per provider",
        status: "running",
        subtasks: &["completed", "running", "todo"],
        attention: Some(("question", Some("Per model or per provider?"), None)),
        duration_minutes: Some(22),
        ..BASE
    },
    FixtureInput {
        id: 458,
        title: "Desktop auto-update channel",
        status: "running",
        subtasks: &["completed", "todo"],
        attention: Some(("direction", None, Some("Needs the signing certificate."))),
        workspace: Some(WorkspaceKind::Stopped),
        ..BASE
    },
    FixtureInput {
        id: 452,
        title: "Shared implementer (future Orbit mode)",
        status: "settling",
        subtasks: &["completed", "reviewing"],
        reviewed: &[2],
        shared: true,
        workspace: Some(WorkspaceKind::NoConn),
        ..BASE
    },
    FixtureInput {
        id: 449,
        title: "Migrate settings storage",
        status: "failed",
        subtasks: &["completed", "failed"],
        replaced: &[2],
        attention: Some(("failure", None, Some("Migration test failed twice."))),
        workspace: Some(WorkspaceKind::Removed),
        duration_minutes: Some(54),
        lines: Some((312, 97)),
        ..BASE
    },
    FixtureInput {
        id: 440,
        title: "Legacy sync cleanup",
        status: "cancelled",
        subtasks: &["completed", "cancelled"],
        workspace: Some(WorkspaceKind::Removed),
        ..BASE
    },
    FixtureInput {
        id: 431,
        title: "Right panel tab reordering",
        status: "completed",
        subtasks: &["completed", "completed"],
        reviewed: &[2],
        pr: Some((1870, Some("merged"))),
        duration_minutes: Some(46),
        lines: Some((214, 61)),
        ..BASE
    },
];

const SUBTASK_TITLES: [&str; 4] = [
    "Upload limits per provider",
    "Attachment chips in the composer",
    "Paste and drop handling",
    "iOS photo picker",
];

const LIST_KEYS: [&str; 11] = [
    "id",
    "title",
    "status",
    "attention",
    "project",
    "workspace",
    "pull_request",
    "subtask_counts",
    "created_at",
    "updated_at",
    "last_activity_at",
];

fn no_metrics() -> Value {
    json!({ "duration_ms": null, "tokens": null, "lines_added": null, "lines_deleted": null })
}

fn workspace_of(input: &FixtureInput) -> Value {
    let kind = input
        .workspace
        .unwrap_or(if matches!(input.status, "backlog" | "todo") {
            WorkspaceKind::None
        } else {
            WorkspaceKind::Running
        });
    if kind == WorkspaceKind::None {
        return Value::Null;
    }
    json!({
        "instance_id": 3000 + input.id,
        "name": format!("task-{}", input.id),
        "status": if kind == WorkspaceKind::Removed { "removed" } else { "active" },
        "power_state": match kind {
            WorkspaceKind::Stopped => json!("stopped"),
            WorkspaceKind::Removed => Value::Null,
            _ => json!("running"),
        },
        "node": { "id": 9, "name": "beast" },
        "branch": format!("task-{}", input.id),
        "conn_environment_id": if kind == WorkspaceKind::Running { json!(ENV) } else { Value::Null },
    })
}

fn detail_of(input: &FixtureInput) -> Value {
    let workspace = workspace_of(input);
    let reachable = !workspace["conn_environment_id"].is_null();
    let mut agent_id = input.id * 10;
    let mut agents: Vec<Value> = Vec::new();
    let mut add_agent = |role: &str,
                         subtask_ids: Vec<i64>,
                         current: bool,
                         attempt: i64,
                         state: &str| {
        agent_id += 1;
        let reviewer = role == "reviewer";
        agents.push(json!({
            "id": agent_id,
            "role": role,
            "subtask_ids": subtask_ids,
            "current": current,
            "attempt": attempt,
            "provider": if reviewer { "claude" } else { "codex" },
            "model": if reviewer { "claude-opus-5-5" } else { "gpt-5.5-codex" },
            "effort": "medium",
            "state": state,
            "needs_input": state == "asking_for_input",
            "created_at": AT,
            "observed_at": AT,
            "conn": if reachable {
                json!({ "environment_id": ENV, "thread_id": format!("orbit:{}-{agent_id}", input.id) })
            } else {
                Value::Null
            },
        }));
        agent_id
    };
    let question = input
        .attention
        .is_some_and(|(kind, _, _)| kind == "question");
    let state_for = |status: &str| match status {
        "running" if question => "asking_for_input",
        "running" => "working",
        "completed" => "done",
        "failed" => "failed",
        _ => "idle",
    };
    let subtask_ids: Vec<i64> = (1..=input.subtasks.len() as i64)
        .map(|i| input.id + i)
        .collect();
    let shared_id = (input.shared && input.subtasks.iter().any(|s| *s != "todo"))
        .then(|| add_agent("implementer", subtask_ids.clone(), true, 1, "working"));
    let mut subtasks = Vec::new();
    for (index, status) in input.subtasks.iter().enumerate() {
        let id = subtask_ids[index];
        let position = index + 1;
        let started = !matches!(*status, "todo" | "reserved");
        let mut current = shared_id;
        if started && !input.shared {
            let replaced = input.replaced.contains(&position);
            if replaced {
                add_agent("implementer", vec![id], false, 1, "failed");
            }
            current = Some(add_agent(
                "implementer",
                vec![id],
                true,
                if replaced { 2 } else { 1 },
                state_for(status),
            ));
        }
        if input.reviewed.contains(&position) {
            let reviewing = *status == "reviewing";
            add_agent(
                "reviewer",
                vec![id],
                reviewing,
                1,
                if reviewing { "working" } else { "done" },
            );
        }
        let title = SUBTASK_TITLES
            .get(index)
            .map_or_else(|| format!("Subtask {position}"), |t| (*t).to_owned());
        let brief_name = SUBTASK_TITLES
            .get(index)
            .map_or_else(|| format!("subtask {position}"), |t| (*t).to_owned());
        let mut metrics = no_metrics();
        if started {
            metrics["duration_ms"] = json!((index as i64 + 1) * 9 * 60_000);
        }
        subtasks.push(json!({
            "id": id,
            "position": position,
            "title": title,
            "brief": format!("Deliver {brief_name}."),
            "deliverables": [{ "id": "proof", "type": "command", "description": "Focused tests pass." }],
            "status": status,
            "attention": null,
            "current_implementer_agent_id": current,
            "metrics": metrics,
        }));
    }
    let count = |names: &[&str]| input.subtasks.iter().filter(|s| names.contains(s)).count();
    json!({
        "id": input.id,
        "title": input.title,
        "status": input.status,
        "attention": input.attention.map(|(kind, question, reason)| {
            json!({ "kind": kind, "question": question, "reason": reason })
        }),
        "project": { "id": 78, "slug": "conn", "name": "Conn", "code": "CON" },
        "workspace": workspace,
        "pull_request": input.pr.map(|(number, state)| json!({
            "number": number,
            "state": state,
            "url": format!("https://github.com/nckrtl/conn/pull/{number}"),
        })),
        "subtask_counts": {
            "total": input.subtasks.len(),
            "todo": count(&["todo", "reserved"]),
            "running": count(&["running", "reviewing"]),
            "completed": count(&["completed"]),
            "failed": count(&["failed"]),
            "cancelled": count(&["cancelled"]),
        },
        "created_at": AT,
        "updated_at": AT,
        "last_activity_at": if input.status == "backlog" { Value::Null } else { json!(AT) },
        "brief": format!("{}.\n\n## Outcome\nA fixture brief for the Tasks panel.", input.title),
        "execution": { "implementer_mode": if input.shared { "shared" } else { "per_subtask" } },
        "metrics": {
            "duration_ms": input.duration_minutes.map(|m| m * 60_000),
            "tokens": null,
            "lines_added": input.lines.map(|(added, _)| added),
            "lines_deleted": input.lines.map(|(_, deleted)| deleted),
        },
        "subtasks": subtasks,
        "agents": agents,
    })
}

const DAY_MS: i64 = 86_400_000;

/// Orbit's `/task-insights` answer, shaped like its own fixture; no 6041/6042 summary fields yet.
fn insights_of(period: InsightsPeriod) -> Value {
    let end = parse_date_ms("2026-11-19T00:00:00+00:00").unwrap_or_default();
    let days: i64 = match period {
        InsightsPeriod::Day => 1,
        InsightsPeriod::Week => 7,
        InsightsPeriod::Month => 30,
    };
    let scale = days as f64 / 30.0;
    let summary = |merged: f64, tokens_per_pr: f64, lead_minutes: f64, first_pass: f64| {
        json!({
            "tasks": (merged * 1.4).round(),
            "merged": merged,
            "excluded": 2,
            "tokens": (merged * tokens_per_pr * 1.2).round(),
            "cost_usd": merged * 3.1,
            "tokens_per_merged_pr": tokens_per_pr,
            "cost_per_merged_pr": 3.1,
            "lead_time_ms": lead_minutes * 60_000.0,
            "queue_ms": 1_800_000,
            "work_ms": 9_720_000,
            "merge_wait_ms": 3_600_000,
            "yield": 0.71,
            "pr_first_pass": first_pass,
            "wasted_share": 0.15,
            "subtask_first_pass": 0.64,
            "review_rounds": 1.3,
            "handoff_first_try": 0.74,
            "questions_per_task": 0.4,
            "questions_by_cause": {},
            "cache_hit": 0.86,
            "tokens_per_hundred_lines": 4100,
        })
    };
    let day = |offset: i64| format_iso_ms(end - offset * DAY_MS)[..10].to_owned();
    // A bucket's own numbers (Orbit 6112); a bucket without merges has no medians.
    let bucket = |index: i64, merged: i64, mut row: Value| {
        let wave = (index as f64 / 2.5).sin();
        let some = |value: f64| {
            if merged == 0 {
                Value::Null
            } else {
                json!(value)
            }
        };
        let merged_f = merged as f64;
        for (key, value) in [
            (
                "tokens",
                some((merged_f * (1_500_000.0 + wave * 300_000.0)).round()),
            ),
            (
                "tokens_per_merged_pr",
                some((1_400_000.0 + wave * 250_000.0).round()),
            ),
            ("wasted_share", some(0.15 + wave * 0.05)),
            (
                "lead_time_ms",
                some(((170.0 + wave * 40.0) * 60_000.0).round()),
            ),
            (
                "delivery_time_ms",
                some(((200.0 + wave * 45.0) * 60_000.0).round()),
            ),
            ("pr_first_pass", some(0.6 + wave * 0.15)),
            (
                "pr_merge_wait_ms",
                some(((55.0 + wave * 20.0) * 60_000.0).round()),
            ),
            ("review_rounds", some(1.4 + wave * 0.3)),
        ] {
            row[key] = value;
        }
        row
    };
    let mut previous = summary((128.0 * scale).round(), 1_550_000.0, 195.0, 0.63);
    previous["review_rounds"] = json!(1.5);
    previous["wasted_share"] = json!(0.18);
    let weekly: Vec<Value> = (0..12)
        .map(|index: i64| {
            json!({
                "week_start": day((12 - index) * 7),
                "tasks": 30,
                "merged": 24,
                "tokens_per_merged_pr": if index == 4 {
                    Value::Null
                } else {
                    json!(1_900_000 - index * 40_000 + (index % 3) * 90_000)
                },
            })
        })
        .collect();
    let hourly: Vec<Value> = if period == InsightsPeriod::Day {
        (0..24)
            .map(|index: i64| {
                let merged = [0, 1, 0, 2, 1, 0][(index % 6) as usize];
                bucket(
                    index,
                    merged,
                    json!({
                        "hour": format_iso_ms(end - (24 - index) * 3_600_000),
                        "merged": merged,
                        "not_merged": i64::from(index % 7 == 0),
                    }),
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    let daily: Vec<Value> = if period == InsightsPeriod::Day {
        Vec::new()
    } else {
        (0..days)
            .map(|index| {
                let merged =
                    [3, 5, 4, 2, 6, 4, 3, 1, 5, 7, 2, 4, 6, 3][(index % 14) as usize] + index / 10;
                bucket(
                    index,
                    merged,
                    json!({
                        "date": day(days - index),
                        "merged": merged,
                        "not_merged": i64::from(index % 4 == 0),
                    }),
                )
            })
            .collect()
    };
    let model = |key: &str, tasks: i64, merged: i64, tokens: i64, lead: i64, r#yield: f64| {
        json!({
            "key": key, "label": key, "tasks": tasks, "merged": merged,
            "tokens_per_merged_pr": tokens, "lead_time_ms": lead, "yield": r#yield,
        })
    };
    json!({
        "data": {
            "period": period.as_str(),
            "from": format!("{}T00:00:00+00:00", day(days)),
            "to": format!("{}T00:00:00+00:00", day(0)),
            "current": summary((117.0 * scale).round(), 1_410_000.0, 179.0, 0.63),
            "previous": previous,
            "weekly": weekly,
            "hourly": hourly,
            "daily": daily,
            "breakdowns": {
                "model": [
                    model("gpt-5.5-codex", 70, 61, 1_520_000, 9_900_000, 0.87),
                    model("claude-opus-5-5", 40, 36, 1_310_000, 11_400_000, 0.9),
                    model("gemini-3-pro", 25, 20, 1_180_000, 12_600_000, 0.8),
                ],
                "project": [],
                "release": [],
            },
        }
    })
}

fn respond(status: u16, body: &Value) -> GatewayResponse {
    GatewayResponse {
        status,
        body: body.to_string(),
    }
}

fn failure(status: u16, code: &str, message: &str) -> GatewayResponse {
    respond(
        status,
        &json!({ "status": status, "error": { "code": code, "message": message, "details": {} } }),
    )
}

/// A Gateway transport that answers the Tasks routes (and `/environments`) from fixtures.
#[derive(Debug, Clone, Default)]
pub struct FixtureTransport {
    pub scenario: FixtureScenario,
    pub overrides: Option<FixtureOverrides>,
}

impl FixtureTransport {
    pub fn new(scenario: FixtureScenario) -> Self {
        Self {
            scenario,
            overrides: None,
        }
    }

    fn details(&self) -> Vec<Value> {
        if self.scenario == FixtureScenario::Empty {
            return Vec::new();
        }
        FIXTURES
            .iter()
            .map(|input| {
                let mut detail = detail_of(input);
                if let (482, Some(options)) = (input.id, &self.overrides) {
                    if let Some((environment_id, thread_id)) = &options.conversation {
                        if let Some(agents) = detail["agents"].as_array_mut() {
                            for agent in agents {
                                agent["conn"] = json!({ "environment_id": environment_id, "thread_id": thread_id });
                            }
                        }
                        if !detail["workspace"].is_null() {
                            detail["workspace"]["conn_environment_id"] = json!(environment_id);
                        }
                    }
                    if let Some((number, url)) = &options.pull_request {
                        detail["pull_request"] = json!({ "number": number, "url": url, "state": "open" });
                    }
                    if let Some(tokens) = options.tokens {
                        detail["metrics"]["tokens"] = json!(tokens);
                    }
                }
                detail
            })
            .collect()
    }

    /// The answer to one request.
    pub fn answer(&self, request: &GatewayRequest) -> Result<GatewayResponse, GatewayError> {
        match self.scenario {
            FixtureScenario::NotANode => {
                return Ok(failure(
                    403,
                    "peer.identity_unknown",
                    "This address is not an active Node.",
                ));
            }
            FixtureScenario::AccessRequired => {
                return Ok(failure(
                    403,
                    "node_access.required",
                    "This Node has no access to the Gateway.",
                ));
            }
            FixtureScenario::ExtensionDisabled => {
                return Ok(failure(
                    409,
                    "extension.disabled",
                    "The Tasks extension is disabled.",
                ));
            }
            FixtureScenario::Unreachable => {
                return Err(GatewayError::Network("connect ECONNREFUSED".to_owned()));
            }
            FixtureScenario::Default | FixtureScenario::Empty => {}
        }
        if request.path == "/task-insights" {
            if self.overrides.as_ref().is_some_and(|o| o.insights_failure) {
                return Ok(failure(
                    500,
                    "gateway.unhandled",
                    "The gateway could not complete the request.",
                ));
            }
            let period = match request.query.get("period").map(String::as_str) {
                Some("24h") => InsightsPeriod::Day,
                Some("7d") => InsightsPeriod::Week,
                _ => InsightsPeriod::Month,
            };
            return Ok(respond(200, &insights_of(period)));
        }
        let details = self.details();
        if request.path == "/tasks" {
            let rows: Vec<Value> = details
                .iter()
                .map(|detail| {
                    Value::Object(
                        LIST_KEYS
                            .iter()
                            .map(|key| ((*key).to_owned(), detail[*key].clone()))
                            .collect(),
                    )
                })
                .collect();
            return Ok(respond(
                200,
                &json!({ "data": rows, "meta": { "next_cursor": null } }),
            ));
        }
        if request.path == "/environments" {
            return Ok(respond(
                200,
                &json!({ "data": [{
                    "environment_id": ENV, "label": "task-482", "url": "https://task-482.beast.orbit",
                    "status": "registered", "power_state": "running", "instance_id": 3482,
                    "node_name": "beast", "project_name": "Conn", "project_slug": "conn",
                    "registered_at": AT
                }]}),
            ));
        }
        let id = request
            .path
            .strip_prefix("/tasks/")
            .and_then(|id| id.parse::<i64>().ok());
        match details
            .into_iter()
            .find(|d| id.is_some() && d["id"].as_i64() == id)
        {
            Some(detail) => Ok(respond(200, &json!({ "data": detail }))),
            None => Ok(failure(404, "http.404", "Not found.")),
        }
    }
}

impl GatewayTransport for FixtureTransport {
    fn send(
        &self,
        request: GatewayRequest,
    ) -> BoxFuture<'_, Result<GatewayResponse, GatewayError>> {
        let answer = self.answer(&request);
        Box::pin(async move { answer })
    }
}

/// The default board, decoded.
pub fn fixture_tasks() -> Vec<TaskSummary> {
    let transport = FixtureTransport::default();
    transport
        .answer(&GatewayRequest::get("/tasks"))
        .ok()
        .and_then(|response| serde_json::from_str(&response.body).ok())
        .and_then(|json| decode_tasks_page(&json))
        .map(|page| page.tasks)
        .unwrap_or_default()
}

/// One default task's detail, decoded.
pub fn fixture_task(id: i64) -> Option<TaskDetail> {
    let response = FixtureTransport::default()
        .answer(&GatewayRequest::get(format!("/tasks/{id}")))
        .ok()?;
    decode_task_detail(&serde_json::from_str(&response.body).ok()?)
}

/// The default insights for one period, decoded.
pub fn fixture_insights(period: InsightsPeriod) -> Option<TaskInsights> {
    decode_task_insights(&insights_of(period))
}

#[cfg(test)]
mod tests {
    use super::super::client::{OrbitTasksClient, TasksErrorReason};
    use super::super::insights::{InsightId, format_insight_value, insight_result, insight_trend};
    use super::super::tasks::{TaskInsightsQuery, TasksListQuery};
    use super::*;
    use std::sync::Arc;

    #[test]
    fn every_fixture_decodes() {
        assert_eq!(fixture_tasks().len(), 10);
        for input in FIXTURES {
            let task = fixture_task(input.id);
            assert!(task.is_some(), "{}", input.id);
        }
        for period in InsightsPeriod::ALL {
            assert!(fixture_insights(period).is_some());
        }
    }

    #[test]
    fn fixture_insights_read_like_conn() {
        let month = fixture_insights(InsightsPeriod::Month);
        let completed = insight_result(month.as_ref(), InsightId::Completed);
        assert_eq!(completed.value, Some(117.0));
        assert_eq!(completed.change, Some(-9.0));
        assert_eq!(
            month
                .as_ref()
                .and_then(|m| m.current.tokens_per_merged_pr)
                .map(|v| format_insight_value(InsightId::Tokens, v))
                .as_deref(),
            Some("1.41M")
        );
        assert_eq!(
            insight_trend(month.as_ref(), InsightId::Completed).map(|t| t.len()),
            Some(15)
        );
        let day = fixture_insights(InsightsPeriod::Day);
        assert_eq!(day.as_ref().map(|d| d.hourly.len()), Some(24));
        assert_eq!(
            day.as_ref().map(|d| d.hourly[0].date.clone()).as_deref(),
            Some("2026-11-18T00:00:00.000Z")
        );
        assert_eq!(
            insight_trend(day.as_ref(), InsightId::Spent).map(|t| t.len()),
            Some(24)
        );
    }

    #[tokio::test]
    async fn scenarios_answer_through_the_client() {
        let client = |scenario| OrbitTasksClient::new(Arc::new(FixtureTransport::new(scenario)));
        let query = TasksListQuery::default();
        assert_eq!(
            client(FixtureScenario::Empty)
                .list_tasks(&query)
                .await
                .map(|p| p.tasks.len()),
            Ok(0)
        );
        for (scenario, reason) in [
            (FixtureScenario::NotANode, TasksErrorReason::NotANode),
            (
                FixtureScenario::AccessRequired,
                TasksErrorReason::AccessRequired,
            ),
            (
                FixtureScenario::ExtensionDisabled,
                TasksErrorReason::ExtensionDisabled,
            ),
            (FixtureScenario::Unreachable, TasksErrorReason::Unreachable),
        ] {
            assert_eq!(
                client(scenario)
                    .list_tasks(&query)
                    .await
                    .err()
                    .map(|e| e.reason),
                Some(reason)
            );
        }
        let default = client(FixtureScenario::Default);
        assert_eq!(
            default.get_task(1).await.err().map(|e| e.reason),
            Some(TasksErrorReason::NotFound)
        );
        assert!(
            default
                .get_task_insights(TaskInsightsQuery {
                    period: InsightsPeriod::Week,
                    project: Some(78)
                })
                .await
                .is_ok()
        );
        assert_eq!(default.environments().await.map(|e| e.len()), Ok(1));
        let failing = OrbitTasksClient::new(Arc::new(FixtureTransport {
            scenario: FixtureScenario::Default,
            overrides: Some(FixtureOverrides {
                insights_failure: true,
                tokens: Some(123.0),
                ..FixtureOverrides::default()
            }),
        }));
        assert!(
            failing
                .get_task_insights(TaskInsightsQuery {
                    period: InsightsPeriod::Month,
                    project: None
                })
                .await
                .is_err()
        );
        assert_eq!(
            failing.get_task(482).await.map(|t| t.metrics.tokens),
            Ok(Some(123.0))
        );
        assert_eq!(
            FixtureScenario::from_name("not-a-node"),
            Some(FixtureScenario::NotANode)
        );
    }
}
