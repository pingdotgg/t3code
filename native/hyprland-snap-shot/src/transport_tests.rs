//! Real Wayland socket/FD transport against a private compositor fixture, no desktop access.
use crate::{
    capture::capture_on,
    feedback, ipc,
    protocols::{
        export::server::{
            hyprland_toplevel_export_frame_v1::{
                self as frame, HyprlandToplevelExportFrameV1 as Frame,
            },
            hyprland_toplevel_export_manager_v1::{
                self as export, HyprlandToplevelExportManagerV1 as Export,
            },
        },
        mapping::server::{
            hyprland_toplevel_mapping_manager_v1::{
                self as mapping, HyprlandToplevelMappingManagerV1 as Mapping,
            },
            hyprland_toplevel_window_mapping_handle_v1::{
                self as handle, HyprlandToplevelWindowMappingHandleV1 as Handle,
            },
        },
    },
};
use std::{
    fs::File,
    io::{BufReader, Write},
    os::unix::{fs::FileExt, net::UnixStream},
    sync::{Arc, Mutex},
    thread,
};
use wayland_protocols::{
    wp::{
        presentation_time::server::{
            wp_presentation::{self, WpPresentation},
            wp_presentation_feedback::{self, WpPresentationFeedback},
        },
        viewporter::server::{
            wp_viewport::{self, WpViewport},
            wp_viewporter::{self, WpViewporter},
        },
    },
    xdg::xdg_output::zv1::server::{
        zxdg_output_manager_v1::{self, ZxdgOutputManagerV1},
        zxdg_output_v1::ZxdgOutputV1,
    },
};
use wayland_protocols_wlr::{
    foreign_toplevel::v1::server::{
        zwlr_foreign_toplevel_handle_v1::{
            self as toplevel, ZwlrForeignToplevelHandleV1 as Toplevel,
        },
        zwlr_foreign_toplevel_manager_v1::{
            self as manager, ZwlrForeignToplevelManagerV1 as Manager,
        },
    },
    layer_shell::v1::server::{
        zwlr_layer_shell_v1::{self, ZwlrLayerShellV1},
        zwlr_layer_surface_v1::ZwlrLayerSurfaceV1,
    },
};
use wayland_server::{
    Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New, Resource,
    backend::{ClientData, ClientId, DisconnectReason},
    protocol::{
        wl_buffer::{self, WlBuffer},
        wl_callback::WlCallback,
        wl_compositor::{self, WlCompositor},
        wl_output::{self, WlOutput},
        wl_region::WlRegion,
        wl_shm::{self, WlShm},
        wl_shm_pool::{self, WlShmPool},
        wl_subcompositor::{self, WlSubcompositor},
        wl_subsurface::{self, WlSubsurface},
        wl_surface::{self, WlSurface},
    },
};

