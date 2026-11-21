//! Lightweight turning-arc spinner for active tool calls and the Working row.
//!
//! Only schedules a repaint timer when actually rendered in the element tree, so idle
//! views incur zero timer wakeups and zero GPU repaints.

use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use gpui_kit::{
    App, AppContext as _, Bounds, EntityId, Hsla, IntoElement, PathBuilder, Pixels, RenderOnce,
    Styled as _, Window, canvas, fill, point, px, size,
};

/// Full rotation period in seconds.
const TURN_SECONDS: f32 = 0.9;
/// ~30 fps refresh interval so spinners stay smooth without pegging high-refresh displays.
const FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Fraction of the ring drawn (three-quarters arc).
const ARC_SWEEP: f32 = 0.75;

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
