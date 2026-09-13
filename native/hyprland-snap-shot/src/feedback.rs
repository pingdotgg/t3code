use crate::{
    Result, emit,
    ipc::{self, Rect},
};
use serde::Deserialize;
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState},
    delegate_compositor, delegate_layer, delegate_output, delegate_registry, delegate_shm,
    output::{OutputHandler, OutputState},
    registry::{ProvidesRegistryState, RegistryState},
    shell::{
        WaylandSurface,
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
    },
    shm::{
        Shm, ShmHandler,
        slot::{Buffer, SlotPool},
    },
};
use std::{
    fs::File,
    io::{BufReader, Read},
    os::unix::net::UnixStream,
    path::Path,
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    globals::registry_queue_init,
    protocol::{
        wl_output::{self, WlOutput},
        wl_shm,
        wl_subcompositor::WlSubcompositor,
        wl_subsurface::WlSubsurface,
        wl_surface::WlSurface,
    },
};
use wayland_protocols::wp::presentation_time::client::{
    wp_presentation::WpPresentation,
    wp_presentation_feedback::{self, WpPresentationFeedback},
};
use wayland_protocols::wp::viewporter::client::{
    wp_viewport::WpViewport, wp_viewporter::WpViewporter,
};

enum Receipt {
    Initial(usize),
    Landed,
}

#[derive(Clone, Copy, PartialEq)]
enum Texture {
    None,
    Flash,
    Image,
}

#[derive(Deserialize)]
pub struct Options {
    bounds: Rect,
    pid: u32,
    flash: bool,
    animate: bool,
}
#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "lowercase")]
enum Command {
    Close,
    Animate { title: String, frame: Rect },
}
struct Overlay {
    layer: LayerSurface,
    image: WlSurface,
    subsurface: WlSubsurface,
    viewport: WpViewport,
    _background: WpViewport,
    bounds: Rect,
    configured: bool,
    presented: bool,
    frame_pending: bool,
    receipt_pending: bool,
    texture: Texture,
    background_attached: bool,
}
struct Feedback {
    registry: RegistryState,
    output: OutputState,
    shm: Shm,
    presentation: WpPresentation,
    _pool: SlotPool,
    overlays: Vec<Overlay>,
    background: Buffer,
    image: Buffer,
    flash: Buffer,
    image_size: (u32, u32),
    options: Options,
    start: Instant,
    flight: Option<(Rect, Instant)>,
    destination: Option<ipc::Window>,
    ready: bool,
    landed: bool,
    landing_receipts: usize,
    done: bool,
}

/// Clip in logical output space, then map the visible portion to source pixels.
fn clip(rect: Rect, output: Rect, image: (u32, u32)) -> Option<(Rect, Rect)> {
    if !rect.valid() || !output.valid() || !rect.intersects(output) {
        return None;
    }
    let x = rect.x.max(output.x);
    let y = rect.y.max(output.y);
    let right = (rect.x + rect.width).min(output.x + output.width);
    let bottom = (rect.y + rect.height).min(output.y + output.height);
    if right - x < 1. || bottom - y < 1. {
        return None;
    }
    // Wayland source rectangles use 24.8 fixed point. Quantize edges together so rounding
    // can never put the right/bottom edge outside the image at fractional output scales.
    let left_px = ((x - rect.x) / rect.width * f64::from(image.0) * 256.).floor() / 256.;
    let top_px = ((y - rect.y) / rect.height * f64::from(image.1) * 256.).floor() / 256.;
    let right_px = ((right - rect.x) / rect.width * f64::from(image.0) * 256.).floor() / 256.;
    let bottom_px = ((bottom - rect.y) / rect.height * f64::from(image.1) * 256.).floor() / 256.;
    if right_px <= left_px || bottom_px <= top_px {
        return None;
    }
    Some((
        Rect {
            x: x - output.x,
            y: y - output.y,
            width: right - x,
            height: bottom - y,
        },
        Rect {
            x: left_px,
            y: top_px,
            width: right_px - left_px,
            height: bottom_px - top_px,
        },
    ))
}
fn interpolate(from: Rect, to: Rect, progress: f64) -> Rect {
    let t = 1.0 - (1.0 - progress.clamp(0., 1.)).powi(3);
    Rect {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        width: from.width + (to.width - from.width) * t,
        height: from.height + (to.height - from.height) * t,
    }
}
fn target(bounds: Rect, frame: Rect) -> Result<Rect> {
    if !bounds.valid()
        || !frame.valid()
        || frame.x < 0.
        || frame.y < 0.
        || frame.x + frame.width > 1.01
        || frame.y + frame.height > 1.01
    {
        return Err("Invalid capture animation destination.".into());
    }
    Ok(Rect {
        x: bounds.x + frame.x * bounds.width,
        y: bounds.y + frame.y * bounds.height,
        width: frame.width * bounds.width,
        height: frame.height * bounds.height,
    })
}

