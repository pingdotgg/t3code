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
use gpui_kit::test::{TestEventExt as _, TestWindowExt as _};
use gpui_kit::{
    AnyWindowHandle, App, AsyncApp, Entity, InputEvent as _, MouseButton, Point, ScrollDelta,
    ScrollEvent, WeakEntity, point, px, size,
};
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

async fn await_preview_reply(
    rx: oneshot::Receiver<Result<Value, String>>,
) -> Result<Value, String> {
    RT.spawn(async move {
        tokio::time::timeout(std::time::Duration::from_secs(15), rx)
            .await
            .map_err(|_| "Timed out waiting for browser preview reply.".to_owned())?
            .map_err(|_| "Browser preview channel closed.".to_owned())?
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn run(
    app: &WeakEntity<ConnApp>,
    window: AnyWindowHandle,
    cmd: &Value,
    cx: &mut AsyncApp,
) -> Result<Value, String> {
    let err = |e: anyhow_like::AnyError| e.0;
    match text(cmd, "cmd") {
        "spike-files-open" => {
            let path = text(cmd, "path").to_owned();
            if !conn_contract::source::workspace_relative(&path) {
                return Err("Expected workspace-relative file".into());
            }
            app.update(cx, |app, cx| {
                app.show_source_location(
                    &conn_contract::source::SourceLocation { path, lines: None },
                    cx,
                )
            })
            .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "spike-files-state" => window
            .update(cx, |_, window, cx| {
                app.read_with(cx, |app, cx| app.spike_files_state(window, cx))
            })
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string()),
        "spike-drag" => {
            let pt = |a: &str, b: &str| {
                point(
                    px(cmd[a].as_f64().unwrap_or_default() as f32),
                    px(cmd[b].as_f64().unwrap_or_default() as f32),
                )
            };
            let (start, end) = (pt("x", "y"), pt("toX", "toY"));
            window
                .update(cx, |_, window, cx| {
                    window.pointer_move(start, None, cx);
                    window.pointer_down(start, MouseButton::Left, cx);
                    window.pointer_move(end, Some(MouseButton::Left), cx);
                    window.pointer_up(end, MouseButton::Left, cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "dump" => app
            .read_with(cx, |app, cx| app.automation_dump(cx))
            .map_err(|e| err(e.into())),
        "connect-saved-environment" => {
            app.update(cx, |app, cx| {
                app.automation_connect_saved(text(cmd, "id"), cx)
            })
            .map_err(|e| err(e.into()))??;
            Ok(json!(true))
        }
        "seed-big-thread" => {
            let turns = cmd
                .get("turns")
                .and_then(Value::as_u64)
                .map_or(100, |n| n as usize);
            app.update(cx, |app, cx| app.automation_seed_big_thread(turns, cx))
                .map_err(|e| err(e.into()))
        }
        "toc-open" => {
            let open = cmd.get("open").and_then(Value::as_bool).unwrap_or(true);
            app.update(cx, |app, cx| app.automation_set_toc_open(open, cx))
                .map_err(|e| err(e.into()))
        }
        "toc-jump" => {
            let turn = cmd
                .get("turn")
                .and_then(Value::as_u64)
                .ok_or_else(|| "toc-jump requires integer `turn` (1-based)".to_owned())?
                as usize;
            app.update(cx, |app, cx| app.automation_toc_jump(turn, cx))
                .map_err(|e| err(e.into()))?
        }
        "scroll-latest" => app
            .update(cx, |app, cx| app.automation_scroll_latest(cx))
            .map_err(|e| err(e.into())),
        "a11y-tree" => {
            let tree = window
                .update(cx, |_, window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                    window.debug_a11y_tree_json()
                })
                .map_err(|e| e.to_string())?;
            Ok(match tree {
                Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json!(raw)),
                None => json!({ "active": false }),
            })
        }
        #[cfg(target_os = "macos")]
        "ax-hit-test" => {
            let x = cmd.get("x").and_then(Value::as_f64).unwrap_or(20.0);
            let y = cmd.get("y").and_then(Value::as_f64).unwrap_or(60.0);
            window
                .update(cx, |_, window, cx| {
                    window.refresh();
                    window.draw(cx).clear(cx);
                    macos_ax_hit_test(window, x, y)
                })
                .map_err(|e| e.to_string())?
        }
        #[cfg(target_os = "macos")]
        "query" => {
            let filter = AxFilter::from_cmd(cmd);
            let nodes = window
                .update(cx, |_, window, cx| {
                    window.render_frame(cx);
                    macos_ax_query(window, &filter)
                })
                .map_err(|e| e.to_string())??;
            Ok(json!({ "matches": nodes }))
        }
        #[cfg(target_os = "macos")]
        "click" => {
            let button = match text(cmd, "button") {
                "right" => MouseButton::Right,
                "middle" => MouseButton::Middle,
                _ => MouseButton::Left,
            };
            let clicks = cmd
                .get("clicks")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1) as usize;
            let (pt, matched) = resolve_target_point(window, cmd, cx)?;
            window
                .update(cx, |_, window, cx| {
                    let original = window.modifiers();
                    let command = cmd.get("command").and_then(Value::as_bool) == Some(true);
                    if command {
                        window.change_modifiers(gpui_kit::Modifiers::command(), cx);
                    }
                    window.pointer_move(pt, None, cx);
                    for _ in 0..clicks {
                        window.pointer_down(pt, button, cx);
                        window.pointer_up(pt, button, cx);
                    }
                    if command {
                        window.change_modifiers(original, cx);
                    }
                })
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "x": f32::from(pt.x),
                "y": f32::from(pt.y),
                "target": matched,
            }))
        }
        #[cfg(target_os = "macos")]
        "modifiers" => {
            let modifiers = if cmd.get("command").and_then(Value::as_bool) == Some(true) {
                gpui_kit::Modifiers::command()
            } else {
                gpui_kit::Modifiers::none()
            };
            window
                .update(cx, |_, window, cx| window.change_modifiers(modifiers, cx))
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        #[cfg(target_os = "macos")]
        "hover" => {
            let (pt, matched) = resolve_target_point(window, cmd, cx)?;
            window
                .update(cx, |_, window, cx| {
                    window.pointer_move(pt, None, cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "x": f32::from(pt.x),
                "y": f32::from(pt.y),
                "target": matched,
            }))
        }
        "press" => {
            let key = text(cmd, "key").to_owned();
            if key.is_empty() {
                return Err(
                    "`press` requires a non-empty `key` (e.g. `cmd-k`, `escape`)".to_owned(),
                );
            }
            window
                .update(cx, |_, window, cx| {
                    window.press(&key, cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!({ "pressed": key }))
        }
        "type" => {
            let value = text(cmd, "text").to_owned();
            window
                .update(cx, |_, window, cx| {
                    window.input(&value, cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!({ "typed": value.len() }))
        }
        #[cfg(target_os = "macos")]
        "scroll" => {
            let dx = cmd.get("deltaX").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let dy = cmd.get("deltaY").and_then(Value::as_f64).unwrap_or(-120.0) as f32;
            let (pt, matched) = resolve_target_point(window, cmd, cx)?;
            window
                .update(cx, |_, window, cx| {
                    window.render_frame(cx);
                    window.dispatch_event(
                        ScrollEvent {
                            position: pt,
                            delta: ScrollDelta::Pixels(point(px(dx), px(dy))),
                            modifiers: window.modifiers(),
                            ..Default::default()
                        }
                        .to_platform_input(),
                        cx,
                    );
                    window.render_frame(cx);
                })
                .map_err(|e| e.to_string())?;
            Ok(json!({
                "x": f32::from(pt.x),
                "y": f32::from(pt.y),
                "deltaX": dx,
                "deltaY": dy,
                "target": matched,
            }))
        }
        #[cfg(target_os = "macos")]
        "wait" => {
            let timeout_ms = cmd
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(5_000)
                .min(30_000);
            let expect_absent = cmd.get("absent").and_then(Value::as_bool).unwrap_or(false)
                || cmd.get("absentAxId").is_some()
                || cmd.get("absentLabel").is_some();
            let filter = if expect_absent {
                AxFilter {
                    ax_id: cmd
                        .get("absentAxId")
                        .or_else(|| cmd.get("axId"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    label: cmd
                        .get("absentLabel")
                        .or_else(|| cmd.get("label"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    role: cmd.get("role").and_then(Value::as_str).map(str::to_owned),
                }
            } else {
                AxFilter::from_cmd(cmd)
            };
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
            loop {
                let nodes = window
                    .update(cx, |_, window, cx| {
                        window.render_frame(cx);
                        macos_ax_query(window, &filter)
                    })
                    .map_err(|e| e.to_string())??;
                if expect_absent && nodes.is_empty() {
                    return Ok(json!({ "matched": false, "absent": true }));
                }
                if !expect_absent && !nodes.is_empty() {
                    return Ok(json!({ "matched": true, "matches": nodes }));
                }
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for element (absent={expect_absent}, axId={:?}, label={:?})",
                        filter.ax_id, filter.label
                    ));
                }
                RT.spawn(async {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                })
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        "theme" => {
            let id = text(cmd, "id").to_owned();
            let ok = app
                .update(cx, |app, cx| app.set_theme_local(&id, cx))
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
        "attach-file" => {
            let path = text(cmd, "path");
            if path.is_empty() {
                return Err("`attach-file` requires a non-empty `path`".to_owned());
            }
            let path = std::path::PathBuf::from(path);
            let entity = app.upgrade().ok_or("app is gone")?;
            window
                .update(cx, |_, window, cx| {
                    entity.update(cx, |app, cx| {
                        app.attach_paths_to_composer(vec![path], window, cx);
                    });
                })
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
        }
        "clipboard-read" => {
            let value = cx.update(|cx| cx.read_from_clipboard().and_then(|item| item.text()));
            Ok(json!({ "text": value }))
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
        "browser-eval" => {
            let expression = text(cmd, "expression").to_owned();
            let rx = app
                .update(cx, |app, cx| app.browser_preview_eval(&expression, cx))
                .map_err(|e| err(e.into()))??;
            await_preview_reply(rx).await
        }
        "browser-snapshot" => {
            let rx = app
                .update(cx, |app, cx| {
                    app.browser_preview_call("snapshot", &json!({}), cx)
                })
                .map_err(|e| err(e.into()))??;
            await_preview_reply(rx).await
        }
        "browser-act" => {
            let rx = app
                .update(cx, |app, cx| app.browser_preview_call("act", cmd, cx))
                .map_err(|e| err(e.into()))??;
            await_preview_reply(rx).await
        }
        "browser-screenshot" => {
            let path = std::path::PathBuf::from(text(cmd, "path"));
            app.read_with(cx, |app, cx| app.browser_screenshot(&path, cx))
                .map_err(|e| err(e.into()))?
        }
        "new-thread" => {
            let project = cmd
                .get("project")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let mode = cmd.get("mode").and_then(Value::as_str).map(str::to_owned);
            let worktree = cmd.get("worktree").and_then(Value::as_bool);
            let entity = app.upgrade().ok_or("app is gone")?;
            window
                .update(cx, |_, window, cx| {
                    entity.update(cx, |app, cx| {
                        let project_id = project.and_then(|title| {
                            app.shell()
                                .projects
                                .iter()
                                .find(|p| p.title == title || p.id == title)
                                .map(|p| p.id.clone())
                        });
                        app.start_new_thread(project_id, Some(window), cx);
                        if let Some(mode) = mode {
                            app.set_draft_runtime_mode(Some(mode), cx);
                        }
                        if let Some(use_worktree) = worktree {
                            app.set_draft_workspace_strategy(use_worktree, cx);
                        }
                    });
                })
                .map_err(|e| e.to_string())?;
            Ok(json!("ok"))
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

/// Calls AppKit's `-[NSView accessibilityChildren]` and `-[NSView accessibilityHitTest:]`
/// directly on the window's content view (the same Objective-C methods invoked by macOS
/// `AXUIElementCopyElementAtPosition`) so automated tests can verify live macOS AX output
/// without cross-process TCC grants.
#[cfg(target_os = "macos")]
fn macos_ax_hit_test(
    window: &gpui_kit::Window,
    x_from_left: f64,
    y_from_top: f64,
) -> Result<Value, String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::CStr;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsRect {
        origin: NsPoint,
        size: NsSize,
    }
    // SAFETY: `NsPoint` matches AppKit `NSPoint` (`CGPoint`: two f64s).
    unsafe impl objc2::Encode for NsPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsSize` matches AppKit `NSSize` (`CGSize`: two f64s).
    unsafe impl objc2::Encode for NsSize {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsRect` matches AppKit `NSRect` (`CGRect`: `CGPoint` + `CGSize`).
    unsafe impl objc2::Encode for NsRect {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[NsPoint::ENCODING, NsSize::ENCODING]);
    }

    let handle = HasWindowHandle::window_handle(window).map_err(|e| e.to_string())?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("window is not AppKit".to_owned());
    };

    // Helper: read an `NSString *` returned by an accessibility getter.
    unsafe fn ax_string(obj: &AnyObject, sel: objc2::runtime::Sel) -> Option<String> {
        // SAFETY: Caller passes a live Objective-C object on the main thread whose selector
        // returns a nullable `NSString *`.
        let s: Option<Retained<AnyObject>> = unsafe { objc2::msg_send![obj, performSelector: sel] };
        let s = s?;
        // SAFETY: `s` is a valid `NSString`; `UTF8String` returns a NUL-terminated C string
        // valid for the lifetime of `s` (or null).
        let ptr: *const std::ffi::c_char = unsafe { objc2::msg_send![&*s, UTF8String] };
        if ptr.is_null() {
            return None;
        }
        // SAFETY: `ptr` is non-null and NUL-terminated, backed by `s` for this block.
        let cstr = unsafe { CStr::from_ptr(ptr) };
        Some(cstr.to_string_lossy().into_owned())
    }

    // SAFETY: Executed synchronously on the AppKit main thread inside `window.update`, with a
    // live `NSView` handle from GPUI. Every `msg_send!` selector is a documented `NSView`,
    // `NSWindow`, `NSArray`, or `NSAccessibility` protocol method.
    unsafe {
        let view: &AnyObject = handle.ns_view.cast::<AnyObject>().as_ref();
        let ns_window: Option<Retained<AnyObject>> = objc2::msg_send![view, window];
        let ns_window = ns_window.ok_or("no NSWindow")?;
        let content: Option<Retained<AnyObject>> = objc2::msg_send![&*ns_window, contentView];
        let content = content.ok_or("no contentView")?;

        let cls_name_ptr: *const std::ffi::c_char = {
            let cls_str: Retained<AnyObject> = objc2::msg_send![&*content, className];
            objc2::msg_send![&*cls_str, UTF8String]
        };
        let content_class = if cls_name_ptr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(cls_name_ptr).to_string_lossy().into_owned()
        };

        let children: Option<Retained<AnyObject>> =
            objc2::msg_send![&*content, accessibilityChildren];
        let child_count: usize = children
            .as_ref()
            .map_or(0, |arr| objc2::msg_send![&**arr, count]);

        let bounds: NsRect = objc2::msg_send![&*content, bounds];
        let flipped: bool = objc2::msg_send![&*content, isFlipped];
        let view_pt = NsPoint {
            x: x_from_left,
            y: if flipped {
                y_from_top
            } else {
                bounds.size.height - y_from_top
            },
        };
        let nil: *mut AnyObject = std::ptr::null_mut();
        let win_pt: NsPoint = objc2::msg_send![&*content, convertPoint: view_pt, toView: nil];
        let screen_pt: NsPoint = objc2::msg_send![&*ns_window, convertPointToScreen: win_pt];

        let hit: Option<Retained<AnyObject>> =
            objc2::msg_send![&*content, accessibilityHitTest: screen_pt];
        let hit_json = match hit {
            Some(el) => {
                let role = ax_string(&el, objc2::sel!(accessibilityRole));
                let subrole = ax_string(&el, objc2::sel!(accessibilitySubrole));
                let identifier = ax_string(&el, objc2::sel!(accessibilityIdentifier));
                let title = ax_string(&el, objc2::sel!(accessibilityTitle));
                let help = ax_string(&el, objc2::sel!(accessibilityHelp));
                let frame: NsRect = objc2::msg_send![&*el, accessibilityFrame];
                json!({
                    "role": role,
                    "subrole": subrole,
                    "identifier": identifier,
                    "title": title,
                    "help": help,
                    "frame": {
                        "x": frame.origin.x,
                        "y": frame.origin.y,
                        "width": frame.size.width,
                        "height": frame.size.height,
                    },
                })
            }
            None => Value::Null,
        };

        Ok(json!({
            "content_class": content_class,
            "child_count": child_count,
            "query": { "x": x_from_left, "y": y_from_top },
            "hit": hit_json,
        }))
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct AxFilter {
    ax_id: Option<String>,
    label: Option<String>,
    role: Option<String>,
}

#[cfg(target_os = "macos")]
impl AxFilter {
    fn from_cmd(cmd: &Value) -> Self {
        Self {
            ax_id: cmd.get("axId").and_then(Value::as_str).map(str::to_owned),
            label: cmd.get("label").and_then(Value::as_str).map(str::to_owned),
            role: cmd.get("role").and_then(Value::as_str).map(str::to_owned),
        }
    }

    fn matches(&self, ax_id: Option<&str>, label: Option<&str>, role: Option<&str>) -> bool {
        if let Some(want) = self.ax_id.as_deref()
            && ax_id != Some(want)
        {
            return false;
        }
        if let Some(want) = self.label.as_deref() {
            let needle = want.to_ascii_lowercase();
            let got = label.unwrap_or("").to_ascii_lowercase();
            if !got.contains(&needle) {
                return false;
            }
        }
        if let Some(want) = self.role.as_deref() {
            let needle = want.to_ascii_lowercase();
            let got = role.unwrap_or("").to_ascii_lowercase();
            if got != needle && !got.ends_with(&needle) {
                return false;
            }
        }
        true
    }
}

#[cfg(target_os = "macos")]
fn resolve_target_point(
    window: AnyWindowHandle,
    cmd: &Value,
    cx: &mut AsyncApp,
) -> Result<(Point<gpui_kit::Pixels>, Value), String> {
    if let (Some(x), Some(y)) = (
        cmd.get("x").and_then(Value::as_f64),
        cmd.get("y").and_then(Value::as_f64),
    ) {
        return Ok((point(px(x as f32), px(y as f32)), Value::Null));
    }
    let filter = AxFilter::from_cmd(cmd);
    if filter.ax_id.is_none() && filter.label.is_none() && filter.role.is_none() {
        return Err("target requires `axId`, `label`, `role`, or explicit `x`/`y`".to_owned());
    }
    let index = cmd.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
    let matches = window
        .update(cx, |_, window, cx| {
            window.render_frame(cx);
            macos_ax_query(window, &filter)
        })
        .map_err(|e| e.to_string())??;
    let target = matches
        .into_iter()
        .filter(|node| {
            node["bounds"]["width"].as_f64().unwrap_or(0.0) > 0.0
                && node["bounds"]["height"].as_f64().unwrap_or(0.0) > 0.0
        })
        .nth(index)
        .ok_or_else(|| {
            format!(
                "no visible element matched axId={:?} label={:?} role={:?}",
                filter.ax_id, filter.label, filter.role
            )
        })?;
    let x = target["bounds"]["x"].as_f64().unwrap_or(0.0)
        + target["bounds"]["width"].as_f64().unwrap_or(0.0) * 0.5;
    let y = target["bounds"]["y"].as_f64().unwrap_or(0.0)
        + target["bounds"]["height"].as_f64().unwrap_or(0.0) * 0.5;
    Ok((point(px(x as f32), px(y as f32)), target))
}

/// Walks the window's live in-process AppKit AccessKit tree and returns every matching
/// node with its `axId`, `role`, `label`, and window-local top-left GPUI `bounds`.
#[cfg(target_os = "macos")]
fn macos_ax_query(window: &gpui_kit::Window, filter: &AxFilter) -> Result<Vec<Value>, String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::ffi::CStr;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NsRect {
        origin: NsPoint,
        size: NsSize,
    }
    // SAFETY: `NsPoint` matches AppKit `NSPoint` (`CGPoint`: two f64s).
    unsafe impl objc2::Encode for NsPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsSize` matches AppKit `NSSize` (`CGSize`: two f64s).
    unsafe impl objc2::Encode for NsSize {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    // SAFETY: `NsRect` matches AppKit `NSRect` (`CGRect`: `CGPoint` + `CGSize`).
    unsafe impl objc2::Encode for NsRect {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGRect", &[NsPoint::ENCODING, NsSize::ENCODING]);
    }

    unsafe fn ax_string(obj: &AnyObject, sel: objc2::runtime::Sel) -> Option<String> {
        // SAFETY: Caller passes a live Objective-C accessibility object on the AppKit main thread.
        let responds: bool = unsafe { objc2::msg_send![obj, respondsToSelector: sel] };
        if !responds {
            return None;
        }
        // SAFETY: Selector existence was checked immediately above.
        let s: Option<Retained<AnyObject>> = unsafe { objc2::msg_send![obj, performSelector: sel] };
        let s = s?;
        // SAFETY: `s` is an `NSString` returned by an accessibility string getter.
        let ptr: *const std::ffi::c_char = unsafe { objc2::msg_send![&*s, UTF8String] };
        if ptr.is_null() {
            return None;
        }
        // SAFETY: `ptr` is non-null and NUL-terminated for the lifetime of `s`.
        let cstr = unsafe { CStr::from_ptr(ptr) };
        let out = cstr.to_string_lossy().into_owned();
        if out.is_empty() { None } else { Some(out) }
    }

    let handle = HasWindowHandle::window_handle(window).map_err(|e| e.to_string())?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("window is not AppKit".to_owned());
    };

    // SAFETY: Executed on the AppKit main thread inside `window.update` with a live GPUI NSView.
    unsafe {
        let view: &AnyObject = handle.ns_view.cast::<AnyObject>().as_ref();
        let ns_window: Option<Retained<AnyObject>> = objc2::msg_send![view, window];
        let ns_window = ns_window.ok_or("no NSWindow")?;
        let content: Option<Retained<AnyObject>> = objc2::msg_send![&*ns_window, contentView];
        let content = content.ok_or("no contentView")?;
        let content_bounds: NsRect = objc2::msg_send![&*content, bounds];
        let flipped: bool = objc2::msg_send![&*content, isFlipped];
        let nil: *mut AnyObject = std::ptr::null_mut();

        let mut stack: Vec<Retained<AnyObject>> = Vec::new();
        let root_children: Option<Retained<AnyObject>> =
            objc2::msg_send![&*content, accessibilityChildren];
        if let Some(arr) = root_children {
            let count: usize = objc2::msg_send![&*arr, count];
            for idx in (0..count).rev() {
                let child: Retained<AnyObject> = objc2::msg_send![&*arr, objectAtIndex: idx];
                stack.push(child);
            }
        }

        let mut results = Vec::new();
        let mut visited = 0usize;
        while let Some(el) = stack.pop() {
            visited += 1;
            if visited > 4_000 {
                break;
            }
            let role = ax_string(&el, objc2::sel!(accessibilityRole));
            let ax_id = ax_string(&el, objc2::sel!(accessibilityIdentifier));
            let label = ax_string(&el, objc2::sel!(accessibilityTitle))
                .or_else(|| ax_string(&el, objc2::sel!(accessibilityLabel)))
                .or_else(|| ax_string(&el, objc2::sel!(accessibilityHelp)));

            if filter.matches(ax_id.as_deref(), label.as_deref(), role.as_deref()) {
                let screen_frame: NsRect = objc2::msg_send![&*el, accessibilityFrame];
                let win_rect: NsRect =
                    objc2::msg_send![&*ns_window, convertRectFromScreen: screen_frame];
                let view_rect: NsRect =
                    objc2::msg_send![&*content, convertRect: win_rect, fromView: nil];
                let y = if flipped {
                    view_rect.origin.y
                } else {
                    content_bounds.size.height - (view_rect.origin.y + view_rect.size.height)
                };
                results.push(json!({
                    "axId": ax_id,
                    "role": role,
                    "label": label,
                    "bounds": {
                        "x": view_rect.origin.x,
                        "y": y,
                        "width": view_rect.size.width,
                        "height": view_rect.size.height,
                    },
                }));
            }

            let responds_children: bool =
                objc2::msg_send![&*el, respondsToSelector: objc2::sel!(accessibilityChildren)];
            if responds_children {
                let kids: Option<Retained<AnyObject>> =
                    objc2::msg_send![&*el, accessibilityChildren];
                if let Some(arr) = kids {
                    let count: usize = objc2::msg_send![&*arr, count];
                    for idx in (0..count).rev() {
                        let child: Retained<AnyObject> =
                            objc2::msg_send![&*arr, objectAtIndex: idx];
                        stack.push(child);
                    }
                }
            }
        }
        Ok(results)
    }
}
