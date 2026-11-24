//! The Orbit tool of the bar (`apps/web/src/laravelToolbar/ui/orbit.tsx`, `dependencies.tsx`,
//! `useOrbit.ts`): the Instance behind the page, seen through the Orbit Gateway. The calls and
//! their rules (allowlist, own-Instance write guard) live in `conn_desktop::laravel_toolbar::orbit`.
//!
//! The application log is a tail read every few seconds: Orbit's log stream is a Pusher channel
//! the Gateway leases per call, and `conn-orbit`'s realtime follower covers the Tasks channel
//! only, so the live stream is not ported.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use conn_desktop::laravel_toolbar::layout::{SortValue, next_table_sort, sort_table_rows};
use conn_desktop::laravel_toolbar::model::format_bytes;
use conn_desktop::laravel_toolbar::orbit::{
    LogLine, OrbitDependencies, OrbitPage, OrbitProcess, OrbitToolClient, ProcessAction,
    ProcessStatus, has_process_warning, parse_log_lines, split_log_levels,
};
use conn_theme::Tokens;
use gpui_kit::TestSupportExt as _;
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, ClickEvent, ClipboardItem, Context, FontWeight, IntoElement, ScrollHandle,
    SharedString, Window, div, px,
};

use super::parts::{
    self, Align, MONO, SMALL_PX, TEXT_PX, Tone, Value as Cell, Width, body_row, cell, empty_row,
    head_row, key_value_rows, sort_header, stat, stat_strip, underline_tabs,
};
use super::{LaravelToolbar, PanelId};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome;
use crate::panels::color::to_hsla;
use crate::theme::hsla_alpha;

const LOG_LINES: u32 = 200;
const PROCESS_REFRESH: Duration = Duration::from_secs(5);
const LOG_REFRESH: Duration = Duration::from_secs(3);

