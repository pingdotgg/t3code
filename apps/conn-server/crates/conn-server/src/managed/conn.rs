//! The fence at the byte level: every managed connection's socket is a [`FencedIo`]. The
//! handlers a connection carries (an HTTP request, an RPC or media WebSocket) are attached to
//! it. Once any of them is fenced, the socket refuses every further write and read, so nothing
//! Hyper or the WebSocket still buffers can reach the peer, and the connection ends. While one
//! is paused, writes wait. A handler stays registered until its connection is gone: only then
//! can the target say no handler and no sendable byte of that edge remain.
//!
//! Every managed response carries `Connection: close`, so an HTTP connection carries one
//! request and ends with it.

use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use futures_core::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::Handle;
use crate::session::GateState;

/// The handlers attached to one connection.
#[derive(Default)]
pub struct Slot {
    handles: Mutex<Vec<Arc<Handle>>>,
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot").finish_non_exhaustive()
    }
}

impl Slot {
    /// Keeps `handle` registered for the life of the connection and fences the connection
    /// with it.
    pub fn attach(&self, handle: Arc<Handle>) {
        crate::lock(&self.handles).push(handle);
    }
}

/// What a managed handler learns about its connection: the TCP peer and its slot.
#[derive(Clone, Debug)]
pub struct Peer {
    pub addr: SocketAddr,
    pub slot: Arc<Slot>,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, Listener>> for Peer {
    fn connect_info(stream: axum::serve::IncomingStream<'_, Listener>) -> Self {
        stream.remote_addr().clone()
    }
}

/// The managed listener: plain TCP, each socket wrapped in a [`FencedIo`].
#[derive(Debug)]
pub struct Listener(pub tokio::net::TcpListener);

impl axum::serve::Listener for Listener {
    type Io = FencedIo;
    type Addr = Peer;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    let slot = Arc::new(Slot::default());
                    let io = FencedIo {
                        inner: stream,
                        slot: slot.clone(),
                        watched: Vec::new(),
                        fenced: false,
                    };
                    return (io, Peer { addr, slot });
                }
                // As axum's own TCP listener: a failed accept (out of descriptors) waits a
                // moment and tries again.
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(Peer {
            addr: self.0.local_addr()?,
            slot: Arc::new(Slot::default()),
        })
    }
}

struct Watched {
    handle: Arc<Handle>,
    closed: BoxFuture<'static, ()>,
    changed: BoxFuture<'static, ()>,
}

/// A TCP socket that honours the fence of every handler attached to it.
pub struct FencedIo {
    inner: tokio::net::TcpStream,
    slot: Arc<Slot>,
    watched: Vec<Watched>,
    /// Latched at the first fence: every later poll fails at once and no finished future is
    /// polled again.
    fenced: bool,
}

impl std::fmt::Debug for FencedIo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FencedIo")
            .field("handlers", &self.watched.len())
            .finish_non_exhaustive()
    }
}

fn fenced() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "managed access revoked")
}

impl FencedIo {
    /// `Ready(Ok)`: all attached handlers are open. `Ready(Err)`: one is fenced. `Pending`:
    /// one is paused; the task wakes at its next change or its fence.
    fn check(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.fenced {
            return Poll::Ready(Err(fenced()));
        }
        let state = self.check_handlers(cx);
        if matches!(state, Poll::Ready(Err(_))) {
            self.fenced = true;
            self.watched.clear();
        }
        state
    }

