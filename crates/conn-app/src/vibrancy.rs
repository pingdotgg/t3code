//! macOS window vibrancy as Conn's Electron window has it (`vibrancy: "under-window"`,
//! `visualEffectState: "followWindow"` in `DesktopWindow.ts`).
//!
//! GPUI's own `WindowBackgroundAppearance::Blurred` uses the same material but strips its tint
//! and saturation, leaving a plain blur: Conn's translucent shell tint (`--shell-fill`, 60%)
//! then sits on a much darker backdrop and the whole shell reads too dark. So the window is
//! opened `Transparent`, and this inserts a full `NSVisualEffectView` with its material intact
//! below GPUI's content.

use conn_theme::Appearance;
use gpui_kit::{App, Styled as _, Window};

/// Adds the vibrancy view behind every new root window and clears `gpui-component`'s opaque root
/// background so Conn's translucent shell fills composite over macOS vibrancy.
pub(crate) fn install(cx: &mut App) {
    cx.observe_new::<gpui_kit::base::Root>(|root, window, _| {
        // `gpui-component`'s `WindowState` RootPlugin refines `Root` with an opaque
        // `.bg(theme.tokens.background)` on every render. `Root::render` applies `root.style()`
        // after plugin styles, so setting transparent black here clears that opaque fill and lets
        // Conn's `shell_fill` (60%) and `shell_inner_fill` (76%) composite over the
        // `NSVisualEffectView` behind GPUI's transparent `CAMetalLayer` (matching Conn's
        // `html.electron-macos, html.electron-macos body { background: transparent !important; }`).
        root.style().background = Some(gpui_kit::transparent_black().into());
        if let Some(window) = window {
            add_vibrancy(window);
        }
    })
    .detach();
}

