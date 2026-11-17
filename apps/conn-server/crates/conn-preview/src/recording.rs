//! A bounded MediaRecorder in a separate renderer, using T3's pinned encoder script.
use crate::{Browser, Error, spec::spec};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::sync::{OwnedSemaphorePermit, oneshot};

#[derive(Debug)]
pub(crate) struct Recording {
    browser: Browser,
    pub session: String,
    context: String,
    css_width: f64,
    pub encoder: String,
    stop: Option<oneshot::Sender<()>>,
    pump: Option<tokio::task::JoinHandle<()>>,
    pub started: String,
    _slot: OwnedSemaphorePermit,
}
impl Drop for Recording {
    fn drop(&mut self) {
        if let Some(pump) = self.pump.take() {
            pump.abort();
        }
        let (browser, context, session) = (
            self.browser.clone(),
            self.context.clone(),
            self.session.clone(),
        );
        tokio::spawn(async move {
            let _ = browser
                .send("Page.stopScreencast", json!({}), Some(&session))
                .await;
            let _ = browser
                .send(
                    "Target.detachFromTarget",
                    json!({"sessionId":session}),
                    None,
                )
                .await;
            let _ = browser
                .send(
                    "Target.disposeBrowserContext",
                    json!({"browserContextId":context}),
                    None,
                )
                .await;
        });
    }
}

