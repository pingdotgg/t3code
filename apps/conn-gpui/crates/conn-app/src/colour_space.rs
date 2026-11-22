//! Tags every macOS window's `CAMetalLayer` as sRGB so painted colors match
//! Conn's sRGB tokens on wide-gamut displays.

use gpui_kit::{App, Window};

/// Observes every new root window and tags its Metal layer with sRGB.
pub(crate) fn install(cx: &mut App) {
    cx.observe_new::<gpui_kit::base::Root>(|_, window, _| {
        if let Some(window) = window {
            tag_srgb(window);
        }
    })
    .detach();
}

#[cfg(target_os = "macos")]
fn tag_srgb(window: &Window) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_core_graphics::{CGColorSpace, kCGColorSpaceSRGB};
    use objc2_quartz_core::CAMetalLayer;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: `handle.ns_view` is the window's live NSView on the main thread
    // for the duration of this synchronous callback.
    let view: &AnyObject = unsafe { handle.ns_view.cast::<AnyObject>().as_ref() };
    // SAFETY: `-[NSView layer]` takes no arguments and returns a retained
    // `CALayer` or `nil`, matching `Option<Retained<AnyObject>>`.
    let layer: Option<Retained<AnyObject>> = unsafe { objc2::msg_send![view, layer] };
    let Some(Ok(layer)) = layer.map(|l| l.downcast::<CAMetalLayer>()) else {
        return;
    };
    if layer.colorspace().is_some() {
        return;
    }
    // SAFETY: `kCGColorSpaceSRGB` is an immutable Core Graphics extern constant.
    let srgb = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }));
    layer.setColorspace(srgb.as_deref());
}

#[cfg(not(target_os = "macos"))]
fn tag_srgb(_window: &Window) {}
