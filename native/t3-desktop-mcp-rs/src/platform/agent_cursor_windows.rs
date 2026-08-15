//! Windows agent-cursor overlay — Mac parity.
//!
//! Matches `native/t3-desktop-mcp/Sources/AgentCursor.swift`:
//! soft lavender glow, rounded arrow, curved Bezier flight with heading that
//! follows the path tangent (frozen on land — no upright settle wiggle),
//! idle breathe. No click ring. Disabled with `T3_DESKTOP_AGENT_CURSOR=0`.
//!
//! Fade is driven by Computer Use `tools/call` activity (see
//! `note_desktop_tool_*`), not a wall-clock idle after the last move.

use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP,
    HGDIOBJ, ReleaseDC, SelectObject,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, GetWindowRect, KillTimer, MSG,
    PostMessageW, PostQuitMessage, RegisterClassExW, SetTimer, SetWindowPos, ShowWindow,
    TranslateMessage, UpdateLayeredWindow, CS_HREDRAW, CS_VREDRAW, HWND_TOPMOST, SWP_NOACTIVATE,
    SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, ULW_ALPHA, WM_DESTROY, WM_TIMER,
    WM_USER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::w;

const SIDE: i32 = 112;
const HOTSPOT: f64 = 56.0;
const WM_AGENT_MOVE: u32 = WM_USER + 40;
const WM_AGENT_PRESS: u32 = WM_USER + 41;
const WM_AGENT_HIDE: u32 = WM_USER + 42;
/// Brief grace after the last desktop tools/call before fading — cancelled if
/// another tools/call starts. Override with `T3_DESKTOP_AGENT_CURSOR_TASK_FADE_SECS`.
const DEFAULT_TASK_FADE: Duration = Duration::from_secs(8);
const FADE_OUT_MS: f64 = 350.0;
const FADE_IN_MS: f64 = 500.0;
const TICK_MS: u32 = 16; // ~60fps

static ENABLED: AtomicBool = AtomicBool::new(true);
static HWND_PTR: AtomicIsize = AtomicIsize::new(0);
static CURSOR: OnceLock<AgentCursor> = OnceLock::new();
static LAST_POINT: Mutex<Option<(f64, f64)>> = Mutex::new(None);
static TASK_HIDE_GEN: AtomicU64 = AtomicU64::new(0);
/// Generation that should trigger hide when `FADE_DEADLINE_MS` elapses.
static FADE_TARGET_GEN: AtomicU64 = AtomicU64::new(0);
/// Deadline (ms since unix epoch) for the single fade watcher thread.
static FADE_DEADLINE_MS: AtomicU64 = AtomicU64::new(0);
static FADE_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

pub struct AgentCursor;

