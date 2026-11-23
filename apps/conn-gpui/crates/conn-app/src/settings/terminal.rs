//! Settings → Terminal: font, spacing and cursor, applied live to the terminal view and drawer.
//!
//! Web Conn's Typography page has the terminal font family, size and line height; this page
//! adds the font weight, letter spacing and cursor that a terminal also needs. Values live in
//! [`crate::terminal_settings`], which saves them and repaints every window.

use conn_state::terminal_settings::{
    CursorStyle, FONT_WEIGHT_STEP, FONT_WEIGHTS, TerminalSettings, clamp_weight_to_axis,
    nearest_weight, snap_weight, weight_name,
};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Div, ElementId, Entity, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, div, px,
};

use super::SettingsModal;
use super::controls::{pill_switch, settings_bare_section, settings_row, settings_section};
use crate::a11y::ConnA11yExt as _;
use crate::fonts::axes::{FamilyWeights, family_weights};
use crate::panels::chrome::{MenuEntry, MenuRow, dropdown_menu};
use crate::terminal_settings;
use crate::theme::hsla;
use gpui_kit::prelude::FluentBuilder as _;

const CONTROL_H_PX: f32 = 28.0;
/// The font weight control's width, slider or dropdown: fixed, right-aligned, so the label and its
/// description keep their column (Nick, #338).
const WEIGHT_CONTROL_W_PX: f32 = 180.0;
/// The value beside the slider (`425`).
const WEIGHT_READOUT_W_PX: f32 = 32.0;

/// The font family the terminal draws with: the saved one, else the theme's monospace font.
fn effective_family(settings: &TerminalSettings) -> String {
    if settings.font_family.is_empty() {
        crate::theme::MONO_FONT.to_owned()
    } else {
        settings.font_family.clone()
    }
}

/// The weights shown for `family`: its own when static (named, ascending), the named weights
/// when the family is unknown.
fn static_choices(weights: &FamilyWeights) -> Vec<u16> {
    match weights {
        FamilyWeights::Static(weights) => weights.clone(),
        _ => FONT_WEIGHTS.iter().map(|(weight, _)| *weight).collect(),
    }
}

/// `Regular · 400`.
fn weight_label(weight: u16) -> String {
    match weight_name(weight) {
        Some(name) => format!("{name} \u{b7} {weight}"),
        None => weight.to_string(),
    }
}

/// The weight slider's range for a variable font: its axis, on the 25 step.
fn slider_range(min: f32, max: f32) -> (f32, f32) {
    let step = f32::from(FONT_WEIGHT_STEP);
    ((min / step).ceil() * step, (max / step).floor() * step)
}

/// Settings → Terminal's font weight control state: the slider of a variable font, which is
/// rebuilt when its range changes (a new family), and whether the static dropdown is open.
pub(super) struct TerminalWeightUi {
    slider: Entity<SliderState>,
    _sub: Subscription,
    menu_open: bool,
}

impl TerminalWeightUi {
    pub(super) fn new(cx: &mut Context<'_, SettingsModal>) -> Self {
        let (slider, sub) = Self::build_slider(cx);
        Self {
            slider,
            _sub: sub,
            menu_open: false,
        }
    }

    /// A slider over the current family's weight axis (the whole 0 to 900 range when it has none),
    /// at the saved weight kept inside it.
    fn build_slider(cx: &mut Context<'_, SettingsModal>) -> (Entity<SliderState>, Subscription) {
        let settings = terminal_settings::current(cx);
        let (min, max) = match family_weights(&effective_family(&settings)) {
            FamilyWeights::Variable { min, max } => slider_range(min, max),
            _ => (0.0, 900.0),
        };
        let value = f32::from(settings.font_weight).clamp(min, max);
        let slider = cx.new(|_| {
            SliderState::new()
                .min(min)
                .max(max)
                .step(f32::from(FONT_WEIGHT_STEP))
                .default_value(value)
        });
        let sub = cx.subscribe(&slider, |_this, _slider, event: &SliderEvent, cx| {
            if let SliderEvent::Change(value) = event {
                let weight = snap_weight(value.end());
                let weight =
                    match family_weights(&effective_family(&terminal_settings::current(cx))) {
                        FamilyWeights::Variable { min, max } => {
                            clamp_weight_to_axis(weight, min, max)
                        }
                        _ => weight,
                    };
                terminal_settings::update(cx, |s| s.font_weight = weight);
            }
        });
        (slider, sub)
    }

