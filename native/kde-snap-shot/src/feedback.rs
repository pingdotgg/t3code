//! A short-lived QML overlay hosted by KWin, not a persistent desktop effect.
//! Commands arrive on our parent's private stdin; only KWin can consume them.
use super::*;
use std::io::BufRead;

const OBJECT: &str = "/com/t3tools/KdeCapture/Feedback";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    bounds: Bounds,
    pid: u32,
    flash: bool,
    animate: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum Event {
    Ready { animate: bool },
    Landed,
    Done,
}

struct Bridge {
    owner: String,
    commands: async_channel::Receiver<String>,
    done: mpsc::SyncSender<()>,
}
impl Bridge {
    fn authorize(&self, header: &zbus::message::Header<'_>) -> zbus::fdo::Result<()> {
        if header.sender().map(|name| name.as_str()) == Some(self.owner.as_str()) {
            Ok(())
        } else {
            Err(zbus::fdo::Error::AccessDenied("Not KWin".into()))
        }
    }
}
#[zbus::interface(name = "com.t3tools.KdeCapture.Feedback")]
impl Bridge {
    // An async pending call is an event channel, not a timer or a blocking KWin call.
    async fn next(
        &self,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<String> {
        self.authorize(&header)?;
        Ok(self
            .commands
            .recv()
            .await
            .unwrap_or_else(|_| "{\"command\":\"close\"}".into()))
    }

    fn event(
        &self,
        value: &str,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        self.authorize(&header)?;
        let event: Event = serde_json::from_str(value)
            .map_err(|_| zbus::fdo::Error::InvalidArgs("Invalid feedback event".into()))?;
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{}", serde_json::to_string(&event).unwrap());
        let _ = stdout.flush();
        if matches!(event, Event::Done) {
            let _ = self.done.try_send(());
        }
        Ok(())
    }
}

pub(super) fn supported(connection: &Connection) -> bool {
    let Ok(proxy) = Proxy::new(
        connection,
        "org.kde.KWin",
        "/Scripting",
        "org.freedesktop.DBus.Introspectable",
    ) else {
        return false;
    };
    proxy
        .call::<_, _, String>("Introspect", &())
        .is_ok_and(|xml| xml.contains("name=\"loadDeclarativeScript\""))
}

pub(super) fn run(connection: &Connection, directory: &Path, options: &str) -> Result<()> {
    let mut options: Options = serde_json::from_str(options)?;
    if options.bounds.width == 0 || options.bounds.height == 0 || options.pid == 0 {
        return Err("Invalid capture feedback geometry".into());
    }
    // Use KDE's config reader to respect config layering and the desktop's motion setting.
    let factor = std::process::Command::new("kreadconfig6")
        .args([
            "--file",
            "kdeglobals",
            "--group",
            "KDE",
            "--key",
            "AnimationDurationFactor",
            "--default",
            "1",
        ])
        .output()?;
    if !factor.status.success() {
        return Err("Couldn't read KDE animation preferences".into());
    }
    let factor: f64 = String::from_utf8(factor.stdout)?.trim().parse()?;
    if !factor.is_finite() || factor < 0.0 {
        return Err("Invalid KDE animation preference".into());
    }
    options.animate &= factor > 0.0;
    let owner = zbus::blocking::fdo::DBusProxy::new(connection)?
        .get_name_owner("org.kde.KWin".try_into()?)?
        .to_string();
    let (send, commands) = async_channel::bounded(4);
    let (done, finished) = mpsc::sync_channel(1);
    connection.object_server().at(
        OBJECT,
        Bridge {
            owner,
            commands,
            done,
        },
    )?;

    // Subscribe before checking, so a lock racing setup can't expose the snapshot.
    let locker = Proxy::new(
        connection,
        "org.freedesktop.ScreenSaver",
        "/ScreenSaver",
        "org.freedesktop.ScreenSaver",
    )?;
    let signals = locker.receive_signal("ActiveChanged")?;
    if locker.call::<_, _, bool>("GetActive", &())? {
        return Err("Screen is locked".into());
    }
    let lock_commands = send.clone();
    std::thread::spawn(move || {
        for signal in signals {
            if signal
                .body()
                .deserialize::<(bool,)>()
                .is_ok_and(|(active,)| active)
            {
                let _ = lock_commands.send_blocking("{\"command\":\"close\"}".into());
                break;
            }
        }
    });
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = String::new();
            match input.by_ref().take(8193).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 8192 => break,
                _ => {
                    if send.send_blocking(line).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = send.send_blocking("{\"command\":\"close\"}".into());
    });