impl Recording {
    pub(crate) async fn start(
        browser: Browser,
        target: &str,
        slot: OwnedSemaphorePermit,
        rate: u64,
    ) -> Result<Self, Error> {
        let context = browser
            .send(
                "Target.createBrowserContext",
                json!({"disposeOnDetach":true}),
                None,
            )
            .await?;
        let context = context
            .get("browserContextId")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("The recorder context is missing.".into()))?
            .to_owned();
        let result = start_in(browser.clone(), target, context.clone(), slot, rate).await;
        if result.is_err() {
            let _ = browser
                .send(
                    "Target.disposeBrowserContext",
                    json!({"browserContextId":context}),
                    None,
                )
                .await;
        }
        result
    }
    pub(crate) async fn discard(mut self) {
        self.stop_pump().await;
        let _ = self
            .browser
            .send(
                "Target.disposeBrowserContext",
                json!({"browserContextId":self.context}),
                None,
            )
            .await;
    }
    async fn stop_pump(&mut self) {
        let _ = self
            .browser
            .send("Page.stopScreencast", json!({}), Some(&self.session))
            .await;
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(pump) = self.pump.take() {
            let mut pump = pump;
            if tokio::time::timeout(Duration::from_secs(10), &mut pump)
                .await
                .is_err()
            {
                pump.abort();
            }
        }
    }
    pub(crate) async fn finish(
        mut self,
        thread: &str,
        tab: &str,
        state: &Path,
    ) -> Result<Value, Error> {
        self.stop_pump().await;
        if let Ok(frame) = self
            .browser
            .send(
                "Page.captureScreenshot",
                json!({"format":"jpeg","quality":90}),
                Some(&self.session),
            )
            .await
            && let Some(data) = frame.get("data").and_then(Value::as_str)
        {
            let _ = eval(
                &self.browser,
                &self.encoder,
                &format!(
                    "globalThis.__t3Recorder.frame({},{})",
                    json!(data),
                    self.css_width
                ),
            )
            .await;
        }
        let result =
            tokio::time::timeout(Duration::from_secs(120), self.export(thread, tab, state))
                .await
                .map_err(|_| Error("Preview recording stop timed out after 120000ms.".into()))?;
        let _ = self
            .browser
            .send(
                "Target.disposeBrowserContext",
                json!({"browserContextId":self.context}),
                None,
            )
            .await;
        result
    }
    async fn export(&self, thread: &str, tab: &str, state: &Path) -> Result<Value, Error> {
        use tokio::io::AsyncWriteExt;
        let info = eval(
            &self.browser,
            &self.encoder,
            "globalThis.__t3Recorder.stop()",
        )
        .await?;
        let bytes = info.get("bytes").and_then(Value::as_u64).unwrap_or(0);
        if bytes > 50 * 1024 * 1024 {
            return Err(Error(
                "The recording exceeds 50 MiB. Make a shorter recording.".into(),
            ));
        }
        let mime = info
            .get("mimeType")
            .and_then(Value::as_str)
            .ok_or_else(|| Error("The recording captured no frames.".into()))?;
        let count = info
            .get("count")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 3600)
            .ok_or_else(|| Error("The recording has too many chunks.".into()))?;
        if bytes == 0 {
            return Err(Error("The recording captured no frames.".into()));
        }
        let extension = if mime.starts_with("video/mp4") {
            "mp4"
        } else {
            "webm"
        };
        let segment = conn_files::attachments::thread_segment(thread).ok_or_else(|| {
            Error("Preview recording could not be saved to the agent environment.".into())
        })?;
        let id = format!("{segment}-{}-{extension}", conn_support::uuid_v4());
        let directory = state.join("attachments");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(crate::err)?;
        let path = directory.join(format!("{id}.{extension}"));
        let staging = path.with_extension("partial");
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .await
            .map_err(crate::err)?;
        let result = async {
            let mut written = 0u64;
            for index in 0..count {
                let chunk = eval(
                    &self.browser,
                    &self.encoder,
                    &format!("globalThis.__t3Recorder.chunk({index})"),
                )
                .await?;
                let text = chunk
                    .as_str()
                    .filter(|s| s.len() <= 12 * 1024 * 1024)
                    .ok_or_else(|| Error("The recording chunk is too large.".into()))?
                    .to_owned();
                let chunk =
                    tokio::task::spawn_blocking(move || conn_support::base64::decode(&text))
                        .await
                        .map_err(crate::err)?
                        .ok_or_else(|| Error("The recording transfer is incomplete.".into()))?;
                written += chunk.len() as u64;
                if written > bytes {
                    return Err(Error("The recording transfer is incomplete.".into()));
                }
                output.write_all(&chunk).await.map_err(crate::err)?;
            }
            if written != bytes {
                return Err(Error("The recording transfer is incomplete.".into()));
            }
            output.flush().await.map_err(crate::err)?;
            drop(output);
            tokio::fs::rename(&staging, &path).await.map_err(crate::err)
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&staging).await;
        }
        result?;
        Ok(
            json!({"id":id,"tabId":tab,"path":path,"mimeType":mime.split(';').next().unwrap_or(mime),"sizeBytes":bytes,"createdAt":conn_support::time::iso_from_ms(conn_support::time::now_ms())}),
        )
    }
}
async fn start_in(
    browser: Browser,
    target: &str,
    context: String,
    slot: OwnedSemaphorePermit,
    rate: u64,
) -> Result<Recording, Error> {
    let encoder = browser
        .send(
            "Target.createTarget",
            json!({"url":"about:blank","browserContextId":context}),
            None,
        )
        .await?;
    let encoder = encoder
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("The recorder page is missing.".into()))?;
    let attached = browser
        .send(
            "Target.attachToTarget",
            json!({"targetId":encoder,"flatten":true}),
            None,
        )
        .await?;
    let encoder = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("The recorder session is missing.".into()))?
        .to_owned();
    eval(
        &browser,
        &encoder,
        spec()?
            .scripts
            .recorders
            .get(&rate.to_string())
            .ok_or_else(|| Error("Unsupported recording frame rate.".into()))?,
    )
    .await?;
    let attached = browser
        .send(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            None,
        )
        .await?;
    let session = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("The recorder capture session is missing.".into()))?
        .to_owned();
    let first = browser
        .send(
            "Page.captureScreenshot",
            json!({"format":"jpeg","quality":90}),
            Some(&session),
        )
        .await?;
    let data = first
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("The recorder captured no frame.".into()))?;
    let metrics = browser
        .send("Page.getLayoutMetrics", json!({}), Some(&session))
        .await?;
    let width = metrics
        .pointer("/cssVisualViewport/clientWidth")
        .and_then(Value::as_f64)
        .unwrap_or(1280.);
    eval(
        &browser,
        &encoder,
        &format!("globalThis.__t3Recorder.frame({},{width})", json!(data)),
    )
    .await?;
    let (mut frames, cdp, encoding, source) = (
        browser.frames(&session)?,
        browser.clone(),
        encoder.clone(),
        session.clone(),
    );
    browser
        .send(
            "Page.startScreencast",
            json!({"format":"jpeg","quality":90,"everyNthFrame":1}),
            Some(&session),
        )
        .await?;
    let (stop, mut stopped) = oneshot::channel();
    let pump = tokio::spawn(async move {
        let deadline = tokio::time::sleep(Duration::from_secs(5 * 60));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _=&mut stopped=>break,
                ()=&mut deadline=>{let _=cdp.send("Page.stopScreencast",json!({}),Some(&source)).await;let _=eval(&cdp,&encoding,"globalThis.__t3Recorder.stop()").await;break;},
                frame=frames.recv()=>{
                    let Some(frame)=frame else {break;};
                    let _=cdp.send("Page.screencastFrameAck", json!({"sessionId":frame.pointer("/params/sessionId")}), Some(&source)).await;
                    if let Some(data)=frame.pointer("/params/data").and_then(Value::as_str){let accepted=eval(&cdp,&encoding,&format!("globalThis.__t3Recorder.frame({},{width})",json!(data))).await;if accepted.as_ref().ok().and_then(Value::as_bool)==Some(false){let _=cdp.send("Page.stopScreencast",json!({}),Some(&source)).await;break;}}
                }
            }
        }
    });
    Ok(Recording {
        browser,
        session,
        context,
        encoder,
        stop: Some(stop),
        pump: Some(pump),
        started: conn_support::time::iso_from_ms(conn_support::time::now_ms()),
        _slot: slot,
        css_width: width,
    })
}
async fn eval(browser: &Browser, session: &str, expression: &str) -> Result<Value, Error> {
    let result = browser
        .send(
            "Runtime.evaluate",
            json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
            Some(session),
        )
        .await?;
    if result.get("exceptionDetails").is_some() {
        return Err(Error("The recording encoder failed.".into()));
    }
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Null))
}
