//! Conn-styled bottom composer card, floating model picker, and `/` + `@` completion menus.
//!
//! Visual parity with real Conn (`ChatComposer.tsx`, `ComposerSurface.tsx`,
//! `ComposerControlsBar.tsx`, `ComposerPrimaryActions.tsx`, `ComposerSpeechButton.tsx`,
//! `ProviderModelPicker.tsx`, `ComposerCommandMenu.tsx`):
//! - Card: `16px` radius (`rounded-2xl`), `tokens.card` (light) / `tokens.shell_field` (dark)
//!   fill, `1px` `tokens.shell_inner_border` hairline border.
//! - Body: `px-4 pt-4 pb-2` (`16px` / `16px` / `8px`), `14px` text, `2` min lines, `8` max lines.
//! - Footer: `px-2 pb-2` (`8px` / `8px`), right-aligned controls (`gap-2` = `8px`):
//!   provider icon + model name (`28px` height), microphone button (`28px`, button only),
//!   and `32px` round send button (or destructive stop button while working).

mod menus;
mod model_picker;

use std::fmt;

use conn_client::Connection;
use conn_contract::rpc::projects::search_entries;
use conn_contract::rpc::server::get_config;
use conn_contract::{ChatAttachment, ProjectSearchEntriesInput, ServerProbePayload};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{
    Enter, Escape, InputEvent, InputState, MoveDown, MoveUp, Textarea, TextareaState,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, Render,
    SharedString, StatefulInteractiveElement as _, Styled as _, Subscription, Window, deferred,
    div, px,
};

use self::menus::{
    ComposerTrigger, ComposerTriggerKind, FileMentionEntry, detect_trigger, filter_slash_commands,
    render_command_menu, replace_trigger,
};
use self::model_picker::{ModelCatalog, ModelPickerView, render_model_picker};
use super::color::{hsla, hsla_alpha};
use super::icons;
use crate::panels::chrome::ConnTooltipExt as _;

pub(super) const COMPOSER_PLACEHOLDER: &str = "Ask anything. @ files, $ skills, / commands";
pub(super) const COMPOSER_MIN_LINES: usize = 2;
pub(super) const COMPOSER_MAX_LINES: usize = 8;

/// Composer card corner radius matching Conn's `rounded-2xl` (`16px`).
const COMPOSER_RADIUS_PX: f32 = 16.0;
/// Footer control height matching `ComposerControl` `size="sm"` (`h-7` = `28px`).
const FOOTER_CONTROL_HEIGHT_PX: f32 = 28.0;
/// Primary send/stop button size matching `sm:h-8 sm:w-8` (`32px`).
const PRIMARY_ACTION_SIZE_PX: f32 = 32.0;
/// Maximum width of the model name label in the trigger (`max-w-56` = `224px`).
const MODEL_LABEL_MAX_WIDTH_PX: f32 = 224.0;
/// Maximum file mention results requested from `projects.searchEntries`.
const FILE_SEARCH_LIMIT: i64 = 25;

/// Superheroicons 16/solid path for the microphone button (`Mic` -> `microphone`).
const ICON_MICROPHONE: &str = "superhero/microphone.svg";
/// Superheroicons 16/solid path for the attach-files button (`Paperclip` -> `attach`).
const ICON_ATTACH: &str = "superhero/attach.svg";

/// State of one staged file/image attachment in the composer strip.
#[derive(Clone, Debug)]
struct PendingAttachment {
    local_id: u64,
    name: String,
    size_bytes: usize,
    status: AttachmentUploadStatus,
}

#[derive(Clone, Debug)]
enum AttachmentUploadStatus {
    Uploading,
    Ready(ChatAttachment),
    Error(String),
}

/// Events emitted by [`Composer`] to its host view (`ChatView` -> `ConnApp`).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ComposerEvent {
    Send {
        text: String,
        attachments: Vec<ChatAttachment>,
    },
    Stop,
    ModelSelected {
        instance_id: String,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
    },
    RuntimeModeSelected(String),
    InteractionModeSelected(String),
    SlashCommand(String),
}

/// Stateful GPUI entity for the Conn composer, model picker, `/` command menu, and `@` mentions.
pub(crate) struct Composer {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_branch: Option<String>,
    worktree_active: bool,
    runtime_mode: String,
    interaction_mode: String,
    runtime_menu_open: bool,
    working: bool,
    textarea: Entity<TextareaState>,
    model_search_input: Entity<InputState>,
    catalog: ModelCatalog,
    catalog_loading: bool,
    catalog_error: Option<String>,
    selected_instance_id: Option<String>,
    selected_driver: Option<String>,
    selected_model: String,
    selected_options: Option<serde_json::Map<String, serde_json::Value>>,
    model_picker_open: bool,
    effort_menu_open: bool,
    picker_provider_filter: Option<String>,
    picker_highlighted_index: usize,
    active_trigger: Option<ComposerTrigger>,
    dismissed_trigger_text: Option<String>,
    menu_highlighted_index: usize,
    file_mentions: Vec<FileMentionEntry>,
    file_mentions_loading: bool,
    file_search_generation: u64,
    attachments: Vec<PendingAttachment>,
    next_attachment_id: u64,
    _subscriptions: Vec<Subscription>,
}

impl fmt::Debug for Composer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Composer")
            .field("working", &self.working)
            .field("selected_instance_id", &self.selected_instance_id)
            .field("selected_model", &self.selected_model)
            .field("model_picker_open", &self.model_picker_open)
            .field("active_trigger", &self.active_trigger)
            .field("providers", &self.catalog.providers.len())
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ComposerEvent> for Composer {}

