//! Linux agent-cursor overlay — Windows/Mac parity (X11).
//!
//! Soft lavender glow, rounded arrow PNG, curved Bezier flight with heading
//! that follows the path tangent (frozen on land), idle breathe. No click ring.
//! Disabled with `T3_DESKTOP_AGENT_CURSOR=0`.
//!
//! Fade is driven by Computer Use `tools/call` activity (see
//! `note_desktop_tool_*`), not a wall-clock idle after the last move.
//!
//! Own X11 connection on a dedicated UI thread (separate from `LinuxDesktop`).
//! Override-redirect 112×112 topmost window; ShapeInput empty so clicks pass
//! through. Prefers a 32-bit ARGB visual; falls back to opaque-ish PutImage.

use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::shape::{ConnectionExt as _, SK, SO};
use x11rb::protocol::xproto::{
    ClipOrdering, ColormapAlloc, ConfigureWindowAux, ConnectionExt as _, CreateGCAux,
    CreateWindowAux, ImageFormat, ImageOrder, StackMode, VisualClass, Visualtype, WindowClass,
};
use x11rb::rust_connection::RustConnection;

const SIDE: i32 = 112;
const HOTSPOT: f64 = 56.0;
/// Brief grace after the last desktop tools/call before fading — cancelled if
/// another tools/call starts. Override with `T3_DESKTOP_AGENT_CURSOR_TASK_FADE_SECS`.
const DEFAULT_TASK_FADE: Duration = Duration::from_secs(8);
const FADE_OUT_MS: f64 = 350.0;
const FADE_IN_MS: f64 = 500.0;
const TICK_MS: u64 = 16; // ~60fps

static ENABLED: AtomicBool = AtomicBool::new(true);
static CURSOR: OnceLock<AgentCursor> = OnceLock::new();
static LAST_POINT: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static TASK_HIDE_GEN: AtomicU64 = AtomicU64::new(0);
static FADE_TARGET_GEN: AtomicU64 = AtomicU64::new(0);
static FADE_DEADLINE_MS: AtomicU64 = AtomicU64::new(0);
static FADE_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
static CMD_TX: OnceLock<Sender<Cmd>> = OnceLock::new();
static UI_LIVE: AtomicBool = AtomicBool::new(false);

enum Cmd {
    Move { x: f64, y: f64, press: bool },
    Hide,
}

pub struct AgentCursor;

impl AgentCursor {
    pub fn shared() -> &'static Self {
        CURSOR.get_or_init(|| {
            ENABLED.store(agent_cursor_enabled(), Ordering::Relaxed);
            if ENABLED.load(Ordering::Relaxed) {
                let (tx, rx) = mpsc::channel();
                let _ = CMD_TX.set(tx);
                let _ = thread::Builder::new()
                    .name("t3-agent-cursor".into())
                    .spawn(move || ui_thread(rx));
                thread::sleep(Duration::from_millis(120));
            }
            Self
        })
    }

    pub fn show(&self, x: f64, y: f64) {
        if ENABLED.load(Ordering::Relaxed) {
            move_and_wait(x, y, false);
        }
    }

    pub fn press(&self, x: f64, y: f64) {
        if ENABLED.load(Ordering::Relaxed) {
            move_and_wait(x, y, true);
        }
    }

    /// Non-blocking hop for mid-drag visuals (must not sleep while a button is down).
    pub fn glide(&self, x: f64, y: f64) {
        if ENABLED.load(Ordering::Relaxed) {
            move_no_wait(x, y);
        }
    }

    pub fn hide(&self) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        TASK_HIDE_GEN.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut last) = LAST_POINT.lock() {
            *last = None;
        }
        post(Cmd::Hide);
    }

    /// A Computer Use `tools/call` is starting — keep the pointer up.
    pub fn note_desktop_tool_started(&self) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        // Cancel any armed fade before bumping the generation so an expired
        // watcher cannot hide after this call.
        FADE_DEADLINE_MS.store(0, Ordering::SeqCst);
        TASK_HIDE_GEN.fetch_add(1, Ordering::SeqCst);
    }

    /// A Computer Use `tools/call` finished. Fade once tools stop for this task.
    pub fn note_desktop_tool_finished(&self) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        let used = LAST_POINT
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        if !used {
            return;
        }
        let generation = TASK_HIDE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let delay = task_fade_grace();
        FADE_TARGET_GEN.store(generation, Ordering::SeqCst);
        FADE_DEADLINE_MS.store(
            now_unix_ms().saturating_add(delay.as_millis() as u64),
            Ordering::SeqCst,
        );
        ensure_fade_watcher();
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ensure_fade_watcher() {
    if FADE_WATCHER_STARTED
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let _ = thread::Builder::new()
        .name("t3-agent-cursor-fade".into())
        .spawn(|| {
            loop {
                thread::sleep(Duration::from_millis(50));
                let deadline = FADE_DEADLINE_MS.load(Ordering::SeqCst);
                if deadline == 0 || now_unix_ms() < deadline {
                    continue;
                }
                let target = FADE_TARGET_GEN.load(Ordering::SeqCst);
                if FADE_DEADLINE_MS
                    .compare_exchange(deadline, 0, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    continue;
                }
                // Re-check after disarming: `note_desktop_tool_started` may have
                // bumped the generation between the load and the CAS.
                if TASK_HIDE_GEN.load(Ordering::SeqCst) == target {
                    AgentCursor::shared().hide();
                }
            }
        });
}

