//! Where each thread's Tasks tab is, and the board settings.
//!
//! Port of the reducers in `apps/web/src/orbit/tasks/tasksPanelStore.ts`, without zustand: a
//! plain state the app owns and persists (serde, the same shape as Conn's `conn:tasks-panel:v1`).
//! Time comes in as `now_ms` so the reducers stay pure.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::insights::InsightId;
use super::tasks::{InsightsPeriod, TaskLane};

/// `Subtasks` exists on the task only; a subtask shows Brief and Agents.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TasksDetailTab {
    #[default]
    Brief,
    Subtasks,
    Agents,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TasksView {
    #[default]
    Board,
    Task,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct BoardScroll {
    pub top: f64,
    pub left: f64,
}

/// Where Conn reads a task's pull request: the project that hosts its repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksPullRequest {
    pub environment_id: String,
    pub project_id: String,
    pub repository: String,
    pub number: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub url: String,
    /// The pull request panel's tab, as Conn names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksNavigation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_thread_key: Option<String>,
    pub view: TasksView,
    /// Kept while the board shows, so reopening the same task restores its place.
    pub task_id: Option<i64>,
    /// `None` shows the task's own brief.
    pub subtask_id: Option<i64>,
    pub tab: TasksDetailTab,
    /// Inside a subtask: the tab the task itself had open, restored when the path leads back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_tab: Option<TasksDetailTab>,
    pub board_scroll: BoardScroll,
    pub detail_scroll_top: f64,
    /// The task's pull request, open one level below the task.
    #[serde(default)]
    pub pull_request: Option<TasksPullRequest>,
    /// When this thread's Tasks navigation last changed, for the cap.
    #[serde(default)]
    pub updated_at: u64,
}

impl Default for TasksNavigation {
    fn default() -> Self {
        Self {
            origin_thread_key: None,
            view: TasksView::Board,
            task_id: None,
            subtask_id: None,
            tab: TasksDetailTab::Brief,
            task_tab: None,
            board_scroll: BoardScroll::default(),
            detail_scroll_top: 0.0,
            pull_request: None,
            updated_at: 0,
        }
    }
}

/// Only the threads changed most recently keep their place, so storage stays bounded.
pub const TASKS_NAVIGATION_THREAD_LIMIT: usize = 50;

/// The same task comes back where it was; another one opens at its brief, from the top.
fn opened_task(current: &TasksNavigation, task_id: i64) -> TasksNavigation {
    if current.task_id == Some(task_id) {
        TasksNavigation {
            view: TasksView::Task,
            pull_request: None,
            ..current.clone()
        }
    } else {
        TasksNavigation {
            view: TasksView::Task,
            task_id: Some(task_id),
            subtask_id: None,
            tab: TasksDetailTab::Brief,
            task_tab: None,
            detail_scroll_top: 0.0,
            pull_request: None,
            ..current.clone()
        }
    }
}

/// Every thread's Tasks navigation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksPanelState {
    pub by_thread_key: HashMap<String, TasksNavigation>,
}

impl TasksPanelState {
    /// The thread's navigation, or the default (the board).
    pub fn navigation(&self, thread_key: &str) -> TasksNavigation {
        self.by_thread_key
            .get(thread_key)
            .cloned()
            .unwrap_or_default()
    }

    /// Restores persisted state the way Conn's migration does: every entry counts as oldest.
    pub fn restored(mut self) -> Self {
        for entry in self.by_thread_key.values_mut() {
            entry.updated_at = 0;
        }
        self.cap();
        self
    }

