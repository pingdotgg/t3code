//! Thread hover flyout (`ThreadHoverCard.tsx`, `SidebarThreadRow.tsx` `SidebarThreadTooltip`).
//!
//! Hovering a sidebar thread row opens a glass card to the right of the row (`side="right"
//! align="start" sideOffset={4}`). Conn's sidebar `TooltipProvider` uses `delay=150`,
//! `closeDelay=0`, `timeout=400`: the card opens `150ms` after the pointer enters, closes at
//! once on leave, and a row entered within `400ms` of a close opens at once.
//!
//! The card is a child of the hovered row. A canvas inside the row records the row's window
//! bounds each frame; the card is then placed from them (level with the row's top, see
//! `hover_card_state::card_origin`), so it follows the list's scroll position. It has no
//! hitbox, so the pointer passes through it.

use std::time::Instant;

use conn_contract::PullRequestState;
use conn_state::{ProjectShell, ThreadShell};
use conn_theme::Tokens;
use gpui_kit::{
    AnyElement, BoxShadow, Context, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Styled as _, TestSupportExt as _, WeakEntity, anchored, canvas, deferred, div,
    point, px,
};

use crate::a11y::ConnA11yExt as _;
use crate::app::ConnApp;
use crate::icons;
use crate::sidebar::hover_card_state::{
    COLLISION_PADDING_PX, Entered, HoverError, HoverPullRequest, OPEN_DELAY, RowRect, RowRectCell,
    card_height, card_origin, fitting_pr_lines, hover_card_model,
};
use crate::sidebar::render_project_favicon;
use crate::sidebar::thread_list::middle_truncate;
use crate::theme::{MONO_FONT, hsla, hsla_alpha};

/// `max-w-80`.
const CARD_MAX_WIDTH_PX: f32 = 320.0;
/// `rounded-lg` (the row card's corner radius).
const CARD_RADIUS_PX: f32 = 8.0;
/// `text-ui`.
const UI_FONT_PX: f32 = 13.0;
const UI_LINE_PX: f32 = 20.0;
/// `text-sm leading-tight`.
const TITLE_FONT_PX: f32 = 14.0;
const TITLE_LINE_PX: f32 = 17.5;
/// `size-3`.
const ICON_PX: f32 = 12.0;
/// Characters of branch that fit one row at `max-w-80` (`MiddleTruncate`, ~7px per glyph).
const BRANCH_CHAR_BUDGET: usize = 38;

impl ConnApp {
    /// Row `on_hover` handler.
    pub(crate) fn thread_hover_changed(
        &mut self,
        thread_id: &str,
        hovered: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let now = Instant::now();
        if !hovered {
            if self.thread_hover.leave(thread_id, now) {
                cx.notify();
            }
            return;
        }
        if self.thread_hover_suppressed() {
            return;
        }
        match self.thread_hover.enter(thread_id, now) {
            Entered::Shown => cx.notify(),
            Entered::Unchanged => {}
            Entered::Wait(generation) => {
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(OPEN_DELAY).await;
                    let _ = this.update(cx, |app, cx| {
                        if app.thread_hover.elapse(generation) {
                            cx.notify();
                        }
                    });
                })
                .detach();
            }
        }
    }

    /// Closes the card (row press, context menu, rename, list scroll).
    pub(crate) fn dismiss_thread_hover(&mut self, cx: &mut Context<'_, Self>) {
        if self.thread_hover.dismiss() {
            cx.notify();
        }
    }
}

/// `shadow-xl shadow-black/25`: Tailwind's two `shadow-xl` layers recoloured.
fn card_shadow() -> Vec<BoxShadow> {
    let layer = |y: f32, blur: f32, spread: f32| BoxShadow {
        color: gpui_kit::hsla(0.0, 0.0, 0.0, 0.25),
        offset: point(px(0.0), px(y)),
        blur_radius: px(blur),
        spread_radius: px(spread),
        inset: false,
    };
    vec![layer(20.0, 25.0, -5.0), layer(8.0, 10.0, -6.0)]
}

fn detail_row(
    key: &'static str,
    ax_label: String,
    icon: AnyElement,
    text: impl Into<SharedString>,
    color: gpui_kit::Hsla,
) -> AnyElement {
    div()
        .id(key)
        .test_support()
        .a11y_group(format!("sidebar.thread-hover-card.{key}"), ax_label)
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .child(icon)
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_color(color)
                .child(text.into()),
        )
        .into_any_element()
}

