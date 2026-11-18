//! The method table: one entry per RPC method, either a handler or "not supported".
//!
//! Each contract area registers its handlers from its own file in `methods/`, so tracks
//! never edit one shared list. Registration checks every tag against the contract
//! (`conn_contract::methods`) and panics at startup on a typo, a duplicate, or a unary
//! handler for a stream method (or the reverse).

use std::{collections::HashMap, fmt, future::Future, sync::Arc};

use conn_contract::{from_json, methods, to_json};
use conn_wire::{Exit, error_defect};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::mpsc;

use conn_engine::BoxFuture;

use crate::{limits, scopes};

/// What a handler knows about its call. Grows with auth (track a) without changing handlers.
#[derive(Clone, Debug, Default)]
pub struct CallContext {
    /// Names the WebSocket connection the call came on, unique per process. `session::run`
    /// sets it; it is zero for a call made outside a session (tests, fixtures).
    pub connection_id: u64,
    /// The headers the client sent with this request. Effect puts the WebSocket upgrade
    /// headers first; `/ws` starts this list empty, so it holds only the request's own.
    pub headers: Vec<(String, String)>,
    /// The session that authenticated the WebSocket upgrade.
    pub principal: Option<Arc<crate::auth::Principal>>,
}

/// How a call failed, mapped to the Effect `Exit` the client receives.
#[derive(Clone, Debug, PartialEq)]
pub enum Failure {
    /// A typed error from the method's contract error schema.
    Fail(Value),
    /// A defect: a bug or an unsupported case. The client sees an `Error`.
    Die(Value),
}

impl Failure {
    pub fn fail<E: Serialize>(error: &E) -> Self {
        Failure::Fail(to_json(error))
    }

    pub fn die(message: impl Into<String>) -> Self {
        Failure::Die(error_defect("ConnServerError", message))
    }

    pub fn into_exit(self) -> Exit {
        match self {
            Failure::Fail(error) => Exit::fail(error),
            Failure::Die(defect) => Exit::die(defect),
        }
    }
}

/// The exit for a method nobody registered. Effect answers an unknown tag the same way.
pub fn not_supported_exit(tag: &str) -> Exit {
    Exit::die(error_defect(
        "ConnServerNotSupported",
        format!("conn-server does not support `{tag}` yet"),
    ))
}

/// Items of a stream handler. A closed channel ends the stream successfully.
pub type ItemStream = mpsc::Receiver<Result<Value, Failure>>;

type UnaryFn =
    dyn Fn(CallContext, Value) -> BoxFuture<'static, Result<Value, Failure>> + Send + Sync;
type StreamFn =
    dyn Fn(CallContext, Value) -> BoxFuture<'static, Result<ItemStream, Failure>> + Send + Sync;

#[derive(Clone)]
pub enum Handler {
    Unary(Arc<UnaryFn>),
    Stream(Arc<StreamFn>),
}

impl std::fmt::Debug for Handler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unary(_) => "Handler::Unary",
            Self::Stream(_) => "Handler::Stream",
        })
    }
}

#[derive(Default)]
pub struct MethodTable {
    handlers: HashMap<&'static str, Handler>,
    disconnect: Vec<Arc<dyn Fn(u64) + Send + Sync>>,
}

impl std::fmt::Debug for MethodTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MethodTable")
            .field("handlers", &self.handlers.len())
            .finish()
    }
}

