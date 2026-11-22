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
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use conn_client::Connection;
use conn_contract::rpc::projects::search_entries;
use conn_contract::rpc::server::get_config;
use conn_contract::{ChatAttachment, ProjectSearchEntriesInput, ServerProbePayload};
use conn_desktop::operator::{DictationStart, DictationWait, OperatorClient};
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{
    Enter, Escape, InputEvent, InputState, MoveDown, MoveUp, Paste, Textarea, TextareaState,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, ClipboardEntry, Context, Entity, EventEmitter, ExternalPaths,
    FontWeight, ImageFormat, InteractiveElement as _, IntoElement, ParentElement as _,
    PathPromptOptions, Render, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, deferred, div, px,
};

use self::menus::{
    ComposerTrigger, ComposerTriggerKind, FileMentionEntry, detect_trigger, filter_slash_commands,
    render_command_menu, replace_trigger,
};
use self::model_picker::{ModelCatalog, ModelPickerView, render_model_picker};
use super::color::{hsla, hsla_alpha};
use super::icons;
use crate::a11y::ConnA11yExt as _;
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

/// Active Operator voice dictation session state in the composer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum DictationState {
    #[default]
    Idle,
    Starting {
        session_id: String,
    },
    Recording {
        session_id: String,
    },
    Transcribing {
        session_id: String,
    },
}

impl DictationState {
    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Idle => None,
            Self::Starting { session_id }
            | Self::Recording { session_id }
            | Self::Transcribing { session_id } => Some(session_id.as_str()),
        }
    }
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
    /// Toggle between Local (`false`) and Worktree (`true`) when composing a new thread draft.
    WorkspaceModeSelected(bool),
    SlashCommand(String),
}

/// Stateful GPUI entity for the Conn composer, model picker, `/` command menu, and `@` mentions.
pub(crate) struct Composer {
    tokens: Tokens,
    connection: Option<Connection>,
    workspace_root: Option<String>,
    thread_branch: Option<String>,
    worktree_active: bool,
    is_draft: bool,
    submitting: bool,
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
    dictation: DictationState,
    dictation_error: Option<String>,
    next_dictation_seq: u64,
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
            is_draft: false,
            submitting: false,
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
            dictation: DictationState::Idle,
            dictation_error: None,
            next_dictation_seq: 1,
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

    /// Marks whether the composer is currently composing a new-thread draft and whether launch is
    /// in flight.
    pub(crate) fn set_draft_mode(
        &mut self,
        is_draft: bool,
        submitting: bool,
        cx: &mut Context<'_, Self>,
    ) {
        if self.is_draft == is_draft && self.submitting == submitting {
            return;
        }
        self.is_draft = is_draft;
        self.submitting = submitting;
        cx.notify();
    }

    /// Moves keyboard focus into the composer textarea.
    pub(crate) fn focus_input(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.textarea.update(cx, |input, cx| {
            input.focus(window, cx);
        });
    }