fn pull_request_line(
    idx: usize,
    pr: &HoverPullRequest,
    tokens: &Tokens,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let (icon, color) = match pr.state {
        Some((PullRequestState::Open, false)) => {
            ("superhero/pull-request.svg", hsla(tokens.success))
        }
        Some((PullRequestState::Open, true)) => (
            "superhero/pull-request-draft.svg",
            hsla(tokens.muted_foreground),
        ),
        Some((PullRequestState::Closed, _)) => (
            "superhero/pull-request-closed.svg",
            hsla(tokens.destructive),
        ),
        Some((PullRequestState::Merged, _)) => ("superhero/merge.svg", hsla(tokens.info)),
        None => ("superhero/pull-request.svg", hsla(tokens.muted_foreground)),
    };
    div()
        .id(("hover-card-pr", idx))
        .a11y_group(
            format!("sidebar.thread-hover-card.pr.{idx}"),
            format!("Pull request #{}: {}", pr.number, pr.title),
        )
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .min_w_0()
        .child(icons::concept(icon, ICON_PX, color))
        .child(
            div()
                .flex_shrink_0()
                .font_family(SharedString::from(MONO_FONT))
                .child(format!("#{}", pr.number)),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_color(hsla_alpha(tokens.foreground, 0.75))
                .child(pr.title.clone()),
        )
}

