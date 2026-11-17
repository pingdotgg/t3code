//! One JPEG capture and decoder per tab; viewers release Chrome through their socket acks.
use crate::{Browser, Error};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{broadcast, mpsc};

type Routes = Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>;
#[derive(Debug)]
pub(crate) struct Frames {
    routes: Routes,
    session: String,
    rx: mpsc::Receiver<Value>,
}
impl Frames {
    pub(crate) fn new(routes: Routes, session: &str) -> Result<Self, Error> {
        let (tx, rx) = mpsc::channel(3);
        {
            let mut routes = routes.lock().map_err(crate::err)?;
            if routes.len() >= 40 || routes.contains_key(session) {
                return Err(Error("The browser capture limit is reached.".into()));
            }
            routes.insert(session.into(), tx);
        }
        Ok(Self {
            routes,
            session: session.into(),
            rx,
        })
    }
    pub(crate) async fn recv(&mut self) -> Option<Value> {
        self.rx.recv().await
    }
}
impl Drop for Frames {
    fn drop(&mut self) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.remove(&self.session);
        }
    }
}

#[derive(Debug)]
struct Ack {
    browser: Browser,
    session: String,
    id: Value,
    sent: AtomicBool,
    deadline: tokio::time::Instant,
}
impl Ack {
    fn take(&self) -> Option<impl Future<Output = ()> + Send + 'static> {
        if self.sent.swap(true, Ordering::Relaxed) {
            return None;
        }
        let (browser, session, id, deadline) = (
            self.browser.clone(),
            self.session.clone(),
            self.id.clone(),
            self.deadline,
        );
        Some(async move {
            tokio::time::sleep_until(deadline).await;
            let _ = browser
                .send(
                    "Page.screencastFrameAck",
                    json!({"sessionId":id}),
                    Some(&session),
                )
                .await;
        })
    }
}
impl Drop for Ack {
    fn drop(&mut self) {
        if let Some(send) = self.take() {
            tokio::spawn(send);
        }
    }
}
/// Shared JPEG bytes and an idempotent Chrome acknowledgement.
#[derive(Clone, Debug)]
pub struct Frame {
    pub data: Arc<[u8]>,
    ack: Option<Arc<Ack>>,
}
impl Frame {
    pub(crate) fn still(data: Vec<u8>) -> Self {
        Self {
            data: data.into(),
            ack: None,
        }
    }
    pub fn release(&self) {
        if let Some(send) = self.ack.as_ref().and_then(|ack| ack.take()) {
            tokio::spawn(send);
        }
    }
    pub async fn ack(&self) {
        if let Some(send) = self.ack.as_ref().and_then(|ack| ack.take()) {
            send.await;
        }
    }
}
#[derive(Debug)]
pub(crate) struct Screencast {
    frames: broadcast::Sender<Frame>,
    pump: tokio::task::JoinHandle<()>,
}
impl Screencast {
    pub(crate) fn start(browser: Browser, session: String) -> Result<Self, Error> {
        let mut incoming = browser.frames(&session)?;
        let pace = std::time::Duration::from_millis(crate::spec::spec()?.screencast_ack_pace_ms);
        let (frames, _) = broadcast::channel(1);
        let output = frames.clone();
        let pump = tokio::spawn(async move {
            while let Some(mut message) = incoming.recv().await {
                let ack = Arc::new(Ack {
                    browser: browser.clone(),
                    session: session.clone(),
                    id: message
                        .pointer("/params/sessionId")
                        .cloned()
                        .unwrap_or(Value::Null),
                    sent: AtomicBool::new(false),
                    deadline: tokio::time::Instant::now() + pace,
                });
                let Some(Value::String(data)) =
                    message.pointer_mut("/params/data").map(std::mem::take)
                else {
                    continue;
                };
                if let Ok(Some(data)) =
                    tokio::task::spawn_blocking(move || conn_support::base64::decode(&data)).await
                {
                    let _ = output.send(Frame {
                        data: data.into(),
                        ack: Some(ack),
                    });
                }
            }
        });
        Ok(Self { frames, pump })
    }
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.frames.subscribe()
    }
}
impl Drop for Screencast {
    fn drop(&mut self) {
        self.pump.abort();
    }
}
