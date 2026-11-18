//! The target routes under `/api/v1/conn/managed` on the Gateway, over HTTPS that trusts the
//! lab Orbit CA only. Every request carries the service credential, the environment ID and
//! the generation. Nothing here logs a token or the credential.

use std::{sync::Arc, time::Duration};

use futures_core::future::BoxFuture;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, body::Bytes};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};

use super::provision::Provision;

/// One Gateway call may take this long; a probe that takes longer has failed.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(2);
/// The largest Gateway answer read. A snapshot carries every owed revision, and the
/// contract has no paging yet: the cap leaves room for a long offline backlog (about
/// 200,000 owed rows) while still bounding one answer.
const MAX_ANSWER_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayError {
    /// No answer: connect, TLS, timeout, or an answer that is not the contract's JSON.
    Transport(String),
    /// The Gateway answered with an error code (`conn.managed_*`).
    Refused { status: u16, code: String },
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(reason) => write!(f, "gateway unreachable: {reason}"),
            Self::Refused { status, code } => write!(f, "gateway refused ({status}): {code}"),
        }
    }
}

/// The Gateway as the target uses it. Tests implement it in memory.
pub trait Gateway: Send + Sync {
    /// `POST /authority`: the reply's `data`.
    fn authority(
        &self,
        nonce: String,
        after_revision: Option<u64>,
    ) -> BoxFuture<'static, Result<Value, GatewayError>>;
    /// `POST /introspect`.
    fn introspect(
        &self,
        nonce: String,
        token: String,
        peer_address: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>>;
    /// `POST /ack`; `body` holds the ACK fields.
    fn ack(&self, body: Value) -> BoxFuture<'static, Result<Value, GatewayError>>;
    /// `POST /realtime`.
    fn realtime(&self) -> BoxFuture<'static, Result<Value, GatewayError>>;
    /// `POST /broadcasting/auth`.
    fn broadcasting_auth(
        &self,
        socket_id: String,
        channel_name: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>>;
}

/// The real Gateway over HTTPS.
pub struct HttpsGateway {
    host: String,
    port: u16,
    base_path: String,
    tls: Arc<rustls::ClientConfig>,
    credential: Arc<str>,
    environment_id: Arc<str>,
    generation: u64,
}

impl std::fmt::Debug for HttpsGateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpsGateway")
            .field("host", &self.host)
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl HttpsGateway {
    pub fn new(provision: &Provision) -> Result<Self, String> {
        let url = url::Url::parse(&provision.gateway_url).map_err(|e| e.to_string())?;
        if url.scheme() != "https" {
            return Err("the Gateway URL must be https".into());
        }
        let host = url
            .host_str()
            .ok_or("the Gateway URL has no host")?
            .to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        Ok(Self {
            host,
            port,
            base_path: url.path().trim_end_matches('/').to_owned(),
            tls: lab_tls(&provision.ca_pem)?,
            credential: provision.credential.clone(),
            environment_id: provision.environment_id.clone().into(),
            generation: provision.generation,
        })
    }

    fn post(
        &self,
        path: &'static str,
        body: Value,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        self.post_with(path, body, Envelope::Data)
    }

    fn post_with(
        &self,
        path: &'static str,
        mut body: Value,
        envelope: Envelope,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        if let Some(object) = body.as_object_mut() {
            object.insert("environment_id".into(), json!(&*self.environment_id));
            object.insert("generation".into(), json!(self.generation));
        }
        let call = post_json(
            self.host.clone(),
            self.port,
            format!("{}/api/v1/conn/managed{path}", self.base_path),
            self.tls.clone(),
            self.credential.clone(),
            body,
            envelope,
        );
        Box::pin(async move {
            match tokio::time::timeout(CALL_TIMEOUT, call).await {
                Ok(result) => result,
                Err(_) => Err(GatewayError::Transport("timeout".into())),
            }
        })
    }
}

impl Gateway for HttpsGateway {
    fn authority(
        &self,
        nonce: String,
        after_revision: Option<u64>,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        self.post(
            "/authority",
            json!({ "nonce": nonce, "after_revision": after_revision }),
        )
    }

    fn introspect(
        &self,
        nonce: String,
        token: String,
        peer_address: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        self.post(
            "/introspect",
            json!({ "nonce": nonce, "token": token, "peer_address": peer_address }),
        )
    }

    fn ack(&self, body: Value) -> BoxFuture<'static, Result<Value, GatewayError>> {
        self.post("/ack", body)
    }

    fn realtime(&self) -> BoxFuture<'static, Result<Value, GatewayError>> {
        self.post("/realtime", json!({}))
    }