/// The Orbit panel's tabs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OrbitTab {
    Instance,
    Processes,
    Logs,
    Composer,
    Javascript,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OrbitState {
    /// The page's domain is being resolved.
    Loading,
    /// Not an Orbit page, or Orbit is not reachable from this Mac: the tool stays hidden.
    None,
    Ready {
        page: OrbitPage,
        processes: Vec<OrbitProcess>,
        error: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Deps {
    Loading,
    Ready(OrbitDependencies),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq)]
enum ProcessLog {
    Reading,
    Ready(String),
    Failed(String),
}

/// The application log of the Instance.
#[derive(Clone, Debug, PartialEq)]
struct AppLog {
    text: String,
    refreshing: bool,
    error: Option<String>,
}

/// What the bar knows about the page's Orbit Instance.
pub(crate) struct OrbitTool {
    client: Option<OrbitToolClient>,
    domain: Option<String>,
    pub(crate) state: OrbitState,
    /// The Instance the thread's own server runs in: the only one the tool may change.
    own_instance: Option<i64>,
    environment: Option<String>,
    deps: Deps,
    pub(crate) tab: OrbitTab,
    selected: Option<i64>,
    follow_process: bool,
    follow_app: bool,
    busy: HashSet<i64>,
    process_log: (Option<i64>, ProcessLog),
    app_log: AppLog,
    process_scroll: ScrollHandle,
    app_scroll: ScrollHandle,
    last_processes: Option<Instant>,
    last_process_log: Option<Instant>,
    last_app_log: Option<Instant>,
    reading_process_log: bool,
    reading_app_log: bool,
    polling: bool,
    pub(crate) deps_sort: Option<conn_desktop::laravel_toolbar::layout::TableSort>,
}

impl OrbitTool {
    pub(super) fn new(_cx: &mut Context<'_, LaravelToolbar>) -> Self {
        Self {
            client: OrbitToolClient::new().ok(),
            domain: None,
            state: OrbitState::None,
            own_instance: None,
            environment: None,
            deps: Deps::Loading,
            tab: OrbitTab::Instance,
            selected: None,
            follow_process: true,
            follow_app: true,
            busy: HashSet::new(),
            process_log: (None, ProcessLog::Reading),
            app_log: AppLog {
                text: String::new(),
                refreshing: false,
                error: None,
            },
            process_scroll: ScrollHandle::new(),
            app_scroll: ScrollHandle::new(),
            last_processes: None,
            last_process_log: None,
            last_app_log: None,
            reading_process_log: false,
            reading_app_log: false,
            polling: false,
            deps_sort: None,
        }
    }

    /// Tests never reach the Gateway: the scheduler of a test cannot wait on Tokio.
    #[cfg(test)]
    pub(super) fn offline_for_test(&mut self) {
        self.client = None;
    }

    #[cfg(test)]
    pub(super) fn set_dependencies_for_test(&mut self, data: OrbitDependencies) {
        self.deps = Deps::Ready(data);
    }

    /// The bar shows the Orbit item once the page's Instance is known.
    pub(super) fn is_ready(&self) -> bool {
        matches!(self.state, OrbitState::Ready { .. })
    }

    pub(super) fn has_warnings(&self) -> bool {
        matches!(&self.state, OrbitState::Ready { processes, .. } if has_process_warning(processes))
    }

    fn processes(&self) -> &[OrbitProcess] {
        match &self.state {
            OrbitState::Ready { processes, .. } => processes,
            _ => &[],
        }
    }

    fn selected_process(&self) -> Option<&OrbitProcess> {
        let processes = self.processes();
        processes
            .iter()
            .find(|p| Some(p.id) == self.selected)
            .or_else(|| processes.first())
    }
}

pub(super) fn orbit_icon(tokens: &Tokens) -> AnyElement {
    gpui_kit::svg()
        .path("brand/orbit.svg")
        .size(px(14.0))
        .flex_none()
        .text_color(to_hsla(tokens.muted_foreground))
        .into_any_element()
}

/// The host of a page URL, when it is a name Orbit could serve.
fn page_domain(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_owned();
    // Orbit serves dotted names; an address or `localhost` is never an Instance's domain.
    (host.contains('.') && host.parse::<std::net::IpAddr>().is_err()).then_some(host)
}

impl LaravelToolbar {
    /// The Conn server this thread runs on: the Instance behind its Orbit environment is the only
    /// one the tool may change. A self-registered server has none, so it changes nothing.
    pub(crate) fn set_environment(&mut self, environment_id: String, cx: &mut Context<'_, Self>) {
        if self.orbit.environment.as_deref() == Some(environment_id.as_str()) {
            return;
        }
        self.orbit.environment = Some(environment_id.clone());
        self.orbit.own_instance = None;
        if environment_id.is_empty() {
            return;
        }
        let task = crate::live::RT.spawn(async move {
            let client = conn_desktop::orbit::client::OrbitTasksClient::live().ok()?;
            let environments = client.environments().await.ok()?;
            environments
                .into_iter()
                .find(|environment| environment.environment_id == environment_id)
                .and_then(|environment| environment.instance_id)
        });
        cx.spawn(async move |this, cx| {
            let instance = task.await.ok().flatten();
            let _ = this.update(cx, |this, cx| {
                this.orbit.own_instance = instance;
                cx.notify();
            });
        })
        .detach();
    }

    /// The page moved to `url`: ask Orbit which Instance serves its domain, once per domain.
    pub(super) fn orbit_page_changed(&mut self, url: &str, cx: &mut Context<'_, Self>) {
        let domain = page_domain(url);
        if self.orbit.domain == domain {
            return;
        }
        self.orbit.domain.clone_from(&domain);
        self.orbit.state = OrbitState::None;
        self.orbit.deps = Deps::Loading;
        self.orbit.selected = None;
        self.orbit.process_log = (None, ProcessLog::Reading);
        self.orbit.app_log = AppLog {
            text: String::new(),
            refreshing: false,
            error: None,
        };
        cx.notify();
        let (Some(domain), Some(client)) = (domain, self.orbit.client.clone()) else {
            return;
        };
        self.orbit.state = OrbitState::Loading;
        let lookup = domain.clone();
        let task = crate::live::RT.spawn({
            async move {
                let page = client.resolve_page(&lookup).await?;
                match page {
                    Some(page) => {
                        let processes = client.processes(page.instance_id).await?;
                        Ok::<_, conn_desktop::laravel_toolbar::orbit::OrbitToolError>(Some((
                            page, processes,
                        )))
                    }
                    None => Ok(None),
                }
            }
        });
        cx.spawn(async move |this, cx| {
            let result: Option<(OrbitPage, Vec<OrbitProcess>)> = match task.await {
                Ok(Ok(found)) => found,
                // Orbit is not reachable from this machine; the tool stays hidden.
                _ => None,
            };
            let _ = this.update(cx, |this, cx| {
                if this.orbit.domain.as_deref() != Some(domain.as_str()) {
                    return;
                }
                this.orbit.state = match result {
                    Some((page, processes)) => OrbitState::Ready {
                        page,
                        processes,
                        error: None,
                    },
                    None => OrbitState::None,
                };
                if this.orbit.is_ready() {
                    this.load_dependencies(cx);
                    this.start_orbit_polling(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn load_dependencies(&mut self, cx: &mut Context<'_, Self>) {
        let (OrbitState::Ready { page, .. }, Some(client)) =
            (&self.orbit.state, self.orbit.client.clone())
        else {
            return;
        };
        let instance_id = page.instance_id;
        let task = crate::live::RT.spawn(async move { client.dependencies(instance_id).await });
        cx.spawn(async move |this, cx| {
            let deps = match task.await {
                Ok(Ok(data)) => Deps::Ready(data),
                Ok(Err(error)) => Deps::Failed(error.to_string()),
                Err(error) => Deps::Failed(error.to_string()),
            };
            let _ = this.update(cx, |this, cx| {
                this.orbit.deps = deps;
                cx.notify();
            });
        })
        .detach();
    }

    /// Process states change behind our back (crashes, other clients): while the panel is open the
    /// list, the selected process's log and the application log are read again on a timer.
    fn start_orbit_polling(&mut self, cx: &mut Context<'_, Self>) {
        if self.orbit.polling {
            return;
        }
        self.orbit.polling = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let alive = this.update(cx, |this, cx| this.orbit_tick(cx));
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn orbit_tick(&mut self, cx: &mut Context<'_, Self>) {
        if self.active() != Some(PanelId::Orbit) || !self.orbit.is_ready() {
            return;
        }
        let due =
            |last: Option<Instant>, every: Duration| last.is_none_or(|at| at.elapsed() >= every);
        if due(self.orbit.last_processes, PROCESS_REFRESH) {
            self.refresh_processes(cx);
        }
        match self.orbit.tab {
            OrbitTab::Processes => {
                let selected_up = self
                    .orbit
                    .selected_process()
                    .is_some_and(|p| p.status.may_be_up());
                let following = self.orbit.follow_process && selected_up;
                let every = if following {
                    LOG_REFRESH
                } else {
                    Duration::from_secs(3600)
                };
                let wrong_process =
                    self.orbit.selected_process().map(|p| p.id) != self.orbit.process_log.0;
                if wrong_process || (following && due(self.orbit.last_process_log, every)) {
                    self.read_process_log(cx);
                }
            }
            OrbitTab::Logs
                if self.orbit.follow_app && due(self.orbit.last_app_log, LOG_REFRESH) =>
            {
                self.read_app_log(cx);
            }
            _ => {}
        }
    }

    pub(crate) fn refresh_processes(&mut self, cx: &mut Context<'_, Self>) {
        let (OrbitState::Ready { page, .. }, Some(client)) =
            (&self.orbit.state, self.orbit.client.clone())
        else {
            return;
        };
        let instance_id = page.instance_id;
        self.orbit.last_processes = Some(Instant::now());
        let task = crate::live::RT.spawn(async move { client.processes(instance_id).await });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(list)) = task.await {
                let _ = this.update(cx, |this, cx| {
                    if let OrbitState::Ready {
                        page, processes, ..
                    } = &mut this.orbit.state
                        && page.instance_id == instance_id
                    {
                        *processes = list;
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    /// The selected process's log: read again every few seconds while following, and on retry.
    /// A read that fails keeps the last tail while following, and ends in an error with Retry
    /// otherwise.
    pub(crate) fn read_process_log(&mut self, cx: &mut Context<'_, Self>) {
        let (Some(process), Some(client)) = (
            self.orbit.selected_process().cloned(),
            self.orbit.client.clone(),
        ) else {
            return;
        };
        if self.orbit.reading_process_log {
            return;
        }
        self.orbit.reading_process_log = true;
        self.orbit.last_process_log = Some(Instant::now());
        if self.orbit.process_log.0 != Some(process.id) {
            self.orbit.process_log = (Some(process.id), ProcessLog::Reading);
            cx.notify();
        }
        let id = process.id;
        let task = crate::live::RT.spawn(async move {
            tokio::time::timeout(Duration::from_secs(35), client.process_logs(id, LOG_LINES)).await
        });
        cx.spawn(async move |this, cx| {
            let result: Result<String, String> = match task.await {
                Ok(Ok(Ok(text))) => Ok(text),
                Ok(Ok(Err(error))) => Err(error.to_string()),
                Ok(Err(_)) => Err("Orbit did not return the log in time.".to_owned()),
                Err(error) => Err(error.to_string()),
            };
            let _ = this.update(cx, |this, cx| {
                this.orbit.reading_process_log = false;
                if this.orbit.selected_process().map(|p| p.id) != Some(id) {
                    return;
                }
                let keep_tail = this.orbit.follow_process
                    && matches!(&this.orbit.process_log, (Some(p), ProcessLog::Ready(_)) if *p == id);
                this.orbit.process_log = match result {
                    Ok(text) => (Some(id), ProcessLog::Ready(text)),
                    Err(_) if keep_tail => this.orbit.process_log.clone(),
                    Err(error) => (Some(id), ProcessLog::Failed(error)),
                };
                if this.orbit.follow_process {
                    this.orbit.process_scroll.scroll_to_bottom();
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn read_app_log(&mut self, cx: &mut Context<'_, Self>) {
        let (OrbitState::Ready { page, .. }, Some(client)) =
            (&self.orbit.state, self.orbit.client.clone())
        else {
            return;
        };
        if self.orbit.reading_app_log {
            return;
        }
        self.orbit.reading_app_log = true;
        self.orbit.last_app_log = Some(Instant::now());
        let instance_id = page.instance_id;
        let task = crate::live::RT
            .spawn(async move { client.instance_logs(instance_id, LOG_LINES).await });
        cx.spawn(async move |this, cx| {
            let result = match task.await {
                Ok(Ok(text)) => Ok(text),
                Ok(Err(error)) => Err(error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            let _ = this.update(cx, |this, cx| {
                this.orbit.reading_app_log = false;
                match result {
                    Ok(text) => {
                        this.orbit.app_log = AppLog {
                            text,
                            refreshing: true,
                            error: None,
                        };
                    }
                    Err(error) => {
                        this.orbit.app_log.refreshing = true;
                        this.orbit.app_log.error = Some(error);
                    }
                }
                if this.orbit.follow_app {
                    this.orbit.app_scroll.scroll_to_bottom();
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Starts, stops or restarts processes of the thread's own Instance.
    fn run_process_action(
        &mut self,
        targets: Vec<OrbitProcess>,
        action: ProcessAction,
        cx: &mut Context<'_, Self>,
    ) {
        let (OrbitState::Ready { page, .. }, Some(client)) =
            (&self.orbit.state, self.orbit.client.clone())
        else {
            return;
        };
        let page_instance = page.instance_id;
        let own = self.orbit.own_instance;
        if let OrbitState::Ready { error, .. } = &mut self.orbit.state {
            *error = None;
        }
        for process in targets {
            self.orbit.busy.insert(process.id);
            let client = client.clone();
            let id = process.id;
            let task = crate::live::RT
                .spawn(async move { client.act(page_instance, own, id, action).await });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.orbit.busy.remove(&process.id);
                    let failure = match result {
                        Ok(Ok(())) => None,
                        Ok(Err(error)) => Some(error.to_string()),
                        Err(error) => Some(error.to_string()),
                    };
                    if let (Some(message), OrbitState::Ready { error, .. }) =
                        (failure, &mut this.orbit.state)
                    {
                        *error = Some(format!(
                            "Could not {} {}: {message}",
                            action.word(),
                            process.name
                        ));
                    }
                    this.refresh_processes(cx);
                    cx.notify();
                });
            })
            .detach();
        }
        cx.notify();
    }

    // ─── Render ─────────────────────────────────────────────────────────────

    pub(super) fn render_orbit_panel(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let OrbitState::Ready { page, error, .. } = self.orbit.state.clone() else {
            let header = self.panel_header(
                "superhero/globe.svg",
                "Orbit".to_owned(),
                None,
                None,
                false,
                cx,
            );
            let body = empty_row(&tokens, "orbit-empty", "No Orbit Instance for this page");
            return self.panel_shell(PanelId::Orbit, header, false, body);
        };
        let processes = self.orbit.processes().to_vec();
        let tab = self.orbit.tab;
        let running = processes
            .iter()
            .filter(|p| p.status == ProcessStatus::Running)
            .count();
        let down: Vec<OrbitProcess> = processes
            .iter()
            .filter(|p| matches!(p.status, ProcessStatus::Stopped | ProcessStatus::Crashed))
            .cloned()
            .collect();
        let restartable: Vec<OrbitProcess> = processes
            .iter()
            .filter(|p| p.status.may_be_up())
            .cloned()
            .collect();

        let actions = (tab == OrbitTab::Processes && !processes.is_empty()).then(|| {
            let start_targets = down.clone();
            let restart_targets = restartable.clone();
            let start = chrome::text_button(
                "laravel-toolbar-start-all",
                Some("superhero/play.svg"),
                "Start all",
                &tokens,
                cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.run_process_action(start_targets.clone(), ProcessAction::Start, cx);
                }),
            )
            .test_support()
            .a11y_button("browser.laravel-toolbar.orbit.start-all", "Start all");
            let restart = chrome::text_button(
                "laravel-toolbar-restart-all",
                Some("superhero/retry.svg"),
                "Restart all",
                &tokens,
                cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.run_process_action(restart_targets.clone(), ProcessAction::Restart, cx);
                }),
            )
            .test_support()
            .a11y_button("browser.laravel-toolbar.orbit.restart-all", "Restart all");
            let mut group = chrome::toolbar_group(&tokens);
            group = if down.is_empty() {
                group.child(start.opacity(0.5))
            } else {
                group.child(start)
            };
            group = if restartable.is_empty() {
                group.child(restart.opacity(0.5))
            } else {
                group.child(restart)
            };
            group.into_any_element()
        });
        let header = self.panel_header_with_icon(
            orbit_icon(&tokens),
            "Orbit".to_owned(),
            None,
            actions,
            false,
            cx,
        );

        let package_manager = match &self.orbit.deps {
            Deps::Ready(data) => data.package_manager.clone(),
            _ => None,
        };
        let tabs = underline_tabs(
            &tokens,
            "orbit",
            tab,
            vec![
                (OrbitTab::Instance, "instance", "Instance".to_owned()),
                (OrbitTab::Processes, "processes", "Processes".to_owned()),
                (OrbitTab::Logs, "logs", "Logs".to_owned()),
                (OrbitTab::Composer, "composer", "Composer".to_owned()),
                (
                    OrbitTab::Javascript,
                    "javascript",
                    package_manager.unwrap_or_else(|| "JavaScript".to_owned()),
                ),
            ],
            |this, tab, cx| {
                this.orbit.tab = tab;
                this.orbit.last_process_log = None;
                this.orbit.last_app_log = None;
                if tab == OrbitTab::Processes {
                    this.read_process_log(cx);
                } else if tab == OrbitTab::Logs {
                    this.read_app_log(cx);
                }
            },
            cx,
        );

        let content = match tab {
            OrbitTab::Instance => {
                let count =
                    |status: ProcessStatus| processes.iter().filter(|p| p.status == status).count();
                let mut stats = vec![
                    stat(
                        &tokens,
                        "processes",
                        "Processes",
                        processes.len().to_string(),
                        None,
                        Tone::Default,
                    ),
                    stat(
                        &tokens,
                        "running",
                        "Running",
                        running.to_string(),
                        None,
                        Tone::Success,
                    ),
                    stat(
                        &tokens,
                        "stopped",
                        "Stopped",
                        count(ProcessStatus::Stopped).to_string(),
                        None,
                        Tone::Default,
                    ),
                    stat(
                        &tokens,
                        "crashed",
                        "Crashed",
                        count(ProcessStatus::Crashed).to_string(),
                        None,
                        if count(ProcessStatus::Crashed) > 0 {
                            Tone::Danger
                        } else {
                            Tone::Default
                        },
                    ),
                ];
                if count(ProcessStatus::Unknown) > 0 {
                    stats.push(stat(
                        &tokens,
                        "unknown",
                        "Unknown",
                        count(ProcessStatus::Unknown).to_string(),
                        None,
                        Tone::Default,
                    ));
                }
                let rows = vec![
                    (
                        "Instance ID".to_owned(),
                        Cell::Text(page.instance_id.to_string()),
                    ),
                    ("Domain".to_owned(), Cell::Mono(page.domain.clone())),
                    (
                        "Node".to_owned(),
                        Cell::Text(page.node_name.unwrap_or_else(|| "–".to_owned())),
                    ),
                ];
                div()
                    .id("laravel-toolbar-orbit-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(stat_strip(&tokens, stats))
                    .child(key_value_rows(&tokens, "orbit-instance", rows, false))
                    .into_any_element()
            }
            OrbitTab::Processes => self.render_orbit_processes(&processes, error, cx),
            OrbitTab::Logs => self.render_orbit_app_log(cx),
            OrbitTab::Composer | OrbitTab::Javascript => self.render_orbit_dependencies(tab, cx),
        };
        let flush = div()
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .child(tabs)
            .child(content)
            .into_any_element();
        self.panel_shell(PanelId::Orbit, header, true, flush)
    }

    fn render_orbit_processes(
        &mut self,
        processes: &[OrbitProcess],
        error: Option<String>,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let Some(selected) = self.orbit.selected_process().cloned() else {
            return empty_row(
                &tokens,
                "orbit-no-processes",
                "This Orbit Instance runs no processes",
            );
        };
        let muted = to_hsla(tokens.muted_foreground);
        let hover = hsla_alpha(tokens.foreground, 0.04);
        let mut list = div()
            .id("laravel-toolbar-orbit-process-list")
            .w(px(288.0))
            .flex_shrink_0()
            .h_full()
            .overflow_y_scroll()
            .border_r_1()
            .border_color(to_hsla(tokens.border));
        for process in processes {
            let up = process.status.may_be_up();
            let busy = self.orbit.busy.contains(&process.id);
            let marker = match process.status {
                ProcessStatus::Running => to_hsla(tokens.success),
                ProcessStatus::Starting => to_hsla(tokens.info),
                ProcessStatus::Crashed => to_hsla(tokens.destructive),
                ProcessStatus::Stopped => hsla_alpha(tokens.muted_foreground, 0.5),
                ProcessStatus::Unknown => muted,
            };
            let usage = [
                process.cpu.map(|cpu| format!("{cpu:.1}% CPU")),
                process.memory_bytes.map(|bytes| format_bytes(bytes as i64)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            let second = if process.status == ProcessStatus::Unknown {
                "status unknown".to_owned()
            } else if process.status == ProcessStatus::Running && !usage.is_empty() {
                usage.join(" · ")
            } else {
                process.status.label().to_owned()
            };
            let id = process.id;
            let name = process.name.clone();
            let stop_or_start = if up {
                let target = process.clone();
                chrome::icon_button(
                    SharedString::from(format!("orbit-stop-{id}")),
                    "superhero/stop.svg",
                    &tokens,
                    busy,
                    cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        cx.stop_propagation();
                        this.run_process_action(vec![target.clone()], ProcessAction::Stop, cx);
                    }),
                )
                .test_support()
                .a11y_button(
                    format!("browser.laravel-toolbar.orbit.process.{id}.stop"),
                    format!("Stop {name}"),
                )
            } else {
                let target = process.clone();
                chrome::icon_button(
                    SharedString::from(format!("orbit-start-{id}")),
                    "superhero/play.svg",
                    &tokens,
                    busy,
                    cx.listener(move |this, _: &ClickEvent, _window, cx| {
                        cx.stop_propagation();
                        this.run_process_action(vec![target.clone()], ProcessAction::Start, cx);
                    }),
                )
                .test_support()
                .a11y_button(
                    format!("browser.laravel-toolbar.orbit.process.{id}.start"),
                    format!("Start {name}"),
                )
            };
            let target = process.clone();
            let restart = chrome::icon_button(
                SharedString::from(format!("orbit-restart-{id}")),
                "superhero/retry.svg",
                &tokens,
                busy || !up,
                cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    cx.stop_propagation();
                    this.run_process_action(vec![target.clone()], ProcessAction::Restart, cx);
                }),
            )
            .test_support()
            .a11y_button(
                format!("browser.laravel-toolbar.orbit.process.{id}.restart"),
                format!("Restart {name}"),
            );
            let mut row = h_flex()
                .id(SharedString::from(format!("orbit-process-{id}")))
                .test_support()
                .a11y_button(
                    format!("browser.laravel-toolbar.orbit.process.{id}"),
                    process.name.clone(),
                )
                .w_full()
                .items_center()
                .gap(px(8.0))
                .py(px(10.0))
                .pr(px(6.0))
                .pl(px(12.0))
                .text_size(px(TEXT_PX))
                .border_b_1()
                .border_color(to_hsla(tokens.border))
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.orbit.selected = Some(id);
                    this.orbit.last_process_log = None;
                    this.read_process_log(cx);
                    cx.notify();
                }))
                .child(parts::row_marker(marker, 32.0))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .font_family(MONO)
                                .child(process.name.clone()),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(SMALL_PX))
                                .text_color(muted)
                                .child(second),
                        ),
                )
                .child(
                    h_flex()
                        .flex_shrink_0()
                        .items_center()
                        .child(stop_or_start)
                        .child(restart),
                );
            if process.id == selected.id {
                row = row.bg(to_hsla(tokens.accent));
            }
            list = list.child(row);
        }

        let can_follow = selected.status.may_be_up();
        let following = self.orbit.follow_process && can_follow;
        let log_state = if self.orbit.process_log.0 == Some(selected.id) {
            self.orbit.process_log.1.clone()
        } else {
            ProcessLog::Reading
        };
        let log_text = match &log_state {
            ProcessLog::Ready(text) => Some(text.clone()),
            _ => None,
        };
        let follow_button = h_flex()
            .id("laravel-toolbar-orbit-follow")
            .test_support()
            .a11y_button(
                "browser.laravel-toolbar.orbit.follow",
                if following { "Following" } else { "Follow" },
            )
            .h(px(24.0))
            .items_center()
            .gap(px(6.0))
            .px(px(8.0))
            .rounded(px(6.0))
            .text_size(px(TEXT_PX))
            .font_weight(FontWeight::MEDIUM)
            .when(can_follow, |el| el.cursor_pointer())
            .when(!can_follow, |el| el.opacity(0.5))
            .text_color(if following {
                to_hsla(tokens.success_foreground)
            } else {
                muted
            })
            .when(following, |el| el.bg(hsla_alpha(tokens.success, 0.15)))
            .when(following, |el| {
                el.child(
                    div()
                        .size(px(6.0))
                        .rounded_full()
                        .bg(to_hsla(tokens.success)),
                )
            })
            .child(if following { "Following" } else { "Follow" })
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                if can_follow {
                    this.orbit.follow_process = !this.orbit.follow_process;
                    cx.notify();
                }
            }));
        let retry = chrome::icon_button(
            "laravel-toolbar-orbit-retry",
            "superhero/retry.svg",
            &tokens,
            false,
            cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.orbit.last_process_log = None;
                this.orbit.process_log.1 = ProcessLog::Reading;
                this.read_process_log(cx);
                cx.notify();
            }),
        )
        .test_support()
        .a11y_button(
            "browser.laravel-toolbar.orbit.read-again",
            "Read the log again",
        );
        let copy_text = log_text.clone().unwrap_or_default();
        let copy = chrome::icon_button(
            "laravel-toolbar-orbit-copy-log",
            "superhero/copy.svg",
            &tokens,
            log_text.is_none(),
            move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy_text.clone())),
        )
        .test_support()
        .a11y_button("browser.laravel-toolbar.orbit.copy-log", "Copy log");
        let head = h_flex()
            .h(px(36.0))
            .flex_shrink_0()
            .items_center()
            .gap(px(8.0))
            .pl(px(12.0))
            .pr(px(6.0))
            .text_size(px(TEXT_PX))
            .border_b_1()
            .border_color(to_hsla(tokens.border))
            .child(div().font_family(MONO).child(selected.name.clone()))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(MONO)
                    .text_color(muted)
                    .child(selected.command.unwrap_or_default()),
            )
            .child(
                h_flex()
                    .ml_auto()
                    .flex_shrink_0()
                    .items_center()
                    .gap(px(2.0))
                    .child(follow_button)
                    .children(
                        (!following && matches!(log_state, ProcessLog::Ready(_))).then(|| {
                            h_flex()
                                .items_center()
                                .child(
                                    div()
                                        .px(px(4.0))
                                        .text_size(px(SMALL_PX))
                                        .text_color(muted)
                                        .child("One-time tail"),
                                )
                                .child(retry)
                        }),
                    )
                    .child(copy),
            );

        let lines_body = match &log_state {
            ProcessLog::Failed(message) => h_flex()
                .items_center()
                .gap(px(8.0))
                .px(px(12.0))
                .child(
                    div()
                        .text_color(to_hsla(tokens.destructive))
                        .child(message.clone()),
                )
                .child(
                    chrome::text_button(
                        "laravel-toolbar-orbit-log-retry",
                        Some("superhero/retry.svg"),
                        "Retry",
                        &tokens,
                        cx.listener(|this, _: &ClickEvent, _window, cx| {
                            this.orbit.process_log.1 = ProcessLog::Reading;
                            this.read_process_log(cx);
                            cx.notify();
                        }),
                    )
                    .test_support()
                    .a11y_button("browser.laravel-toolbar.orbit.log-retry", "Retry"),
                )
                .into_any_element(),
            ProcessLog::Reading => div()
                .px(px(12.0))
                .text_color(muted)
                .child("Reading the log… Orbit can take a few seconds.")
                .into_any_element(),
            ProcessLog::Ready(text) => self.log_lines(&parse_log_lines(text), "No log lines yet"),
        };
        let log_pane = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(head)
            .children(error.map(|message| {
                div()
                    .flex_shrink_0()
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_PX))
                    .text_color(to_hsla(tokens.destructive))
                    .border_b_1()
                    .border_color(to_hsla(tokens.border))
                    .child(message)
            }))
            .child(
                div()
                    .id("laravel-toolbar-orbit-process-log")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.orbit.process_scroll)
                    .py(px(8.0))
                    .child(lines_body),
            );
        h_flex()
            .flex_1()
            .min_h_0()
            .child(list)
            .child(log_pane)
            .into_any_element()
    }

    /// Log lines: a muted time, level words coloured, the rest as written.
    fn log_lines(&self, lines: &[LogLine], empty: &str) -> AnyElement {
        let tokens = &self.tokens;
        if lines.is_empty() {
            return div()
                .px(px(12.0))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(empty.to_owned())
                .into_any_element();
        }
        let hover = hsla_alpha(tokens.foreground, 0.04);
        let mut column = div()
            .flex()
            .flex_col()
            .font_family(MONO)
            .text_size(px(TEXT_PX))
            .line_height(px(20.0));
        for line in lines {
            let mut text = h_flex().flex_wrap().min_w_0();
            for (piece, level) in split_log_levels(&line.text) {
                let color = level.map(|level| match level {
                    "INFO" => to_hsla(tokens.info_foreground),
                    "WARN" | "WARNING" => to_hsla(tokens.warning_foreground),
                    "ERROR" | "FAIL" | "FAILED" => to_hsla(tokens.destructive),
                    "DONE" => to_hsla(tokens.success_foreground),
                    _ => to_hsla(tokens.muted_foreground),
                });
                text = text.child(match color {
                    Some(color) => div().text_color(color).child(piece),
                    None => div().child(piece),
                });
            }
            column = column.child(
                h_flex()
                    .id(SharedString::from(format!("log-line-{}", line.id)))
                    .items_start()
                    .gap(px(12.0))
                    .px(px(12.0))
                    .py(px(2.0))
                    .hover(move |s| s.bg(hover))
                    .children(line.time.clone().map(|time| {
                        div()
                            .flex_shrink_0()
                            .text_color(to_hsla(tokens.muted_foreground))
                            .child(time)
                    }))
                    .child(text),
            );
        }
        column.into_any_element()
    }

    fn render_orbit_app_log(&mut self, cx: &mut Context<'_, Self>) -> AnyElement {
        let tokens = self.tokens.clone();
        let muted = to_hsla(tokens.muted_foreground);
        let following = self.orbit.follow_app;
        let log = self.orbit.app_log.clone();
        let status = if !following {
            "Paused"
        } else if log.refreshing {
            "Refreshing"
        } else {
            "Connecting…"
        };
        let copy_text = log.text.clone();
        let toggle = chrome::text_button(
            "laravel-toolbar-orbit-app-follow",
            Some(if following {
                "superhero/stop.svg"
            } else {
                "superhero/play.svg"
            }),
            if following { "Pause" } else { "Follow" },
            &tokens,
            cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.orbit.follow_app = !this.orbit.follow_app;
                this.orbit.last_app_log = None;
                cx.notify();
            }),
        )
        .test_support()
        .a11y_button(
            "browser.laravel-toolbar.orbit.app-follow",
            if following { "Pause" } else { "Follow" },
        );
        let copy = chrome::icon_button(
            "laravel-toolbar-orbit-copy-app-log",
            "superhero/copy.svg",
            &tokens,
            log.text.is_empty(),
            move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy_text.clone())),
        )
        .test_support()
        .a11y_button(
            "browser.laravel-toolbar.orbit.copy-app-log",
            "Copy application log",
        );
        let head = h_flex()
            .h(px(36.0))
            .flex_shrink_0()
            .items_center()
            .gap(px(8.0))
            .px(px(12.0))
            .text_size(px(TEXT_PX))
            .border_b_1()
            .border_color(to_hsla(tokens.border))
            .child(
                div()
                    .font_family(MONO)
                    .text_color(muted)
                    .child("storage/logs/laravel.log"),
            )
            .child(
                h_flex()
                    .ml_auto()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(SMALL_PX))
                            .text_color(muted)
                            .child(status),
                    )
                    .child(toggle)
                    .child(copy),
            );
        let lines = parse_log_lines(&log.text);
        let empty = if log.refreshing {
            "No log lines yet"
        } else {
            "Reading the application log…"
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(head)
            .children(log.error.map(|message| {
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .text_size(px(TEXT_PX))
                    .text_color(to_hsla(tokens.destructive))
                    .border_b_1()
                    .border_color(to_hsla(tokens.border))
                    .child(message)
            }))
            .child(
                div()
                    .id("laravel-toolbar-orbit-app-log")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.orbit.app_scroll)
                    .py(px(8.0))
                    .child(self.log_lines(&lines, empty)),
            )
            .into_any_element()
    }

    fn render_orbit_dependencies(
        &mut self,
        tab: OrbitTab,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = self.tokens.clone();
        let (packages, note) = match &self.orbit.deps {
            Deps::Loading => (None, "Loading dependencies…".to_owned()),
            Deps::Failed(message) => (None, message.clone()),
            Deps::Ready(data) => {
                let (list, error) = if tab == OrbitTab::Composer {
                    (data.composer.clone(), data.composer_error.clone())
                } else {
                    (data.javascript.clone(), data.javascript_error.clone())
                };
                (
                    list,
                    error.unwrap_or_else(|| {
                        "No saved inventory. Run an Orbit dependency scan for this instance."
                            .to_owned()
                    }),
                )
            }
        };
        let Some(packages) = packages else {
            return empty_row(&tokens, "orbit-deps-empty", &note);
        };
        if packages.is_empty() {
            let name = if tab == OrbitTab::Composer {
                "Composer"
            } else {
                "JavaScript"
            };
            return empty_row(
                &tokens,
                "orbit-deps-none",
                &format!("No {name} dependencies"),
            );
        }
        let sorted = sort_table_rows(
            &packages,
            self.orbit.deps_sort.as_ref(),
            |dependency, column| {
                Some(SortValue::Text(match column {
                    "name" => dependency.name.clone(),
                    "version" => dependency.version.clone(),
                    "constraint" => return dependency.constraint.clone().map(SortValue::Text),
                    _ => if dependency.development {
                        "Dev"
                    } else {
                        "Production"
                    }
                    .to_owned(),
                }))
            },
        );
        let sort = self.orbit.deps_sort.clone();
        let sorter = |column: &'static str,
                      label: &'static str,
                      width: Width,
                      cx: &mut Context<'_, Self>| {
            sort_header(
                &tokens,
                "dependencies",
                column,
                label,
                sort.as_ref(),
                width,
                Align::Left,
                move |this, _cx| {
                    this.orbit.deps_sort = next_table_sort(this.orbit.deps_sort.as_ref(), column);
                },
                cx,
            )
        };
        let head = vec![
            sorter("name", "Package", Width::Flex, cx),
            sorter("version", "Version", Width::Fixed(112.0), cx),
            sorter("constraint", "Requirement", Width::Fixed(112.0), cx),
            sorter("type", "Type", Width::Fixed(96.0), cx),
        ];
        let muted = to_hsla(tokens.muted_foreground);
        let mut list = div()
            .flex()
            .flex_col()
            .w_full()
            .child(head_row(&tokens, head));
        for dependency in sorted {
            list = list.child(
                body_row(
                    &tokens,
                    vec![
                        cell(
                            Width::Flex,
                            Align::Left,
                            div()
                                .truncate()
                                .font_family(MONO)
                                .child(dependency.name.clone()),
                        ),
                        cell(
                            Width::Fixed(112.0),
                            Align::Left,
                            div().font_family(MONO).child(dependency.version.clone()),
                        ),
                        cell(
                            Width::Fixed(112.0),
                            Align::Left,
                            div().font_family(MONO).text_color(muted).child(
                                dependency
                                    .constraint
                                    .clone()
                                    .unwrap_or_else(|| "–".to_owned()),
                            ),
                        ),
                        cell(
                            Width::Fixed(96.0),
                            Align::Left,
                            div().text_color(muted).child(if dependency.development {
                                "Dev"
                            } else {
                                "Production"
                            }),
                        ),
                    ],
                )
                .id(SharedString::from(format!("dependency-{}", dependency.id)))
                .test_support()
                .a11y_group(
                    format!("browser.laravel-toolbar.dependency.{}", dependency.id),
                    dependency.name.clone(),
                ),
            );
        }
        div()
            .id("laravel-toolbar-orbit-deps-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(list)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::page_domain;

    #[test]
    fn only_dotted_names_can_be_orbit_domains() {
        assert_eq!(
            page_domain("https://dlf.test/posts?x=1").as_deref(),
            Some("dlf.test")
        );
        assert_eq!(page_domain("http://localhost:8000/"), None);
        assert_eq!(page_domain("http://127.0.0.1/"), None);
        assert_eq!(page_domain("about:blank"), None);
        assert_eq!(page_domain("file:///tmp/x.html"), None);
    }
}
