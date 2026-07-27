//! Window chrome: the Windows 11 answer to the macOS app's transparent
//! `NSWindow` + behind-window Liquid Glass.
//!
//! macOS punches the window non-opaque so the WindowServer blurs the desktop
//! behind it (`TransparentWindowConfigurator`), then paints the layer stack
//! described in `Theme/GlassLayering.swift` on top. Windows 11 exposes the
//! same capability as a *system backdrop*: DWM composites the material behind
//! the window and the app paints over it. The mapping this file encodes:
//!
//! | macOS                              | Windows 11                        |
//! |------------------------------------|-----------------------------------|
//! | behind-window blur (desktop)       | `DWMSBT_MAINWINDOW` (Mica)        |
//! | translucent chrome over content    | `DWMSBT_TRANSIENTWINDOW` (Acrylic)|
//! | fully solid window (translucency 1)| `DWMSBT_NONE`                     |
//!
//! The renderer keeps owning the rest of the stack — plate, scenery photo and
//! legibility wash are the same math on both platforms (`src/theme/glass.ts`
//! is a direct port of `GlassLayering.swift`), so the honesty invariant
//! ("photo + wash cover exactly the translucency the user picked") holds
//! unchanged. Only the bottom layer differs.
//!
//! Everything here is a no-op on non-Windows hosts so the crate still builds
//! and tests on the development machine.

use serde::{Deserialize, Serialize};

/// Which system backdrop DWM should composite behind the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Backdrop {
    /// No material: the window is fully opaque. Matches translucency 1.0,
    /// where the macOS window plate reaches solid.
    None,
    /// Mica — the desktop wallpaper, heavily blurred and tinted. The closest
    /// analogue to macOS's behind-window blur for a long-lived main window.
    Mica,
    /// Mica Alt ("tabbed"): a stronger tint than Mica, which reads better
    /// under the app's always-dark chrome on light wallpapers.
    MicaAlt,
    /// Acrylic — a more translucent, higher-blur material. Windows guidance
    /// reserves it for transient surfaces, so it is offered but not default.
    Acrylic,
}

impl Backdrop {
    /// `DWM_SYSTEMBACKDROP_TYPE` values.
    #[cfg(windows)]
    const fn dwm_value(self) -> i32 {
        match self {
            Self::None => 1,    // DWMSBT_NONE
            Self::Mica => 2,    // DWMSBT_MAINWINDOW
            Self::Acrylic => 3, // DWMSBT_TRANSIENTWINDOW
            Self::MicaAlt => 4, // DWMSBT_TABBEDWINDOW
        }
    }
}

/// Applies the dark title bar and the requested system backdrop.
///
/// The macOS app forces `.dark` for every surface (`App.swift` sets both
/// `\.colorScheme` and `preferredColorScheme`), so the Windows title bar and
/// the DWM caption are pinned dark too rather than following the system theme.
#[cfg(windows)]
pub fn apply_window_chrome(
    window: &tauri::WebviewWindow,
    backdrop: Backdrop,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let raw = window.hwnd().map_err(|error| error.to_string())?;
    // Tauri may link a different `windows` crate version, so rebuild the
    // handle from the raw pointer rather than passing its `HWND` across.
    let hwnd = HWND(raw.0.cast());

    let dark: i32 = 1;
    // SAFETY: `hwnd` is a live top-level window and the value pointer/length
    // pair matches what each attribute documents.
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            std::ptr::from_ref(&dark).cast(),
            u32::try_from(std::mem::size_of::<i32>()).unwrap_or(4),
        )
        .map_err(|error| format!("could not set the dark title bar: {error}"))?;
    }

    let backdrop_value = backdrop.dwm_value();
    // SAFETY: same contract as above.
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            std::ptr::from_ref(&backdrop_value).cast(),
            u32::try_from(std::mem::size_of::<i32>()).unwrap_or(4),
        )
        .map_err(|error| format!("could not set the system backdrop: {error}"))?;
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn apply_window_chrome(
    _window: &tauri::WebviewWindow,
    _backdrop: Backdrop,
) -> Result<(), String> {
    // The development host renders the same UI without a system backdrop; the
    // renderer's own layer stack is what carries the design either way.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backdrop_round_trips_through_the_ipc_shape() {
        let json = serde_json::to_string(&Backdrop::MicaAlt).expect("serializes");
        assert_eq!(json, "\"mica-alt\"");
        let parsed: Backdrop = serde_json::from_str("\"acrylic\"").expect("parses");
        assert_eq!(parsed, Backdrop::Acrylic);
    }

    #[cfg(windows)]
    #[test]
    fn dwm_values_match_the_documented_enum() {
        assert_eq!(Backdrop::None.dwm_value(), 1);
        assert_eq!(Backdrop::Mica.dwm_value(), 2);
        assert_eq!(Backdrop::Acrylic.dwm_value(), 3);
        assert_eq!(Backdrop::MicaAlt.dwm_value(), 4);
    }
}
