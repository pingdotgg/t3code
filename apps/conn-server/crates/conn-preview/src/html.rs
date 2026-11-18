//! Short-lived HTML captures using T3's page interception and theme fragment.
use crate::{Browser, Error, Launch, install::Installer, proxy::Proxy, spec::spec};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, watch};

/// Capture concurrency follows T3. No browser stays alive after a capture.
#[derive(Clone, Debug)]
pub struct HtmlPreview {
    installer: Arc<Installer>,
    slots: Arc<Semaphore>,
}
impl HtmlPreview {
    pub fn new(base: PathBuf) -> Self {
        Self::with_installer(Arc::new(Installer::new(base)))
    }
    pub fn with_installer(installer: Arc<Installer>) -> Self {
        Self {
            installer,
            slots: Arc::new(Semaphore::new(
                spec()
                    .map(|s| s.html.max_concurrent_browsers)
                    .unwrap_or_default(),
            )),
        }
    }
    pub fn reserve(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        self.slots.clone().try_acquire_owned().map_err(|_| {
            Error("Headless Chrome could not render the page: the preview queue is full.".into())
        })
    }
    pub async fn capture(
        &self,
        slot: tokio::sync::OwnedSemaphorePermit,
        html: String,
        width: Option<u64>,
        appearance: &str,
    ) -> Result<Value, Error> {
        let preview = self.clone();
        let appearance = appearance.to_owned();
        tokio::spawn(async move {
            let _slot = slot;
            let executable = preview.installer.executable().await?;
            preview
                .capture_with(
                    executable,
                    html,
                    width,
                    &appearance,
                    std::env::var("T3CODE_SERVER_BROWSER_SANDBOX").as_deref() == Ok("0"),
                )
                .await
        })
        .await
        .map_err(crate::err)?
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
        self.capture_with_timeout(
            executable,
            html,
            width,
            appearance,
            no_sandbox,
            Duration::from_secs(20),
        )
        .await
    }
    async fn capture_with_timeout(
        &self,
        executable: PathBuf,
        html: String,
        width: Option<u64>,
        appearance: &str,
        no_sandbox: bool,
        timeout: Duration,
    ) -> Result<Value, Error> {
        let spec = spec()?;
        let width = width.unwrap_or(spec.html.default_width).clamp(240, 1600);
        let directory =
            std::env::temp_dir().join(format!("t3-html-preview-{}", conn_support::uuid_v4()));
        tokio::fs::create_dir(&directory)
            .await
            .map_err(crate::err)?;
        let result = capture(
            executable, html, width, appearance, &directory, no_sandbox, timeout,
        )
        .await;
        let _ = tokio::fs::remove_dir_all(directory).await;
        result
    }
}

async fn capture(
    executable: PathBuf,
    html: String,
    width: u64,
    appearance: &str,
    directory: &std::path::Path,
    no_sandbox: bool,
    timeout: Duration,
) -> Result<Value, Error> {
    let deadline = tokio::time::Instant::now() + timeout;
    let fragment = spec()?
        .html
        .fragments
        .get(appearance)
        .ok_or_else(|| Error("Unknown HTML appearance.".into()))?;
    let proxy = Proxy::start().await?;
    let args = if no_sandbox {
        &spec()?.html.unsandboxed_args
    } else {
        &spec()?.html.args
    }
    .iter()
    .map(|arg| {
        arg.replace("__PROXY_PORT__", &proxy.port.to_string())
            .replace("__PROFILE__", &directory.join("profile").to_string_lossy())
    })
    .collect();
    let browser = Browser::launch_with_timeout(
        Launch {
            executable,
            args,
            directory: directory.to_path_buf(),
        },
        deadline.saturating_duration_since(tokio::time::Instant::now()),
    )
    .await
    .map_err(|error| {
        if error.0 == "The browser command timed out." {
            capture_timeout()
        } else {
            error
        }
    })?;
    let mut result = tokio::time::timeout_at(
        deadline,
        render(&browser, html, width, appearance, fragment),
    )
    .await
    .unwrap_or_else(|_| Err(capture_timeout()));
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
            return Err(Error(spec()?.root_error.clone()));
        }
        return Err(Error("This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run `t3 browser setup` on the host once to allow it, then try again.".into()));
    }
    result
}

fn capture_timeout() -> Error {
    Error("Headless Chrome could not render the page: the page did not finish loading within 20 seconds.".into())
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
    browser.deny_downloads(Some(context)).await?;
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
    let prefix = conn_support::text::utf16_prefix(&text, 500);
    let clipped = if prefix.len() < text.len() {
        format!("{prefix}…")
    } else {
        text
    };
    Some(json!({"level":level,"text":clipped}))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn a_capture_timeout_waits_for_chrome_to_die_before_returning() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("conn-html-timeout-{}", conn_support::uuid_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let pid_file = root.join("pid");
        let script = format!(
            "#!/usr/bin/python3 -B\nimport os,json,signal\nopen({},'w').write(str(os.getpid()))\nr=os.fdopen(3,'rb',buffering=0);w=os.fdopen(4,'wb',buffering=0)\nwhile True:\n data=bytearray()\n while True:\n  c=r.read(1)\n  if not c: signal.pause()\n  if c==b'\\0': break\n  data.extend(c)\n q=json.loads(data)\n if q['method']=='Browser.getVersion': w.write(json.dumps({{'id':q['id'],'result':{{}}}}).encode()+b'\\0')\n",
            serde_json::to_string(&pid_file).unwrap()
        );
        let executable = root.join("chrome");
        tokio::fs::write(&executable, script).await.unwrap();
        tokio::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let preview = HtmlPreview::new(root.clone());
        let error = preview
            .capture_with_timeout(
                executable,
                "<p>Fixture</p>".into(),
                None,
                "dark",
                false,
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
        assert!(error.0.contains("did not finish loading"));
        let pid = tokio::fs::read_to_string(pid_file).await.unwrap();
        assert!(!tokio::fs::try_exists(format!("/proc/{pid}")).await.unwrap());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
