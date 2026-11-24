//! Right-panel header matching real Conn (`RightPanelTabs.tsx` + `PanelLayoutControls.tsx`):
//! open-panel tabs, `+` add-panel button with a `dropdown-glass` menu, and far-right
//! maximize and close/toggle controls. Bottom-dock is deferred (`docs/scope.md` #16), so its
//! button is not drawn.

use std::rc::Rc;

use conn_state::{PanelSurface, RightPanelTab};
use conn_theme::Tokens;
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::{
    App, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString, Styled,
    Svg, Window, WindowControlArea, deferred, div, px, svg,
};

use super::color::to_hsla;
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// Header height (`--shell-header-height`, 44px).
pub(crate) const HEADER_HEIGHT_PX: f32 = 44.0;
/// Left inset on the tab strip (`pl-2`, 8px). Combined with the tab's `pl-2` (8px),
/// the first tab icon starts at 16px, aligning with panel content below.
const HEADER_PAD_START_PX: f32 = 8.0;
/// Right inset for the far-right layout controls (`--workspace-controls-right`, 11px).
const HEADER_PAD_END_PX: f32 = 11.0;
/// Open-panel tab height (`h-7`, 28px) and max width (`max-w-40`, 160px).
const TAB_HEIGHT_PX: f32 = 28.0;
const TAB_MAX_WIDTH_PX: f32 = 160.0;
/// Tab pill corner radius (`rounded-lg`, 8px).
const TAB_RADIUS_PX: f32 = 8.0;
/// Right-panel control button corner radius (`--control-radius: 6px`).
pub(crate) const CONTROL_RADIUS_PX: f32 = 6.0;
/// Add-panel `+` trigger button size (`size="icon-xs"` -> `sm:size-6`, 24px).
const ADD_BUTTON_SIZE_PX: f32 = 24.0;
/// Far-right layout toggle button size (`size="sm"` -> `sm:h-7 sm:min-w-7`, 28px).
const LAYOUT_BUTTON_SIZE_PX: f32 = 28.0;
/// Tab label font size (`text-sm`, 14px / 20px line height).
const TAB_FONT_SIZE_PX: f32 = 14.0;
const TAB_LINE_HEIGHT_PX: f32 = 20.0;
/// Standard header/tab icon size (`size-4`, 16px).
const HEADER_ICON_PX: f32 = 16.0;
/// Gap between a tab's icon slot and title (`gap-1`).
const TAB_GAP_PX: f32 = 4.0;
/// The tab's icon slot, which shows the close `X` while the tab is hovered
/// (`PanelTabCloseButton`: `size-5`, `rounded-sm`).
const TAB_CLOSE_SLOT_PX: f32 = 20.0;
const TAB_CLOSE_SLOT_RADIUS_PX: f32 = 4.0;
/// Dropdown-glass menu (`menu.tsx`): `rounded-xl` popup, `p-1` list, `min-w-[10rem]`,
/// `sideOffset={6}`; rows `min-h-7 rounded-lg px-2 py-1 gap-2 text-sm`.
const MENU_RADIUS_PX: f32 = 12.0;
const MENU_ROW_RADIUS_PX: f32 = 8.0;
const MENU_ROW_HEIGHT_PX: f32 = 28.0;
const MENU_MIN_WIDTH_PX: f32 = 160.0;
const MENU_SIDE_OFFSET_PX: f32 = 6.0;
/// Launcher rows (`RightPanelEmptyState`): `h-8` rows in a `max-w-xs` (320px) column.
const LAUNCHER_ROW_HEIGHT_PX: f32 = 32.0;
const LAUNCHER_MAX_WIDTH_PX: f32 = 320.0;
/// Menu row icons draw at 80% opacity (`[&>svg]:opacity-80`); disabled rows at 64%.
const MENU_ICON_OPACITY: f32 = 0.8;
const MENU_DISABLED_OPACITY: f32 = 0.64;
/// `MenuShortcut`: `text-xs font-medium`.
const MENU_SHORTCUT_FONT_PX: f32 = 12.0;

