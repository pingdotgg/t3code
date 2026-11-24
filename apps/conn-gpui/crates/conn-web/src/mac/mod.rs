//! macOS CEF runtime loader, helper subprocess entry, host lifecycle, and native view.

pub(crate) mod helper;
pub(crate) mod host;

// Generated from cef-dll-sys's macOS bindings; rustfmt leaves it as written.
#[rustfmt::skip]
#[expect(
    clippy::undocumented_unsafe_blocks,
    unreachable_pub,
    reason = "generated CEF C API forwarders exported for cef-dll-sys linkage"
)]
mod loader;
mod loader_support;
mod toolbar_hooks;

pub(crate) mod view;
