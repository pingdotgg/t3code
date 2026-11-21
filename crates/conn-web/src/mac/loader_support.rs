//! Runtime `dlopen` / `dlsym` loader replacing CEF's C++ wrapper on macOS.
//!
//! Exports `cef_load_library`, `cef_unload_library`, `cef_scoped_library_loader_create`,
//! and `cef_scoped_library_loader_free` so `cef-dll-sys` with `features = ["dox"]` links
//! without downloading CEF or invoking CMake at build time.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::Mutex;
use std::sync::atomic::{AtomicPtr, Ordering};

/// Loaded framework handle. Kept loaded for the lifetime of the process.
static LIBRARY: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// Last `dlerror` message recorded by `cef_load_library`.
static LOAD_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn last_load_error() -> Option<String> {
    LOAD_ERROR.lock().ok().and_then(|e| e.clone())
}

/// Cached function pointer slot resolved via `dlsym` on first call.
pub(crate) struct Slot {
    name: &'static CStr,
    found: AtomicPtr<c_void>,
}

impl Slot {
    pub(crate) const fn new(name: &'static CStr) -> Self {
        Self {
            name,
            found: AtomicPtr::new(std::ptr::null_mut()),
        }
    }

    pub(crate) fn get(&self) -> *mut c_void {
        let found = self.found.load(Ordering::Acquire);
        if !found.is_null() {
            return found;
        }
        let library = LIBRARY.load(Ordering::Acquire);
        if library.is_null() {
            missing(self.name, "before the CEF framework was loaded");
        }
        // SAFETY: `library` is a non-null handle returned by `dlopen` in
        // `cef_load_library` and never closed; `self.name` is a `'static CStr`.
        let found = unsafe { libc::dlsym(library, self.name.as_ptr()) };
        if found.is_null() {
            missing(self.name, "and was not found in the loaded CEF framework");
        }
        self.found.store(found, Ordering::Release);
        found
    }
}

fn missing(name: &CStr, why: &str) -> ! {
    eprintln!("conn-web: {} was called {why}", name.to_string_lossy());
    std::process::abort()
}

pub(crate) fn is_loaded() -> bool {
    !LIBRARY.load(Ordering::Acquire).is_null()
}

/// Opens the CEF framework binary at `path` using `RTLD_FIRST`.
///
/// # Safety
///
/// `path` must be null or point to a valid, NUL-terminated C string for the
/// duration of this call.
#[unsafe(no_mangle)]
#[expect(
    unreachable_pub,
    reason = "exported C symbol required by cef-dll-sys linkage"
)]
pub unsafe extern "C" fn cef_load_library(path: *const c_char) -> c_int {
    if is_loaded() {
        return 1;
    }
    if path.is_null() {
        return 0;
    }
    // SAFETY: Caller guarantees `path` is a valid NUL-terminated C string.
    let handle =
        unsafe { libc::dlopen(path, libc::RTLD_LAZY | libc::RTLD_LOCAL | libc::RTLD_FIRST) };
    if handle.is_null() {
        // SAFETY: `dlerror` takes no arguments and returns null or a thread-local C string.
        let why_ptr = unsafe { libc::dlerror() };
        let why = if why_ptr.is_null() {
            "unknown".to_owned()
        } else {
            // SAFETY: Non-null `dlerror` result is a valid NUL-terminated string
            // until the next dl* call on this thread.
            unsafe { CStr::from_ptr(why_ptr) }
                .to_string_lossy()
                .into_owned()
        };
        if let Ok(mut err) = LOAD_ERROR.lock() {
            *err = Some(why);
        }
        return 0;
    }
    LIBRARY.store(handle, Ordering::Release);
    1
}

/// Kept loaded for the lifetime of the process; reports success to `cef-rs`.
///
/// # Safety
///
/// Always safe to call; signature matches CEF's C API.
#[unsafe(no_mangle)]
#[expect(
    unreachable_pub,
    reason = "exported C symbol required by cef-dll-sys linkage"
)]
pub unsafe extern "C" fn cef_unload_library() -> c_int {
    1
}

/// Loads the CEF framework relative to the current executable (used by `cef::library_loader::LibraryLoader`).
///
/// # Safety
///
/// Always safe to call; signature matches CEF's C API.
#[unsafe(no_mangle)]
#[expect(
    unreachable_pub,
    reason = "exported C symbol required by cef-dll-sys linkage"
)]
pub unsafe extern "C" fn cef_scoped_library_loader_create(helper: c_int) -> *mut c_void {
    let Ok(exe) = std::env::current_exe() else {
        return std::ptr::null_mut();
    };
    let Some(dir) = exe.parent() else {
        return std::ptr::null_mut();
    };
    let relative = if helper != 0 {
        "../../../Chromium Embedded Framework.framework/Chromium Embedded Framework"
    } else {
        "../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework"
    };
    let Ok(path) = CString::new(dir.join(relative).to_string_lossy().into_owned()) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `path` is a valid NUL-terminated CString alive for the duration of the call.
    if unsafe { cef_load_library(path.as_ptr()) } == 1 {
        LIBRARY.load(Ordering::Acquire)
    } else {
        std::ptr::null_mut()
    }
}

/// No-op release matching `cef_scoped_library_loader_create`.
///
/// # Safety
///
/// Always safe to call; signature matches CEF's C API.
#[unsafe(no_mangle)]
#[expect(
    unreachable_pub,
    reason = "exported C symbol required by cef-dll-sys linkage"
)]
pub unsafe extern "C" fn cef_scoped_library_loader_free(_loader: *mut c_void) {}
