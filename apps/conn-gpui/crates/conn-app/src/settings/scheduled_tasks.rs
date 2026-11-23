//! Settings › Scheduled tasks & webhooks page matching Conn's `ScheduledTasksSettings.tsx`.
//!
//! Subscribes live to `conn-server`'s `scheduledTasks.subscribe` RPC stream and exposes:
//! - Task list with schedule summary, next/last run status, enable switch, Run now, Edit, Delete,
//!   and webhook URL Copy / Rotate / Deliveries actions.
//! - Inline Create/Edit form (`scheduledTasks.upsert`) supporting Fixed time (with weekdays),
//!   Interval, Once, and Webhook (HMAC signature, max age, replay/coalesce dedupe), plus workspace
//!   strategy, project, model, and runtime mode.
//! - Inline Webhook Deliveries inspector (`scheduledTasks.listWebhookDeliveries` &
//!   `scheduledTasks.getWebhookDelivery`).

use conn_client::{Connection, StreamId};
use conn_contract::{RuntimeMode, ScheduledTaskWebhookSignatureEncoding};
use conn_state::{
    DEFAULT_WEBHOOK_SIGNATURE_HEADER, DEFAULT_WEBHOOK_SIGNATURE_PREFIX, ScheduleMode,
    ScheduledTask, ScheduledTaskDraft, ScheduledTaskGetWebhookDeliveryInput,
    ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskListResult,
    ScheduledTaskListWebhookDeliveriesInput, ScheduledTaskListWebhookDeliveriesResult,
    ScheduledTaskRunNowResult, ScheduledTaskRunStatus, ScheduledTaskSchedule,
    ScheduledTaskSetEnabledInput, ScheduledTaskWebhookDelivery,
    ScheduledTaskWebhookDeliverySummary, WorkspaceMode, build_upsert_input, resolve_webhook_url,
    schedule_label, webhook_delivery_label,
};
use conn_theme::{ShellGeometry, Tokens};
use gpui_kit::component::input::{Input, InputState, Textarea, TextareaState};
use gpui_kit::{
    AnyElement, AppContext as _, ClickEvent, ClipboardItem, Context, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, Window, div, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::settings::controls::{pill_switch, settings_row, settings_section};
use crate::theme::hsla;

/// Lightweight project entry passed from `ConnApp` into Settings › Scheduled tasks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScheduledTaskProjectOption {
    pub(crate) id: String,
    pub(crate) name: String,
}

const WEEKDAY_ORDER: [(i64, &str); 7] = [
    (1, "Mo"),
    (2, "Tu"),
    (3, "We"),
    (4, "Th"),
    (5, "Fr"),
    (6, "Sa"),
    (0, "Su"),
];

const RUNTIME_MODES: [(RuntimeMode, &str); 4] = [
    (RuntimeMode::FullAccess, "Full access"),
    (RuntimeMode::Auto, "Auto"),
    (RuntimeMode::AutoAcceptEdits, "Auto-accept edits"),
    (RuntimeMode::ApprovalRequired, "Approval required"),
];

enum ActiveSubView {
    List,
    Editor(EditorState),
    Deliveries(DeliveriesState),
}

struct EditorState {
    draft: ScheduledTaskDraft,
    title_input: Entity<InputState>,
    prompt_input: Entity<TextareaState>,
    interval_input: Entity<InputState>,
    time_of_day_input: Entity<InputState>,
    run_at_input: Entity<InputState>,
    base_ref_input: Entity<InputState>,
    existing_worktree_input: Entity<InputState>,
    instance_input: Entity<InputState>,
    model_input: Entity<InputState>,
    sig_header_input: Entity<InputState>,
    sig_prefix_input: Entity<InputState>,
    sig_secret_input: Entity<InputState>,
    max_age_input: Entity<InputState>,
    replay_key_input: Entity<InputState>,
    coalesce_key_input: Entity<InputState>,
    coalesce_window_input: Entity<InputState>,
    saving: bool,
    error: Option<String>,
}

struct DeliveriesState {
    task_id: String,
    task_title: String,
    loading: bool,
    error: Option<String>,
    deliveries: Vec<ScheduledTaskWebhookDeliverySummary>,
    selected_id: Option<String>,
    selected: Option<ScheduledTaskWebhookDelivery>,
    loading_detail: bool,
}

/// Entity owning the live `scheduledTasks.subscribe` stream and task CRUD UI.
pub(crate) struct ScheduledTasksView {
    tokens: Tokens,
    geometry: ShellGeometry,
    connection: Option<Connection>,
    server_url: Option<String>,
    projects: Vec<ScheduledTaskProjectOption>,
    default_instance_id: Option<String>,
    default_model: String,
    tasks: Vec<ScheduledTask>,
    time_zone: Option<String>,
    loading: bool,
    error: Option<String>,
    notice: Option<String>,
    busy_task_id: Option<String>,
    sub_view: ActiveSubView,
    stream_id: Option<StreamId>,
    _stream_task: Option<Task<()>>,
    _op_task: Option<Task<()>>,
}

impl Drop for ScheduledTasksView {
    fn drop(&mut self) {
        if let (Some(conn), Some(id)) = (self.connection.as_ref(), self.stream_id.take()) {
            conn.cancel_stream(id);
        }
    }
}

/// Initialization parameters for [`ScheduledTasksView`].
pub(crate) struct ScheduledTasksInit {
    pub(crate) tokens: Tokens,
    pub(crate) geometry: ShellGeometry,
    pub(crate) connection: Option<Connection>,
    pub(crate) server_url: Option<String>,
    pub(crate) projects: Vec<ScheduledTaskProjectOption>,
    pub(crate) default_instance_id: Option<String>,
    pub(crate) default_model: String,
}