impl AgentCursor {
    pub fn shared() -> &'static Self {
        CURSOR.get_or_init(|| {
            ENABLED.store(agent_cursor_enabled(), Ordering::Relaxed);
            if ENABLED.load(Ordering::Relaxed) {
                let _ = thread::Builder::new()
                    .name("t3-agent-cursor".into())
                    .spawn(ui_thread);
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
        let hwnd = HWND(HWND_PTR.load(Ordering::Relaxed) as *mut _);
        if hwnd.0.is_null() {
            return;
        }
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_AGENT_HIDE, WPARAM(0), LPARAM(0));
        }
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

/// One long-lived watcher thread — avoids spawning a sleeper per tools/call.
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
                // Clear only if this deadline is still armed (a newer finish
                // may have replaced it while we slept).
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
    let wait = {
        let mut last = LAST_POINT.lock().unwrap_or_else(|e| e.into_inner());
        let micros = travel_wait_micros(*last, x, y);
        *last = Some((x, y));
        micros
    };
    post(
        if press {
            WM_AGENT_PRESS
        } else {
            WM_AGENT_MOVE
        },
        x,
        y,
    );
    if wait > 0 {
        thread::sleep(Duration::from_micros(wait));
    }
}

/// Fire-and-forget move for mid-drag hops — never blocks with the button held.
fn move_no_wait(x: f64, y: f64) {
    if let Ok(mut last) = LAST_POINT.lock() {
        *last = Some((x, y));
    }
    post(WM_AGENT_MOVE, x, y);
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

fn post(msg: u32, x: f64, y: f64) {
    let hwnd = HWND(HWND_PTR.load(Ordering::Relaxed) as *mut _);
    if hwnd.0.is_null() {
        return;
    }
    let xi = x.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16 as u16 as isize;
    let yi = y.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16 as u16 as isize;
    unsafe {
        let _ = PostMessageW(Some(hwnd), msg, WPARAM(0), LPARAM((yi << 16) | xi));
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

struct Framebuf {
    bits: *mut u8,
    hdc: windows::Win32::Graphics::Gdi::HDC,
    dib: HBITMAP,
    old: HGDIOBJ,
}

fn ui_thread() {
    unsafe {
        let class = w!("T3AgentCursorOverlay");
        let module = GetModuleHandleW(None).unwrap_or_default();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(wnd_proc),
            hInstance: HINSTANCE(module.0),
            lpszClassName: class,
            ..Default::default()
        };
        let _ = RegisterClassExW(&wc);

        let hwnd = match CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("T3 Agent Cursor"),
            WS_POPUP,
            0,
            0,
            SIDE,
            SIDE,
            None,
            None,
            Some(HINSTANCE(module.0)),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(_) => return,
        };
        HWND_PTR.store(hwnd.0 as isize, Ordering::Relaxed);
        let _ = ShowWindow(hwnd, SW_HIDE);

        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        HWND_PTR.store(0, Ordering::Relaxed);
    }
}

thread_local! {
    static STATE: std::cell::RefCell<Anim> = std::cell::RefCell::new(Anim::new());
    static FB: std::cell::RefCell<Option<Framebuf>> = const { std::cell::RefCell::new(None) };
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_AGENT_MOVE | WM_AGENT_PRESS => {
                let x = (lparam.0 & 0xFFFF) as i16 as f64;
                let y = ((lparam.0 >> 16) & 0xFFFF) as i16 as f64;
                let popping = msg == WM_AGENT_PRESS;
                STATE.with(|cell| {
                    let mut state = cell.borrow_mut();
                    begin(&mut state, x, y, popping);
                    ensure_shown(hwnd, &state);
                });
                FB.with(|cell| {
                    let mut slot = cell.borrow_mut();
                    if slot.is_none() {
                        *slot = make_framebuf(hwnd);
                    }
                });
                let _ = SetTimer(Some(hwnd), 1, TICK_MS, None);
                STATE.with(|state_cell| {
                    FB.with(|fb_cell| {
                        let mut state = state_cell.borrow_mut();
                        let mut fb = fb_cell.borrow_mut();
                        tick(hwnd, &mut state, fb.as_mut());
                    });
                });
                LRESULT(0)
            }
            WM_AGENT_HIDE => {
                STATE.with(|cell| {
                    let mut state = cell.borrow_mut();
                    state.fading = true;
                });
                let _ = SetTimer(Some(hwnd), 1, TICK_MS, None);
                LRESULT(0)
            }
            WM_TIMER => {
                let keep = STATE.with(|state_cell| {
                    FB.with(|fb_cell| {
                        let mut state = state_cell.borrow_mut();
                        let mut fb = fb_cell.borrow_mut();
                        tick(hwnd, &mut state, fb.as_mut())
                    })
                });
                if !keep {
                    let _ = KillTimer(Some(hwnd), 1);
                }
                LRESULT(0)
            }
            WM_DESTROY => {
                FB.with(|cell| {
                    if let Some(fb) = cell.borrow_mut().take() {
                        destroy_framebuf(fb);
                    }
                });
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }
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

unsafe fn ensure_shown(hwnd: HWND, state: &Anim) {
    if let Some((cx, cy)) = state.current {
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                (cx - HOTSPOT).round() as i32,
                (cy - HOTSPOT).round() as i32,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

/// Returns false when the animation can sleep (timer may stop).
unsafe fn tick(hwnd: HWND, state: &mut Anim, fb: Option<&mut Framebuf>) -> bool {
    let mut busy = false;

    if state.fading {
        state.alpha = (state.alpha - (TICK_MS as f64) / FADE_OUT_MS).max(0.0);
        busy = state.alpha > 0.0;
        if state.alpha <= 0.0 {
            state.visible = false;
            state.current = None;
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
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

            unsafe {
                let (cx, cy) = state.current.unwrap_or(cur);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    (cx - HOTSPOT).round() as i32,
                    (cy - HOTSPOT).round() as i32,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        } else {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    (cur.0 - HOTSPOT).round() as i32,
                    (cur.1 - HOTSPOT).round() as i32,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    }

    if state.visible && state.alpha > 0.05 {
        state.phase += 0.08;
        busy = true;
    }

    if let Some(fb) = fb {
        unsafe {
            render(fb, state);
            present(hwnd, fb, state.alpha);
        }
    }

    busy || state.visible
}

unsafe fn make_framebuf(hwnd: HWND) -> Option<Framebuf> {
    unsafe {
        let screen = GetDC(Some(hwnd));
        if screen.is_invalid() {
            return None;
        }
        let hdc = CreateCompatibleDC(Some(screen));
        let _ = ReleaseDC(Some(hwnd), screen);
        if hdc.is_invalid() {
            return None;
        }

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: SIDE,
                biHeight: -SIDE, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = match CreateDIBSection(Some(hdc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(dib) if !bits.is_null() => dib,
            _ => {
                let _ = DeleteDC(hdc);
                return None;
            }
        };
        let old = SelectObject(hdc, HGDIOBJ(dib.0));
        Some(Framebuf {
            bits: bits as *mut u8,
            hdc,
            dib,
            old,
        })
    }
}

unsafe fn destroy_framebuf(fb: Framebuf) {
    unsafe {
        let _ = SelectObject(fb.hdc, fb.old);
        let _ = DeleteObject(fb.dib.into());
        let _ = DeleteDC(fb.hdc);
    }
}

unsafe fn present(hwnd: HWND, fb: &Framebuf, alpha: f64) {
    unsafe {
        let mut src = POINT { x: 0, y: 0 };
        let mut size = SIZE {
            cx: SIDE,
            cy: SIDE,
        };
        let mut dst = POINT { x: 0, y: 0 };
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        dst.x = rect.left;
        dst.y = rect.top;

        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
            hwnd,
            None,
            Some(&dst),
            Some(&size),
            Some(fb.hdc),
            Some(&src),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
    }
}

fn put_px(buf: &mut [u8], x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
    if x < 0 || y < 0 || x >= SIDE || y >= SIDE || a == 0 {
        return;
    }
    let i = ((y * SIDE + x) * 4) as usize;
    // Premultiplied BGRA for UpdateLayeredWindow
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
            // stops: 0→0.72 lavender, 0.30→0.38, 0.65→0.14 purple, 1→0
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

unsafe fn render(fb: &mut Framebuf, state: &Anim) {
    let len = (SIDE * SIDE * 4) as usize;
    let buf = unsafe { std::slice::from_raw_parts_mut(fb.bits, len) };
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

    // Exact Mac artwork (shared with chrome extension icons/cursor-112.png).
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
    // Large travel spikes can drive scale ≤ 0 (div-by-zero / mirrored sprite)
    // or make the scan radius cover millions of off-frame pixels.
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
