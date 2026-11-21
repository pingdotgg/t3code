//! The Linked items surface (Conn's `pull-requests` surface kind / `ThreadPullRequestsPanel.tsx`):
//! lists the active thread's linked pull requests (stacked by native or derived chains, with state,
//! conflict, watch, checks, review, diff stats, author, repo/branches, hover actions, and link
//! dialog) and linked issues (enriched via `issues.detail` when the server supports it), staying
//! live-refreshed via `pullRequests.subscribeLinkedThreadRefreshes` and `orchestration.subscribeShell`.

mod logic;
mod render;

use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::time::Duration;

use conn_client::{Connection, StreamId};
use conn_contract::{
    OrchestrationProjectShell, OrchestrationV2Command, OrchestrationV2CommandThreadPullRequestLink,
    OrchestrationV2CommandThreadPullRequestUnlink, OrchestrationV2CommandThreadPullRequestWatch,
    ThreadPullRequestLink, ThreadPullRequestLinkSource, lit,
};
use conn_theme::Tokens;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::v_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    ClipboardItem, Context, Entity, EventEmitter, IntoElement, KeyDownEvent, Render, Subscription,
    Window,
};
use serde_json::{Value, json};

use self::logic::{
    IssueDetailSummary, LinkInputResolution, ProjectRepoInfo, ServerCapabilities, ThreadIssueLink,
    ThreadLinkedData, find_project_for_link, now_epoch_ms, parse_project_repo_info,
    parse_server_capabilities, parse_thread_linked_data, pull_request_list_lines,
    resolve_link_pull_request_input, resolve_thread_pull_request_chains, thread_issue_key,
    visible_thread_pull_requests,
};
use self::render::{
    ListCallbacks, render_empty_state, render_link_dialog, render_linked_list,
    render_loading_state, render_unavailable_state,
};
use super::chrome;

/// Relative timestamps tick once a minute (`RelativeTime` / `useNowMinute`).
const CLOCK_TICK_INTERVAL: Duration = Duration::from_secs(60);

/// Events emitted by [`LinkedItemsPanel`] when the user opens a linked pull request or issue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LinkedItemsEvent {
    /// Open the pull request in the Pull request right-panel surface.
    OpenPullRequest {
        project_id: Option<String>,
        host: String,
        repository: String,
        number: i64,
        url: String,
    },
    /// Open the linked issue in an Issue surface (or externally when unsupported).
    OpenIssue {
        project_id: String,
        tracker: String,
        host: String,
        scope: String,
        key: String,
        display_key: String,
        url: String,
    },
}

impl EventEmitter<LinkedItemsEvent> for LinkedItemsPanel {}

#[derive(Clone, Debug)]
enum LoadState {
    Idle,
    Loading,
    Ready(ThreadLinkedData),
    Error(String),
}

/// The Linked items panel entity.
pub(crate) struct LinkedItemsPanel {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_id: Option<String>,
    server_available: bool,
    capabilities: ServerCapabilities,
    projects: HashMap<String, ProjectRepoInfo>,
    load_state: LoadState,
    load_generation: u64,
    issue_details: HashMap<String, IssueDetailSummary>,
    open_menu_key: Option<String>,
    action_notice: Option<String>,
    link_dialog_open: bool,
    link_input: Entity<InputState>,
    link_reference: String,
    link_dirty: bool,
    link_pending: bool,
    link_error: Option<String>,
    command_seq: u64,
    now_ms: i64,
    active_streams: Vec<StreamId>,
    _subscriptions: Vec<Subscription>,
}

impl fmt::Debug for LinkedItemsPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinkedItemsPanel")
            .field("workspace_root", &self.workspace_root)
            .field("thread_id", &self.thread_id)
            .field("server_available", &self.server_available)
            .field("capabilities", &self.capabilities)
            .field("link_dialog_open", &self.link_dialog_open)
            .finish_non_exhaustive()
    }
}

impl Drop for LinkedItemsPanel {
    fn drop(&mut self) {
        if let Some(conn) = &self.connection {
            for stream_id in self.active_streams.drain(..) {
                conn.cancel_stream(stream_id);
            }
        }
    }
}

