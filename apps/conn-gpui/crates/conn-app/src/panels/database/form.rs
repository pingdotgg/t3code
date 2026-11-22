//! Add/Edit connection form (`ConnectionForm` in Conn's `DatabasePanel.tsx`) and Conn's
//! `outline` / `ghost` `size="sm"` buttons shared with the Database empty state.

use conn_desktop::database::DatabaseDriver;
use conn_desktop::database::api::PanelConnection;
use conn_theme::{Appearance, Tokens};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{
    AnyElement, App, BoxShadow, ClickEvent, Context, Div, ElementId, Entity, FontWeight,
    IntoElement, ParentElement, SharedString, Stateful, Styled, Subscription, Window, div, point,
    px,
};

use super::super::chrome::{self, UI_LINE_HEIGHT_PX, UI_TEXT_PX, XS_LINE_HEIGHT_PX, XS_TEXT_PX};
use super::super::color::to_hsla;
use super::super::header::{CONTROL_RADIUS_PX, superhero_icon};
use super::DatabasePanel;
use super::store::{default_port_placeholder, name_placeholder, parse_port_input};

/// Conn's `Button size="sm"` (`sm:h-7`, 28px; `text-sm`, 14px / 20px; `gap-1.5`, 6px;
/// `px-[calc(--spacing(2.5)-1px)]`, 9px; `rounded-(--control-radius)`, 6px).
const SM_BUTTON_HEIGHT_PX: f32 = 28.0;
const SM_BUTTON_PAD_X_PX: f32 = 9.0;
const SM_TEXT_PX: f32 = 14.0;
const SM_LINE_HEIGHT_PX: f32 = 20.0;
const PILL_RADIUS_PX: f32 = 9999.0;

/// State for the open connection editor form (`editing` in `DatabasePanel.tsx`).
pub(crate) struct ConnectionFormState {
    pub(crate) draft: PanelConnection,
    name_input: Entity<InputState>,
    host_input: Entity<InputState>,
    port_input: Entity<InputState>,
    database_input: Entity<InputState>,
    username_input: Entity<InputState>,
    password_input: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ConnectionFormState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionFormState")
            .field("draft", &self.draft)
            .finish_non_exhaustive()
    }
}

