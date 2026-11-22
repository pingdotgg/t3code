//! Lightweight turning-arc spinner for active tool calls and the Working row.
//!
//! Only schedules a repaint timer when actually rendered in the element tree, so idle
//! views incur zero timer wakeups and zero GPU repaints.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, AppContext as _, Bounds, EntityId, HighlightStyle, Hsla, IntoElement, PathBuilder, Pixels,
    RenderOnce, Rgba, Styled as _, StyledText, Window, canvas, fill, point, px, size,
};

/// Full rotation period in seconds.
const TURN_SECONDS: f32 = 0.9;
/// ~30 fps refresh interval so spinners stay smooth without pegging high-refresh displays.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Fraction of the ring drawn (three-quarters arc).
const ARC_SWEEP: f32 = 0.75;

/// Shimmer period matching Conn's `live-tool-shine 2.2s steps(30) infinite` (`index.css:620`).
const SHIMMER_PERIOD_MS: u128 = 2_200;
const SHIMMER_STEPS: u128 = 30;
/// Half-width of the glowing highlight band in characters (~4.5rem band).
const SHIMMER_BAND_HALF_CHARS: f32 = 5.0;
/// Step interval (`2200ms / 30` ≈ 73 ms, ~13.6 fps) — gentle on GPU while matching Conn's cadence.
pub(super) const SHIMMER_STEP_INTERVAL: Duration = Duration::from_millis(73);

/// Renders `text` with Conn's left-to-right `live-tool-shine` shimmer sweeping a highlight band
/// from `base` (muted) up to `highlight` (foreground) and back.
#[must_use]
pub(super) fn shimmer_text(text: &str, base: Hsla, highlight: Hsla) -> StyledText {
    static START: OnceLock<Instant> = OnceLock::new();
    let elapsed_ms = START.get_or_init(Instant::now).elapsed().as_millis();
    let step = ((elapsed_ms % SHIMMER_PERIOD_MS) * SHIMMER_STEPS) / SHIMMER_PERIOD_MS;
    let phase = (step as f32) / (SHIMMER_STEPS as f32);

    let char_count = text.chars().count();
    if char_count == 0 {
        return StyledText::new(String::new());
    }

    let base_rgba: Rgba = base.into();
    let hi_rgba: Rgba = highlight.into();
    let center =
        -SHIMMER_BAND_HALF_CHARS + phase * ((char_count as f32) + 2.0 * SHIMMER_BAND_HALF_CHARS);

    let mut highlights = Vec::with_capacity(char_count);
    for (idx, (byte_start, ch)) in text.char_indices().enumerate() {
        let byte_end = byte_start + ch.len_utf8();
        let dist = ((idx as f32) - center).abs() / SHIMMER_BAND_HALF_CHARS;
        let weight = if dist < 1.0 {
            0.5 * (1.0 + (dist * std::f32::consts::PI).cos())
        } else {
            0.0
        };
        let color: Hsla = Rgba {
            r: base_rgba.r + (hi_rgba.r - base_rgba.r) * weight,
            g: base_rgba.g + (hi_rgba.g - base_rgba.g) * weight,
            b: base_rgba.b + (hi_rgba.b - base_rgba.b) * weight,
            a: base_rgba.a + (hi_rgba.a - base_rgba.a) * weight,
        }
        .into();
        highlights.push((
            byte_start..byte_end,
            HighlightStyle {
                color: Some(color),
                ..Default::default()
            },
        ));
    }

    StyledText::new(text.to_owned()).with_highlights(highlights)
}

thread_local! {
    /// Views that already have a pending spinner tick timer.
    static TICKING: RefCell<HashSet<EntityId>> = RefCell::new(HashSet::new());
}

/// Three-quarter turning arc spinner painted directly on a GPUI canvas.
#[derive(IntoElement)]
pub(super) struct TurningArc {
    side: f32,
    color: Hsla,
}

impl TurningArc {
    pub(super) fn new(side: f32, color: Hsla) -> Self {
        Self { side, color }
    }
}

impl RenderOnce for TurningArc {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let color = self.color;
        canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                paint_arc(bounds, color, window);
                schedule_next_frame(window, cx);
            },
        )
        .flex_none()
        .size(px(self.side))
    }
}

fn paint_arc(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    static START: OnceLock<Instant> = OnceLock::new();
    let turned = (START.get_or_init(Instant::now).elapsed().as_secs_f32() / TURN_SECONDS).fract();

    let stroke_width = 1.6_f32;
    let side = f32::from(bounds.size.width).min(f32::from(bounds.size.height));
    let radius = ((side - 3.0) / 2.0).max(1.0);
    let center = bounds.center();
    let at = |angle: f32| {
        point(
            center.x + px(radius * angle.cos()),
            center.y + px(radius * angle.sin()),
        )
    };

    let start = turned * std::f32::consts::TAU;
    let end = start + ARC_SWEEP * std::f32::consts::TAU;
    let mut path = PathBuilder::stroke(px(stroke_width));
    path.move_to(at(start));
    path.arc_to(
        point(px(radius), px(radius)),
        px(0.0),
        ARC_SWEEP > 0.5,
        true,
        at(end),
    );
    if let Ok(built) = path.build() {
        window.paint_path(built, color);
    }

    // Round caps at both arc endpoints.
    for angle in [start, end] {
        let c = at(angle);
        let dot = Bounds {
            origin: point(c.x - px(stroke_width / 2.0), c.y - px(stroke_width / 2.0)),
            size: size(px(stroke_width), px(stroke_width)),
        };
        window.paint_quad(fill(dot, color).corner_radii(px(stroke_width / 2.0)));
    }
}

fn schedule_next_frame(window: &mut Window, cx: &mut App) {
    let view_id = window.current_view();
    let already_ticking = TICKING.with(|set| !set.borrow_mut().insert(view_id));
    if already_ticking {
        return;
    }
    let window_handle = window.window_handle();
    cx.spawn(async move |cx| {
        cx.background_executor().timer(FRAME_INTERVAL).await;
        TICKING.with(|set| {
            set.borrow_mut().remove(&view_id);
        });
        let _ = cx.update_window(window_handle, |_, _, cx| {
            cx.notify(view_id);
        });
    })
    .detach();
}