    /// Restores or replaces the composer textarea text (e.g. if a thread launch fails).
    pub(crate) fn set_draft_text(
        &mut self,
        text: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.textarea.update(cx, |input, cx| {
            input.set_value(text, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
    }

    /// Returns the composer's resolved `(instance_id, model_slug, options)` selection,
    /// falling back to the loaded `server.getConfig` catalog default when unset.
    #[must_use]
    pub(crate) fn current_model_selection(
        &self,
    ) -> Option<(
        String,
        String,
        Option<serde_json::Map<String, serde_json::Value>>,
    )> {
        if let Some(opt) = self
            .catalog
            .find_model(self.selected_instance_id.as_deref(), &self.selected_model)
        {
            return Some((
                opt.instance_id.clone(),
                opt.slug.clone(),
                self.selected_options.clone(),
            ));
        }
        if let Some(instance_id) = self.selected_instance_id.as_deref()
            && !instance_id.trim().is_empty()
            && !self.selected_model.trim().is_empty()
            && self.selected_model != "Default model"
        {
            return Some((
                instance_id.to_owned(),
                self.selected_model.clone(),
                self.selected_options.clone(),
            ));
        }
        self.catalog
            .default_model()
            .map(|opt| (opt.instance_id.clone(), opt.slug.clone(), None))
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
                        if (composer.selected_instance_id.is_none()
                            || composer.selected_model == "Default model")
                            && let Some(default_opt) = composer.catalog.default_model().cloned()
                        {
                            composer.selected_instance_id = Some(default_opt.instance_id);
                            composer.selected_driver = Some(default_opt.driver);
                            composer.selected_model = default_opt.slug;
                        }
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
        if self.connection.is_none() {
            return;
        }
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
            let _ = this.update_in(cx, |composer, window, cx| {
                composer.attach_paths(paths, window, cx);
            });
        })
        .detach();
    }

    /// Reads local file paths (from file picker, drag-and-drop, or clipboard) and uploads each
    /// into the composer attachment strip.
    pub(crate) fn attach_paths(
        &mut self,
        paths: Vec<PathBuf>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if self.connection.is_none() || paths.is_empty() {
            return;
        }
        for path in paths {
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("attachment")
                .to_owned();
            let mime_type = infer_mime_type(&path).to_owned();
            match std::fs::read(&path) {
                Ok(bytes) => {
                    self.stage_and_upload_bytes(name, mime_type, bytes, window, cx);
                }
                Err(err) => {
                    let local_id = self.next_attachment_id;
                    self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
                    self.attachments.push(PendingAttachment {
                        local_id,
                        name,
                        size_bytes: 0,
                        status: AttachmentUploadStatus::Error(err.to_string()),
                    });
                    cx.notify();
                }
            }
        }
    }

    /// Stages in-memory bytes (such as a pasted clipboard image) and uploads via
    /// `attachments.createUploadUrl`.
    fn stage_and_upload_bytes(
        &mut self,
        name: String,
        mime_type: String,
        bytes: Vec<u8>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(conn) = self.connection.clone() else {
            return;
        };
        let local_id = self.next_attachment_id;
        self.next_attachment_id = self.next_attachment_id.wrapping_add(1);
        let size_bytes = bytes.len();
        self.attachments.push(PendingAttachment {
            local_id,
            name: name.clone(),
            size_bytes,
            status: AttachmentUploadStatus::Uploading,
        });
        cx.notify();

        cx.spawn_in(window, async move |this, cx| {
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
        })
        .detach();
    }

    /// Intercepts `⌘V` when the clipboard holds copied files or a standalone image (screenshots,
    /// image copies without accompanying plain text), uploading them as chat attachments.
    ///
    /// Returns `true` if the paste was consumed as attachments (caller stops propagation so the
    /// textarea does not also paste raw paths or fail silently).
    fn try_paste_attachments(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> bool {
        if self.connection.is_none() {
            return false;
        }
        let Some(item) = cx.read_from_clipboard() else {
            return false;
        };
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut images: Vec<gpui_kit::Image> = Vec::new();
        let mut has_text = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::ExternalPaths(p) => {
                    paths.extend(p.paths().iter().cloned());
                }
                ClipboardEntry::Image(img) => {
                    images.push(img.clone());
                }
                ClipboardEntry::String(text) if !text.text().is_empty() => {
                    has_text = true;
                }
                ClipboardEntry::String(_) => {}
            }
        }
        if !paths.is_empty() {
            self.attach_paths(paths, window, cx);
            return true;
        }
        // Rich text copied from browsers sometimes includes an image flavor alongside text;
        // keep plain text pasting as text (matching Threadbear's `take_reply_clipboard`).
        if has_text || images.is_empty() {
            return false;
        }
        let mut attached_any = false;
        for image in images {
            if let Some((ext, mime)) = clipboard_image_spec(image.format) {
                let name = format!("pasted-{:x}.{ext}", image.id);
                self.stage_and_upload_bytes(name, mime.to_owned(), image.bytes, window, cx);
                attached_any = true;
            }
        }
        attached_any
    }

