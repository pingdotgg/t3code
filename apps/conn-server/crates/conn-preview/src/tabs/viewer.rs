//! Bounded viewer sessions and human ownership of a server tab.
use super::{Inner, Preview, Tab, lock};
use crate::{Browser, Error};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    time::Instant,
};

/// A decoded viewer frame or state message. The socket sends frames as binary JPEG.
#[derive(Debug)]
pub enum Output {
    Frame(crate::screencast::Frame),
    Message(Value),
    Closed,
}
/// One attached viewer. It shares the tab capture and releases control on drop.
#[derive(Debug)]
pub struct Viewer {
    inner: std::sync::Weak<Inner>,
    thread: String,
    tab: String,
    id: String,
    browser: Browser,
    session: String,
    frames: broadcast::Receiver<crate::screencast::Frame>,
    control: watch::Receiver<Value>,
    can_operate: bool,
    first: Option<Value>,
    still: Option<String>,
    pressed: Mutex<Vec<Value>>,
}
impl Drop for Viewer {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut state = lock(&inner.state);
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|t| t.thread == self.thread && t.id == self.tab)
            {
                tab.viewers.retain(|id| id != &self.id);
                if tab.controller.as_deref() == Some(&self.id) {
                    tab.controller = None;
                    tab.generation += 1;
                }
                let _ = tab.control.send(control_message(tab));
            }
        }
        let pressed = std::mem::take(&mut *lock(&self.pressed));
        let browser = self.browser.clone();
        let session = self.session.clone();
        let inner = self.inner.clone();
        let thread = self.thread.clone();
        let id = self.tab.clone();
        tokio::spawn(async move {
            release_input(&browser, &session, pressed).await;
            if let Some(inner) = inner.upgrade() {
                let gate = lock(&inner.state)
                    .tabs
                    .iter()
                    .find(|t| t.thread == thread && t.id == id)
                    .map(|t| t.action.clone());
                if let Some(gate) = gate {
                    let _gate = gate.lock().await;
                    let stop = {
                        let mut state = lock(&inner.state);
                        state
                            .tabs
                            .iter_mut()
                            .find(|t| t.thread == thread && t.id == id && t.viewers.is_empty())
                            .is_some_and(|t| t.cast.take().is_some())
                    };
                    if stop {
                        let _ = browser
                            .send("Page.stopScreencast", json!({}), Some(&session))
                            .await;
                    }
                }
            }
        });
    }
}
pub(super) fn control_message(tab: &Tab) -> Value {
    json!({"type":"control","canOperate":true,"controller":if tab.controller.is_some(){"another-viewer"}else if tab.owner.is_some(){"agent"}else{"unclaimed"},"generation":tab.generation,"dialog":tab.dialog})
}
/// The error of an attachment whose admission check said no under the tab's lock.
pub const ADMISSION_REFUSED: &str = "The viewer's access is paused or revoked.";

impl Preview {
    pub async fn attach_viewer(
        &self,
        thread: &str,
        id: &str,
        can_operate: bool,
        width: u64,
        height: u64,
        quality: u64,
    ) -> Result<Viewer, Error> {
        self.attach_viewer_checked(thread, id, can_operate, width, height, quality, &|| true)
            .await
    }

