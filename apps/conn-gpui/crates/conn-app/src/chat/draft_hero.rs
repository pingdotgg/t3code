//! New-thread draft hero: the composer sits vertically centered on the chat card with the
//! headline and project combobox directly above it (`ChatView.tsx` `isDraftHeroState`,
//! `DraftHeroHeadline.tsx`, `DraftHeroProjectHeading.tsx`, `DraftProjectName.tsx`).

use gpui_kit::TestSupportExt as _;
use gpui_kit::component::input::{Escape, Input, InputEvent, InputState, MoveDown, MoveUp};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, TextRun, Window, canvas, deferred, div, px,
};

use super::color::hsla;
use super::composer_state::{
    ProjectPickerItem, ProjectPickerRow, new_thread_draft_key, project_picker_rows,
};
use super::{
    CHAT_CONTENT_MAX_WIDTH_PX, CHAT_LANE_PADDING_X_PX, ChatEvent, ChatView, DraftViewInfo, icons,
};
use crate::a11y::ConnA11yExt as _;
use crate::panels::chrome::ConnTooltipExt as _;

/// `text-3xl` heading (`30px` / `36px`).
const HEADING_FONT_PX: f32 = 30.0;
const HEADING_LINE_HEIGHT_PX: f32 = 36.0;
/// Stacked project name under the heading (`text-base`).
const STACKED_PROJECT_FONT_PX: f32 = 16.0;
const STACKED_PROJECT_LINE_HEIGHT_PX: f32 = 24.0;
/// Second line: `mt-2 h-6 text-sm`.
const SUBLINE_FONT_PX: f32 = 14.0;
const SUBLINE_HEIGHT_PX: f32 = 24.0;
/// `lg:` breakpoint for the inline heading.
const INLINE_HEADING_MIN_VIEWPORT_PX: f32 = 1024.0;
/// Combobox popup width (`w-72`).
const PICKER_WIDTH_PX: f32 = 288.0;
/// Combobox list max height (`max-h-[min(var(--available-height),23rem)]` less the search row).
const PICKER_LIST_MAX_HEIGHT_PX: f32 = 320.0;
/// Gap between the headline and the composer card (`pb-4`).
const HEADLINE_GAP_PX: f32 = 16.0;

const BUILD_IN_PREFIX: &str = "What should we build in";
const BUILD_IN_SUFFIX: &str = "?";
const BUILD_STACKED: &str = "What should we build?";
const SCRATCH_HEADING: &str = "What should we work on?";
const ADD_PROJECT_LABEL: &str = "Add project";

/// Hero-only state owned by [`ChatView`].
pub(super) struct DraftHeroState {
    pub(super) menu_open: bool,
    pub(super) search: Entity<InputState>,
    pub(super) highlighted: usize,
    /// Last measured headline container width, used to choose the inline or stacked heading.
    pub(super) container_width: f32,
    _search_sub: Subscription,
}

impl DraftHeroState {
    pub(super) fn new(window: &mut Window, cx: &mut Context<'_, ChatView>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search projects..."));
        let sub = cx.subscribe_in(
            &search,
            window,
            |view, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => {
                    view.hero.highlighted = 0;
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => view.pick_highlighted_draft_row(window, cx),
                _ => {}
            },
        );
        Self {
            menu_open: false,
            search,
            highlighted: 0,
            container_width: CHAT_CONTENT_MAX_WIDTH_PX,
            _search_sub: sub,
        }
    }
}

impl ChatView {
    /// The picker moves the draft to `project_id` (`DraftHeroHeadline` `selectProject`). Content
    /// follows; an empty draft stays and the project's own draft shows. Returns `true` when the
    /// content moved. Call before the app swaps in the new [`DraftViewInfo`].
    pub(crate) fn retarget_draft_project(
        &mut self,
        project_id: &str,
        cx: &mut Context<'_, Self>,
    ) -> bool {
        let Some(draft) = &self.draft else {
            return false;
        };
        let key = new_thread_draft_key(&draft.environment_id, project_id);
        self.composer
            .update(cx, |c, cx| c.retarget_draft_key(&key, cx))
    }

    /// Clears the shown draft once it is sent or discarded (`clearDraftThread`). Call before the
    /// app swaps out the [`DraftViewInfo`].
    pub(crate) fn discard_draft(&mut self, cx: &mut Context<'_, Self>) {
        let Some(draft) = &self.draft else {
            return;
        };
        let key = new_thread_draft_key(&draft.environment_id, &draft.project_id);
        self.composer.update(cx, |c, _| c.discard_draft_key(&key));
    }