/// Renders a superheroicons 16/solid SVG tinted with `color`.
#[must_use]
pub(crate) fn superhero_icon(path: &'static str, size_px: f32, color: Hsla) -> Svg {
    svg()
        .path(path)
        .size(px(size_px))
        .text_color(color)
        .flex_none()
}

/// Human-readable label for a right-panel tab (Conn's `surfaceTitle` / menu labels).
#[must_use]
pub(crate) fn panel_tab_label(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Files => "Files",
        RightPanelTab::Diff => "Diff",
        RightPanelTab::Terminal => "Terminal",
        RightPanelTab::Browser => "Browser",
        RightPanelTab::Api => "API",
        RightPanelTab::Database => "Database",
        RightPanelTab::Mcp => "MCP",
        RightPanelTab::Tasks => "Tasks",
        RightPanelTab::PullRequest => "Pull request",
        RightPanelTab::LinkedItems => "Linked items",
        RightPanelTab::Device => "Device",
        RightPanelTab::File => "File",
    }
}

/// The tab title of an open surface: a file's base name, else the surface label.
#[must_use]
pub(crate) fn surface_label(surface: &PanelSurface) -> String {
    match surface {
        PanelSurface::Kind(tab) => panel_tab_label(*tab).to_owned(),
        PanelSurface::File(path) => PanelSurface::file_title(path).to_owned(),
    }
}

/// The tab icon of an open surface: a file's `@pierre/trees` type icon, else the surface icon.
#[must_use]
pub(crate) fn surface_icon_path(surface: &PanelSurface) -> &'static str {
    match surface {
        PanelSurface::Kind(tab) => panel_tab_icon_path(*tab),
        PanelSurface::File(path) => crate::file_icons::file_icon(path).asset,
    }
}

/// Optional themed tint for an open surface's tab icon (`@pierre/trees` file-type colors).
#[must_use]
fn surface_icon_color(surface: &PanelSurface, tokens: &Tokens, fallback: Hsla) -> Hsla {
    match surface {
        PanelSurface::Kind(_) => fallback,
        PanelSurface::File(path) => crate::file_icons::file_icon(path)
            .color
            .map(|c| to_hsla(c.for_appearance(tokens.appearance)))
            .unwrap_or(fallback),
    }
}

/// Icon asset for a right-panel tab: superheroicons 16/solid through Conn's manifest
/// (`Globe` browser (globe with grid), `Webhook`, `Database`, `ListTodo` checklist, `TerminalSquare`, `Files`,
/// `FileDiff`, pull request, link, `Smartphone`), and the MCP brand mark.
#[must_use]
pub(crate) fn panel_tab_icon_path(tab: RightPanelTab) -> &'static str {
    match tab {
        RightPanelTab::Files => "superhero/files.svg",
        RightPanelTab::Diff => "superhero/file-diff.svg",
        RightPanelTab::Terminal => "superhero/terminal-window.svg",
        RightPanelTab::Browser => "superhero/globe.svg",
        RightPanelTab::Api => "superhero/webhook.svg",
        RightPanelTab::Database => "superhero/database.svg",
        RightPanelTab::Mcp => "brand/mcp.svg",
        RightPanelTab::Tasks => "superhero/checklist.svg",
        RightPanelTab::PullRequest => "superhero/pull-request.svg",
        RightPanelTab::LinkedItems => "superhero/link.svg",
        RightPanelTab::Device => "superhero/phone.svg",
        RightPanelTab::File => "superhero/file.svg",
    }
}

/// One row of the surface list: the `+` menu and the empty-panel launcher draw the same rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PanelMenuItem {
    pub(crate) tab: RightPanelTab,
    pub(crate) label: &'static str,
    pub(crate) icon: &'static str,
    pub(crate) shortcut: &'static str,
    /// Offered as enabled; the rest show dimmed, as in Conn.
    pub(crate) available: bool,
}

impl PanelMenuItem {
    /// The AX identifier suffix: `Pull request` -> `pull-request`.
    fn slug(&self) -> String {
        self.label.to_ascii_lowercase().replace(' ', "-")
    }
}

