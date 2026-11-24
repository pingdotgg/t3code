//! The example terminal at the bottom of Settings → Terminal: a few fixed lines drawn with the
//! saved font, size, weight, line height, letter spacing and cursor, and the real terminal's
//! colours, so a change shows at once. It is a picture: no shell runs and nothing can be typed.
//!
//! With Cursor blink on, the cursor blinks on the real terminal's period and rule: visible for
//! [`CURSOR_BLINK_MS`], hidden for as long, starting visible. The terminal ignores Reduce Motion,
//! so the example does too. The repaint timer runs only while the example is being painted, so a
//! hidden Settings page repaints nothing.

use std::cell::RefCell;
use std::collections::HashSet;
use std::time::{Duration, Instant};

use conn_state::terminal_settings::{CursorStyle, TerminalSettings};
use conn_theme::Tokens;
use gpui_kit::{
    App, AppContext as _, Bounds, EntityId, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, Styled as _, TextAlign, TextRun, Window, canvas, div, fill, point, px,
    size,
};

use super::color::{Rgb8, mix_rgb8, rgb8_to_hsla};
use super::terminal::{CURSOR_BLINK_MS, measure_font};
use super::terminal_palette::TerminalPalette;
use crate::a11y::ConnA11yExt as _;

/// Space around the lines inside the box.
const PAD_PX: f32 = 12.0;

/// ANSI colour numbers of Conn's palette: green, blue, cyan and bright black (grey).
const GREEN: usize = 2;
const BLUE: usize = 4;
const CYAN: usize = 6;
const GREY: usize = 8;

/// One coloured piece of a line; `None` is the terminal's foreground.
type Piece = (&'static str, Option<usize>);

/// The lines of the example: a prompt and command, build output, a listing, and a new prompt
/// where the cursor sits.
const LINES: [&[Piece]; 5] = [
    &[
        ("nick@mac", Some(GREEN)),
        (" ", None),
        ("~/conn", Some(BLUE)),
        (" % ", None),
        ("cargo test -p conn-state", None),
    ],
    &[
        ("   Compiling ", Some(GREEN)),
        ("conn-state v0.1.0", None),
        (" (crates/conn-state)", Some(GREY)),
    ],
    &[
        ("test result: ", None),
        ("ok", Some(GREEN)),
        (". 193 passed; 0 failed", None),
    ],
    &[
        ("Cargo.toml  ", None),
        ("crates/", Some(BLUE)),
        ("  ", None),
        ("docs/", Some(BLUE)),
        ("  README.md  ", None),
        ("target/", Some(CYAN)),
    ],
    &[
        ("nick@mac", Some(GREEN)),
        (" ", None),
        ("~/conn", Some(BLUE)),
        (" % ", None),
    ],
];

/// The share of the foreground mixed into the terminal background for the box's 1px border:
/// lighter than the background on a dark theme, a shade darker on a light one, subtle on both.
const BORDER_MIX: f32 = 0.14;

/// `background` with `BORDER_MIX` of `foreground` mixed in.
fn border_rgb(background: Rgb8, foreground: Rgb8) -> Rgb8 {
    mix_rgb8(foreground, BORDER_MIX, background)
}

/// Whether the cursor is in its visible half `elapsed_ms` after blinking began: the real
/// terminal's rule. A steady cursor (blink off) is always visible.
fn cursor_visible(blinking: bool, elapsed_ms: u128) -> bool {
    !blinking || (elapsed_ms / u128::from(CURSOR_BLINK_MS)).is_multiple_of(2)
}

/// Milliseconds until the cursor next flips.
fn ms_to_next_flip(elapsed_ms: u128) -> u64 {
    CURSOR_BLINK_MS - (elapsed_ms % u128::from(CURSOR_BLINK_MS)) as u64
}

/// A paint this long after the last one means the example was hidden meanwhile: blinking starts
/// over, visible, as it does when the terminal gains focus.
const RESTART_AFTER: Duration = Duration::from_millis(CURSOR_BLINK_MS * 2);

#[derive(Default)]
struct BlinkClock {
    /// When the current blinking run began; `None` while the cursor is steady.
    epoch: Option<Instant>,
    last_paint: Option<Instant>,
    /// Views with a repaint timer pending.
    ticking: HashSet<EntityId>,
}

thread_local! {
    static BLINK: RefCell<BlinkClock> = RefCell::new(BlinkClock::default());
}

/// Milliseconds into the blinking run at `now`, starting one when this is the first paint of it.
fn blink_elapsed_ms(clock: &mut BlinkClock, blinking: bool, now: Instant) -> u128 {
    if !blinking {
        clock.epoch = None;
        clock.last_paint = None;
        return 0;
    }
    let stale = clock
        .last_paint
        .is_none_or(|last| now.duration_since(last) > RESTART_AFTER);
    if stale || clock.epoch.is_none() {
        clock.epoch = Some(now);
    }
    clock.last_paint = Some(now);
    clock
        .epoch
        .map_or(0, |epoch| now.duration_since(epoch).as_millis())
}

/// Repaints the view at the next flip, once. Called while painting, so it stops when painting does.
fn schedule_flip(window: &mut Window, cx: &mut App, delay_ms: u64) {
    let view_id = window.current_view();
    if !BLINK.with(|clock| clock.borrow_mut().ticking.insert(view_id)) {
        return;
    }
    let handle = window.window_handle();
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(Duration::from_millis(delay_ms))
            .await;
        BLINK.with(|clock| {
            clock.borrow_mut().ticking.remove(&view_id);
        });
        let _ = cx.update_window(handle, |_, _, cx| cx.notify(view_id));
    })
    .detach();
}