    /// Follows a new family or a reset: a new range and the saved weight.
    pub(super) fn rebuild(&mut self, cx: &mut Context<'_, SettingsModal>) {
        let (slider, sub) = Self::build_slider(cx);
        self.slider = slider;
        self._sub = sub;
        self.menu_open = false;
    }
}

impl SettingsModal {
    /// The Terminal page: one raised group of rows, as Conn's other settings pages.
    pub(super) fn render_terminal_page(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let settings = terminal_settings::current(cx);
        let tokens = &self.tokens;
        let geometry = &self.geometry;

        let family = div()
            .w(px(220.0))
            .h(px(CONTROL_H_PX))
            .child(gpui_kit::component::input::Input::new(
                &self.terminal_family_input,
            ))
            .into_any_element();

        let size = stepper(
            "terminal-font-size",
            "Font size",
            format!("{} px", trim_float(settings.font_size, 0)),
            self,
            cx,
            |s, d| s.font_size = s.stepped_font_size(d),
        );
        let line_height = stepper(
            "terminal-line-height",
            "Line height",
            format!("{:.2}", settings.line_height),
            self,
            cx,
            |s, d| s.line_height = s.stepped_line_height(d),
        );
        let spacing = stepper(
            "terminal-letter-spacing",
            "Letter spacing",
            format!("{} px", trim_float(settings.letter_spacing, 2)),
            self,
            cx,
            |s, d| s.letter_spacing = s.stepped_letter_spacing(d),
        );

        let family_weights = family_weights(&effective_family(&settings));
        let (weight, weight_description) = self.weight_control(&settings, &family_weights, cx);

        let cursor_options: Vec<(String, bool, TerminalChange)> = CursorStyle::ALL
            .iter()
            .map(|style| {
                let style = *style;
                (
                    style.label().to_owned(),
                    settings.cursor_style == style,
                    Box::new(move |s: &mut TerminalSettings| s.cursor_style = style)
                        as TerminalChange,
                )
            })
            .collect();
        let cursor = segmented("terminal-cursor-style", cursor_options, self, cx);

        let blink = pill_switch(
            "conn-settings-terminal-cursor-blink",
            settings.cursor_blink,
            tokens,
            move |_window, cx| {
                terminal_settings::update(cx, |s| s.cursor_blink = !s.cursor_blink);
            },
        )
        .into_any_element();

        let reset = {
            let hover = hsla(tokens.shell_highlight);
            div()
                .id("terminal-settings-reset")
                .a11y_button("settings.terminal.reset", "Reset terminal settings")
                .h(px(CONTROL_H_PX))
                .px(px(12.0))
                .flex()
                .items_center()
                .rounded(px(6.0))
                .border_1()
                .border_color(hsla(tokens.shell_divider_header))
                .bg(hsla(tokens.shell_control))
                .cursor_pointer()
                .text_size(px(geometry.ui_font_size_px))
                .text_color(hsla(tokens.foreground))
                .hover(move |s| s.bg(hover))
                .on_click(cx.listener(|this, _, window, cx| {
                    terminal_settings::update(cx, |s| *s = TerminalSettings::default());
                    this.sync_terminal_family_input(window, cx);
                    this.terminal_weight.rebuild(cx);
                }))
                .child("Reset")
                .into_any_element()
        };

        let rows = vec![
            settings_row(
                "Font family",
                Some("A font installed on this Mac. Empty uses the theme's monospace font."),
                family,
                tokens,
                geometry,
            ),
            settings_row("Font size", Some("8 to 20 pixels."), size, tokens, geometry),
            settings_row(
                "Font weight",
                Some(weight_description),
                weight,
                tokens,
                geometry,
            ),
            settings_row(
                "Line height",
                Some("A multiple of the font size, 1 to 2."),
                line_height,
                tokens,
                geometry,
            ),
            settings_row(
                "Letter spacing",
                Some("Extra space after each character."),
                spacing,
                tokens,
                geometry,
            ),
            settings_row("Cursor style", None, cursor, tokens, geometry),
            settings_row(
                "Blinking cursor",
                Some("Blinks only while the terminal has focus."),
                blink,
                tokens,
                geometry,
            ),
            settings_row(
                "Reset",
                Some("Back to the defaults."),
                reset,
                tokens,
                geometry,
            ),
        ];

        // The example sits under the rows, in the terminal's colours and the settings above, with
        // no card around it: the terminal box carries its own border (Nick, #336).
        let example = crate::panels::terminal_demo::render_terminal_demo(&settings, tokens)
            .into_any_element();
        div()
            .flex()
            .flex_col()
            .gap(px(20.0))
            .w_full()
            .child(settings_section("Terminal", rows, tokens, geometry))
            .child(settings_bare_section("Example", example, tokens, geometry))
            .into_any_element()
    }

