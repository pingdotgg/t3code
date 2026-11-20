//! Bounded Chrome DevTools pipe transport. See README.md for the T3 boundary.
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

pub mod html;
pub mod install;
mod page;
pub use page::credential_field_expression;
mod proxy;
mod recording;
mod screencast;
mod spec;
pub mod tabs;

use command_fds::{CommandFdExt, FdMapping};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc, oneshot},
};

/// A screenshot can be large, but a renderer must not grow the server without limit.
const MAX_MESSAGE_BYTES: usize = 36 * 1024 * 1024;
/// Bound callers waiting on Chrome as well as responses Chrome has not sent yet.
const MAX_PENDING: usize = 16;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// A browser or transport failure, without page data or process environment.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub String);

/// Launch parameters. The owner supplies T3's pinned executable and flags.
#[derive(Debug)]
pub struct Launch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub directory: PathBuf,
}

#[derive(Debug)]
struct Request {
    method: String,
    params: Value,
    session: Option<String>,
    reply: oneshot::Sender<Result<Value, Error>>,
}

/// One Chrome process, started only when requested. Dropping all handles stops it.
#[derive(Debug, Clone)]
pub struct Browser {
    tx: mpsc::Sender<Request>,
    events: broadcast::Sender<Value>,
    frames: Arc<std::sync::Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    stderr: Arc<std::sync::Mutex<String>>,
    shutdown: Arc<tokio::sync::Notify>,
    stopped: tokio::sync::watch::Receiver<bool>,
}

impl Browser {
    /// Starts the executable with CDP on fd 3 and 4, as T3 launches Chrome.
    pub async fn launch(input: Launch) -> Result<Self, Error> {
        Self::launch_with_timeout(input, COMMAND_TIMEOUT).await
    }
    pub(crate) async fn launch_with_timeout(
        input: Launch,
        timeout: Duration,
    ) -> Result<Self, Error> {
        let deadline = tokio::time::Instant::now() + timeout;
        let (parent, child) = tokio::task::spawn_blocking(std::os::unix::net::UnixStream::pair)
            .await
            .map_err(err)?
            .map_err(err)?;
        parent.set_nonblocking(true).map_err(err)?;
        let stream = tokio::net::UnixStream::from_std(parent).map_err(err)?;
        let duplicate = child.try_clone().map_err(err)?;
        let mut command = tokio::process::Command::new(&input.executable);
        command
            .args(&input.args)
            .current_dir(&input.directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command.process_group(0);
        command
            .fd_mappings(vec![
                FdMapping {
                    parent_fd: child.into(),
                    child_fd: 3,
                },
                FdMapping {
                    parent_fd: duplicate.into(),
                    child_fd: 4,
                },
            ])
            .map_err(err)?;
        let mut child = tokio::task::spawn_blocking(move || command.spawn())
            .await
            .map_err(err)?
            .map_err(err)?;
        let stderr = Arc::new(std::sync::Mutex::new(String::new()));
        let tail = stderr.clone();
        let output = child
            .stderr
            .take()
            .ok_or_else(|| Error("Chrome has no stderr pipe.".into()))?;
        let stderr_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut reader = output;
            let mut bytes = [0; 1024];
            while let Ok(n) = reader.read(&mut bytes).await {
                if n == 0 {
                    break;
                }
                if let Ok(mut tail) = tail.lock() {
                    tail.push_str(&String::from_utf8_lossy(bytes.get(..n).unwrap_or_default()));
                    if tail.len() > 2048 {
                        let at = tail
                            .char_indices()
                            .find(|(i, _)| *i >= tail.len() - 2048)
                            .map_or(tail.len(), |(i, _)| i);
                        tail.drain(..at);
                    }
                }
            }
        });
        let (tx, rx) = mpsc::channel(MAX_PENDING);
        let (events, _) = broadcast::channel(64);
        let notify = events.clone();
        let frames = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let frame_output = frames.clone();
        let shutdown = Arc::new(tokio::sync::Notify::new());
        let ending = shutdown.clone();
        let (stopped_tx, stopped) = tokio::sync::watch::channel(false);
        tokio::spawn(async move {
            tokio::select! {()=run(stream, rx, notify,frame_output)=>{},()=ending.notified()=>{}}
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
            if let Some(pid) = child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .and_then(rustix::process::Pid::from_raw)
            {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            let mut stderr_task = stderr_task;
            if tokio::time::timeout(Duration::from_secs(1), &mut stderr_task)
                .await
                .is_err()
            {
                stderr_task.abort();
            }
            let _ = stopped_tx.send(true);
        });
        let browser = Self {
            tx,
            events,
            frames,
            stderr,
            shutdown,
            stopped,
        };
        let ready = tokio::time::timeout_at(
            deadline,
            browser.send("Browser.getVersion", json!({}), None),
        )
        .await
        .unwrap_or_else(|_| Err(Error("The browser command timed out.".into())));
        if let Err(error) = ready {
            browser.close().await;
            let stderr = browser.stderr();
            if stderr.contains("Running as root without --no-sandbox")
                || (stderr.contains("No usable sandbox") && rustix::process::getuid().is_root())
            {
                return Err(Error(spec::spec()?.root_error.clone()));
            }
            if stderr.contains("No usable sandbox") {
                return Err(Error("This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run `t3 browser setup` on the host once to allow it, then try again.".into()));
            }
            if let Some(library) = stderr
                .split_once("error while loading shared libraries: ")
                .and_then(|(_, rest)| rest.split(':').next())
                .filter(|s| !s.is_empty() && s.len() < 256)
            {
                return Err(Error(format!(
                    "This host is missing libraries T3's browser needs ({library}). Run `t3 browser setup` on the host to install them, then try again."
                )));
            }
            return Err(error);
        }
        Ok(browser)
    }