/// The surface list in Conn's order (`RightPanelTab::MENU_ORDER`), the single source for the `+`
/// menu and the launcher.
#[must_use]
pub(crate) fn panel_menu_items(available_tabs: &[RightPanelTab]) -> Vec<PanelMenuItem> {
    RightPanelTab::MENU_ORDER
        .into_iter()
        .map(|tab| PanelMenuItem {
            tab,
            label: panel_tab_label(tab),
            icon: panel_tab_icon_path(tab),
            shortcut: tab.menu_shortcut(),
            available: available_tabs.contains(&tab),
        })
        .collect()
}

/// State passed to [`render_panel_header`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct PanelHeaderProps<'a> {
    pub(crate) open_tabs: &'a [PanelSurface],
    pub(crate) active_tab: &'a PanelSurface,
    pub(crate) maximized: bool,
    /// The panel is maximized while the sidebar is collapsed, so the header owns the window's
    /// top-left corner: it clears the macOS traffic lights (`90px`) and shows the `PanelLeft`
    /// sidebar reopen button, as Conn's chat header does.
    pub(crate) owns_window_leading_edge: bool,
    pub(crate) panel_open: bool,
    pub(crate) add_menu_open: bool,
    /// Surfaces the add menu offers as enabled; the rest show dimmed, as in Conn.
    pub(crate) available_tabs: &'a [RightPanelTab],
    pub(crate) tokens: &'a Tokens,
}

/// Callbacks emitted by [`render_panel_header`].
#[derive(Clone)]
pub(crate) struct PanelHeaderCallbacks {
    pub(crate) on_select_tab: Rc<dyn Fn(PanelSurface, &mut Window, &mut App)>,
    pub(crate) on_close_tab: Option<Rc<dyn Fn(PanelSurface, &mut Window, &mut App)>>,
    pub(crate) on_toggle_add_menu: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(crate) on_add_tab: Rc<dyn Fn(RightPanelTab, &mut Window, &mut App)>,
    pub(crate) on_toggle_maximize: Rc<dyn Fn(&mut Window, &mut App)>,
    pub(crate) on_toggle_panel: Rc<dyn Fn(&mut Window, &mut App)>,
    /// Reopens the sidebar (shown only when [`PanelHeaderProps::owns_window_leading_edge`]).
    pub(crate) on_open_sidebar: Rc<dyn Fn(&mut Window, &mut App)>,
}

