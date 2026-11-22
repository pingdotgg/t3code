//! The Tasks surface (Conn `apps/web/src/orbit/tasks/`): live Orbit task board with search,
//! board settings, 2-row insight metrics with GPUI sparklines and expandable trend charts,
//! status lanes, realtime invalidation updates, and full task/subtask detail navigation.

mod board;
mod charts;
mod detail;
mod format;
mod insights;

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use conn_desktop::orbit::board::{ErrorNoticeKind, tasks_error_notice};
use conn_desktop::orbit::client::{OrbitTasksClient, TasksError, TasksInvalidation};
use conn_desktop::orbit::detail::TaskObserver;
use conn_desktop::orbit::fixtures::{FixtureScenario, FixtureTransport};
use conn_desktop::orbit::insights::InsightId;
use conn_desktop::orbit::panel::{
    TasksBoardSettings, TasksDetailTab, TasksNavigation, TasksPanelState, TasksView,
};
use conn_desktop::orbit::realtime::{TasksFollower, TasksLiveStatus, follow_orbit_tasks};
use conn_desktop::orbit::tasks::{
    InsightsPeriod, TaskInsights, TaskInsightsQuery, TaskLane, TasksListQuery, TasksPage,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    Bounds, Context, Entity, IntoElement, KeyDownEvent, MouseButton, Pixels, Render, ScrollHandle,
    Subscription, Window, div,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;

use self::board::{BoardCallbacks, render_board, render_notice};
use self::detail::{DetailCallbacks, DetailLoadState, render_task_detail};
use self::format::now_epoch_ms;
use super::color::to_hsla;
use super::header::superhero_icon;

/// Orbit's insights refresh every 5 minutes (`TasksInsights.tsx`: `INSIGHTS_POLL_MS`).
const INSIGHTS_POLL_INTERVAL: Duration = Duration::from_secs(300);
/// Task card relative timestamps and working durations tick every minute (`useNowMinute`).
const CLOCK_TICK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
enum ListLoadState {
    Loading,
    Ready(TasksPage),
    Error(TasksError),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedBoardSettings {
    #[serde(default)]
    hidden_lanes: Vec<TaskLane>,
    #[serde(default)]
    hidden_insights: Vec<InsightIdSerde>,
    #[serde(default = "default_period")]
    insight_period: InsightsPeriod,
}

fn default_period() -> InsightsPeriod {
    InsightsPeriod::Month
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum InsightIdSerde {
    Completed,
    Spent,
    Tokens,
    Wasted,
    Delivery,
    FirstPass,
    MergeWait,
    ReviewRounds,
}

impl From<InsightId> for InsightIdSerde {
    fn from(id: InsightId) -> Self {
        match id {
            InsightId::Completed => Self::Completed,
            InsightId::Spent => Self::Spent,
            InsightId::Tokens => Self::Tokens,
            InsightId::Wasted => Self::Wasted,
            InsightId::Delivery => Self::Delivery,
            InsightId::FirstPass => Self::FirstPass,
            InsightId::MergeWait => Self::MergeWait,
            InsightId::ReviewRounds => Self::ReviewRounds,
        }
    }
}

impl From<InsightIdSerde> for InsightId {
    fn from(id: InsightIdSerde) -> Self {
        match id {
            InsightIdSerde::Completed => Self::Completed,
            InsightIdSerde::Spent => Self::Spent,
            InsightIdSerde::Tokens => Self::Tokens,
            InsightIdSerde::Wasted => Self::Wasted,
            InsightIdSerde::Delivery => Self::Delivery,
            InsightIdSerde::FirstPass => Self::FirstPass,
            InsightIdSerde::MergeWait => Self::MergeWait,
            InsightIdSerde::ReviewRounds => Self::ReviewRounds,
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        PathBuf::from(home).join("Library/Application Support/conn-gpui/tasks-board-settings.json"),
    )
}

fn load_board_settings() -> TasksBoardSettings {
    settings_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<PersistedBoardSettings>(&json).ok())
        .map(|raw| TasksBoardSettings {
            hidden_lanes: raw.hidden_lanes,
            hidden_insights: raw.hidden_insights.into_iter().map(Into::into).collect(),
            insight_period: raw.insight_period,
        })
        .unwrap_or_default()
}

fn save_board_settings(settings: &TasksBoardSettings) {
    let Some(path) = settings_path() else {
        return;
    };
    let payload = PersistedBoardSettings {
        hidden_lanes: settings.hidden_lanes.clone(),
        hidden_insights: settings
            .hidden_insights
            .iter()
            .copied()
            .map(Into::into)
            .collect(),
        insight_period: settings.insight_period,
    };
    let Ok(json) = serde_json::to_string_pretty(&payload) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(error) = std::fs::write(&path, json) {
        eprintln!("tasks panel: could not save board settings: {error}");
    }
}

/// Builds the live client, or a `FixtureTransport` client when `CONN_GPUI_TASKS_FIXTURE` names a
/// scenario (`default`, `empty`, `not-a-node`, `access-required`, `extension-disabled`, `unreachable`).
fn build_client() -> Result<OrbitTasksClient, String> {
    if let Ok(name) = std::env::var("CONN_GPUI_TASKS_FIXTURE")
        && let Some(scenario) = FixtureScenario::from_name(name.trim())
    {
        return Ok(OrbitTasksClient::new(Arc::new(FixtureTransport::new(
            scenario,
        ))));
    }
    if cfg!(test) {
        return Err("Orbit Tasks live client disabled in tests".to_owned());
    }
    OrbitTasksClient::live().map_err(|err| err.to_string())
}

/// The Tasks panel entity.
pub(crate) struct TasksPanel {
    tokens: Tokens,
    project_key: Option<String>,
    workspace_root: Option<String>,
    client: Option<OrbitTasksClient>,
    unavailable_reason: Option<String>,
    _follower: Option<TasksFollower>,
    live_status: TasksLiveStatus,
    list_state: ListLoadState,
    list_request: u64,
    insights: Option<TaskInsights>,
    insights_request: u64,
    detail_state: DetailLoadState,
    detail_observer: Option<TaskObserver>,
    detail_notice: Option<String>,
    panel_state: TasksPanelState,
    board_settings: TasksBoardSettings,
    query: String,
    search_input: Entity<InputState>,
    settings_open: bool,
    expanded_insight: Option<InsightId>,
    chart_hover: Option<usize>,
    chart_bounds: Rc<Cell<Bounds<Pixels>>>,
    insights_scroll: ScrollHandle,
    lanes_scroll: ScrollHandle,
    detail_scroll: ScrollHandle,
    now_ms: i64,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for TasksPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TasksPanel")
            .field("project_key", &self.project_key)
            .field("workspace_root", &self.workspace_root)
            .field("live_status", &self.live_status)
            .field("settings_open", &self.settings_open)
            .field("expanded_insight", &self.expanded_insight)
            .finish_non_exhaustive()
    }
}

impl TasksPanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search tasks"));
        let search_sub = cx.subscribe(&search_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let next = input.read(cx).value().to_string();
                if this.query != next {
                    this.query = next;
                    cx.notify();
                }
            }
        });

        let (client, unavailable_reason) = match build_client() {
            Ok(client) => (Some(client), None),
            Err(reason) => (None, Some(reason)),
        };

        let follower = client
            .as_ref()
            .map(|c| follow_orbit_tasks(crate::live::RT.handle(), c.clone()));

        let mut panel = Self {
            tokens,
            project_key: None,
            workspace_root: None,
            client,
            unavailable_reason,
            _follower: follower,
            live_status: TasksLiveStatus::Connecting,
            list_state: ListLoadState::Loading,
            list_request: 0,
            insights: None,
            insights_request: 0,
            detail_state: DetailLoadState::Loading,
            detail_observer: None,
            detail_notice: None,
            panel_state: TasksPanelState::default(),
            board_settings: load_board_settings(),
            query: String::new(),
            search_input,
            settings_open: false,
            expanded_insight: None,
            chart_hover: None,
            chart_bounds: Rc::new(Cell::new(Bounds::default())),
            insights_scroll: ScrollHandle::new(),
            lanes_scroll: ScrollHandle::new(),
            detail_scroll: ScrollHandle::new(),
            now_ms: now_epoch_ms(),
            _subscriptions: vec![search_sub],
        };

        panel.start_background_loops(cx);
        panel.reload_tasks(false, cx);
        panel.reload_insights(cx);
        panel
    }

    /// Subscribes to app-wide Orbit Gateway Reverb events (`FleetChanged`, `ProfileChanged`)
    /// from this panel's shared `private-orbit` WebSocket follower.
    pub(crate) fn subscribe_orbit_events(
        &self,
    ) -> Option<tokio::sync::broadcast::Receiver<conn_desktop::orbit::OrbitRealtimeEvent>> {
        self._follower.as_ref().map(|f| f.subscribe_events())
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread's project (Conn keys panel state by project) and its folder.
    pub(crate) fn set_project(
        &mut self,
        project_key: Option<String>,
        workspace_root: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.project_key == project_key && self.workspace_root == workspace_root {
            return;
        }
        self.project_key = project_key;
        self.workspace_root = workspace_root;
        self.settings_open = false;
        self.detail_notice = None;
        let nav = self.navigation();
        if nav.view == TasksView::Task
            && let Some(task_id) = nav.task_id
        {
            self.load_task_detail(task_id, false, cx);
        }
        cx.notify();
    }

    fn nav_key(&self) -> &str {
        self.project_key.as_deref().unwrap_or("default")
    }

    fn navigation(&self) -> TasksNavigation {
        self.panel_state.navigation(self.nav_key())
    }

    fn start_background_loops(&self, cx: &mut Context<'_, Self>) {
        if let Some(follower) = &self._follower {
            let mut status_rx = follower.status();
            cx.spawn(async move |this, cx| {
                loop {
                    let next = crate::live::RT
                        .spawn(async move {
                            let ok = status_rx.changed().await.is_ok();
                            let value = *status_rx.borrow();
                            (ok, value, status_rx)
                        })
                        .await;
                    let Ok((true, value, rx)) = next else {
                        break;
                    };
                    status_rx = rx;
                    if this
                        .update(cx, |panel, cx| {
                            if panel.live_status != value {
                                panel.live_status = value;
                                cx.notify();
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }

        if let Some(client) = &self.client {
            let mut invalidations = client.subscribe();
            cx.spawn(async move |this, cx| {
                loop {
                    let received = crate::live::RT
                        .spawn(async move {
                            let item = invalidations.recv().await;
                            (item, invalidations)
                        })
                        .await;
                    let Ok((item, rx)) = received else {
                        break;
                    };
                    invalidations = rx;
                    let target = match item {
                        Ok(target) => target,
                        Err(RecvError::Lagged(_)) => TasksInvalidation::List,
                        Err(RecvError::Closed) => break,
                    };
                    if this
                        .update(cx, |panel, cx| panel.handle_invalidation(target, cx))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();

            // Slow 5-minute poll for insights (`TasksInsights.tsx`: `INSIGHTS_POLL_MS`).
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(INSIGHTS_POLL_INTERVAL).await;
                    if this
                        .update(cx, |panel, cx| panel.reload_insights(cx))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }

        // Minute clock tick so card ages and working durations stay current (`useNowMinute`).
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(CLOCK_TICK_INTERVAL).await;
                if this
                    .update(cx, |panel, cx| {
                        panel.now_ms = now_epoch_ms();
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn handle_invalidation(&mut self, target: TasksInvalidation, cx: &mut Context<'_, Self>) {
        self.reload_tasks(true, cx);
        let nav = self.navigation();
        if nav.view == TasksView::Task
            && let Some(task_id) = nav.task_id
            && self
                .detail_observer
                .as_ref()
                .is_none_or(|obs| obs.wants(target))
        {
            self.load_task_detail(task_id, true, cx);
        }
    }

    fn reload_tasks(&mut self, quiet: bool, cx: &mut Context<'_, Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.list_request += 1;
        let request_id = self.list_request;
        if !quiet {
            self.list_state = ListLoadState::Loading;
            cx.notify();
        }
        let task = crate::live::RT.spawn(async move {
            client
                .list_tasks(&TasksListQuery {
                    limit: Some(100),
                    ..TasksListQuery::default()
                })
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = match task.await {
                Ok(res) => res,
                Err(err) => Err(TasksError {
                    reason: conn_desktop::orbit::TasksErrorReason::Unreachable,
                    message: format!("The Orbit Gateway task failed: {err}"),
                }),
            };
            let _ = this.update(cx, |panel, cx| {
                if panel.list_request != request_id {
                    return;
                }
                panel.now_ms = now_epoch_ms();
                panel.list_state = match result {
                    Ok(page) => ListLoadState::Ready(page),
                    Err(error) => ListLoadState::Error(error),
                };
                cx.notify();
            });
        })
        .detach();
    }

    fn reload_insights(&mut self, cx: &mut Context<'_, Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        self.insights_request += 1;
        let request_id = self.insights_request;
        let period = self.board_settings.insight_period;
        let task = crate::live::RT.spawn(async move {
            client
                .get_task_insights(TaskInsightsQuery {
                    period,
                    project: None,
                })
                .await
        });
        cx.spawn(async move |this, cx| {
            let result = task.await.ok().and_then(Result::ok);
            let _ = this.update(cx, |panel, cx| {
                if panel.insights_request != request_id {
                    return;
                }
                panel.insights = result;
                cx.notify();
            });
        })
        .detach();
    }

    fn load_task_detail(&mut self, task_id: i64, quiet: bool, cx: &mut Context<'_, Self>) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let observer = match &mut self.detail_observer {
            Some(obs) if obs.task_id() == task_id => obs,
            slot => {
                *slot = Some(TaskObserver::new(task_id));
                slot.as_mut()
                    .unwrap_or_else(|| unreachable!("just populated detail_observer"))
            }
        };
        let ticket = observer.begin_read();
        if !quiet {
            self.detail_state = DetailLoadState::Loading;
            cx.notify();
        }
        let task = crate::live::RT.spawn(async move { client.get_task(task_id).await });
        cx.spawn(async move |this, cx| {
            let result = match task.await {
                Ok(res) => res,
                Err(err) => Err(TasksError {
                    reason: conn_desktop::orbit::TasksErrorReason::Unreachable,
                    message: format!("The Orbit Gateway task failed: {err}"),
                }),
            };
            let _ = this.update(cx, |panel, cx| {
                let Some(obs) = &mut panel.detail_observer else {
                    return;
                };
                if obs.task_id() != task_id {
                    return;
                }
                if let Some(settled) = obs.finish_read(ticket, result) {
                    panel.detail_state = match settled {
                        Ok(detail) => DetailLoadState::Ready(Box::new(detail)),
                        Err(error) => DetailLoadState::Error(error),
                    };
                    cx.notify();
                }
            });
        })
        .detach();
    }

    fn open_task(&mut self, task_id: i64, cx: &mut Context<'_, Self>) {
        let key = self.nav_key().to_owned();
        let now = now_epoch_ms().max(0) as u64;
        self.panel_state.open_task(&key, task_id, now);
        self.settings_open = false;
        self.detail_notice = None;
        let needs_load = !matches!(
            &self.detail_state,
            DetailLoadState::Ready(t) if t.summary.id == task_id
        );
        self.load_task_detail(task_id, !needs_load, cx);
        cx.notify();
    }

    fn show_board(&mut self, cx: &mut Context<'_, Self>) {
        let key = self.nav_key().to_owned();
        let now = now_epoch_ms().max(0) as u64;
        self.panel_state.show_board(&key, now);
        self.detail_notice = None;
        cx.notify();
    }

    fn open_subtask(
        &mut self,
        subtask_id: Option<i64>,
        tab: Option<TasksDetailTab>,
        cx: &mut Context<'_, Self>,
    ) {
        let key = self.nav_key().to_owned();
        let now = now_epoch_ms().max(0) as u64;
        if self.panel_state.open_subtask(&key, subtask_id, tab, now) {
            self.detail_notice = None;
            cx.notify();
        }
    }

    fn set_detail_tab(&mut self, tab: TasksDetailTab, cx: &mut Context<'_, Self>) {
        let key = self.nav_key().to_owned();
        let now = now_epoch_ms().max(0) as u64;
        if self.panel_state.set_tab(&key, tab, now) {
            cx.notify();
        }
    }

    fn open_pull_request(&mut self, task_id: i64, url: String, cx: &mut Context<'_, Self>) {
        // Conn opens the PR inline when the host PR panel is mounted; until the native PR panel
        // is wired into RightPanel, open the task and open the PR URL externally on macOS.
        self.open_task(task_id, cx);
        if let Err(err) = std::process::Command::new("open").arg(&url).spawn() {
            self.detail_notice = Some(format!("Could not open pull request {url}: {err}"));
            cx.notify();
        }
    }

    fn open_agent_conversation(
        &mut self,
        environment_id: String,
        thread_id: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.detail_notice = Some(format!(
            "Agent conversation ({thread_id} on {environment_id}) requires cross-environment thread navigation, not yet wired in RightPanel."
        ));
        cx.notify();
    }

    fn toggle_lane(&mut self, lane: TaskLane, cx: &mut Context<'_, Self>) {
        let shown = !self.board_settings.hidden_lanes.contains(&lane);
        if shown && self.board_settings.hidden_lanes.len() >= TaskLane::ALL.len() - 1 {
            return;
        }
        self.board_settings.toggle_lane(lane);
        save_board_settings(&self.board_settings);
        cx.notify();
    }

    fn toggle_insight(&mut self, id: InsightId, cx: &mut Context<'_, Self>) {
        self.board_settings.toggle_insight(id);
        if self.expanded_insight == Some(id) && self.board_settings.hidden_insights.contains(&id) {
            self.expanded_insight = None;
            self.chart_hover = None;
        }
        save_board_settings(&self.board_settings);
        cx.notify();
    }

    fn set_insight_period(&mut self, period: InsightsPeriod, cx: &mut Context<'_, Self>) {
        if self.board_settings.insight_period == period {
            return;
        }
        self.board_settings.insight_period = period;
        self.chart_hover = None;
        save_board_settings(&self.board_settings);
        self.reload_insights(cx);
        cx.notify();
    }

    fn list_title_for(&self, task_id: i64) -> Option<&str> {
        let ListLoadState::Ready(page) = &self.list_state else {
            return None;
        };
        page.tasks
            .iter()
            .find(|t| t.id == task_id)
            .map(|t| t.title.as_str())
    }
}

impl Render for TasksPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let entity = cx.entity();

        let body = if let Some(reason) = &self.unavailable_reason {
            render_notice(
                &self.tokens,
                "superhero/unplug.svg",
                "Tasks are unavailable",
                reason.clone(),
                None,
            )
        } else {
            let nav = self.navigation();
            if nav.view == TasksView::Task
                && let Some(task_id) = nav.task_id
            {
                let callbacks = DetailCallbacks {
                    on_show_board: {
                        let entity = entity.clone();
                        Rc::new(move |_, cx| entity.update(cx, |p, cx| p.show_board(cx)))
                    },
                    on_open_subtask: {
                        let entity = entity.clone();
                        Rc::new(move |sub_id, tab, _, cx| {
                            entity.update(cx, |p, cx| p.open_subtask(sub_id, tab, cx));
                        })
                    },
                    on_set_tab: {
                        let entity = entity.clone();
                        Rc::new(move |tab, _, cx| {
                            entity.update(cx, |p, cx| p.set_detail_tab(tab, cx));
                        })
                    },
                    on_retry: {
                        let entity = entity.clone();
                        Rc::new(move |_, cx| {
                            entity.update(cx, |p, cx| p.load_task_detail(task_id, false, cx));
                        })
                    },
                    on_open_pr: {
                        let entity = entity.clone();
                        Rc::new(move |id, url, _, cx| {
                            entity.update(cx, |p, cx| p.open_pull_request(id, url, cx));
                        })
                    },
                    on_open_agent: Rc::new(move |env_id, thread_id, _, cx| {
                        entity.update(cx, |p, cx| {
                            p.open_agent_conversation(env_id, thread_id, cx);
                        });
                    }),
                };
                render_task_detail(
                    &self.tokens,
                    &nav,
                    self.live_status,
                    &self.detail_state,
                    self.list_title_for(task_id),
                    self.detail_notice.as_deref(),
                    &self.detail_scroll,
                    callbacks,
                )
            } else {
                match &self.list_state {
                    ListLoadState::Loading => div()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(superhero_icon(
                            "superhero/spinner.svg",
                            18.0,
                            to_hsla(self.tokens.muted_foreground),
                        ))
                        .into_any_element(),
                    ListLoadState::Error(error) => {
                        let notice = tasks_error_notice(error.reason);
                        let icon = match notice.kind {
                            ErrorNoticeKind::Access => "superhero/lock.svg",
                            ErrorNoticeKind::Unavailable => "superhero/unplug.svg",
                        };
                        render_notice(
                            &self.tokens,
                            icon,
                            notice.title,
                            error.message.clone(),
                            Some(Rc::new(move |_, cx| {
                                entity.update(cx, |p, cx| p.reload_tasks(false, cx));
                            })),
                        )
                    }
                    ListLoadState::Ready(page) if page.tasks.is_empty() => render_notice(
                        &self.tokens,
                        "superhero/checklist.svg",
                        "No tasks",
                        "Tasks Orbit runs for this project show here.",
                        None,
                    ),
                    ListLoadState::Ready(page) => {
                        let callbacks = BoardCallbacks {
                            on_clear_query: {
                                let entity = entity.clone();
                                Rc::new(move |window, cx| {
                                    entity.update(cx, |p, cx| {
                                        p.query.clear();
                                        p.search_input.update(cx, |s, cx| {
                                            s.set_value(String::new(), window, cx)
                                        });
                                        cx.notify();
                                    });
                                })
                            },
                            on_toggle_settings: {
                                let entity = entity.clone();
                                Rc::new(move |_, cx| {
                                    entity.update(cx, |p, cx| {
                                        p.settings_open = !p.settings_open;
                                        cx.notify();
                                    });
                                })
                            },
                            on_toggle_lane: {
                                let entity = entity.clone();
                                Rc::new(move |lane, _, cx| {
                                    entity.update(cx, |p, cx| p.toggle_lane(lane, cx));
                                })
                            },
                            on_toggle_insight: {
                                let entity = entity.clone();
                                Rc::new(move |id, _, cx| {
                                    entity.update(cx, |p, cx| p.toggle_insight(id, cx));
                                })
                            },
                            on_set_period: {
                                let entity = entity.clone();
                                Rc::new(move |period, _, cx| {
                                    entity.update(cx, |p, cx| p.set_insight_period(period, cx));
                                })
                            },
                            on_expand_insight: {
                                let entity = entity.clone();
                                Rc::new(move |id, _, cx| {
                                    entity.update(cx, |p, cx| {
                                        p.expanded_insight = id;
                                        p.chart_hover = None;
                                        cx.notify();
                                    });
                                })
                            },
                            on_hover_chart: {
                                let entity = entity.clone();
                                Rc::new(move |idx, _, cx| {
                                    entity.update(cx, |p, cx| {
                                        if p.chart_hover != idx {
                                            p.chart_hover = idx;
                                            cx.notify();
                                        }
                                    });
                                })
                            },
                            on_open_task: {
                                let entity = entity.clone();
                                Rc::new(move |task_id, _, cx| {
                                    entity.update(cx, |p, cx| p.open_task(task_id, cx));
                                })
                            },
                            on_open_pr: Rc::new(move |task_id, url, _, cx| {
                                entity.update(cx, |p, cx| {
                                    p.open_pull_request(task_id, url, cx);
                                });
                            }),
                        };

                        render_board(
                            &self.tokens,
                            &page.tasks,
                            self.insights.as_ref(),
                            &self.query,
                            &self.search_input,
                            &self.board_settings,
                            self.settings_open,
                            self.expanded_insight,
                            self.chart_hover,
                            Rc::clone(&self.chart_bounds),
                            &self.insights_scroll,
                            &self.lanes_scroll,
                            self.now_ms,
                            callbacks,
                        )
                    }
                }
            }
        };

        v_flex()
            .id("tasks-panel")
            .size_full()
            .min_h_0()
            .overflow_hidden()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|panel, _, _, cx| {
                    if panel.settings_open {
                        panel.settings_open = false;
                        cx.notify();
                    }
                }),
            )
            .on_key_down(cx.listener(|panel, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    if panel.settings_open {
                        panel.settings_open = false;
                        cx.notify();
                        cx.stop_propagation();
                    } else if panel.expanded_insight.take().is_some() {
                        panel.chart_hover = None;
                        cx.notify();
                        cx.stop_propagation();
                    }
                }
            }))
            .child(body)
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::AssetSource as _;

    use super::*;

    #[test]
    fn persisted_board_settings_round_trip() {
        let raw = PersistedBoardSettings {
            hidden_lanes: vec![TaskLane::Backlog],
            hidden_insights: vec![InsightIdSerde::Spent, InsightIdSerde::MergeWait],
            insight_period: InsightsPeriod::Week,
        };
        let Ok(json) = serde_json::to_string(&raw) else {
            panic!("board settings must serialize");
        };
        let Ok(decoded) = serde_json::from_str::<PersistedBoardSettings>(&json) else {
            panic!("board settings must deserialize");
        };
        assert_eq!(decoded.hidden_lanes, vec![TaskLane::Backlog], "lanes kept");
        assert_eq!(
            decoded
                .hidden_insights
                .into_iter()
                .map(InsightId::from)
                .collect::<Vec<_>>(),
            vec![InsightId::Spent, InsightId::MergeWait],
            "insights kept"
        );
        assert_eq!(decoded.insight_period, InsightsPeriod::Week, "period kept");
    }

    #[test]
    fn tasks_panel_superhero_icons_exist_in_embedded_assets() {
        let assets = crate::superhero::AppAssets;
        for path in [
            "superhero/search.svg",
            "superhero/adjust.svg",
            "superhero/trend-up.svg",
            "superhero/trend-down.svg",
            "superhero/close.svg",
            "superhero/checklist.svg",
            "superhero/lock.svg",
            "superhero/unplug.svg",
            "superhero/chevron-left.svg",
            "superhero/check.svg",
            "superhero/circle.svg",
            "superhero/circle-dashed.svg",
            "superhero/error-circle.svg",
            "superhero/agent.svg",
            "superhero/server.svg",
            "superhero/branch.svg",
            "superhero/usage.svg",
            "superhero/file-diff.svg",
            "superhero/question.svg",
            "superhero/pull-request.svg",
            "superhero/merge.svg",
            "superhero/pull-request-closed.svg",
            "superhero/spinner.svg",
        ] {
            let Ok(loaded) = assets.load(path) else {
                panic!("asset load failed for {path}");
            };
            assert!(
                loaded.is_some(),
                "tasks panel icon `{path}` must exist in embedded assets"
            );
        }
    }
}
