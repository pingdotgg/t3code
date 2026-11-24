//! `Cmd+K` command palette entity and floating `dropdown-glass` overlay.
//!
//! Mirrors `apps/web/src/components/CommandPalette.tsx` and
//! `ui/command.tsx` with Conn shell tokens (`shell_overlay`, `glass_divider`,
//! `shell_highlight`, raised `Kbd` hints).

pub(crate) mod filter;

use conn_state::{RightPanelTab, ShellState};
use conn_theme::{Appearance, ShellGeometry, Tokens};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Enter, Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, KeyBinding, MouseButton, ParentElement as _, Render,
    ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Subscription,
    TestSupportExt as _, Window, actions, anchored, deferred, div, point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::settings::controls::kbd_cap;
use crate::theme::{hsla, hsla_alpha};

pub(crate) use filter::{
    FilteredGroup, PaletteAction, PaletteItems, PaletteProject, PaletteRow, PaletteTarget,
    PaletteTheme, PaletteThread,
};

actions!(conn_palette, [OpenCommandPalette]);

/// Registers the global `Cmd+K` shortcut for the command palette.
pub(crate) fn register_keybindings(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-k", OpenCommandPalette, None)]);
}

const PALETTE_WIDTH_PX: f32 = 576.0;
const PALETTE_RADIUS_PX: f32 = 12.0;
const ROW_RADIUS_PX: f32 = 8.0;
const LIST_MAX_HEIGHT_PX: f32 = 360.0;

/// Events emitted by [`CommandPalette`] for `ConnApp` to handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PaletteEvent {
    SelectThread(String),
    ConnectOrbitTarget(String),
    ApplyTheme(String),
    Action(PaletteAction),
    Dismiss,
}

impl PaletteItems {
    /// Builds palette items from the live [`ShellState`], Orbit Nodes/Instances, built-in themes,
    /// and Orbit custom themes.
    #[must_use]
    pub(crate) fn from_shell(
        shell: &ShellState,
        active_thread_id: Option<&str>,
        active_theme_id: &str,
        custom_themes: &[conn_theme::ThemeDefinition],
        fleet: &conn_desktop::orbit::OrbitFleet,
        active_server_id: Option<&str>,
    ) -> Self {
        let threads = shell
            .threads
            .iter()
            .map(|thread| {
                let project_title = shell
                    .project(&thread.project_id)
                    .map_or_else(|| thread.project_id.clone(), |p| p.title.clone());
                PaletteThread {
                    id: thread.id.clone(),
                    title: thread.title.clone(),
                    project_title,
                    branch: thread.branch.clone(),
                    is_current: active_thread_id == Some(thread.id.as_str()),
                }
            })
            .collect();

        let projects = shell
            .projects
            .iter()
            .map(|project| PaletteProject {
                id: project.id.clone(),
                title: project.title.clone(),
                workspace_root: project.workspace_root.clone(),
            })
            .collect();

        let themes = conn_theme::builtin_themes()
            .into_iter()
            .chain(custom_themes.iter().cloned())
            .map(|theme| {
                let derived = Tokens::derive(&theme);
                PaletteTheme {
                    is_current: theme.id == active_theme_id,
                    id: theme.id,
                    name: theme.name,
                    appearance: theme.appearance,
                    swatch_bg: derived.background,
                    swatch_primary: derived.primary,
                    swatch_accent: derived.accent,
                }
            })
            .collect();

        let targets = fleet
            .nodes
            .iter()
            .chain(fleet.instances.iter().filter(|i| i.is_awake()))
            .map(|target| PaletteTarget {
                is_current: active_server_id == Some(target.server_id.as_str()),
                is_node: target.is_node(),
                server_id: target.server_id.clone(),
                title: target.display_title(),
                subtitle: target.display_subtitle(),
            })
            .collect();

        Self {
            threads,
            projects,
            targets,
            themes,
        }
    }
}

/// Interactive `Cmd+K` command palette entity.
pub(crate) struct CommandPalette {
    input: Entity<InputState>,
    items: PaletteItems,
    filtered: Vec<FilteredGroup>,
    selected_index: usize,
    scroll: ScrollHandle,
    tokens: Tokens,
    geometry: ShellGeometry,
    _typing: Subscription,
}

impl std::fmt::Debug for CommandPalette {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandPalette")
            .field("groups", &self.filtered.len())
            .field("selected_index", &self.selected_index)
            .finish()
    }
}

impl EventEmitter<PaletteEvent> for CommandPalette {}