/// Renders Conn's 44px right-panel glass header: open tabs, `+` add-panel launcher with
/// `dropdown-glass` menu, and far-right maximize and close/toggle buttons.
pub(crate) fn render_panel_header(
    props: PanelHeaderProps<'_>,
    callbacks: PanelHeaderCallbacks,
) -> impl IntoElement {
    let fg = to_hsla(props.tokens.foreground);
    let muted = to_hsla(props.tokens.muted_foreground);
    let highlight = to_hsla(props.tokens.shell_highlight);

    let mut tab_strip = h_flex()
        .id("right-panel-tab-strip")
        .a11y(gpui_kit::Role::TabList, "panel.tabs", "Right panel tabs")
        .min_w_0()
        .flex_shrink(1.0)
        .h_full()
        .items_center()
        .gap(px(4.0))
        .overflow_x_scroll();

    for (idx, tab) in props.open_tabs.iter().enumerate() {
        let active = tab == props.active_tab;
        let text_color = if active { fg } else { muted };
        let label = surface_label(tab);
        let icon_path = surface_icon_path(tab);
        let icon_color = surface_icon_color(tab, props.tokens, text_color);
        let group = SharedString::from(format!("right-panel-tab-group-{idx}"));
        let on_select = callbacks.on_select_tab.clone();
        let on_close_middle = callbacks.on_close_tab.clone();
        let on_close = callbacks.on_close_tab.clone();
        let close_hover = to_hsla(props.tokens.muted);

        // `PanelTabCloseButton`: the surface icon, swapped for an `X` while the tab is hovered.
        let close_slot = div()
            .id(SharedString::from(format!("right-panel-tab-close-{idx}")))
            .a11y_button(
                format!(
                    "panel.tab.{}.close",
                    label.to_ascii_lowercase().replace(' ', "-")
                ),
                format!("Close {label}"),
            )
            .relative()
            .flex()
            .flex_shrink_0()
            .size(px(TAB_CLOSE_SLOT_PX))
            .items_center()
            .justify_center()
            .rounded(px(TAB_CLOSE_SLOT_RADIUS_PX))
            .cursor_pointer()
            .hover(move |s| s.bg(close_hover))
            .on_mouse_down(MouseButton::Left, {
                let tab = tab.clone();
                move |_, window, cx| {
                    cx.stop_propagation();
                    if let Some(close) = &on_close {
                        close(tab.clone(), window, cx);
                    }
                }
            })
            // Both glyphs are laid out, stacked; hover only flips visibility. (A hover style
            // that changes `display` would skip prepaint for the newly shown element.)
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .group_hover(group.clone(), |s| s.invisible())
                    .child(superhero_icon(icon_path, HEADER_ICON_PX, icon_color)),
            )
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .invisible()
                    .group_hover(group.clone(), |s| s.visible())
                    .child(superhero_icon("superhero/close.svg", HEADER_ICON_PX, fg)),
            );

        let tab_ax_id = SharedString::from(format!(
            "panel.tab.{}",
            label.to_ascii_lowercase().replace(' ', "-")
        ));
        let tab_el = h_flex()
            .id(SharedString::from(format!("right-panel-tab-{idx}-{label}")))
            .a11y_tab(tab_ax_id, label.clone(), active)
            .group(group)
            .h(px(TAB_HEIGHT_PX))
            .max_w(px(TAB_MAX_WIDTH_PX))
            .flex_shrink_0()
            .pl(px(8.0))
            .pr(px(8.0))
            .gap(px(TAB_GAP_PX))
            .items_center()
            .rounded(px(TAB_RADIUS_PX))
            .cursor_pointer()
            .text_size(px(TAB_FONT_SIZE_PX))
            .line_height(px(TAB_LINE_HEIGHT_PX))
            .text_color(text_color)
            .when(active, |el| el.bg(highlight))
            .when(!active, |el| {
                el.hover(move |s| s.bg(highlight).text_color(fg))
            })
            .on_mouse_down(MouseButton::Left, {
                let tab = tab.clone();
                move |_, window, cx| {
                    cx.stop_propagation();
                    on_select(tab.clone(), window, cx);
                }
            })
            .on_mouse_down(MouseButton::Middle, {
                let tab = tab.clone();
                move |_, window, cx| {
                    if let Some(close) = &on_close_middle {
                        close(tab.clone(), window, cx);
                    }
                }
            })
            .child(close_slot)
            .child(div().min_w_0().truncate().child(label));

        tab_strip = tab_strip.child(tab_el);
    }

    // Trailing `+` trigger and anchored `dropdown-glass` add-panel menu.
    let on_toggle_add = callbacks.on_toggle_add_menu.clone();
    let add_icon_color = if props.add_menu_open { fg } else { muted };
    let mut add_anchor = div().relative().flex_shrink_0().child(
        div()
            .id("right-panel-add-btn")
            .a11y_button("panel.add-tab", "Add panel tab")
            .aria_expanded(props.add_menu_open)
            .size(px(ADD_BUTTON_SIZE_PX))
            .rounded(px(CONTROL_RADIUS_PX))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(props.add_menu_open, |el| el.bg(highlight))
            .hover(move |s| s.bg(highlight))
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                cx.stop_propagation();
                on_toggle_add(window, cx);
            })
            .child(superhero_icon(
                "superhero/add.svg",
                HEADER_ICON_PX,
                add_icon_color,
            )),
    );

    if props.add_menu_open {
        add_anchor = add_anchor.child(render_add_panel_menu(
            props.tokens,
            props.available_tabs,
            callbacks.on_add_tab,
        ));
    }

    let mut left_strip = h_flex()
        .flex_1()
        .min_w_0()
        .h_full()
        .items_center()
        .gap(px(4.0));
    if props.owns_window_leading_edge {
        // `AppSidebarLayout.tsx`: the `28x28` `PanelLeft` reopen button at `x = 90px`.
        let on_open_sidebar = callbacks.on_open_sidebar.clone();
        let sidebar_hover = to_hsla(props.tokens.sidebar_row_hover);
        left_strip = left_strip.child(
            div()
                .id("right-panel-open-sidebar")
                .a11y_button("panel.open-sidebar", "Show sidebar")
                .aria_keyshortcuts("Meta+B")
                .size(px(LAYOUT_BUTTON_SIZE_PX))
                .flex()
                .flex_shrink_0()
                .items_center()
                .justify_center()
                .rounded(px(TAB_RADIUS_PX))
                .cursor_pointer()
                .hover(move |s| s.bg(sidebar_hover))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_open_sidebar(window, cx);
                })
                .conn_tooltip("Show sidebar (⌘B)", props.tokens)
                .child(crate::icons::chrome(
                    gpui_kit::assets::IconName::PanelLeft,
                    muted,
                )),
        );
    }
    let left_strip = left_strip.child(tab_strip).child(add_anchor);

    // Far-right layout controls: maximize/restore and close/toggle right panel.
    let max_icon = if props.maximized {
        "superhero/minimize.svg"
    } else {
        "superhero/maximize.svg"
    };
    let on_max = callbacks.on_toggle_maximize;
    let on_toggle = callbacks.on_toggle_panel;

    let right_controls = h_flex()
        .flex_shrink_0()
        .h_full()
        .items_center()
        .gap(px(4.0))
        .child(header_icon_toggle(
            "right-panel-maximize-btn",
            "panel.maximize",
            if props.maximized {
                "Restore right panel"
            } else {
                "Maximize right panel"
            },
            max_icon,
            props.maximized,
            fg,
            muted,
            highlight,
            on_max,
        ))
        .child(header_icon_toggle(
            "right-panel-toggle-btn",
            "panel.toggle",
            "Toggle right panel",
            "superhero/sidebar-right.svg",
            props.panel_open,
            fg,
            muted,
            highlight,
            on_toggle,
        ));

    h_flex()
        .id("right-panel-header-bar")
        .a11y(
            gpui_kit::Role::Toolbar,
            "panel.header",
            "Right panel header",
        )
        .w_full()
        .h(px(HEADER_HEIGHT_PX))
        .flex_shrink_0()
        .pl(px(if props.owns_window_leading_edge {
            crate::shell::MACOS_TRAFFIC_LIGHTS_INSET_PX
        } else {
            HEADER_PAD_START_PX
        }))
        .pr(px(HEADER_PAD_END_PX))
        .items_center()
        .gap(px(4.0))
        .window_control_area(WindowControlArea::Drag)
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count == 2 {
                window.zoom_window();
            } else {
                window.start_window_move();
            }
        })
        .child(left_strip)
        .child(right_controls)
}