impl ConnectionFormState {
    pub(crate) fn new(
        initial: PanelConnection,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) -> Self {
        let initial_name_placeholder = name_placeholder(&initial);
        let initial_port_placeholder = default_port_placeholder(initial.connection.driver);

        let name_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(initial_name_placeholder);
            state.set_value(initial.name.clone(), window, cx);
            state
        });
        let host_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder("127.0.0.1");
            state.set_value(initial.connection.host.clone(), window, cx);
            state
        });
        let port_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).placeholder(initial_port_placeholder);
            let value = initial
                .connection
                .port
                .map_or_else(String::new, |port| port.to_string());
            state.set_value(value, window, cx);
            state
        });
        let database_input = cx.new(|cx| {
            let placeholder = if initial.connection.driver == DatabaseDriver::Sqlite {
                "/Users/me/app/database/database.sqlite"
            } else {
                ""
            };
            let mut state = InputState::new(window, cx).placeholder(placeholder);
            state.set_value(initial.connection.database.clone(), window, cx);
            state
        });
        let username_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(initial.connection.username.clone(), window, cx);
            state
        });
        let password_input = cx.new(|cx| {
            let mut state = InputState::new(window, cx).masked(true);
            state.set_value(initial.connection.password.clone(), window, cx);
            state
        });

        let subscriptions = vec![
            subscribe_field(&name_input, FormField::Name, window, cx),
            subscribe_field(&host_input, FormField::Host, window, cx),
            subscribe_field(&port_input, FormField::Port, window, cx),
            subscribe_field(&database_input, FormField::Database, window, cx),
            subscribe_field(&username_input, FormField::Username, window, cx),
            subscribe_field(&password_input, FormField::Password, window, cx),
        ];

        Self {
            draft: initial,
            name_input,
            host_input,
            port_input,
            database_input,
            username_input,
            password_input,
            _subscriptions: subscriptions,
        }
    }

    pub(crate) fn set_driver(
        &mut self,
        driver: DatabaseDriver,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) {
        if self.draft.connection.driver == driver {
            return;
        }
        self.draft.connection.driver = driver;
        let port_placeholder = default_port_placeholder(driver);
        self.port_input
            .update(cx, |s, cx| s.set_placeholder(port_placeholder, window, cx));
        let db_placeholder = if driver == DatabaseDriver::Sqlite {
            "/Users/me/app/database/database.sqlite"
        } else {
            ""
        };
        self.database_input
            .update(cx, |s, cx| s.set_placeholder(db_placeholder, window, cx));
        self.refresh_name_placeholder(window, cx);
        cx.notify();
    }

    pub(crate) fn refresh_name_placeholder(
        &self,
        window: &mut Window,
        cx: &mut Context<'_, DatabasePanel>,
    ) {
        let placeholder = name_placeholder(&self.draft);
        self.name_input
            .update(cx, |s, cx| s.set_placeholder(placeholder, window, cx));
    }

    pub(crate) fn can_save(&self) -> bool {
        !self.draft.connection.database.trim().is_empty()
    }

    pub(crate) fn render(
        &self,
        tokens: &Tokens,
        cx: &mut Context<'_, DatabasePanel>,
    ) -> AnyElement {
        let entity = cx.entity();
        let driver = self.draft.connection.driver;
        let sqlite = driver == DatabaseDriver::Sqlite;
        let can_save = self.can_save();

        // Driver selector inside `ToolbarGroup className="w-fit"`.
        let mut driver_group = chrome::toolbar_group(tokens);
        for candidate in DatabaseDriver::ALL {
            let active = candidate == driver;
            let entity = entity.clone();
            let hover = to_hsla(tokens.shell_highlight);
            let fg = to_hsla(tokens.foreground);
            let muted = to_hsla(tokens.muted_foreground);
            driver_group = driver_group.child(
                h_flex()
                    .id(SharedString::from(format!(
                        "db-driver-{}",
                        candidate.label()
                    )))
                    .h(px(24.0))
                    .px(px(7.0))
                    .items_center()
                    .rounded(px(PILL_RADIUS_PX))
                    .cursor_pointer()
                    .text_size(px(XS_TEXT_PX))
                    .line_height(px(XS_LINE_HEIGHT_PX))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if active { fg } else { muted })
                    .when(active, |el| el.bg(hover))
                    .hover(move |s| s.bg(hover).text_color(fg))
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |panel, cx| {
                            if let Some(form) = &mut panel.editing {
                                form.set_driver(candidate, window, cx);
                            }
                        });
                    })
                    .child(candidate.label()),
            );
        }

        let mut form = v_flex()
            .id("db-connection-form")
            .flex_1()
            .min_h_0()
            .w_full()
            .overflow_y_scroll()
            .gap(px(12.0))
            .px(px(16.0))
            .py(px(12.0))
            .child(labeled_field(
                "Name",
                tokens,
                soft_text_input(&self.name_input, tokens),
            ))
            .child(labeled_field(
                "Driver",
                tokens,
                h_flex().child(driver_group),
            ));

        if sqlite {
            form = form.child(labeled_field(
                "File on this Mac",
                tokens,
                soft_text_input(&self.database_input, tokens),
            ));
        } else {
            form = form
                .child(
                    h_flex()
                        .w_full()
                        .gap(px(12.0))
                        .child(div().flex_1().min_w_0().child(labeled_field(
                            "Host",
                            tokens,
                            soft_text_input(&self.host_input, tokens),
                        )))
                        .child(div().w(px(96.0)).flex_shrink_0().child(labeled_field(
                            "Port",
                            tokens,
                            soft_text_input(&self.port_input, tokens),
                        ))),
                )
                .child(labeled_field(
                    "Database",
                    tokens,
                    soft_text_input(&self.database_input, tokens),
                ))
                .child(labeled_field(
                    "Username",
                    tokens,
                    soft_text_input(&self.username_input, tokens),
                ))
                .child(labeled_field(
                    "Password",
                    tokens,
                    soft_text_input(&self.password_input, tokens),
                ));
        }

        let entity_cancel = entity.clone();
        let entity_save = entity;
        form = form.child(
            h_flex()
                .w_full()
                .justify_end()
                .gap(px(8.0))
                .pt(px(4.0))
                .child(ghost_sm_button(
                    "db-form-cancel",
                    "Cancel",
                    tokens,
                    move |_, _, cx| {
                        entity_cancel.update(cx, |panel, cx| panel.cancel_editing(cx));
                    },
                ))
                .child(outline_sm_button(
                    "db-form-save",
                    None,
                    "Save connection",
                    tokens,
                    !can_save,
                    move |_, window, cx| {
                        entity_save.update(cx, |panel, cx| panel.save_editing(window, cx));
                    },
                )),
        );

        form.into_any_element()
    }
}

#[derive(Clone, Copy)]
enum FormField {
    Name,
    Host,
    Port,
    Database,
    Username,
    Password,
}