const TARGET: u64 = 0x12345678abcdef01;
// Same low 32 bits: a truncated-address capture would pick the wrong window.
const OTHER: u64 = 0xfedcba98abcdef01;
#[derive(Clone, Copy)]
enum Mode {
    Success,
    Denied,
    BadBuffer,
}
struct State {
    mode: Mode,
    captures: Arc<Mutex<Vec<u64>>>,
}
#[derive(Debug)]
struct ClientState;
impl ClientData for ClientState {
    fn initialized(&self, _: ClientId) {}
    fn disconnected(&self, _: ClientId, _: DisconnectReason) {}
}
/// Serves one client from a background thread until the fixture drops.
struct Server {
    stop: UnixStream,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    /// Insert one client into `display` and dispatch it on a background thread.
    fn start<S: Send + 'static>(
        mut display: Display<S>,
        mut state: S,
    ) -> (Self, wayland_client::Connection) {
        let (client, server) = UnixStream::pair().unwrap();
        display
            .handle()
            .insert_client(server, Arc::new(ClientState))
            .unwrap();
        let (stop, wake) = UnixStream::pair().unwrap();
        let thread = thread::spawn(move || {
            loop {
                display.dispatch_clients(&mut state).unwrap();
                display.flush_clients().unwrap();
                let mut fds = [
                    rustix::event::PollFd::new(&display, rustix::event::PollFlags::IN),
                    rustix::event::PollFd::new(&wake, rustix::event::PollFlags::IN),
                ];
                rustix::event::poll(&mut fds, None).unwrap();
                if !fds[1].revents().is_empty() {
                    break;
                }
            }
        });
        (
            Self {
                stop,
                thread: Some(thread),
            },
            wayland_client::Connection::from_socket(client).unwrap(),
        )
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.write_all(&[1]);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
struct Fixture {
    _server: Server,
    captures: Arc<Mutex<Vec<u64>>>,
}
impl Fixture {
    fn start(mode: Mode) -> (Self, wayland_client::Connection) {
        let display = Display::<State>::new().unwrap();
        let handle = display.handle();
        handle.create_global::<State, WlShm, _>(1, ());
        handle.create_global::<State, Mapping, _>(1, ());
        handle.create_global::<State, Export, _>(2, ());
        handle.create_global::<State, Manager, _>(3, ());
        let captures = Arc::new(Mutex::new(Vec::new()));
        let state = State {
            mode,
            captures: captures.clone(),
        };
        let (server, connection) = Server::start(display, state);
        (
            Self {
                _server: server,
                captures,
            },
            connection,
        )
    }
}

macro_rules! global {
    ($state:ty, $ty:ty) => {
        impl GlobalDispatch<$ty, ()> for $state {
            fn bind(
                _: &mut Self,
                _: &DisplayHandle,
                _: &Client,
                resource: New<$ty>,
                _: &(),
                init: &mut DataInit<'_, Self>,
            ) {
                init.init(resource, ());
            }
        }
    };
}
macro_rules! noop {
    ($state:ty, $data:ty, $($ty:ty),+) => {$(
        impl Dispatch<$ty, $data> for $state {
            fn request(
                _: &mut Self,
                _: &Client,
                _: &$ty,
                _: <$ty as Resource>::Request,
                _: &$data,
                _: &DisplayHandle,
                _: &mut DataInit<'_, Self>,
            ) {
            }
        }
    )+};
}
global!(State, Export);
global!(State, Mapping);
impl GlobalDispatch<WlShm, ()> for State {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WlShm>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ()).format(wl_shm::Format::Argb8888);
    }
}
impl GlobalDispatch<Manager, ()> for State {
    fn bind(
        _: &mut Self,
        dh: &DisplayHandle,
        client: &Client,
        resource: New<Manager>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        let manager = init.init(resource, ());
        for address in [OTHER, TARGET] {
            let window = client
                .create_resource::<Toplevel, _, Self>(dh, 3, address)
                .unwrap();
            manager.toplevel(&window);
            window.title("same title".into());
            window.app_id("same-app".into());
            window.done();
        }
    }
}
impl Dispatch<Manager, ()> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &Manager,
        _: manager::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl Dispatch<Toplevel, u64> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &Toplevel,
        _: toplevel::Request,
        _: &u64,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl Dispatch<Handle, ()> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &Handle,
        _: handle::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl Dispatch<Mapping, ()> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &Mapping,
        request: mapping::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let mapping::Request::GetWindowForToplevelWlr { handle, toplevel } = request {
            let address = *toplevel.data::<u64>().unwrap();
            init.init(handle, ())
                .window_address((address >> 32) as u32, address as u32);
        }
    }
}
impl Dispatch<Export, ()> for State {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &Export,
        request: export::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            export::Request::CaptureToplevelWithWlrToplevelHandle {
                frame,
                overlay_cursor,
                handle,
            } => {
                assert_eq!(overlay_cursor, 0);
                state
                    .captures
                    .lock()
                    .unwrap()
                    .push(*handle.data::<u64>().unwrap());
                let frame = init.init(frame, ());
                match state.mode {
                    Mode::Denied => frame.failed(),
                    Mode::BadBuffer => {
                        frame.buffer(wl_shm::Format::Argb8888, 16384, 16384, 65536);
                        frame.buffer_done();
                    }
                    Mode::Success => {
                        frame.buffer(wl_shm::Format::Argb8888, 2, 1, 12);
                        frame.buffer_done();
                    }
                }
            }
            export::Request::CaptureToplevel { .. } => {
                panic!("Do not use truncated window addresses")
            }
            _ => {}
        }
    }
}
impl Dispatch<WlShm, ()> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlShm,
        request: wl_shm::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wl_shm::Request::CreatePool { id, fd, .. } = request {
            init.init(id, Arc::new(File::from(fd)));
        }
    }
}
struct BufferData {
    file: Arc<File>,
    offset: u64,
}
impl Dispatch<WlShmPool, Arc<File>> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlShmPool,
        request: wl_shm_pool::Request,
        file: &Arc<File>,
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wl_shm_pool::Request::CreateBuffer {
            id,
            offset,
            width,
            height,
            stride,
            ..
        } = request
        {
            assert_eq!((width, height, stride), (2, 1, 12));
            init.init(
                id,
                BufferData {
                    file: file.clone(),
                    offset: offset as u64,
                },
            );
        }
    }
}
impl Dispatch<WlBuffer, BufferData> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlBuffer,
        _: wl_buffer::Request,
        _: &BufferData,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
    }
}
impl Dispatch<Frame, ()> for State {
    fn request(
        _: &mut Self,
        _: &Client,
        resource: &Frame,
        request: frame::Request,
        _: &(),
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        if let frame::Request::Copy {
            buffer,
            ignore_damage,
        } = request
        {
            assert_eq!(ignore_damage, 1, "Static windows must not wait for damage");
            let data = buffer.data::<BufferData>().unwrap();
            data.file
                .write_all_at(&[30, 20, 10, 255, 60, 50, 40, 255, 0, 0, 0, 0], data.offset)
                .unwrap();
            resource.flags(frame::Flags::empty());
            resource.ready(0, 1, 0);
        }
    }
}