    /// [`Self::attach_viewer`], with `admit` asked again once the tab's lock is held and
    /// before any viewer state changes: a caller whose access was paused or revoked while it
    /// waited attaches nothing.
    #[expect(
        clippy::too_many_arguments,
        reason = "the viewer's options plus its admission check"
    )]
    pub async fn attach_viewer_checked(
        &self,
        thread: &str,
        id: &str,
        can_operate: bool,
        width: u64,
        height: u64,
        quality: u64,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Viewer, Error> {
        let gate = lock(&self.0.state)
            .tabs
            .iter()
            .find(|t| t.thread == thread && t.id == id)
            .map(|t| t.action.clone())
            .ok_or_else(|| Error("The server preview tab does not exist.".into()))?;
        let _gate = gate.lock().await;
        if !admit() {
            return Err(Error(ADMISSION_REFUSED.into()));
        }
        let viewer = conn_support::uuid_v4();
        let (browser, session, control, viewport, frames, start) = {
            let mut state = lock(&self.0.state);
            let tab = state
                .tabs
                .iter_mut()
                .find(|t| t.thread == thread && t.id == id)
                .ok_or_else(|| Error("The server preview tab does not exist.".into()))?;
            if tab.viewers.len() >= 8 {
                return Err(Error(
                    "Too many viewers are attached to this tab (8).".into(),
                ));
            }
            let start = tab.cast.is_none();
            // T3 captures once per viewer; sharing keeps Chromium's encoders bounded per tab.
            if start {
                tab.cast = Some(crate::screencast::Screencast::start(
                    tab.browser.clone(),
                    tab.session.clone(),
                )?);
            }
            let frames = tab
                .cast
                .as_ref()
                .ok_or_else(|| Error("The tab capture is missing.".into()))?
                .subscribe();
            tab.viewers.push(viewer.clone());
            (
                tab.browser.clone(),
                tab.session.clone(),
                tab.control.subscribe(),
                tab.viewport.clone(),
                frames,
                start,
            )
        };
        let mut result = Viewer {
            inner: Arc::downgrade(&self.0),
            thread: thread.into(),
            tab: id.into(),
            id: viewer,
            frames,
            browser,
            session,
            control,
            can_operate,
            first: Some(
                json!({"type":"viewport","width":viewport.get("width"),"height":viewport.get("height")}),
            ),
            still: None,
            pressed: Mutex::new(vec![]),
        };
        if start {
            result.browser.send("Page.startScreencast",json!({"format":"jpeg","quality":quality.clamp(1,100),"maxWidth":width.clamp(1,7680),"maxHeight":height.clamp(1,4320)}),Some(&result.session)).await?;
        }
        if let Ok(Ok(frame)) = tokio::time::timeout(
            Duration::from_secs(1),
            result.browser.send(
                "Page.captureScreenshot",
                json!({"format":"jpeg","quality":quality.clamp(1,100)}),
                Some(&result.session),
            ),
        )
        .await
        {
            result.still = frame
                .get("data")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 8 * 1024 * 1024)
                .map(str::to_owned);
        }
        {
            let mut state = lock(&self.0.state);
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|t| t.thread == thread && t.id == id)
            {
                if can_operate && tab.owner.is_none() && tab.controller.is_none() {
                    tab.controller = Some(result.id.clone());
                    tab.generation += 1;
                }
                let _ = tab.control.send(control_message(tab));
            }
        }
        Ok(result)
    }
}
impl Viewer {
    pub fn control(&self) -> Value {
        let mut value = self.control.borrow().clone();
        value["canOperate"] = json!(self.can_operate);
        if let Some(inner) = self.inner.upgrade()
            && lock(&inner.state)
                .tabs
                .iter()
                .find(|t| t.id == self.tab && t.thread == self.thread)
                .is_some_and(|t| t.controller.as_deref() == Some(&self.id))
        {
            value["controller"] = json!("you");
        }
        value
    }
    pub async fn next(&mut self) -> Result<Output, Error> {
        if let Some(first) = self.first.take() {
            return Ok(Output::Message(first));
        }
        if let Some(text) = self.still.take() {
            let bytes = tokio::task::spawn_blocking(move || conn_support::base64::decode(&text))
                .await
                .map_err(crate::err)?
                .ok_or_else(|| Error("The viewer frame is invalid.".into()))?;
            return Ok(Output::Frame(crate::screencast::Frame::still(bytes)));
        }
        loop {
            tokio::select! {
                            changed=self.control.changed()=>{if changed.is_err(){return Ok(Output::Closed);}
            if let Some(inner)=self.inner.upgrade()&& let Some(tab)=lock(&inner.state).tabs.iter().find(|t|t.thread==self.thread&&t.id==self.tab){self.first=Some(json!({"type":"viewport","width":tab.viewport.get("width"),"height":tab.viewport.get("height")}));}return Ok(Output::Message(self.control()));},
                            frame=self.frames.recv()=>{
                                let frame=match frame{Ok(frame)=>frame,Err(broadcast::error::RecvError::Lagged(_))=>continue,Err(_)=>return Ok(Output::Closed)};
                                return Ok(Output::Frame(frame));
                            }
                        }
        }
    }
    pub async fn input(&self, message: Value) -> Result<(), Error> {
        if !self.can_operate {
            return Ok(());
        }
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let inner = self
            .inner
            .upgrade()
            .ok_or_else(|| Error("The preview tab is closed.".into()))?;
        if matches!(kind, "takeControl" | "releaseControl") {
            {
                let mut state = lock(&inner.state);
                let tab = state
                    .tabs
                    .iter_mut()
                    .find(|t| t.thread == self.thread && t.id == self.tab)
                    .ok_or_else(|| Error("The preview tab is closed.".into()))?;
                if kind == "takeControl" {
                    tab.controller = Some(self.id.clone());
                } else if tab.controller.as_deref() == Some(&self.id) {
                    tab.controller = None;
                }
                tab.generation += 1;
                let _ = tab.control.send(control_message(tab));
            }
            let pressed = std::mem::take(&mut *lock(&self.pressed));
            release_input(&self.browser, &self.session, pressed).await;
            let _ = self
                .browser
                .send("Runtime.terminateExecution", json!({}), Some(&self.session))
                .await;
            let _ = self
                .browser
                .send("Page.stopLoading", json!({}), Some(&self.session))
                .await;
            let _ = crate::page::utility(
                &self.browser,
                &self.session,
                "globalThis.__connRefGeneration=null;return null;",
            )
            .await;
            return Ok(());
        }
        let owns = lock(&inner.state)
            .tabs
            .iter()
            .find(|t| t.thread == self.thread && t.id == self.tab)
            .is_some_and(|t| t.controller.as_deref() == Some(&self.id));
        if !owns {
            return Ok(());
        }
        let number = |field: &str, default: f64| {
            message
                .get(field)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .unwrap_or(default)
        };
        let modifiers = number("modifiers", 0.) as u64 & 15;
        let (method, params) = match kind {
            "mouse" => {
                let action = message
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                (
                    "Input.dispatchMouseEvent",
                    json!({"type":match action{"down"=>"mousePressed","up"=>"mouseReleased",_=>"mouseMoved"},"x":number("x",0.),"y":number("y",0.),"button":message.get("button").and_then(Value::as_str).unwrap_or("none"),"buttons":number("buttons",0.),"clickCount":number("clickCount",if action=="move"{0.}else{1.}),"modifiers":modifiers}),
                )
            }
            "wheel" => (
                "Input.dispatchMouseEvent",
                json!({"type":"mouseWheel","x":number("x",0.),"y":number("y",0.),"deltaX":number("deltaX",0.),"deltaY":number("deltaY",0.),"modifiers":modifiers}),
            ),
            "text" => (
                "Input.insertText",
                json!({"text":message.get("text").and_then(Value::as_str).unwrap_or_default().chars().take(10_000).collect::<String>()}),
            ),
            "key" => {
                let action = message
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut params = json!({"type":if action=="up"{"keyUp"}else if message.get("text").and_then(Value::as_str).is_some_and(|s|!s.is_empty()){"keyDown"}else{"rawKeyDown"},"key":message.get("key"),"code":message.get("code"),"text":message.get("text").and_then(Value::as_str).unwrap_or_default(),"windowsVirtualKeyCode":number("keyCode",0.),"modifiers":modifiers});
                if action != "up"
                    && let Some(command) = crate::spec::spec()?.editing_commands.get(&format!(
                        "{modifiers}:{}",
                        message
                            .get("key")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_ascii_lowercase()
                    ))
                {
                    params["commands"] = command.get("commands").cloned().unwrap_or(json!([]));
                }
                ("Input.dispatchKeyEvent", params)
            }
            "navigate" => (
                "Page.navigate",
                json!({"url":super::normalize_url(message.get("url").and_then(Value::as_str).unwrap_or_default())?}),
            ),
            "reload" => (
                "Page.reload",
                json!({"ignoreCache":message.get("ignoreCache").and_then(Value::as_bool).unwrap_or(false)}),
            ),
            "stopLoading" => ("Page.stopLoading", json!({})),
            "dialog" => (
                "Page.handleJavaScriptDialog",
                json!({"accept":message.get("accept").and_then(Value::as_bool).unwrap_or(false),"promptText":message.get("promptText").and_then(Value::as_str).unwrap_or_default()}),
            ),
            "resize" => {
                let width = number("width", 0.).round().min(3840.) as u64;
                let height = number("height", 0.).round().min(2160.) as u64;
                if width < 100 || height < 100 {
                    return Ok(());
                }
                let fill = {
                    let mut state = lock(&inner.state);
                    if let Some(tab) = state
                        .tabs
                        .iter_mut()
                        .find(|t| t.thread == self.thread && t.id == self.tab)
                    {
                        tab.fill_size = Some(json!({"width":width,"height":height}));
                        tab.snapshot
                            .pointer("/viewport/_tag")
                            .and_then(Value::as_str)
                            == Some("fill")
                    } else {
                        false
                    }
                };
                if fill {
                    self.browser.send("Emulation.setDeviceMetricsOverride",json!({"width":width,"height":height,"deviceScaleFactor":2,"mobile":false}),Some(&self.session)).await?;
                    if let Some(tab) = lock(&inner.state)
                        .tabs
                        .iter_mut()
                        .find(|t| t.thread == self.thread && t.id == self.tab)
                    {
                        tab.viewport = json!({"width":width,"height":height});
                        tab.used = Instant::now();
                        let _ = tab.control.send(control_message(tab));
                    }
                }
                return Ok(());
            }
            "viewport" => {
                Preview(inner)
                    .resize(
                        &self.thread,
                        &self.tab,
                        message
                            .get("setting")
                            .cloned()
                            .unwrap_or(json!({"_tag":"fill"})),
                    )
                    .await?;
                return Ok(());
            }
            "history" => {
                let history = self
                    .browser
                    .send("Page.getNavigationHistory", json!({}), Some(&self.session))
                    .await?;
                let index = history
                    .get("currentIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    + if number("delta", 0.) < 0. { -1 } else { 1 };
                let id = history
                    .get("entries")
                    .and_then(Value::as_array)
                    .and_then(|entries| usize::try_from(index).ok().and_then(|i| entries.get(i)))
                    .and_then(|entry| entry.get("id"))
                    .cloned();
                let Some(id) = id else {
                    return Ok(());
                };
                ("Page.navigateToHistoryEntry", json!({"entryId":id}))
            }
            _ => return Ok(()),
        };
        if matches!(kind, "key" | "mouse") {
            let mut pressed = lock(&self.pressed);
            let identity = if kind == "key" {
                message.get("code").or_else(|| message.get("key"))
            } else {
                message.get("button")
            };
            pressed.retain(|p| p.get("identity") != identity);
            if message.get("action").and_then(Value::as_str) == Some("down") && pressed.len() < 64 {
                pressed.push(json!({"identity":identity,"kind":kind,"params":params}));
            }
        }
        self.browser
            .send(method, params, Some(&self.session))
            .await?;
        Ok(())
    }
}

async fn release_input(browser: &Browser, session: &str, pressed: Vec<Value>) {
    for entry in pressed {
        let mut params = entry.get("params").cloned().unwrap_or(json!({}));
        let key = entry.get("kind").and_then(Value::as_str) == Some("key");
        params["type"] = json!(if key { "keyUp" } else { "mouseReleased" });
        params["buttons"] = json!(0);
        params["modifiers"] = json!(0);
        if let Some(fields) = params.as_object_mut() {
            fields.remove("text");
        }
        let _ = browser
            .send(
                if key {
                    "Input.dispatchKeyEvent"
                } else {
                    "Input.dispatchMouseEvent"
                },
                params,
                Some(session),
            )
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn viewers_share_one_capture_and_chrome_waits_for_client_ack() {
        let root =
            std::env::temp_dir().join(format!("conn-preview-cast-{}", conn_support::uuid_v4()));
        let preview = Preview::with_fixture(
            root.clone(),
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake-chrome.py"),
        );
        let opened = preview.invoke("t", "a", "open", json!({})).await.unwrap();
        let tab = opened["tabId"].as_str().unwrap();
        let mut first = preview
            .attach_viewer("t", tab, false, 1280, 800, 70)
            .await
            .unwrap();
        let second = preview
            .attach_viewer("t", tab, false, 1280, 800, 70)
            .await
            .unwrap();
        assert_eq!(
            first
                .browser
                .send("Fixture.counts", json!({}), None)
                .await
                .unwrap()["casts"],
            1
        );
        first.still = None;
        first.first = None;
        first
            .browser
            .send("Fixture.frame", json!({}), Some(&first.session))
            .await
            .unwrap();
        let frame = loop {
            if let Output::Frame(frame) = first.next().await.unwrap() {
                break frame;
            }
        };
        assert_eq!(
            first
                .browser
                .send("Fixture.counts", json!({}), None)
                .await
                .unwrap()["acks"],
            0
        );
        frame.ack().await;
        frame.ack().await;
        assert_eq!(
            first
                .browser
                .send("Fixture.counts", json!({}), None)
                .await
                .unwrap()["acks"],
            1
        );
        drop(frame);
        drop(first);
        drop(second);
        preview.shutdown().await;
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