fn subscribe_field(
    input: &Entity<InputState>,
    field: FormField,
    window: &Window,
    cx: &mut Context<'_, DatabasePanel>,
) -> Subscription {
    cx.subscribe_in(
        input,
        window,
        move |panel, input: &Entity<InputState>, event: &InputEvent, window, cx| match event {
            InputEvent::Change => {
                let value = input.read(cx).value().to_string();
                let Some(form) = &mut panel.editing else {
                    return;
                };
                let mut target_changed = false;
                match field {
                    FormField::Name => form.draft.name = value,
                    FormField::Host => {
                        form.draft.connection.host = value;
                        target_changed = true;
                    }
                    FormField::Port => {
                        form.draft.connection.port = parse_port_input(&value);
                        target_changed = true;
                    }
                    FormField::Database => {
                        form.draft.connection.database = value;
                        target_changed = true;
                    }
                    FormField::Username => form.draft.connection.username = value,
                    FormField::Password => form.draft.connection.password = value,
                }
                if target_changed {
                    form.refresh_name_placeholder(window, cx);
                }
                cx.notify();
            }
            InputEvent::PressEnter { .. } => {
                if panel
                    .editing
                    .as_ref()
                    .is_some_and(ConnectionFormState::can_save)
                {
                    panel.save_editing(window, cx);
                }
            }
            InputEvent::Focus | InputEvent::Blur => {}
        },
    )
}

fn labeled_field(
    label: &'static str,
    tokens: &Tokens,
    control: impl IntoElement,
) -> impl IntoElement {
    v_flex()
        .w_full()
        .gap(px(6.0))
        .child(
            div()
                .text_size(px(UI_TEXT_PX))
                .line_height(px(UI_LINE_HEIGHT_PX))
                .text_color(to_hsla(tokens.muted_foreground))
                .child(label),
        )
        .child(control)
}

/// Conn's `fieldClass`: `h-8 w-full rounded-(--toolbar-radius) border border-(--shell-divider-header)!
/// bg-(--shell-field) px-3 text-ui text-foreground`.
fn soft_text_input(state: &Entity<InputState>, tokens: &Tokens) -> impl IntoElement {
    let hover = to_hsla(tokens.shell_control);
    h_flex()
        .w_full()
        .h(px(chrome::CONTROL_HEIGHT_PX))
        .items_center()
        .rounded(px(PILL_RADIUS_PX))
        .bg(to_hsla(tokens.shell_field))
        .border_1()
        .border_color(to_hsla(tokens.shell_divider_header))
        .px(px(12.0))
        .text_size(px(UI_TEXT_PX))
        .text_color(to_hsla(tokens.foreground))
        .hover(move |s| s.bg(hover))
        .child(
            div().flex_1().min_w_0().child(
                Input::new(state)
                    .appearance(false)
                    .text_size(px(UI_TEXT_PX)),
            ),
        )
}

/// Conn's `Button variant="ghost" size="sm"`.
pub(crate) fn ghost_sm_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let hover = to_hsla(tokens.shell_highlight);
    h_flex()
        .id(id)
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(SM_BUTTON_PAD_X_PX))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .cursor_pointer()
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground))
        .hover(move |s| s.bg(hover))
        .on_click(on_click)
        .child(label.into())
}

/// Conn's `Button variant="outline" size="sm"` (used by `+ Add connection` and `Save connection`).
pub(crate) fn outline_sm_button(
    id: impl Into<ElementId>,
    icon_path: Option<&'static str>,
    label: impl Into<SharedString>,
    tokens: &Tokens,
    disabled: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let (bg, hover_bg) = match tokens.appearance {
        Appearance::Light => (
            to_hsla(tokens.popover),
            chrome::alpha(tokens.shell_highlight, 0.5),
        ),
        Appearance::Dark => (
            chrome::alpha(tokens.input, 0.32),
            chrome::alpha(tokens.input, 0.64),
        ),
    };
    let shadow = match tokens.appearance {
        Appearance::Light => Some(BoxShadow {
            color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.05),
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(2.0),
            spread_radius: px(0.0),
            inset: false,
        }),
        Appearance::Dark => None,
    };

    let mut button = h_flex()
        .id(id)
        .flex_shrink_0()
        .h(px(SM_BUTTON_HEIGHT_PX))
        .px(px(SM_BUTTON_PAD_X_PX))
        .gap(px(6.0))
        .items_center()
        .justify_center()
        .rounded(px(CONTROL_RADIUS_PX))
        .bg(bg)
        .border_1()
        .border_color(to_hsla(tokens.input))
        .text_size(px(SM_TEXT_PX))
        .line_height(px(SM_LINE_HEIGHT_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(to_hsla(tokens.foreground));

    if let Some(shadow) = shadow
        && !disabled
    {
        button = button.shadow(vec![shadow]);
    }
    if let Some(path) = icon_path {
        button = button.child(superhero_icon(path, 16.0, to_hsla(tokens.muted_foreground)));
    }
    button = button.child(label.into());

    if disabled {
        button.opacity(0.64)
    } else {
        button
            .cursor_pointer()
            .hover(move |s| s.bg(hover_bg))
            .on_click(on_click)
    }
}