    /// Toggles Operator voice dictation: starts a session when idle, stops & transcribes when
    /// recording.
    pub(crate) fn toggle_dictation(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        self.dictation_error = None;
        match self.dictation.clone() {
            DictationState::Idle => self.start_dictation(window, cx),
            DictationState::Recording { session_id } => {
                self.stop_dictation(session_id, window, cx);
            }
            DictationState::Starting { session_id } => {
                self.cancel_dictation(session_id, cx);
            }
            DictationState::Transcribing { .. } => {}
        }
    }

    fn start_dictation(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let seq = self.next_dictation_seq;
        self.next_dictation_seq = self.next_dictation_seq.wrapping_add(1);
        let session_id = next_dictation_session_id(seq);
        self.dictation = DictationState::Starting {
            session_id: session_id.clone(),
        };
        cx.notify();

        let sid_for_start = session_id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let start_res = crate::live::RT
                .spawn(async move {
                    let client = OperatorClient::from_config()?;
                    match client.start(&sid_for_start).await? {
                        DictationStart::Started => Ok(DictationStart::Started),
                        DictationStart::Unsupported => {
                            // Older Operator without session API: trigger legacy toggle.
                            client.legacy_toggle().await?;
                            Ok(DictationStart::Unsupported)
                        }
                    }
                })
                .await;

            match start_res {
                Ok(Ok(DictationStart::Started)) => {
                    let still_same = this
                        .update_in(cx, |composer, window, cx| {
                            if composer.dictation.session_id() == Some(session_id.as_str()) {
                                composer.dictation = DictationState::Recording {
                                    session_id: session_id.clone(),
                                };
                                composer.spawn_dictation_wait(session_id.clone(), window, cx);
                                cx.notify();
                                true
                            } else {
                                false
                            }
                        })
                        .unwrap_or(false);
                    if !still_same {
                        let sid = session_id.clone();
                        crate::live::RT.spawn(async move {
                            if let Ok(client) = OperatorClient::from_config() {
                                let _ = client.cancel(&sid).await;
                            }
                        });
                    }
                }
                Ok(Ok(DictationStart::Unsupported)) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        cx.notify();
                    });
                }
                Ok(Err(err)) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        composer.dictation_error = Some(friendly_operator_error(&err));
                        cx.notify();
                    });
                }
                Err(err) => {
                    let _ = this.update(cx, |composer, cx| {
                        composer.dictation = DictationState::Idle;
                        composer.dictation_error = Some(err.to_string());
                        cx.notify();
                    });
                }
            }
        })
        .detach();
    }

    fn spawn_dictation_wait(
        &mut self,
        session_id: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let sid = session_id.clone();
                let wait_res = crate::live::RT
                    .spawn(async move {
                        let client = OperatorClient::from_config()?;
                        client.wait(&sid).await
                    })
                    .await;

                match wait_res {
                    Ok(Ok(DictationWait::StillWaiting)) => {
                        let keep_going = this
                            .read_with(cx, |composer, _| {
                                matches!(
                                    &composer.dictation,
                                    DictationState::Recording { session_id: active }
                                        if active == &session_id
                                )
                            })
                            .unwrap_or(false);
                        if !keep_going {
                            break;
                        }
                    }
                    Ok(Ok(DictationWait::Transcript(text))) => {
                        let _ = this.update_in(cx, |composer, window, cx| {
                            if matches!(
                                &composer.dictation,
                                DictationState::Recording { session_id: active }
                                    if active == &session_id
                            ) {
                                composer.dictation = DictationState::Idle;
                                composer.apply_dictation_transcript(&text, window, cx);
                                cx.notify();
                            }
                        });
                        break;
                    }
                    // Older Operator without /dictate/wait, or wait cancelled when user clicked stop.
                    Ok(Ok(DictationWait::Unsupported)) | Ok(Err(_)) | Err(_) => {
                        break;
                    }
                }
            }
        })
        .detach();
    }

    fn stop_dictation(
        &mut self,
        session_id: String,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.dictation = DictationState::Transcribing {
            session_id: session_id.clone(),
        };
        cx.notify();

        let sid = session_id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let stop_res = crate::live::RT
                .spawn(async move {
                    let client = OperatorClient::from_config()?;
                    client.stop(&sid).await
                })
                .await;

            let _ = this.update_in(cx, |composer, window, cx| {
                if composer.dictation.session_id() != Some(session_id.as_str()) {
                    return;
                }
                composer.dictation = DictationState::Idle;
                match stop_res {
                    Ok(Ok(text)) => {
                        composer.apply_dictation_transcript(&text, window, cx);
                    }
                    Ok(Err(err)) => {
                        composer.dictation_error = Some(friendly_operator_error(&err));
                    }
                    Err(err) => {
                        composer.dictation_error = Some(err.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn cancel_dictation(&mut self, session_id: String, cx: &mut Context<'_, Self>) {
        self.dictation = DictationState::Idle;
        self.dictation_error = None;
        cx.notify();
        crate::live::RT.spawn(async move {
            if let Ok(client) = OperatorClient::from_config() {
                let _ = client.cancel(&session_id).await;
            }
        });
    }

    fn apply_dictation_transcript(
        &mut self,
        transcript: &str,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let existing = self.textarea.read(cx).value().to_string();
        let Some(merged) = append_transcript(&existing, transcript) else {
            return;
        };
        self.textarea.update(cx, |input, cx| {
            input.set_value(merged, window, cx);
            input.focus(window, cx);
        });
        self.on_draft_changed(cx);
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
        if self.submitting {
            return;
        }
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
        if self.is_draft {
            let next_worktree = !self.worktree_active;
            left = left.child(
                div()
                    .id("composer-workspace-mode-toggle")
                    .a11y_button(
                        "composer.workspace-mode",
                        format!("Workspace mode: {env_label}"),
                    )
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .h(px(22.0))
                    .px(px(6.0))
                    .rounded(px(6.0))
                    .flex_shrink_0()
                    .cursor_pointer()
                    .text_color(if self.worktree_active { fg } else { muted })
                    .when(self.worktree_active, |el| el.bg(hover_bg))
                    .hover(move |s| s.bg(hover_bg).text_color(fg))
                    .on_click(cx.listener(move |composer, _, _, cx| {
                        composer.worktree_active = next_worktree;
                        cx.emit(ComposerEvent::WorkspaceModeSelected(next_worktree));
                        cx.notify();
                    }))
                    .conn_tooltip(
                        "Click to switch between Local checkout and new git Worktree",
                        tokens,
                    )
                    .child(icons::icon(
                        env_icon,
                        12.0,
                        if self.worktree_active { fg } else { muted },
                    ))
                    .child(env_label),
            );
        } else {
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
        }

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
            .a11y_button(
                "composer.plan-mode",
                if plan_active {
                    "Plan mode (enabled)"
                } else {
                    "Toggle Plan mode"
                },
            )
            .aria_selected(plan_active)
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
                .a11y_button(
                    "composer.runtime-mode",
                    format!(
                        "Runtime permissions: {}",
                        runtime_mode_label(&self.runtime_mode)
                    ),
                )
                .aria_expanded(self.runtime_menu_open)
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
            .id("composer-context-strip")
            .a11y(
                gpui_kit::Role::Toolbar,
                "composer.context-strip",
                "Thread context",
            )
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
            && !is_uploading
            && !self.submitting;
        let (model_label, driver) = self.display_model_and_driver();
        let tokens = self.tokens.clone();

        let (card_bg, card_border) = composer_surface_colors(&tokens);
        let highlight_bg = hsla(tokens.shell_highlight);
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);

        let model_trigger = div()
            .id("chat-composer-model-picker")
            .a11y_button(
                "composer.model-picker",
                format!("Select model: {model_label}"),
            )
            .aria_expanded(self.model_picker_open)
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
                        .a11y_button(
                            "composer.effort-picker",
                            format!("{}: {current_label}", reasoning.label),
                        )
                        .aria_expanded(self.effort_menu_open)
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
            .a11y_button("composer.attach", "Attach files")
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

        let mic_btn = render_microphone_button(
            &self.dictation,
            &tokens,
            cx.listener(|composer, _, window, cx| {
                composer.toggle_dictation(window, cx);
            }),
        );

        let dictation_badge: Option<AnyElement> = match &self.dictation {
            DictationState::Starting { .. } => Some(
                div()
                    .text_size(px(11.0))
                    .text_color(muted)
                    .child("Starting…")
                    .into_any_element(),
            ),
            DictationState::Recording { .. } => Some(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(5.0))
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.destructive))
                    .child(
                        div()
                            .size(px(6.0))
                            .rounded_full()
                            .bg(hsla(tokens.destructive)),
                    )
                    .child("Listening…")
                    .into_any_element(),
            ),
            DictationState::Transcribing { .. } => Some(
                div()
                    .text_size(px(11.0))
                    .text_color(muted)
                    .child("Transcribing…")
                    .into_any_element(),
            ),
            DictationState::Idle => self.dictation_error.as_ref().map(|err| {
                div()
                    .id("chat-composer-dictation-err")
                    .max_w(px(180.0))
                    .truncate()
                    .cursor_pointer()
                    .text_size(px(11.0))
                    .text_color(hsla(tokens.destructive))
                    .on_click(cx.listener(|composer, _, _, cx| {
                        composer.dictation_error = None;
                        cx.notify();
                    }))
                    .conn_tooltip(err.clone(), &tokens)
                    .child(err.clone())
                    .into_any_element()
            }),
        };

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
            .id("chat-composer-card")
            .a11y_group("composer.card", "Message input card")
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
                            .when_some(dictation_badge, |el, badge| el.child(badge))
                            .child(mic_btn)
                            .child(action_btn),
                    ),
            );

        let mut root = div()
            .id("chat-composer-root")
            .a11y(gpui_kit::Role::Form, "composer.root", "Message composer")
            .relative()
            .w_full()
            .on_drop(
                cx.listener(|composer, dropped: &ExternalPaths, window, cx| {
                    composer.attach_paths(dropped.paths().to_vec(), window, cx);
                }),
            )
            .capture_action(cx.listener(|composer, _: &Paste, window, cx| {
                if composer.try_paste_attachments(window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|composer, _: &Escape, _window, cx| {
                if let Some(session_id) = composer.dictation.session_id().map(str::to_owned) {
                    composer.cancel_dictation(session_id, cx);
                    cx.stop_propagation();
                    return;
                }
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

/// Microphone button styled like Conn's `ComposerSpeechButton` wired to local Operator dictation.
fn render_microphone_button<FClick>(
    state: &DictationState,
    tokens: &Tokens,
    on_click: FClick,
) -> AnyElement
where
    FClick: Fn(&gpui_kit::ClickEvent, &mut Window, &mut gpui_kit::App) + 'static,
{
    let highlight_bg = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let destructive = hsla(tokens.destructive);

    let (tooltip, icon_color, active_bg) = match state {
        DictationState::Idle => ("Dictate with Operator", muted, None),
        DictationState::Starting { .. } => (
            "Starting Operator dictation… (Esc to cancel)",
            destructive,
            Some(hsla_alpha(tokens.destructive, 0.14)),
        ),
        DictationState::Recording { .. } => (
            "Stop dictation (click or Esc to cancel)",
            destructive,
            Some(hsla_alpha(tokens.destructive, 0.18)),
        ),
        DictationState::Transcribing { .. } => {
            ("Transcribing…", fg, Some(hsla_alpha(tokens.accent, 0.16)))
        }
    };

    let mut btn = div()
        .id("chat-composer-mic")
        .a11y_button("composer.mic", tooltip)
        .flex()
        .items_center()
        .justify_center()
        .size(px(FOOTER_CONTROL_HEIGHT_PX))
        .rounded_full()
        .cursor_pointer()
        .on_click(on_click)
        .conn_tooltip(tooltip, tokens)
        .child(icons::icon(ICON_MICROPHONE, 16.0, icon_color));

    if let Some(bg) = active_bg {
        btn = btn.bg(bg);
    } else {
        btn = btn.hover(move |s| s.bg(highlight_bg).text_color(fg));
    }

    btn.into_any_element()
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
            .a11y_button("composer.stop", "Stop generation")
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
            .a11y_button("composer.send", "Send message")
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
            .a11y_button("composer.send", "Send message (disabled)")
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
    } else if lower.contains("antigravity") || lower.contains("gemini") {
        Some("antigravity")
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

/// Maps a GPUI clipboard [`ImageFormat`] to `(extension, mime_type)`.
fn clipboard_image_spec(format: ImageFormat) -> Option<(&'static str, &'static str)> {
    match format {
        ImageFormat::Png => Some(("png", "image/png")),
        ImageFormat::Jpeg => Some(("jpg", "image/jpeg")),
        ImageFormat::Webp => Some(("webp", "image/webp")),
        ImageFormat::Gif => Some(("gif", "image/gif")),
        ImageFormat::Bmp => Some(("bmp", "image/bmp")),
        ImageFormat::Tiff => Some(("tiff", "image/tiff")),
        ImageFormat::Svg => Some(("svg", "image/svg+xml")),
        ImageFormat::Ico => Some(("ico", "image/x-icon")),
        ImageFormat::Pnm => None,
    }
}

fn next_dictation_session_id(seq: u64) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("conn-composer-{millis}-{seq}")
}

fn friendly_operator_error(err: &conn_desktop::operator::OperatorError) -> String {
    match err {
        conn_desktop::operator::OperatorError::Unreachable { .. } => {
            "Operator isn't running".to_owned()
        }
        conn_desktop::operator::OperatorError::Unauthorized(_) => {
            "Enable Local API in Operator → Settings".to_owned()
        }
        other => other.to_string(),
    }
}

/// Appends dictated `transcript` to `existing` draft text with a single space separator when
/// needed. Returns `None` when `transcript` is empty/whitespace.
fn append_transcript(existing: &str, transcript: &str) -> Option<String> {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return None;
    }
    if existing.is_empty() {
        return Some(trimmed.to_owned());
    }
    let needs_space = !existing.ends_with(char::is_whitespace);
    let mut out = String::with_capacity(existing.len() + trimmed.len() + usize::from(needs_space));
    out.push_str(existing);
    if needs_space {
        out.push(' ');
    }
    out.push_str(trimmed);
    Some(out)
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

    #[test]
    fn append_transcript_joins_cleanly_and_ignores_blank() {
        assert_eq!(append_transcript("", "   "), None);
        assert_eq!(
            append_transcript("", "  fix the build  "),
            Some("fix the build".to_owned())
        );
        assert_eq!(
            append_transcript("Please", "check tests"),
            Some("Please check tests".to_owned())
        );
        assert_eq!(
            append_transcript("Line 1\n", "Line 2"),
            Some("Line 1\nLine 2".to_owned())
        );
    }

    #[test]
    fn clipboard_image_spec_maps_formats_and_session_ids_validate() {
        assert_eq!(
            clipboard_image_spec(ImageFormat::Png),
            Some(("png", "image/png"))
        );
        assert_eq!(
            clipboard_image_spec(ImageFormat::Jpeg),
            Some(("jpg", "image/jpeg"))
        );
        let sid = next_dictation_session_id(7);
        assert!(conn_desktop::operator::is_valid_session_id(&sid));
    }
}