fn task_fade_grace() -> Duration {
    match std::env::var("T3_DESKTOP_AGENT_CURSOR_TASK_FADE_SECS") {
        Ok(raw) => {
            if let Ok(secs) = raw.trim().parse::<f64>() {
                // from_secs_f64 panics on inf/NaN/overflow — reject those.
                if secs.is_finite() && (0.0..3600.0).contains(&secs) {
                    return Duration::from_secs_f64(secs);
                }
            }
            DEFAULT_TASK_FADE
        }
        Err(_) => DEFAULT_TASK_FADE,
    }
}

fn move_and_wait(x: f64, y: f64, press: bool) {
    if !UI_LIVE.load(Ordering::Relaxed) {
        return;
    }
    let wait = {
        let mut last = LAST_POINT.lock().unwrap_or_else(|e| e.into_inner());
        let micros = travel_wait_micros(*last, x, y);
        *last = Some((x, y));
        micros
    };
    post(Cmd::Move { x, y, press });
    if wait > 0 {
        thread::sleep(Duration::from_micros(wait));
    }
}

/// Fire-and-forget move for mid-drag hops — never blocks with the button held.
fn move_no_wait(x: f64, y: f64) {
    if let Ok(mut last) = LAST_POINT.lock() {
        *last = Some((x, y));
    }
    post(Cmd::Move {
        x,
        y,
        press: false,
    });
}

/// Approximate flight time for the curved path so clicks wait until landing.
fn travel_wait_micros(from: Option<(f64, f64)>, x: f64, y: f64) -> u64 {
    let Some((fx, fy)) = from else {
        return 100_000;
    };
    let dist = (x - fx).hypot(y - fy);
    if dist < 2.0 {
        return 60_000;
    }
    let seconds = (0.18 + dist / 900.0).clamp(0.28, 0.95);
    ((seconds + 0.05) * 1_000_000.0) as u64
}

fn agent_cursor_enabled() -> bool {
    match std::env::var("T3_DESKTOP_AGENT_CURSOR") {
        Ok(value) => {
            let v = value.trim();
            !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        }
        Err(_) => true,
    }
}

fn post(cmd: Cmd) {
    if let Some(tx) = CMD_TX.get() {
        let _ = tx.send(cmd);
    }
}

struct Anim {
    current: Option<(f64, f64)>,
    target: (f64, f64),
    vel: (f64, f64),
    path_from: (f64, f64),
    path_c1: (f64, f64),
    path_c2: (f64, f64),
    path_to: (f64, f64),
    path_elapsed: f64,
    path_duration: f64,
    path_active: bool,
    arc_sign: f64,
    phase: f64,
    tilt: f64,
    alpha: f64,
    fading: bool,
    visible: bool,
}

impl Anim {
    fn new() -> Self {
        Self {
            current: None,
            target: (0.0, 0.0),
            vel: (0.0, 0.0),
            path_from: (0.0, 0.0),
            path_c1: (0.0, 0.0),
            path_c2: (0.0, 0.0),
            path_to: (0.0, 0.0),
            path_elapsed: 0.0,
            path_duration: 0.0,
            path_active: false,
            arc_sign: 1.0,
            phase: 0.0,
            tilt: 0.0,
            alpha: 0.0,
            fading: false,
            visible: false,
        }
    }
}