/// Syncs the macOS application appearance (`NSAppearanceNameAqua` / `NSAppearanceNameDarkAqua`)
/// with the active Conn theme, matching Conn's `ElectronTheme.ts` (`nativeTheme.themeSource`).
///
/// Without this, `NSVisualEffectView`'s `UnderWindowBackground` material follows the OS system
/// appearance instead of the selected Conn theme (e.g. light vibrancy under a dark theme or dark
/// vibrancy under a light theme).
#[cfg(target_os = "macos")]
pub(crate) fn sync_appearance(appearance: Appearance) {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};

    let name = match appearance {
        Appearance::Light => c"NSAppearanceNameAqua",
        Appearance::Dark => c"NSAppearanceNameDarkAqua",
    };

    let (Some(ns_string_cls), Some(ns_appearance_cls), Some(ns_app_cls)) = (
        AnyClass::get(c"NSString"),
        AnyClass::get(c"NSAppearance"),
        AnyClass::get(c"NSApplication"),
    ) else {
        return;
    };

    // SAFETY: Standard AppKit/Foundation calls on the main thread:
    // - `[[NSString alloc] initWithUTF8String:]` takes a NUL-terminated static C string and
    //   returns a +1 owned `NSString` wrapped in `Retained`.
    // - `+[NSAppearance appearanceNamed:]` returns an `NSAppearance` or `nil`.
    // - `+[NSApplication sharedApplication]` returns the singleton `NSApplication` instance.
    // - `-[NSApplication setAppearance:]` accepts a nullable `NSAppearance *`.
    unsafe {
        let allocated: *mut AnyObject = objc2::msg_send![ns_string_cls, alloc];
        let ns_name: Option<Retained<AnyObject>> = Retained::from_raw(objc2::msg_send![
            allocated,
            initWithUTF8String: name.as_ptr()
        ]);
        let Some(ns_name) = ns_name else {
            return;
        };
        let ns_appearance: Option<Retained<AnyObject>> =
            objc2::msg_send![ns_appearance_cls, appearanceNamed: &*ns_name];
        let Some(ns_appearance) = ns_appearance else {
            return;
        };
        let ns_app: Option<Retained<AnyObject>> = objc2::msg_send![ns_app_cls, sharedApplication];
        let Some(ns_app) = ns_app else {
            return;
        };
        let _: () = objc2::msg_send![&*ns_app, setAppearance: &*ns_appearance];
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn sync_appearance(_appearance: Appearance) {}

#[cfg(target_os = "macos")]
fn add_vibrancy(window: &Window) {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    // AppKit enum values (NSVisualEffectView.h, NSView.h, NSWindow.h).
    const MATERIAL_UNDER_WINDOW_BACKGROUND: isize = 21;
    const BLENDING_BEHIND_WINDOW: isize = 0;
    const STATE_FOLLOWS_WINDOW_ACTIVE_STATE: isize = 0;
    const AUTORESIZE_WIDTH_AND_HEIGHT: usize = 2 | 16;
    const ORDERING_BELOW: isize = -1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }
    // SAFETY: `NsRect` is `#[repr(C)]` with the layout of `NSRect` (`CGRect`: four f64s).
    unsafe impl objc2::Encode for NsRect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
            "CGRect",
            &[
                objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
                objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
            ],
        );
    }

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
        return;
    };
    // SAFETY: `handle.ns_view` is the window's live NSView, used on the main thread during this
    // synchronous callback.
    let view: &AnyObject = unsafe { handle.ns_view.cast::<AnyObject>().as_ref() };
    // SAFETY: `-[NSView window]` returns the view's window or nil.
    let ns_window: Option<Retained<AnyObject>> = unsafe { objc2::msg_send![view, window] };
    let Some(ns_window) = ns_window else {
        return;
    };
    // SAFETY: `-[NSWindow contentView]` returns the content view or nil.
    let content: Option<Retained<AnyObject>> =
        unsafe { objc2::msg_send![&*ns_window, contentView] };
    let Some(content) = content else {
        return;
    };
    // SAFETY: `-[NSView bounds]` returns an `NSRect` by value.
    let frame: NsRect = unsafe { objc2::msg_send![&*content, bounds] };
    // SAFETY: standard alloc/init of an AppKit view class on the main thread; the returned
    // object is owned (+1) and retained by `Retained`.
    let effect: Option<Retained<AnyObject>> = unsafe {
        let allocated: *mut AnyObject = objc2::msg_send![effect_class, alloc];
        let initialized: *mut AnyObject = objc2::msg_send![allocated, initWithFrame: frame];
        Retained::from_raw(initialized)
    };
    let Some(effect) = effect else {
        return;
    };
    // SAFETY: documented NSVisualEffectView / NSView setters taking NSInteger/NSUInteger enums,
    // and `-[NSView addSubview:positioned:relativeTo:]` with a nil sibling, all on the main
    // thread; the content view retains the subview.
    unsafe {
        let material = std::env::var("CONN_GPUI_VIBRANCY_MATERIAL")
            .ok()
            .and_then(|v| v.parse::<isize>().ok())
            .unwrap_or(MATERIAL_UNDER_WINDOW_BACKGROUND);
        let _: () = objc2::msg_send![&*effect, setMaterial: material];
        let _: () = objc2::msg_send![&*effect, setBlendingMode: BLENDING_BEHIND_WINDOW];
        let state = std::env::var("CONN_GPUI_VIBRANCY_STATE")
            .ok()
            .and_then(|v| v.parse::<isize>().ok())
            .unwrap_or(STATE_FOLLOWS_WINDOW_ACTIVE_STATE);
        let _: () = objc2::msg_send![&*effect, setState: state];
        let _: () = objc2::msg_send![&*effect, setAutoresizingMask: AUTORESIZE_WIDTH_AND_HEIGHT];
        let _: () = objc2::msg_send![&*effect, setAccessibilityElement: false];
        let nil: *mut AnyObject = std::ptr::null_mut();
        let _: () = objc2::msg_send![
            &*content,
            addSubview: &*effect,
            positioned: ORDERING_BELOW,
            relativeTo: nil
        ];
    }
    if std::env::var_os("CONN_GPUI_FRAME_LOG").is_some() {
        // SAFETY: `-[NSView subviews]` returns the content view's subviews array.
        let count: usize = unsafe {
            let subviews: Retained<AnyObject> = objc2::msg_send![&*content, subviews];
            objc2::msg_send![&*subviews, count]
        };
        let same = std::ptr::eq(view, &*content);
        eprintln!(
            "vibrancy: effect view added; content subviews {count}, gpui view is content view: {same}"
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn add_vibrancy(_window: &Window) {}

#[cfg(all(test, feature = "automation"))]
mod tests {
    use gpui_kit::{
        AppContext as _, Context, IntoElement, Render, Styled as _, TestAppContext, Window, div,
    };

    struct EmptyView;

    impl Render for EmptyView {
        fn render(&mut self, _: &mut Window, _: &mut Context<'_, Self>) -> impl IntoElement {
            div()
        }
    }

    #[gpui_kit::test]
    fn vibrancy_install_clears_root_opaque_background(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            super::install(cx);
        });
        let (root, _) = cx.add_window_view(|window, cx| {
            let content = cx.new(|_| EmptyView);
            gpui_kit::base::Root::new(content, window, cx)
        });
        root.update(cx, |root, _| {
            let bg = root.style().background.as_ref();
            assert!(
                bg.is_some(),
                "vibrancy::install must set an explicit background override on Root"
            );
            assert_eq!(
                bg.and_then(|fill| fill.color()),
                Some(gpui_kit::Background::from(gpui_kit::transparent_black())),
                "Root background override must be transparent so NSVisualEffectView shows through"
            );
        });
    }
}
