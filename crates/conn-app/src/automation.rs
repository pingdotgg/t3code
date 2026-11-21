//! Scripted control of a real window for visual verification (modeled on
//! `.refs/threadbear/desktop/gpui/src/automation.rs`). Only a build with the `automation` feature
//! has this; a release never does.
//!
//! Set `CONN_GPUI_AUTOMATION=<file>`. The app listens on a loopback port and writes the port to
//! that file. Each request is one JSON line; each reply is one JSON line (`{"result": ..}` or
//! `{"error": ..}`). `scripts/automate.py` is the client.
//!
//! Commands:
//! - `{"cmd":"dump"}`: theme, connection status, projects, threads, selection, timeline.
//! - `{"cmd":"screenshot","path":"..png"}`: the window's latest frame, flattened onto the
//!   theme background (GPUI's capture has no desktop blur behind the translucent frame).
//! - `{"cmd":"theme","id":"t3-code-light"}`
//! - `{"cmd":"select","title":"..."}` or `{"cmd":"select","id":"..."}`
//! - `{"cmd":"send","text":"..."}` (to the selected thread), `{"cmd":"stop"}`
//! - `{"cmd":"palette"}`, `{"cmd":"settings"}`: toggle the overlays
//! - `{"cmd":"browse","url":"..."}`, `{"cmd":"browser-title"}` (CEF builds)
//! - `{"cmd":"new-thread","project":"hello-rust"}`: open a draft; the next `send` launches it
//! - `{"cmd":"approve"}`, `{"cmd":"deny"}`: answer every pending approval in the selected thread
//! - `{"cmd":"sidebar"}`, `{"cmd":"panel","tab":"files"}`, `{"cmd":"close-panel"}`
//! - `{"cmd":"resize","width":1440,"height":900}`

use conn_state::RightPanelTab;
use gpui_kit::{AnyWindowHandle, App, AsyncApp, Entity, WeakEntity, px, size};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

use crate::app::ConnApp;
use crate::live::RT;

type Request = (Value, oneshot::Sender<Value>);

/// Starts listening if `CONN_GPUI_AUTOMATION` names a file to write the port to.
pub(crate) fn serve(app: &Entity<ConnApp>, window: AnyWindowHandle, cx: &mut App) {
    let Ok(file) = std::env::var("CONN_GPUI_AUTOMATION") else {
        return;
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<Request>();
    RT.spawn(listen(file, tx));
    let app = app.downgrade();
    cx.spawn(async move |cx| {
        while let Some((cmd, reply)) = rx.recv().await {
            let line = match run(&app, window, &cmd, cx).await {
                Ok(result) => json!({ "result": result }),
                Err(error) => json!({ "error": error }),
            };
            let _ = reply.send(line);
        }
    })
    .detach();
}

async fn listen(file: String, tx: mpsc::UnboundedSender<Request>) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0").await else {
        eprintln!("automation: could not bind a loopback port");
        return;
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    if let Err(e) = std::fs::write(&file, addr.port().to_string()) {
        eprintln!("automation: could not write {file}: {e}");
        return;
    }
    eprintln!("automation: listening on {addr}");
    while let Ok((stream, _)) = listener.accept().await {
        let tx = tx.clone();
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let cmd: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                let (reply_tx, reply_rx) = oneshot::channel();
                if tx.send((cmd, reply_tx)).is_err() {
                    return;
                }
                let Ok(reply) = reply_rx.await else { return };
                let mut out = reply.to_string();
                out.push('\n');
                if write.write_all(out.as_bytes()).await.is_err() {
                    return;
                }
            }
        });
    }
}

fn text<'a>(cmd: &'a Value, key: &str) -> &'a str {
    cmd.get(key).and_then(Value::as_str).unwrap_or_default()
}

