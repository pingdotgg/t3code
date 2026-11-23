//! Settings route modal matching Conn's `AppRouteModal` shell design.
//!
//! Layout:
//! - Frosted modal frame (`shell_fill`, `18px` window radius) over a dimmed scrim.
//! - Transparent `44px` header (`shell_header_height`) with title, breadcrumb,
//!   and circular close button (Escape also closes).
//! - Inset left navigation panel (`General`, `Appearance`, `Connections`,
//!   `Keyboard`) with `sidebar_row_hover`/`sidebar_row_selected` lighting fills
//!   joined to the inset content card by a `1px` `shell_divider`.
//! - Inset content card (`shell_inner_fill`, `14px` outer corners) holding
//!   raised `SettingsGroup` cards (`shell_settings_card`, `shell_settings_card_border`,
//!   `shell_divider_raised` between square rows, no trailing divider).

pub(crate) mod controls;
pub(crate) mod projects;
pub(crate) mod providers;
pub(crate) mod scheduled_tasks;

use conn_client::{Connection, ConnectionStatus};
use conn_theme::{Appearance, Rgba, ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, FontWeight, InteractiveElement as _, IntoElement, KeyBinding, KeyDownEvent,
    MouseButton, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window,
    actions, anchored, deferred, div, point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::orbit_sync::{OrbitSettingsInfo, OrbitSyncStatus};
use crate::shell::{DIVIDER_WIDTH_PX, INNER_BORDER_PX};
use crate::theme::{hsla, hsla_alpha};

use self::controls::{kbd_cap, pill_switch, settings_row, settings_section};
pub(crate) use self::scheduled_tasks::{
    ScheduledTaskProjectOption, ScheduledTasksInit, ScheduledTasksView,
};

actions!(conn_settings, [OpenSettings]);

/// Registers the global `Cmd+,` shortcut for opening Settings.
pub(crate) fn register_keybindings(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-,", OpenSettings, None)]);
}

const MODAL_MAX_WIDTH_PX: f32 = 1040.0;
const MODAL_MAX_HEIGHT_PX: f32 = 720.0;
const NAV_WIDTH_PX: f32 = 208.0;
const NAV_ROW_HEIGHT_PX: f32 = 32.0;

/// Sections listed in the Settings left navigation rail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SettingsPage {
    General,
    Appearance,
    Connections,
    Providers,
    Projects,
    ScheduledTasks,
    Keyboard,
}

const ALL_PAGES: [SettingsPage; 7] = [
    SettingsPage::General,
    SettingsPage::Appearance,
    SettingsPage::Connections,
    SettingsPage::Providers,
    SettingsPage::Projects,
    SettingsPage::ScheduledTasks,
    SettingsPage::Keyboard,
];

impl SettingsPage {
    fn label(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Appearance => "Appearance",
            Self::Connections => "Connections",
            Self::Providers => "Providers",
            Self::Projects => "Projects",
            Self::ScheduledTasks => "Scheduled tasks",
            Self::Keyboard => "Keyboard",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::General => IconName::SlidersHorizontal,
            Self::Appearance => IconName::Palette,
            Self::Connections => IconName::Plug,
            Self::Providers => IconName::Bot,
            Self::Projects => IconName::Folder,
            Self::ScheduledTasks => IconName::Clock,
            Self::Keyboard => IconName::Keyboard,
        }
    }
}

/// Connection metadata displayed on the Connections settings page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SettingsConnectionInfo {
    pub(crate) server_label: Option<String>,
    pub(crate) server_url: Option<String>,
    pub(crate) status: Option<ConnectionStatus>,
}

/// Events emitted by [`SettingsModal`] for `ConnApp` to handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SettingsEvent {
    ApplyTheme(String),
    ReduceTransparency(bool),
    PersistComposerContextStrip(bool),
    OrbitSyncNow,
    OrbitBindProfile(i64),
    OrbitCreateProfile(String),
    OrbitForcePush,
    OrbitForcePull,
    OrbitRestoreBackup,
    OrbitConnectTarget(String),
    OrbitWakeInstance {
        instance_id: i64,
        server_id: String,
    },
    OrbitToggleSyncWorkspaces(bool),
    OrbitToggleSyncAppearance(bool),
    OrbitToggleSyncDesktopSettings(bool),
    ConnectDirectServer {
        raw_url: String,
        bearer_token: String,
    },
    Close,
}

#[derive(Clone, Debug)]
struct ThemeOption {
    id: String,
    name: String,
    appearance: Appearance,
    from_orbit: bool,
    bg: Rgba,
    sidebar: Rgba,
    primary: Rgba,
    accent: Rgba,
}

fn build_theme_options(custom_themes: &[conn_theme::ThemeDefinition]) -> Vec<ThemeOption> {
    let mut out: Vec<ThemeOption> = conn_theme::builtin_themes()
        .into_iter()
        .map(|theme| {
            let derived = Tokens::derive(&theme);
            ThemeOption {
                id: theme.id,
                name: theme.name,
                appearance: theme.appearance,
                from_orbit: false,
                bg: derived.background,
                sidebar: derived.sidebar,
                primary: derived.primary,
                accent: derived.accent,
            }
        })
        .collect();
    for theme in custom_themes {
        let derived = Tokens::derive(theme);
        out.push(ThemeOption {
            id: theme.id.clone(),
            name: theme.name.clone(),
            appearance: theme.appearance,
            from_orbit: true,
            bg: derived.background,
            sidebar: derived.sidebar,
            primary: derived.primary,
            accent: derived.accent,
        });
    }
    out
}

/// Settings route modal entity.
pub(crate) struct SettingsModal {
    tokens: Tokens,
    geometry: ShellGeometry,
    active_page: SettingsPage,
    active_theme_id: String,
    reduce_transparency: bool,
    persist_composer_context_strip: bool,
    connection: SettingsConnectionInfo,
    orbit: OrbitSettingsInfo,
    themes: Vec<ThemeOption>,
    search_input: Entity<InputState>,
    _search_sub: Subscription,
    new_profile_input: Entity<InputState>,
    show_stopped_instances: bool,
    direct_server_url_input: Entity<InputState>,
    direct_server_token_input: Entity<InputState>,
    direct_server_error: Option<String>,
    operator_url_input: Entity<InputState>,
    operator_saved_notice: Option<String>,
    scheduled_tasks: Entity<ScheduledTasksView>,
    providers: Entity<providers::ProvidersView>,
    projects: Entity<projects::ProjectsView>,
    focus_handle: FocusHandle,
    scroll: ScrollHandle,
}

impl std::fmt::Debug for SettingsModal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsModal")
            .field("active_page", &self.active_page)
            .field("active_theme_id", &self.active_theme_id)
            .field("reduce_transparency", &self.reduce_transparency)
            .finish()
    }
}

impl EventEmitter<SettingsEvent> for SettingsModal {}