struct Overlay {
    conn: RustConnection,
    screen_num: usize,
    win: u32,
    gc: u32,
    depth: u8,
    visual: Visualtype,
    /// True when depth is 32 and unused bits can carry alpha.
    argb: bool,
    byte_order: ImageOrder,
    bitmap_bit_order: ImageOrder,
    bitmap_scanline_pad: u8,
    bits_per_pixel: u8,
    mapped: bool,
    /// Premultiplied BGRA scratch (same layout as Windows).
    pixels: Vec<u8>,
    /// Packed server pixels for PutImage.
    put_buf: Vec<u8>,
}

fn ui_thread(rx: Receiver<Cmd>) {
    let Ok((conn, screen_num)) = x11rb::connect(None) else {
        // No DISPLAY / connect failed — keep shared() alive; show/press are no-ops.
        drain_forever(rx);
        return;
    };
    let setup = conn.setup().clone();
    let screen = &setup.roots[screen_num];
    let byte_order = setup.image_byte_order;

    let (depth, visual, argb) = match find_argb_visual(screen) {
        Some((d, v)) => (d, v, true),
        None => {
            let root_visual = screen
                .allowed_depths
                .iter()
                .flat_map(|d| d.visuals.iter().map(move |v| (d.depth, *v)))
                .find(|(_, v)| v.visual_id == screen.root_visual)
                .map(|(d, v)| (d, v))
                .unwrap_or((
                    screen.root_depth,
                    Visualtype {
                        visual_id: screen.root_visual,
                        class: VisualClass::TRUE_COLOR,
                        bits_per_rgb_value: 8,
                        colormap_entries: 256,
                        red_mask: 0xFF0000,
                        green_mask: 0x00FF00,
                        blue_mask: 0x0000FF,
                    },
                ));
            (root_visual.0, root_visual.1, false)
        }
    };

    let win = match conn.generate_id() {
        Ok(id) => id,
        Err(_) => {
            drain_forever(rx);
            return;
        }
    };
    let gc = match conn.generate_id() {
        Ok(id) => id,
        Err(_) => {
            drain_forever(rx);
            return;
        }
    };
    let cmap = match conn.generate_id() {
        Ok(id) => id,
        Err(_) => {
            drain_forever(rx);
            return;
        }
    };

    if conn
        .create_colormap(ColormapAlloc::NONE, cmap, screen.root, visual.visual_id)
        .is_err()
    {
        drain_forever(rx);
        return;
    }

    let aux = CreateWindowAux::new()
        .override_redirect(1)
        .colormap(cmap)
        .border_pixel(0)
        .background_pixel(0);

    if conn
        .create_window(
            depth,
            win,
            screen.root,
            0,
            0,
            SIDE as u16,
            SIDE as u16,
            0,
            WindowClass::INPUT_OUTPUT,
            visual.visual_id,
            &aux,
        )
        .is_err()
    {
        let _ = conn.free_colormap(cmap);
        drain_forever(rx);
        return;
    }

    // Clicks pass through: empty ShapeInput region. Without Shape, a topmost
    // override-redirect window would eat clicks under the hotspot — fail closed.
    if conn.shape_query_version().is_err()
        || conn
            .shape_rectangles(
                SO::SET,
                SK::INPUT,
                ClipOrdering::UNSORTED,
                win,
                0,
                0,
                &[],
            )
            .is_err()
    {
        let _ = conn.destroy_window(win);
        let _ = conn.free_colormap(cmap);
        drain_forever(rx);
        return;
    }

    if conn
        .create_gc(gc, win, &CreateGCAux::new().graphics_exposures(0))
        .is_err()
    {
        let _ = conn.destroy_window(win);
        let _ = conn.free_colormap(cmap);
        drain_forever(rx);
        return;
    }
    let _ = conn.flush();

    let bits_per_pixel = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == depth)
        .map(|f| f.bits_per_pixel)
        .unwrap_or(if depth == 32 { 32 } else { 24 });

    let mut overlay = Overlay {
        conn,
        screen_num,
        win,
        gc,
        depth,
        visual,
        argb,
        byte_order,
        bitmap_bit_order: setup.bitmap_format_bit_order,
        bitmap_scanline_pad: setup.bitmap_format_scanline_pad,
        bits_per_pixel,
        mapped: false,
        pixels: vec![0u8; (SIDE * SIDE * 4) as usize],
        put_buf: Vec::new(),
    };
    let mut state = Anim::new();
    UI_LIVE.store(true, Ordering::Relaxed);

    loop {
        let tick_start = Instant::now();

        // Drain pending commands.
        let mut got = false;
        loop {
            match rx.try_recv() {
                Ok(Cmd::Move { x, y, press }) => {
                    got = true;
                    begin(&mut state, x, y, press);
                    ensure_shown(&mut overlay, &state);
                    tick(&mut overlay, &mut state);
                }
                Ok(Cmd::Hide) => {
                    got = true;
                    state.fading = true;
                    tick(&mut overlay, &mut state);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        let busy = if !got {
            tick(&mut overlay, &mut state)
        } else {
            state.visible || state.fading || state.path_active || state.alpha > 0.0
        };

        // Swallow X events so the queue does not fill.
        while overlay.conn.poll_for_event().ok().flatten().is_some() {}

        let elapsed = tick_start.elapsed();
        let frame = Duration::from_millis(TICK_MS);
        if busy {
            if elapsed < frame {
                thread::sleep(frame - elapsed);
            }
        } else {
            // Idle: block until the next command (or a long poll).
            match rx.recv_timeout(Duration::from_secs(3600)) {
                Ok(Cmd::Move { x, y, press }) => {
                    begin(&mut state, x, y, press);
                    ensure_shown(&mut overlay, &state);
                    tick(&mut overlay, &mut state);
                }
                Ok(Cmd::Hide) => {
                    state.fading = true;
                    tick(&mut overlay, &mut state);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

fn drain_forever(rx: Receiver<Cmd>) {
    while rx.recv().is_ok() {}
}

fn find_argb_visual(
    screen: &x11rb::protocol::xproto::Screen,
) -> Option<(u8, Visualtype)> {
    for depth in &screen.allowed_depths {
        if depth.depth != 32 {
            continue;
        }
        for visual in &depth.visuals {
            if visual.class == VisualClass::TRUE_COLOR || visual.class == VisualClass::DIRECT_COLOR
            {
                let rgb = visual.red_mask | visual.green_mask | visual.blue_mask;
                // Prefer visuals with spare high bits for alpha.
                if rgb.count_ones() <= 24 {
                    return Some((depth.depth, *visual));
                }
            }
        }
    }
    None
}

fn begin(state: &mut Anim, x: f64, y: f64, _popping: bool) {
    state.target = (x, y);
    let fresh = state.current.is_none() || !state.visible || state.alpha < 0.05;
    if fresh {
        state.current = Some((x, y));
        state.vel = (0.0, 0.0);
        state.path_active = false;
        state.tilt = 0.0;
        // Fade in — never pop to full opacity.
        state.alpha = 0.0;
        state.fading = false;
        state.visible = true;
        return;
    }

    let from = state.current.unwrap_or((x, y));
    let dx = x - from.0;
    let dy = y - from.1;
    let dist = dx.hypot(dy);
    state.alpha = 1.0;
    state.fading = false;
    state.visible = true;

    if dist < 2.0 {
        state.current = Some((x, y));
        state.vel = (0.0, 0.0);
        state.path_active = false;
        state.tilt = 0.0;
        return;
    }

    // Cubic flight: bank through cruise, flare upright into the target.
    state.arc_sign *= -1.0;
    let handle = (dist * 0.35).clamp(40.0, 180.0);
    let nx = -dy / dist;
    let ny = dx / dist;
    let start_dir = if state.tilt.abs() > 0.05 {
        let ang = -state.tilt;
        (ang.sin(), -ang.cos())
    } else {
        (dx / dist, dy / dist)
    };
    let depart = handle.min(dist * 0.45);
    state.path_from = from;
    state.path_to = (x, y);
    state.path_c1 = (
        from.0 + start_dir.0 * depart + nx * (dist * 0.18).min(90.0) * state.arc_sign,
        from.1 + start_dir.1 * depart + ny * (dist * 0.18).min(90.0) * state.arc_sign,
    );
    let approach = (handle * 0.9).min((dist * 0.28).max(28.0));
    state.path_c2 = (x, y + approach);
    state.path_duration = (0.18 + dist / 900.0).clamp(0.28, 0.95);
    state.path_elapsed = 0.0;
    state.path_active = true;
    state.vel = (0.0, 0.0);
}

fn cubic_bezier(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
    t: f64,
) -> (f64, f64) {
    let o = 1.0 - t;
    let o2 = o * o;
    let t2 = t * t;
    (
        o2 * o * p0.0 + 3.0 * o2 * t * p1.0 + 3.0 * o * t2 * p2.0 + t2 * t * p3.0,
        o2 * o * p0.1 + 3.0 * o2 * t * p1.1 + 3.0 * o * t2 * p2.1 + t2 * t * p3.1,
    )
}

fn cubic_bezier_tangent(
    p0: (f64, f64),
    p1: (f64, f64),
    p2: (f64, f64),
    p3: (f64, f64),
    t: f64,
) -> (f64, f64) {
    let o = 1.0 - t;
    (
        3.0 * o * o * (p1.0 - p0.0) + 6.0 * o * t * (p2.0 - p1.0) + 3.0 * t * t * (p3.0 - p2.0),
        3.0 * o * o * (p1.1 - p0.1) + 6.0 * o * t * (p2.1 - p1.1) + 3.0 * t * t * (p3.1 - p2.1),
    )
}

fn ensure_shown(overlay: &mut Overlay, state: &Anim) {
    if let Some((cx, cy)) = state.current {
        move_window(overlay, cx, cy);
        if !overlay.mapped {
            let _ = overlay.conn.map_window(overlay.win);
            overlay.mapped = true;
            let _ = overlay.conn.flush();
        }
    }
}

fn move_window(overlay: &mut Overlay, cx: f64, cy: f64) {
    let x = (cx - HOTSPOT).round() as i32;
    let y = (cy - HOTSPOT).round() as i32;
    let _ = overlay.conn.configure_window(
        overlay.win,
        &ConfigureWindowAux::new()
            .x(x)
            .y(y)
            .stack_mode(StackMode::ABOVE),
    );
}

/// Returns false when the animation can sleep.
fn tick(overlay: &mut Overlay, state: &mut Anim) -> bool {
    let mut busy = false;

    if state.fading {
        state.alpha = (state.alpha - (TICK_MS as f64) / FADE_OUT_MS).max(0.0);
        busy = state.alpha > 0.0;
        if state.alpha <= 0.0 {
            state.visible = false;
            state.current = None;
            if overlay.mapped {
                let _ = overlay.conn.unmap_window(overlay.win);
                overlay.mapped = false;
                let _ = overlay.conn.flush();
            }
            return false;
        }
    } else if state.visible && state.alpha < 1.0 {
        // Fade in on first appear (and after a prior fade-out).
        state.alpha = (state.alpha + (TICK_MS as f64) / FADE_IN_MS).min(1.0);
        busy = true;
    }

    if let Some(mut cur) = state.current {
        if state.path_active {
            let dt = TICK_MS as f64 / 1000.0;
            state.path_elapsed += dt;
            let u = (state.path_elapsed / state.path_duration.max(0.001)).min(1.0);
            let t = u * u * (3.0 - 2.0 * u);
            let pos = cubic_bezier(
                state.path_from,
                state.path_c1,
                state.path_c2,
                state.path_to,
                t,
            );
            let tan = cubic_bezier_tangent(
                state.path_from,
                state.path_c1,
                state.path_c2,
                state.path_to,
                t,
            );
            state.vel = ((pos.0 - cur.0) / dt, (pos.1 - cur.1) / dt);
            cur = pos;
            state.current = Some(cur);

            let tan_len = tan.0.hypot(tan.1);
            if tan_len > 0.001 {
                let desired = -tan.0.atan2(-tan.1);
                let mut delta = desired - state.tilt;
                while delta > std::f64::consts::PI {
                    delta -= std::f64::consts::TAU;
                }
                while delta < -std::f64::consts::PI {
                    delta += std::f64::consts::TAU;
                }
                let follow = ((0.12 + t * 0.55) + dt * 6.0).min(1.0);
                state.tilt += delta * follow;
            }

            if u >= 1.0 {
                state.current = Some(state.path_to);
                state.vel = (0.0, 0.0);
                state.tilt = 0.0; // path flared upright
                state.path_active = false;
            }
            busy = true;

            let (cx, cy) = state.current.unwrap_or(cur);
            move_window(overlay, cx, cy);
        } else {
            move_window(overlay, cur.0, cur.1);
        }
    }

    if state.visible && state.alpha > 0.05 {
        state.phase += 0.08;
        busy = true;
    }

    if state.visible || state.alpha > 0.0 {
        render(&mut overlay.pixels, state);
        present(overlay, state.alpha);
    }

    busy || state.visible
}

fn present(overlay: &mut Overlay, alpha: f64) {
    let a_scale = alpha.clamp(0.0, 1.0);
    // Match the server pixmap format exactly — 15/16-bit displays use 2 bytes/pixel.
    // Do not force a minimum of 3; PutImage size must match bits_per_pixel.
    let bpp = (overlay.bits_per_pixel as usize).div_ceil(8).max(1);
    let n = (SIDE * SIDE) as usize;
    overlay.put_buf.resize(n * bpp, 0);

    for i in 0..n {
        let bi = i * 4;
        let b = overlay.pixels[bi] as f64;
        let g = overlay.pixels[bi + 1] as f64;
        let r = overlay.pixels[bi + 2] as f64;
        let a = overlay.pixels[bi + 3] as f64 * a_scale;
        // Buffer is premultiplied; re-scale by global fade.
        let r8 = (r * a_scale).round().clamp(0.0, 255.0) as u8;
        let g8 = (g * a_scale).round().clamp(0.0, 255.0) as u8;
        let b8 = (b * a_scale).round().clamp(0.0, 255.0) as u8;
        let a8 = a.round().clamp(0.0, 255.0) as u8;

        let pixel = pack_pixel(r8, g8, b8, a8, &overlay.visual, overlay.argb, overlay.byte_order);
        let dest = &mut overlay.put_buf[i * bpp..i * bpp + bpp.min(4)];
        let take = dest.len().min(4);
        dest.copy_from_slice(&pixel[..take]);
    }

    let _ = overlay.conn.put_image(
        ImageFormat::Z_PIXMAP,
        overlay.win,
        overlay.gc,
        SIDE as u16,
        SIDE as u16,
        0,
        0,
        0,
        overlay.depth,
        &overlay.put_buf,
    );

    // Without compositing (or without an ARGB visual), opaque PutImage paints a
    // black square. Clip via Shape when needed — `argb` alone only proves the
    // visual has an alpha channel, not that a CM is compositing it.
    if !overlay.argb || !compositing_manager_running(&overlay.conn, overlay.screen_num) {
        apply_alpha_bounding_shape(overlay, a_scale);
    }

    let _ = overlay.conn.flush();
}

fn compositing_manager_running(conn: &RustConnection, screen_num: usize) -> bool {
    let name = format!("_NET_WM_CM_S{screen_num}");
    let Ok(atom) = conn.intern_atom(false, name.as_bytes()) else {
        return false;
    };
    let Ok(atom) = atom.reply() else {
        return false;
    };
    let Ok(owner) = conn.get_selection_owner(atom.atom) else {
        return false;
    };
    owner.reply().is_ok_and(|reply| reply.owner != 0)
}

fn apply_alpha_bounding_shape(overlay: &mut Overlay, a_scale: f64) {
    let Ok(pixmap) = overlay.conn.generate_id() else {
        return;
    };
    let Ok(mask_gc) = overlay.conn.generate_id() else {
        return;
    };
    if overlay
        .conn
        .create_pixmap(1, pixmap, overlay.win, SIDE as u16, SIDE as u16)
        .is_err()
    {
        return;
    }
    // XYBitmap paints set bits with GC foreground and clear bits with
    // background. X11 defaults those to 0/1, which inverts Shape polarity
    // (1 = inside the window). Force foreground=1, background=0 so opaque
    // cursor pixels stay in the BOUNDING region.
    if overlay
        .conn
        .create_gc(
            mask_gc,
            pixmap,
            &CreateGCAux::new()
                .graphics_exposures(0)
                .foreground(1)
                .background(0),
        )
        .is_err()
    {
        let _ = overlay.conn.free_pixmap(pixmap);
        return;
    }

    let width = SIDE as usize;
    let height = SIDE as usize;
    // XYBitmap scanlines are padded to bitmap_format_scanline_pad bits.
    let pad_bits = usize::from(overlay.bitmap_scanline_pad).max(8);
    let stride = width.div_ceil(pad_bits) * (pad_bits / 8);
    let mut bits = vec![0u8; stride * height];
    let msb_first = overlay.bitmap_bit_order == ImageOrder::MSB_FIRST;
    for y in 0..height {
        for x in 0..width {
            let a = overlay.pixels[(y * width + x) * 4 + 3] as f64 * a_scale;
            if a < 8.0 {
                continue;
            }
            let bit = if msb_first {
                7 - (x % 8)
            } else {
                x % 8
            };
            bits[y * stride + x / 8] |= 1 << bit;
        }
    }

    let _ = overlay.conn.put_image(
        ImageFormat::XY_BITMAP,
        pixmap,
        mask_gc,
        SIDE as u16,
        SIDE as u16,
        0,
        0,
        0,
        1,
        &bits,
    );
    let _ = overlay.conn.shape_mask(
        SO::SET,
        SK::BOUNDING,
        overlay.win,
        0,
        0,
        pixmap,
    );
    let _ = overlay.conn.free_gc(mask_gc);
    let _ = overlay.conn.free_pixmap(pixmap);
}

fn place_component(component: u8, mask: u32) -> u32 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = mask.count_ones();
    let max = (1u32 << bits) - 1;
    let scaled = (u32::from(component) * max) / 255;
    scaled << shift
}

fn pack_pixel(
    r: u8,
    g: u8,
    b: u8,
    a: u8,
    visual: &Visualtype,
    argb: bool,
    byte_order: ImageOrder,
) -> [u8; 4] {
    let mut pixel =
        place_component(r, visual.red_mask) | place_component(g, visual.green_mask) | place_component(b, visual.blue_mask);
    if argb {
        let alpha_mask = !(visual.red_mask | visual.green_mask | visual.blue_mask);
        pixel |= place_component(a, alpha_mask);
    }
    if byte_order == ImageOrder::MSB_FIRST {
        pixel.to_be_bytes()
    } else {
        pixel.to_le_bytes()
    }
}

fn put_px(buf: &mut [u8], x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
    if x < 0 || y < 0 || x >= SIDE || y >= SIDE || a == 0 {
        return;
    }
    let i = ((y * SIDE + x) * 4) as usize;
    // Premultiplied BGRA (same as Windows UpdateLayeredWindow path).
    let af = a as u16;
    let dst_b = buf[i] as u16;
    let dst_g = buf[i + 1] as u16;
    let dst_r = buf[i + 2] as u16;
    let dst_a = buf[i + 3] as u16;
    let inv = 255u16.saturating_sub(af);
    let out_a = af + (dst_a * inv + 127) / 255;
    let out_b = (b as u16 * af + dst_b * inv + 127) / 255;
    let out_g = (g as u16 * af + dst_g * inv + 127) / 255;
    let out_r = (r as u16 * af + dst_r * inv + 127) / 255;
    buf[i] = out_b.min(255) as u8;
    buf[i + 1] = out_g.min(255) as u8;
    buf[i + 2] = out_r.min(255) as u8;
    buf[i + 3] = out_a.min(255) as u8;
}

fn radial_glow(buf: &mut [u8], cx: f64, cy: f64, radius: f64) {
    // lavender → purple → transparent, matching Mac gradient stops.
    let min_x = (cx - radius).floor() as i32;
    let max_x = (cx + radius).ceil() as i32;
    let min_y = (cy - radius).floor() as i32;
    let max_y = (cy + radius).ceil() as i32;
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f64 + 0.5 - cx;
            let dy = y as f64 + 0.5 - cy;
            let t = ((dx * dx + dy * dy).sqrt() / radius).clamp(0.0, 1.0);
            let (rf, gf, bf, af) = if t < 0.30 {
                let u = t / 0.30;
                lerp4((0.76, 0.72, 0.99, 0.72), (0.76, 0.72, 0.99, 0.38), u)
            } else if t < 0.65 {
                let u = (t - 0.30) / 0.35;
                lerp4((0.76, 0.72, 0.99, 0.38), (0.58, 0.52, 0.94, 0.14), u)
            } else {
                let u = (t - 0.65) / 0.35;
                lerp4((0.58, 0.52, 0.94, 0.14), (0.58, 0.52, 0.94, 0.0), u)
            };
            if af > 0.002 {
                put_px(
                    buf,
                    x,
                    y,
                    (rf * 255.0) as u8,
                    (gf * 255.0) as u8,
                    (bf * 255.0) as u8,
                    (af * 255.0) as u8,
                );
            }
        }
    }
}

fn lerp4(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64), t: f64) -> (f64, f64, f64, f64) {
    (
        a.0 + (b.0 - a.0) * t,
        a.1 + (b.1 - a.1) * t,
        a.2 + (b.2 - a.2) * t,
        a.3 + (b.3 - a.3) * t,
    )
}

fn render(buf: &mut [u8], state: &Anim) {
    buf.fill(0);

    let tip = (HOTSPOT, HOTSPOT);
    let breathe = 1.0 + 0.03 * state.phase.sin();

    // Soft lavender wash with idle breathe (no click ring).
    radial_glow(buf, tip.0 + 6.0, tip.1 + 9.0, 34.0 * breathe);

    // Pure 2D: heading rotation only — no squash/stretch.
    let sx = 1.0;
    let sy = 1.0;
    let cos_t = state.tilt.cos();
    let sin_t = state.tilt.sin();

    blit_cursor_png(buf, tip, sx, sy, cos_t, sin_t);
}

fn cursor_rgba() -> &'static [(u8, u8, u8, u8)] {
    use std::sync::OnceLock;
    static PIXELS: OnceLock<Vec<(u8, u8, u8, u8)>> = OnceLock::new();
    PIXELS.get_or_init(|| {
        let bytes = include_bytes!("cursor_112.png");
        let img = image::load_from_memory(bytes)
            .expect("cursor_112.png")
            .into_rgba8();
        assert_eq!(img.width(), SIDE as u32);
        assert_eq!(img.height(), SIDE as u32);
        img.pixels()
            .map(|p| {
                let [r, g, b, a] = p.0;
                (r, g, b, a)
            })
            .collect()
    })
}

fn blit_cursor_png(buf: &mut [u8], tip: (f64, f64), sx: f64, sy: f64, cos_t: f64, sin_t: f64) {
    let pixels = cursor_rgba();
    let sx = sx.max(0.01);
    let sy = sy.max(0.01);
    let inv_det = 1.0 / (sx * sy);
    let isx = sy * inv_det;
    let isy = sx * inv_det;
    let radius = (SIDE as f64) * 0.55 * sx.max(sy);
    let min_x = (tip.0 - radius).floor().max(0.0) as i32;
    let max_x = (tip.0 + radius).ceil().min((SIDE - 1) as f64) as i32;
    let min_y = (tip.1 - radius).floor().max(0.0) as i32;
    let max_y = (tip.1 + radius).ceil().min((SIDE - 1) as f64) as i32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let dx = x as f64 + 0.5 - tip.0;
            let dy = y as f64 + 0.5 - tip.1;
            let rx = dx * cos_t + dy * sin_t;
            let ry = -dx * sin_t + dy * cos_t;
            let u = rx * isx + HOTSPOT;
            let v = ry * isy + HOTSPOT;
            if u < 0.0 || v < 0.0 || u >= (SIDE as f64) - 1.0 || v >= (SIDE as f64) - 1.0 {
                continue;
            }
            let x0 = u.floor() as i32;
            let y0 = v.floor() as i32;
            let fx = u - x0 as f64;
            let fy = v - y0 as f64;
            let sample = |xx: i32, yy: i32| -> (f64, f64, f64, f64) {
                if xx < 0 || yy < 0 || xx >= SIDE || yy >= SIDE {
                    return (0.0, 0.0, 0.0, 0.0);
                }
                let (r, g, b, a) = pixels[(yy * SIDE + xx) as usize];
                (r as f64, g as f64, b as f64, a as f64)
            };
            let c00 = sample(x0, y0);
            let c10 = sample(x0 + 1, y0);
            let c01 = sample(x0, y0 + 1);
            let c11 = sample(x0 + 1, y0 + 1);
            let mix = |a: f64, b: f64, t: f64| a + (b - a) * t;
            let r0 = (
                mix(c00.0, c10.0, fx),
                mix(c00.1, c10.1, fx),
                mix(c00.2, c10.2, fx),
                mix(c00.3, c10.3, fx),
            );
            let r1 = (
                mix(c01.0, c11.0, fx),
                mix(c01.1, c11.1, fx),
                mix(c01.2, c11.2, fx),
                mix(c01.3, c11.3, fx),
            );
            let a = mix(r0.3, r1.3, fy);
            if a > 1.0 {
                put_px(
                    buf,
                    x,
                    y,
                    mix(r0.0, r1.0, fy) as u8,
                    mix(r0.1, r1.1, fy) as u8,
                    mix(r0.2, r1.2, fy) as u8,
                    a as u8,
                );
            }
        }
    }
}