pub fn run(directory: &Path, mut options: Options) -> Result<()> {
    if !options.bounds.valid() {
        return Err("Invalid capture bounds.".into());
    }
    ipc::ensure_unlocked()?;
    options.animate &= ipc::animations_enabled();
    let mut events = UnixStream::connect(ipc::session_directory()?.join(".socket2.sock"))?;
    events.set_nonblocking(true)?;
    let mut decoder = png::Decoder::new(BufReader::new(File::open(directory.join("capture.png"))?));
    decoder.set_limits(png::Limits {
        bytes: 128 * 1024 * 1024,
    });
    let mut reader = decoder.read_info()?;
    let mut bytes = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("Invalid capture image size.")?
    ];
    let info = reader.next_frame(&mut bytes)?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("Expected RGBA capture image.".into());
    }
    let (connection, mut queue, mut state, compositor, layer_shell, subcompositor, viewporter) = {
        let connection = Connection::connect_to_env()?;
        let (globals, queue) = registry_queue_init::<Feedback>(&connection)?;
        let qh = queue.handle();
        let compositor = CompositorState::bind(&globals, &qh)?;
        let layer_shell = LayerShell::bind(&globals, &qh)?;
        let subcompositor: WlSubcompositor = globals.bind(&qh, 1..=1, ())?;
        let viewporter: WpViewporter = globals.bind(&qh, 1..=1, ())?;
        let presentation: WpPresentation = globals.bind(&qh, 1..=1, ())?;
        let shm = Shm::bind(&globals, &qh)?;
        let mut pool = SlotPool::new(bytes.len() * 2 + 4, &shm)?;
        let (background, canvas) = pool.create_buffer(1, 1, 4, wl_shm::Format::Argb8888)?;
        canvas.fill(0);
        let (image, canvas) = pool.create_buffer(
            info.width as i32,
            info.height as i32,
            info.width as i32 * 4,
            wl_shm::Format::Argb8888,
        )?;
        // Wayland's ARGB8888 is native-endian and premultiplied; PNG is straight RGBA.
        for (src, dst) in bytes.chunks_exact(4).zip(canvas.chunks_exact_mut(4)) {
            let a = u32::from(src[3]);
            dst.copy_from_slice(&[
                (u32::from(src[2]) * a / 255) as u8,
                (u32::from(src[1]) * a / 255) as u8,
                (u32::from(src[0]) * a / 255) as u8,
                src[3],
            ]);
        }
        let (flash, canvas) = pool.create_buffer(
            info.width as i32,
            info.height as i32,
            info.width as i32 * 4,
            wl_shm::Format::Argb8888,
        )?;
        for (src, dst) in bytes.chunks_exact(4).zip(canvas.chunks_exact_mut(4)) {
            let a = u32::from(src[3]);
            for (i, channel) in [2, 1, 0].into_iter().enumerate() {
                dst[i] = ((u32::from(src[channel]) * 3 + 255) / 4 * a / 255) as u8;
            }
            dst[3] = src[3];
        }
        let state = Feedback {
            registry: RegistryState::new(&globals),
            output: OutputState::new(&globals, &qh),
            shm,
            presentation,
            _pool: pool,
            overlays: Vec::new(),
            background,
            image,
            flash,
            image_size: (info.width, info.height),
            options,
            start: Instant::now(),
            flight: None,
            destination: None,
            ready: false,
            landed: false,
            landing_receipts: 0,
            done: false,
        };
        (
            connection,
            queue,
            state,
            compositor,
            layer_shell,
            subcompositor,
            viewporter,
        )
    };
    let qh = queue.handle();
    queue.roundtrip(&mut state)?;
    queue.roundtrip(&mut state)?;
    let region = compositor.wl_compositor().create_region(&qh, ());
    for output in state.output.outputs() {
        let data = state
            .output
            .info(&output)
            .ok_or("Missing output information.")?;
        let (x, y) = data.logical_position.ok_or("Missing output position.")?;
        let (width, height) = data.logical_size.ok_or("Missing output size.")?;
        if width <= 0 || height <= 0 {
            continue;
        }
        let surface = compositor.create_surface(&qh);
        surface.set_input_region(Some(&region));
        let background = viewporter.get_viewport(&surface, &qh, ());
        background.set_destination(width, height);
        let image = compositor.create_surface(&qh);
        image.set_input_region(Some(&region));
        let viewport = viewporter.get_viewport(&image, &qh, ());
        let subsurface = subcompositor.get_subsurface(&image, &surface, &qh, ());
        let layer = layer_shell.create_layer_surface(
            &qh,
            surface,
            Layer::Overlay,
            Some("t3-snap-shot"),
            Some(&output),
        );
        layer.set_anchor(Anchor::TOP | Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer.set_exclusive_zone(-1);
        layer.set_size(width as u32, height as u32);
        layer.commit();
        state.overlays.push(Overlay {
            layer,
            image,
            subsurface,
            viewport,
            _background: background,
            bounds: Rect {
                x: x.into(),
                y: y.into(),
                width: width.into(),
                height: height.into(),
            },
            configured: false,
            presented: !state.options.bounds.intersects(Rect {
                x: x.into(),
                y: y.into(),
                width: width.into(),
                height: height.into(),
            }),
            frame_pending: false,
            receipt_pending: false,
            texture: Texture::None,
            background_attached: false,
        });
    }
    region.destroy();
    if state.overlays.is_empty() {
        return Err("No output is available for capture effects.".into());
    }
    let stdin = std::io::stdin();
    if state.overlays.iter().all(|o| o.presented) {
        return Err("The captured window is outside the visible outputs.".into());
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut commands = Vec::new();
    while !state.done {
        queue.dispatch_pending(&mut state)?;
        if state.done {
            break;
        }
        connection.flush()?;
        let Some(read) = queue.prepare_read() else {
            continue;
        };
        let timeout = rustix::event::Timespec::try_from(
            deadline
                .checked_duration_since(Instant::now())
                .ok_or("Capture feedback expired.")?,
        )?;
        let mut fds = [
            rustix::event::PollFd::new(&connection, rustix::event::PollFlags::IN),
            rustix::event::PollFd::new(&stdin, rustix::event::PollFlags::IN),
            rustix::event::PollFd::new(&events, rustix::event::PollFlags::IN),
        ];
        if rustix::event::poll(&mut fds, Some(&timeout))? == 0 {
            break;
        }
        if fds[0].revents().intersects(
            rustix::event::PollFlags::IN
                | rustix::event::PollFlags::HUP
                | rustix::event::PollFlags::ERR,
        ) {
            read.read()?;
        } else {
            drop(read);
        }
        let input_ready = fds[1]
            .revents()
            .intersects(rustix::event::PollFlags::IN | rustix::event::PollFlags::HUP);
        let events_ready = !fds[2].revents().is_empty();
        drop(fds);
        if events_ready {
            let mut bytes = [0; 8192];
            match events.read(&mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    ipc::ensure_unlocked()?;
                    if let Some(destination) = &state.destination {
                        let current = ipc::destination(
                            ipc::windows()?,
                            state.options.pid,
                            &destination.title,
                        )?;
                        if current.as_ref() != Some(destination) {
                            break;
                        }
                        if ipc::active_window()?.address != destination.address {
                            break;
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(error.into()),
            }
        }
        if input_ready {
            let mut buf = [0; 2048];
            let count = stdin.lock().read(&mut buf)?;
            if count == 0 {
                break;
            }
            commands.extend_from_slice(&buf[..count]);
            if commands.len() > 4096 {
                return Err("Oversized feedback command.".into());
            }
            while let Some(end) = commands.iter().position(|byte| *byte == b'\n') {
                let line = commands.drain(..=end).collect::<Vec<_>>();
                match serde_json::from_slice::<Command>(&line)? {
                    Command::Close => state.done = true,
                    Command::Animate { title, frame }
                        if state.options.animate && state.flight.is_none() =>
                    {
                        ipc::ensure_unlocked()?;
                        let window = ipc::destination(ipc::windows()?, state.options.pid, &title)?
                            .ok_or("Capture destination is not visible.")?;
                        let dest = target(window.bounds(), frame)?;
                        state.flight = Some((dest, Instant::now()));
                        state.destination = Some(window);
                        state.draw(&qh)?;
                    }
                    _ => {}
                }
            }
        }
    }
    // Dropping the connection destroys every overlay, including cancellation/error paths.
    emit(serde_json::json!({"event":"done"}))
}

impl Feedback {
    fn draw(&mut self, qh: &QueueHandle<Self>) -> Result<()> {
        let progress = self
            .flight
            .map(|(_, start)| start.elapsed().as_secs_f64() / 0.48);
        let rect = self
            .flight
            .map(|(to, _)| interpolate(self.options.bounds, to, progress.unwrap_or(0.)))
            .unwrap_or(self.options.bounds);
        let flashing = self.options.flash
            && self.start.elapsed() < Duration::from_millis(130)
            && self.flight.is_none();
        let visible = self.options.animate || flashing;
        let driver = self
            .overlays
            .iter()
            .position(|o| o.bounds.intersects(rect))
            .unwrap_or(0);
        let landing = progress.is_some_and(|p| p >= 1.) && !self.landed;
        for (index, overlay) in self.overlays.iter_mut().enumerate() {
            if !overlay.configured {
                continue;
            }
            let surface = overlay.layer.wl_surface();
            if let Some((dest, src)) =
                clip(rect, overlay.bounds, self.image_size).filter(|_| visible)
            {
                overlay
                    .viewport
                    .set_source(src.x, src.y, src.width, src.height);
                overlay.viewport.set_destination(
                    dest.width.round().max(1.) as i32,
                    dest.height.round().max(1.) as i32,
                );
                overlay
                    .subsurface
                    .set_position(dest.x.round() as i32, dest.y.round() as i32);
                // Immutable textures are uploaded only when they change. Flight frames update
                // the viewport and subsurface position, not megabytes of shared-memory pixels.
                let texture = if flashing {
                    Texture::Flash
                } else {
                    Texture::Image
                };
                if overlay.texture != texture {
                    overlay.image.attach(
                        Some((if flashing { &self.flash } else { &self.image }).wl_buffer()),
                        0,
                        0,
                    );
                    overlay.image.damage_buffer(0, 0, i32::MAX, i32::MAX);
                    overlay.texture = texture;
                }
            } else {
                if overlay.texture != Texture::None {
                    overlay.image.attach(None, 0, 0);
                    overlay.texture = Texture::None;
                }
            }
            overlay.image.commit();
            if !overlay.background_attached {
                surface.attach(Some(self.background.wl_buffer()), 0, 0);
                overlay.background_attached = true;
            }
            if !overlay.presented && !overlay.receipt_pending {
                self.presentation
                    .feedback(surface, qh, Receipt::Initial(index));
                overlay.receipt_pending = true;
            }
            if landing && overlay.bounds.intersects(rect) {
                self.presentation.feedback(surface, qh, Receipt::Landed);
                self.landing_receipts += 1;
            }
            if !overlay.frame_pending
                && self.ready
                && index == driver
                && (flashing || progress.is_some_and(|p| p < 1.))
            {
                surface.frame(qh, surface.clone());
                overlay.frame_pending = true;
            }
            surface.commit();
        }
        if landing {
            // Presentation feedback, not a frame callback, acknowledges the final painted image.
            self.landed = true;
            if self.landing_receipts == 0 {
                self.done = true;
            }
        }
        Ok(())
    }
}
impl CompositorHandler for Feedback {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: i32,
    ) {
    }
    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: wl_output::Transform,
    ) {
    }
    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: &WlOutput,
    ) {
    }
    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: &WlOutput,
    ) {
    }
    fn frame(&mut self, _: &Connection, qh: &QueueHandle<Self>, surface: &WlSurface, _: u32) {
        if self.landed {
            return;
        }
        if let Some(overlay) = self
            .overlays
            .iter_mut()
            .find(|o| o.layer.wl_surface() == surface)
        {
            overlay.frame_pending = false;
        }
        if self.ready && self.draw(qh).is_err() {
            self.done = true;
        }
    }
}
impl LayerShellHandler for Feedback {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &LayerSurface) {
        self.done = true;
    }
    fn configure(
        &mut self,
        _: &Connection,
        qh: &QueueHandle<Self>,
        layer: &LayerSurface,
        config: LayerSurfaceConfigure,
        _: u32,
    ) {
        if let Some(overlay) = self.overlays.iter_mut().find(|o| o.layer == *layer) {
            if overlay.configured
                || (config.new_size.0 != 0
                    && config.new_size
                        != (overlay.bounds.width as u32, overlay.bounds.height as u32))
            {
                self.done = true;
                return;
            }
            overlay.configured = true;
        }
        if self.overlays.iter().all(|o| o.configured) && self.draw(qh).is_err() {
            self.done = true;
        }
    }
}
impl OutputHandler for Feedback {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.output
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: WlOutput) {
        if !self.overlays.is_empty() {
            self.done = true;
        }
    }
    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: WlOutput) {
        if self.ready {
            self.done = true;
        }
    }
    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, _: WlOutput) {
        self.done = true;
    }
}
impl ShmHandler for Feedback {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}
impl ProvidesRegistryState for Feedback {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    smithay_client_toolkit::registry_handlers!(OutputState);
}
delegate_registry!(Feedback);
delegate_output!(Feedback);
delegate_shm!(Feedback);
delegate_layer!(Feedback);
delegate_compositor!(Feedback);
delegate_noop!(Feedback: ignore WlSubcompositor);
delegate_noop!(Feedback: ignore WlSubsurface);
delegate_noop!(Feedback: ignore WpViewporter);
delegate_noop!(Feedback: ignore WpViewport);
delegate_noop!(Feedback: ignore WpPresentation);
impl Dispatch<WpPresentationFeedback, Receipt> for Feedback {
    fn event(
        state: &mut Self,
        _: &WpPresentationFeedback,
        event: wp_presentation_feedback::Event,
        receipt: &Receipt,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wp_presentation_feedback::Event::Presented { .. } => {
                match receipt {
                    Receipt::Initial(index) => {
                        state.overlays[*index].presented = true;
                        if !state.ready && state.overlays.iter().all(|o| o.presented) {
                            state.ready = true;
                            if emit(serde_json::json!({"event":"ready","animate":state.options.animate})).is_err() || state.draw(qh).is_err() {state.done=true;}
                        }
                    }
                    Receipt::Landed => {
                        state.landing_receipts = state.landing_receipts.saturating_sub(1);
                        if state.landing_receipts == 0
                            && emit(serde_json::json!({"event":"landed"})).is_err()
                        {
                            state.done = true;
                        }
                    }
                }
            }
            wp_presentation_feedback::Event::Discarded => state.done = true,
            _ => {}
        }
    }
}
delegate_noop!(Feedback: ignore wayland_client::protocol::wl_region::WlRegion);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clips_across_negative_origin_and_scaled_outputs() {
        let rect = Rect {
            x: -100.,
            y: 0.,
            width: 200.,
            height: 100.,
        };
        let (dest, src) = clip(
            rect,
            Rect {
                x: 0.,
                y: 0.,
                width: 1920.,
                height: 1080.,
            },
            (400, 200),
        )
        .unwrap();
        assert_eq!(
            dest,
            Rect {
                x: 0.,
                y: 0.,
                width: 100.,
                height: 100.
            }
        );
        assert_eq!(
            src,
            Rect {
                x: 200.,
                y: 0.,
                width: 200.,
                height: 200.
            }
        );
        assert!(
            clip(
                rect,
                Rect {
                    x: 200.,
                    y: 0.,
                    width: 100.,
                    height: 100.
                },
                (400, 200)
            )
            .is_none()
        );
    }
    #[test]
    fn flight_ends_at_exact_composer_bounds() {
        let a = Rect {
            x: -300.,
            y: 0.,
            width: 600.,
            height: 500.,
        };
        let b = Rect {
            x: 100.,
            y: 400.,
            width: 100.,
            height: 80.,
        };
        assert_eq!(interpolate(a, b, 0.), a);
        assert_eq!(interpolate(a, b, 1.), b);
        assert_eq!(
            target(
                a,
                Rect {
                    x: 0.5,
                    y: 0.4,
                    width: 0.2,
                    height: 0.1
                }
            )
            .unwrap(),
            Rect {
                x: 0.,
                y: 200.,
                width: 120.,
                height: 50.
            }
        );
        assert!(
            target(
                a,
                Rect {
                    x: 590.,
                    y: 0.,
                    width: 30.,
                    height: 30.
                }
            )
            .is_err()
        );
    }
}