impl MethodTable {
    pub fn on_disconnect(&mut self, handler: impl Fn(u64) + Send + Sync + 'static) {
        self.disconnect.push(Arc::new(handler));
    }
    pub fn disconnect(&self, connection: u64) {
        for handler in &self.disconnect {
            handler(connection);
        }
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a unary method. The payload is decoded into `I`; a payload that does not
    /// decode, or breaks a contract limit (`limits.rs`), ends the call with a defect, as
    /// Effect does for a schema failure.
    pub fn unary<I, O, F, Fut>(&mut self, tag: &'static str, handler: F)
    where
        I: DeserializeOwned + Send + 'static,
        O: Serialize + 'static,
        F: Fn(CallContext, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, Failure>> + Send + 'static,
    {
        self.insert(tag, false);
        let handler = Arc::new(handler);
        let call = move |ctx: CallContext,
                         mut payload: Value|
              -> BoxFuture<'static, Result<Value, Failure>> {
            let handler = handler.clone();
            Box::pin(async move {
                scopes::check(tag, &ctx, &payload)?;
                limits::check(tag, &mut payload)?;
                let input = decode::<I>(tag, payload)?;
                handler(ctx, input).await.map(|output| to_json(&output))
            })
        };
        self.handlers.insert(tag, Handler::Unary(Arc::new(call)));
    }

    /// Registers a stream method. The handler resolves to the stream once it has started.
    pub fn stream<I, F, Fut>(&mut self, tag: &'static str, handler: F)
    where
        I: DeserializeOwned + Send + 'static,
        F: Fn(CallContext, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<ItemStream, Failure>> + Send + 'static,
    {
        self.insert(tag, true);
        let handler = Arc::new(handler);
        let call = move |ctx: CallContext,
                         mut payload: Value|
              -> BoxFuture<'static, Result<ItemStream, Failure>> {
            let handler = handler.clone();
            Box::pin(async move {
                scopes::check(tag, &ctx, &payload)?;
                limits::check(tag, &mut payload)?;
                handler(ctx, decode::<I>(tag, payload)?).await
            })
        };
        self.handlers.insert(tag, Handler::Stream(Arc::new(call)));
    }

    fn insert(&self, tag: &str, stream: bool) {
        let Some(info) = conn_contract::method(tag) else {
            panic!("`{tag}` is not a method of the client contract");
        };
        assert!(
            scopes::is_declared(tag),
            "`{tag}` has no entry in the scope table (scopes.rs)"
        );
        assert_eq!(
            info.stream,
            stream,
            "`{tag}` is registered as {} but the contract says {}",
            kind(stream),
            kind(info.stream)
        );
        assert!(
            !self.handlers.contains_key(tag),
            "`{tag}` is registered twice"
        );
    }

    /// A table with only the methods named in `allow`, and the same disconnect handlers. The
    /// managed ingress serves each profile from one: a method outside it answers "not
    /// supported", as an unregistered method does.
    pub fn restricted(&self, allow: &[&str]) -> MethodTable {
        MethodTable {
            handlers: self
                .handlers
                .iter()
                .filter(|(tag, _)| allow.contains(tag))
                .map(|(tag, handler)| (*tag, handler.clone()))
                .collect(),
            disconnect: self.disconnect.clone(),
        }
    }

    /// The handler for `tag`, or `None` when the method is not supported.
    pub fn get(&self, tag: &str) -> Option<&Handler> {
        self.handlers.get(tag)
    }

    pub fn coverage(&self) -> Coverage {
        let all = methods();
        let missing: Vec<&'static str> = all
            .iter()
            .filter(|m| !self.handlers.contains_key(m.tag.as_str()))
            .map(|m| m.tag.as_str())
            .collect();
        Coverage {
            implemented: all.len() - missing.len(),
            total: all.len(),
            streams_implemented: all
                .iter()
                .filter(|m| m.stream && self.handlers.contains_key(m.tag.as_str()))
                .count(),
            streams_total: all.iter().filter(|m| m.stream).count(),
            missing,
        }
    }
}

fn kind(stream: bool) -> &'static str {
    if stream { "a stream" } else { "unary" }
}

fn decode<I: DeserializeOwned>(tag: &str, payload: Value) -> Result<I, Failure> {
    from_json(payload).map_err(|e| Failure::die(format!("invalid payload for `{tag}`: {e}")))
}

#[derive(Clone, Debug)]
pub struct Coverage {
    pub implemented: usize,
    pub total: usize,
    pub streams_implemented: usize,
    pub streams_total: usize,
    pub missing: Vec<&'static str>,
}

impl fmt::Display for Coverage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} of {} methods ({} of {} streams)",
            self.implemented, self.total, self.streams_implemented, self.streams_total
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table() -> MethodTable {
        let mut table = MethodTable::new();
        table.unary("server.probe", |_, _: Value| async { Ok(json!({})) });
        table.stream("orchestration.subscribeShell", |_, _: Value| async {
            let (tx, rx) = mpsc::channel(1);
            tx.send(Ok(json!({"kind": "synchronized"}))).await.unwrap();
            Ok(rx)
        });
        table
    }

    #[test]
    fn reports_coverage() {
        let coverage = table().coverage();
        let all = conn_contract::methods();
        let streams = all.iter().filter(|m| m.stream).count();
        assert_eq!(
            coverage.to_string(),
            format!("2 of {} methods (1 of {streams} streams)", all.len())
        );
        assert_eq!(coverage.missing.len(), all.len() - 2);
        assert!(!coverage.missing.contains(&"server.probe"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn calls_handlers_and_reports_bad_payloads() {
        let mut table = table();
        #[derive(serde::Deserialize)]
        struct Input {
            name: String,
        }
        table.unary("server.getConfig", |_, input: Input| async move {
            Ok(input.name)
        });
        let Some(Handler::Unary(call)) = table.get("server.getConfig") else {
            panic!()
        };
        assert_eq!(
            call(CallContext::default(), json!({"name": "a"})).await,
            Ok(json!("a"))
        );
        let Err(Failure::Die(defect)) = call(CallContext::default(), json!({})).await else {
            panic!()
        };
        assert!(
            defect["message"]
                .as_str()
                .unwrap()
                .contains("invalid payload")
        );

        let Some(Handler::Stream(call)) = table.get("orchestration.subscribeShell") else {
            panic!()
        };
        let mut items = call(CallContext::default(), json!({})).await.unwrap();
        assert_eq!(
            items.recv().await,
            Some(Ok(json!({"kind": "synchronized"})))
        );
    }

    #[test]
    fn unsupported_methods_get_a_well_formed_defect() {
        assert!(table().get("server.getConfig").is_none());
        assert_eq!(
            serde_json::to_value(not_supported_exit("server.getConfig")).unwrap(),
            json!({"_tag": "Failure", "cause": [{"_tag": "Die", "defect": {
                "name": "ConnServerNotSupported",
                "message": "conn-server does not support `server.getConfig` yet"
            }}]})
        );
    }

    #[test]
    #[should_panic(expected = "not a method of the client contract")]
    fn rejects_unknown_tags() {
        MethodTable::new().unary("server.nope", |_, _: Value| async { Ok(json!({})) });
    }

    #[test]
    #[should_panic(expected = "registered as unary but the contract says a stream")]
    fn rejects_the_wrong_kind() {
        MethodTable::new().unary("orchestration.subscribeShell", |_, _: Value| async {
            Ok(json!({}))
        });
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn rejects_duplicates() {
        table().unary("server.probe", |_, _: Value| async { Ok(json!({})) });
    }
}