    fn broadcasting_auth(
        &self,
        socket_id: String,
        channel_name: String,
    ) -> BoxFuture<'static, Result<Value, GatewayError>> {
        // This route answers the Pusher shape, `{"auth": …}`, without the `data` envelope.
        self.post_with(
            "/broadcasting/auth",
            json!({ "socket_id": socket_id, "channel_name": channel_name }),
            Envelope::Bare,
        )
    }
}

/// A rustls client that trusts only the certificates in `ca_pem`, the lab Orbit CA.
pub fn lab_tls(ca_pem: &[u8]) -> Result<Arc<rustls::ClientConfig>, String> {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(ca_pem) {
        let cert = cert.map_err(|e| format!("the CA file: {e}"))?;
        roots
            .add(cert)
            .map_err(|e| format!("the CA certificate: {e}"))?;
    }
    if roots.is_empty() {
        return Err("the CA file holds no certificate".into());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Opens TLS to `host:port`, verifying `host` against the lab roots.
pub async fn connect_tls(
    host: &str,
    port: u16,
    tls: Arc<rustls::ClientConfig>,
) -> Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>, GatewayError> {
    let transport = |e: std::io::Error| GatewayError::Transport(e.kind().to_string());
    let tcp = tokio::net::TcpStream::connect((host, port))
        .await
        .map_err(transport)?;
    let _ = tcp.set_nodelay(true);
    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|_| GatewayError::Transport("invalid host name".into()))?;
    tokio_rustls::TlsConnector::from(tls)
        .connect(name, tcp)
        .await
        .map_err(transport)
}

async fn post_json(
    host: String,
    port: u16,
    path: String,
    tls: Arc<rustls::ClientConfig>,
    credential: Arc<str>,
    body: Value,
    envelope: Envelope,
) -> Result<Value, GatewayError> {
    let transport = |what: &str| GatewayError::Transport(what.to_owned());
    let stream = connect_tls(&host, port, tls).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| transport("http handshake"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let authority = if port == 443 {
        host.clone()
    } else {
        format!("{host}:{port}")
    };
    let request = Request::post(path)
        .header("host", authority)
        .header("authorization", format!("Bearer {credential}"))
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .map_err(|_| transport("request"))?;
    let response = sender
        .send_request(request)
        .await
        .map_err(|_| transport("request failed"))?;
    let status = response.status().as_u16();
    let bytes = Limited::new(response.into_body(), MAX_ANSWER_BYTES)
        .collect()
        .await
        .map_err(|_| transport("answer"))?
        .to_bytes();
    let answer: Value =
        serde_json::from_slice(&bytes).map_err(|_| transport("answer is not JSON"))?;
    decode_answer(status, answer, envelope)
}

/// How a route wraps a successful answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Envelope {
    /// `{"data": …, "meta": …}`: every target route but one.
    Data,
    /// The bare object: `/broadcasting/auth` answers `{"auth": …}`, as Pusher expects.
    Bare,
}

/// The payload of a 2xx answer, or the error code of any other.
pub fn decode_answer(
    status: u16,
    answer: Value,
    envelope: Envelope,
) -> Result<Value, GatewayError> {
    if (200..300).contains(&status) {
        return match envelope {
            Envelope::Data => answer
                .get("data")
                .cloned()
                .ok_or_else(|| GatewayError::Transport("answer has no data".into())),
            Envelope::Bare if answer.is_object() => Ok(answer),
            Envelope::Bare => Err(GatewayError::Transport("answer is not an object".into())),
        };
    }
    let code = answer
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    Err(GatewayError::Refused { status, code })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The merged Gateway's shapes (Orbit `d023758a54f9`, `ConnManagedTargetsController`).
    #[test]
    fn answers_decode_as_the_gateway_sends_them() {
        let auth = json!({"auth": "key:signature"});
        assert_eq!(decode_answer(200, auth.clone(), Envelope::Bare), Ok(auth));
        let authority = json!({"data": {"kind": "current"}, "meta": {"request_id": "r"}});
        assert_eq!(
            decode_answer(200, authority, Envelope::Data),
            Ok(json!({"kind": "current"}))
        );
        let refused = json!({"status": 403, "error": {"code": "conn.managed_target_identity", "message": "m"}});
        assert_eq!(
            decode_answer(403, refused, Envelope::Bare),
            Err(GatewayError::Refused {
                status: 403,
                code: "conn.managed_target_identity".into()
            })
        );
    }
}