    fn cap(&mut self) {
        if self.by_thread_key.len() <= TASKS_NAVIGATION_THREAD_LIMIT {
            return;
        }
        let mut entries: Vec<(String, TasksNavigation)> = self.by_thread_key.drain().collect();
        // Stable on ties, newest first.
        entries.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.updated_at));
        entries.truncate(TASKS_NAVIGATION_THREAD_LIMIT);
        self.by_thread_key = entries.into_iter().collect();
    }

    /// Applies a change; returns whether anything changed.
    fn update(
        &mut self,
        thread_key: &str,
        now_ms: u64,
        change: impl FnOnce(&TasksNavigation) -> Option<TasksNavigation>,
    ) -> bool {
        let current = self.navigation(thread_key);
        let Some(next) = change(&current) else {
            return false;
        };
        self.by_thread_key.insert(
            thread_key.to_owned(),
            TasksNavigation {
                updated_at: now_ms,
                ..next
            },
        );
        self.cap();
        true
    }

    /// Carries the source thread's Tasks place to the target thread.
    pub fn handoff(&mut self, source_key: &str, target_key: &str, now_ms: u64) -> bool {
        let Some(source) = self.by_thread_key.get(source_key).cloned() else {
            return false;
        };
        if source_key == target_key || source.origin_thread_key.as_deref() == Some(target_key) {
            return false;
        }
        let origin = source
            .origin_thread_key
            .clone()
            .unwrap_or_else(|| source_key.to_owned());
        self.by_thread_key.insert(
            target_key.to_owned(),
            TasksNavigation {
                origin_thread_key: Some(origin),
                updated_at: now_ms,
                ..source
            },
        );
        self.cap();
        true
    }

    /// A card opens the task itself.
    pub fn open_task(&mut self, thread_key: &str, task_id: i64, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            Some(opened_task(current, task_id))
        })
    }

    /// Opens the task's pull request below the task, from its row or a board card's badge.
    pub fn open_pull_request(
        &mut self,
        thread_key: &str,
        task_id: i64,
        pull_request: TasksPullRequest,
        now_ms: u64,
    ) -> bool {
        self.update(thread_key, now_ms, |current| {
            let task = opened_task(current, task_id);
            // The PR sits below the task itself, so a subtask the task had open closes; the task
            // comes back on its own tab.
            Some(if task.subtask_id.is_none() {
                TasksNavigation {
                    pull_request: Some(pull_request),
                    ..task
                }
            } else {
                TasksNavigation {
                    subtask_id: None,
                    tab: task.task_tab.unwrap_or(TasksDetailTab::Brief),
                    task_tab: None,
                    detail_scroll_top: 0.0,
                    pull_request: Some(pull_request),
                    ..task
                }
            })
        })
    }

    /// Back up from the pull request to the task, on the tab the task had open.
    pub fn close_pull_request(&mut self, thread_key: &str, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            current.pull_request.is_some().then(|| TasksNavigation {
                pull_request: None,
                ..current.clone()
            })
        })
    }

    pub fn set_pull_request_tab(&mut self, thread_key: &str, tab: &str, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            let pull_request = current.pull_request.as_ref()?;
            (pull_request.tab.as_deref() != Some(tab)).then(|| TasksNavigation {
                pull_request: Some(TasksPullRequest {
                    tab: Some(tab.to_owned()),
                    ..pull_request.clone()
                }),
                ..current.clone()
            })
        })
    }

    /// `tab` switches the content tab too; without it the current tab stays.
    pub fn open_subtask(
        &mut self,
        thread_key: &str,
        subtask_id: Option<i64>,
        tab: Option<TasksDetailTab>,
        now_ms: u64,
    ) -> bool {
        self.update(thread_key, now_ms, |current| {
            if current.subtask_id == subtask_id && tab.is_none_or(|t| t == current.tab) {
                return None;
            }
            // The task's own tab is remembered while inside its subtasks; a subtask's tab never
            // carries back to the task.
            let task_tab = if current.subtask_id.is_none() {
                Some(current.tab)
            } else {
                current.task_tab
            };
            Some(match subtask_id {
                None => TasksNavigation {
                    subtask_id,
                    tab: tab.or(task_tab).unwrap_or(current.tab),
                    task_tab: None,
                    detail_scroll_top: 0.0,
                    ..current.clone()
                },
                Some(_) => TasksNavigation {
                    subtask_id,
                    tab: tab.unwrap_or(if current.tab == TasksDetailTab::Subtasks {
                        TasksDetailTab::Brief
                    } else {
                        current.tab
                    }),
                    task_tab,
                    detail_scroll_top: 0.0,
                    ..current.clone()
                },
            })
        })
    }

    pub fn set_tab(&mut self, thread_key: &str, tab: TasksDetailTab, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            (current.tab != tab).then(|| TasksNavigation {
                tab,
                detail_scroll_top: 0.0,
                ..current.clone()
            })
        })
    }

    pub fn show_board(&mut self, thread_key: &str, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            (current.view != TasksView::Board).then(|| TasksNavigation {
                view: TasksView::Board,
                ..current.clone()
            })
        })
    }

    pub fn save_board_scroll(
        &mut self,
        thread_key: &str,
        top: f64,
        left: f64,
        now_ms: u64,
    ) -> bool {
        self.update(thread_key, now_ms, |current| {
            (current.board_scroll.top != top || current.board_scroll.left != left).then(|| {
                TasksNavigation {
                    board_scroll: BoardScroll { top, left },
                    ..current.clone()
                }
            })
        })
    }

    pub fn save_detail_scroll(&mut self, thread_key: &str, top: f64, now_ms: u64) -> bool {
        self.update(thread_key, now_ms, |current| {
            (current.detail_scroll_top != top).then(|| TasksNavigation {
                detail_scroll_top: top,
                ..current.clone()
            })
        })
    }
}