    fn check_handlers(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        {
            let handles = crate::lock(&self.slot.handles);
            for handle in handles.iter().skip(self.watched.len()) {
                self.watched.push(Watched {
                    handle: handle.clone(),
                    closed: handle.closed(),
                    changed: handle.changed(),
                });
            }
        }
        let mut paused = false;
        for watched in &mut self.watched {
            if watched.closed.as_mut().poll(cx).is_ready() {
                return Poll::Ready(Err(fenced()));
            }
            match watched.handle.state() {
                GateState::Closed => return Poll::Ready(Err(fenced())),
                GateState::Paused => {
                    paused = true;
                    while watched.changed.as_mut().poll(cx).is_ready() {
                        watched.changed = watched.handle.changed();
                    }
                }
                GateState::Open => {}
            }
        }
        if paused {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    }

    /// Reads stop only at a fence; a pause holds output, not input.
    fn check_fence(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        match self.check(cx) {
            Poll::Ready(Err(error)) => Err(error),
            _ => Ok(()),
        }
    }
}

impl AsyncRead for FencedIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_fence(cx)?;
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for FencedIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.check(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.inner).poll_write(cx, buf),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.check(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.inner).poll_flush(cx),
            other => other,
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // A fenced socket is dropped, not shut down gracefully: no buffered byte follows.
        self.check_fence(cx)?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Serves `router` on `listener` with fenced sockets. Never returns while the listener
/// works.
pub async fn serve(listener: tokio::net::TcpListener, router: axum::Router) -> io::Result<()> {
    axum::serve(
        Listener(listener),
        router.into_make_service_with_connect_info::<Peer>(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        time::Instant,
    };

    use super::*;
    use crate::managed::{
        Shared,
        authority::{AuthorityReply, Notice, SnapshotEdge},
    };

    const ENV: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

    /// An open authority with edge 1, and one registered handler of it.
    fn open_handle() -> (Arc<Shared>, Handle) {
        let shared = Shared::new(ENV.into(), 1);
        shared.set_notice_link(true);
        let wall = conn_support::time::now_ms();
        let probe = shared
            .with(|a| {
                (
                    a.begin_probe("n-1".into(), Instant::now(), wall),
                    Default::default(),
                )
            })
            .expect("probe");
        let reply = AuthorityReply {
            nonce: probe.nonce,
            environment_id: ENV.into(),
            generation: 1,
            head_revision: 0,
            server_time: Some(conn_support::time::iso_from_ms(wall)),
            kind: "snapshot".into(),
            edges: Some(vec![SnapshotEdge {
                edge_id: 1,
                consumer_node_id: 101,
            }]),
            revisions: None,
            owed: vec![],
        };
        shared.with(|a| ((), a.apply_reply(&reply, Instant::now(), wall)));
        let far = Instant::now() + Duration::from_secs(3_600);
        let epoch = shared.read(|a| a.epoch());
        let (id, closed) = shared
            .with(|a| {
                (
                    a.admit(1, 0, far, epoch, None, Instant::now(), wall),
                    Default::default(),
                )
            })
            .expect("admitted");
        let handle = Handle {
            shared: shared.clone(),
            id,
            expires: far,
            closed,
        };
        (shared, handle)
    }

    /// A peer that stops reading: the target's writes back up until the socket is pending.
    /// The fence then cuts it: no write, flush or shutdown passes, a second poll does not
    /// panic, the peer gets no byte beyond what the kernel took before the fence, and the
    /// handler unregisters with the socket.
    #[tokio::test(flavor = "current_thread")]
    async fn a_stalled_write_is_cut_at_the_fence() {
        let (shared, handle) = open_handle();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer = tokio::net::TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let slot = Arc::new(Slot::default());
        slot.attach(Arc::new(handle));
        let mut io = FencedIo {
            inner: stream,
            slot,
            watched: Vec::new(),
            fenced: false,
        };
        // The writer runs in its own task and signals once a write returned `Pending`. Only
        // the fence's wakeup can end that write: nothing else polls it again.
        let (pending_tx, pending_rx) = tokio::sync::oneshot::channel::<()>();
        let writer = tokio::spawn(async move {
            let chunk = vec![7u8; 64 * 1024];
            let mut written = 0usize;
            let mut pending_tx = Some(pending_tx);
            loop {
                let result = std::future::poll_fn(|cx| {
                    let poll = Pin::new(&mut io).poll_write(cx, &chunk);
                    if poll.is_pending()
                        && let Some(tx) = pending_tx.take()
                    {
                        let _ = tx.send(());
                    }
                    poll
                })
                .await;
                match result {
                    Ok(n) => written += n,
                    Err(_) => return (written, io),
                }
            }
        });
        pending_rx.await.expect("the write backed up");
        shared.notice(&Notice {
            environment_id: ENV.into(),
            generation: 1,
            revision: 1,
            edge_ids: vec![1],
        });
        let (written, mut io) = tokio::time::timeout(Duration::from_secs(1), writer)
            .await
            .expect("the fence woke the blocked writer")
            .expect("the writer task");
        assert!(written > 0);
        let chunk = vec![7u8; 64 * 1024];
        assert!(io.write(&chunk).await.is_err(), "no write after the fence");
        assert!(io.flush().await.is_err(), "no flush after the fence");
        assert!(
            io.shutdown().await.is_err(),
            "a second poll answers from the latch"
        );
        drop(io);
        assert_eq!(
            shared.read(|a| a.open_handlers()),
            0,
            "the handler ended with the socket"
        );
        let mut received = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), peer.read_to_end(&mut received)).await;
        assert!(
            received.len() <= written,
            "{} bytes reached the peer, {written} were accepted before the fence",
            received.len()
        );
    }

    /// A probe that moves a token's end to a time still ahead re-arms the close timer: the
    /// handler's close resolves at the new end without another probe or any I/O.
    #[tokio::test(flavor = "current_thread")]
    async fn a_shortened_deadline_rearms_the_close_timer() {
        let (shared, handle) = open_handle();
        let mut closed = handle.closed();
        // Already waiting on the old (one-hour) deadline before it moves.
        tokio::select! {
            biased;
            () = &mut closed => panic!("closed before the deadline moved"),
            () = std::future::ready(()) => {}
        }
        // The Gateway time of the opening snapshot was "now": the token now ends 300 ms on.
        let id = handle.id;
        let gateway_now = conn_support::time::now_ms();
        shared.with(|a| {
            a.set_handler_expiry(id, gateway_now + 300);
            ((), Default::default())
        });
        let started = Instant::now();
        tokio::time::timeout(Duration::from_secs(2), closed)
            .await
            .expect("the close timer re-armed to the shortened deadline");
        assert!(started.elapsed() < Duration::from_millis(1_000));
    }
}
