//! Short-lived HTML captures using T3's page interception and theme fragment.
use crate::{
    Browser, Error, Launch,
    install::{Installer, spec},
    proxy::Proxy,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, watch};

/// At most two captures, as in T3. No browser stays alive after a capture.
#[derive(Debug)]
pub struct HtmlPreview {
    installer: Arc<Installer>,
    slots: Semaphore,
}
impl HtmlPreview {
    pub fn new(base: PathBuf) -> Self {
        Self {
            installer: Arc::new(Installer::new(base)),
            slots: Semaphore::new(2),
        }
    }
    pub fn with_installer(installer: Arc<Installer>) -> Self {
        Self {
            installer,
            slots: Semaphore::new(2),
        }
    }
    pub async fn capture(
        &self,
        html: String,
        width: Option<u64>,
        appearance: &str,
    ) -> Result<Value, Error> {
        let _slot = self.slots.try_acquire().map_err(|_| {
            Error("Headless Chrome could not render the page: the preview queue is full.".into())
        })?;
        let executable = self.installer.executable().await?;
        self.capture_with(
            executable,
            html,
            width,
            appearance,
            std::env::var("T3CODE_SERVER_BROWSER_SANDBOX").as_deref() == Ok("0"),
        )
        .await
    }
    /// Runs a capture on an explicitly supplied fixture browser, without installation or host discovery.
    pub async fn capture_with(
        &self,
        executable: PathBuf,
        html: String,
        width: Option<u64>,
        appearance: &str,
        no_sandbox: bool,
    ) -> Result<Value, Error> {
        let spec = spec()?;
        let width = width.unwrap_or(spec.html.default_width).clamp(240, 1600);
        let fragment = spec
            .html
            .fragments
            .get(appearance)
            .ok_or_else(|| Error("Unknown HTML appearance.".into()))?
            .clone();
        let directory =
            std::env::temp_dir().join(format!("t3-html-preview-{}", conn_support::uuid_v4()));
        tokio::fs::create_dir(&directory)
            .await
            .map_err(crate::err)?;
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            capture(
                executable, html, width, appearance, &fragment, &directory, no_sandbox,
            ),
        )
        .await;
        let _ = tokio::fs::remove_dir_all(directory).await;
        result.unwrap_or_else(|_|Err(Error("Headless Chrome could not render the page: the page did not finish loading within 20 seconds.".into())))
    }
}