    /// The font weight control and its description: a slider with a value for a variable font, a
    /// dropdown of the weights the family has for a static one. Both are `WEIGHT_CONTROL_W_PX`
    /// wide.
    fn weight_control(
        &self,
        settings: &TerminalSettings,
        weights: &FamilyWeights,
        cx: &mut Context<'_, Self>,
    ) -> (AnyElement, &'static str) {
        let tokens = &self.tokens;
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        match weights {
            FamilyWeights::Variable { min, max } => {
                let weight = clamp_weight_to_axis(settings.font_weight, *min, *max);
                let control = div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(10.0))
                    .w(px(WEIGHT_CONTROL_W_PX))
                    .h(px(CONTROL_H_PX))
                    .child(
                        div().flex_1().min_w_0().child(
                            Slider::new(&self.terminal_weight.slider)
                                .accessibility_label("Font weight"),
                        ),
                    )
                    .child(
                        div()
                            .id("terminal-font-weight-value")
                            .a11y_group(
                                "settings.terminal-font-weight.value",
                                format!("Font weight: {weight}"),
                            )
                            .w(px(WEIGHT_READOUT_W_PX))
                            .flex_none()
                            .flex()
                            .justify_end()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(fg)
                            .child(weight.to_string()),
                    )
                    .into_any_element();
                (control, "Drag for any weight, 25 at a time.")
            }
            _ => {
                let choices = static_choices(weights);
                let current = nearest_weight(settings.font_weight, &choices);
                let open = self.terminal_weight.menu_open;
                let entity = cx.entity();
                let trigger = div()
                    .id("terminal-font-weight-trigger")
                    .a11y_button(
                        "settings.terminal-font-weight",
                        format!("Font weight: {}", weight_label(current)),
                    )
                    .aria_expanded(open)
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.0))
                    .w_full()
                    .h(px(CONTROL_H_PX))
                    .px(px(10.0))
                    .rounded(px(6.0))
                    .border_1()
                    .border_color(hsla(tokens.shell_divider_header))
                    .bg(hsla(tokens.shell_control))
                    .cursor_pointer()
                    .text_color(fg)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.terminal_weight.menu_open = !this.terminal_weight.menu_open;
                        cx.notify();
                    }))
                    .child(div().min_w_0().truncate().child(weight_label(current)))
                    .child(crate::panels::header::superhero_icon(
                        "superhero/chevron-down.svg",
                        12.0,
                        muted,
                    ));
                let mut wrapper = div()
                    .id("terminal-font-weight-select")
                    .relative()
                    .w(px(WEIGHT_CONTROL_W_PX))
                    .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                        if this.terminal_weight.menu_open {
                            this.terminal_weight.menu_open = false;
                            cx.notify();
                        }
                    }))
                    .child(trigger);
                if open {
                    let entries = choices
                        .iter()
                        .map(|weight| {
                            let weight = *weight;
                            let entity = entity.clone();
                            MenuEntry::Row(MenuRow {
                                id: SharedString::from(format!("terminal-font-weight-{weight}")),
                                label: weight_label(weight).into(),
                                mono: false,
                                checked: weight == current,
                                on_select: Box::new(move |_, cx| {
                                    terminal_settings::update(cx, |s| s.font_weight = weight);
                                    entity.update(cx, |this, cx| {
                                        this.terminal_weight.menu_open = false;
                                        cx.notify();
                                    });
                                }),
                            })
                        })
                        .collect();
                    wrapper = wrapper.child(dropdown_menu(
                        "terminal-font-weight-menu",
                        tokens,
                        entries,
                        crate::theme::MONO_FONT.into(),
                        CONTROL_H_PX,
                    ));
                }
                (wrapper.into_any_element(), "The weights this font has.")
            }
        }
    }

    /// Writes the saved family into the text field (after a reset).
    pub(super) fn sync_terminal_family_input(
        &mut self,
        window: &mut gpui_kit::Window,
        cx: &mut Context<'_, Self>,
    ) {
        let family = terminal_settings::current(cx).font_family;
        self.terminal_family_input
            .update(cx, |input, cx| input.set_value(family, window, cx));
    }
}

/// A change to the settings, applied by [`terminal_settings::update`].
type TerminalChange = Box<dyn Fn(&mut TerminalSettings)>;