    fn draft_picker_rows(&self, cx: &Context<'_, Self>) -> Vec<ProjectPickerRow> {
        let Some(draft) = &self.draft else {
            return Vec::new();
        };
        let query = self.hero.search.read(cx).value().to_string();
        project_picker_rows(
            draft.projects.iter().map(|p| ProjectPickerItem {
                id: &p.id,
                title: &p.title,
                pinned: p.pinned,
                is_scratch: p.is_scratch,
            }),
            &query,
        )
    }

    fn toggle_draft_project_picker(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if self.hero.menu_open {
            self.close_draft_project_picker(window, cx);
            return;
        }
        self.hero.menu_open = true;
        self.hero.search.update(cx, |input, cx| {
            input.set_value("", window, cx);
            input.focus(window, cx);
        });
        let active = self.draft.as_ref().map(|d| d.project_id.clone());
        self.hero.highlighted = self
            .draft_picker_rows(cx)
            .iter()
            .position(
                |row| matches!(row, ProjectPickerRow::Project(id) if Some(id) == active.as_ref()),
            )
            .unwrap_or(0);
        cx.notify();
    }

    /// Closes the combobox and returns focus to the composer (`finalFocus`).
    pub(super) fn close_draft_project_picker(
        &mut self,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        if !self.hero.menu_open {
            return;
        }
        self.hero.menu_open = false;
        self.composer.update(cx, |c, cx| c.focus_input(window, cx));
        cx.notify();
    }

    fn move_draft_highlight(&mut self, delta: isize, cx: &mut Context<'_, Self>) {
        let len = self.draft_picker_rows(cx).len();
        if len == 0 {
            return;
        }
        let current = self.hero.highlighted.min(len - 1);
        self.hero.highlighted = current
            .checked_add_signed(delta)
            .map_or(len - 1, |next| next % len);
        cx.notify();
    }

    fn pick_highlighted_draft_row(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        let rows = self.draft_picker_rows(cx);
        if let Some(row) = rows.get(self.hero.highlighted).cloned() {
            self.pick_draft_row(row, window, cx);
        }
    }

    fn pick_draft_row(
        &mut self,
        row: ProjectPickerRow,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        self.close_draft_project_picker(window, cx);
        match row {
            ProjectPickerRow::AddProject => cx.emit(ChatEvent::DraftAddProject),
            ProjectPickerRow::Project(id) => {
                if self.draft.as_ref().is_some_and(|d| d.project_id != id) {
                    cx.emit(ChatEvent::DraftProjectSelected(id));
                }
            }
        }
    }