/// The example box for `settings`, in the terminal's colours.
#[must_use]
pub(crate) fn render_terminal_demo(
    settings: &TerminalSettings,
    tokens: &Tokens,
) -> impl IntoElement {
    let palette = TerminalPalette::from_tokens(tokens);
    let background = rgb8_to_hsla(palette.background);
    let height = LINES.len() as f32 * settings.cell_height().ceil() + 2.0 * PAD_PX;
    let settings = settings.clone();
    // A 1px edge derived from the terminal's own colours, subtle in both appearances (#336).
    let border = rgb8_to_hsla(border_rgb(palette.background, palette.foreground));

    div()
        .id("terminal-settings-example")
        .a11y_group("settings.terminal.example", "Terminal example")
        .w_full()
        .h(px(height))
        .rounded(px(8.0))
        .border_1()
        .border_color(border)
        .bg(background)
        .overflow_hidden()
        .child(
            canvas(
                |_, _, _| {},
                move |bounds, (), window, cx| {
                    paint_demo(bounds, &settings, &palette, window, cx);
                },
            )
            .size_full(),
        )
}

fn paint_demo(
    bounds: Bounds<gpui_kit::Pixels>,
    settings: &TerminalSettings,
    palette: &TerminalPalette,
    window: &mut Window,
    cx: &mut App,
) {
    let metrics = measure_font(window, cx, settings);
    let (cw, ch) = (metrics.cell_width, metrics.cell_height);
    let origin = point(bounds.origin.x + px(PAD_PX), bounds.origin.y + px(PAD_PX));
    let foreground = rgb8_to_hsla(palette.foreground);
    let text_system = window.text_system().clone();

    let mut cursor_at = (0_usize, 0_usize);
    for (row, pieces) in LINES.iter().enumerate() {
        let mut column = 0_usize;
        for (text, color) in *pieces {
            let color: Hsla = color.map_or(foreground, |n| rgb8_to_hsla(palette.ansi[n]));
            let run = TextRun {
                len: text.len(),
                font: metrics.font.clone(),
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let shaped = text_system.shape_line((*text).into(), metrics.size, &[run], Some(px(cw)));
            let at = point(
                origin.x + px(cw * column as f32),
                origin.y + px(ch * row as f32),
            );
            let _ = shaped.paint(at, px(ch), TextAlign::Left, None, window, cx);
            column += text.chars().count();
        }
        cursor_at = (row, column);
    }

    // The cursor after the last prompt, as the settings draw it: steady, or blinking like the real
    // terminal's when Cursor blink is on.
    let blinking = settings.cursor_blink;
    let elapsed_ms =
        BLINK.with(|clock| blink_elapsed_ms(&mut clock.borrow_mut(), blinking, Instant::now()));
    if blinking {
        schedule_flip(window, cx, ms_to_next_flip(elapsed_ms));
    }
    if !cursor_visible(blinking, elapsed_ms) {
        return;
    }
    let cursor = rgb8_to_hsla(palette.cursor);
    let cell = Bounds {
        origin: point(
            origin.x + px(cw * cursor_at.1 as f32),
            origin.y + px(ch * cursor_at.0 as f32),
        ),
        size: size(px(cw), px(ch)),
    };
    let rect = match settings.cursor_style {
        CursorStyle::Block => cell,
        CursorStyle::Bar => Bounds {
            origin: cell.origin,
            size: size(px(2.0), cell.size.height),
        },
        CursorStyle::Underline => Bounds {
            origin: point(cell.origin.x, cell.origin.y + cell.size.height - px(2.0)),
            size: size(cell.size.width, px(2.0)),
        },
    };
    window.paint_quad(fill(rect, cursor));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real terminal starts a blinking cursor visible and flips it every `CURSOR_BLINK_MS`.
    #[test]
    fn the_example_cursor_blinks_on_the_terminals_period() {
        assert_eq!(CURSOR_BLINK_MS, 530);
        let period = u128::from(CURSOR_BLINK_MS);
        assert!(cursor_visible(true, 0));
        assert!(cursor_visible(true, period - 1));
        assert!(!cursor_visible(true, period));
        assert!(!cursor_visible(true, 2 * period - 1));
        assert!(cursor_visible(true, 2 * period));
    }

    #[test]
    fn a_steady_cursor_is_always_visible() {
        for elapsed in [0, 529, 530, 1_060, 99_999] {
            assert!(cursor_visible(false, elapsed));
        }
    }

    #[test]
    fn the_flip_timer_waits_for_the_next_edge() {
        assert_eq!(ms_to_next_flip(0), CURSOR_BLINK_MS);
        assert_eq!(ms_to_next_flip(500), CURSOR_BLINK_MS - 500);
        assert_eq!(ms_to_next_flip(530), CURSOR_BLINK_MS);
    }

    #[test]
    fn blinking_starts_visible_restarts_after_a_hidden_spell_and_stops_when_off() {
        let mut clock = BlinkClock::default();
        let start = Instant::now();
        assert_eq!(blink_elapsed_ms(&mut clock, true, start), 0);
        let later = start + Duration::from_millis(600);
        assert_eq!(blink_elapsed_ms(&mut clock, true, later), 600);
        // Not painted for longer than two periods (Settings was hidden): visible again from zero.
        let back = later + RESTART_AFTER + Duration::from_millis(1);
        assert_eq!(blink_elapsed_ms(&mut clock, true, back), 0);
        // Turned off: no clock, so nothing to schedule.
        assert_eq!(blink_elapsed_ms(&mut clock, false, back), 0);
        assert!(clock.epoch.is_none());
    }

    #[test]
    fn the_border_is_lighter_on_dark_and_subtle_on_light() {
        let dark = border_rgb((20, 22, 26), (230, 232, 236));
        assert!(
            dark.0 > 20 && dark.1 > 22 && dark.2 > 26,
            "lighter than the background"
        );
        assert!(dark.0 < 80, "still subtle");
        let light = border_rgb((250, 250, 250), (30, 30, 34));
        assert!(light.0 < 250 && light.0 > 200, "a faint line on light");
    }
}