#[expect(
    clippy::too_many_arguments,
    reason = "renders one right-panel header icon toggle button with accessibility metadata"
)]
fn header_icon_toggle(
    id: &'static str,
    ax_id: &'static str,
    ax_label: &'static str,
    icon_path: &'static str,
    pressed: bool,
    fg: Hsla,
    muted: Hsla,
    highlight: Hsla,
    on_press: Rc<dyn Fn(&mut Window, &mut App)>,
) -> impl IntoElement {
    let icon_color = if pressed { fg } else { muted };
    div()
        .id(id)
        .a11y_button(ax_id, ax_label)
        .aria_selected(pressed)
        .size(px(LAYOUT_BUTTON_SIZE_PX))
        .rounded(px(CONTROL_RADIUS_PX))
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .cursor_pointer()
        .when(pressed, |el| el.bg(highlight))
        .hover(move |s| s.bg(highlight))
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            cx.stop_propagation();
            on_press(window, cx);
        })
        .child(superhero_icon(icon_path, HEADER_ICON_PX, icon_color))
}

/// `dropdown-glass` popup shadow: `shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]`,
/// `dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]` (`menu.tsx`).
#[must_use]
pub(crate) fn dropdown_glass_shadow(tokens: &Tokens) -> gpui_kit::BoxShadow {
    let (offset_y, blur, alpha) = match tokens.appearance {
        conn_theme::Appearance::Dark => (18.0, 44.0, 0.80),
        conn_theme::Appearance::Light => (16.0, 40.0, 0.55),
    };
    gpui_kit::BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, alpha),
        offset: gpui_kit::point(px(0.0), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(-18.0),
        inset: false,
    }
}