#[test]
fn exports_exact_window_over_real_fd_transport() {
    let (fixture, connection) = Fixture::start(Mode::Success);
    let directory = tempfile::tempdir().unwrap();
    capture_on(connection, TARGET, directory.path()).unwrap();
    assert_eq!(*fixture.captures.lock().unwrap(), [TARGET]);
    let mut reader = png::Decoder::new(BufReader::new(
        File::open(directory.path().join("capture.png")).unwrap(),
    ))
    .read_info()
    .unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    assert_eq!(pixels, [10, 20, 30, 255, 40, 50, 60, 255]);
}
#[test]
fn failed_export_produces_no_image_and_no_second_capture() {
    let (fixture, connection) = Fixture::start(Mode::Denied);
    let directory = tempfile::tempdir().unwrap();
    assert!(
        capture_on(connection, TARGET, directory.path())
            .unwrap_err()
            .to_string()
            .contains("permission")
    );
    assert_eq!(*fixture.captures.lock().unwrap(), [TARGET]);
    assert!(!directory.path().join("capture.png").exists());
}
#[test]
fn rejects_oversized_buffers_before_allocating_shared_memory() {
    let (_fixture, connection) = Fixture::start(Mode::BadBuffer);
    let directory = tempfile::tempdir().unwrap();
    assert!(
        capture_on(connection, TARGET, directory.path())
            .unwrap_err()
            .to_string()
            .contains("too large")
    );
    assert!(!directory.path().join("capture.png").exists());
}