impl ScheduledTasksView {
    #[must_use]
    pub(crate) fn new(init: ScheduledTasksInit, cx: &mut Context<'_, Self>) -> Self {
        let mut this = Self {
            tokens: init.tokens,
            geometry: init.geometry,
            connection: init.connection,
            server_url: init.server_url,
            projects: init.projects,
            default_instance_id: init.default_instance_id,
            default_model: init.default_model,
            tasks: Vec::new(),
            time_zone: None,
            loading: false,
            error: None,
            notice: None,
            busy_task_id: None,
            sub_view: ActiveSubView::List,
            stream_id: None,
            _stream_task: None,
            _op_task: None,
        };
        this.start_subscription(cx);
        this
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        server_url: Option<String>,
        projects: Vec<ScheduledTaskProjectOption>,
        cx: &mut Context<'_, Self>,
    ) {
        if let (Some(prev), Some(id)) = (self.connection.as_ref(), self.stream_id.take()) {
            prev.cancel_stream(id);
        }
        self._stream_task = None;
        self.connection = connection;
        self.server_url = server_url;
        self.projects = projects;
        self.tasks.clear();
        self.error = None;
        self.sub_view = ActiveSubView::List;
        self.start_subscription(cx);
        cx.notify();
    }

    fn start_subscription(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            self.loading = false;
            return;
        };
        self.loading = true;
        self.error = None;
        let (stream_id, mut rx) =
            conn.stream_json("scheduledTasks.subscribe", serde_json::json!({}));
        self.stream_id = Some(stream_id);

