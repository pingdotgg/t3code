//! Real Wayland socket/FD transport against a private compositor fixture, no desktop access.
use crate::{
    capture::capture_on,
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
use wayland_protocols_wlr::foreign_toplevel::v1::server::{
    zwlr_foreign_toplevel_handle_v1::{self as toplevel, ZwlrForeignToplevelHandleV1 as Toplevel},
    zwlr_foreign_toplevel_manager_v1::{self as manager, ZwlrForeignToplevelManagerV1 as Manager},
};
use wayland_server::{
    Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New, Resource,
    backend::{ClientData, ClientId, DisconnectReason},
    protocol::{
        wl_buffer::{self, WlBuffer},
        wl_shm::{self, WlShm},
        wl_shm_pool::{self, WlShmPool},
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
struct Fixture {
    stop: UnixStream,
    thread: Option<thread::JoinHandle<()>>,
    captures: Arc<Mutex<Vec<u64>>>,
}
impl Fixture {
    fn start(mode: Mode) -> (Self, wayland_client::Connection) {
        let mut display = Display::<State>::new().unwrap();
        let handle = display.handle();
        handle.create_global::<State, WlShm, _>(1, ());
        handle.create_global::<State, Mapping, _>(1, ());
        handle.create_global::<State, Export, _>(2, ());
        handle.create_global::<State, Manager, _>(3, ());
        let (client, server) = UnixStream::pair().unwrap();
        display
            .handle()
            .insert_client(server, Arc::new(ClientState))
            .unwrap();
        let (stop, wake) = UnixStream::pair().unwrap();
        let captures = Arc::new(Mutex::new(Vec::new()));
        let mut state = State {
            mode,
            captures: captures.clone(),
        };
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
                captures,
            },
            wayland_client::Connection::from_socket(client).unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.stop.write_all(&[1]);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}

macro_rules! global {
    ($ty:ty) => {
        impl GlobalDispatch<$ty, ()> for State {
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
global!(Export);
global!(Mapping);
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
