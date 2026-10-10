//! Exercise real D-Bus FD passing and reply types without accessing the desktop bus.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.kde.KWin.ScreenShot2.Error")]
enum CaptureError {
    NoAuthorized(String),
    InvalidWindow(String),
}

#[derive(Default)]
struct State {
    denied: AtomicBool,
    change_identity: AtomicBool,
    spin_title: AtomicBool,
    captures: AtomicUsize,
    unloaded: AtomicUsize,
    script: Mutex<String>,
    captured_ids: Mutex<Vec<String>>,
}
struct Screenshots(Arc<State>);
#[zbus::interface(name = "org.kde.KWin.ScreenShot2")]
impl Screenshots {
    #[zbus(property)]
    fn version(&self) -> u32 {
        5
    }

    fn capture_window(
        &self,
        handle: &str,
        _options: HashMap<String, OwnedValue>,
        pipe: Fd<'_>,
    ) -> std::result::Result<HashMap<String, OwnedValue>, CaptureError> {
        if self.0.denied.load(Ordering::SeqCst) {
            return Err(CaptureError::NoAuthorized("Denied".into()));
        }
        if handle != "{window-1}" {
            return Err(CaptureError::InvalidWindow("Not a window".into()));
        }
        self.0.captured_ids.lock().unwrap().push(handle.into());
        self.write(pipe)
    }
    fn capture_active_window(
        &self,
        _options: HashMap<String, OwnedValue>,
        pipe: Fd<'_>,
    ) -> std::result::Result<HashMap<String, OwnedValue>, CaptureError> {
        if self.0.denied.load(Ordering::SeqCst) {
            return Err(CaptureError::NoAuthorized("Denied".into()));
        }
        self.write(pipe)
    }
}
impl Screenshots {
    fn write(
        &self,
        pipe: Fd<'_>,
    ) -> std::result::Result<HashMap<String, OwnedValue>, CaptureError> {
        self.0.captures.fetch_add(1, Ordering::SeqCst);
        let fd = pipe.as_fd().try_clone_to_owned().unwrap();
        std::thread::spawn(move || {
            let mut file = std::fs::File::from(fd);
            file.write_all(&[0xff112233_u32.to_ne_bytes(), 0xff445566_u32.to_ne_bytes()].concat())
                .unwrap();
        });
        Ok(HashMap::from([
            ("type".into(), Value::from("raw").try_to_owned().unwrap()),
            ("width".into(), 2_u32.into()),
            ("height".into(), 1_u32.into()),
            ("stride".into(), 8_u32.into()),
            ("format".into(), 5_u32.into()),
        ]))
    }
}

struct Scripting(Arc<State>);
#[zbus::interface(name = "org.kde.kwin.Scripting")]
impl Scripting {
    #[zbus(name = "loadScript")]
    fn load_script(&self, path: &str, _name: &str) -> i32 {
        *self.0.script.lock().unwrap() = std::fs::read_to_string(path).unwrap();
        1
    }
    #[zbus(name = "unloadScript")]
    fn unload_script(&self, _name: &str) -> bool {
        self.0.unloaded.fetch_add(1, Ordering::SeqCst);
        true
    }
}
struct LoadedScript(Arc<State>);
#[zbus::interface(name = "org.kde.kwin.Script")]
impl LoadedScript {
    #[zbus(name = "run")]
    async fn run(&self, #[zbus(connection)] connection: &zbus::Connection) {
        let source = self.0.script.lock().unwrap().clone();
        let destination = source
            .split("callDBus(")
            .nth(1)
            .unwrap()
            .split(',')
            .next()
            .unwrap();
        let destination: String = serde_json::from_str(destination).unwrap();
        let changed = self.0.change_identity.load(Ordering::SeqCst)
            && self.0.captures.load(Ordering::SeqCst) > 0;
        let title = if changed {
            "New document"
        } else if self.0.spin_title.load(Ordering::SeqCst) {
            if self.0.captures.load(Ordering::SeqCst) > 0 {
                "⠙ Document"
            } else {
                "⠋ Document"
            }
        } else {
            "Document"
        };
        let value = serde_json::json!({"id": "{window-1}", "title": title, "appName": "Kate", "appIdentifier": "org.kde.kate", "processId": 123, "bounds": {"x": 0, "y": 0, "width": 800, "height": 600}, "clientBounds": {"x": 0, "y": 29, "width": 800, "height": 571}}).to_string();
        connection
            .call_method(
                Some(destination.as_str()),
                "/com/t3tools/KdeCapture",
                Some("com.t3tools.KdeCapture"),
                "Reply",
                &(value,),
            )
            .await
            .unwrap();
    }
}

