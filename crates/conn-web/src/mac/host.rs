//! macOS CEF host lifecycle: framework `dlopen`, AppKit hooks, and nested
//! Chromium message loop integration on the main thread.

use crate::archive::{self, Layout};
use crate::{StartOptions, WebError, WebRuntimeState};
use cef::{args::Args, *};
use std::cell::RefCell;
use std::ffi::{CStr, CString, c_char};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

unsafe extern "C" {
    fn conn_cef_install_app_hooks();
    fn conn_cef_start_message_loop();
    fn conn_main_bundle_identifier() -> *const c_char;
}

static STATE: Mutex<WebRuntimeState> = Mutex::new(WebRuntimeState::NotInstalled);
static INITIALIZE_CALLED: AtomicBool = AtomicBool::new(false);

thread_local! {
    static PENDING: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
}

pub(crate) fn set_state(next: WebRuntimeState) {
    if let Ok(mut state) = STATE.lock() {
        *state = next;
    }
}

pub(crate) fn state() -> WebRuntimeState {
    STATE
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| WebRuntimeState::Failed("web runtime state lock poisoned".into()))
}

fn bundle_identifier() -> Option<String> {
    // SAFETY: `conn_main_bundle_identifier` reads `NSBundle.mainBundle.bundleIdentifier`
    // and returns null or a NUL-terminated UTF-8 string owned by the main bundle.
    let ptr = unsafe { conn_main_bundle_identifier() };
    if ptr.is_null() {
        return None;
    }
    // SAFETY: Non-null return value is a valid NUL-terminated UTF-8 string
    // backed by `NSBundle.mainBundle` for the duration of this copy.
    Some(
        unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned(),
    )
}

fn path_to_cef_string(path: &std::path::Path) -> CefString {
    CefString::from(path.to_string_lossy().as_ref())
}

/// Starts CEF on the main thread (at most once per process).
pub(crate) fn start(options: StartOptions) -> Result<(), WebError> {
    match state() {
        WebRuntimeState::Starting | WebRuntimeState::Running => return Ok(()),
        WebRuntimeState::Failed(why) if INITIALIZE_CALLED.load(Ordering::Acquire) => {
            return Err(WebError::Runtime(why));
        }
        WebRuntimeState::NotInstalled
        | WebRuntimeState::Downloading { .. }
        | WebRuntimeState::Failed(_) => {}
    }

    let archive = archive::current_archive().ok_or(WebError::Unsupported(
        "CEF is not supported on this platform",
    ))?;
    let layout = Layout::new(Layout::default_root()?);
    if !archive::is_installed(&layout, &archive.pin()) {
        return Err(WebError::NotInstalled);
    }

    let current_exe = std::env::current_exe()?;
    let bundle_id = bundle_identifier().unwrap_or_else(|| "dev.conn.gpui".to_owned());
    let helper_exe = archive::make_helpers(&layout, &current_exe, &bundle_id)?;

    let framework_binary = layout.framework_binary();
    let binary_cstr =
        CString::new(framework_binary.to_string_lossy().into_owned()).map_err(|_| {
            WebError::Runtime("CEF framework path contains an interior NUL byte".into())
        })?;

    // SAFETY: `binary_cstr` is a valid NUL-terminated CString alive through the call.
    if unsafe { super::loader_support::cef_load_library(binary_cstr.as_ptr()) } != 1 {
        let detail = super::loader_support::last_load_error()
            .unwrap_or_else(|| "unknown dlopen error".to_owned());
        let why = format!(
            "failed to load CEF framework from {}: {detail}",
            framework_binary.display()
        );
        set_state(WebRuntimeState::Failed(why.clone()));
        return Err(WebError::Runtime(why));
    }

    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    // SAFETY: `conn_cef_install_app_hooks` swizzles `NSApplication -sendEvent:`
    // once via `dispatch_once` and attaches `CefAppProtocol` on the main thread.
    unsafe { conn_cef_install_app_hooks() };

    let args = Args::new();
    let mut app = BrowserApp::new();
    if execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    ) >= 0
    {
        let why = "CEF treated the host process as a subprocess; call conn_web::maybe_run_subprocess() at the top of main()".to_owned();
        set_state(WebRuntimeState::Failed(why.clone()));
        return Err(WebError::Runtime(why));
    }

    let profile_dir = options.profile_dir.unwrap_or_else(|| layout.profile());
    std::fs::create_dir_all(&profile_dir)?;

    let log_file = layout.log_file();
    let settings = Settings {
        // Unsandboxed because CEF is installed on-demand in Application Support
        // rather than bundled inside the signed .app container.
        no_sandbox: 1,
        main_bundle_path: path_to_cef_string(&layout.runtime_bundle()),
        browser_subprocess_path: path_to_cef_string(&helper_exe),
        framework_dir_path: path_to_cef_string(&layout.framework()),
        external_message_pump: 0,
        multi_threaded_message_loop: 0,
        windowless_rendering_enabled: 1,
        root_cache_path: path_to_cef_string(&profile_dir),
        cache_path: path_to_cef_string(&profile_dir.join("browser")),
        persist_session_cookies: 1,
        remote_debugging_port: options.remote_debugging_port.map_or(0, i32::from),
        log_file: path_to_cef_string(&log_file),
        log_severity: LogSeverity::WARNING,
        ..Default::default()
    };

    set_state(WebRuntimeState::Starting);
    PENDING.with(|pending| {
        *pending.borrow_mut() = Some(Box::new(move || {
            let mut app = app;
            INITIALIZE_CALLED.store(true, Ordering::Release);
            if initialize(
                Some(args.as_main_args()),
                Some(&settings),
                Some(&mut app),
                std::ptr::null_mut(),
            ) != 1
            {
                let code = get_exit_code();
                let why = format!("cef_initialize failed with exit code {code}");
                tracing::error!(exit_code = code, "CEF failed to initialize");
                set_state(WebRuntimeState::Failed(why));
                return;
            }
            run_message_loop();
        }));
    });

    // SAFETY: Schedules a `CFRunLoopTimer` on the main run loop to start CEF.
    unsafe { conn_cef_start_message_loop() };
    Ok(())
}

/// Exits Chromium's nested message loop if running.
pub(crate) fn quit() {
    if state() == WebRuntimeState::Running {
        quit_message_loop();
    }
}

/// Callback invoked by `native/appkit_hooks.m` from its main `CFRunLoopTimer`.
#[unsafe(no_mangle)]
#[expect(
    unreachable_pub,
    reason = "C callback invoked by native/appkit_hooks.m"
)]
pub extern "C" fn conn_cef_run_message_loop() {
    if let Some(start_fn) = PENDING.with(|pending| pending.borrow_mut().take()) {
        start_fn();
    }
}

fn browser_switches(command_line: &mut CommandLine) {
    for switch in [
        "use-mock-keychain",
        "disable-background-networking",
        "disable-component-update",
        "no-pings",
    ] {
        command_line.append_switch(Some(&CefString::from(switch)));
    }
}

wrap_app! {
    struct BrowserApp;

    impl App {
        fn on_before_command_line_processing(
            &self,
            process_type: Option<&CefString>,
            command_line: Option<&mut CommandLine>,
        ) {
            let is_browser = process_type.is_none_or(|t| t.to_string().is_empty());
            if let (true, Some(command_line)) = (is_browser, command_line) {
                browser_switches(command_line);
            }
        }

        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(BrowserProcess::new())
        }
    }
}

wrap_browser_process_handler! {
    struct BrowserProcess;

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            set_state(WebRuntimeState::Running);
        }
    }
}