    let path = directory.join("feedback.qml");
    let name = format!("t3-capture-feedback-{}", std::process::id());
    let bus = serde_json::to_string(
        connection
            .unique_name()
            .ok_or("Missing bus identity")?
            .as_str(),
    )?;
    let source = include_str!("feedback.qml")
        .replace("/*OPTIONS*/ null", &serde_json::to_string(&options)?)
        .replace("/*BUS*/ \"\"", &bus)
        .replace("/*NAME*/ \"\"", &serde_json::to_string(&name)?)
        .replace("/*FACTOR*/ 1", &factor.clamp(0.0, 3.0).to_string());
    std::fs::write(&path, source)?;
    std::fs::write(
        directory.join("feedbackGeometry.js"),
        include_str!("feedbackGeometry.js"),
    )?;
    let scripting = Proxy::new(
        connection,
        "org.kde.KWin",
        "/Scripting",
        "org.kde.kwin.Scripting",
    )?;
    let result = (|| {
        let id: i32 = scripting.call(
            "loadDeclarativeScript",
            &(path.to_str().ok_or("Invalid script path")?, &name),
        )?;
        if id < 0 {
            return Err("KWin could not load capture feedback".into());
        }
        let object = format!("/Scripting/Script{id}");
        let loaded = Proxy::new(
            connection,
            "org.kde.KWin",
            object.as_str(),
            "org.kde.kwin.Script",
        )?;
        let _: () = loaded.call("run", &())?;
        finished.recv_timeout(Duration::from_secs(12))?;
        Ok(())
    })();
    let _: zbus::Result<bool> = scripting.call("unloadScript", &(&name,));
    let _ = connection.object_server().remove::<Bridge, _>(OBJECT);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_kwin_can_read_commands_or_acknowledge_feedback() {
        let f = crate::transport_tests::Fixture::new();
        let (send, commands) = async_channel::bounded(4);
        let (done, finished) = mpsc::sync_channel(1);
        f.client
            .object_server()
            .at(
                OBJECT,
                Bridge {
                    owner: f._server.unique_name().unwrap().to_string(),
                    commands,
                    done,
                },
            )
            .unwrap();
        let destination = f.client.unique_name().unwrap().to_string();
        let stranger = Builder::address(f.address.as_str())
            .unwrap()
            .method_timeout(DEADLINE)
            .build()
            .unwrap();
        let unrelated = Proxy::new(
            &stranger,
            destination.as_str(),
            OBJECT,
            "com.t3tools.KdeCapture.Feedback",
        )
        .unwrap();
        let error = unrelated.call::<_, _, String>("Next", &()).unwrap_err();
        assert!(
            matches!(&error, zbus::Error::MethodError(name, _, _) if name.as_str() == "org.freedesktop.DBus.Error.AccessDenied"),
            "{error:?}"
        );
        assert!(
            unrelated
                .call::<_, _, ()>("Event", &("{\"event\":\"done\"}",))
                .is_err()
        );
        assert!(finished.try_recv().is_err());

        let kwin = Proxy::new(
            &f._server,
            destination.clone(),
            OBJECT,
            "com.t3tools.KdeCapture.Feedback",
        )
        .unwrap();
        // Event remains responsive while Next waits. No blocking the D-Bus executor.
        let next = kwin.clone();
        let request = std::thread::spawn(move || next.call::<_, _, String>("Next", &()).unwrap());
        kwin.call::<_, _, ()>("Event", &("{\"event\":\"ready\",\"animate\":true}",))
            .unwrap();
        send.send_blocking("{\"command\":\"close\"}".into())
            .unwrap();
        assert_eq!(request.join().unwrap(), "{\"command\":\"close\"}");
        kwin.call::<_, _, ()>("Event", &("{\"event\":\"done\"}",))
            .unwrap();
        finished.recv_timeout(DEADLINE).unwrap();
        f.client
            .object_server()
            .remove::<Bridge, _>(OBJECT)
            .unwrap();
    }

    #[test]
    fn capability_probe_rejects_missing_declarative_api_without_running_a_script() {
        let f = crate::transport_tests::Fixture::new();
        assert!(!supported(&f.client));
    }
}