pub(super) struct Fixture {
    daemon: Child,
    directory: std::path::PathBuf,
    pub(super) _server: Connection,
    pub(super) client: Connection,
    pub(super) address: String,
    state: Arc<State>,
}
impl Fixture {
    pub(super) fn new() -> Self {
        // mktemp provides a private directory; no predictable paths or desktop bus env changes.
        let output = Command::new("mktemp")
            .args(["-d", "/tmp/t3-kde-bus-XXXXXX"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let directory = std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        let mut daemon = Command::new("dbus-daemon")
            .args([
                "--session",
                "--nofork",
                "--nopidfile",
                "--print-address",
                &format!("--address=unix:path={}/bus", directory.display()),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let state = Arc::new(State::default());
        let server = Builder::address(address.trim())
            .unwrap()
            .name(SCREENSHOT)
            .unwrap()
            .name("org.kde.KWin")
            .unwrap()
            .serve_at("/org/kde/KWin/ScreenShot2", Screenshots(state.clone()))
            .unwrap()
            .serve_at("/Scripting", Scripting(state.clone()))
            .unwrap()
            .serve_at("/Scripting/Script1", LoadedScript(state.clone()))
            .unwrap()
            .build()
            .unwrap();
        let client = Builder::address(address.trim())
            .unwrap()
            .method_timeout(DEADLINE)
            .build()
            .unwrap();
        Self {
            daemon,
            directory,
            _server: server,
            client,
            address: address.trim().to_owned(),
            state,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn permission_probe_never_captures_and_rejects_denial() {
    let f = Fixture::new();
    check(&f.client).unwrap();
    assert_eq!(f.state.captures.load(Ordering::SeqCst), 0);
    f.state.denied.store(true, Ordering::SeqCst);
    assert!(
        check(&f.client)
            .unwrap_err()
            .to_string()
            .contains("NoAuthorized")
    );
    assert!(capture(&f.client, &f.directory).is_err());
    assert_eq!(f.state.captures.load(Ordering::SeqCst), 0);
}

#[test]
fn captures_pinned_window_through_real_fd_and_cleans_scripts() {
    let f = Fixture::new();
    let identity = capture(&f.client, &f.directory).unwrap().unwrap();
    assert_eq!(identity.process_id, 123);
    assert_eq!(
        identity.client_bounds,
        Bounds {
            x: 0,
            y: 29,
            width: 800,
            height: 571
        }
    );
    assert_eq!(*f.state.captured_ids.lock().unwrap(), ["{window-1}"]);
    assert_eq!(f.state.unloaded.load(Ordering::SeqCst), 2);
    assert!(!f.directory.join("window.js").exists());
    let mut decoder = png::Decoder::new(BufReader::new(
        std::fs::File::open(f.directory.join("capture.png")).unwrap(),
    ))
    .read_info()
    .unwrap();
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    decoder.next_frame(&mut pixels).unwrap();
    assert_eq!(pixels, [0x11, 0x22, 0x33, 255, 0x44, 0x55, 0x66, 255]);
}

#[test]
fn omits_identity_when_window_changes_during_capture() {
    let f = Fixture::new();
    f.state.change_identity.store(true, Ordering::SeqCst);
    assert!(capture(&f.client, &f.directory).unwrap().is_none());
    assert!(f.directory.join("capture.png").exists());
}

#[test]
fn keeps_captured_identity_when_only_the_title_spinner_changes() {
    let f = Fixture::new();
    f.state.spin_title.store(true, Ordering::SeqCst);
    let identity = capture(&f.client, &f.directory).unwrap().unwrap();
    assert_eq!(identity.title, "⠋ Document");
    assert_eq!(identity.process_id, 123);
    assert_eq!(*f.state.captured_ids.lock().unwrap(), ["{window-1}"]);
    assert_eq!(f.state.unloaded.load(Ordering::SeqCst), 2);
}