/// `12 px`-style numbers: whole numbers without decimals, others to `places` without trailing zeros.
fn trim_float(value: f32, places: usize) -> String {
    let text = format!("{value:.places$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    }
}

fn control_box(tokens: &conn_theme::Tokens) -> Div {
    div()
        .flex()
        .flex_row()
        .items_center()
        .h(px(CONTROL_H_PX))
        .rounded(px(6.0))
        .border_1()
        .border_color(hsla(tokens.shell_divider_header))
        .bg(hsla(tokens.shell_control))
        .overflow_hidden()
}

/// `−  value  +`: one click changes the value by one step.
fn stepper(
    id: &'static str,
    label: &'static str,
    value: String,
    modal: &SettingsModal,
    cx: &mut Context<'_, SettingsModal>,
    change: fn(&mut TerminalSettings, f32),
) -> AnyElement {
    let tokens = &modal.tokens;
    let hover = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let step_button = |suffix: &'static str,
                       glyph: &'static str,
                       delta: f32,
                       cx: &mut Context<'_, SettingsModal>| {
        div()
            .id(SharedString::from(format!("{id}-{suffix}")))
            .a11y_button(
                SharedString::from(format!("settings.{id}.{suffix}")),
                format!("{label} {suffix}"),
            )
            .w(px(CONTROL_H_PX))
            .h_full()
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .text_color(fg)
            .hover(move |s| s.bg(hover))
            .on_click(cx.listener(move |_, _, _, cx| {
                terminal_settings::update(cx, |s| change(s, delta));
            }))
            .child(glyph)
    };
    control_box(tokens)
        .child(step_button("decrease", "\u{2212}", -1.0, cx))
        .child(
            div()
                .id(SharedString::from(format!("{id}-value")))
                .a11y_group(
                    SharedString::from(format!("settings.{id}.value")),
                    format!("{label}: {value}"),
                )
                .min_w(px(64.0))
                .flex()
                .items_center()
                .justify_center()
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(value),
        )
        .child(step_button("increase", "+", 1.0, cx))
        .into_any_element()
}

/// One selected choice among a few, as a row of segments.
fn segmented(
    id: &'static str,
    options: Vec<(String, bool, TerminalChange)>,
    modal: &SettingsModal,
    cx: &mut Context<'_, SettingsModal>,
) -> AnyElement {
    let tokens = &modal.tokens;
    let hover = hsla(tokens.shell_highlight);
    let fg = hsla(tokens.foreground);
    let muted = hsla(tokens.muted_foreground);
    let selected_bg = hsla(tokens.shell_highlight);
    let mut row = control_box(tokens);
    for (index, (label, selected, change)) in options.into_iter().enumerate() {
        let slug = label.to_ascii_lowercase();
        let element_id: ElementId = SharedString::from(format!("{id}-{slug}")).into();
        row = row.child(
            div()
                .id(element_id)
                .a11y_button(
                    SharedString::from(format!("settings.{id}.{slug}")),
                    label.clone(),
                )
                .px(px(10.0))
                .h_full()
                .flex()
                .items_center()
                .cursor_pointer()
                .when(index > 0, |el| {
                    el.border_l_1()
                        .border_color(hsla(tokens.shell_divider_header))
                })
                .when(selected, |el| el.bg(selected_bg))
                .text_color(if selected { fg } else { muted })
                .when(!selected, |el| el.hover(move |s| s.bg(hover)))
                .on_click(cx.listener(move |_, _, _, cx| {
                    terminal_settings::update(cx, |s| change(s));
                }))
                .child(label),
        );
    }
    row.into_any_element()
}

#[cfg(test)]
mod weight_control_tests {
    use super::*;

    #[test]
    fn labels_name_the_weight_and_the_dropdown_lists_only_the_familys_weights() {
        assert_eq!(weight_label(400), "Regular \u{b7} 400");
        assert_eq!(weight_label(600), "Semibold \u{b7} 600");
        assert_eq!(weight_label(425), "425");
        let menlo_like = FamilyWeights::Static(vec![400, 700]);
        assert_eq!(static_choices(&menlo_like), vec![400, 700]);
        // An unknown family has nothing to limit the list: the nine named weights.
        assert_eq!(static_choices(&FamilyWeights::Unknown).len(), 9);
    }

    #[test]
    fn the_slider_spans_the_axis_on_the_step() {
        assert_eq!(slider_range(100.0, 800.0), (100.0, 800.0));
        assert_eq!(slider_range(1.0, 1000.0), (25.0, 1000.0));
        assert_eq!(slider_range(110.0, 790.0), (125.0, 775.0));
    }
}