        let task = cx.spawn(async move |this, cx| {
            while let Some(raw) = rx.recv().await {
                match serde_json::from_value::<ScheduledTaskListResult>(raw) {
                    Ok(snapshot) => {
                        let tasks: Vec<ScheduledTask> =
                            snapshot.tasks.into_iter().flatten().collect();
                        let time_zone = snapshot.time_zone;
                        let updated = this.update(cx, |view, cx| {
                            view.tasks = tasks;
                            view.time_zone = time_zone;
                            view.loading = false;
                            view.error = None;
                            cx.notify();
                        });
                        if updated.is_err() {
                            break;
                        }
                    }
                    Err(err) => {
                        let _ = this.update(cx, |view, cx| {
                            view.loading = false;
                            view.error = Some(format!("Failed to decode scheduled tasks: {err}"));
                            cx.notify();
                        });
                    }
                }
            }
            let _ = this.update(cx, |view, cx| {
                if view.loading {
                    view.loading = false;
                    cx.notify();
                }
            });
        });
        self._stream_task = Some(task);
    }

    fn open_new_editor(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let default_project_id = self
            .projects
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_default();
        let draft = ScheduledTaskDraft::new_default(
            default_project_id,
            self.default_instance_id.clone(),
            if self.default_model.is_empty() {
                "claude-sonnet-4-6".to_owned()
            } else {
                self.default_model.clone()
            },
        );
        self.open_editor(draft, window, cx);
    }

    fn open_edit_editor(
        &mut self,
        task: &ScheduledTask,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let draft = ScheduledTaskDraft::from_task(task);
        self.open_editor(draft, window, cx);
    }

    fn open_editor(
        &mut self,
        draft: ScheduledTaskDraft,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let title_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Morning PR triage")
                .default_value(draft.title.clone())
        });
        let prompt_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("What should the agent do on each run?")
                .default_value(draft.prompt.clone())
                .auto_grow(4, 10)
        });
        let interval_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("15")
                .default_value(draft.interval_minutes.clone())
        });
        let time_of_day_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("09:00")
                .default_value(draft.time_of_day.clone())
        });
        let run_at_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("2026-12-01T09:00:00Z")
                .default_value(draft.run_at.clone())
        });
        let base_ref_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("main")
                .default_value(draft.base_ref.clone())
        });
        let existing_worktree_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("/path/to/worktree")
                .default_value(draft.existing_worktree_path.clone())
        });
        let instance_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("claudeAgent")
                .default_value(draft.instance_id.clone().unwrap_or_default())
        });
        let model_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("claude-sonnet-4-6")
                .default_value(draft.model.clone())
        });
        let sig_header_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(DEFAULT_WEBHOOK_SIGNATURE_HEADER)
                .default_value(draft.signature_header.clone())
        });
        let sig_prefix_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(DEFAULT_WEBHOOK_SIGNATURE_PREFIX)
                .default_value(draft.signature_prefix.clone())
        });
        let sig_secret_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Leave blank to keep stored secret")
                .default_value(draft.signature_secret.clone())
        });
        let max_age_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Blank = no limit")
                .default_value(draft.max_delivery_age_minutes.clone())
        });
        let replay_key_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("{{headers.x-github-delivery}}")
                .default_value(draft.replay_key.clone())
        });
        let coalesce_key_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("{{body.repository.full_name}}")
                .default_value(draft.coalesce_key.clone())
        });
        let coalesce_window_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("60")
                .default_value(draft.coalesce_window_seconds.clone())
        });

        self.notice = None;
        self.sub_view = ActiveSubView::Editor(EditorState {
            draft,
            title_input,
            prompt_input,
            interval_input,
            time_of_day_input,
            run_at_input,
            base_ref_input,
            existing_worktree_input,
            instance_input,
            model_input,
            sig_header_input,
            sig_prefix_input,
            sig_secret_input,
            max_age_input,
            replay_key_input,
            coalesce_key_input,
            coalesce_window_input,
            saving: false,
            error: None,
        });
        cx.notify();
    }

    fn submit_editor(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let ActiveSubView::Editor(editor) = &mut self.sub_view else {
            return;
        };
        if editor.saving {
            return;
        }
        editor.draft.title = editor.title_input.read(cx).value().to_string();
        editor.draft.prompt = editor.prompt_input.read(cx).value().to_string();
        editor.draft.interval_minutes = editor.interval_input.read(cx).value().to_string();
        editor.draft.time_of_day = editor.time_of_day_input.read(cx).value().to_string();
        editor.draft.run_at = editor.run_at_input.read(cx).value().to_string();
        editor.draft.base_ref = editor.base_ref_input.read(cx).value().to_string();
        editor.draft.existing_worktree_path =
            editor.existing_worktree_input.read(cx).value().to_string();
        let inst = editor.instance_input.read(cx).value().trim().to_owned();
        editor.draft.instance_id = if inst.is_empty() { None } else { Some(inst) };
        editor.draft.model = editor.model_input.read(cx).value().to_string();
        editor.draft.signature_header = editor.sig_header_input.read(cx).value().to_string();
        editor.draft.signature_prefix = editor.sig_prefix_input.read(cx).value().to_string();
        editor.draft.signature_secret = editor.sig_secret_input.read(cx).value().to_string();
        editor.draft.max_delivery_age_minutes = editor.max_age_input.read(cx).value().to_string();
        editor.draft.replay_key = editor.replay_key_input.read(cx).value().to_string();
        editor.draft.coalesce_key = editor.coalesce_key_input.read(cx).value().to_string();
        editor.draft.coalesce_window_seconds =
            editor.coalesce_window_input.read(cx).value().to_string();

        let payload = match build_upsert_input(&editor.draft) {
            Ok(input) => input,
            Err(err) => {
                editor.error = Some(err);
                cx.notify();
                return;
            }
        };
        editor.saving = true;
        editor.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let result = conn
                .call::<_, ScheduledTaskRunNowResult>("scheduledTasks.upsert", &payload)
                .await;
            let _ = this.update(cx, |view, cx| match result {
                Ok(saved) => {
                    view.upsert_local_task(saved.task);
                    view.sub_view = ActiveSubView::List;
                    view.notice = Some("Saved scheduled task.".to_owned());
                    cx.notify();
                }
                Err(err) => {
                    if let ActiveSubView::Editor(ed) = &mut view.sub_view {
                        ed.saving = false;
                        ed.error = Some(format!("Could not save task: {err}"));
                    }
                    cx.notify();
                }
            });
        }));
    }

    fn toggle_enabled(&mut self, task_id: String, enabled: bool, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.busy_task_id = Some(task_id.clone());
        self.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let payload = ScheduledTaskSetEnabledInput {
                id: task_id,
                enabled,
            };
            let result = conn
                .call::<_, ScheduledTaskRunNowResult>("scheduledTasks.setEnabled", &payload)
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy_task_id = None;
                match result {
                    Ok(updated) => view.upsert_local_task(updated.task),
                    Err(err) => view.error = Some(format!("Could not update task: {err}")),
                }
                cx.notify();
            });
        }));
    }

    fn run_now(&mut self, task_id: String, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.busy_task_id = Some(task_id.clone());
        self.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let result = conn
                .call::<_, ScheduledTaskRunNowResult>(
                    "scheduledTasks.runNow",
                    &serde_json::json!({ "id": task_id }),
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy_task_id = None;
                match result {
                    Ok(updated) => {
                        view.upsert_local_task(updated.task);
                        view.notice = Some("Started scheduled task run.".to_owned());
                    }
                    Err(err) => view.error = Some(format!("Could not start task: {err}")),
                }
                cx.notify();
            });
        }));
    }

    fn rotate_webhook_token(&mut self, task_id: String, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.busy_task_id = Some(task_id.clone());
        self.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let result = conn
                .call::<_, ScheduledTaskRunNowResult>(
                    "scheduledTasks.rotateWebhookToken",
                    &serde_json::json!({ "id": task_id }),
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy_task_id = None;
                match result {
                    Ok(updated) => {
                        view.upsert_local_task(updated.task);
                        view.notice = Some("Rotated webhook URL token.".to_owned());
                    }
                    Err(err) => view.error = Some(format!("Could not rotate token: {err}")),
                }
                cx.notify();
            });
        }));
    }

    fn delete_task(&mut self, task_id: String, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.busy_task_id = Some(task_id.clone());
        self.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let result = conn
                .call_json(
                    "scheduledTasks.delete",
                    serde_json::json!({ "id": task_id }),
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                view.busy_task_id = None;
                match result {
                    Ok(_) => {
                        view.tasks.retain(|t| t.id != task_id);
                        view.notice = Some("Deleted scheduled task.".to_owned());
                    }
                    Err(err) => view.error = Some(format!("Could not delete task: {err}")),
                }
                cx.notify();
            });
        }));
    }

    fn open_deliveries(&mut self, task: &ScheduledTask, cx: &mut Context<'_, Self>) {
        self.sub_view = ActiveSubView::Deliveries(DeliveriesState {
            task_id: task.id.clone(),
            task_title: task.title.clone(),
            loading: true,
            error: None,
            deliveries: Vec::new(),
            selected_id: None,
            selected: None,
            loading_detail: false,
        });
        self.refresh_deliveries(cx);
    }

    fn refresh_deliveries(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let ActiveSubView::Deliveries(state) = &mut self.sub_view else {
            return;
        };
        let task_id = state.task_id.clone();
        state.loading = true;
        state.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let input = ScheduledTaskListWebhookDeliveriesInput {
                id: task_id.clone(),
                accept_any_outcome: Some(true),
            };
            let result = conn
                .call::<_, ScheduledTaskListWebhookDeliveriesResult>(
                    "scheduledTasks.listWebhookDeliveries",
                    &input,
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                if let ActiveSubView::Deliveries(state) = &mut view.sub_view
                    && state.task_id == task_id
                {
                    state.loading = false;
                    match result {
                        Ok(list) => state.deliveries = list.deliveries,
                        Err(err) => state.error = Some(format!("Could not load deliveries: {err}")),
                    }
                }
                cx.notify();
            });
        }));
    }

    fn open_delivery_detail(&mut self, delivery_id: String, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let ActiveSubView::Deliveries(state) = &mut self.sub_view else {
            return;
        };
        let task_id = state.task_id.clone();
        state.selected_id = Some(delivery_id.clone());
        state.selected = None;
        state.loading_detail = true;
        state.error = None;
        cx.notify();

        self._op_task = Some(cx.spawn(async move |this, cx| {
            let input = ScheduledTaskGetWebhookDeliveryInput {
                id: task_id.clone(),
                delivery_id: delivery_id.clone(),
                accept_any_outcome: Some(true),
            };
            let result = conn
                .call::<_, ScheduledTaskGetWebhookDeliveryResult>(
                    "scheduledTasks.getWebhookDelivery",
                    &input,
                )
                .await;
            let _ = this.update(cx, |view, cx| {
                if let ActiveSubView::Deliveries(state) = &mut view.sub_view
                    && state.task_id == task_id
                    && state.selected_id.as_deref() == Some(delivery_id.as_str())
                {
                    state.loading_detail = false;
                    match result {
                        Ok(res) => state.selected = Some(res.delivery),
                        Err(err) => state.error = Some(format!("Could not load delivery: {err}")),
                    }
                }
                cx.notify();
            });
        }));
    }

    fn upsert_local_task(&mut self, task: ScheduledTask) {
        if let Some(existing) = self.tasks.iter_mut().find(|t| t.id == task.id) {
            *existing = task;
        } else {
            self.tasks.insert(0, task);
        }
    }

    fn project_name(&self, project_id: &str) -> String {
        self.projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| project_id.to_owned())
    }

    fn pill_button(
        &self,
        id: impl Into<SharedString>,
        ax_id: impl Into<SharedString>,
        label: &str,
        icon: Option<&'static str>,
        active: bool,
        danger: bool,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let id = id.into();
        let ax_id = ax_id.into();
        let fg = if danger {
            hsla(self.tokens.destructive)
        } else {
            hsla(self.tokens.foreground)
        };
        let bg = if active {
            hsla(self.tokens.shell_highlight)
        } else {
            hsla(self.tokens.shell_control_raised)
        };
        let border = hsla(self.tokens.shell_control_raised_border);
        let hover = hsla(self.tokens.sidebar_row_hover);

        let mut btn = div()
            .id(id)
            .a11y_button(ax_id, label.to_owned())
            .flex()
            .flex_row()
            .items_center()
            .gap(px(5.0))
            .h(px(26.0))
            .px(px(9.0))
            .rounded(px(6.0))
            .bg(bg)
            .border_1()
            .border_color(border)
            .text_size(px(12.0))
            .font_weight(if active {
                FontWeight::MEDIUM
            } else {
                FontWeight::NORMAL
            })
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover));
        if let Some(icon_path) = icon {
            btn = btn.child(icons::concept(icon_path, 12.0, fg));
        }
        btn.child(label.to_owned())
    }

    fn render_list(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);
        let err_color = hsla(self.tokens.destructive);
        let ok_color = hsla(self.tokens.success);
        let warn_color = hsla(self.tokens.warning);
        let info_color = hsla(self.tokens.info);

        let mut top_bar = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .px(px(4.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(2.0))
                    .child(
                        div()
                            .text_size(px(self.geometry.ui_font_size_px))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child("Scheduled tasks"),
                    )
                    .children(self.time_zone.as_ref().map(|tz| {
                        div()
                            .text_size(px(12.0))
                            .text_color(muted)
                            .child(format!("Server time zone: {tz}"))
                    })),
            );

        if self.connection.is_some() {
            top_bar = top_bar.child(
                self.pill_button(
                    "scheduled-new-task",
                    "settings.scheduled.new",
                    "New task",
                    Some("superhero/add.svg"),
                    false,
                    false,
                )
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                    this.open_new_editor(window, cx);
                })),
            );
        }

        let mut col = div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(14.0))
            .child(top_bar);

        if let Some(notice) = &self.notice {
            col = col.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.shell_settings_card))
                    .border_1()
                    .border_color(hsla(self.tokens.shell_settings_card_border))
                    .text_size(px(12.0))
                    .text_color(ok_color)
                    .child(notice.clone()),
            );
        }

        if let Some(error) = &self.error {
            col = col.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(8.0))
                    .bg(hsla(self.tokens.shell_settings_card))
                    .border_1()
                    .border_color(err_color)
                    .text_size(px(12.0))
                    .text_color(err_color)
                    .child(error.clone()),
            );
        }

        let rows: Vec<AnyElement> = if self.connection.is_none() {
            vec![settings_row(
                "No server connected",
                Some("Connect to an Orbit Node or Instance to view and manage scheduled tasks."),
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            )]
        } else if self.loading && self.tasks.is_empty() {
            vec![settings_row(
                "Loading scheduled tasks…",
                None,
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            )]
        } else if self.tasks.is_empty() {
            vec![settings_row(
                "No scheduled tasks",
                Some(
                    "Create recurring agent runs on a fixed schedule, interval, one-shot timestamp, or incoming webhook.",
                ),
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            )]
        } else {
            self.tasks
                .iter()
                .map(|task| {
                    let is_webhook = matches!(task.schedule, ScheduledTaskSchedule::Webhook(_));
                    let schedule_text = schedule_label(&task.schedule);
                    let status_text = if let Some(policy) = &task.blocked_by_policy {
                        policy.clone()
                    } else if !task.enabled {
                        "Paused".to_owned()
                    } else if is_webhook {
                        "Listening".to_owned()
                    } else if let Some(next) = &task.next_run_at {
                        format!("Next run {next}")
                    } else {
                        "Not scheduled".to_owned()
                    };

                    let (run_badge_text, run_badge_color) = match task.last_run_status {
                        ScheduledTaskRunStatus::Never => (None, muted),
                        ScheduledTaskRunStatus::Running => (Some("running"), info_color),
                        ScheduledTaskRunStatus::Succeeded => (Some("succeeded"), ok_color),
                        ScheduledTaskRunStatus::Failed => (Some("failed"), err_color),
                    };

                    let project_label = self.project_name(&task.project_id);
                    let summary = format!(
                        "{schedule_text} · {status_text} · {project_label} · {} run{}",
                        task.run_count,
                        if task.run_count == 1 { "" } else { "s" }
                    );

                    let task_id = task.id.clone();
                    let next_enabled = !task.enabled;
                    let entity = cx.entity();
                    let switch = pill_switch(
                        SharedString::from(format!("scheduled-enable-{}", task.id)),
                        task.enabled,
                        &self.tokens,
                        move |_window, cx| {
                            entity.update(cx, |this, cx| {
                                this.toggle_enabled(task_id.clone(), next_enabled, cx);
                            });
                        },
                    );

                    let task_for_edit = task.clone();
                    let edit_btn = self
                        .pill_button(
                            SharedString::from(format!("scheduled-edit-{}", task.id)),
                            SharedString::from(format!("settings.scheduled.edit.{}", task.id)),
                            "Edit",
                            Some("superhero/edit.svg"),
                            false,
                            false,
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_edit_editor(&task_for_edit, window, cx);
                        }));

                    let task_id_del = task.id.clone();
                    let delete_btn = self
                        .pill_button(
                            SharedString::from(format!("scheduled-delete-{}", task.id)),
                            SharedString::from(format!("settings.scheduled.delete.{}", task.id)),
                            "Delete",
                            Some("superhero/delete.svg"),
                            false,
                            true,
                        )
                        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                            this.delete_task(task_id_del.clone(), cx);
                        }));

                    let action_btn = if is_webhook {
                        let task_for_deliv = task.clone();
                        self.pill_button(
                            SharedString::from(format!("scheduled-deliveries-{}", task.id)),
                            SharedString::from(format!(
                                "settings.scheduled.deliveries.{}",
                                task.id
                            )),
                            "Deliveries",
                            Some("superhero/inbox.svg"),
                            false,
                            false,
                        )
                        .on_click(cx.listener(
                            move |this, _: &ClickEvent, _window, cx| {
                                this.open_deliveries(&task_for_deliv, cx);
                            },
                        ))
                    } else {
                        let task_id_run = task.id.clone();
                        self.pill_button(
                            SharedString::from(format!("scheduled-run-{}", task.id)),
                            SharedString::from(format!("settings.scheduled.run.{}", task.id)),
                            "Run now",
                            Some("superhero/play.svg"),
                            false,
                            false,
                        )
                        .on_click(cx.listener(
                            move |this, _: &ClickEvent, _window, cx| {
                                this.run_now(task_id_run.clone(), cx);
                            },
                        ))
                    };

                    let mut left = div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .gap(px(4.0))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .child(icons::concept(
                                    if is_webhook {
                                        "superhero/webhook.svg"
                                    } else {
                                        "superhero/scheduled.svg"
                                    },
                                    13.0,
                                    if task.enabled { fg } else { muted },
                                ))
                                .child(
                                    div()
                                        .text_size(px(self.geometry.ui_font_size_px))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(fg)
                                        .truncate()
                                        .child(task.title.clone()),
                                )
                                .children(run_badge_text.map(|badge| {
                                    div()
                                        .px(px(6.0))
                                        .py(px(1.0))
                                        .rounded(px(9999.0))
                                        .bg(hsla(self.tokens.shell_control_raised))
                                        .border_1()
                                        .border_color(run_badge_color)
                                        .text_size(px(11.0))
                                        .text_color(run_badge_color)
                                        .child(badge)
                                })),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(muted)
                                .truncate()
                                .child(task.prompt.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(if task.blocked_by_policy.is_some() {
                                    warn_color
                                } else {
                                    muted
                                })
                                .child(summary),
                        );

                    if let Some(last_err) = &task.last_run_error {
                        left = left.child(
                            div()
                                .text_size(px(12.0))
                                .text_color(err_color)
                                .child(last_err.clone()),
                        );
                    }

                    if let Some(endpoint) = &task.webhook
                        && let Some(url) = resolve_webhook_url(endpoint, self.server_url.as_deref())
                    {
                        let url_copy = url.clone();
                        let task_id_rot = task.id.clone();
                        left = left.child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .pt(px(4.0))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .px(px(8.0))
                                        .py(px(4.0))
                                        .rounded(px(6.0))
                                        .bg(hsla(self.tokens.shell_control))
                                        .border_1()
                                        .border_color(hsla(self.tokens.shell_control_raised_border))
                                        .font_family(crate::theme::MONO_FONT)
                                        .text_size(px(11.0))
                                        .text_color(muted)
                                        .truncate()
                                        .child(url),
                                )
                                .child(
                                    self.pill_button(
                                        SharedString::from(format!("scheduled-copy-{}", task.id)),
                                        SharedString::from(format!(
                                            "settings.scheduled.copy.{}",
                                            task.id
                                        )),
                                        "Copy",
                                        Some("superhero/copy.svg"),
                                        false,
                                        false,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _: &ClickEvent, _window, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(
                                                url_copy.clone(),
                                            ));
                                            this.notice =
                                                Some("Copied webhook URL to clipboard.".to_owned());
                                            cx.notify();
                                        },
                                    )),
                                )
                                .child(
                                    self.pill_button(
                                        SharedString::from(format!("scheduled-rotate-{}", task.id)),
                                        SharedString::from(format!(
                                            "settings.scheduled.rotate.{}",
                                            task.id
                                        )),
                                        "Rotate",
                                        Some("superhero/rotate-forward.svg"),
                                        false,
                                        false,
                                    )
                                    .on_click(cx.listener(
                                        move |this, _: &ClickEvent, _window, cx| {
                                            this.rotate_webhook_token(task_id_rot.clone(), cx);
                                        },
                                    )),
                                ),
                        );
                    }

                    let busy = self.busy_task_id.as_deref() == Some(task.id.as_str());
                    let controls = div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .flex_shrink_0()
                        .child(switch)
                        .child(action_btn)
                        .child(edit_btn)
                        .child(delete_btn)
                        .children(
                            busy.then(|| div().text_size(px(11.0)).text_color(muted).child("…")),
                        );

                    div()
                        .id(SharedString::from(format!("scheduled-row-{}", task.id)))
                        .a11y_group(
                            SharedString::from(format!("settings.scheduled.row.{}", task.id)),
                            task.title.clone(),
                        )
                        .flex()
                        .flex_row()
                        .items_start()
                        .justify_between()
                        .gap(px(14.0))
                        .w_full()
                        .px(px(14.0))
                        .py(px(12.0))
                        .child(left)
                        .child(controls)
                        .into_any_element()
                })
                .collect()
        };

        col.child(settings_section(
            "Tasks",
            rows,
            &self.tokens,
            &self.geometry,
        ))
        .into_any_element()
    }

    fn render_editor(&self, editor: &EditorState, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);
        let err_color = hsla(self.tokens.destructive);
        let card_bg = hsla(self.tokens.shell_settings_card);
        let card_border = hsla(self.tokens.shell_settings_card_border);

        let heading = if editor.draft.editing_id.is_some() {
            "Edit scheduled task"
        } else {
            "New scheduled task"
        };

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .px(px(4.0))
            .child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(heading),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        self.pill_button(
                            "scheduled-editor-cancel",
                            "settings.scheduled.cancel",
                            "Cancel",
                            None,
                            false,
                            false,
                        )
                        .on_click(cx.listener(
                            |this, _: &ClickEvent, _window, cx| {
                                this.sub_view = ActiveSubView::List;
                                cx.notify();
                            },
                        )),
                    )
                    .child(
                        self.pill_button(
                            "scheduled-editor-save",
                            "settings.scheduled.save",
                            if editor.saving {
                                "Saving…"
                            } else {
                                "Save task"
                            },
                            Some("superhero/check.svg"),
                            true,
                            false,
                        )
                        .on_click(cx.listener(
                            |this, _: &ClickEvent, _window, cx| {
                                this.submit_editor(cx);
                            },
                        )),
                    ),
            );

        let field = |label: &str, hint: Option<&str>, content: AnyElement| -> AnyElement {
            div()
                .flex()
                .flex_col()
                .gap(px(6.0))
                .w_full()
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_baseline()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(12.0))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(fg)
                                .child(label.to_owned()),
                        )
                        .children(hint.map(|h| {
                            div()
                                .text_size(px(11.0))
                                .text_color(muted)
                                .child(h.to_owned())
                        })),
                )
                .child(content)
                .into_any_element()
        };

        let mut form = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .w_full()
            .p(px(16.0))
            .rounded(px(8.0))
            .bg(card_bg)
            .border_1()
            .border_color(card_border);

        if let Some(error) = &editor.error {
            form = form.child(
                div()
                    .text_size(px(12.0))
                    .text_color(err_color)
                    .child(error.clone()),
            );
        }

        // Title & prompt
        form = form
            .child(field(
                "Title",
                None,
                Input::new(&editor.title_input).into_any_element(),
            ))
            .child(field(
                "Prompt",
                Some("Sent to the agent when this task runs"),
                Textarea::new(&editor.prompt_input).into_any_element(),
            ));

        // Project selector pills
        if !self.projects.is_empty() {
            let mut proj_row = div().flex().flex_row().flex_wrap().gap(px(6.0));
            for project in &self.projects {
                let active = editor.draft.project_id == project.id;
                let pid = project.id.clone();
                proj_row = proj_row.child(
                    self.pill_button(
                        SharedString::from(format!("scheduled-proj-{}", project.id)),
                        SharedString::from(format!("settings.scheduled.project.{}", project.id)),
                        &project.name,
                        None,
                        active,
                        false,
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _window, cx| {
                            if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                ed.draft.project_id = pid.clone();
                                cx.notify();
                            }
                        },
                    )),
                );
            }
            form = form.child(field("Project", None, proj_row.into_any_element()));
        }

        // Schedule mode selector
        let mut mode_row = div().flex().flex_row().flex_wrap().gap(px(6.0));
        for mode in [
            ScheduleMode::FixedTime,
            ScheduleMode::Interval,
            ScheduleMode::Once,
            ScheduleMode::Webhook,
        ] {
            let active = editor.draft.schedule_mode == mode;
            mode_row = mode_row.child(
                self.pill_button(
                    SharedString::from(format!("scheduled-mode-{mode:?}")),
                    SharedString::from(format!("settings.scheduled.mode.{mode:?}")),
                    mode.label(),
                    None,
                    active,
                    false,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                        ed.draft.schedule_mode = mode;
                        cx.notify();
                    }
                })),
            );
        }
        form = form.child(field("Schedule", None, mode_row.into_any_element()));

        // Schedule-specific fields
        match editor.draft.schedule_mode {
            ScheduleMode::FixedTime => {
                let mut days_row = div().flex().flex_row().flex_wrap().gap(px(6.0));
                for (day_idx, label) in WEEKDAY_ORDER {
                    let active = editor.draft.weekdays.contains(&day_idx);
                    days_row = days_row.child(
                        self.pill_button(
                            SharedString::from(format!("scheduled-day-{day_idx}")),
                            SharedString::from(format!("settings.scheduled.day.{day_idx}")),
                            label,
                            None,
                            active,
                            false,
                        )
                        .on_click(cx.listener(
                            move |this, _: &ClickEvent, _window, cx| {
                                if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                    if let Some(pos) =
                                        ed.draft.weekdays.iter().position(|&d| d == day_idx)
                                    {
                                        ed.draft.weekdays.remove(pos);
                                    } else {
                                        ed.draft.weekdays.push(day_idx);
                                    }
                                    cx.notify();
                                }
                            },
                        )),
                    );
                }
                form = form
                    .child(field(
                        "Time of day",
                        Some("24-hour HH:MM in server time zone"),
                        Input::new(&editor.time_of_day_input).into_any_element(),
                    ))
                    .child(field(
                        "Weekdays",
                        Some("Leave all selected or empty for daily"),
                        days_row.into_any_element(),
                    ));
            }
            ScheduleMode::Interval => {
                form = form.child(field(
                    "Repeat every (minutes)",
                    Some("Whole minutes >= 1"),
                    Input::new(&editor.interval_input).into_any_element(),
                ));
            }
            ScheduleMode::Once => {
                form = form.child(field(
                    "Run at (ISO-8601)",
                    Some("e.g. 2026-12-01T09:00:00Z"),
                    Input::new(&editor.run_at_input).into_any_element(),
                ));
            }
            ScheduleMode::Webhook => {
                let entity = cx.entity();
                let sig_switch = pill_switch(
                    "scheduled-webhook-sig-switch",
                    editor.draft.signature_enabled,
                    &self.tokens,
                    move |_window, cx| {
                        entity.update(cx, |this, cx| {
                            if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                ed.draft.signature_enabled = !ed.draft.signature_enabled;
                                cx.notify();
                            }
                        });
                    },
                );
                form = form.child(field(
                    "HMAC signature verification",
                    Some("Verify incoming webhook payloads before running"),
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .child(sig_switch)
                        .child(div().text_size(px(12.0)).text_color(muted).child(
                            if editor.draft.signature_enabled {
                                "Required"
                            } else {
                                "Disabled"
                            },
                        ))
                        .into_any_element(),
                ));
                if editor.draft.signature_enabled {
                    let enc_row = div()
                        .flex()
                        .flex_row()
                        .gap(px(6.0))
                        .child(
                            self.pill_button(
                                "scheduled-sig-hex",
                                "settings.scheduled.sig.hex",
                                "Hex",
                                None,
                                editor.draft.signature_encoding
                                    == ScheduledTaskWebhookSignatureEncoding::Hex,
                                false,
                            )
                            .on_click(cx.listener(
                                |this, _: &ClickEvent, _window, cx| {
                                    if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                        ed.draft.signature_encoding =
                                            ScheduledTaskWebhookSignatureEncoding::Hex;
                                        cx.notify();
                                    }
                                },
                            )),
                        )
                        .child(
                            self.pill_button(
                                "scheduled-sig-b64",
                                "settings.scheduled.sig.base64",
                                "Base64",
                                None,
                                editor.draft.signature_encoding
                                    == ScheduledTaskWebhookSignatureEncoding::Base64,
                                false,
                            )
                            .on_click(cx.listener(
                                |this, _: &ClickEvent, _window, cx| {
                                    if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                        ed.draft.signature_encoding =
                                            ScheduledTaskWebhookSignatureEncoding::Base64;
                                        cx.notify();
                                    }
                                },
                            )),
                        );

                    form = form
                        .child(field(
                            "Signature header",
                            None,
                            Input::new(&editor.sig_header_input).into_any_element(),
                        ))
                        .child(field(
                            "Signature prefix",
                            None,
                            Input::new(&editor.sig_prefix_input).into_any_element(),
                        ))
                        .child(field(
                            "Signature encoding",
                            None,
                            enc_row.into_any_element(),
                        ))
                        .child(field(
                            "Signing secret",
                            Some("Write-only; leave blank to keep current secret"),
                            Input::new(&editor.sig_secret_input).into_any_element(),
                        ));
                }
                form = form
                    .child(field(
                        "Max delivery age (minutes)",
                        Some("1–1440, blank for no limit"),
                        Input::new(&editor.max_age_input).into_any_element(),
                    ))
                    .child(field(
                        "Duplicate request key",
                        Some("Optional template like {{headers.x-github-delivery}}"),
                        Input::new(&editor.replay_key_input).into_any_element(),
                    ))
                    .child(field(
                        "Coalesce key & window (seconds)",
                        Some("Optional burst coalescing (10–3600s)"),
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(8.0))
                            .child(div().flex_1().child(Input::new(&editor.coalesce_key_input)))
                            .child(
                                div()
                                    .w(px(110.0))
                                    .child(Input::new(&editor.coalesce_window_input)),
                            )
                            .into_any_element(),
                    ));
            }
        }

        // Workspace strategy
        let mut ws_row = div().flex().flex_row().flex_wrap().gap(px(6.0));
        for mode in [
            WorkspaceMode::Worktree,
            WorkspaceMode::Root,
            WorkspaceMode::ExistingWorktree,
        ] {
            let active = editor.draft.workspace_mode == mode;
            ws_row = ws_row.child(
                self.pill_button(
                    SharedString::from(format!("scheduled-ws-{mode:?}")),
                    SharedString::from(format!("settings.scheduled.ws.{mode:?}")),
                    mode.label(),
                    None,
                    active,
                    false,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                        ed.draft.workspace_mode = mode;
                        cx.notify();
                    }
                })),
            );
        }
        form = form.child(field("Workspace", None, ws_row.into_any_element()));

        match editor.draft.workspace_mode {
            WorkspaceMode::Worktree => {
                let entity = cx.entity();
                let origin_switch = pill_switch(
                    "scheduled-origin-switch",
                    editor.draft.start_from_origin,
                    &self.tokens,
                    move |_window, cx| {
                        entity.update(cx, |this, cx| {
                            if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                                ed.draft.start_from_origin = !ed.draft.start_from_origin;
                                cx.notify();
                            }
                        });
                    },
                );
                form = form.child(field(
                    "Base branch",
                    Some("Branch for new worktrees"),
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.0))
                        .child(div().flex_1().child(Input::new(&editor.base_ref_input)))
                        .child(origin_switch)
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(muted)
                                .child("Fetch from origin"),
                        )
                        .into_any_element(),
                ));
            }
            WorkspaceMode::ExistingWorktree => {
                form = form.child(field(
                    "Checkout path",
                    None,
                    Input::new(&editor.existing_worktree_input).into_any_element(),
                ));
            }
            WorkspaceMode::Root => {}
        }

        // Model + runtime mode
        let mut rt_row = div().flex().flex_row().flex_wrap().gap(px(6.0));
        for (mode, label) in RUNTIME_MODES {
            let active = editor.draft.runtime_mode == mode;
            rt_row = rt_row.child(
                self.pill_button(
                    SharedString::from(format!("scheduled-rt-{mode:?}")),
                    SharedString::from(format!("settings.scheduled.runtime.{mode:?}")),
                    label,
                    None,
                    active,
                    false,
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    if let ActiveSubView::Editor(ed) = &mut this.sub_view {
                        ed.draft.runtime_mode = mode;
                        cx.notify();
                    }
                })),
            );
        }

        form = form
            .child(field(
                "Provider & model",
                Some("Instance id (optional) and model slug"),
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.0))
                    .child(div().w(px(180.0)).child(Input::new(&editor.instance_input)))
                    .child(div().flex_1().child(Input::new(&editor.model_input)))
                    .into_any_element(),
            ))
            .child(field("Runtime mode", None, rt_row.into_any_element()));

        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(14.0))
            .child(header)
            .child(form)
            .into_any_element()
    }

    fn render_deliveries(&self, state: &DeliveriesState, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);
        let err_color = hsla(self.tokens.destructive);
        let ok_color = hsla(self.tokens.success);
        let warn_color = hsla(self.tokens.warning);
        let card_bg = hsla(self.tokens.shell_settings_card);
        let card_border = hsla(self.tokens.shell_settings_card_border);

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .px(px(4.0))
            .child(
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child(format!("Deliveries · {}", state.task_title)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        self.pill_button(
                            "scheduled-deliv-refresh",
                            "settings.scheduled.deliveries.refresh",
                            "Refresh",
                            Some("superhero/refresh.svg"),
                            false,
                            false,
                        )
                        .on_click(cx.listener(
                            |this, _: &ClickEvent, _window, cx| {
                                this.refresh_deliveries(cx);
                            },
                        )),
                    )
                    .child(
                        self.pill_button(
                            "scheduled-deliv-back",
                            "settings.scheduled.deliveries.back",
                            if state.selected_id.is_some() {
                                "All deliveries"
                            } else {
                                "Back to tasks"
                            },
                            None,
                            false,
                            false,
                        )
                        .on_click(cx.listener(
                            |this, _: &ClickEvent, _window, cx| {
                                if let ActiveSubView::Deliveries(d) = &mut this.sub_view
                                    && d.selected_id.is_some()
                                {
                                    d.selected_id = None;
                                    d.selected = None;
                                    cx.notify();
                                    return;
                                }
                                this.sub_view = ActiveSubView::List;
                                cx.notify();
                            },
                        )),
                    ),
            );

        let outcome_color = |outcome: &str, pending_window: Option<bool>| {
            if pending_window == Some(true) {
                warn_color
            } else if outcome == "accepted" {
                ok_color
            } else if matches!(outcome, "dispatch_failed" | "rejected_signature") {
                err_color
            } else if matches!(
                outcome,
                "duplicate" | "coalesced" | "disabled" | "rate_limited" | "expired"
            ) {
                warn_color
            } else {
                muted
            }
        };

        let mut col = div().flex().flex_col().w_full().gap(px(14.0)).child(header);

        if let Some(error) = &state.error {
            col = col.child(
                div()
                    .px(px(12.0))
                    .py(px(8.0))
                    .rounded(px(8.0))
                    .bg(card_bg)
                    .border_1()
                    .border_color(err_color)
                    .text_size(px(12.0))
                    .text_color(err_color)
                    .child(error.clone()),
            );
        }

        if let Some(detail) = &state.selected {
            let badge_color = outcome_color(&detail.outcome, detail.pending_window);
            let label = webhook_delivery_label(&detail.outcome, detail.pending_window);
            let headers_text = detail
                .headers
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect::<Vec<_>>()
                .join("\n");

            let block = |title: &str, body: String| -> AnyElement {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .child(
                        div()
                            .text_size(px(12.0))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(title.to_owned()),
                    )
                    .child(
                        div()
                            .w_full()
                            .p(px(10.0))
                            .rounded(px(6.0))
                            .bg(hsla(self.tokens.shell_control))
                            .font_family(crate::theme::MONO_FONT)
                            .text_size(px(11.0))
                            .text_color(fg)
                            .child(body),
                    )
                    .into_any_element()
            };

            let prompt_text = detail.rendered_prompt.clone().unwrap_or_else(|| {
                if detail.pending_window == Some(true) {
                    "Run scheduled when the coalesce window closes; no run started yet.".to_owned()
                } else {
                    "No run was started for this request.".to_owned()
                }
            });

            let mut card = div()
                .flex()
                .flex_col()
                .gap(px(12.0))
                .p(px(14.0))
                .rounded(px(8.0))
                .bg(card_bg)
                .border_1()
                .border_color(card_border)
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.0))
                        .child(
                            div()
                                .px(px(7.0))
                                .py(px(2.0))
                                .rounded(px(9999.0))
                                .border_1()
                                .border_color(badge_color)
                                .text_size(px(11.0))
                                .text_color(badge_color)
                                .child(label),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(fg)
                                .child(format!("{} · {}", detail.method, detail.received_at)),
                        )
                        .children(detail.signature_verified.then(|| {
                            div()
                                .text_size(px(12.0))
                                .text_color(ok_color)
                                .child("Signature verified")
                        })),
                );
            if let Some(err) = &detail.error {
                card = card.child(
                    div()
                        .text_size(px(12.0))
                        .text_color(if detail.outcome == "filtered" {
                            muted
                        } else {
                            err_color
                        })
                        .child(err.clone()),
                );
            }
            card = card
                .child(block("Prompt sent to the agent", prompt_text))
                .child(block(
                    "Headers",
                    if headers_text.is_empty() {
                        "(none)".to_owned()
                    } else {
                        headers_text
                    },
                ));
            if !detail.query.is_empty() {
                card = card.child(block("Query", detail.query.clone()));
            }
            card = card.child(block(
                if detail.body_truncated {
                    "Body (truncated)"
                } else {
                    "Body"
                },
                if detail.body.is_empty() {
                    "(empty)".to_owned()
                } else {
                    detail.body.clone()
                },
            ));
            return col.child(card).into_any_element();
        }

        if state.loading_detail {
            return col
                .child(settings_section(
                    "Delivery",
                    vec![settings_row(
                        "Loading delivery details…",
                        None,
                        div().into_any_element(),
                        &self.tokens,
                        &self.geometry,
                    )],
                    &self.tokens,
                    &self.geometry,
                ))
                .into_any_element();
        }

        let rows: Vec<AnyElement> = if state.loading && state.deliveries.is_empty() {
            vec![settings_row(
                "Loading deliveries…",
                None,
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            )]
        } else if state.deliveries.is_empty() {
            vec![settings_row(
                "No requests yet",
                Some("POST to this task's webhook URL to trigger an agent run."),
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            )]
        } else {
            let hover = hsla(self.tokens.sidebar_row_hover);
            state
                .deliveries
                .iter()
                .map(|d| {
                    let badge_color = outcome_color(&d.outcome, d.pending_window);
                    let label = webhook_delivery_label(&d.outcome, d.pending_window);
                    let id = d.id.clone();
                    div()
                        .id(SharedString::from(format!("scheduled-deliv-{}", d.id)))
                        .a11y_button(
                            SharedString::from(format!("settings.scheduled.delivery.{}", d.id)),
                            format!("{label} {} {}", d.method, d.received_at),
                        )
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_between()
                        .gap(px(10.0))
                        .w_full()
                        .px(px(14.0))
                        .py(px(10.0))
                        .cursor_pointer()
                        .hover(move |s| s.bg(hover))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                            this.open_delivery_detail(id.clone(), cx);
                        }))
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(8.0))
                                .min_w_0()
                                .child(
                                    div()
                                        .px(px(6.0))
                                        .py(px(1.0))
                                        .rounded(px(9999.0))
                                        .border_1()
                                        .border_color(badge_color)
                                        .text_size(px(11.0))
                                        .text_color(badge_color)
                                        .child(label),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(fg)
                                        .child(d.method.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(muted)
                                        .truncate()
                                        .child(d.received_at.clone()),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(muted)
                                .child(format!("{} B", d.body_bytes)),
                        )
                        .into_any_element()
                })
                .collect()
        };

        col.child(settings_section(
            "Recent requests",
            rows,
            &self.tokens,
            &self.geometry,
        ))
        .into_any_element()
    }
}

impl Render for ScheduledTasksView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        match &self.sub_view {
            ActiveSubView::List => self.render_list(cx),
            ActiveSubView::Editor(editor) => self.render_editor(editor, cx),
            ActiveSubView::Deliveries(deliveries) => self.render_deliveries(deliveries, cx),
        }
    }
}
