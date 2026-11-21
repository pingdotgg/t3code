//! Browser right-panel placeholder with soft URL address bar.
//!
//! The orchestrator wires `conn-web` (CEF) into this surface later.

use std::fmt;

use conn_theme::Tokens;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::{Context, Entity, IntoElement, ParentElement, Render, Styled, Window, div, px};

use super::color::to_hsla;

const UI_TEXT_PX: f32 = 13.0;
const UI_LINE_HEIGHT_PX: f32 = 20.0;
const TOOLBAR_PAD_Y_PX: f32 = 7.5;
const TOOLBAR_PAD_START_PX: f32 = 16.0;
const TOOLBAR_PAD_END_PX: f32 = 11.5;

/// Placeholder Browser panel with Conn's soft URL bar.
pub(crate) struct BrowserPanel {
    tokens: Tokens,
    url_input: Entity<InputState>,
}

impl fmt::Debug for BrowserPanel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrowserPanel").finish_non_exhaustive()
    }
}

impl BrowserPanel {
    pub(crate) fn new(tokens: Tokens, window: &mut Window, cx: &mut Context<'_, Self>) -> Self {
        let url_input = cx.new(|cx| InputState::new(window, cx).placeholder("Enter URL..."));
        Self { tokens, url_input }
    }

    pub(crate) fn set_tokens(&mut self, tokens: Tokens, cx: &mut Context<'_, Self>) {
        self.tokens = tokens;
        cx.notify();
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<'_, Self>) -> impl IntoElement {
        let field_bg = to_hsla(self.tokens.shell_field);
        let field_border = to_hsla(self.tokens.shell_divider_header);
        let divider = to_hsla(self.tokens.shell_divider);
        let muted = to_hsla(self.tokens.muted_foreground);
        let fg = to_hsla(self.tokens.foreground);
        let tile_bg = to_hsla(self.tokens.shell_tile);
        let tile_border = to_hsla(self.tokens.shell_tile_border);

        v_flex()
            .size_full()
            .child(
                h_flex()
                    .w_full()
                    .pt(px(TOOLBAR_PAD_Y_PX))
                    .pb(px(TOOLBAR_PAD_Y_PX))
                    .pl(px(TOOLBAR_PAD_START_PX))
                    .pr(px(TOOLBAR_PAD_END_PX))
                    .items_center()
                    .child(
                        h_flex()
                            .flex_1()
                            .h(px(32.0))
                            .rounded(px(9999.0))
                            .bg(field_bg)
                            .border_1()
                            .border_color(field_border)
                            .pl(px(10.0))
                            .pr(px(10.0))
                            .gap(px(6.0))
                            .items_center()
                            .child(Icon::new(IconName::Globe).size(px(14.0)).text_color(muted))
                            .child(
                                div().flex_1().min_w_0().child(
                                    Input::new(&self.url_input)
                                        .appearance(false)
                                        .text_size(px(UI_TEXT_PX)),
                                ),
                            ),
                    ),
            )
            .child(div().w_full().h(px(1.0)).bg(divider))
            .child(
                v_flex()
                    .flex_1()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap(px(10.0))
                    .child(
                        div()
                            .size(px(40.0))
                            .rounded(px(10.0))
                            .bg(tile_bg)
                            .border_1()
                            .border_color(tile_border)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(Icon::new(IconName::Globe).size(px(18.0)).text_color(fg)),
                    )
                    .child(
                        div()
                            .text_size(px(UI_TEXT_PX))
                            .line_height(px(UI_LINE_HEIGHT_PX))
                            .text_color(muted)
                            .child("Embedded browser preview connects here."),
                    ),
            )
    }
}