#[expect(
    dead_code,
    reason = "public composer API wired into ChatView in chat/mod.rs by orchestrator"
)]
impl Composer {
    /// Creates a new [`Composer`] entity styled with `tokens`.
    ///
    /// When `connection` is present, immediately fetches the provider/model catalog
    /// via `server.getConfig`.
    pub(crate) fn new(
        tokens: Tokens,
        connection: Option<Connection>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let textarea = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(COMPOSER_PLACEHOLDER)
                .auto_grow(COMPOSER_MIN_LINES, COMPOSER_MAX_LINES)
                .submit_on_enter(true)
        });
        let model_search_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search models..."));

        let textarea_sub = cx.subscribe_in(
            &textarea,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift: false, .. } => {
                    if this.active_trigger.is_some() {
                        this.confirm_active_menu(window, cx);
                    } else {
                        this.submit(window, cx);
                    }
                }
                InputEvent::Change => {
                    this.on_draft_changed(cx);
                }
                _ => {}
            },
        );

        let search_sub =
            cx.subscribe(
                &model_search_input,
                |this, _, event: &InputEvent, cx| match event {
                    InputEvent::Change => {
                        this.picker_highlighted_index = 0;
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => {
                        this.confirm_highlighted_model(cx);
                    }
                    _ => {}
                },
            );

        let mut composer = Self {
            tokens,
            connection,
            workspace_root: None,
            thread_branch: None,
            worktree_active: false,
            runtime_mode: "full-access".to_owned(),
            interaction_mode: "default".to_owned(),
            runtime_menu_open: false,
            working: false,
            textarea,
            model_search_input,
            catalog: ModelCatalog::default(),
            catalog_loading: false,
            catalog_error: None,
            selected_instance_id: None,
            selected_driver: None,
            selected_model: "Default model".to_owned(),
            selected_options: None,
            model_picker_open: false,
            effort_menu_open: false,
            picker_provider_filter: None,
            picker_highlighted_index: 0,
            active_trigger: None,
            dismissed_trigger_text: None,
            menu_highlighted_index: 0,
            file_mentions: Vec::new(),
            file_mentions_loading: false,
            file_search_generation: 0,
            attachments: Vec::new(),
            next_attachment_id: 1,
            _subscriptions: vec![textarea_sub, search_sub],
        };
        if composer.connection.is_some() {
            composer.refresh_providers(cx);
        }
        composer
    }

    /// Replaces active theme tokens.
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        if self.tokens == tokens {
            return;
        }
        self.tokens = tokens;
        cx.notify();
    }

    /// Updates the server connection and fetches the provider catalog via `server.getConfig`.
    pub(crate) fn set_connection(
        &mut self,
        connection: Option<Connection>,
        cx: &mut Context<'_, Self>,
    ) {
        self.connection = connection;
        if self.connection.is_some() {
            self.refresh_providers(cx);
        }
    }

    /// Sets the workspace root used for `@` file mention searches (`projects.searchEntries`).
    pub(crate) fn set_workspace_root(&mut self, root: Option<String>, cx: &mut Context<'_, Self>) {
        if self.workspace_root == root {
            return;
        }
        self.workspace_root = root;
        self.file_mentions.clear();
        cx.notify();
    }

    /// Updates the branch, worktree flag, runtime mode, and interaction mode displayed in the
    /// bottom `BranchToolbar` context strip.
    pub(crate) fn set_thread_context(
        &mut self,
        branch: Option<String>,
        worktree_active: bool,
        runtime_mode: String,
        interaction_mode: String,
        cx: &mut Context<'_, Self>,
    ) {
        if self.thread_branch == branch
            && self.worktree_active == worktree_active
            && self.runtime_mode == runtime_mode
            && self.interaction_mode == interaction_mode
        {
            return;
        }
        self.thread_branch = branch;
        self.worktree_active = worktree_active;
        self.runtime_mode = runtime_mode;
        self.interaction_mode = interaction_mode;
        cx.notify();
    }

    /// Updates whether the active thread is running (switches send button to stop).
    pub(crate) fn set_working(&mut self, working: bool, cx: &mut Context<'_, Self>) {
        if self.working == working {
            return;
        }
        self.working = working;
        cx.notify();
    }

    /// Updates the active provider/model and options displayed in the composer footer.
    pub(crate) fn set_model_selection(
        &mut self,
        instance_id: Option<String>,
        driver: Option<String>,
        model: String,
        options: Option<serde_json::Map<String, serde_json::Value>>,
        cx: &mut Context<'_, Self>,
    ) {
        let changed = self.selected_instance_id != instance_id
            || self.selected_driver != driver
            || self.selected_model != model
            || self.selected_options != options;
        if !changed {
            return;
        }
        self.selected_instance_id = instance_id;
        self.selected_driver = driver;
        self.selected_model = model;
        self.selected_options = options;
        cx.notify();
    }

    /// Sets only the model display label (compatibility with `ChatView::set_model_label`).
    pub(crate) fn set_model_label(&mut self, label: String, cx: &mut Context<'_, Self>) {
        if self.selected_model == label {
            return;
        }
        if self.selected_driver.is_none() {
            self.selected_driver = infer_driver_from_model_label(&label).map(str::to_owned);
        }
        self.selected_model = label;
        cx.notify();
    }

    /// Fetches the provider/model list via `server.getConfig`.
    pub(crate) fn refresh_providers(&mut self, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        self.catalog_loading = true;
        self.catalog_error = None;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let res = conn
                .call::<get_config::Payload, get_config::Success>(
                    "server.getConfig",
                    &ServerProbePayload {},
                )
                .await;
            let _ = this.update(cx, |composer, cx| {
                composer.catalog_loading = false;
                match res {
                    Ok(config) => {
                        composer.catalog = ModelCatalog::from_server_config(&config);
                        composer.catalog_error = None;
                    }
                    Err(err) => {
                        composer.catalog_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Toggles the floating model picker popup.
    pub(crate) fn toggle_model_picker(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.model_picker_open = !self.model_picker_open;
        if self.model_picker_open {
            self.active_trigger = None;
            self.picker_provider_filter = self.selected_instance_id.clone();
            self.picker_highlighted_index = 0;
            self.model_search_input.update(cx, |input, cx| {
                input.set_value("", window, cx);
                input.focus(window, cx);
            });
            if self.catalog.providers.is_empty() && !self.catalog_loading {
                self.refresh_providers(cx);
            }
        }
        cx.notify();
    }

    /// Closes any open popup (model picker, `/` command menu, or `@` file menu).
    pub(crate) fn close_overlays(&mut self, cx: &mut Context<'_, Self>) {
        let mut changed = false;
        if self.model_picker_open {
            self.model_picker_open = false;
            changed = true;
        }
        if self.effort_menu_open {
            self.effort_menu_open = false;
            changed = true;
        }
        if self.runtime_menu_open {
            self.runtime_menu_open = false;
            changed = true;
        }
        if self.active_trigger.take().is_some() {
            let text = self.textarea.read(cx).value().to_string();
            self.dismissed_trigger_text = Some(text);
            changed = true;
        }
        if changed {
            cx.notify();
        }
    }

    /// Opens the native file picker to attach one or more files or images to the draft.
    pub(crate) fn pick_attachments(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = prompt.await else {
                return;
            };
            for path in paths {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("attachment")
                    .to_owned();
                let mime_type = infer_mime_type(&path).to_owned();
                let bytes = match std::fs::read(&path) {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        let _ = this.update(cx, |composer, cx| {
                            let local_id = composer.next_attachment_id;
                            composer.next_attachment_id =
                                composer.next_attachment_id.wrapping_add(1);
                            composer.attachments.push(PendingAttachment {
                                local_id,
                                name: name.clone(),
                                size_bytes: 0,
                                status: AttachmentUploadStatus::Error(err.to_string()),
                            });
                            cx.notify();
                        });
                        continue;
                    }
                };
                let size_bytes = bytes.len();
                let local_id = this
                    .update(cx, |composer, cx| {
                        let id = composer.next_attachment_id;
                        composer.next_attachment_id = composer.next_attachment_id.wrapping_add(1);
                        composer.attachments.push(PendingAttachment {
                            local_id: id,
                            name: name.clone(),
                            size_bytes,
                            status: AttachmentUploadStatus::Uploading,
                        });
                        cx.notify();
                        id
                    })
                    .ok();
                let Some(local_id) = local_id else {
                    break;
                };
                let upload_res = conn.upload_chat_attachment(name, mime_type, bytes).await;
                let _ = this.update(cx, |composer, cx| {
                    if let Some(slot) = composer
                        .attachments
                        .iter_mut()
                        .find(|a| a.local_id == local_id)
                    {
                        slot.status = match upload_res {
                            Ok(att) => AttachmentUploadStatus::Ready(att),
                            Err(err) => AttachmentUploadStatus::Error(err.to_string()),
                        };
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }

    fn remove_attachment(&mut self, local_id: u64, cx: &mut Context<'_, Self>) {
        let before = self.attachments.len();
        self.attachments.retain(|a| a.local_id != local_id);
        if self.attachments.len() != before {
            cx.notify();
        }
    }

    /// Submits the current non-empty draft (and any uploaded attachments) via [`ComposerEvent::Send`].
    pub(crate) fn submit(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let raw = self.textarea.read(cx).value().to_string();
        let trimmed = raw.trim().to_owned();
        let still_uploading = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Uploading));
        if still_uploading {
            return;
        }
        let ready_attachments: Vec<ChatAttachment> = self
            .attachments
            .iter()
            .filter_map(|a| match &a.status {
                AttachmentUploadStatus::Ready(att) => Some(att.clone()),
                _ => None,
            })
            .collect();
        if trimmed.is_empty() && ready_attachments.is_empty() {
            return;
        }
        self.textarea.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.attachments.clear();
        self.active_trigger = None;
        self.dismissed_trigger_text = None;
        self.model_picker_open = false;
        cx.emit(ComposerEvent::Send {
            text: trimmed,
            attachments: ready_attachments,
        });
        cx.notify();
    }

    pub(super) fn select_picker_provider(
        &mut self,
        instance_id: String,
        cx: &mut Context<'_, Self>,
    ) {
        self.picker_provider_filter = Some(instance_id);
        self.picker_highlighted_index = 0;
        cx.notify();
    }

    pub(super) fn pick_model(
        &mut self,
        instance_id: String,
        model: String,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(opt) = self.catalog.find_model(Some(&instance_id), &model) {
            self.selected_driver = Some(opt.driver.clone());
        }
        self.selected_instance_id = Some(instance_id.clone());
        self.selected_model = model.clone();
        self.selected_options = None;
        self.model_picker_open = false;
        self.effort_menu_open = false;
        cx.emit(ComposerEvent::ModelSelected {
            instance_id,
            model,
            options: None,
        });
        cx.notify();
    }

    fn pick_effort(&mut self, option_id: String, value: String, cx: &mut Context<'_, Self>) {
        let Some(opt) = self
            .catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
        else {
            return;
        };
        let instance_id = opt.instance_id.clone();
        let model = opt.slug.clone();
        let mut opts = self.selected_options.clone().unwrap_or_default();
        opts.insert(option_id, serde_json::Value::String(value));
        self.selected_options = Some(opts.clone());
        self.effort_menu_open = false;
        cx.emit(ComposerEvent::ModelSelected {
            instance_id,
            model,
            options: Some(opts),
        });
        cx.notify();
    }

    pub(super) fn apply_slash_command(
        &mut self,
        command: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(trigger) = self.active_trigger.take() {
            let current = self.textarea.read(cx).value().to_string();
            let replacement = if command == "model" {
                String::new()
            } else {
                format!("/{command} ")
            };
            let next = replace_trigger(&current, &trigger, &replacement);
            self.textarea.update(cx, |input, cx| {
                input.set_value(next, window, cx);
            });
        }
        self.dismissed_trigger_text = None;
        if command == "model" {
            self.toggle_model_picker(window, cx);
            return;
        }
        cx.emit(ComposerEvent::SlashCommand(command.to_owned()));
        cx.notify();
    }

    pub(super) fn apply_file_mention(
        &mut self,
        path: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if let Some(trigger) = self.active_trigger.take() {
            let current = self.textarea.read(cx).value().to_string();
            let next = replace_trigger(&current, &trigger, &format!("@{path} "));
            self.textarea.update(cx, |input, cx| {
                input.set_value(next, window, cx);
            });
        }
        self.dismissed_trigger_text = None;
        cx.notify();
    }

    fn on_draft_changed(&mut self, cx: &mut Context<'_, Self>) {
        let text = self.textarea.read(cx).value().to_string();
        if self.dismissed_trigger_text.as_deref() == Some(text.as_str()) {
            cx.notify();
            return;
        }
        self.dismissed_trigger_text = None;

        let next_trigger = detect_trigger(&text);
        let query_changed = next_trigger != self.active_trigger;
        self.active_trigger = next_trigger.clone();

        if query_changed {
            self.menu_highlighted_index = 0;
            if let Some(trigger) = next_trigger {
                self.model_picker_open = false;
                if trigger.kind == ComposerTriggerKind::FileMention {
                    self.search_files(trigger.query, cx);
                }
            }
        }
        cx.notify();
    }

    fn search_files(&mut self, query: String, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(cwd)) = (self.connection.clone(), self.workspace_root.clone()) else {
            self.file_mentions.clear();
            self.file_mentions_loading = false;
            return;
        };
        self.file_search_generation = self.file_search_generation.wrapping_add(1);
        let generation = self.file_search_generation;
        self.file_mentions_loading = true;
        cx.notify();

        cx.spawn(async move |this, cx| {
            let payload = ProjectSearchEntriesInput {
                cwd,
                query,
                limit: FILE_SEARCH_LIMIT,
                kind: None,
                image_only: None,
            };
            let res = conn
                .call::<search_entries::Payload, search_entries::Success>(
                    "projects.searchEntries",
                    &payload,
                )
                .await;
            let _ = this.update(cx, |composer, cx| {
                if composer.file_search_generation != generation {
                    return;
                }
                composer.file_mentions_loading = false;
                match res {
                    Ok(result) => {
                        composer.file_mentions = result
                            .entries
                            .into_iter()
                            .map(FileMentionEntry::from_contract)
                            .collect();
                    }
                    Err(_) => {
                        composer.file_mentions.clear();
                    }
                }
                composer.menu_highlighted_index = 0;
                cx.notify();
            });
        })
        .detach();
    }

    fn move_overlay_selection(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        if self.model_picker_open {
            let query = self.model_search_input.read(cx).value().to_string();
            let effective = self
                .picker_provider_filter
                .as_deref()
                .or(self.selected_instance_id.as_deref())
                .or_else(|| {
                    self.catalog
                        .providers
                        .first()
                        .map(|p| p.instance_id.as_str())
                });
            let count = self.catalog.filtered_models(effective, &query).len();
            if count > 0 {
                self.picker_highlighted_index =
                    step_index(self.picker_highlighted_index, delta, count);
                cx.notify();
            }
            return;
        }

        if let Some(trigger) = &self.active_trigger {
            let count = match trigger.kind {
                ComposerTriggerKind::Command => filter_slash_commands(&trigger.query).len(),
                ComposerTriggerKind::FileMention => self.file_mentions.len(),
            };
            if count > 0 {
                self.menu_highlighted_index = step_index(self.menu_highlighted_index, delta, count);
                cx.notify();
            }
        }
    }

    fn confirm_highlighted_model(&mut self, cx: &mut Context<'_, Self>) {
        if !self.model_picker_open {
            return;
        }
        let query = self.model_search_input.read(cx).value().to_string();
        let effective = self
            .picker_provider_filter
            .as_deref()
            .or(self.selected_instance_id.as_deref())
            .or_else(|| {
                self.catalog
                    .providers
                    .first()
                    .map(|p| p.instance_id.as_str())
            });
        let picked = self
            .catalog
            .filtered_models(effective, &query)
            .get(self.picker_highlighted_index)
            .map(|m| (m.instance_id.clone(), m.slug.clone()));
        if let Some((instance_id, slug)) = picked {
            self.pick_model(instance_id, slug, cx);
        }
    }

    fn confirm_active_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let Some(trigger) = self.active_trigger.clone() else {
            return;
        };
        match trigger.kind {
            ComposerTriggerKind::Command => {
                let commands = filter_slash_commands(&trigger.query);
                if let Some(cmd) = commands.get(self.menu_highlighted_index) {
                    self.apply_slash_command(cmd.name, window, cx);
                }
            }
            ComposerTriggerKind::FileMention => {
                if let Some(entry) = self.file_mentions.get(self.menu_highlighted_index) {
                    let path = entry.path.clone();
                    self.apply_file_mention(&path, window, cx);
                }
            }
        }
    }

    fn display_model_and_driver(&self) -> (String, Option<&str>) {
        if let Some(opt) = self
            .catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
        {
            return (opt.trigger_label().to_owned(), Some(opt.driver.as_str()));
        }
        (self.selected_model.clone(), self.selected_driver.as_deref())
    }

    /// Renders Conn's `BranchToolbar` / `ComposerSurface.ContextStrip` under the composer card:
    /// worktree/local indicator + branch name on the left; Plan mode toggle + runtime permission
    /// selector on the right.
    fn render_context_strip(&self, tokens: &Tokens, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let hover_bg = hsla(tokens.shell_highlight);
        let plan_active = self.interaction_mode == "plan";

        let mut left = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_w_0()
            .flex_1()
            .overflow_hidden();

        let env_icon = if self.worktree_active {
            "superhero/folder-git.svg"
        } else {
            "superhero/folder.svg"
        };
        let env_label = if self.worktree_active {
            "Worktree"
        } else {
            "Local"
        };
        left = left.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .flex_shrink_0()
                .child(icons::icon(env_icon, 12.0, muted))
                .child(env_label),
        );

        if let Some(branch) = self.thread_branch.as_deref().filter(|b| !b.is_empty()) {
            left = left.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .min_w_0()
                    .child(icons::icon("superhero/branch.svg", 12.0, muted))
                    .child(div().min_w_0().truncate().child(branch.to_owned())),
            );
        }

        let plan_btn = div()
            .id("composer-plan-mode-toggle")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(22.0))
            .px(px(6.0))
            .rounded(px(6.0))
            .cursor_pointer()
            .text_color(if plan_active { fg } else { muted })
            .when(plan_active, |el| el.bg(hover_bg))
            .hover(move |s| s.bg(hover_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, _, cx| {
                let next = if composer.interaction_mode == "plan" {
                    "default"
                } else {
                    "plan"
                };
                composer.interaction_mode = next.to_owned();
                cx.emit(ComposerEvent::InteractionModeSelected(next.to_owned()));
                cx.notify();
            }))
            .conn_tooltip("Toggle Plan mode", tokens)
            .child(icons::icon(
                "superhero/checklist.svg",
                12.0,
                if plan_active { fg } else { muted },
            ))
            .child("Plan");

        let mut runtime_slot = div().relative().child(
            div()
                .id("composer-runtime-mode-trigger")
                .flex()
                .flex_row()
                .items_center()
                .gap(px(4.0))
                .h(px(22.0))
                .px(px(6.0))
                .rounded(px(6.0))
                .cursor_pointer()
                .text_color(if self.runtime_menu_open { fg } else { muted })
                .when(self.runtime_menu_open, |el| el.bg(hover_bg))
                .hover(move |s| s.bg(hover_bg).text_color(fg))
                .on_click(cx.listener(|composer, _, _, cx| {
                    composer.runtime_menu_open = !composer.runtime_menu_open;
                    if composer.runtime_menu_open {
                        composer.model_picker_open = false;
                    }
                    cx.notify();
                }))
                .conn_tooltip("Runtime permissions", tokens)
                .child(icons::icon("superhero/shield.svg", 12.0, muted))
                .child(runtime_mode_label(&self.runtime_mode))
                .child(icons::icon("superhero/chevron-down.svg", 11.0, muted)),
        );

        if self.runtime_menu_open {
            let pop_fg = hsla(tokens.popover_foreground);
            let mut menu = div()
                .id("composer-runtime-mode-menu")
                .absolute()
                .bottom_full()
                .right_0()
                .mb(px(4.0))
                .w(px(176.0))
                .rounded(px(8.0))
                .bg(hsla(tokens.popover))
                .border_1()
                .border_color(hsla(tokens.shell_inner_border))
                .shadow_md()
                .p(px(4.0))
                .flex()
                .flex_col()
                .gap(px(2.0));
            for &(mode, label) in RUNTIME_MODES {
                let active = self.runtime_mode == mode;
                menu = menu.child(
                    div()
                        .id(SharedString::from(format!("composer-rm-{mode}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .h(px(26.0))
                        .px(px(8.0))
                        .rounded(px(5.0))
                        .cursor_pointer()
                        .text_size(px(12.0))
                        .line_height(px(16.0))
                        .text_color(if active { pop_fg } else { muted })
                        .hover(move |s| s.bg(hover_bg).text_color(pop_fg))
                        .on_click(cx.listener(move |composer, _, _, cx| {
                            composer.runtime_menu_open = false;
                            if composer.runtime_mode != mode {
                                composer.runtime_mode = mode.to_owned();
                                cx.emit(ComposerEvent::RuntimeModeSelected(mode.to_owned()));
                            }
                            cx.notify();
                        }))
                        .child(div().flex_1().child(label))
                        .when(active, |el| {
                            el.child(icons::icon("superhero/check.svg", 12.0, pop_fg))
                        }),
                );
            }
            runtime_slot = runtime_slot.child(deferred(menu).with_priority(3));
        }

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.0))
            .w_full()
            .pt(px(6.0))
            .px(px(6.0))
            .text_size(px(12.0))
            .line_height(px(16.0))
            .text_color(muted)
            .child(left)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .flex_shrink_0()
                    .child(plan_btn)
                    .child(runtime_slot),
            )
            .into_any_element()
    }
}

