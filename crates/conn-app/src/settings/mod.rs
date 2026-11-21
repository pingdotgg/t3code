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

use conn_client::ConnectionStatus;
use conn_theme::{Appearance, Rgba, ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::{
    AnyElement, App, ClickEvent, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement as _, IntoElement, KeyBinding, KeyDownEvent, MouseButton,
    ParentElement as _, Render, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, Window, actions, anchored, deferred, div, point, px,
};

use crate::icons;
use crate::shell::{DIVIDER_WIDTH_PX, INNER_BORDER_PX};
use crate::theme::{hsla, hsla_alpha};

use self::controls::{kbd_cap, pill_switch, settings_row, settings_section};

actions!(conn_settings, [OpenSettings]);

/// Registers the global `Cmd+,` shortcut for opening Settings.
#[expect(
    dead_code,
    reason = "called by ConnApp / main.rs once orchestrator wires Settings"
)]
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
    Keyboard,
}

const ALL_PAGES: [SettingsPage; 4] = [
    SettingsPage::General,
    SettingsPage::Appearance,
    SettingsPage::Connections,
    SettingsPage::Keyboard,
];

impl SettingsPage {
    fn label(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Appearance => "Appearance",
            Self::Connections => "Connections",
            Self::Keyboard => "Keyboard",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::General => IconName::SlidersHorizontal,
            Self::Appearance => IconName::Palette,
            Self::Connections => IconName::Plug,
            Self::Keyboard => IconName::Keyboard,
        }
    }
}

/// Connection metadata displayed on the Connections settings page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SettingsConnectionInfo {
    pub(crate) server_url: Option<String>,
    pub(crate) status: Option<ConnectionStatus>,
}

/// Events emitted by [`SettingsModal`] for `ConnApp` to handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SettingsEvent {
    ApplyTheme(String),
    Close,
}

#[derive(Clone, Debug)]
struct ThemeOption {
    id: String,
    name: String,
    appearance: Appearance,
    bg: Rgba,
    sidebar: Rgba,
    primary: Rgba,
    accent: Rgba,
}

/// Settings route modal entity.
pub(crate) struct SettingsModal {
    tokens: Tokens,
    geometry: ShellGeometry,
    active_page: SettingsPage,
    active_theme_id: String,
    reduce_transparency: bool,
    connection: SettingsConnectionInfo,
    themes: Vec<ThemeOption>,
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

#[expect(
    dead_code,
    reason = "instantiated and updated by ConnApp once orchestrator wires Settings"
)]
impl SettingsModal {
    /// Creates the Settings route modal and focuses it so Escape closes cleanly.
    #[must_use]
    pub(crate) fn new(
        active_theme_id: impl Into<String>,
        tokens: Tokens,
        connection: SettingsConnectionInfo,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let focus_handle = cx.focus_handle();
        window.focus(&focus_handle, cx);

        let themes = conn_theme::builtin_themes()
            .into_iter()
            .map(|theme| {
                let derived = Tokens::derive(&theme);
                ThemeOption {
                    id: theme.id,
                    name: theme.name,
                    appearance: theme.appearance,
                    bg: derived.background,
                    sidebar: derived.sidebar,
                    primary: derived.primary,
                    accent: derived.accent,
                }
            })
            .collect();

        Self {
            tokens,
            geometry: ShellGeometry::default(),
            active_page: SettingsPage::Appearance,
            active_theme_id: active_theme_id.into(),
            reduce_transparency: false,
            connection,
            themes,
            focus_handle,
            scroll: ScrollHandle::new(),
        }
    }

    /// Updates the modal's active theme id and derived tokens after a live theme switch.
    pub(crate) fn set_tokens(
        &mut self,
        theme_id: impl Into<String>,
        tokens: Tokens,
        cx: &mut Context<'_, Self>,
    ) {
        self.active_theme_id = theme_id.into();
        self.tokens = tokens;
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

    fn toggle_reduce_transparency(&mut self, cx: &mut Context<'_, Self>) {
        self.reduce_transparency = !self.reduce_transparency;
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
        let inner_fill = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(self.tokens.shell_inner_fill)
        };

        let mut items = Vec::with_capacity(ALL_PAGES.len());
        for (idx, page) in ALL_PAGES.into_iter().enumerate() {
            let active = self.active_page == page;
            let icon_color = if active { fg } else { muted };
            let mut row = div()
                .id(("conn-settings-nav", idx))
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
            .children(items)
    }

    fn render_content(&self, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let inset = px(self.geometry.shell_inset_px);
        let corner = px(self.geometry.shell_corner_px);
        let border = px(INNER_BORDER_PX);
        let inner_fill = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(self.tokens.shell_inner_fill)
        };

        let page_content: AnyElement = match self.active_page {
            SettingsPage::General => self.render_general_page(),
            SettingsPage::Appearance => self.render_appearance_page(cx),
            SettingsPage::Connections => self.render_connections_page(),
            SettingsPage::Keyboard => self.render_keyboard_page(),
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
                    .py(px(20.0))
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

        let window_rows = vec![settings_row(
            "Reduce transparency",
            Some("Use opaque card surfaces instead of translucent frosted fills."),
            reduce_switch.into_any_element(),
            &self.tokens,
            &self.geometry,
        )];

        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(20.0))
            .child(settings_section(
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

    fn render_theme_rows(
        &self,
        appearance: Appearance,
        cx: &mut Context<'_, Self>,
    ) -> Vec<AnyElement> {
        let fg = hsla(self.tokens.foreground);
        let muted_raised = hsla(self.tokens.muted_foreground_raised);
        let hover_bg = hsla(self.tokens.sidebar_row_hover);
        let selected_bg = hsla(self.tokens.shell_highlight);
        let ring = hsla(self.tokens.ring);
        let border = hsla(self.tokens.shell_settings_card_border);

        self.themes
            .iter()
            .filter(|t| t.appearance == appearance)
            .map(|theme| {
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
            })
            .collect()
    }

    fn render_connections_page(&self) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground_raised);

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

        let rows = vec![
            settings_row(
                "Server URL",
                Some("Active conn-server endpoint configured for this session."),
                div()
                    .text_size(px(self.geometry.ui_font_size_px))
                    .line_height(px(self.geometry.ui_line_height_px))
                    .text_color(fg)
                    .child(url_label)
                    .into_any_element(),
                &self.tokens,
                &self.geometry,
            ),
            settings_row(
                "Connection status",
                Some("Live WebSocket and Effect RPC session state."),
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

        settings_section("Connections", rows, &self.tokens, &self.geometry).into_any_element()
    }

    fn render_keyboard_page(&self) -> AnyElement {
        let shortcuts: &[(&str, &str, &[&str])] = &[
            (
                "Command palette",
                "Search threads, projects, themes, and shell actions.",
                &["⌘", "K"],
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
                "Dismiss modal or palette",
                "Close the active overlay and return focus to the shell.",
                &["Esc"],
            ),
        ];

        let rows = shortcuts
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
        let frame_bg = if self.reduce_transparency {
            hsla(self.tokens.shell_card)
        } else {
            hsla(self.tokens.shell_fill)
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
#[expect(
    dead_code,
    reason = "mounted by ConnApp::render once orchestrator wires Settings"
)]
pub(crate) fn render_overlay(modal: &Entity<SettingsModal>) -> AnyElement {
    modal.clone().into_any_element()
}