async fn capture(
    executable: PathBuf,
    html: String,
    width: u64,
    appearance: &str,
    fragment: &str,
    directory: &std::path::Path,
    no_sandbox: bool,
) -> Result<Value, Error> {
    let proxy = Proxy::start().await?;
    let mut args = vec![
        "--headless=new".into(),
        "--remote-debugging-pipe".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-gpu".into(),
        "--hide-scrollbars".into(),
        "--mute-audio".into(),
        "--block-new-web-contents".into(),
        format!("--proxy-server=socks5://127.0.0.1:{}", proxy.port),
        "--proxy-bypass-list=<-loopback>".into(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".into(),
    ];
    if no_sandbox {
        args.push("--no-sandbox".into());
    }
    args.push(format!(
        "--user-data-dir={}",
        directory.join("profile").display()
    ));
    args.push("about:blank".into());
    let browser = Browser::launch(Launch {
        executable,
        args,
        directory: directory.to_path_buf(),
    })
    .await?;
    let mut result = render(&browser, html, width, appearance, fragment).await;
    if let Ok(result) = &mut result
        && let Some(messages) = result
            .get_mut("consoleMessages")
            .and_then(Value::as_array_mut)
    {
        messages.extend(proxy.warnings());
    }
    let stderr = browser.stderr();
    browser.close().await;
    if result.is_err() && stderr.contains("No usable sandbox") {
        if rustix::process::getuid().is_root() {
            return Err(Error(spec()?.root_error));
        }
        return Err(Error("This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run `t3 browser setup` on the host once to allow it, then try again.".into()));
    }
    result
}

#[derive(Default, Debug)]
struct Console {
    messages: Vec<Value>,
    omitted: u64,
}

async fn render(
    browser: &Browser,
    html: String,
    width: u64,
    appearance: &str,
    fragment: &str,
) -> Result<Value, Error> {
    let context = browser
        .send("Target.createBrowserContext", json!({}), None)
        .await?;
    let context = context
        .get("browserContextId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("Chrome returned no context.".into()))?;
    let target = browser
        .send(
            "Target.createTarget",
            json!({"url":"about:blank","browserContextId":context}),
            None,
        )
        .await?;
    let target = target
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error("Chrome returned no target.".into()))?
        .to_owned();
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
        .ok_or_else(|| Error("Chrome returned no session.".into()))?
        .to_owned();
    let mut events = browser.events();
    let (loaded, mut loading) = watch::channel(false);
    let console = Arc::new(Mutex::new(Console::default()));
    let entries = console.clone();
    let cdp = browser.clone();
    let event_session = session.clone();
    let body = tokio::task::spawn_blocking(move || conn_support::base64::encode(html.as_bytes()))
        .await
        .map_err(crate::err)?;
    let handler = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if event.get("sessionId").and_then(Value::as_str) != Some(&event_session) {
                continue;
            }
            let method = event
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let params = event.get("params").unwrap_or(&Value::Null);
            if method == "Page.loadEventFired" {
                let _ = loaded.send(true);
            } else if method == "Fetch.requestPaused" {
                let url = params
                    .pointer("/request/url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .split('#')
                    .next()
                    .unwrap_or_default();
                let request = params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let command = if url == "http://t3-page.localhost/page.html" {
                    (
                        "Fetch.fulfillRequest",
                        json!({"requestId":request,"responseCode":200,"responseHeaders":[{"name":"Content-Type","value":"text/html; charset=utf-8"}],"body":body}),
                    )
                } else if params.get("resourceType").and_then(Value::as_str) == Some("Document")
                    && params.get("frameId").and_then(Value::as_str) != Some(&target)
                    && !url.starts_with("http://t3-page.localhost/")
                {
                    ("Fetch.continueRequest", json!({"requestId":request}))
                } else {
                    (
                        "Fetch.failRequest",
                        json!({"requestId":request,"errorReason":"AccessDenied"}),
                    )
                };
                let _ = cdp.send(command.0, command.1, Some(&event_session)).await;
            } else if let Some(message) = console_message(method, params)
                && let Ok(mut entries) = entries.lock()
            {
                if entries.messages.len() < 20 {
                    entries.messages.push(message);
                } else {
                    entries.omitted += 1;
                }
            }
        }
    });
    struct Cancel(tokio::task::JoinHandle<()>);
    impl Drop for Cancel {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _cancel = Cancel(handler);
    let send = |method: &'static str, params: Value| browser.send(method, params, Some(&session));
    for method in ["Page.enable", "Runtime.enable", "Log.enable"] {
        send(method, json!({})).await?;
    }
    send(
        "Emulation.setEmulatedMedia",
        json!({"features":[{"name":"prefers-color-scheme","value":appearance}]}),
    )
    .await?;
    send("Page.addScriptToEvaluateOnNewDocument",json!({"source":"delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;","runImmediately":true})).await?;
    send("Fetch.enable",json!({"patterns":[{"urlPattern":"http://t3-page.localhost/*"},{"urlPattern":"*","resourceType":"Document"}]})).await?;
    send(
        "Emulation.setDeviceMetricsOverride",
        json!({"width":width,"height":800,"deviceScaleFactor":1,"mobile":false}),
    )
    .await?;
    let navigation = send(
        "Page.navigate",
        json!({"url":format!("http://t3-page.localhost/page.html{fragment}")}),
    )
    .await?;
    if navigation.get("errorText").is_some() {
        return Err(Error(
            "Headless Chrome could not render the page: the page could not be opened.".into(),
        ));
    }
    while !*loading.borrow() {
        loading.changed().await.map_err(crate::err)?;
    }
    let spec = spec()?;
    send(
        "Runtime.evaluate",
        json!({"expression":spec.html.settle,"awaitPromise":true}),
    )
    .await?;
    let measured = send(
        "Runtime.evaluate",
        json!({"expression":spec.html.measure,"returnByValue":true}),
    )
    .await?;
    let height = measured
        .pointer("/result/value")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| Error("Chrome returned no page height.".into()))?
        .ceil()
        .max(0.) as u64;
    let captured = height.clamp(1, 4000);
    let png=send("Page.captureScreenshot",json!({"format":"png","captureBeyondViewport":true,"clip":{"x":0,"y":0,"width":width,"height":captured,"scale":1}})).await?;
    let messages=console.lock().map(|c|{let mut messages=c.messages.clone();if c.omitted>0{messages.push(json!({"level":"warning","text":format!("{} more console messages were omitted.",c.omitted)}));}messages}).unwrap_or_default();
    Ok(
        json!({"width":width,"contentHeight":height,"capturedHeight":captured,"consoleMessages":messages,"screenshot":{"mimeType":"image/png","data":png.get("data").and_then(Value::as_str).ok_or_else(||Error("Chrome returned no screenshot.".into()))?,"width":width,"height":captured}}),
    )
}

pub(crate) fn console_message(method: &str, params: &Value) -> Option<Value> {
    let (level, text) = match method {
        "Runtime.consoleAPICalled" => {
            let level = match params.get("type")?.as_str()? {
                "log" | "debug" | "dir" | "dirxml" | "table" | "trace" => "log",
                "info" => "info",
                "warning" => "warning",
                "error" | "assert" => "error",
                _ => return None,
            };
            let text = params
                .get("args")?
                .as_array()?
                .iter()
                .map(|arg| {
                    arg.get("value")
                        .and_then(Value::as_str)
                        .or_else(|| arg.get("description").and_then(Value::as_str))
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            arg.get("value").map(Value::to_string).unwrap_or_else(|| {
                                arg.get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned()
                            })
                        })
                })
                .collect::<Vec<_>>()
                .join(" ");
            (level, text)
        }
        "Runtime.exceptionThrown" => {
            let details = params.get("exceptionDetails")?;
            (
                "error",
                details
                    .pointer("/exception/description")
                    .or_else(|| details.get("text"))?
                    .as_str()?
                    .into(),
            )
        }
        "Log.entryAdded" => {
            let entry = params.get("entry")?;
            let level = entry.get("level")?.as_str()?;
            if !matches!(level, "error" | "warning") {
                return None;
            }
            let mut text = entry.get("text")?.as_str()?.to_owned();
            if let Some(url) = entry.get("url").and_then(Value::as_str) {
                text.push(' ');
                text.push_str(url);
            }
            (level, text)
        }
        _ => return None,
    };
    let text = text.replace("http://t3-page.localhost/page.html", "page.html");
    let mut length = 0;
    let mut clipped = String::new();
    for c in text.chars() {
        length += c.len_utf16();
        if length > 500 {
            clipped.push('…');
            break;
        }
        clipped.push(c);
    }
    Some(json!({"level":level,"text":clipped}))
}