/// One 1920x1080 output. Every request each wl_surface receives is logged by protocol id so
/// tests can check what the compositor was actually told, frame by frame.
struct Screen {
    log: Arc<Mutex<Vec<(u32, &'static str)>>>,
    image: Arc<Mutex<Option<u32>>>,
    // Presentation feedback is answered on the next commit, as a compositor would.
    presenting: Vec<WpPresentationFeedback>,
}
impl Screen {
    /// Serve the compositor globals and return a handle that reads the shared request log.
    fn start() -> (Server, wayland_client::Connection, Self) {
        let display = Display::<Screen>::new().unwrap();
        let handle = display.handle();
        handle.create_global::<Screen, WlShm, _>(1, ());
        handle.create_global::<Screen, WlCompositor, _>(6, ());
        handle.create_global::<Screen, WlSubcompositor, _>(1, ());
        handle.create_global::<Screen, WpViewporter, _>(1, ());
        handle.create_global::<Screen, WpPresentation, _>(1, ());
        handle.create_global::<Screen, ZwlrLayerShellV1, _>(4, ());
        handle.create_global::<Screen, ZxdgOutputManagerV1, _>(3, ());
        handle.create_global::<Screen, WlOutput, _>(4, ());
        let screen = Screen {
            log: Arc::new(Mutex::new(Vec::new())),
            image: Arc::new(Mutex::new(None)),
            presenting: Vec::new(),
        };
        let mirror = Screen {
            log: screen.log.clone(),
            image: screen.image.clone(),
            presenting: Vec::new(),
        };
        let (server, connection) = Server::start(display, screen);
        (server, connection, mirror)
    }
    /// Requests the capture's subsurface received, in order.
    fn image_requests(&self) -> Vec<&'static str> {
        let image = self
            .image
            .lock()
            .unwrap()
            .expect("no subsurface was created");
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| *id == image)
            .map(|(_, name)| *name)
            .collect()
    }
    /// Record a request on `surface` under a short name the test can count.
    fn log(&self, surface: &WlSurface, name: &'static str) {
        self.log
            .lock()
            .unwrap()
            .push((surface.id().protocol_id(), name));
    }
}
global!(Screen, WlCompositor);
global!(Screen, WlSubcompositor);
global!(Screen, WpViewporter);
global!(Screen, ZwlrLayerShellV1);
global!(Screen, ZxdgOutputManagerV1);
impl GlobalDispatch<WlShm, ()> for Screen {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WlShm>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ()).format(wl_shm::Format::Argb8888);
    }
}
impl GlobalDispatch<WpPresentation, ()> for Screen {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WpPresentation>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ()).clock_id(1);
    }
}
impl GlobalDispatch<WlOutput, ()> for Screen {
    fn bind(
        _: &mut Self,
        _: &DisplayHandle,
        _: &Client,
        resource: New<WlOutput>,
        _: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        // `done` follows the xdg_output geometry, as wlroots-style compositors send it.
        let output = init.init(resource, ());
        output.geometry(
            0,
            0,
            600,
            340,
            wl_output::Subpixel::Unknown,
            "T3".into(),
            "Fixture".into(),
            wl_output::Transform::Normal,
        );
        output.mode(wl_output::Mode::Current, 1920, 1080, 60000);
        output.scale(1);
    }
}
impl Dispatch<ZxdgOutputManagerV1, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &ZxdgOutputManagerV1,
        request: zxdg_output_manager_v1::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let zxdg_output_manager_v1::Request::GetXdgOutput { id, output } = request {
            let xdg = init.init(id, ());
            xdg.logical_position(0, 0);
            xdg.logical_size(1920, 1080);
            output.done();
        }
    }
}
impl Dispatch<WlCompositor, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlCompositor,
        request: wl_compositor::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wl_compositor::Request::CreateSurface { id } => {
                init.init(id, ());
            }
            wl_compositor::Request::CreateRegion { id } => {
                init.init(id, ());
            }
            _ => {}
        }
    }
}
impl Dispatch<WlSurface, ()> for Screen {
    fn request(
        state: &mut Self,
        _: &Client,
        surface: &WlSurface,
        request: wl_surface::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            wl_surface::Request::Attach { .. } => state.log(surface, "attach"),
            wl_surface::Request::Damage { .. } | wl_surface::Request::DamageBuffer { .. } => {
                state.log(surface, "damage")
            }
            wl_surface::Request::Commit => {
                state.log(surface, "commit");
                for feedback in state.presenting.drain(..) {
                    feedback.presented(
                        0,
                        0,
                        0,
                        16_666_666,
                        0,
                        0,
                        wp_presentation_feedback::Kind::empty(),
                    );
                }
            }
            // Frame callbacks are never answered: tests drive frames explicitly.
            wl_surface::Request::Frame { callback } => {
                init.init(callback, ());
            }
            _ => {}
        }
    }
}
impl Dispatch<WlSubcompositor, ()> for Screen {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WlSubcompositor,
        request: wl_subcompositor::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wl_subcompositor::Request::GetSubsurface { id, surface, .. } = request {
            *state.image.lock().unwrap() = Some(surface.id().protocol_id());
            init.init(id, surface);
        }
    }
}
impl Dispatch<WlSubsurface, WlSurface> for Screen {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WlSubsurface,
        request: wl_subsurface::Request,
        surface: &WlSurface,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        if let wl_subsurface::Request::SetPosition { .. } = request {
            state.log(surface, "position");
        }
    }
}
impl Dispatch<WpViewporter, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WpViewporter,
        request: wp_viewporter::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wp_viewporter::Request::GetViewport { id, surface } = request {
            init.init(id, surface);
        }
    }
}
impl Dispatch<WpViewport, WlSurface> for Screen {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WpViewport,
        request: wp_viewport::Request,
        surface: &WlSurface,
        _: &DisplayHandle,
        _: &mut DataInit<'_, Self>,
    ) {
        match request {
            wp_viewport::Request::SetSource { .. } => state.log(surface, "source"),
            wp_viewport::Request::SetDestination { .. } => state.log(surface, "destination"),
            _ => {}
        }
    }
}
impl Dispatch<WpPresentation, ()> for Screen {
    fn request(
        state: &mut Self,
        _: &Client,
        _: &WpPresentation,
        request: wp_presentation::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wp_presentation::Request::Feedback { callback, .. } = request {
            state.presenting.push(init.init(callback, ()));
        }
    }
}
impl Dispatch<ZwlrLayerShellV1, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &ZwlrLayerShellV1,
        request: zwlr_layer_shell_v1::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let zwlr_layer_shell_v1::Request::GetLayerSurface { id, .. } = request {
            init.init(id, ()).configure(1, 1920, 1080);
        }
    }
}
impl Dispatch<WlShm, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlShm,
        request: wl_shm::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wl_shm::Request::CreatePool { id, .. } = request {
            init.init(id, ());
        }
    }
}
impl Dispatch<WlShmPool, ()> for Screen {
    fn request(
        _: &mut Self,
        _: &Client,
        _: &WlShmPool,
        request: wl_shm_pool::Request,
        _: &(),
        _: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let wl_shm_pool::Request::CreateBuffer { id, .. } = request {
            init.init(id, ());
        }
    }
}
noop!(
    Screen,
    (),
    WlBuffer,
    WlCallback,
    WlOutput,
    WlRegion,
    WpPresentationFeedback,
    ZwlrLayerSurfaceV1,
    ZxdgOutputV1
);

