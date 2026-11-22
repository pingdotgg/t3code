//! CEF helper subprocess entry point on macOS.
//!
//! When CEF launches a renderer, GPU, network, or utility subprocess, it
//! re-executes the helper bundle binary with a `--type=<kind>` flag. Calling
//! [`maybe_run_subprocess`] at the top of `main()` intercepts those invocations
//! before GPUI or any application state initializes.

use crate::archive::Layout;
use cef::{args::Args, library_loader::LibraryLoader, sandbox::Sandbox, *};
use std::ffi::CString;

/// If this process was launched as a CEF helper subprocess (`--type=...`),
/// loads the CEF framework, runs `cef_execute_process`, and returns `Some(exit_code)`.
/// Otherwise returns `None`.
pub(crate) fn maybe_run_subprocess() -> Option<i32> {
    if !std::env::args().any(|arg| arg.starts_with("--type=")) {
        return None;
    }

    let args = Args::new();
    let sandboxed = !std::env::args().any(|arg| arg == "--no-sandbox");
    let sandbox = sandboxed.then(|| {
        let mut sandbox = Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    });

    if !load_framework_for_helper() {
        eprintln!("conn-web helper: failed to load Chromium Embedded Framework");
        return Some(1);
    }

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let code = execute_process(
        Some(args.as_main_args()),
        None::<&mut App>,
        std::ptr::null_mut(),
    );
    drop(sandbox);
    Some(code)
}

fn load_framework_for_helper() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        let loader = LibraryLoader::new(&exe, true);
        if loader.load() {
            // Keep the framework loaded for the lifetime of the helper process.
            std::mem::forget(loader);
            return true;
        }
    }

    // Fallback: locate the framework via the configured install layout.
    if let Ok(root) = Layout::default_root() {
        let binary = Layout::new(root).framework_binary();
        if let Ok(path) = CString::new(binary.to_string_lossy().into_owned()) {
            // SAFETY: `path` is a valid NUL-terminated CString alive through the call.
            if unsafe { super::loader_support::cef_load_library(path.as_ptr()) } == 1 {
                return true;
            }
        }
    }
    false
}