impl LinkedItemsPanel {
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let link_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Pull request URL or #42"));
        let link_sub = cx.subscribe(&link_input, |this, input, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                let next = input.read(cx).value().to_string();
                if this.link_reference != next {
                    this.link_reference = next;
                    this.link_dirty = true;
                    this.link_error = None;
                    cx.notify();
                }
            }
        });

        let server_available = connection.is_some();
        let mut panel = Self {
            tokens,
            connection,
            workspace_root: None,
            thread_id: None,
            server_available,
            capabilities: ServerCapabilities::default(),
            projects: HashMap::new(),
            load_state: LoadState::Idle,
            load_generation: 0,
            issue_details: HashMap::new(),
            open_menu_key: None,
            action_notice: None,
            link_dialog_open: false,
            link_input,
            link_reference: String::new(),
            link_dirty: false,
            link_pending: false,
            link_error: None,
            command_seq: 0,
            now_ms: now_epoch_ms(),
            active_streams: Vec::new(),
            _subscriptions: vec![link_sub],
        };

        panel.start_background_loops(cx);
        panel
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    /// The selected thread and its project folder.
    pub(crate) fn set_thread(
        &mut self,
        workspace_root: Option<String>,
        thread_id: Option<String>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.workspace_root == workspace_root && self.thread_id == thread_id {
            return;
        }
        self.workspace_root = workspace_root;
        self.thread_id = thread_id;
        self.open_menu_key = None;
        self.action_notice = None;
        self.issue_details.clear();
        self.reload(false, cx);
    }

    fn start_background_loops(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(conn) = self.connection.clone() {
            // 1. Read server capabilities (`server.getConfig`).
            let config_conn = conn.clone();
            cx.spawn(async move |this, cx| {
                let res = config_conn.call_json("server.getConfig", json!({})).await;
                let _ = this.update(cx, |panel, cx| {
                    match res {
                        Ok(json) => {
                            panel.server_available = true;
                            panel.capabilities = parse_server_capabilities(&json);
                            panel.fetch_missing_issue_details(cx);
                        }
                        Err(_) => {
                            // Keep `server_available` true unless thread loading also fails;
                            // some dev servers may still serve orchestration even if config lags.
                        }
                    }
                    cx.notify();
                });
            })
            .detach();

            // 2. Live refresh stream: `pullRequests.subscribeLinkedThreadRefreshes`.
            let (refresh_stream_id, mut refresh_rx) =
                conn.stream_json("pullRequests.subscribeLinkedThreadRefreshes", json!({}));
            self.active_streams.push(refresh_stream_id);
            cx.spawn(async move |this, cx| {
                while refresh_rx.recv().await.is_some() {
                    if this
                        .update(cx, |panel, cx| {
                            if panel.thread_id.is_some() {
                                panel.reload(true, cx);
                            }
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();

            // 3. Shell stream: keeps project repository identities and the active thread's
            // linked pull requests / issues live as the agent or another client edits them.
            let (shell_stream_id, mut shell_rx) =
                conn.stream_json("orchestration.subscribeShell", json!({}));
            self.active_streams.push(shell_stream_id);
            cx.spawn(async move |this, cx| {
                while let Some(item) = shell_rx.recv().await {
                    if this
                        .update(cx, |panel, cx| panel.handle_shell_stream_item(&item, cx))
                        .is_err()
                    {
                        break;
                    }
                }
            })
            .detach();
        }

        // Minute clock tick so relative timestamps stay current without continuous repaints.
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

    fn handle_shell_stream_item(&mut self, item: &Value, cx: &mut Context<'_, Self>) {
        let Some(kind) = item.get("kind").and_then(Value::as_str) else {
            return;
        };
        let mut changed = false;
        match kind {
            "snapshot" => {
                if let Some(snapshot) = item.get("snapshot") {
                    if let Some(raw_projects) = snapshot.get("projects").and_then(Value::as_array) {
                        self.projects.clear();
                        for raw in raw_projects {
                            if let Ok(project) =
                                serde_json::from_value::<OrchestrationProjectShell>(raw.clone())
                            {
                                let info = parse_project_repo_info(&project);
                                self.projects.insert(info.id.clone(), info);
                            }
                        }
                        changed = true;
                    }
                    if let Some(active_id) = self.thread_id.as_deref()
                        && let Some(raw_threads) = snapshot.get("threads").and_then(Value::as_array)
                        && let Some(thread) = raw_threads
                            .iter()
                            .find(|t| t.get("id").and_then(Value::as_str) == Some(active_id))
                    {
                        let data = parse_thread_linked_data(thread);
                        self.apply_loaded_data(data, cx);
                        changed = true;
                    }
                }
            }
            "project.updated" => {
                if let Some(raw) = item.get("project")
                    && let Ok(project) =
                        serde_json::from_value::<OrchestrationProjectShell>(raw.clone())
                {
                    let info = parse_project_repo_info(&project);
                    self.projects.insert(info.id.clone(), info);
                    changed = true;
                }
            }
            "project.removed" => {
                if let Some(id) = item.get("projectId").and_then(Value::as_str)
                    && self.projects.remove(id).is_some()
                {
                    changed = true;
                }
            }
            "thread.updated" => {
                if let Some(thread) = item.get("thread")
                    && thread.get("id").and_then(Value::as_str) == self.thread_id.as_deref()
                {
                    let data = parse_thread_linked_data(thread);
                    self.apply_loaded_data(data, cx);
                    changed = true;
                }
            }
            _ => {}
        }
        if changed {
            cx.notify();
        }
    }

    fn reload(&mut self, quiet: bool, cx: &mut Context<'_, Self>) {
        self.load_generation = self.load_generation.wrapping_add(1);
        let generation = self.load_generation;

        let Some(thread_id) = self.thread_id.clone() else {
            self.load_state = LoadState::Idle;
            cx.notify();
            return;
        };
        let Some(conn) = self.connection.clone() else {
            self.server_available = false;
            self.load_state = LoadState::Idle;
            cx.notify();
            return;
        };

        if !quiet {
            self.load_state = LoadState::Loading;
            cx.notify();
        }

        cx.spawn(async move |this, cx| {
            let res = conn
                .call_json(
                    "orchestration.getThreadProjection",
                    json!({ "threadId": thread_id }),
                )
                .await;
            let _ = this.update(cx, |panel, cx| {
                if panel.load_generation != generation {
                    return;
                }
                panel.now_ms = now_epoch_ms();
                match res {
                    Ok(projection) => {
                        let thread_json = projection.get("thread").unwrap_or(&projection);
                        let data = parse_thread_linked_data(thread_json);
                        panel.server_available = true;
                        panel.apply_loaded_data(data, cx);
                    }
                    Err(err) => {
                        if !quiet || !matches!(panel.load_state, LoadState::Ready(_)) {
                            panel.load_state = LoadState::Error(err.to_string());
                        }
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn apply_loaded_data(&mut self, data: ThreadLinkedData, cx: &mut Context<'_, Self>) {
        self.load_state = LoadState::Ready(data);
        self.fetch_missing_issue_details(cx);
    }

    fn fetch_missing_issue_details(&mut self, cx: &mut Context<'_, Self>) {
        if !self.capabilities.issues {
            return;
        }
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let LoadState::Ready(data) = &self.load_state else {
            return;
        };
        let generation = self.load_generation;
        let to_fetch: Vec<ThreadIssueLink> = data
            .issues
            .iter()
            .filter(|issue| !self.issue_details.contains_key(&thread_issue_key(issue)))
            .cloned()
            .collect();

        for issue in to_fetch {
            let conn = conn.clone();
            let key = thread_issue_key(&issue);
            cx.spawn(async move |this, cx| {
                let payload = json!({
                    "projectId": issue.project_id,
                    "tracker": issue.tracker,
                    "host": issue.host,
                    "scope": issue.scope,
                    "key": issue.key,
                });
                let Ok(value) = conn.call_json("issues.detail", payload).await else {
                    return;
                };
                let Ok(detail) = serde_json::from_value::<IssueDetailSummary>(value) else {
                    return;
                };
                let _ = this.update(cx, |panel, cx| {
                    if panel.load_generation != generation {
                        return;
                    }
                    panel.issue_details.insert(key, detail);
                    cx.notify();
                });
            })
            .detach();
        }
    }

    fn next_command_id(&mut self, verb: &str) -> String {
        self.command_seq = self.command_seq.wrapping_add(1);
        format!(
            "linked-items-{verb}-{}-{}",
            now_epoch_ms(),
            self.command_seq
        )
    }

    fn current_project(&self) -> Option<&ProjectRepoInfo> {
        let project_id = match &self.load_state {
            LoadState::Ready(data) => data.project_id.as_deref(),
            _ => None,
        };
        if let Some(id) = project_id
            && let Some(info) = self.projects.get(id)
        {
            return Some(info);
        }
        let root = self.workspace_root.as_deref()?;
        self.projects
            .values()
            .find(|info| info.workspace_root == root)
    }

    fn projects_list(&self) -> Vec<ProjectRepoInfo> {
        self.projects.values().cloned().collect()
    }

    fn open_pull_request(&mut self, link: ThreadPullRequestLink, cx: &mut Context<'_, Self>) {
        self.open_menu_key = None;
        let thread_project_id = match &self.load_state {
            LoadState::Ready(data) => data.project_id.as_deref(),
            _ => None,
        };
        let projects = self.projects_list();
        let project_id = find_project_for_link(&projects, thread_project_id, &link);
        cx.emit(LinkedItemsEvent::OpenPullRequest {
            project_id,
            host: link.host,
            repository: link.repository,
            number: link.number,
            url: link.url,
        });
        cx.notify();
    }

    fn open_issue(&mut self, issue: ThreadIssueLink, cx: &mut Context<'_, Self>) {
        self.open_menu_key = None;
        cx.emit(LinkedItemsEvent::OpenIssue {
            project_id: issue.project_id,
            tracker: issue.tracker,
            host: issue.host,
            scope: issue.scope,
            key: issue.key,
            display_key: issue.display_key,
            url: issue.url,
        });
        cx.notify();
    }

    fn copy_link(&mut self, url: String, cx: &mut Context<'_, Self>) {
        self.open_menu_key = None;
        cx.write_to_clipboard(ClipboardItem::new_string(url));
        cx.notify();
    }

    fn set_watching(
        &mut self,
        link: ThreadPullRequestLink,
        watching: bool,
        cx: &mut Context<'_, Self>,
    ) {
        self.open_menu_key = None;
        self.action_notice = None;
        let (Some(conn), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let command = OrchestrationV2Command::ThreadPullRequestWatch(
            OrchestrationV2CommandThreadPullRequestWatch {
                r#type: lit::ThreadPullRequestWatch,
                command_id: self.next_command_id("watch"),
                thread_id,
                host: link.host,
                repository: link.repository,
                number: link.number,
                watching,
                link: None,
            },
        );
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = conn.dispatch_command(command).await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(_) => panel.reload(true, cx),
                    Err(err) => panel.action_notice = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn unlink(&mut self, link: ThreadPullRequestLink, cx: &mut Context<'_, Self>) {
        self.open_menu_key = None;
        self.action_notice = None;
        let (Some(conn), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            return;
        };
        let command = OrchestrationV2Command::ThreadPullRequestUnlink(
            OrchestrationV2CommandThreadPullRequestUnlink {
                r#type: lit::ThreadPullRequestUnlink,
                command_id: self.next_command_id("unlink"),
                thread_id,
                host: link.host,
                repository: link.repository,
                number: link.number,
            },
        );
        cx.notify();
        cx.spawn(async move |this, cx| {
            let res = conn.dispatch_command(command).await;
            let _ = this.update(cx, |panel, cx| {
                match res {
                    Ok(_) => panel.reload(true, cx),
                    Err(err) => panel.action_notice = Some(err.to_string()),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_link_dialog(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.open_menu_key = None;
        self.link_dialog_open = true;
        self.link_reference.clear();
        self.link_dirty = false;
        self.link_pending = false;
        self.link_error = None;
        self.link_input.update(cx, |state, cx| {
            state.set_value(String::new(), window, cx);
            state.focus(window, cx);
        });
        cx.notify();
    }

    fn close_link_dialog(&mut self, cx: &mut Context<'_, Self>) {
        if self.link_pending {
            return;
        }
        self.link_dialog_open = false;
        self.link_error = None;
        cx.notify();
    }

    fn submit_link_dialog(&mut self, cx: &mut Context<'_, Self>) {
        if self.link_pending {
            return;
        }
        self.link_dirty = true;
        let resolution =
            resolve_link_pull_request_input(&self.link_reference, self.current_project());
        let LinkInputResolution::Resolved(parsed) = resolution else {
            cx.notify();
            return;
        };
        let (Some(conn), Some(thread_id)) = (self.connection.clone(), self.thread_id.clone())
        else {
            self.link_error = Some("The thread's environment is not available.".to_owned());
            cx.notify();
            return;
        };

        self.link_pending = true;
        self.link_error = None;
        let command = OrchestrationV2Command::ThreadPullRequestLink(
            OrchestrationV2CommandThreadPullRequestLink {
                r#type: lit::ThreadPullRequestLink,
                command_id: self.next_command_id("link"),
                thread_id,
                host: parsed.host,
                repository: parsed.repository,
                number: parsed.number,
                url: parsed.url,
                source: ThreadPullRequestLinkSource::Manual,
                repository_web_url: None,
            },
        );
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn.dispatch_command(command).await;
            let _ = this.update(cx, |panel, cx| {
                panel.link_pending = false;
                match res {
                    Ok(_) => {
                        panel.link_dialog_open = false;
                        panel.link_reference.clear();
                        panel.link_dirty = false;
                        panel.link_error = None;
                        panel.reload(true, cx);
                    }
                    Err(err) => {
                        panel.link_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn handle_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<'_, Self>) {
        match event.keystroke.key.as_str() {
            "escape" => {
                if self.link_dialog_open {
                    self.close_link_dialog(cx);
                } else if self.open_menu_key.is_some() {
                    self.open_menu_key = None;
                    cx.notify();
                }
            }
            "enter" if self.link_dialog_open => {
                self.submit_link_dialog(cx);
            }
            _ => {}
        }
    }
}

impl Render for LinkedItemsPanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let entity = cx.entity();

        let body = if !self.server_available || self.connection.is_none() {
            render_unavailable_state(
                &self.tokens,
                "Linked items unavailable",
                "The thread's environment is not available.",
                None,
            )
        } else if self.thread_id.is_none() {
            chrome::empty_state(&self.tokens, "Select a thread to view linked items.")
                .into_any_element()
        } else {
            match &self.load_state {
                LoadState::Idle | LoadState::Loading => render_loading_state(&self.tokens),
                LoadState::Error(error) => render_unavailable_state(
                    &self.tokens,
                    "Could not load pull requests",
                    error.clone(),
                    Some({
                        let entity = entity.clone();
                        Rc::new(move |_, cx| {
                            entity.update(cx, |panel, cx| panel.reload(false, cx));
                        })
                    }),
                ),
                LoadState::Ready(data) => {
                    let visible = visible_thread_pull_requests(&data.pull_requests);
                    if visible.is_empty() && data.issues.is_empty() {
                        render_empty_state(&self.tokens, {
                            let entity = entity.clone();
                            Rc::new(move |window, cx| {
                                entity.update(cx, |panel, cx| panel.open_link_dialog(window, cx));
                            })
                        })
                    } else {
                        let chains = resolve_thread_pull_request_chains(&visible);
                        let lines = pull_request_list_lines(chains);
                        let callbacks = ListCallbacks {
                            on_open_pr: {
                                let entity = entity.clone();
                                Rc::new(move |link, _, cx| {
                                    entity
                                        .update(cx, |panel, cx| panel.open_pull_request(link, cx));
                                })
                            },
                            on_open_issue: {
                                let entity = entity.clone();
                                Rc::new(move |issue, _, cx| {
                                    entity.update(cx, |panel, cx| panel.open_issue(issue, cx));
                                })
                            },
                            on_copy_link: {
                                let entity = entity.clone();
                                Rc::new(move |url, _, cx| {
                                    entity.update(cx, |panel, cx| panel.copy_link(url, cx));
                                })
                            },
                            on_toggle_watch: {
                                let entity = entity.clone();
                                Rc::new(move |link, watching, _, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.set_watching(link, watching, cx);
                                    });
                                })
                            },
                            on_unlink: {
                                let entity = entity.clone();
                                Rc::new(move |link, _, cx| {
                                    entity.update(cx, |panel, cx| panel.unlink(link, cx));
                                })
                            },
                            on_toggle_menu: {
                                let entity = entity.clone();
                                Rc::new(move |key, _, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.open_menu_key = key;
                                        cx.notify();
                                    });
                                })
                            },
                            on_open_link_dialog: {
                                let entity = entity.clone();
                                Rc::new(move |window, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.open_link_dialog(window, cx);
                                    });
                                })
                            },
                            on_dismiss_notice: {
                                let entity = entity.clone();
                                Rc::new(move |_, cx| {
                                    entity.update(cx, |panel, cx| {
                                        panel.action_notice = None;
                                        cx.notify();
                                    });
                                })
                            },
                        };
                        render_linked_list(
                            &self.tokens,
                            &visible,
                            &lines,
                            &data.issues,
                            &self.issue_details,
                            self.open_menu_key.as_deref(),
                            self.capabilities,
                            self.action_notice.as_deref(),
                            self.now_ms,
                            callbacks,
                        )
                    }
                }
            }
        };

        let mut root = v_flex()
            .relative()
            .size_full()
            .min_h_0()
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                this.handle_key_down(event, cx);
            }))
            .child(body);

        if self.link_dialog_open {
            let resolution =
                resolve_link_pull_request_input(&self.link_reference, self.current_project());
            root = root.child(render_link_dialog(
                &self.tokens,
                &self.link_input,
                &resolution,
                self.link_dirty,
                self.link_error.as_deref(),
                self.link_pending,
                {
                    let entity = entity.clone();
                    Rc::new(move |_, cx| {
                        entity.update(cx, |panel, cx| panel.close_link_dialog(cx));
                    })
                },
                Rc::new(move |_, cx| {
                    entity.update(cx, |panel, cx| panel.submit_link_dialog(cx));
                }),
            ));
        }

        root
    }
}