fn render_add_panel_menu(
    tokens: &Tokens,
    available_tabs: &[RightPanelTab],
    on_add_tab: Rc<dyn Fn(RightPanelTab, &mut Window, &mut App)>,
) -> impl IntoElement {
    // GPUI cannot blur what lies behind a popup, so use `dropdown-glass`'s own fallback for
    // that case (`@supports not (backdrop-filter)`: `var(--popover)`), not the 94% overlay.
    let overlay_bg = to_hsla(tokens.popover);
    let glass_border = to_hsla(tokens.foreground.with_alpha(0.08));
    let highlight = to_hsla(tokens.shell_highlight);
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    let icon_color = muted.opacity(MENU_ICON_OPACITY);
    let shadow = dropdown_glass_shadow(tokens);

    let mut list = div()
        .id("right-panel-add-menu")
        .a11y(gpui_kit::Role::Menu, "panel.add-menu", "Add panel")
        .flex()
        .flex_col()
        .min_w(px(MENU_MIN_WIDTH_PX))
        .p(px(4.0))
        .rounded(px(MENU_RADIUS_PX))
        .bg(overlay_bg)
        .border_1()
        .border_color(glass_border)
        .shadow(vec![shadow])
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation());

    for item in panel_menu_items(available_tabs) {
        let PanelMenuItem {
            tab,
            label,
            icon,
            shortcut,
            available,
        } = item;
        let on_add = on_add_tab.clone();
        let mut row = h_flex()
            .id(SharedString::from(format!("right-panel-add-{label}")))
            .a11y(
                gpui_kit::Role::MenuItem,
                format!("panel.add-menu.{}", item.slug()),
                label,
            )
            .w_full()
            .min_h(px(MENU_ROW_HEIGHT_PX))
            .px(px(8.0))
            .py(px(4.0))
            .gap(px(8.0))
            .items_center()
            .rounded(px(MENU_ROW_RADIUS_PX))
            .text_size(px(TAB_FONT_SIZE_PX))
            .line_height(px(TAB_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(superhero_icon(icon, HEADER_ICON_PX, icon_color))
            .child(div().min_w_0().truncate().child(label))
            .child(
                div()
                    .ml_auto()
                    .flex_shrink_0()
                    .text_size(px(MENU_SHORTCUT_FONT_PX))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(muted)
                    .child(shortcut),
            );
        // Browser profiles submenu is out of scope (`docs/scope.md` #17/#31): no chevron.
        row = if available {
            row.cursor_pointer()
                .hover(move |s| s.bg(highlight))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_add(tab, window, cx);
                })
        } else {
            row.opacity(MENU_DISABLED_OPACITY)
        };
        list = list.child(row);
    }

    deferred(
        div()
            .absolute()
            .top(px(ADD_BUTTON_SIZE_PX + MENU_SIDE_OFFSET_PX))
            .left(px(0.0))
            .child(list),
    )
    .with_priority(1)
}

