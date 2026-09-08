use crate::{
    Result,
    protocols::{
        export::{
            hyprland_toplevel_export_frame_v1::{
                self as frame, HyprlandToplevelExportFrameV1 as Frame,
            },
            hyprland_toplevel_export_manager_v1::HyprlandToplevelExportManagerV1 as Export,
        },
        mapping::{
            hyprland_toplevel_mapping_manager_v1::HyprlandToplevelMappingManagerV1 as Mapping,
            hyprland_toplevel_window_mapping_handle_v1::{
                self as mapping, HyprlandToplevelWindowMappingHandleV1 as Handle,
            },
        },
    },
};
use smithay_client_toolkit::{
    delegate_registry, delegate_shm,
    registry::{ProvidesRegistryState, RegistryState},
    shm::{
        Shm, ShmHandler,
        slot::{Buffer, SlotPool},
    },
};
use std::{
    fs::OpenOptions,
    io::BufWriter,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, EventQueue, QueueHandle, WEnum, delegate_noop,
    globals::{GlobalList, registry_queue_init},
    protocol::wl_shm,
};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1::{self as toplevel, ZwlrForeignToplevelHandleV1 as Toplevel},
    zwlr_foreign_toplevel_manager_v1::{self as manager, ZwlrForeignToplevelManagerV1 as Manager},
};

struct Capture {
    registry: RegistryState,
    shm: Shm,
    mapping: Mapping,
    export: Export,
    target: u64,
    started: bool,
    done: bool,
    error: Option<String>,
    pixels: Option<Pixels>,
    inverted: bool,
}
struct Pixels {
    pool: SlotPool,
    buffer: Buffer,
    width: u32,
    height: u32,
    stride: u32,
    format: wl_shm::Format,
}

fn connect(
    connection: Connection,
) -> Result<(Connection, GlobalList, EventQueue<Capture>, Capture)> {
    let (globals, queue) = registry_queue_init::<Capture>(&connection)?;
    let qh = queue.handle();
    let mapping = globals.bind::<Mapping,_,_>(&qh, 1..=1, ())
        .map_err(|_| "Update Hyprland: its window-mapping protocol is required for exact active-window capture.")?;
    let export = globals
        .bind::<Export, _, _>(&qh, 2..=2, ())
        .map_err(|_| "This Hyprland version does not support window export v2.")?;
    let state = Capture {
        registry: RegistryState::new(&globals),
        shm: Shm::bind(&globals, &qh)?,
        mapping,
        export,
        target: 0,
        started: false,
        done: false,
        error: None,
        pixels: None,
        inverted: false,
    };
    Ok((connection, globals, queue, state))
}
pub fn check() -> Result<bool> {
    let (_, globals, queue, _) = connect(Connection::connect_to_env()?)?;
    let _manager: Manager = globals.bind(&queue.handle(), 1..=3, ())?;
    Ok(globals.contents().with_list(|list| {
        [
            "zwlr_layer_shell_v1",
            "wp_viewporter",
            "wl_subcompositor",
            "wp_presentation",
        ]
        .iter()
        .all(|name| list.iter().any(|g| &g.interface == name))
    }))
}

pub fn capture(address: u64, directory: &Path) -> Result<()> {
    capture_on(Connection::connect_to_env()?, address, directory)
}

pub(super) fn capture_on(connection: Connection, address: u64, directory: &Path) -> Result<()> {
    let (connection, globals, mut queue, mut state) = connect(connection)?;
    state.target = address;
    let _manager: Manager = globals.bind(&queue.handle(), 1..=3, ())?;
    let deadline = Instant::now() + Duration::from_secs(15);
    while !state.done && state.error.is_none() {
        queue.dispatch_pending(&mut state)?;
        if state.done || state.error.is_some() {
            break;
        }
        connection.flush()?;
        if let Some(read) = queue.prepare_read() {
            let timeout = rustix::event::Timespec::try_from(deadline.checked_duration_since(Instant::now()).ok_or("Hyprland capture timed out. Approve its screen-sharing prompt, then try again.")?)?;
            let mut fds = [rustix::event::PollFd::new(
                &connection,
                rustix::event::PollFlags::IN,
            )];
            if rustix::event::poll(&mut fds, Some(&timeout))? == 0 {
                return Err("Hyprland capture timed out. Check screen-sharing permission.".into());
            }
            read.read()?;
        }
    }
    if let Some(error) = state.error {
        return Err(error.into());
    }
    let pixels = state.pixels.as_mut().ok_or("Hyprland returned no image.")?;
    let bytes = pixels.pool.raw_data_mut(&pixels.buffer.slot());
    let rgba = to_rgba(
        bytes,
        pixels.width,
        pixels.height,
        pixels.stride,
        pixels.format,
        state.inverted,
    )?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join("capture.png"))?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), pixels.width, pixels.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header()?.write_image_data(&rgba)?;
    Ok(())
}

fn image_size(width: u32, height: u32, stride: u32) -> Result<usize> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 || stride < width * 4 {
        return Err("Invalid capture dimensions.".into());
    }
    let size = u64::from(height) * u64::from(stride);
    if size > 128 * 1024 * 1024 {
        return Err("Capture is too large.".into());
    }
    Ok(size as usize)
}