/// Board settings: lanes and insights the user turned off, and the insights period. One setting
/// for every thread and window. Turned-off lists, so a lane or insight added later shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TasksBoardSettings {
    pub hidden_lanes: Vec<TaskLane>,
    pub hidden_insights: Vec<InsightId>,
    pub insight_period: InsightsPeriod,
}

impl Default for TasksBoardSettings {
    fn default() -> Self {
        Self {
            hidden_lanes: Vec::new(),
            hidden_insights: Vec::new(),
            insight_period: InsightsPeriod::Month,
        }
    }
}

fn toggled<T: PartialEq + Copy>(list: &mut Vec<T>, entry: T) {
    if let Some(index) = list.iter().position(|item| *item == entry) {
        list.remove(index);
    } else {
        list.push(entry);
    }
}

impl TasksBoardSettings {
    pub fn toggle_lane(&mut self, lane: TaskLane) {
        toggled(&mut self.hidden_lanes, lane);
    }

    pub fn toggle_insight(&mut self, insight: InsightId) {
        toggled(&mut self.hidden_insights, insight);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Store {
        state: TasksPanelState,
        now: u64,
    }

    impl Store {
        fn new() -> Self {
            Self {
                state: TasksPanelState::default(),
                now: 1_000,
            }
        }
        fn tick(&mut self) -> u64 {
            self.now += 1;
            self.now
        }
        fn at(&self, key: &str) -> TasksNavigation {
            self.state.navigation(key)
        }
    }

    fn pr() -> TasksPullRequest {
        TasksPullRequest {
            environment_id: "env".to_owned(),
            project_id: "project".to_owned(),
            repository: "nckrtl/conn".to_owned(),
            number: 1931,
            host: None,
            url: "https://github.com/nckrtl/conn/pull/1931".to_owned(),
            tab: None,
        }
    }

    #[test]
    fn restores_the_task_subtask_tab_and_scroll_after_the_board_per_thread() {
        let mut s = Store::new();
        let t = s.tick();
        s.state.save_board_scroll("env:a", 120.0, 40.0, t);
        s.state.open_task("env:a", 482, t);
        s.state
            .open_subtask("env:a", Some(484), Some(TasksDetailTab::Agents), t);
        s.state.save_detail_scroll("env:a", 300.0, t);
        s.state.open_task("env:b", 431, t);
        s.state.show_board("env:a", t);
        let a = s.at("env:a");
        assert_eq!(
            (a.view, a.board_scroll),
            (
                TasksView::Board,
                BoardScroll {
                    top: 120.0,
                    left: 40.0
                }
            )
        );
        s.state.open_task("env:a", 482, t);
        let a = s.at("env:a");
        assert_eq!(
            (a.view, a.task_id, a.subtask_id, a.tab, a.detail_scroll_top),
            (
                TasksView::Task,
                Some(482),
                Some(484),
                TasksDetailTab::Agents,
                300.0
            )
        );
        let b = s.at("env:b");
        assert_eq!(
            (b.task_id, b.subtask_id, b.tab),
            (Some(431), None, TasksDetailTab::Brief)
        );
    }

    #[test]
    fn returns_from_a_subtask_to_the_tasks_own_tab() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:tabs";
        s.state.open_task(k, 482, t);
        s.state.open_subtask(k, Some(484), None, t);
        s.state.set_tab(k, TasksDetailTab::Agents, t);
        s.state.open_subtask(k, None, None, t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (None, TasksDetailTab::Brief)
        );
        s.state.set_tab(k, TasksDetailTab::Agents, t);
        s.state.open_subtask(k, Some(484), None, t);
        s.state.set_tab(k, TasksDetailTab::Brief, t);
        s.state
            .open_subtask(k, Some(485), Some(TasksDetailTab::Agents), t);
        s.state.open_subtask(k, None, None, t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (None, TasksDetailTab::Agents)
        );
    }