/// The empty right panel: Conn's `RightPanelEmptyState` (`Open a surface`), the `+` menu's rows
/// listed in the panel body. Picking one opens that surface as a tab.
pub(crate) fn render_panel_launcher(
    tokens: &Tokens,
    available_tabs: &[RightPanelTab],
    on_add_tab: Rc<dyn Fn(RightPanelTab, &mut Window, &mut App)>,
) -> impl IntoElement {
    let fg = to_hsla(tokens.foreground);
    let muted = to_hsla(tokens.muted_foreground);
    // `hover:bg-accent/60`.
    let hover_bg = to_hsla(tokens.shell_highlight);

    let mut rows = div().flex().flex_col().gap(px(2.0));
    for item in panel_menu_items(available_tabs) {
        let on_add = on_add_tab.clone();
        let tab = item.tab;
        let mut row = h_flex()
            .id(SharedString::from(format!(
                "right-panel-launcher-{}",
                item.slug()
            )))
            .a11y_button(format!("panel.launcher.{}", item.slug()), item.label)
            .w_full()
            .h(px(LAUNCHER_ROW_HEIGHT_PX))
            .px(px(10.0))
            .gap(px(10.0))
            .items_center()
            .rounded(px(CONTROL_RADIUS_PX))
            .text_size(px(TAB_FONT_SIZE_PX))
            .line_height(px(TAB_LINE_HEIGHT_PX))
            .text_color(fg)
            .child(superhero_icon(item.icon, HEADER_ICON_PX, fg))
            .child(div().flex_1().min_w_0().truncate().child(item.label))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(MENU_SHORTCUT_FONT_PX))
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(muted)
                    .child(item.shortcut),
            );
        row = if item.available {
            row.cursor_pointer()
                .hover(move |s| s.bg(hover_bg))
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    cx.stop_propagation();
                    on_add(tab, window, cx);
                })
        } else {
            // `opacity-50`.
            row.opacity(0.5)
        };
        rows = rows.child(row);
    }

    div()
        .id("right-panel-launcher")
        .a11y_group("panel.launcher", "Open a surface")
        .flex()
        .flex_1()
        .min_h_0()
        .items_center()
        .justify_center()
        .px(px(24.0))
        .child(
            div()
                .w_full()
                .max_w(px(LAUNCHER_MAX_WIDTH_PX))
                .py(px(24.0))
                .child(
                    div()
                        .mb(px(12.0))
                        .text_center()
                        .text_size(px(TAB_FONT_SIZE_PX))
                        .line_height(px(TAB_LINE_HEIGHT_PX))
                        .font_weight(gpui_kit::FontWeight::MEDIUM)
                        .text_color(fg)
                        .child("Open a surface"),
                )
                .child(rows),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_kit::AssetSource as _;

    #[test]
    fn add_menu_matches_conn_order_and_shortcuts() {
        let rows: Vec<(&str, &str)> = RightPanelTab::MENU_ORDER
            .iter()
            .map(|t| (panel_tab_label(*t), t.menu_shortcut()))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("Browser", "B"),
                ("API", "R"),
                ("Database", "Q"),
                ("MCP", "I"),
                ("Tasks", "K"),
                ("Terminal", "T"),
                ("Files", "F"),
                ("Diff", "D"),
                ("Pull request", "P"),
                ("Linked items", "L"),
                ("Device", "M"),
            ]
        );
        assert_eq!(
            RightPanelTab::from_menu_shortcut("q"),
            Some(RightPanelTab::Database)
        );
    }

    #[test]
    fn menu_and_launcher_share_one_item_list() {
        let items = panel_menu_items(&[RightPanelTab::Browser, RightPanelTab::Tasks]);
        let order: Vec<RightPanelTab> = items.iter().map(|item| item.tab).collect();
        assert_eq!(order, RightPanelTab::MENU_ORDER.to_vec());
        let available: Vec<&str> = items
            .iter()
            .filter(|item| item.available)
            .map(|item| item.label)
            .collect();
        assert_eq!(available, ["Browser", "Tasks"]);
        assert_eq!(items[8].slug(), "pull-request");
        assert_eq!(items[0].icon, panel_tab_icon_path(RightPanelTab::Browser));
    }

    #[test]
    fn header_superhero_icons_exist_in_embedded_assets() {
        let assets = crate::superhero::AppAssets;
        let mut paths: Vec<&str> = RightPanelTab::MENU_ORDER
            .iter()
            .map(|t| panel_tab_icon_path(*t))
            .collect();
        paths.extend([
            "superhero/chevron-right.svg",
            "superhero/add.svg",
            "superhero/close.svg",
            "superhero/maximize.svg",
            "superhero/minimize.svg",
            "superhero/panel-bottom.svg",
            "superhero/sidebar-right.svg",
        ]);
        for path in paths {
            let loaded = assets.load(path).expect("asset load should not fail");
            assert!(
                loaded.is_some(),
                "header superheroicon `{path}` must exist in embedded assets"
            );
        }
    }
}