fn to_rgba(
    bytes: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: wl_shm::Format,
    inverted: bool,
) -> Result<Vec<u8>> {
    let size = image_size(width, height, stride)?;
    if bytes.len() < size {
        return Err("Truncated capture buffer.".into());
    }
    let (red, blue, alpha) = match format {
        wl_shm::Format::Argb8888 => (2, 0, true),
        wl_shm::Format::Xrgb8888 => (2, 0, false),
        wl_shm::Format::Abgr8888 => (0, 2, true),
        wl_shm::Format::Xbgr8888 => (0, 2, false),
        _ => return Err("Hyprland returned an unsupported capture pixel format.".into()),
    };
    let mut rgba = vec![0; (width * height * 4) as usize];
    for y in 0..height {
        let row = if inverted { height - 1 - y } else { y };
        for x in 0..width {
            let source = (row * stride + x * 4) as usize;
            let dest = ((y * width + x) * 4) as usize;
            let a = if alpha { bytes[source + 3] } else { 255 };
            for (i, channel) in [red, 1, blue].into_iter().enumerate() {
                rgba[dest + i] = if a == 0 {
                    0
                } else {
                    (u32::from(bytes[source + channel]) * 255 / u32::from(a)).min(255) as u8
                };
            }
            rgba[dest + 3] = a;
        }
    }
    Ok(rgba)
}

impl Dispatch<Manager, ()> for Capture {
    fn event(
        state: &mut Self,
        _: &Manager,
        event: manager::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let manager::Event::Toplevel { toplevel } = event {
            state
                .mapping
                .get_window_for_toplevel_wlr(&toplevel, qh, toplevel.clone());
        }
    }
    wayland_client::event_created_child!(Capture, Manager, [0 => (Toplevel, ())]);
}
impl Dispatch<Toplevel, ()> for Capture {
    fn event(
        _: &mut Self,
        handle: &Toplevel,
        event: toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let toplevel::Event::Closed = event {
            handle.destroy();
        }
    }
}
impl Dispatch<Handle, Toplevel> for Capture {
    fn event(
        state: &mut Self,
        handle: &Handle,
        event: mapping::Event,
        toplevel: &Toplevel,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let mapping::Event::WindowAddress {
            address_hi,
            address,
        } = event
        {
            if (u64::from(address_hi) << 32 | u64::from(address)) == state.target && !state.started
            {
                state.started = true;
                state
                    .export
                    .capture_toplevel_with_wlr_toplevel_handle(0, toplevel, qh, ());
            }
        }
        handle.destroy();
    }
}
impl Dispatch<Frame, ()> for Capture {
    fn event(
        state: &mut Self,
        frame: &Frame,
        event: frame::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if state.error.is_some() || state.done {
            return;
        }
        let result = (|| -> Result<()> {
            match event {
                frame::Event::Buffer { format: WEnum::Value(format), width, height, stride } => {
                    let mut pool = SlotPool::new(image_size(width, height, stride)?, &state.shm)?;
                    let (buffer, _) = pool.create_buffer(width as i32, height as i32, stride as i32, format)?;
                    state.pixels = Some(Pixels { pool, buffer, width, height, stride, format });
                }
                frame::Event::BufferDone => {
                    let pixels = state.pixels.as_ref().ok_or("Hyprland did not offer a shared-memory image.")?;
                    frame.copy(pixels.buffer.wl_buffer(), 1);
                }
                frame::Event::Flags { flags: WEnum::Value(flags) } => state.inverted = flags.contains(frame::Flags::YInvert),
                frame::Event::Ready { .. } => { state.done = true; frame.destroy(); }
                frame::Event::Failed => return Err("Hyprland could not capture this window. Check screen-sharing permission and try again.".into()),
                _ => {}
            }
            Ok(())
        })();
        if let Err(error) = result {
            state.error = Some(error.to_string());
        }
    }
}
delegate_noop!(Capture: ignore Export);
delegate_noop!(Capture: ignore Mapping);
delegate_registry!(Capture);
delegate_shm!(Capture);
impl ProvidesRegistryState for Capture {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    smithay_client_toolkit::registry_handlers!();
}
impl ShmHandler for Capture {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_buffer_allocations() {
        assert!(image_size(100, 100, 399).is_err());
        assert!(image_size(16384, 16384, 65536).is_err());
        assert!(image_size(0, 10, 4).is_err());
    }
    #[test]
    fn converts_channels_padding_flip_and_alpha() {
        let bytes = [10, 20, 30, 255, 0, 0, 0, 0, 25, 50, 100, 128, 0, 0, 0, 0];
        assert_eq!(
            to_rgba(&bytes, 1, 2, 8, wl_shm::Format::Argb8888, true).unwrap(),
            [199, 99, 49, 128, 30, 20, 10, 255]
        );
        assert_eq!(
            to_rgba(&bytes, 1, 1, 8, wl_shm::Format::Xbgr8888, false).unwrap(),
            [10, 20, 30, 255]
        );
        assert!(to_rgba(&bytes[..2], 1, 1, 4, wl_shm::Format::Argb8888, false).is_err());
    }
}