#[test]
fn flight_frames_reattach_the_capture_without_redamaging_it() {
    let (_server, connection, screen) = Screen::start();
    let options = serde_json::from_value(serde_json::json!({
        "bounds": {"x": 100, "y": 100, "width": 400, "height": 200},
        "pid": 7, "flash": false, "animate": true,
    }))
    .unwrap();
    let (_connection, mut queue, mut state) =
        feedback::connect(connection, &[255; 2 * 4], (2, 1), options).unwrap();
    let qh = queue.handle();
    // Configure paints the capture in place, presentation feedback marks the overlay ready,
    // and a final roundtrip lets the server log the ready frame's requests.
    for _ in 0..3 {
        queue.roundtrip(&mut state).unwrap();
    }
    let before = screen.image_requests();
    assert_eq!(before.iter().filter(|r| **r == "damage").count(), 1);
    assert!(before.contains(&"commit"));

    let window: ipc::Window = serde_json::from_value(serde_json::json!({
        "address": "0x1", "pid": 7, "title": "T3 Code", "class": "t3code",
        "at": [800, 300], "size": [600, 400], "mapped": true, "hidden": false,
    }))
    .unwrap();
    let dest = ipc::Rect {
        x: 900.,
        y: 400.,
        width: 100.,
        height: 50.,
    };
    state.fly(dest, window, &qh).unwrap();
    state.draw(&qh).unwrap();
    state.draw(&qh).unwrap();
    queue.roundtrip(&mut state).unwrap();
    let frames = screen.image_requests()[before.len()..].to_vec();
    // Hyprland 0.56 sizes a subsurface from its last attached buffer, not its viewport, so
    // each flight frame must reattach the existing buffer. The pixels are unchanged, so
    // a frame never damages them again.
    let count = |name| frames.iter().filter(|r| **r == name).count();
    assert_eq!(count("commit"), 3);
    assert_eq!(count("destination"), 3);
    assert_eq!(count("attach"), 3, "{frames:?}");
    assert_eq!(count("damage"), 0, "{frames:?}");
    for frame in frames.split(|r| *r == "commit").filter(|f| !f.is_empty()) {
        assert!(frame.contains(&"attach"), "{frames:?}");
    }
}