    #[test]
    fn opens_a_tasks_pr_below_the_task_and_goes_back_up() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:pr";
        s.state.open_task(k, 482, t);
        s.state.set_tab(k, TasksDetailTab::Agents, t);
        s.state.open_pull_request(k, 482, pr(), t);
        s.state.set_pull_request_tab(k, "timeline", t);
        let at = s.at(k);
        assert_eq!((at.task_id, at.tab), (Some(482), TasksDetailTab::Agents));
        assert_eq!(
            at.pull_request
                .as_ref()
                .map(|p| (p.number, p.tab.as_deref())),
            Some((1931, Some("timeline")))
        );
        s.state.close_pull_request(k, t);
        assert_eq!(
            (s.at(k).tab, s.at(k).pull_request),
            (TasksDetailTab::Agents, None)
        );
        s.state.show_board(k, t);
        s.state.open_pull_request(k, 470, pr(), t);
        assert_eq!(
            (s.at(k).view, s.at(k).task_id, s.at(k).tab),
            (TasksView::Task, Some(470), TasksDetailTab::Brief)
        );
        s.state.show_board(k, t);
        s.state.open_task(k, 470, t);
        assert_eq!((s.at(k).task_id, s.at(k).pull_request), (Some(470), None));
    }

    #[test]
    fn opens_the_pr_from_a_badge_even_when_that_task_had_a_subtask_open() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:pr-sub";
        s.state.open_task(k, 482, t);
        s.state.set_tab(k, TasksDetailTab::Subtasks, t);
        s.state
            .open_subtask(k, Some(484), Some(TasksDetailTab::Agents), t);
        s.state.show_board(k, t);
        s.state.open_pull_request(k, 482, pr(), t);
        let at = s.at(k);
        assert_eq!(
            (at.task_id, at.subtask_id, at.tab),
            (Some(482), None, TasksDetailTab::Subtasks)
        );
        assert_eq!(at.pull_request.map(|p| p.number), Some(1931));
        s.state.close_pull_request(k, t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (None, TasksDetailTab::Subtasks)
        );
    }

    #[test]
    fn opens_a_subtask_from_the_subtasks_tab_on_its_brief_and_comes_back() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:subtasks";
        s.state.open_task(k, 482, t);
        s.state.set_tab(k, TasksDetailTab::Subtasks, t);
        s.state.open_subtask(k, Some(484), None, t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (Some(484), TasksDetailTab::Brief)
        );
        s.state.open_subtask(k, None, None, t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (None, TasksDetailTab::Subtasks)
        );
        s.state
            .open_subtask(k, Some(485), Some(TasksDetailTab::Agents), t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (Some(485), TasksDetailTab::Agents)
        );
    }

    #[test]
    fn opens_a_different_task_at_its_brief_from_the_top() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:c";
        s.state.open_task(k, 482, t);
        s.state
            .open_subtask(k, Some(483), Some(TasksDetailTab::Agents), t);
        s.state.save_detail_scroll(k, 200.0, t);
        s.state.open_task(k, 470, t);
        let at = s.at(k);
        assert_eq!(
            (at.task_id, at.subtask_id, at.tab, at.detail_scroll_top),
            (Some(470), None, TasksDetailTab::Brief, 0.0)
        );
    }

    #[test]
    fn keeps_the_content_tab_between_subtasks_unless_one_is_asked_for() {
        let mut s = Store::new();
        let t = s.tick();
        let k = "env:d";
        s.state.open_task(k, 482, t);
        s.state.set_tab(k, TasksDetailTab::Agents, t);
        s.state.save_detail_scroll(k, 80.0, t);
        s.state.open_subtask(k, Some(483), None, t);
        let at = s.at(k);
        assert_eq!(
            (at.subtask_id, at.tab, at.detail_scroll_top),
            (Some(483), TasksDetailTab::Agents, 0.0)
        );
        s.state
            .open_subtask(k, None, Some(TasksDetailTab::Brief), t);
        assert_eq!(
            (s.at(k).subtask_id, s.at(k).tab),
            (None, TasksDetailTab::Brief)
        );
        let before = s.state.clone();
        assert!(!s.state.open_subtask(k, None, None, t + 1));
        assert!(!s.state.save_detail_scroll(k, 0.0, t + 1));
        assert_eq!(s.state, before);
    }

    #[test]
    fn keeps_only_the_threads_changed_most_recently() {
        let mut s = Store::new();
        for index in 0..TASKS_NAVIGATION_THREAD_LIMIT {
            let t = s.tick();
            s.state
                .open_task(&format!("env:cap-{index}"), index as i64, t);
        }
        let t = s.tick();
        s.state.save_detail_scroll("env:cap-0", 40.0, t);
        let t = s.tick();
        s.state.open_task("env:cap-new", 999, t);
        assert_eq!(s.state.by_thread_key.len(), TASKS_NAVIGATION_THREAD_LIMIT);
        assert!(s.state.by_thread_key.contains_key("env:cap-0"));
        assert!(s.state.by_thread_key.contains_key("env:cap-new"));
        assert!(!s.state.by_thread_key.contains_key("env:cap-1"));
    }

    #[test]
    fn caps_old_persisted_navigation_when_it_is_restored() {
        let entries = (0..70)
            .map(|index| {
                (
                    format!("old:{index}"),
                    TasksNavigation {
                        task_id: Some(index),
                        updated_at: 500,
                        ..TasksNavigation::default()
                    },
                )
            })
            .collect();
        let restored = TasksPanelState {
            by_thread_key: entries,
        }
        .restored();
        assert_eq!(restored.by_thread_key.len(), TASKS_NAVIGATION_THREAD_LIMIT);
        assert!(
            restored
                .by_thread_key
                .values()
                .all(|entry| entry.updated_at == 0)
        );
    }

    #[test]
    fn hands_the_place_over_once() {
        let mut s = Store::new();
        let t = s.tick();
        s.state.open_task("origin", 482, t);
        assert!(s.state.handoff("origin", "target", t));
        assert_eq!(s.at("target").origin_thread_key.as_deref(), Some("origin"));
        assert_eq!(s.at("target").task_id, Some(482));
        assert!(!s.state.handoff("target", "origin", t));
        assert!(!s.state.handoff("missing", "x", t));
    }

    #[test]
    fn toggles_board_settings_and_round_trips_navigation_json() {
        let mut settings = TasksBoardSettings::default();
        settings.toggle_lane(TaskLane::Backlog);
        settings.toggle_insight(InsightId::Spent);
        settings.toggle_lane(TaskLane::Backlog);
        assert!(settings.hidden_lanes.is_empty());
        assert_eq!(settings.hidden_insights, vec![InsightId::Spent]);
        assert_eq!(settings.insight_period, InsightsPeriod::Month);
        let json = serde_json::to_value(TasksNavigation::default()).unwrap_or_default();
        assert_eq!(json["view"], "board");
        assert_eq!(json["detailScrollTop"], 0.0);
    }
}