async fn run(
    app: &WeakEntity<ConnApp>,
    window: AnyWindowHandle,
    cmd: &Value,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    let err = |e: anyhow_like::AnyError| e.0;
    match text(cmd, "cmd") {
        "dump" => app
            .read_with(cx, |app, _| app.automation_dump())
            .map_err(|e| err(e.into())),
        "theme" => {
            let id = text(cmd, "id").to_owned();
            let ok = app
                .update(cx, |app, cx| app.set_theme(&id, cx))
                .map_err(|e| err(e.into()))?;
            if ok {
                Ok(json!("ok"))
            } else {
                Err(format!("unknown theme `{id}`"))
            }
        }
        "select" => {
            let id = text(cmd, "id").to_owned();
            let title = text(cmd, "title").to_owned();
            app.update(cx, |app, cx| app.automation_select(&id, &title, cx))
                .map_err(|e| err(e.into()))?
        }
        "send" => {
            let body = text(cmd, "text").to_owned();
            app.update(cx, |app, cx| {
                app.send_prompt(body, cx);
                json!("ok")
            })
            .map_err(|e| err(e.into()))
        }
        "stop" => app
            .update(cx, |app, cx| {
                app.stop_selected(cx);
                json!("ok")
            })
            .map_err(|e| err(e.into())),
        "palette" | "settings" => {
            let which = text(cmd, "cmd").to_owned();
            let entity = app.upgrade().ok_or("app is gone")?;
            window
                .update(cx, |_, window, cx| {
                    entity.update(cx, |app, cx| {
                        if which == "palette" {
                            app.open_command_palette(window, cx);
                        } else {
                            app.open_settings(window, cx);
                        }
                    });
                })
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "browse" => {
            let url = text(cmd, "url").to_owned();
            app.update(cx, |app, cx| app.browse(url, cx))
                .map_err(|e| err(e.into()))?;
            // The native view is created at paint time, and a covered window gets no system
            // frames: draw one now so the browser appears without waiting for focus.
            window
                .update(cx, |_, window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "browser-state" => app
            .read_with(cx, |app, cx| app.browser_state(cx))
            .map_err(|e| err(e.into())),
        "browser-title" => app
            .read_with(cx, |app, cx| json!(app.browser_title(cx)))
            .map_err(|e| err(e.into())),
        "new-thread" => {
            let project = cmd
                .get("project")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mode = cmd.get("mode").and_then(Value::as_str).map(str::to_owned);
            app.update(cx, |app, cx| {
                let project_id = project.and_then(|title| {
                    app.shell()
                        .projects
                        .iter()
                        .find(|p| p.title == title || p.id == title)
                        .map(|p| p.id.clone())
                });
                app.set_draft_runtime_mode(mode);
                app.start_new_thread(project_id, cx);
                json!("ok")
            })
            .map_err(|e| err(e.into()))
        }
        "approve" | "deny" => {
            let decision = if text(cmd, "cmd") == "approve" {
                "accept"
            } else {
                "decline"
            };
            app.update(cx, |app, cx| {
                let pending: Vec<String> = app
                    .selected_timeline()
                    .map(|t| {
                        t.entries
                            .iter()
                            .filter(|e| matches!(e, conn_state::TimelineEntry::Approval { .. }))
                            .map(|e| e.id().to_owned())
                            .collect()
                    })
                    .unwrap_or_default();
                for id in &pending {
                    app.respond_approval(id, decision, cx);
                }
                json!(pending.len())
            })
            .map_err(|e| err(e.into()))
        }
        "sidebar" => app
            .update(cx, |app, cx| {
                app.toggle_sidebar(cx);
                json!("ok")
            })
            .map_err(|e| err(e.into())),
        "panel" => {
            let name = text(cmd, "tab");
            let Some(tab) = RightPanelTab::MENU_ORDER.into_iter().find(|tab| {
                crate::panels::header::panel_tab_label(*tab).eq_ignore_ascii_case(name)
            }) else {
                return Err(format!("unknown tab `{name}`"));
            };
            app.update(cx, |app, cx| {
                app.select_right_panel_tab(tab, cx);
                json!("ok")
            })
            .map_err(|e| err(e.into()))
        }
        "close-panel" => app
            .update(cx, |app, cx| {
                if app.layout().right_panel_open {
                    app.toggle_right_panel(cx);
                }
                json!("ok")
            })
            .map_err(|e| err(e.into())),
        "resize" => {
            let w = cmd.get("width").and_then(Value::as_f64).unwrap_or(1440.0) as f32;
            let h = cmd.get("height").and_then(Value::as_f64).unwrap_or(900.0) as f32;
            window
                .update(cx, |_, window, _| window.resize(size(px(w), px(h))))
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "screenshot" => {
            let path = std::path::PathBuf::from(text(cmd, "path"));
            let backdrop = app
                .read_with(cx, |app, _| app.tokens().background)
                .map_err(|e| err(e.into()))?;
            let image = window
                .update(cx, |_, window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                    window.render_to_image().map_err(|e| e.to_string())
                })
                .map_err(|e| e.to_string())??;
            cx.background_executor()
                .spawn(async move { save_flattened(image, backdrop, &path) })
                .await?;
            Ok(json!("ok"))
        }
        other => Err(format!("unknown command `{other}`")),
    }
}

/// Writes `image` composited over an opaque `backdrop` (the translucent frame has no desktop
/// behind it in a capture), so the PNG shows what the eye sees over a plain background.
fn save_flattened(
    mut image: image::RgbaImage,
    backdrop: conn_theme::Rgba,
    path: &std::path::Path,
) -> Result<(), String> {
    let bg = [backdrop.r, backdrop.g, backdrop.b];
    for pixel in image.pixels_mut() {
        let a = f32::from(pixel[3]) / 255.0;
        for (channel, bg) in pixel.0.iter_mut().take(3).zip(bg) {
            // Metal's capture is premultiplied by alpha.
            let src = f32::from(*channel) / 255.0;
            let out = src + bg * (1.0 - a);
            *channel = (out.clamp(0.0, 1.0) * 255.0).round() as u8;
        }
        pixel[3] = 255;
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    image.save(path).map_err(|e| e.to_string())
}

/// Error text from GPUI's handle errors without naming `anyhow` as a dependency.
mod anyhow_like {
    pub(super) struct AnyError(pub(super) String);
    impl<E: std::fmt::Display> From<E> for AnyError {
        fn from(e: E) -> Self {
            Self(e.to_string())
        }
    }
}