const RUNTIME_MODES: &[(&str, &str)] = &[
    ("full-access", "Full access"),
    ("auto", "Auto"),
    ("auto-accept-edits", "Accept edits"),
    ("approval-required", "Supervised"),
];

fn runtime_mode_label(mode: &str) -> &'static str {
    RUNTIME_MODES
        .iter()
        .find(|&&(id, _)| id == mode)
        .map_or("Full access", |&(_, label)| label)
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let has_ready_attachments = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Ready(_)));
        let is_uploading = self
            .attachments
            .iter()
            .any(|a| matches!(a.status, AttachmentUploadStatus::Uploading));
        let has_sendable = (!self.textarea.read(cx).value().trim().is_empty()
            || has_ready_attachments)
            && !is_uploading;
        let (model_label, driver) = self.display_model_and_driver();
        let tokens = self.tokens.clone();

        let (card_bg, card_border) = composer_surface_colors(&tokens);
        let highlight_bg = hsla(tokens.shell_highlight);
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);

        let model_trigger = div()
            .id("chat-composer-model-picker")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .h(px(FOOTER_CONTROL_HEIGHT_PX))
            .px(px(8.0))
            .rounded(px(8.0))
            .cursor_pointer()
            .text_size(px(14.0))
            .line_height(px(20.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if self.model_picker_open {
                fg
            } else {
                hsla_alpha(tokens.foreground, 0.80)
            })
            .when(self.model_picker_open, |s| s.bg(highlight_bg))
            .hover(move |s| s.bg(highlight_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, window, cx| {
                composer.toggle_model_picker(window, cx);
            }))
            .child(crate::icons::provider_mark(
                driver
                    .filter(|d| !d.is_empty())
                    .unwrap_or(model_label.as_str()),
                16.0,
                if self.model_picker_open { fg } else { muted },
            ))
            .child(
                div()
                    .max_w(px(MODEL_LABEL_MAX_WIDTH_PX))
                    .truncate()
                    .child(model_label),
            );

        let effort_picker: Option<AnyElement> = self
            .catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
            .and_then(|m| m.reasoning.as_ref())
            .map(|reasoning| {
                let current_id = self
                    .selected_options
                    .as_ref()
                    .and_then(|opts| opts.get(&reasoning.option_id))
                    .and_then(serde_json::Value::as_str)
                    .or(reasoning.default_value.as_deref())
                    .unwrap_or_default();
                let current_label = reasoning
                    .choices
                    .iter()
                    .find(|(id, _)| id == current_id)
                    .map_or("Effort", |(_, label)| label.as_str());
                let mut slot = div().relative().child(
                    div()
                        .id("chat-composer-effort-picker")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.0))
                        .h(px(FOOTER_CONTROL_HEIGHT_PX))
                        .px(px(8.0))
                        .rounded(px(8.0))
                        .cursor_pointer()
                        .text_size(px(13.0))
                        .line_height(px(20.0))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(if self.effort_menu_open { fg } else { muted })
                        .when(self.effort_menu_open, |s| s.bg(highlight_bg))
                        .hover(move |s| s.bg(highlight_bg).text_color(fg))
                        .on_click(cx.listener(|composer, _, _, cx| {
                            composer.effort_menu_open = !composer.effort_menu_open;
                            if composer.effort_menu_open {
                                composer.model_picker_open = false;
                                composer.runtime_menu_open = false;
                            }
                            cx.notify();
                        }))
                        .conn_tooltip(reasoning.label.clone(), &tokens)
                        .child(icons::icon(
                            "superhero/thinking.svg",
                            13.0,
                            if self.effort_menu_open { fg } else { muted },
                        ))
                        .child(current_label.to_owned()),
                );
                if self.effort_menu_open {
                    let pop_fg = hsla(tokens.popover_foreground);
                    let mut menu = div()
                        .id("chat-composer-effort-menu")
                        .absolute()
                        .bottom_full()
                        .right_0()
                        .mb(px(4.0))
                        .w(px(164.0))
                        .rounded(px(8.0))
                        .bg(hsla(tokens.popover))
                        .border_1()
                        .border_color(hsla(tokens.shell_inner_border))
                        .shadow_md()
                        .p(px(4.0))
                        .flex()
                        .flex_col()
                        .gap(px(2.0));
                    for (choice_id, choice_label) in &reasoning.choices {
                        let active = choice_id == current_id;
                        let opt_id = reasoning.option_id.clone();
                        let val = choice_id.clone();
                        menu = menu.child(
                            div()
                                .id(SharedString::from(format!("composer-effort-{choice_id}")))
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(6.0))
                                .h(px(26.0))
                                .px(px(8.0))
                                .rounded(px(5.0))
                                .cursor_pointer()
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .text_color(if active { pop_fg } else { muted })
                                .hover(move |s| s.bg(highlight_bg).text_color(pop_fg))
                                .on_click(cx.listener(move |composer, _, _, cx| {
                                    composer.pick_effort(opt_id.clone(), val.clone(), cx);
                                }))
                                .child(div().flex_1().child(choice_label.clone()))
                                .when(active, |el| {
                                    el.child(icons::icon("superhero/check.svg", 12.0, pop_fg))
                                }),
                        );
                    }
                    slot = slot.child(deferred(menu).with_priority(3));
                }
                slot.into_any_element()
            });

        let attach_btn = div()
            .id("chat-composer-attach")
            .flex()
            .items_center()
            .justify_center()
            .size(px(FOOTER_CONTROL_HEIGHT_PX))
            .rounded_full()
            .cursor_pointer()
            .hover(move |s| s.bg(highlight_bg).text_color(fg))
            .on_click(cx.listener(|composer, _, window, cx| {
                composer.pick_attachments(window, cx);
            }))
            .conn_tooltip("Attach files", &tokens)
            .child(icons::icon(ICON_ATTACH, 16.0, muted));

        let mic_btn = render_microphone_button(&tokens);

        let action_btn = render_primary_action_button(
            self.working,
            has_sendable,
            &tokens,
            cx.listener(|_composer, _, _, cx| {
                cx.emit(ComposerEvent::Stop);
            }),
            cx.listener(|composer, _, window, cx| {
                composer.submit(window, cx);
            }),
        );

        let mut card = div()
            .w_full()
            .rounded(px(COMPOSER_RADIUS_PX))
            .bg(card_bg)
            .border_1()
            .border_color(card_border)
            .overflow_hidden();

        if !self.attachments.is_empty() {
            let mut strip = div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(6.0))
                .px(px(14.0))
                .pt(px(12.0));
            for att in &self.attachments {
                let local_id = att.local_id;
                let file_icon = crate::file_icons::file_icon(&att.name);
                let icon_color = file_icon
                    .color
                    .map(|c| hsla(c.for_appearance(tokens.appearance)))
                    .unwrap_or(muted);
                let status_label = match &att.status {
                    AttachmentUploadStatus::Uploading => "Uploading…".to_owned(),
                    AttachmentUploadStatus::Ready(_) => format_byte_size(att.size_bytes),
                    AttachmentUploadStatus::Error(err) => err.clone(),
                };
                let is_err = matches!(att.status, AttachmentUploadStatus::Error(_));
                strip = strip.child(
                    div()
                        .id(SharedString::from(format!("composer-att-{local_id}")))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.0))
                        .h(px(28.0))
                        .max_w(px(220.0))
                        .px(px(8.0))
                        .rounded(px(8.0))
                        .bg(hsla(tokens.shell_control))
                        .border_1()
                        .border_color(if is_err {
                            hsla(tokens.destructive)
                        } else {
                            hsla(tokens.shell_inner_border)
                        })
                        .child(icons::icon(file_icon.asset, 14.0, icon_color))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.0))
                                .line_height(px(16.0))
                                .text_color(fg)
                                .child(att.name.clone()),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(11.0))
                                .line_height(px(16.0))
                                .text_color(if is_err {
                                    hsla(tokens.destructive)
                                } else {
                                    muted
                                })
                                .child(status_label),
                        )
                        .child(
                            div()
                                .id(SharedString::from(format!("composer-att-rm-{local_id}")))
                                .flex()
                                .items_center()
                                .justify_center()
                                .size(px(16.0))
                                .flex_shrink_0()
                                .rounded(px(4.0))
                                .cursor_pointer()
                                .hover(move |s| s.bg(highlight_bg))
                                .on_click(cx.listener(move |composer, _, _, cx| {
                                    composer.remove_attachment(local_id, cx);
                                }))
                                .child(icons::icon("superhero/close.svg", 11.0, muted)),
                        ),
                );
            }
            card = card.child(strip);
        }

        card = card
            .child(
                div().px(px(16.0)).pt(px(16.0)).pb(px(8.0)).child(
                    Textarea::new(&self.textarea)
                        .appearance(false)
                        .bordered(false)
                        .text_size(px(14.0))
                        .line_height(px(22.0))
                        .text_color(fg),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .px(px(8.0))
                    .pb(px(8.0))
                    .child(attach_btn)
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(6.0))
                            .child(model_trigger)
                            .when_some(effort_picker, |el, picker| el.child(picker))
                            .child(mic_btn)
                            .child(action_btn),
                    ),
            );

        let mut root = div()
            .id("chat-composer-root")
            .relative()
            .w_full()
            .capture_action(cx.listener(|composer, _: &Escape, _window, cx| {
                if composer.model_picker_open
                    || composer.effort_menu_open
                    || composer.runtime_menu_open
                    || composer.active_trigger.is_some()
                {
                    composer.close_overlays(cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &MoveUp, _window, cx| {
                if composer.model_picker_open || composer.active_trigger.is_some() {
                    composer.move_overlay_selection(-1, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &MoveDown, _window, cx| {
                if composer.model_picker_open || composer.active_trigger.is_some() {
                    composer.move_overlay_selection(1, cx);
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &Enter, window, cx| {
                if composer.model_picker_open {
                    composer.confirm_highlighted_model(cx);
                    cx.stop_propagation();
                } else if composer.active_trigger.is_some() {
                    composer.confirm_active_menu(window, cx);
                    cx.stop_propagation();
                }
            }))
            .child(card)
            .child(self.render_context_strip(&tokens, cx));

        if let Some(trigger) = self.active_trigger.clone() {
            let menu = render_command_menu(
                &trigger,
                &self.file_mentions,
                self.file_mentions_loading,
                self.menu_highlighted_index,
                &tokens,
                cx,
            );
            root = root.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .right_0()
                        .mb(px(6.0))
                        .child(menu),
                )
                .with_priority(2),
            );
        } else if self.model_picker_open {
            let query = self.model_search_input.read(cx).value().to_string();
            let popup = render_model_picker(
                &ModelPickerView {
                    catalog: &self.catalog,
                    loading: self.catalog_loading,
                    error: self.catalog_error.as_deref(),
                    active_instance_id: self.selected_instance_id.as_deref(),
                    active_model: &self.selected_model,
                    selected_provider: self.picker_provider_filter.as_deref(),
                    search_input: &self.model_search_input,
                    query: &query,
                    highlighted_index: self.picker_highlighted_index,
                    tokens: &tokens,
                },
                cx,
            );
            root = root.child(
                deferred(
                    div()
                        .absolute()
                        .bottom_full()
                        .right_0()
                        .mb(px(6.0))
                        .child(popup),
                )
                .with_priority(2),
            );
        }

        root
    }
}

/// Composer card surface fill and border from `conn_theme::Tokens`.
///
/// Mirrors Conn's `--shell-composer` (`var(--card)` in light, lifted surface in dark)
/// and `--chat-composer-outline` (`8%` black/white hairline via `shell_inner_border`).
fn composer_surface_colors(tokens: &Tokens) -> (gpui_kit::Hsla, gpui_kit::Hsla) {
    let bg = match tokens.appearance {
        Appearance::Light => hsla(tokens.card),
        Appearance::Dark => hsla(tokens.shell_field),
    };
    (bg, hsla(tokens.shell_inner_border))
}

/// Microphone button styled like Conn's `ComposerSpeechButton` (`icon-sm` ghost, button only).
fn render_microphone_button(tokens: &Tokens) -> AnyElement {
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);

    div()
        .id("chat-composer-mic")
        .flex()
        .items_center()
        .justify_center()
        .size(px(FOOTER_CONTROL_HEIGHT_PX))
        .rounded_full()
        .cursor_pointer()
        .hover(move |s| s.bg(highlight_bg).text_color(fg))
        .child(icons::icon(ICON_MICROPHONE, 16.0, muted))
        .into_any_element()
}

/// Round send / stop primary button matching `ComposerPrimaryActions.tsx`.
fn render_primary_action_button<FStop, FSend>(
    working: bool,
    has_text: bool,
    tokens: &Tokens,
    on_stop: FStop,
    on_send: FSend,
) -> AnyElement
where
    FStop: Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
    FSend: Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
{
    if working {
        div()
            .id("chat-composer-stop")
            .flex()
            .items_center()
            .justify_center()
            .size(px(PRIMARY_ACTION_SIZE_PX))
            .rounded_full()
            .cursor_pointer()
            .bg(hsla_alpha(tokens.destructive, 0.90))
            .hover(|s| s.bg(hsla(tokens.destructive)))
            .on_click(on_stop)
            .child(icons::icon(
                icons::SQUARE,
                12.0,
                hsla(tokens.destructive_foreground),
            ))
            .into_any_element()
    } else if has_text {
        div()
            .id("chat-composer-send")
            .flex()
            .items_center()
            .justify_center()
            .size(px(PRIMARY_ACTION_SIZE_PX))
            .rounded_full()
            .cursor_pointer()
            .bg(hsla(tokens.primary))
            .hover(|s| s.bg(hsla_alpha(tokens.primary, 0.88)))
            .on_click(on_send)
            .child(icons::icon(
                icons::ARROW_UP,
                14.0,
                hsla(tokens.primary_foreground),
            ))
            .into_any_element()
    } else {
        // Conn: `disabled:bg-foreground/12 disabled:text-muted-foreground`.
        div()
            .id("chat-composer-send-disabled")
            .flex()
            .items_center()
            .justify_center()
            .size(px(PRIMARY_ACTION_SIZE_PX))
            .rounded_full()
            .bg(hsla_alpha(tokens.foreground, 0.12))
            .child(icons::icon(
                icons::ARROW_UP,
                14.0,
                hsla(tokens.muted_foreground),
            ))
            .into_any_element()
    }
}

fn infer_driver_from_model_label(label: &str) -> Option<&'static str> {
    let lower = label.to_ascii_lowercase();
    if lower.contains("claude")
        || lower.contains("haiku")
        || lower.contains("sonnet")
        || lower.contains("opus")
    {
        Some("claudeAgent")
    } else if lower.contains("gpt") || lower.contains("codex") || lower.contains("o3") {
        Some("codex")
    } else {
        None
    }
}

fn step_index(current: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let len_isize = isize::try_from(len).unwrap_or(isize::MAX);
    let current_isize = isize::try_from(current).unwrap_or(0);
    let next = (current_isize + delta).rem_euclid(len_isize);
    usize::try_from(next).unwrap_or(0)
}

fn infer_mime_type(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("md" | "markdown") => "text/markdown",
        Some(
            "txt" | "log" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "toml" | "yaml"
            | "yml" | "css" | "html",
        ) => "text/plain",
        _ => "application/octet-stream",
    }
}

fn format_byte_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infer_mime_and_byte_size_formatting() {
        assert_eq!(
            infer_mime_type(std::path::Path::new("shot.PNG")),
            "image/png"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("photo.jpg")),
            "image/jpeg"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("main.rs")),
            "text/plain"
        );
        assert_eq!(
            infer_mime_type(std::path::Path::new("archive.bin")),
            "application/octet-stream"
        );
        assert_eq!(format_byte_size(512), "512 B");
        assert_eq!(format_byte_size(2048), "2.0 KB");
        assert_eq!(format_byte_size(2 * 1024 * 1024), "2.0 MB");
    }

    #[test]
    fn step_index_wraps_in_both_directions() {
        assert_eq!(step_index(0, 1, 3), 1, "steps forward");
        assert_eq!(step_index(2, 1, 3), 0, "wraps past end");
        assert_eq!(step_index(0, -1, 3), 2, "wraps before start");
        assert_eq!(step_index(0, 1, 0), 0, "empty list stays at 0");
    }

    #[test]
    fn infer_driver_recognizes_common_model_names() {
        assert_eq!(
            infer_driver_from_model_label("haiku"),
            Some("claudeAgent"),
            "haiku maps to claudeAgent"
        );
        assert_eq!(
            infer_driver_from_model_label("GPT-5.4"),
            Some("codex"),
            "GPT-5.4 maps to codex"
        );
        assert_eq!(
            infer_driver_from_model_label("custom-model"),
            None,
            "unknown model returns None"
        );
    }
}