    pub(crate) async fn deny_downloads(&self, context: Option<&str>) -> Result<(), Error> {
        // T3 saves tab downloads; until that path is served, deny them to prevent unbounded files.
        let mut params = json!({"behavior":"deny"});
        if let Some(context) = context {
            params["browserContextId"] = json!(context);
        }
        self.send("Browser.setDownloadBehavior", params, None)
            .await?;
        Ok(())
    }

    /// Sends one bounded command. The response deadline includes queue time.
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, Error> {
        let (reply, received) = oneshot::channel();
        let request = Request {
            method: method.into(),
            params,
            session: session.map(str::to_owned),
            reply,
        };
        tokio::time::timeout(COMMAND_TIMEOUT, async {
            if method == "Page.screencastFrameAck" {
                // Chrome permits only three outstanding frames per capture, bounding ack waiters.
                self.tx
                    .send(request)
                    .await
                    .map_err(|_| Error("The browser disconnected.".into()))?;
            } else {
                self.tx
                    .try_send(request)
                    .map_err(|_| Error("The browser command queue is full or closed.".into()))?;
            }
            received
                .await
                .map_err(|_| Error("The browser disconnected.".into()))?
        })
        .await
        .map_err(|_| Error("The browser command timed out.".into()))?
    }

    /// Subscribes before an operation so its milestone cannot be missed.
    pub fn events(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    pub(crate) fn frames(&self, session: &str) -> Result<screencast::Frames, Error> {
        screencast::Frames::new(self.frames.clone(), session)
    }
    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    pub fn stderr(&self) -> String {
        self.stderr
            .lock()
            .map(|tail| tail.clone())
            .unwrap_or_default()
    }

    /// Requests orderly shutdown. Process ownership still kills a browser that stays up.
    pub async fn close(&self) {
        let mut stopped = self.stopped.clone();
        if *stopped.borrow() {
            return;
        }
        let graceful = tokio::time::timeout(Duration::from_secs(2), async {
            let _ = self.send("Browser.close", json!({}), None).await;
            while !*stopped.borrow() {
                if stopped.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        if graceful.is_err() {
            self.shutdown.notify_one();
            while !*stopped.borrow() {
                if stopped.changed().await.is_err() {
                    break;
                }
            }
        }
    }
}

fn err(error: impl std::fmt::Display) -> Error {
    Error(error.to_string())
}

async fn run(
    stream: tokio::net::UnixStream,
    mut rx: mpsc::Receiver<Request>,
    events: broadcast::Sender<Value>,
    frames: Arc<std::sync::Mutex<HashMap<String, mpsc::Sender<Value>>>>,
) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut pending = HashMap::<u64, oneshot::Sender<Result<Value, Error>>>::new();
    let budget = Arc::new(tokio::sync::Semaphore::new(40));
    let mut pages = HashMap::<String, tokio::sync::OwnedSemaphorePermit>::new();
    let mut id = 0u64;
    let mut buffer = Vec::new();
    loop {
        tokio::select! {
            request = rx.recv() => {
                let Some(request) = request else {
                    let _ = writer.write_all(b"{\"id\":0,\"method\":\"Browser.close\"}\0").await;
                    break;
                };
                pending.retain(|_, reply| !reply.is_closed());
                let ack = request.method == "Page.screencastFrameAck";
                if !ack && pending.len() >= MAX_PENDING {
                    let _ = request.reply.send(Err(Error("Too many browser commands are pending.".into())));
                    continue;
                }
                id = id.wrapping_add(1);
                let mut message=json!({"id":id,"method":request.method,"params":request.params});
                if let Some(session)=request.session{message["sessionId"]=json!(session);}
                let mut bytes = match tokio::task::spawn_blocking(move||serde_json::to_vec(&message)).await {
                    Ok(Ok(bytes)) if bytes.len() <= MAX_MESSAGE_BYTES => bytes,
                    _ => { let _ = request.reply.send(Err(Error("The browser command is too large.".into()))); continue; }
                };
                bytes.push(0);
                let acknowledged = if ack { Some(request.reply) } else { pending.insert(id, request.reply); None };
                if !matches!(tokio::time::timeout(Duration::from_secs(20),writer.write_all(&bytes)).await,Ok(Ok(()))) { break; }
                if let Some(reply) = acknowledged { let _ = reply.send(Ok(Value::Null)); }
            }
            chunk = reader.fill_buf() => {
                let Ok(chunk) = chunk else { break; };
                if chunk.is_empty() { break; }
                let n = chunk.iter().position(|b| *b == 0).map_or(chunk.len(), |at| at + 1);
                if buffer.len().saturating_add(n) > MAX_MESSAGE_BYTES { break; }
                buffer.extend_from_slice(chunk.get(..n).unwrap_or_default());
                reader.consume(n);
                if buffer.last() != Some(&0) { continue; }
                buffer.pop();
                let size=buffer.len();
                let incoming=std::mem::take(&mut buffer);
                let parsed=tokio::task::spawn_blocking(move||{let result=serde_json::from_slice::<Value>(&incoming);(result,incoming)}).await;
                let mut message=match parsed{Ok((Ok(message),mut incoming))=>{incoming.clear();buffer=if incoming.capacity()>1024*1024 {Vec::new()}else{incoming};message},_=>break};
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(reply) = pending.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(Error(error.get("message").and_then(Value::as_str).unwrap_or("Chrome rejected the command.").into()))
                        } else { Ok(message.as_object_mut().and_then(|m|m.remove("result")).unwrap_or(Value::Null)) };
                        let _ = reply.send(result);
                    }
                } else if message.get("method").and_then(Value::as_str)==Some("Target.targetCreated") {
                    if message.pointer("/params/targetInfo/type").and_then(Value::as_str)==Some("page")
                        && let Some(target)=message.pointer("/params/targetInfo/targetId").and_then(Value::as_str).filter(|t|t.len()<=256)
                            && !pages.contains_key(target) {
                                if let Ok(permit) = budget.clone().try_acquire_owned(){pages.insert(target.into(), permit);}
                                else{id=id.wrapping_add(1);let close=json!({"id":id,"method":"Target.closeTarget","params":{"targetId":target}});if let Ok(mut bytes)=serde_json::to_vec(&close){bytes.push(0);let _=writer.write_all(&bytes).await;}continue;}
                            }
                    if size<=64*1024{let _=events.send(message);}
                } else if message.get("method").and_then(Value::as_str)==Some("Target.targetDestroyed") {
                    if let Some(target) = message.pointer("/params/targetId").and_then(Value::as_str) { pages.remove(target); }
                    let _=events.send(message);
                } else if message.get("method").and_then(Value::as_str)==Some("Page.screencastFrame") {
                    let route = message.get("sessionId").and_then(Value::as_str).and_then(|session| {
                        frames.lock().ok()?.get(session).cloned()
                    });
                    let valid = message.pointer("/params/data").and_then(Value::as_str).is_some_and(|d| d.len() <= 8*1024*1024);
                    let unqueued = if let Some(tx) = route.filter(|_| valid) {
                        tx.try_send(message).err().map(tokio::sync::mpsc::error::TrySendError::into_inner)
                    } else { Some(message) };
                    if let Some(message) = unqueued {
                        id=id.wrapping_add(1);
                        let ack=json!({"id":id,"method":"Page.screencastFrameAck","sessionId":message.get("sessionId"),"params":{"sessionId":message.pointer("/params/sessionId")}});
                        if let Ok(mut bytes)=serde_json::to_vec(&ack){bytes.push(0);if writer.write_all(&bytes).await.is_err(){break;}}
                    }
                } else if message.get("method").is_some() {
                    // Event consumers must not retain oversized page payloads in a ring buffer.
                    if size<=64*1024 { let _ = events.send(message); }
                }
            }
        }
    }
    for (_, reply) in pending {
        let _ = reply.send(Err(Error("The browser disconnected.".into())));
    }
}

/// Uses the contract's generated error text without echoing a selector's contents.
pub fn tool_error(kind: &str, operation: &str, length: usize) -> String {
    spec::spec()
        .ok()
        .and_then(|s| s.error_templates.get(kind).cloned())
        .unwrap_or_else(|| "Preview automation failed.".into())
        .replace("<operation>", operation)
        .replace("987654", &length.to_string())
}
