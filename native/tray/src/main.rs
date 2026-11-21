use std::{
    error::Error,
    path::{Path, PathBuf},
    process::Command,
};

use tray_icon::{
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

enum Event {
    Menu(MenuEvent),
    Tray(TrayIconEvent),
}

struct Tray {
    _icon: TrayIcon,
    open: MenuItem,
    quit: MenuItem,
    status: MenuItem,
    launcher: PathBuf,
}

impl Tray {
    fn new(launcher: PathBuf) -> Result<Self> {
        let open = MenuItem::new("Open T3 Code", true, None);
        let quit = MenuItem::new("Quit Tray", true, None);
        let status = MenuItem::new("T3 Code", false, None);
        let menu = Menu::new();
        menu.append_items(&[&status, &open, &quit])?;
        let icon = TrayIconBuilder::new()
            .with_tooltip("T3 Code")
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .with_icon(load_icon()?)
            .build()?;
        Ok(Self {
            _icon: icon,
            open,
            quit,
            status,
            launcher,
        })
    }

    fn handle(&mut self, event: Event) -> bool {
        match event {
            Event::Menu(event) if event.id == self.quit.id() => return false,
            Event::Menu(event) if event.id == self.open.id() => self.open(),
            Event::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }) => self.open(),
            _ => {}
        }
        true
    }

    fn open(&mut self) {
        if let Err(error) = self.launch() {
            self.status.set_text("Could not open T3 Code");
            eprintln!("Could not open T3 Code: {error}");
        } else {
            self.status.set_text("T3 Code");
        }
    }

    fn launch(&mut self) -> std::io::Result<()> {
        let mut child = launch_command(&self.launcher).spawn()?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
}

fn launch_command(launcher: &Path) -> Command {
    #[cfg(target_os = "macos")]
    if launcher
        .extension()
        .is_some_and(|extension| extension == "app")
    {
        let mut command = Command::new("/usr/bin/open");
        command.arg(launcher);
        return command;
    }
    Command::new(launcher)
}

fn load_icon() -> Result<Icon> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!(
        "../../../assets/prod/t3-black-web-favicon-32x32.png"
    )));
    decoder.set_transformations(
        png::Transformations::normalize_to_color8() | png::Transformations::ALPHA,
    );
    let mut reader = decoder.read_info()?;
    let mut pixels = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("Invalid tray icon size")?
    ];
    let frame = reader.next_frame(&mut pixels)?;
    pixels.truncate(frame.buffer_size());
    Ok(Icon::from_rgba(pixels, frame.width, frame.height)?)
}

#[cfg(target_os = "linux")]
fn run(launcher: PathBuf) -> Result<()> {
    // KSNI runs its own D-Bus event loop and does not require a GTK window.
    let (events, receiver) = std::sync::mpsc::channel();
    let menu_events = events.clone();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_events.send(Event::Menu(event));
    }));
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = events.send(Event::Tray(event));
    }));
    let mut tray = Tray::new(launcher)?;
    for event in receiver {
        if !tray.handle(event) {
            break;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(launcher: PathBuf) -> Result<()> {
    use tao::{
        event::{Event as TaoEvent, StartCause},
        event_loop::{ControlFlow, EventLoopBuilder},
    };

    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<Event>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(Event::Menu(event));
    }));
    let proxy = event_loop.create_proxy();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = proxy.send_event(Event::Tray(event));
    }));

    let mut tray = None;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            TaoEvent::NewEvents(StartCause::Init) => match Tray::new(launcher.clone()) {
                Ok(app) => {
                    tray = Some(app);
                    // The status item is drawn on the next run-loop pass, which `Wait` would defer until input.
                    #[cfg(target_os = "macos")]
                    if let Some(run_loop) = objc2_core_foundation::CFRunLoop::main() {
                        run_loop.wake_up();
                    }
                }
                Err(error) => {
                    eprintln!("Could not create T3 Code tray: {error}");
                    *flow = ControlFlow::ExitWithCode(1);
                }
            },
            TaoEvent::UserEvent(event) => {
                if let Some(app) = &mut tray {
                    if !app.handle(event) {
                        tray.take();
                        *flow = ControlFlow::Exit;
                    }
                }
            }
            _ => {}
        }
    })
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let launcher = args.next().map(PathBuf::from);
    if let Some(launcher) = launcher.filter(|path| path.is_absolute() && path.exists()) {
        if args.next().is_none() {
            return run(launcher);
        }
    }
    Err(
        "Usage: t3-tray <absolute path to the installed T3 Code executable or macOS app bundle>"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_png_produces_a_native_tray_icon() {
        super::load_icon().unwrap();
    }
}