/// Renders the measuring canvas and, once the row has been measured, the card level with it.
#[must_use]
pub(crate) fn render_thread_hover_card(
    thread: &ThreadShell,
    project: Option<&ProjectShell>,
    environment_label: Option<&str>,
    environment_icon: &'static str,
    rect: &RowRectCell,
    app: WeakEntity<ConnApp>,
    tokens: &Tokens,
) -> AnyElement {
    let measure = {
        let rect = rect.clone();
        canvas(
            move |bounds, window, cx| {
                let measured = RowRect {
                    x: f32::from(bounds.origin.x),
                    y: f32::from(bounds.origin.y),
                    width: f32::from(bounds.size.width),
                    height: f32::from(bounds.size.height),
                    viewport_height: f32::from(window.viewport_size().height),
                };
                if rect.get() != Some(measured) {
                    rect.set(Some(measured));
                    cx.defer(move |cx| {
                        let _ = app.update(cx, |_, cx| cx.notify());
                    });
                }
            },
            |_, (), _, _| {},
        )
        // `-1px` covers the row's transparent top border, so the rect starts at the row's edge.
        .absolute()
        .top(px(-1.0))
        .left_0()
        .right_0()
        .bottom_0()
    };
    let wrapper = div().absolute().inset_0().child(measure);
    let Some(row) = rect.get() else {
        return wrapper.into_any_element();
    };
    let mut model = hover_card_model(thread, project, environment_label);
    model.pull_requests.truncate(fitting_pr_lines(&model, &row));
    let (card_x, card_y) = card_origin(&row, card_height(&model, model.pull_requests.len()));
    let muted = hsla(tokens.muted_foreground);
    let text = hsla_alpha(tokens.foreground, 0.75);
    let icon = |path: &'static str, color| icons::concept(path, ICON_PX, color).into_any_element();

    let mut rows = div()
        .flex()
        .flex_col()
        .gap(px(6.0))
        .pl(px(2.0))
        .text_size(px(UI_FONT_PX))
        .line_height(px(UI_LINE_PX))
        .text_color(muted);

    if let Some(name) = &model.project {
        let mut row = div()
            .id("hover-card-project")
            .a11y_group(
                "sidebar.thread-hover-card.project",
                format!("Project {name}"),
            )
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.0))
            .min_w_0();
        if let Some(project) = project {
            row = row.child(render_project_favicon(project, ICON_PX, tokens));
        }
        rows = rows.child(
            row.child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(text)
                    .child(name.clone()),
            ),
        );
    }
    if let Some(label) = &model.environment {
        rows = rows.child(detail_row(
            "environment",
            format!("Environment {label}"),
            icon(environment_icon, muted),
            label.clone(),
            text,
        ));
    }
    if let Some(branch) = &model.branch {
        rows = rows.child(detail_row(
            "branch",
            format!("Branch {branch}"),
            icon("superhero/branch.svg", muted),
            middle_truncate(branch, BRANCH_CHAR_BUDGET),
            text,
        ));
    }
    // The linked issues live here, not on the row: the issue icon and its key, or how many.
    if let Some(issues) = &model.issues {
        rows = rows.child(detail_row(
            "issues",
            issues.label.clone(),
            icon("superhero/circle-dot.svg", muted),
            issues.label.clone(),
            text,
        ));
    }
    let provider_mark = icons::provider_mark(
        &thread.provider_instance_id,
        ICON_PX,
        hsla_alpha(tokens.foreground, 0.60),
    );
    let model_label = if model.model.is_empty() {
        model.provider.clone()
    } else {
        model.model.clone()
    };
    rows = rows.child(detail_row(
        "model",
        format!("Model {model_label}"),
        div()
            .flex()
            .flex_shrink_0()
            .opacity(0.6)
            .child(provider_mark)
            .into_any_element(),
        model_label,
        text,
    ));
    if let Some(count) = model.subagents {
        let noun = if count == 1 { "subagent" } else { "subagents" };
        rows = rows.child(detail_row(
            "subagents",
            format!("{count} {noun}"),
            icon("superhero/agent.svg", muted),
            format!("{count} {noun}"),
            text,
        ));
    }
    if let Some(from) = &model.handed_off_from {
        rows = rows.child(detail_row(
            "handoff",
            format!("Handed off from {from}"),
            icon("superhero/switch.svg", muted),
            format!("Handed off from {from}"),
            text,
        ));
    }
    if let Some(error) = model.error {
        let color = match error {
            HoverError::UsageLimit => hsla(tokens.warning),
            HoverError::Failed => hsla(tokens.destructive),
        };
        rows = rows.child(detail_row(
            "error",
            error.label().to_owned(),
            icon("superhero/warning.svg", color),
            error.label(),
            color,
        ));
    }

    let mut body = div()
        .flex()
        .flex_col()
        .gap(px(8.0))
        .min_w_0()
        .max_w(px(CARD_MAX_WIDTH_PX))
        .px(px(4.0))
        .py(px(8.0))
        .child(
            div()
                .id("hover-card-title")
                .a11y(
                    gpui_kit::Role::Heading,
                    "sidebar.thread-hover-card.title",
                    model.title.clone(),
                )
                .min_w_0()
                .truncate()
                .text_size(px(TITLE_FONT_PX))
                .line_height(px(TITLE_LINE_PX))
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(hsla(tokens.foreground))
                .child(model.title.clone()),
        )
        .child(
            rows.id("hover-card-details")
                .a11y_group("sidebar.thread-hover-card.details", "Thread details"),
        );

    if !model.pull_requests.is_empty() {
        body = body.child(
            div()
                .id("hover-card-prs")
                .a11y_group("sidebar.thread-hover-card.prs", "Linked pull requests")
                .flex()
                .flex_col()
                .gap(px(6.0))
                .min_w_0()
                .pt(px(8.0))
                .pl(px(2.0))
                .border_t_1()
                .border_color(hsla(tokens.glass_divider))
                .text_size(px(UI_FONT_PX))
                .line_height(px(UI_LINE_PX))
                .text_color(muted)
                .children(
                    model
                        .pull_requests
                        .iter()
                        .enumerate()
                        .map(|(idx, pr)| pull_request_line(idx, pr, tokens)),
                ),
        );
    }

    // `dropdown-glass`: GPUI cannot blur what lies behind a popup, so it uses the opaque
    // `@supports not (backdrop-filter)` fallback (`var(--popover)`), as the other popovers do.
    let card = div()
        .id("sidebar-thread-hover-card")
        .test_support()
        .a11y(
            gpui_kit::Role::Tooltip,
            "sidebar.thread-hover-card",
            format!("Thread preview: {}", model.title),
        )
        .flex()
        .flex_col()
        .max_w(px(CARD_MAX_WIDTH_PX))
        .rounded(px(CARD_RADIUS_PX))
        .px(px(8.0))
        .py(px(4.0))
        .bg(hsla(tokens.popover))
        .border_1()
        .border_color(hsla(tokens.glass_divider))
        .shadow(card_shadow())
        .child(body);

    wrapper
        .child(
            deferred(
                anchored()
                    .position(point(px(card_x), px(card_y)))
                    .snap_to_window_with_margin(px(COLLISION_PADDING_PX))
                    .child(card),
            )
            .with_priority(5),
        )
        .into_any_element()
}
