//! One-shot KWin adapter. The installed executable, not Electron or the AppImage
//! mount, is the identity authorized by KDE's desktop-entry permission check.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::{Read, Write},
    os::{fd::AsFd, unix::net::UnixStream},
    path::Path,
    sync::mpsc,
    time::Duration,
};
use zbus::{
    blocking::{Connection, Proxy, connection::Builder},
    zvariant::{Fd, OwnedValue, Value},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const SCREENSHOT: &str = "org.kde.KWin.ScreenShot2";
const MAX_BYTES: usize = 128 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(5);

mod feedback;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Window {
    id: String,
    title: String,
    app_name: String,
    app_identifier: String,
    process_id: u32,
    bounds: Bounds,
    client_bounds: Bounds,
}

impl Window {
    fn matches_after_capture(&self, current: &Self) -> bool {
        self.id == current.id
            && self.process_id == current.process_id
            && self.app_identifier == current.app_identifier
            && self.app_name == current.app_name
            && self.bounds == current.bounds
            && self.client_bounds == current.client_bounds
            && capture_title(&self.title) == capture_title(&current.title)
    }
}

/// Match the same leading CLI spinner accepted by the Wayland AT-SPI window matcher.
fn capture_title(title: &str) -> &str {
    let title = title.trim();
    let mut chars = title.chars();
    if matches!(
        chars.next(),
        Some('⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏')
    ) && chars.clone().next().is_some_and(char::is_whitespace)
    {
        let label = chars.as_str().trim_start();
        if !label.is_empty() {
            return label;
        }
    }
    title
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct ScriptReply {
    owner: String,
    result: mpsc::SyncSender<String>,
}
#[zbus::interface(name = "com.t3tools.KdeCapture")]
impl ScriptReply {
    fn reply(
        &self,
        value: &str,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        if header.sender().map(|name| name.as_str()) != Some(self.owner.as_str()) {
            return Err(zbus::fdo::Error::AccessDenied("Not KWin".into()));
        }
        if value.len() > 64 * 1024 {
            return Err(zbus::fdo::Error::InvalidArgs(
                "Oversized window metadata".into(),
            ));
        }
        let _ = self.result.try_send(value.to_owned());
        Ok(())
    }
}

/// Scripts exist only for this operation. Unload even when evaluation/callback fails.
fn script(connection: &Connection, directory: &Path, body: &str) -> Result<String> {
    let dbus = zbus::blocking::fdo::DBusProxy::new(connection)?;
    let owner = dbus.get_name_owner("org.kde.KWin".try_into()?)?.to_string();
    let (send, receive) = mpsc::sync_channel(1);
    connection.object_server().at(
        "/com/t3tools/KdeCapture",
        ScriptReply {
            owner,
            result: send,
        },
    )?;
    let path = directory.join("window.js");
    let name = format!("t3-capture-{}", std::process::id());
    let destination = serde_json::to_string(
        connection
            .unique_name()
            .ok_or("Missing bus identity")?
            .as_str(),
    )?;
    let source = format!(
        "function reply(value) {{ callDBus({destination}, '/com/t3tools/KdeCapture', 'com.t3tools.KdeCapture', 'Reply', JSON.stringify(value)); }}\ntry {{ {body} }} catch (error) {{ reply({{error: String(error)}}); }}"
    );
    std::fs::write(&path, source)?;
    let scripting = Proxy::new(
        connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )?;
    let result = (|| {
        let id: i32 = scripting.call(
            "loadScript",
            &(path.to_str().ok_or("Invalid script path")?, &name),
        )?;
        if id < 0 {
            return Err("KWin could not load the capture helper script".into());
        }
        let result = (|| {
            let object = format!("/Scripting/Script{id}");
            let loaded = Proxy::new(
                connection,
                "org.kde.KWin",
                object.as_str(),
                "org.kde.kwin.Script",
            )?;
            let _: () = loaded.call("run", &())?;
            Ok(receive.recv_timeout(DEADLINE)?)
        })();
        let _: std::result::Result<bool, _> = scripting.call("unloadScript", &(&name,));
        result
    })();
    connection
        .object_server()
        .remove::<ScriptReply, _>("/com/t3tools/KdeCapture")?;
    let _ = std::fs::remove_file(path);
    result
}

fn window(connection: &Connection, directory: &Path, id: Option<&str>) -> Result<Option<Window>> {
    let selector = match id {
        Some(id) => format!(
            "workspace.windowList().find(w => String(w.internalId) === {})",
            serde_json::to_string(id)?
        ),
        None => "workspace.activeWindow".into(),
    };
    let value = script(
        connection,
        directory,
        &format!(
            "function bounds(rect) {{ return {{ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }}; }}
             const w = {selector}; reply(!w ? null : {{ id: String(w.internalId), title: w.caption, appName: w.resourceClass || w.desktopFileName || 'Application', appIdentifier: w.desktopFileName || w.resourceClass || '', processId: w.pid, bounds: bounds(w.frameGeometry), clientBounds: bounds(w.clientGeometry) }});"
        ),
    )?;
    Ok(serde_json::from_str(&value)?)
}

fn screenshot_proxy(connection: &Connection) -> zbus::Result<Proxy<'_>> {
    Proxy::new(
        connection,
        SCREENSHOT,
        "/org/kde/KWin/ScreenShot2",
        SCREENSHOT,
    )
}

/// InvalidWindow follows the authorization check and cannot produce a screenshot.
fn check(connection: &Connection) -> Result<()> {
    let proxy = screenshot_proxy(connection)?;
    if proxy.get_property::<u32>("Version")? < 2 {
        return Err("KDE's screenshot API is too old".into());
    }
    let sink = OpenOptions::new().write(true).open("/dev/null")?;
    let reply: zbus::Result<HashMap<String, OwnedValue>> = proxy.call(
        "CaptureWindow",
        &(
            "t3-permission-check-not-a-window",
            HashMap::<&str, Value<'_>>::new(),
            Fd::from(sink.as_fd()),
        ),
    );
    match reply {
        Err(zbus::Error::MethodError(name, _, _))
            if name.as_str() == "org.kde.KWin.ScreenShot2.Error.InvalidWindow" =>
        {
            Ok(())
        }
        Err(error) => Err(error.into()),
        Ok(_) => Err("KWin returned an unexpected permission-check result".into()),
    }
}

fn uint(metadata: &HashMap<String, OwnedValue>, key: &str) -> Result<usize> {
    Ok(u32::try_from(
        metadata
            .get(key)
            .ok_or_else(|| format!("Missing screenshot {key}"))?,
    )? as usize)
}

/// KWin supplies Qt ARGB32/RGB32 or RGBA8888 pixels. Refuse unknown formats.
fn rgba(raw: &[u8], width: usize, height: usize, stride: usize, format: usize) -> Result<Vec<u8>> {
    let row = width
        .checked_mul(4)
        .ok_or("Invalid screenshot dimensions")?;
    let bytes = stride
        .checked_mul(height)
        .ok_or("Invalid screenshot dimensions")?;
    if width == 0 || height == 0 || stride < row || bytes > MAX_BYTES || raw.len() != bytes {
        return Err("Invalid or oversized screenshot dimensions".into());
    }
    if ![4, 5, 6, 17, 18].contains(&format) {
        return Err("Unsupported KDE screenshot pixel format".into());
    }
    let mut output = Vec::with_capacity(row * height);
    for y in 0..height {
        for pixel in raw[y * stride..y * stride + row].chunks_exact(4) {
            let (r, g, b, a) = if format >= 17 {
                (pixel[0], pixel[1], pixel[2], pixel[3])
            } else {
                let argb = u32::from_ne_bytes(pixel.try_into()?);
                (
                    (argb >> 16) as u8,
                    (argb >> 8) as u8,
                    argb as u8,
                    if format == 4 { 255 } else { (argb >> 24) as u8 },
                )
            };
            let straight = |v: u8| {
                if a == 0 {
                    0
                } else {
                    ((v as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8
                }
            };
            if format == 6 || format == 18 {
                output.extend_from_slice(&[straight(r), straight(g), straight(b), a]);
            } else {
                output.extend_from_slice(&[r, g, b, a]);
            }
        }
    }
    Ok(output)
}

fn capture(connection: &Connection, directory: &Path) -> Result<Option<Window>> {
    // Lack of scripting only loses identity/text; never guess which app was captured.
    let before = window(connection, directory, None).ok().flatten();
    let proxy = screenshot_proxy(connection)?;
    let (mut reader, writer) = UnixStream::pair()?;
    reader.set_read_timeout(Some(DEADLINE))?;
    let options = HashMap::from([
        ("include-decoration", Value::from(true)),
        ("include-shadow", Value::from(false)),
        ("include-cursor", Value::from(false)),
        ("native-resolution", Value::from(true)),
    ]);
    let metadata: HashMap<String, OwnedValue> = if let Some(window) = &before {
        proxy.call(
            "CaptureWindow",
            &(&window.id, options, Fd::from(writer.as_fd())),
        )?
    } else {
        proxy.call("CaptureActiveWindow", &(options, Fd::from(writer.as_fd())))?
    };
    drop(writer);
    if <&str>::try_from(metadata.get("type").ok_or("Missing screenshot type")?)? != "raw" {
        return Err("Unsupported KDE screenshot type".into());
    }
    let width = uint(&metadata, "width")?;
    let height = uint(&metadata, "height")?;
    let stride = metadata
        .get("stride")
        .map(|_| uint(&metadata, "stride"))
        .transpose()?
        .unwrap_or(width.checked_mul(4).ok_or("Invalid width")?);
    let bytes = stride
        .checked_mul(height)
        .filter(|bytes| *bytes <= MAX_BYTES)
        .ok_or("Screenshot too large")?;
    let mut raw = vec![0; bytes];
    reader.read_exact(&mut raw)?;
    let pixels = rgba(&raw, width, height, stride, uint(&metadata, "format")?)?;
    let image = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("capture.png"))?;
    let mut encoder = png::Encoder::new(image, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut image = encoder.write_header()?;
    image.write_image_data(&pixels)?;
    image.finish()?;
    let identity = before.filter(|before| {
        window(connection, directory, Some(&before.id))
            .ok()
            .flatten()
            .is_some_and(|current| before.matches_after_capture(&current))
    });
    Ok(identity)
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let connection = Builder::session()?.method_timeout(DEADLINE).build()?;
    match args.get(1).map(String::as_str) {
        Some("check") => {
            check(&connection)?;
            println!(
                "{}",
                serde_json::json!({"ready": true, "feedbackAvailable": feedback::supported(&connection)})
            );
        }
        Some("capture") if args.len() == 3 => {
            let window = capture(&connection, Path::new(&args[2]))?;
            println!("{}", serde_json::json!({"window": window}));
        }
        Some("feedback") if args.len() == 4 => {
            feedback::run(&connection, Path::new(&args[2]), &args[3])?;
        }
        Some("activate") if args.len() == 5 => {
            let pid: u32 = args[3].parse()?;
            let title = serde_json::to_string(&args[4])?;
            let value = script(
                &connection,
                Path::new(&args[2]),
                &format!(
                    "const targetPid = {pid}; const targetTitle = {title};\n{}",
                    include_str!("activate.js")
                ),
            )?;
            if serde_json::from_str::<serde_json::Value>(&value)?["activated"] != true {
                return Err("KDE could not identify the T3 Code window to activate".into());
            }
            println!("{{\"activated\":true}}");
        }
        _ => {
            return Err(
                "Expected check, capture <directory>, feedback <directory> <options>, or activate <directory> <pid> <title>"
                    .into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod transport_tests;

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(std::io::stderr(), "{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> Window {
        Window {
            id: "{window-1}".into(),
            title: "⠋ Document".into(),
            app_name: "Editor".into(),
            app_identifier: "editor".into(),
            process_id: 123,
            bounds: Bounds {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            },
            client_bounds: Bounds {
                x: 0,
                y: 29,
                width: 800,
                height: 571,
            },
        }
    }

    #[test]
    fn accepts_only_a_leading_cli_spinner_with_a_nonempty_label() {
        let before = window();
        for title in [
            "⠋ Document",
            "⠙ Document",
            "⠹ Document",
            "⠸ Document",
            "⠼ Document",
            "⠴ Document",
            "⠦ Document",
            "⠧ Document",
            "⠇ Document",
            "⠏ Document",
            "Document",
        ] {
            let mut after = before.clone();
            after.title = title.into();
            assert!(before.matches_after_capture(&after), "{title}");
            assert!(after.matches_after_capture(&before), "{title}");
        }
        for title in ["⠙ Other", "⠙Document", "⠁ Document", "Document ⠙", "⠙", ""] {
            let mut after = before.clone();
            after.title = title.into();
            assert!(!before.matches_after_capture(&after), "{title}");
        }
        assert_ne!(capture_title("⠋"), capture_title("⠙"));
    }

    #[test]
    fn spinner_normalization_does_not_weaken_window_identity_checks() {
        let before = window();
        for field in [
            "id",
            "process_id",
            "app_identifier",
            "app_name",
            "bounds",
            "client_bounds",
        ] {
            let mut after = before.clone();
            after.title = "⠙ Document".into();
            match field {
                "id" => after.id = "{window-2}".into(),
                "process_id" => after.process_id = 456,
                "app_identifier" => after.app_identifier = "other".into(),
                "app_name" => after.app_name = "Other".into(),
                "bounds" => after.bounds.width = 400,
                "client_bounds" => after.client_bounds.height = 500,
                _ => unreachable!(),
            }
            assert!(!before.matches_after_capture(&after), "{field}");
        }
    }

    #[test]
    fn decodes_native_argb_and_row_padding() {
        let raw = [0xff112233_u32.to_ne_bytes(), [0; 4]].concat();
        assert_eq!(rgba(&raw, 1, 1, 8, 5).unwrap(), [0x11, 0x22, 0x33, 255]);
    }
    #[test]
    fn unpremultiplies_transparency() {
        assert_eq!(
            rgba(&[64, 32, 16, 128], 1, 1, 4, 18).unwrap(),
            [128, 64, 32, 128]
        );
        assert_eq!(rgba(&[0, 0, 0, 0], 1, 1, 4, 18).unwrap(), [0, 0, 0, 0]);
    }
    #[test]
    fn rejects_invalid_dimensions_truncation_and_formats() {
        for (width, height, stride, format) in [
            (0, 1, 4, 5),
            (2, 1, 4, 5),
            (1, 2, 4, 5),
            (1, 1, 4, 99),
            (usize::MAX, 1, 4, 5),
        ] {
            assert!(rgba(&[0; 4], width, height, stride, format).is_err());
        }
    }
}