    /// Full chat-card layout while composing a draft: headline above, composer centered,
    /// notices detached below so they never move the centered card.
    pub(super) fn render_draft_hero(
        &mut self,
        draft: &DraftViewInfo,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let lane = || {
            div()
                .w_full()
                .max_w(px(CHAT_CONTENT_MAX_WIDTH_PX))
                .mx_auto()
        };
        let headline = self.render_draft_headline(draft, window, cx);
        let mut below = lane().flex().flex_col().gap(px(4.0)).pt(px(16.0));
        if let Some(error) = self.error_banner.clone() {
            below = below.child(self.render_error_banner(&error, cx));
        }

        div()
            .id("chat-draft-hero")
            .test_support()
            .a11y_group("chat.draft-hero", "New thread")
            .flex()
            .flex_col()
            .size_full()
            .min_h_0()
            .min_w_0()
            .px(px(CHAT_LANE_PADDING_X_PX))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|view, _, window, cx| view.close_draft_project_picker(window, cx)),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .justify_end()
                    .child(lane().pb(px(HEADLINE_GAP_PX)).child(headline)),
            )
            .child(lane().flex_none().child(self.composer.clone()))
            .child(div().flex_1().flex().flex_col().child(below))
            .into_any_element()
    }

    fn render_draft_headline(
        &mut self,
        draft: &DraftViewInfo,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let weak = cx.weak_entity();
        let measured = self.hero.container_width;
        let measure = canvas(
            move |bounds, _window, cx| {
                let width = f32::from(bounds.size.width);
                if (width - measured).abs() > 0.5 {
                    cx.defer(move |cx| {
                        let _ = weak.update(cx, |view, cx| {
                            view.hero.container_width = width;
                            cx.notify();
                        });
                    });
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .inset_0();

        let heading = || {
            div()
                .text_size(px(HEADING_FONT_PX))
                .line_height(px(HEADING_LINE_HEIGHT_PX))
                .font_weight(FontWeight::NORMAL)
                .text_color(fg)
        };

        let mut root = div()
            .relative()
            .w_full()
            .flex()
            .flex_col()
            .items_center()
            .child(measure);

        if draft.is_scratch {
            root = root.child(heading().w_full().text_center().child(SCRATCH_HEADING));
        } else if self.heading_fits_inline(draft, window) {
            root = root.child(
                div()
                    .flex()
                    .flex_row()
                    .items_baseline()
                    .justify_center()
                    .gap(px(8.0))
                    .w_full()
                    .child(heading().flex_shrink_0().child(BUILD_IN_PREFIX))
                    .child(
                        heading()
                            .flex()
                            .flex_row()
                            .min_w_0()
                            .child(self.render_project_trigger(
                                draft,
                                &draft.project_title,
                                HEADING_FONT_PX,
                                HEADING_LINE_HEIGHT_PX,
                                cx,
                            ))
                            .child(BUILD_IN_SUFFIX),
                    ),
            );
        } else {
            root = root.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(8.0))
                    .w_full()
                    .child(heading().text_center().child(BUILD_STACKED))
                    .child(
                        div()
                            .flex()
                            .justify_center()
                            .max_w_full()
                            .text_size(px(STACKED_PROJECT_FONT_PX))
                            .line_height(px(STACKED_PROJECT_LINE_HEIGHT_PX))
                            .text_color(fg)
                            .child(self.render_project_trigger(
                                draft,
                                &draft.project_title,
                                STACKED_PROJECT_FONT_PX,
                                STACKED_PROJECT_LINE_HEIGHT_PX,
                                cx,
                            )),
                    ),
            );
        }

        if draft.scratch_available {
            let subline = div()
                .mt(px(8.0))
                .h(px(SUBLINE_HEIGHT_PX))
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(SUBLINE_FONT_PX))
                .line_height(px(SUBLINE_HEIGHT_PX));
            if draft.is_scratch {
                root = root.child(subline.text_color(fg).child(self.render_project_trigger(
                    draft,
                    "No project",
                    SUBLINE_FONT_PX,
                    SUBLINE_HEIGHT_PX,
                    cx,
                )));
            } else if !draft.launching {
                root = root.child(subline.child(self.render_start_without_project(cx)));
            }
        }

        root.into_any_element()
    }

    /// Inline when the viewport is `lg` and the one-line heading fits the measured container.
    fn heading_fits_inline(&self, draft: &DraftViewInfo, window: &mut Window) -> bool {
        if f32::from(window.viewport_size().width) < INLINE_HEADING_MIN_VIEWPORT_PX {
            return false;
        }
        let font = window.text_style().font();
        let run = |len: usize, weight: FontWeight| TextRun {
            len,
            font: gpui_kit::Font {
                weight,
                ..font.clone()
            },
            color: gpui_kit::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let size = px(HEADING_FONT_PX);
        let text_system = window.text_system();
        let prefix = text_system.shape_line(
            SharedString::from(BUILD_IN_PREFIX),
            size,
            &[run(BUILD_IN_PREFIX.len(), FontWeight::NORMAL)],
            None,
        );
        let title = format!("{}{BUILD_IN_SUFFIX}", draft.project_title);
        let name = text_system.shape_line(
            SharedString::from(title.clone()),
            size,
            &[run(title.len(), FontWeight::MEDIUM)],
            None,
        );
        f32::from(prefix.width) + 8.0 + f32::from(name.width) <= self.hero.container_width
    }

    /// `InlineButton tone="picker"` combobox trigger plus its popup.
    fn render_project_trigger(
        &self,
        draft: &DraftViewInfo,
        label: &str,
        font_px: f32,
        line_height_px: f32,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let fg = hsla(self.tokens.foreground);
        let open = self.hero.menu_open;
        let can_choose = !draft.launching;
        let mut trigger = div()
            .id("draft-project-picker")
            .a11y_button(
                "chat.draft.project-picker",
                format!("Project: {}", draft.project_title),
            )
            .aria_expanded(open)
            .min_w_0()
            .max_w_full()
            .truncate()
            .text_size(px(font_px))
            .line_height(px(line_height_px))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .when(open, |el| el.underline())
            .child(label.to_owned());
        if can_choose {
            trigger = trigger
                .cursor_pointer()
                .hover(|s| s.underline())
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(|view, _, window, cx| {
                    view.toggle_draft_project_picker(window, cx);
                }));
        }
        if !draft.is_scratch {
            trigger = trigger.conn_tooltip(draft.project_title.clone(), &self.tokens);
        }

        let mut slot = div().relative().min_w_0().child(trigger);
        if open && can_choose {
            slot = slot.child(
                deferred(
                    div()
                        .absolute()
                        .top_full()
                        .left_0()
                        .right_0()
                        .mt(px(4.0))
                        .flex()
                        .justify_center()
                        .child(self.render_project_popup(draft, cx)),
                )
                .with_priority(3),
            );
        }
        slot.into_any_element()
    }

    fn render_project_popup(
        &self,
        draft: &DraftViewInfo,
        cx: &mut Context<'_, Self>,
    ) -> AnyElement {
        let tokens = &self.tokens;
        let fg = hsla(tokens.foreground);
        let muted = hsla(tokens.muted_foreground);
        let border = hsla(tokens.foreground.with_alpha(0.08));
        let highlight_bg = hsla(tokens.foreground.with_alpha(0.09));
        let search_border = hsla(tokens.border.with_alpha(0.70));
        let rows = self.draft_picker_rows(cx);
        let highlighted = self.hero.highlighted.min(rows.len().saturating_sub(1));

        let search = div().px(px(12.0)).pt(px(10.0)).child(
            div()
                .relative()
                .flex()
                .flex_row()
                .items_center()
                .pb(px(6.0))
                .border_b_1()
                .border_color(search_border)
                .child(div().absolute().left_0().top(px(5.0)).child(icons::icon(
                    "superhero/search.svg",
                    16.0,
                    muted.opacity(0.55),
                )))
                .child(
                    div().flex_1().min_w_0().h(px(26.0)).pl(px(20.0)).child(
                        Input::new(&self.hero.search)
                            .appearance(false)
                            .text_size(px(14.0)),
                    ),
                ),
        );

        let mut list = div()
            .id("draft-project-menu")
            .flex()
            .flex_col()
            .max_h(px(PICKER_LIST_MAX_HEIGHT_PX))
            .overflow_y_scroll()
            .p(px(4.0));
        if rows.is_empty() {
            list = list.child(
                div()
                    .p(px(8.0))
                    .text_center()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(muted)
                    .child("No matching projects."),
            );
        }
        for (idx, row) in rows.into_iter().enumerate() {
            let (key, label, leading): (SharedString, String, AnyElement) = match &row {
                ProjectPickerRow::AddProject => (
                    "chat.draft.project.add".into(),
                    ADD_PROJECT_LABEL.to_owned(),
                    icons::icon("superhero/folder-add.svg", 16.0, muted).into_any_element(),
                ),
                ProjectPickerRow::Project(id) => {
                    let Some(option) = draft.projects.iter().find(|p| &p.id == id) else {
                        continue;
                    };
                    (
                        format!("chat.draft.project.{id}").into(),
                        option.title.clone(),
                        crate::sidebar::render_project_favicon(&option.shell, 16.0, tokens)
                            .into_any_element(),
                    )
                }
            };
            let is_selected =
                matches!(&row, ProjectPickerRow::Project(id) if *id == draft.project_id);
            list = list.child(
                div()
                    .id(("draft-project-opt", idx))
                    .a11y_button(key, label.clone())
                    .aria_selected(is_selected)
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.0))
                    .min_h(px(28.0))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(8.0))
                    .cursor_pointer()
                    .text_size(px(14.0))
                    .line_height(px(20.0))
                    .text_color(fg)
                    .when(idx == highlighted, |el| el.bg(highlight_bg))
                    .on_mouse_move(cx.listener(move |view, _, _, cx| {
                        if view.hero.highlighted != idx {
                            view.hero.highlighted = idx;
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |view, _, window, cx| {
                        view.pick_draft_row(row.clone(), window, cx);
                    }))
                    .child(leading)
                    .child(div().flex_1().min_w_0().truncate().child(label)),
            );
        }

        div()
            .id("draft-project-popup")
            .w(px(PICKER_WIDTH_PX))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(12.0))
            .bg(hsla(tokens.popover))
            .border_1()
            .border_color(border)
            .shadow(vec![crate::panels::header::dropdown_glass_shadow(tokens)])
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .capture_action(cx.listener(|view, _: &MoveUp, _, cx| {
                view.move_draft_highlight(-1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|view, _: &MoveDown, _, cx| {
                view.move_draft_highlight(1, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|view, _: &Escape, window, cx| {
                view.close_draft_project_picker(window, cx);
                cx.stop_propagation();
            }))
            .child(search)
            .child(list)
            .into_any_element()
    }

    /// `or start without a project` (`InlineButton tone="muted"`).
    fn render_start_without_project(&self, cx: &mut Context<'_, Self>) -> AnyElement {
        let muted = hsla(self.tokens.muted_foreground);
        let fg = hsla(self.tokens.foreground);
        div()
            .id("draft-start-scratch")
            .a11y_button("chat.draft.start-scratch", "or start without a project")
            .cursor_pointer()
            .font_weight(FontWeight::MEDIUM)
            .text_color(muted)
            .hover(move |s| s.text_color(fg).underline())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(|_, _, _, cx| cx.emit(ChatEvent::DraftStartScratch)))
            .child("or start without a project")
            .into_any_element()
    }
}