impl CommandPalette {
    /// Creates a new command palette, initializes filtered groups, and focuses
    /// its search input.
    #[must_use]
    pub(crate) fn new(
        items: PaletteItems,
        tokens: Tokens,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Search threads, projects, nodes, themes, or actions…")
        });
        input.update(cx, |state, cx| state.focus(window, cx));

        let typing = cx.subscribe(&input, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.refresh_filter(cx);
            }
        });

        let filtered = filter::filter_items(&items, "");

        Self {
            input,
            items,
            filtered,
            selected_index: 0,
            scroll: ScrollHandle::new(),
            tokens,
            geometry: ShellGeometry::default(),
            _typing: typing,
        }
    }

    /// Updates the palette's active tokens (e.g. after live theme switching).
    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }

    fn refresh_filter(&mut self, cx: &mut Context<'_, Self>) {
        let query = self.input.read(cx).value().to_string();
        self.filtered = filter::filter_items(&self.items, &query);
        self.selected_index = 0;
        self.scroll.scroll_to_item(0);
        cx.notify();
    }

    fn move_selection(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        let count = filter::total_rows(&self.filtered);
        if count == 0 {
            self.selected_index = 0;
            return;
        }
        let next = if delta < 0 {
            self.selected_index.saturating_sub(delta.unsigned_abs())
        } else {
            (self.selected_index + delta.unsigned_abs()).min(count - 1)
        };
        self.selected_index = next;
        if let Some(child_idx) = filter::scroll_child_index(&self.filtered, next) {
            self.scroll.scroll_to_item(child_idx);
        }
        cx.notify();
    }

    fn confirm_selection(&mut self, cx: &mut Context<'_, Self>) {
        if let Some(row) = filter::row_at(&self.filtered, self.selected_index).cloned() {
            self.activate_row(row, cx);
        }
    }

    fn activate_row(&mut self, row: PaletteRow, cx: &mut Context<'_, Self>) {
        match row {
            PaletteRow::Thread(thread) => cx.emit(PaletteEvent::SelectThread(thread.id)),
            PaletteRow::Project(project) => {
                cx.emit(PaletteEvent::Action(PaletteAction::SelectProject(
                    project.id,
                )));
            }
            PaletteRow::Target(target) => {
                cx.emit(PaletteEvent::ConnectOrbitTarget(target.server_id));
            }
            PaletteRow::Theme(theme) => cx.emit(PaletteEvent::ApplyTheme(theme.id)),
            PaletteRow::Action(entry) => cx.emit(PaletteEvent::Action(entry.action)),
        }
    }

    fn dismiss(&mut self, cx: &mut Context<'_, Self>) {
        cx.emit(PaletteEvent::Dismiss);
    }

    fn render_results(&self, list_max_h: f32, cx: &mut Context<'_, Self>) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);

        if self.filtered.is_empty() {
            return div()
                .px(px(16.0))
                .py(px(28.0))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .text_color(muted)
                .child("No matching threads, projects, themes, or actions.")
                .into_any_element();
        }

        let mut children: Vec<AnyElement> = Vec::new();
        let mut flat_idx = 0_usize;

        for (group_idx, group) in self.filtered.iter().enumerate() {
            let mut heading = div()
                .px(px(10.0))
                .pb(px(4.0))
                .text_size(px(self.geometry.ui_font_size_px))
                .line_height(px(self.geometry.ui_line_height_px))
                .font_weight(FontWeight::MEDIUM)
                .text_color(muted)
                .child(group.label);

            if group_idx > 0 {
                heading = heading.pt(px(8.0));
            } else {
                heading = heading.pt(px(2.0));
            }
            children.push(heading.into_any_element());

            for row in &group.rows {
                let is_selected = flat_idx == self.selected_index;
                children.push(self.render_row(row, flat_idx, is_selected, cx));
                flat_idx += 1;
            }
        }

        div()
            .id("conn-palette-list")
            .flex_none()
            .max_h(px(list_max_h))
            .px(px(8.0))
            .py(px(6.0))
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .children(children)
            .into_any_element()
    }

    fn render_row(
        &self,
        row: &PaletteRow,
        flat_idx: usize,
        is_selected: bool,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let muted = hsla(self.tokens.muted_foreground);
        let selected_bg = hsla(self.tokens.shell_highlight);
        let hover_bg = hsla(self.tokens.sidebar_row_hover);
        let row_clone = row.clone();

        let (ax_kind, ax_title) = match row {
            PaletteRow::Thread(t) => ("thread", t.title.as_str()),
            PaletteRow::Project(p) => ("project", p.title.as_str()),
            PaletteRow::Target(t) => ("target", t.title.as_str()),
            PaletteRow::Theme(t) => ("theme", t.name.as_str()),
            PaletteRow::Action(a) => ("action", a.title),
        };
        let mut container = div()
            .id(SharedString::from(format!("conn-palette-row-{flat_idx}")))
            .a11y(
                gpui_kit::Role::ListItem,
                format!("palette.row.{flat_idx}"),
                format!("{ax_kind}: {ax_title}"),
            )
            .aria_selected(is_selected)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .min_h(px(34.0))
            .px(px(10.0))
            .py(px(6.0))
            .rounded(px(ROW_RADIUS_PX))
            .cursor_pointer()
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .on_click(cx.listener(move |this, _: &ClickEvent, _window, cx| {
                this.activate_row(row_clone.clone(), cx);
            }));

        if is_selected {
            container = container.bg(selected_bg);
        } else {
            container = container.hover(move |s| s.bg(hover_bg));
        }

        match row {
            PaletteRow::Thread(thread) => {
                let subtitle = match &thread.branch {
                    Some(branch) if !branch.is_empty() => {
                        format!("{} · {branch}", thread.project_title)
                    }
                    _ => thread.project_title.clone(),
                };
                container = container
                    .child(icons::chrome(IconName::MessageSquare, muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(fg)
                            .child(thread.title.clone()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .max_w(px(200.0))
                            .truncate()
                            .text_color(muted)
                            .child(subtitle),
                    );
                if thread.is_current {
                    container = container.child(
                        div()
                            .flex_shrink_0()
                            .px(px(6.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(hsla(self.tokens.shell_highlight))
                            .text_color(muted)
                            .child("Current"),
                    );
                }
            }
            PaletteRow::Project(project) => {
                container = container
                    .child(icons::chrome(IconName::Folder, muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(fg)
                            .child(project.title.clone()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .max_w(px(220.0))
                            .truncate()
                            .text_color(muted)
                            .child(project.workspace_root.clone()),
                    );
            }
            PaletteRow::Target(target) => {
                let icon = if target.is_node {
                    IconName::Plug
                } else {
                    IconName::Layers
                };
                container = container
                    .child(icons::chrome(icon, muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(fg)
                            .child(target.title.clone()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .max_w(px(220.0))
                            .truncate()
                            .text_color(muted)
                            .child(target.subtitle.clone()),
                    );
                if target.is_current {
                    container = container.child(
                        div()
                            .flex_shrink_0()
                            .px(px(6.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(hsla(self.tokens.shell_highlight))
                            .text_color(hsla(self.tokens.success))
                            .child("Connected"),
                    );
                }
            }
            PaletteRow::Theme(theme) => {
                let mode_label = match theme.appearance {
                    Appearance::Light => "Light",
                    Appearance::Dark => "Dark",
                };
                container = container
                    .child(icons::chrome(IconName::Palette, muted))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(fg)
                            .child(theme.name.clone()),
                    )
                    .child(div().flex_shrink_0().text_color(muted).child(mode_label));
                if theme.is_current {
                    container = container.child(
                        div()
                            .flex_shrink_0()
                            .px(px(6.0))
                            .py(px(1.0))
                            .rounded(px(4.0))
                            .bg(hsla(self.tokens.shell_highlight))
                            .text_color(muted)
                            .child("Current"),
                    );
                }
                container = container.child(render_theme_swatch(
                    theme.swatch_bg,
                    theme.swatch_primary,
                    theme.swatch_accent,
                    hsla(self.tokens.glass_divider),
                ));
            }
            PaletteRow::Action(entry) => {
                let icon = action_icon(&entry.action);
                container = container.child(icons::chrome(icon, muted)).child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(fg)
                        .child(entry.title),
                );
                if let Some(keys) = entry.shortcut {
                    let mut caps = div().flex().flex_row().items_center().gap(px(4.0));
                    for &key in keys {
                        caps = caps.child(kbd_cap(key, &self.tokens));
                    }
                    container = container.child(caps);
                }
            }
        }

        container.into_any_element()
    }

    fn render_footer(&self) -> impl IntoElement {
        let muted = hsla(self.tokens.muted_foreground);
        let divider = hsla(self.tokens.glass_divider);

        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(12.0))
            .px(px(14.0))
            .py(px(8.0))
            .border_t_1()
            .border_color(divider)
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(muted)
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(14.0))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .child(kbd_cap("↑", &self.tokens))
                            .child(kbd_cap("↓", &self.tokens))
                            .child("Navigate"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .child(kbd_cap("↵", &self.tokens))
                            .child("Select"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .child(kbd_cap("Esc", &self.tokens))
                            .child("Close"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.0))
                    .child(kbd_cap(">", &self.tokens))
                    .child("Actions"),
            )
    }
}

impl Render for CommandPalette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let viewport_w = f32::from(viewport.width);
        let viewport_h = f32::from(viewport.height);

        let width = PALETTE_WIDTH_PX.min((viewport_w - 32.0).max(320.0));
        let top = (viewport_h * 0.11).clamp(48.0, 120.0);
        let list_max_h = (viewport_h - top - 160.0).clamp(140.0, LIST_MAX_HEIGHT_PX);

        let scrim_alpha = match self.tokens.appearance {
            Appearance::Dark => 0.45,
            Appearance::Light => 0.22,
        };
        let scrim = hsla_alpha(self.tokens.background, scrim_alpha);
        // GPUI cannot blur in-window content behind popovers, so use `popover` (matching
        // `dropdown-glass`'s `@supports not (backdrop-filter)` fallback) instead of a translucent
        // overlay that lets unblurred chat text bleed through.
        let glass_bg = hsla(self.tokens.popover);
        let glass_edge = hsla(self.tokens.glass_divider);
        let muted = hsla(self.tokens.muted_foreground);

        let search_row = div()
            .id("conn-palette-input-row")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .w_full()
            .px(px(14.0))
            .py(px(10.0))
            .border_b_1()
            .border_color(glass_edge)
            .capture_action(cx.listener(|this, _: &MoveUp, _window, cx| {
                this.move_selection(-1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|this, _: &MoveDown, _window, cx| {
                this.move_selection(1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|this, _: &Enter, _window, cx| {
                this.confirm_selection(cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|this, _: &Escape, _window, cx| {
                this.dismiss(cx);
                cx.stop_propagation();
            }))
            .child(icons::chrome(IconName::Search, muted))
            .child(
                div().flex_1().min_w_0().child(
                    Input::new(&self.input)
                        .appearance(false)
                        .pl(px(0.0))
                        .text_size(px(self.geometry.ui_font_size_px))
                        .line_height(px(self.geometry.ui_line_height_px)),
                ),
            );

        let card = div()
            .id("conn-command-palette")
            .test_support()
            .a11y(gpui_kit::Role::Dialog, "palette.modal", "Command palette")
            .flex()
            .flex_col()
            .w(px(width))
            .rounded(px(PALETTE_RADIUS_PX))
            .overflow_hidden()
            .bg(glass_bg)
            .border_1()
            .border_color(glass_edge)
            .shadow_lg()
            .font_family(".SystemUIFont")
            .text_size(px(self.geometry.ui_font_size_px))
            .line_height(px(self.geometry.ui_line_height_px))
            .text_color(hsla(self.tokens.foreground))
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(search_row)
            .child(self.render_results(list_max_h, cx))
            .child(self.render_footer());

        deferred(
            anchored().position(point(px(0.0), px(0.0))).child(
                div()
                    .id("conn-palette-backdrop")
                    .relative()
                    .w(viewport.width)
                    .h(viewport.height)
                    .bg(scrim)
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _window, cx| this.dismiss(cx)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top(px(top))
                            .left_0()
                            .right_0()
                            .flex()
                            .justify_center()
                            .child(card),
                    ),
            ),
        )
        .with_priority(crate::panels::chrome::MODAL_LAYER_PRIORITY)
    }
}

/// Renders an open [`CommandPalette`] entity as a deferred window overlay.
#[must_use]
pub(crate) fn render_overlay(palette: &Entity<CommandPalette>) -> AnyElement {
    palette.clone().into_any_element()
}

fn action_icon(action: &PaletteAction) -> IconName {
    match action {
        PaletteAction::NewThread => IconName::SquarePen,
        PaletteAction::ToggleSidebar => IconName::PanelLeft,
        PaletteAction::ToggleRightPanel => IconName::PanelRight,
        PaletteAction::OpenPanel(RightPanelTab::Files) => IconName::Folder,
        PaletteAction::OpenPanel(RightPanelTab::Diff) => IconName::GitPullRequest,
        PaletteAction::OpenPanel(RightPanelTab::Terminal) => IconName::Terminal,
        PaletteAction::OpenPanel(RightPanelTab::Browser) => IconName::Globe,
        PaletteAction::OpenPanel(tab) => icons::right_panel_tab_icon(*tab),
        PaletteAction::SelectProject(_) => IconName::Folder,
        PaletteAction::OpenSettings => IconName::Settings,
    }
}

fn render_theme_swatch(
    bg: conn_theme::Rgba,
    primary: conn_theme::Rgba,
    accent: conn_theme::Rgba,
    border: gpui_kit::Hsla,
) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .flex_shrink_0()
        .gap(px(2.0))
        .p(px(2.0))
        .rounded(px(9999.0))
        .bg(hsla(bg))
        .border_1()
        .border_color(border)
        .child(div().size(px(8.0)).rounded(px(9999.0)).bg(hsla(primary)))
        .child(div().size(px(8.0)).rounded(px(9999.0)).bg(hsla(accent)))
}