impl Focusable for SettingsModal {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl SettingsModal {
    /// Creates the Settings route modal and focuses it so Escape closes cleanly.
    #[expect(
        clippy::too_many_arguments,
        reason = "initializes modal with theme, transparency, connection, Orbit sync, and custom themes"
    )]
    #[must_use]
    pub(crate) fn new(
        active_theme_id: impl Into<String>,
        tokens: Tokens,
        reduce_transparency: bool,
        persist_composer_context_strip: bool,
        connection: SettingsConnectionInfo,
        live_connection: Option<Connection>,
        projects: Vec<ScheduledTaskProjectOption>,
        default_model: (Option<String>, String),
        orbit: OrbitSettingsInfo,
        custom_themes: &[conn_theme::ThemeDefinition],
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        window.focus(&focus_handle, cx);

        let themes = build_theme_options(custom_themes);

        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("Search settings"));
        let search_sub = cx.subscribe(&search_input, |_this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });

        let operator_cfg = conn_desktop::operator::OperatorConfig::load_effective();
        let operator_url = operator_cfg.base_url;
        let operator_url_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(conn_desktop::operator::DEFAULT_OPERATOR_URL)
                .default_value(operator_url)
        });
        let provider_connection = live_connection.clone();
        let projects_connection = live_connection.clone();
        let provider_environment = connection
            .server_label
            .clone()
            .unwrap_or_else(|| "this environment".to_owned());
        let initial_server_url = connection.server_url.clone().unwrap_or_default();
        let direct_server_url_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("http://127.0.0.1:3780/pair#token=…")
                .default_value(initial_server_url)
        });
        let direct_server_token_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Bearer token (optional if pairing URL)")
        });
        let new_profile_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("New profile name"));

        let geometry = ShellGeometry::default();
        let scheduled_tokens = tokens.clone();
        let scheduled_url = connection.server_url.clone();
        let (default_instance_id, default_model_slug) = default_model;
        let scheduled_tasks = cx.new(|cx| {
            ScheduledTasksView::new(
                ScheduledTasksInit {
                    tokens: scheduled_tokens,
                    geometry,
                    connection: live_connection,
                    server_url: scheduled_url,
                    projects: projects.clone(),
                    default_instance_id,
                    default_model: default_model_slug,
                },
                cx,
            )
        });

        let providers = cx.new(|cx| {
            providers::ProvidersView::new(
                providers::ProvidersInit {
                    tokens: tokens.clone(),
                    geometry,
                    connection: provider_connection,
                    environment_label: provider_environment,
                },
                window,
                cx,
            )
        });

        let projects_tokens = tokens.clone();
        let projects = cx.new(|_| {
            projects::ProjectsView::new(projects_tokens, geometry, projects, projects_connection)
        });
        Self {
            tokens,
            geometry,
            active_page: SettingsPage::Appearance,
            active_theme_id: active_theme_id.into(),
            reduce_transparency,
            persist_composer_context_strip,
            connection,
            orbit,
            themes,
            search_input,
            _search_sub: search_sub,
            new_profile_input,
            show_stopped_instances: false,
            direct_server_url_input,
            direct_server_token_input,
            direct_server_error: None,
            operator_url_input,
            operator_saved_notice: None,
            scheduled_tasks,
            providers,
            projects,
            focus_handle,
            scroll: ScrollHandle::new(),
        }
    }

    /// The live provider catalog, for the Providers page.
    pub(crate) fn set_server_config(
        &mut self,
        config: std::sync::Arc<conn_state::providers::ServerConfigState>,
        cx: &mut Context<'_, Self>,
    ) {
        self.projects.update(cx, |view, cx| {
            view.set_server_config(std::sync::Arc::clone(&config), cx);
        });
        self.providers
            .update(cx, |view, cx| view.set_server_config(config, cx));
    }

    /// The projects the server lists, for each one's actions and workspace default.
    pub(crate) fn set_project_shells(
        &mut self,
        shells: Vec<conn_contract::OrchestrationProjectShell>,
        cx: &mut Context<'_, Self>,
    ) {
        self.projects
            .update(cx, |view, cx| view.set_shells(shells, cx));
    }

    /// `Open provider setup`: the Providers page with `instance_id`'s Account row open.
    pub(crate) fn focus_provider(&mut self, instance_id: String, cx: &mut Context<'_, Self>) {
        self.providers
            .update(cx, |view, cx| view.focus_provider(instance_id, cx));
        self.select_page(SettingsPage::Providers, cx);
    }

    /// Updates Orbit sync status, Nodes/Instances fleet, profiles, prefs, and custom themes live.
    pub(crate) fn set_orbit_state(
        &mut self,
        connection: SettingsConnectionInfo,
        live_connection: Option<Connection>,
        projects: Vec<ScheduledTaskProjectOption>,
        orbit: OrbitSettingsInfo,
        custom_themes: &[conn_theme::ThemeDefinition],
        cx: &mut Context<'_, Self>,
    ) {
        let url_changed = self.connection.server_url != connection.server_url;
        if url_changed {
            let environment = connection
                .server_label
                .clone()
                .unwrap_or_else(|| "this environment".to_owned());
            let provider_connection = live_connection.clone();
            let projects_connection = provider_connection.clone();
            self.projects
                .update(cx, |view, cx| view.set_connection(projects_connection, cx));
            self.providers.update(cx, |view, cx| {
                view.set_connection(provider_connection, environment, cx);
            });
        }
        self.projects
            .update(cx, |view, cx| view.set_projects(projects.clone(), cx));
        self.connection = connection;
        self.orbit = orbit;
        self.themes = build_theme_options(custom_themes);
        if url_changed {
            let server_url = self.connection.server_url.clone();
            self.scheduled_tasks.update(cx, |view, cx| {
                view.set_connection(live_connection, server_url, projects, cx);
            });
        }
        cx.notify();
    }

    /// Updates the modal's active theme id and derived tokens after a live theme switch.
    pub(crate) fn set_tokens(
        &mut self,
        theme_id: impl Into<String>,
        tokens: Tokens,
        cx: &mut Context<'_, Self>,
    ) {
        self.active_theme_id = theme_id.into();
        self.tokens = tokens.clone();
        self.scheduled_tasks.update(cx, |view, cx| {
            view.set_tokens(tokens.clone(), cx);
        });
        self.projects
            .update(cx, |view, cx| view.set_tokens(tokens.clone(), cx));
        self.providers
            .update(cx, |view, cx| view.set_tokens(tokens, cx));
        cx.notify();
    }

    /// Switches the active Settings page.
    pub(crate) fn select_page(&mut self, page: SettingsPage, cx: &mut Context<'_, Self>) {
        self.active_page = page;
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(SettingsEvent::Close);
    }

    fn select_theme(&mut self, theme_id: String, cx: &mut Context<'_, Self>) {
        self.active_theme_id = theme_id.clone();
        cx.emit(SettingsEvent::ApplyTheme(theme_id));
        cx.notify();
    }

    fn submit_direct_server(&mut self, cx: &mut Context<'_, Self>) {
        let raw_url = self.direct_server_url_input.read(cx).value().to_string();
        let bearer_token = self.direct_server_token_input.read(cx).value().to_string();
        let token_opt = (!bearer_token.trim().is_empty()).then_some(bearer_token.as_str());
        if let Err(err) = conn_desktop::server_store::parse_server_input(&raw_url, token_opt) {
            self.direct_server_error = Some(err);
            cx.notify();
            return;
        }
        self.direct_server_error = None;
        cx.emit(SettingsEvent::ConnectDirectServer {
            raw_url,
            bearer_token,
        });
        cx.notify();
    }

    fn save_operator_config(&mut self, cx: &mut Context<'_, Self>) {
        let base_url = self.operator_url_input.read(cx).value().trim().to_owned();
        let cfg = conn_desktop::operator::OperatorConfig {
            base_url: if base_url.is_empty() {
                conn_desktop::operator::DEFAULT_OPERATOR_URL.to_owned()
            } else {
                base_url
            },
            token: None,
        };
        self.operator_saved_notice = match cfg.save_default() {
            Ok(()) => Some("Saved".to_owned()),
            Err(err) => Some(format!("Save failed: {err}")),
        };
        cx.notify();
    }

    fn toggle_reduce_transparency(&mut self, cx: &mut Context<'_, Self>) {
        self.reduce_transparency = !self.reduce_transparency;
        cx.emit(SettingsEvent::ReduceTransparency(self.reduce_transparency));
        cx.notify();
    }

    fn toggle_persist_composer_context_strip(&mut self, cx: &mut Context<'_, Self>) {
        self.persist_composer_context_strip = !self.persist_composer_context_strip;
        cx.emit(SettingsEvent::PersistComposerContextStrip(
            self.persist_composer_context_strip,
        ));
        cx.notify();
    }

    fn render_header(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let close_hover = hsla(self.tokens.shell_header_control_hover);

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .w_full()
            .h(px(self.geometry.header_height_px))
            .flex_shrink_0()
            .pl(px(20.0))
            .pr(px(self.geometry.workspace_controls_right_px))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .text_size(px(14.0))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child("Settings"),
                    )
                    .child(div().text_color(muted).child("/"))
                    .child(div().text_color(muted).child(self.active_page.label())),
            )
            .child(
                div()
                    .id("conn-settings-close")
                    .a11y_button("settings.close", "Close settings")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(28.0))
                    .rounded(px(9999.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(close_hover))
                    .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                        this.close(cx);
                    }))
                    .child(icons::chrome(IconName::X, muted)),
            )
    }

    fn render_nav(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let fg = hsla(self.tokens.sidebar_foreground);
        let muted = hsla(self.tokens.sidebar_muted_foreground);
        let hover_bg = hsla(self.tokens.sidebar_row_hover);
        let selected_bg = hsla(self.tokens.sidebar_row_selected);
        let inset = px(self.geometry.shell_inset_px);
        let corner = px(self.geometry.shell_corner_px);
        let border = px(INNER_BORDER_PX);
        let frame = over(self.tokens.shell_fill, self.tokens.sidebar);
        let inner_fill = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(over(self.tokens.shell_inner_fill, frame))
        };

        let mut items = Vec::with_capacity(ALL_PAGES.len());
        for (idx, page) in ALL_PAGES.into_iter().enumerate() {
            let active = self.active_page == page;
            let icon_color = if active { fg } else { muted };
            let nav_ax_id = SharedString::from(format!(
                "settings.nav.{}",
                page.label().to_ascii_lowercase()
            ));
            let mut row = div()
                .id(("conn-settings-nav", idx))
                .a11y_tab(nav_ax_id, page.label(), active)
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .w_full()
                .h(px(NAV_ROW_HEIGHT_PX))
                .px(px(10.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(if active { fg } else { muted })
                .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                    this.select_page(page, cx);
                }))
                .child(icons::chrome(page.icon(), icon_color))
                .child(div().flex_1().truncate().child(page.label()));

            if active {
                row = row.bg(selected_bg).font_weight(FontWeight::MEDIUM);
            } else {
                row = row.hover(move |s| s.bg(hover_bg));
            }
            items.push(row);
        }

        let query = self.search_input.read(cx).value().to_string();
        let has_query = !query.trim().is_empty();
        let search_to_clear = self.search_input.clone();

        let mut search_bar = div()
            .id("conn-settings-search")
            .a11y(gpui_kit::Role::Search, "settings.search", "Search settings")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .w_full()
            .h(px(30.0))
            .px(px(8.0))
            .mb(px(6.0))
            .rounded(px(7.0))
            .bg(hsla(self.tokens.shell_control))
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .child(icons::chrome(IconName::Search, muted))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.search_input)
                        .appearance(false)
                        .text_size(px(self.geometry.ui_font_size_px)),
                ),
            );
        if has_query {
            search_bar = search_bar.child(
                div()
                    .id("conn-settings-search-clear")
                    .a11y_button("settings.search.clear", "Clear search")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(16.0))
                    .rounded(px(4.0))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(move |_, window, cx| {
                        search_to_clear.update(cx, |state, cx| {
                            state.set_value(String::new(), window, cx);
                        });
                    })
                    .child(icons::concept("superhero/close.svg", 11.0, muted)),
            );
        }

        div()
            .flex()
            .flex_col()
            .w(px(NAV_WIDTH_PX))
            .flex_shrink_0()
            .min_h_0()
            .ml(inset)
            .mb(inset)
            .p(px(8.0))
            .gap(px(2.0))
            .rounded_tl(corner)
            .rounded_bl(corner)
            .bg(inner_fill)
            .border_color(hsla(self.tokens.shell_inner_border))
            .border_t(border)
            .border_b(border)
            .border_l(border)
            .child(search_bar)
            .children(items)
    }

    fn render_content(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let inset = px(self.geometry.shell_inset_px);
        let corner = px(self.geometry.shell_corner_px);
        let border = px(INNER_BORDER_PX);
        let frame = over(self.tokens.shell_fill, self.tokens.sidebar);
        let inner_fill = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(over(self.tokens.shell_inner_fill, frame))
        };

        let query = self.search_input.read(cx).value().to_string();
        let needle = query.trim().to_ascii_lowercase();

        let page_content: AnyElement = if !needle.is_empty() {
            self.render_search_results(&needle, cx)
        } else {
            match self.active_page {
                SettingsPage::General => self.render_general_page(),
                SettingsPage::Appearance => self.render_appearance_page(cx),
                SettingsPage::Connections => self.render_connections_page(cx),
                SettingsPage::Providers => self.providers.clone().into_any_element(),
                SettingsPage::Projects => self.projects.clone().into_any_element(),
                SettingsPage::ScheduledTasks => self.scheduled_tasks.clone().into_any_element(),
                SettingsPage::Keyboard => self.render_keyboard_page(),
            }
        };

        div()
            .id("conn-settings-content")
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .mr(inset)
            .mb(inset)
            .rounded_tr(corner)
            .rounded_br(corner)
            .bg(inner_fill)
            .border_color(hsla(self.tokens.shell_inner_border))
            .border_t(border)
            .border_b(border)
            .border_r(border)
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .max_w(px(720.0))
                    .px(px(28.0))
                    .pt(px(20.0))
                    .pb(px(32.0))
                    .gap(px(20.0))
                    .child(page_content),
            )
    }

    fn render_general_page(&self) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground_raised);
        let rows = vec![
            settings_row(
                "Application",
                Some("Conn native desktop shell powered by Rust and GPUI."),
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(muted)
                    .child("conn-gpui")
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Interface typography",
                Some("13px sans UI scale with tabular numerals for metadata."),
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(muted)
                    .child("13px / 20px")
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
        ];

        settings_section("General", rows, &self.tokens, &self.geometry).into_any_element()
    }

    fn render_appearance_page(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let orbit_rows: Vec<AnyElement> = self
            .themes
            .iter()
            .filter(|t| t.from_orbit)
            .map(|theme| self.render_single_theme_row(theme, cx))
            .collect();
        let dark_rows = self.render_theme_rows(Appearance::Dark, cx);
        let light_rows = self.render_theme_rows(Appearance::Light, cx);

        let entity = cx.entity();
        let reduce_switch = pill_switch(
            "conn-settings-reduce-transparency",
            self.reduce_transparency,
            &self.tokens,
            move |_window, cx| {
                entity.update(cx, |this, cx| this.toggle_reduce_transparency(cx));
            },
        );
        let entity_strip = cx.entity();
        let context_strip_switch = pill_switch(
            "conn-settings-persist-composer-context",
            self.persist_composer_context_strip,
            &self.tokens,
            move |_window, cx| {
                entity_strip.update(cx, |this, cx| {
                    this.toggle_persist_composer_context_strip(cx)
                });
            },
        );

        let window_rows = vec![
            settings_row(
                "Reduce transparency",
                Some("Use opaque card surfaces instead of translucent frosted fills."),
                reduce_switch.into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Keep composer context visible",
                Some("Keep branch and worktree controls below the composer after a thread starts."),
                context_strip_switch.into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
        ];

        let mut col = div().flex().flex_col().w_full().gap(px(20.0));
        if !orbit_rows.is_empty() {
            col = col.child(settings_section(
                "From Orbit profile",
                orbit_rows,
                &self.tokens,
                &self.geometry,
            ));
        }
        col.child(settings_section(
            "Dark themes",
            dark_rows,
            &self.tokens,
            &self.geometry,
        ))
        .child(settings_section(
            "Light themes",
            light_rows,
            &self.tokens,
            &self.geometry,
        ))
        .child(settings_section(
            "Window",
            window_rows,
            &self.tokens,
            &self.geometry,
        ))
        .into_any_element()
    }

    fn render_search_results(&self, needle: &str, cx: &mut Context<'_, Self>) -> AnyElement {
        let mut sections: Vec<AnyElement> = Vec::new();

        let matching_themes: Vec<AnyElement> = self
            .themes
            .iter()
            .filter(|t| {
                t.name.to_ascii_lowercase().contains(needle)
                    || t.id.to_ascii_lowercase().contains(needle)
                    || "theme appearance color".contains(needle)
            })
            .map(|theme| self.render_single_theme_row(theme, cx))
            .collect();
        if !matching_themes.is_empty() {
            sections.push(
                settings_section("Themes", matching_themes, &self.tokens, &self.geometry)
                    .into_any_element(),
            );
        }

        let mut window_matches: Vec<AnyElement> = Vec::new();
        if "reduce transparency opaque frosted window appearance".contains(needle) {
            let entity = cx.entity();
            let reduce_switch = pill_switch(
                "conn-settings-search-reduce-transparency",
                self.reduce_transparency,
                &self.tokens,
                move |_window, cx| {
                    entity.update(cx, |this, cx| this.toggle_reduce_transparency(cx));
                },
            );
            window_matches.push(settings_row(
                "Reduce transparency",
                Some("Use opaque card surfaces instead of translucent frosted fills."),
                reduce_switch.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }
        if "keep composer context visible branch worktree strip prompt appearance".contains(needle)
        {
            let entity = cx.entity();
            let context_switch = pill_switch(
                "conn-settings-search-persist-composer-context-strip",
                self.persist_composer_context_strip,
                &self.tokens,
                move |_window, cx| {
                    entity.update(cx, |this, cx| {
                        this.toggle_persist_composer_context_strip(cx)
                    });
                },
            );
            window_matches.push(settings_row(
                "Keep composer context visible",
                Some("Show the branch and worktree strip below the composer on active threads."),
                context_switch.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }
        if !window_matches.is_empty() {
            sections.push(
                settings_section("Window", window_matches, &self.tokens, &self.geometry)
                    .into_any_element(),
            );
        }

        let matching_shortcuts: Vec<AnyElement> = KEYBOARD_SHORTCUTS
            .iter()
            .filter(|&&(title, desc, _)| {
                title.to_ascii_lowercase().contains(needle)
                    || desc.to_ascii_lowercase().contains(needle)
                    || "keyboard shortcut hotkey".contains(needle)
            })
            .map(|&(title, desc, keys)| {
                let mut caps = div().flex().flex_row().items_center().gap(px(4.0));
                for &key in keys {
                    caps = caps.child(kbd_cap(key, &self.tokens));
                }
                settings_row(
                    title,
                    Some(desc),
                    caps.into_any_element(),
                    &self.tokens,
                    &self.geometry,
                )
            })
            .collect();
        if !matching_shortcuts.is_empty() {
            sections.push(
                settings_section(
                    "Keyboard shortcuts",
                    matching_shortcuts,
                    &self.tokens,
                    &self.geometry,
                )
                .into_any_element(),
            );
        }

        if "connection server url websocket status transport orbit profile sync workspaces operator dictation voice token"
            .contains(needle)
        {
            sections.push(self.render_connections_page(cx));
        }

        if "scheduled tasks cron recurring interval webhook deliveries hmac automation"
            .contains(needle)
        {
            sections.push(self.scheduled_tasks.clone().into_any_element());
        }

        if sections.is_empty() {
            return div()
                .py(px(24.0))
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(hsla(self.tokens.muted_foreground))
                .child("No settings match your search.")
                .into_any_element();
        }

        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(20.0))
            .children(sections)
            .into_any_element()
    }

    fn render_theme_rows(
        &self,
        appearance: Appearance,
        cx: &mut Context<'_, Self>,
    ) -> Vec<AnyElement> {
        self.themes
            .iter()
            .filter(|t| !t.from_orbit && t.appearance == appearance)
            .map(|theme| self.render_single_theme_row(theme, cx))
            .collect()
    }

    fn render_single_theme_row(
        &self,
        theme: &ThemeOption,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted_raised = hsla(self.tokens.muted_foreground_raised);
        let hover_bg = hsla(self.tokens.sidebar_row_hover);
        let selected_bg = hsla(self.tokens.shell_highlight);
        let ring = hsla(self.tokens.ring);
        let border = hsla(self.tokens.shell_settings_card_border);

        let is_active = theme.id == self.active_theme_id;
        let theme_id = theme.id.clone();

        let swatch = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(3.0))
            .p(px(4.0))
            .rounded(px(9999.0))
            .bg(hsla(theme.bg))
            .border_1()
            .border_color(if is_active { ring } else { border })
            .child(
                div()
                    .size(px(10.0))
                    .rounded(px(9999.0))
                    .bg(hsla(theme.sidebar)),
            )
            .child(
                div()
                    .size(px(10.0))
                    .rounded(px(9999.0))
                    .bg(hsla(theme.primary)),
            )
            .child(
                div()
                    .size(px(10.0))
                    .rounded(px(9999.0))
                    .bg(hsla(theme.accent)),
            );

        let mut row = div()
            .id(SharedString::from(format!("conn-theme-row-{}", theme.id)))
            .a11y_button(
                SharedString::from(format!("settings.theme.{}", theme.id)),
                theme.name.clone(),
            )
            .aria_selected(is_active)
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .w_full()
            .px(px(14.0))
            .py(px(10.0))
            .cursor_pointer()
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.select_theme(theme_id.clone(), cx);
            }))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.0))
                    .min_w_0()
                    .child(swatch)
                    .child(
                        div()
                            .font_weight(if is_active {
                                FontWeight::MEDIUM
                            } else {
                                FontWeight::NORMAL
                            })
                            .text_color(fg)
                            .child(theme.name.clone()),
                    ),
            )
            .child(if is_active {
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .text_color(fg)
                    .child("Active")
                    .child(icons::chrome(IconName::Check, fg))
                    .into_any_element()
            } else {
                div()
                    .text_color(muted_raised)
                    .child(theme.id.clone())
                    .into_any_element()
            });

        if is_active {
            row = row.bg(selected_bg);
        } else {
            row = row.hover(move |s| s.bg(hover_bg));
        }

        row.into_any_element()
    }

    fn render_connections_page(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);
        let control_bg = hsla(self.tokens.shell_control_raised);
        let control_border = hsla(self.tokens.shell_control_raised_border);
        let hover_bg = hsla(self.tokens.sidebar_row_hover);
        let selected_bg = hsla(self.tokens.shell_highlight);

        let url_label = self
            .connection
            .server_url
            .clone()
            .unwrap_or_else(|| "Not connected (demo fixture)".to_owned());

        let (status_text, status_color) = match &self.connection.status {
            Some(ConnectionStatus::Connected) => {
                ("Connected".to_owned(), hsla(self.tokens.success))
            }
            Some(ConnectionStatus::Connecting) => {
                ("Connecting…".to_owned(), hsla(self.tokens.warning))
            }
            Some(ConnectionStatus::Reconnecting { attempt }) => (
                format!("Reconnecting (attempt {attempt})"),
                hsla(self.tokens.warning),
            ),
            Some(ConnectionStatus::Failed(err)) => {
                (format!("Failed: {err}"), hsla(self.tokens.destructive))
            }
            None => ("Offline".to_owned(), muted),
        };

        let status_pill = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.0))
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(fg)
            .child(div().size(px(8.0)).rounded(px(9999.0)).bg(status_color))
            .child(status_text);

        let server_label = self
            .connection
            .server_label
            .clone()
            .unwrap_or_else(|| "Active server".to_owned());

        let rows = vec![
            settings_row(
                &server_label,
                Some(&url_label),
                status_pill.into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Transport",
                Some("Typed conn-wire / conn-contract RPC over WebSocket."),
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(muted)
                    .child("WebSocket /ws")
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
        ];

        // Orbit Nodes section (`Settings › Connections › Orbit Nodes`).
        let mut node_rows: Vec<AnyElement> = Vec::new();
        for node in &self.orbit.fleet.nodes {
            let sid = node.server_id.clone();
            let is_active = self.orbit.active_server_id.as_deref() == Some(sid.as_str());
            let is_connecting = self.orbit.connecting_server_id.as_deref() == Some(sid.as_str());
            let is_local = self
                .orbit
                .local_node_name
                .as_deref()
                .is_some_and(|local| node.label.eq_ignore_ascii_case(local));
            let is_paired = self.orbit.paired_server_ids.iter().any(|p| p == &sid);
            let title = if is_local {
                format!("{} (This Mac)", node.display_title())
            } else {
                node.display_title()
            };
            let mut subtitle = node.display_subtitle();
            if is_paired && !is_active {
                subtitle.push_str(" · paired");
            }
            let btn_label = if is_active {
                "Connected"
            } else if is_connecting {
                "Connecting…"
            } else {
                "Connect"
            };
            let btn_ax_id = SharedString::from(format!("settings.orbit.node.{sid}"));
            let mut btn = div()
                .id(SharedString::from(format!("conn-orbit-node-{sid}")))
                .a11y_button(btn_ax_id, format!("{btn_label} {}", node.display_title()))
                .px(px(10.0))
                .py(px(5.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(control_border)
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .child(btn_label);
            if is_active {
                btn = btn.bg(selected_bg).text_color(hsla(self.tokens.success));
            } else if is_connecting {
                btn = btn.bg(control_bg).text_color(hsla(self.tokens.warning));
            } else {
                let target_id = sid.clone();
                btn = btn
                    .bg(control_bg)
                    .text_color(fg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(move |_this, _: &ClickEvent, _window, cx| {
                        cx.emit(SettingsEvent::OrbitConnectTarget(target_id.clone()));
                    }));
            }
            node_rows.push(orbit_node_row(
                &title,
                orbit_node_role_badge(node),
                &subtitle,
                btn.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        // Orbit Instances section (`Settings › Connections › Orbit Instances`).
        let running_count = self.orbit.fleet.running_instance_count();
        let stopped_count = self
            .orbit
            .fleet
            .instances
            .len()
            .saturating_sub(running_count);
        let mut instance_rows: Vec<AnyElement> = Vec::new();
        for inst in &self.orbit.fleet.instances {
            let awake = inst.is_awake();
            if !awake && !self.show_stopped_instances {
                continue;
            }
            let sid = inst.server_id.clone();
            let inst_id = inst.instance_id();
            let is_active = self.orbit.active_server_id.as_deref() == Some(sid.as_str());
            let is_connecting = self.orbit.connecting_server_id.as_deref() == Some(sid.as_str());
            let is_waking = inst_id.is_some() && self.orbit.waking_instance_id == inst_id;
            let title = inst.display_title();
            let subtitle = inst.display_subtitle();

            let (btn_label, btn_color) = if is_active {
                ("Connected", hsla(self.tokens.success))
            } else if is_waking {
                ("Waking…", hsla(self.tokens.warning))
            } else if is_connecting {
                ("Connecting…", hsla(self.tokens.warning))
            } else if awake {
                ("Connect", fg)
            } else {
                ("Wake", muted)
            };

            let btn_ax_id = SharedString::from(format!("settings.orbit.instance.{sid}"));
            let mut btn = div()
                .id(SharedString::from(format!("conn-orbit-inst-{sid}")))
                .a11y_button(btn_ax_id, format!("{btn_label} {title}"))
                .px(px(10.0))
                .py(px(5.0))
                .rounded(px(7.0))
                .border_1()
                .border_color(control_border)
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(btn_color)
                .child(btn_label);

            if is_active {
                btn = btn.bg(selected_bg);
            } else if is_waking || is_connecting {
                btn = btn.bg(control_bg);
            } else if awake {
                let target_id = sid.clone();
                btn = btn
                    .bg(control_bg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(move |_this, _: &ClickEvent, _window, cx| {
                        cx.emit(SettingsEvent::OrbitConnectTarget(target_id.clone()));
                    }));
            } else if let Some(instance_id) = inst_id {
                let target_id = sid.clone();
                btn = btn
                    .bg(control_bg)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover_bg))
                    .on_click(cx.listener(move |_this, _: &ClickEvent, _window, cx| {
                        cx.emit(SettingsEvent::OrbitWakeInstance {
                            instance_id,
                            server_id: target_id.clone(),
                        });
                    }));
            }

            instance_rows.push(settings_row(
                &title,
                Some(&subtitle),
                btn.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        if stopped_count > 0 {
            let toggle_label = if self.show_stopped_instances {
                format!("Hide stopped ({stopped_count})")
            } else {
                format!("Show stopped ({stopped_count})")
            };
            let toggle_btn = div()
                .id("conn-orbit-toggle-stopped-instances")
                .a11y_button(
                    "settings.orbit.toggle-stopped-instances",
                    toggle_label.clone(),
                )
                .px(px(10.0))
                .py(px(5.0))
                .rounded(px(7.0))
                .bg(control_bg)
                .border_1()
                .border_color(control_border)
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                    this.show_stopped_instances = !this.show_stopped_instances;
                    cx.notify();
                }))
                .child(toggle_label);
            let summary =
                format!("{running_count} running · {stopped_count} stopped Orbit instance(s)");
            instance_rows.push(settings_row(
                "Stopped instances",
                Some(&summary),
                toggle_btn.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        // Orbit Profile Sync section (`Settings › Connections › Orbit profile sync`).
        let (orbit_status_text, orbit_status_color, orbit_desc) = match &self.orbit.status {
            OrbitSyncStatus::Idle => (
                "Ready".to_owned(),
                muted,
                "Syncs workspaces, themes, and desktop preferences through Orbit Gateway."
                    .to_owned(),
            ),
            OrbitSyncStatus::Syncing => (
                "Syncing…".to_owned(),
                hsla(self.tokens.warning),
                "Contacting https://gateway.orbit/api/v1/conn…".to_owned(),
            ),
            OrbitSyncStatus::Synced {
                node_name,
                wireguard_ip,
                profile_name,
                profile_version,
                workspace_count,
                custom_theme_count,
            } => (
                format!("{profile_name} · v{profile_version}"),
                hsla(self.tokens.success),
                format!(
                    "Node {node_name} ({wireguard_ip}) · {workspace_count} workspace(s) · {custom_theme_count} custom theme(s)"
                ),
            ),
            OrbitSyncStatus::Unbound {
                node_name,
                wireguard_ip,
            } => (
                format!("No profile bound ({node_name})"),
                hsla(self.tokens.warning),
                format!("Signed in as {wireguard_ip}. Pick or create a profile below."),
            ),
            OrbitSyncStatus::Offline(reason) => {
                ("Gateway unreachable".to_owned(), muted, reason.clone())
            }
        };

        let sync_btn = div()
            .id("conn-settings-orbit-sync-now")
            .a11y_button(
                "settings.orbit.sync-now",
                "Sync Orbit profile and fleet now",
            )
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                cx.emit(SettingsEvent::OrbitSyncNow);
            }))
            .child("Sync now");

        let orbit_status_control = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(fg)
                    .child(
                        div()
                            .size(px(8.0))
                            .rounded(px(9999.0))
                            .bg(orbit_status_color),
                    )
                    .child(orbit_status_text),
            )
            .child(sync_btn);

        let mut orbit_rows = vec![settings_row(
            "Orbit Gateway",
            Some(&orbit_desc),
            orbit_status_control.into_any_element(),
            &self.tokens,
            &self.geometry,
        )];

        if !self.orbit.profiles.is_empty() {
            let mut pills = div()
                .flex()
                .flex_row()
                .flex_wrap()
                .items_center()
                .gap(px(6.0));
            for (idx, profile) in self.orbit.profiles.iter().enumerate() {
                let profile_id = profile.id;
                let active = self.orbit.active_profile_id == Some(profile_id);
                let mut pill = div()
                    .id(SharedString::from(format!(
                        "conn-orbit-profile-{idx}-{profile_id}"
                    )))
                    .a11y_button(
                        SharedString::from(format!("settings.orbit.profile.{profile_id}")),
                        format!("Bind Orbit profile {}", profile.name),
                    )
                    .aria_selected(active)
                    .px(px(10.0))
                    .py(px(4.0))
                    .rounded(px(7.0))
                    .border_1()
                    .border_color(control_border)
                    .text_size(px(12.0))
                    .font_weight(if active {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .text_color(if active { fg } else { muted })
                    .cursor_pointer()
                    .on_click(cx.listener(move |_this, _: &ClickEvent, _window, cx| {
                        cx.emit(SettingsEvent::OrbitBindProfile(profile_id));
                    }))
                    .child(profile.name.clone());
                pill = if active {
                    pill.bg(selected_bg)
                } else {
                    pill.bg(control_bg).hover(move |s| s.bg(hover_bg))
                };
                pills = pills.child(pill);
            }
            orbit_rows.push(settings_row(
                "Orbit profile",
                Some("Profile bound to this Orbit Node."),
                pills.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        // Create new profile row.
        let create_btn = div()
            .id("conn-settings-orbit-create-profile")
            .a11y_button("settings.orbit.create-profile", "Create Orbit profile")
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                let name = this.new_profile_input.read(cx).value().trim().to_owned();
                if !name.is_empty() {
                    this.new_profile_input
                        .update(cx, |input, cx| input.set_value("", window, cx));
                    cx.emit(SettingsEvent::OrbitCreateProfile(name));
                }
            }))
            .child("Create");
        orbit_rows.push(settings_row(
            "New profile",
            Some("Creates a profile on Orbit Gateway and binds this Node to it."),
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(8.0))
                .child(
                    div()
                        .w(px(176.0))
                        .child(Input::new(&self.new_profile_input)),
                )
                .child(create_btn)
                .into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        let ws_enabled = self.orbit.prefs.sync_workspaces;
        let ws_entity = cx.entity();
        orbit_rows.push(settings_row(
            "Sync workspaces",
            Some("Keep workspace rail tiles and project groupings synced via Orbit."),
            pill_switch(
                "conn-settings-orbit-sync-workspaces",
                ws_enabled,
                &self.tokens,
                move |_window, cx| {
                    ws_entity.update(cx, |this, cx| {
                        this.orbit.prefs.sync_workspaces = !this.orbit.prefs.sync_workspaces;
                        cx.emit(SettingsEvent::OrbitToggleSyncWorkspaces(
                            this.orbit.prefs.sync_workspaces,
                        ));
                        cx.notify();
                    });
                },
            )
            .into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        let app_enabled = self.orbit.prefs.sync_appearance;
        let app_entity = cx.entity();
        orbit_rows.push(settings_row(
            "Sync appearance & themes",
            Some("Share light/dark theme slots and custom theme palettes across devices."),
            pill_switch(
                "conn-settings-orbit-sync-appearance",
                app_enabled,
                &self.tokens,
                move |_window, cx| {
                    app_entity.update(cx, |this, cx| {
                        this.orbit.prefs.sync_appearance = !this.orbit.prefs.sync_appearance;
                        cx.emit(SettingsEvent::OrbitToggleSyncAppearance(
                            this.orbit.prefs.sync_appearance,
                        ));
                        cx.notify();
                    });
                },
            )
            .into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        let desktop_enabled = self.orbit.prefs.sync_desktop_settings;
        let desktop_entity = cx.entity();
        orbit_rows.push(settings_row(
            "Sync desktop settings",
            Some("Sync desktop appearance preferences such as glass opacity."),
            pill_switch(
                "conn-settings-orbit-sync-desktop",
                desktop_enabled,
                &self.tokens,
                move |_window, cx| {
                    desktop_entity.update(cx, |this, cx| {
                        this.orbit.prefs.sync_desktop_settings =
                            !this.orbit.prefs.sync_desktop_settings;
                        cx.emit(SettingsEvent::OrbitToggleSyncDesktopSettings(
                            this.orbit.prefs.sync_desktop_settings,
                        ));
                        cx.notify();
                    });
                },
            )
            .into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        // Resolve differences (Use this device / Use the profile) + attribution.
        let resolve_desc = if !self.orbit.section_changes.is_empty() {
            self.orbit.section_changes.join(" · ")
        } else {
            "Replace the profile with this device's settings, or pull the profile onto this device."
                .to_owned()
        };
        let push_btn = div()
            .id("conn-settings-orbit-use-device")
            .a11y_button("settings.orbit.use-device", "Use this device settings")
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                cx.emit(SettingsEvent::OrbitForcePush);
            }))
            .child("Use this device");
        let pull_btn = div()
            .id("conn-settings-orbit-use-profile")
            .a11y_button("settings.orbit.use-profile", "Use profile settings")
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                cx.emit(SettingsEvent::OrbitForcePull);
            }))
            .child("Use the profile");
        orbit_rows.push(settings_row(
            "Resolve differences",
            Some(&resolve_desc),
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .child(push_btn)
                .child(pull_btn)
                .into_any_element(),
            &self.tokens,
            &self.geometry,
        ));

        if self.orbit.has_backup {
            let restore_btn = div()
                .id("conn-settings-orbit-restore-backup")
                .a11y_button("settings.orbit.restore-backup", "Restore previous settings")
                .px(px(10.0))
                .py(px(5.0))
                .rounded(px(7.0))
                .bg(control_bg)
                .border_1()
                .border_color(control_border)
                .text_size(px(12.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_click(cx.listener(|_this, _: &ClickEvent, _window, cx| {
                    cx.emit(SettingsEvent::OrbitRestoreBackup);
                }))
                .child("Restore");
            orbit_rows.push(settings_row(
                "Restore previous settings",
                Some("Undo the last profile pull and restore this device's saved backup."),
                restore_btn.into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        if let Some(notice) = &self.orbit.notice {
            orbit_rows.push(settings_row(
                "Status notice",
                Some(notice),
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        let operator_save_btn = div()
            .id("conn-settings-operator-save")
            .a11y_button("settings.operator.save", "Save operator settings")
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(control_bg)
            .border_1()
            .border_color(control_border)
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.save_operator_config(cx);
            }))
            .child("Save");

        let operator_notice = self.operator_saved_notice.as_ref().map(|msg| {
            div()
                .text_size(px(12.0))
                .text_color(hsla(self.tokens.success))
                .child(msg.clone())
        });

        let operator_control = conn_desktop::operator::OperatorControlInfo::load_default();
        let (operator_status_text, operator_status_color) = match operator_control {
            Some(ref info) if info.enabled == Some(false) => (
                "Local API off in Operator".to_owned(),
                hsla(self.tokens.warning),
            ),
            Some(ref info) if info.token.is_some() => (
                "Auto-detected from Operator".to_owned(),
                hsla(self.tokens.success),
            ),
            _ => (
                "Not detected (enable Local API in Operator)".to_owned(),
                muted,
            ),
        };

        let operator_rows = vec![
            settings_row(
                "Status",
                Some("Automatically reads Operator's local control.json token on this Mac."),
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(fg)
                    .child(
                        div()
                            .size(px(8.0))
                            .rounded(px(9999.0))
                            .bg(operator_status_color),
                    )
                    .child(operator_status_text)
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Local API URL",
                Some("Operator local HTTP endpoint on this Mac (default http://127.0.0.1:12321)."),
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .w(px(220.0))
                            .child(Input::new(&self.operator_url_input)),
                    )
                    .children(operator_notice)
                    .child(operator_save_btn)
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
        ];

        let direct_connect_btn = div()
            .id("conn-settings-direct-connect")
            .a11y_button("settings.direct.connect", "Connect to conn-server")
            .px(px(10.0))
            .py(px(5.0))
            .rounded(px(7.0))
            .bg(hsla(self.tokens.primary))
            .text_size(px(12.0))
            .font_weight(FontWeight::MEDIUM)
            .text_color(hsla(self.tokens.primary_foreground))
            .cursor_pointer()
            .hover(|s| s.opacity(0.90))
            .on_click(cx.listener(|this, _: &ClickEvent, _window, cx| {
                this.submit_direct_server(cx);
            }))
            .child("Connect");

        let mut direct_rows = vec![
            settings_row(
                "Server or pairing URL",
                Some(
                    "Paste a conn-server pairing URL (http://127.0.0.1:3780/pair#token=...) or server URL.",
                ),
                div()
                    .w(px(280.0))
                    .child(Input::new(&self.direct_server_url_input))
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Bearer token",
                Some("Needed only when entering a plain server URL without #token=."),
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .w(px(210.0))
                            .child(Input::new(&self.direct_server_token_input)),
                    )
                    .child(direct_connect_btn)
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
        ];
        if let Some(err) = &self.direct_server_error {
            direct_rows.push(settings_row(
                "Connection error",
                Some(err),
                div().into_any_element(),
                &self.tokens,
                &self.geometry,
            ));
        }

        let mut page = div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(20.0))
            .child(settings_section(
                "Active server",
                rows,
                &self.tokens,
                &self.geometry,
            ))
            .child(settings_section(
                "Connect to conn-server",
                direct_rows,
                &self.tokens,
                &self.geometry,
            ));

        if !node_rows.is_empty() {
            page = page.child(settings_section(
                "Orbit Nodes",
                node_rows,
                &self.tokens,
                &self.geometry,
            ));
        }
        if !instance_rows.is_empty() {
            page = page.child(settings_section(
                "Orbit Instances",
                instance_rows,
                &self.tokens,
                &self.geometry,
            ));
        }

        page.child(settings_section(
            "Orbit profile sync",
            orbit_rows,
            &self.tokens,
            &self.geometry,
        ))
        .child(settings_section(
            "Operator dictation",
            operator_rows,
            &self.tokens,
            &self.geometry,
        ))
        .into_any_element()
    }

    fn render_keyboard_page(&self) -> AnyElement {
        let rows = KEYBOARD_SHORTCUTS
            .iter()
            .map(|&(title, desc, keys)| {
                let mut caps = div().flex().flex_row().items_center().gap(px(4.0));
                for &key in keys {
                    caps = caps.child(kbd_cap(key, &self.tokens));
                }
                settings_row(
                    title,
                    Some(desc),
                    caps.into_any_element(),
                    &self.tokens,
                    &self.geometry,
                )
            })
            .collect();

        settings_section("Keyboard shortcuts", rows, &self.tokens, &self.geometry)
            .into_any_element()
    }
}

const KEYBOARD_SHORTCUTS: &[(&str, &str, &[&str])] = &[
    (
        "Command palette",
        "Search threads, projects, themes, and shell actions.",
        &["⌘", "K"],
    ),
    (
        "New thread",
        "Start composing a new thread in the current project.",
        &["⌘", "N"],
    ),
    (
        "Open settings",
        "Open the Settings modal from anywhere in the window.",
        &["⌘", ","],
    ),
    (
        "Toggle sidebar",
        "Show or hide the workspace rail and thread sidebar.",
        &["⌘", "B"],
    ),
    (
        "Toggle right panel",
        "Show or hide the Files, Diff, Terminal, and Browser panel.",
        &["⌘", "⌥", "B"],
    ),
    (
        "Terminal copy / paste / select all",
        "Copy mouse-selected text, paste clipboard, or select all in Terminal.",
        &["⌘", "C / V / A"],
    ),
    (
        "Dismiss modal or palette",
        "Close the active overlay and return focus to the shell.",
        &["Esc"],
    ),
];

impl Render for SettingsModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let viewport_w = f32::from(viewport.width);
        let viewport_h = f32::from(viewport.height);

        let modal_w = MODAL_MAX_WIDTH_PX.min((viewport_w - 48.0).max(520.0));
        let modal_h = MODAL_MAX_HEIGHT_PX.min((viewport_h - 48.0).max(380.0));

        let scrim_alpha = match self.tokens.appearance {
            Appearance::Dark => 0.50,
            Appearance::Light => 0.25,
        };
        let scrim = hsla_alpha(self.tokens.background, scrim_alpha);
        // GPUI cannot blur in-window content, so the frame's frosted tint is flattened onto
        // the sidebar color: the same look as Conn's frame over its own sidebar, never the
        // chat showing through.
        let frame_bg = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(over(self.tokens.shell_fill, self.tokens.sidebar))
        };

        let body = div()
            .flex()
            .flex_row()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .child(self.render_nav(cx))
            .child(
                div()
                    .w(px(DIVIDER_WIDTH_PX))
                    .flex_shrink_0()
                    .mb(px(self.geometry.shell_inset_px))
                    .bg(hsla(self.tokens.shell_divider)),
            )
            .child(self.render_content(cx));

        let modal = div()
            .id("conn-settings-modal")
            .test_support()
            .a11y(gpui_kit::Role::Dialog, "settings.modal", "Settings")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _window, cx| {
                if event.keystroke.key == "escape" {
                    this.close(cx);
                    cx.stop_propagation();
                }
            }))
            .flex()
            .flex_col()
            .w(px(modal_w))
            .h(px(modal_h))
            .rounded(px(self.geometry.window_radius_px))
            .overflow_hidden()
            .bg(frame_bg)
            .border_1()
            .border_color(hsla(self.tokens.shell_inner_border))
            .shadow_lg()
            .font_family(".SystemUIFont")
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(hsla(self.tokens.foreground))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(self.render_header(cx))
            .child(body);

        deferred(
            anchored().position(point(px(0.0), px(0.0))).child(
                div()
                    .id("conn-settings-backdrop")
                    .flex()
                    .items_center()
                    .justify_center()
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(scrim)
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _window, cx| this.close(cx)),
                    )
                    .child(modal),
            ),
        )
        .with_priority(2)
    }
}

/// Renders an open [`SettingsModal`] entity as a deferred window overlay.
#[must_use]
pub(crate) fn render_overlay(modal: &Entity<SettingsModal>) -> AnyElement {
    modal.clone().into_any_element()
}

/// Source-over compositing of `top` on an opaque `below`.
fn over(top: conn_theme::Rgba, below: conn_theme::Rgba) -> conn_theme::Rgba {
    let a = top.a;
    conn_theme::Rgba::new(
        top.r * a + below.r * (1.0 - a),
        top.g * a + below.g * (1.0 - a),
        top.b * a + below.b * (1.0 - a),
        1.0,
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OrbitNodeRoleBadge {
    Agent,
}

impl OrbitNodeRoleBadge {
    const fn label(self) -> &'static str {
        match self {
            Self::Agent => "Agent",
        }
    }
}

fn orbit_node_role_badge(
    node: &conn_desktop::orbit::OrbitServerTarget,
) -> Option<OrbitNodeRoleBadge> {
    node.has_agent_role().then_some(OrbitNodeRoleBadge::Agent)
}

/// Renders an Orbit Node row inside `Settings › Connections`, placing a subtle Conn-styled
/// `Agent` pill badge next to the node label when the Node carries the Orbit `agent` role (the
/// Conn entry point).
fn orbit_node_row(
    title: &str,
    role_badge: Option<OrbitNodeRoleBadge>,
    description: &str,
    trailing: AnyElement,
    tokens: &Tokens,
    geometry: &ShellGeometry,
) -> AnyElement {
    let fg = hsla(tokens.foreground);
    let muted_raised = hsla(tokens.muted_foreground_raised);

    let mut title_row = div()
        .flex()
        .flex_row()
        .flex_wrap()
        .items_center()
        .gap(px(8.0))
        .child(
            div()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(title.to_owned()),
        );

    if let Some(badge) = role_badge {
        let (badge_bg, badge_border, badge_fg) = match badge {
            OrbitNodeRoleBadge::Agent => (
                hsla(tokens.shell_control_raised),
                hsla(tokens.shell_control_raised_border),
                muted_raised,
            ),
        };
        title_row = title_row.child(
            div()
                .flex_shrink_0()
                .px(px(7.0))
                .py(px(1.0))
                .rounded(px(9999.0))
                .bg(badge_bg)
                .border_1()
                .border_color(badge_border)
                .text_size(px(11.0))
                .line_height(px(16.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(badge_fg)
                .child(badge.label()),
        );
    }

    let text_col = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(px(2.0))
        .child(title_row)
        .child(
            div()
                .text_size(px(geometry.ui_font_size_px))
                .line_height(px(geometry.ui_line_height_px))
                .text_color(muted_raised)
                .child(description.to_owned()),
        );

    let slug = title.to_ascii_lowercase().replace(' ', "-");
    div()
        .id(SharedString::from(format!("settings-row-{slug}")))
        .a11y_group(
            SharedString::from(format!("settings.row.{slug}")),
            title.to_owned(),
        )
        .flex()
        .flex_row()
        .items_start()
        .justify_between()
        .gap(px(16.0))
        .w_full()
        .px(px(14.0))
        .py(px(12.0))
        .child(text_col)
        .child(div().flex_shrink_0().child(trailing))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use conn_desktop::orbit::{OrbitServerTarget, OrbitTargetKind, OrbitTargetStatus};

    use super::{OrbitNodeRoleBadge, orbit_node_role_badge};

    fn node_target(roles: &[&str]) -> OrbitServerTarget {
        OrbitServerTarget {
            server_id: "node-mini".to_owned(),
            label: "mini".to_owned(),
            url: "http://10.44.0.8:3773".to_owned(),
            server_version: Some("0.1.7".to_owned()),
            registered_by: Some("mini".to_owned()),
            status: OrbitTargetStatus::Registered,
            cleanup_pending: false,
            kind: OrbitTargetKind::Node {
                node_name: "mini".to_owned(),
                roles: roles.iter().map(|r| (*r).to_owned()).collect(),
            },
        }
    }

    #[test]
    fn resolves_orbit_node_role_badges() {
        let agent = node_target(&["router", "agent"]);
        assert_eq!(
            orbit_node_role_badge(&agent),
            Some(OrbitNodeRoleBadge::Agent)
        );
        assert_eq!(OrbitNodeRoleBadge::Agent.label(), "Agent");

        let plain = node_target(&["router"]);
        assert_eq!(orbit_node_role_badge(&plain), None);
    }
}
