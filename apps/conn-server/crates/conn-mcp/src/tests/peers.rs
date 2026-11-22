//! Linked environments as `/mcp` serves them, on a stand-in for the server's peer links: what a
//! forwarded call carries, the link tools, and the fence for a peer link's own work.

use std::sync::Mutex;

use conn_engine::BoxFuture;

use super::*;
use crate::{LinkAsk, LinkInfo, PeerCall, PeerFailure, Peers};

#[derive(Default)]
struct StandIn {
    enabled: bool,
    calls: Mutex<Vec<PeerCall>>,
}

impl Peers for StandIn {
    fn enabled(&self) -> bool {
        self.enabled
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<Value>, String>> {
        Box::pin(async {
            Ok(vec![json!({
                "environmentId": "env-peer", "label": "Peer", "urls": ["http://127.0.0.1:1"],
                "access": "auto", "linkedAt": "2026-11-19T00:00:00.000Z",
                "expiresAt": "2026-12-19T00:00:00.000Z", "lastReachedAt": null,
                "lastError": null, "status": "reachable",
            })])
        })
    }

    fn get(&self, environment_id: &str) -> BoxFuture<'_, Result<Option<LinkInfo>, String>> {
        let known = environment_id == "env-peer";
        Box::pin(async move {
            Ok(known.then(|| LinkInfo {
                label: "Peer".into(),
                access: "auto".into(),
                expired: false,
            }))
        })
    }

    fn unlink(&self, environment_id: &str) -> BoxFuture<'_, Result<bool, String>> {
        let known = environment_id == "env-peer";
        Box::pin(async move { Ok(known) })
    }

    fn call(&self, call: PeerCall) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        crate::lock(&self.calls).push(call);
        Box::pin(async { Ok(json!({"threads": [], "total": 0})) })
    }

    fn request_link(&self, _ask: LinkAsk) -> BoxFuture<'_, Result<Value, PeerFailure>> {
        Box::pin(async { Ok(json!({"status": "pending", "turnItemId": "card"})) })
    }
}

fn linked(access: &'static str) -> Caller {
    Caller::Client(ClientCaller {
        session_id: "link-session".into(),
        max_runtime_mode: (access != "read-only").then_some(access),
        label: "T3 Code · other".into(),
        linked: true,
        narrowed: None,
        scopes: None,
    })
}

#[tokio::test(flavor = "current_thread")]
async fn forwards_with_the_callers_limits_and_a_scoped_retry_key() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-forward",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers.clone()),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    swamp
        .request(
            "tools/call",
            json!({"name": "conn_thread_wait", "arguments": {
                "environmentId": "env-peer", "threadId": "t", "timeoutMs": 999_999,
            }}),
        )
        .await;
    swamp
        .request(
            "tools/call",
            json!({"name": "conn_thread_send", "arguments": {
                "environmentId": "env-peer", "threadId": "t", "message": "hi",
                "clientRequestId": "k",
            }}),
        )
        .await;
    let calls = crate::lock(&peers.calls).clone();
    assert_eq!(calls.len(), 2, "both calls went to the peer");
    let (wait, send) = (&calls[0], &calls[1]);
    assert_eq!(wait.environment_id, "env-peer");
    assert!(
        !wait.arguments.contains_key("environmentId"),
        "the target never reaches the peer"
    );
    assert_eq!(wait.arguments["timeoutMs"], 45_000, "a wait is cut to 45 s");
    assert_eq!(wait.limits.runtime_mode, "full-access");
    assert_eq!(wait.limits.interaction_mode, "default");
    assert!(wait.sender.is_none(), "an outside client sends no thread");
    let key = send.arguments["clientRequestId"].as_str().unwrap();
    assert!(
        key.starts_with("fwd:") && key.len() == 68,
        "the retry key is scoped to its caller: {key}"
    );
    // A mode above the link's access is refused here, with the link named.
    let (code, message) = swamp
        .failure(
            "conn_thread_launch",
            json!({"environmentId": "env-peer", "projectId": "p", "title": "x", "runtimeMode": "full-access"}),
        )
        .await;
    assert_eq!(code, "runtime_mode_escalation_denied");
    assert!(
        message.contains("\"Peer\" was linked with auto access"),
        "{message}"
    );
    assert_eq!(
        crate::lock(&peers.calls).len(),
        2,
        "the refused launch never left"
    );
    // This environment's own id stays here.
    swamp
        .ok(
            "conn_environment_read",
            json!({"environmentId": "env-test"}),
        )
        .await;
    assert_eq!(crate::lock(&peers.calls).len(), 2);
    let links = swamp.ok("conn_environment_links", json!({})).await;
    assert_eq!(links["environmentId"], "env-test");
    assert_eq!(links["links"][0]["status"], "reachable");
    let unlinked = swamp
        .ok(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    assert_eq!(
        unlinked,
        json!({"environmentId": "env-peer", "removed": true})
    );
    let (code, _) = swamp.failure("conn_environment_link", json!({})).await;
    assert_eq!(
        code, "thread_credential_required",
        "a card needs a calling thread"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn links_off_hides_the_link_tools_and_keeps_calls_here() {
    let f = fixture_full(
        "peers-off",
        None,
        FakeProvider::new("claudeAgent"),
        Some(Arc::new(StandIn::default())),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    let list = swamp.request("tools/list", json!({})).await;
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(!names.contains(&"conn_environment_links"));
    assert!(names.contains(&"conn_environment_preferences_update"));
    let reply = swamp
        .request(
            "tools/call",
            json!({"name": "conn_environment_links", "arguments": {}}),
        )
        .await;
    assert_eq!(reply["error"]["code"], -32602, "a hidden tool is not found");
    let (code, message) = swamp
        .failure("conn_thread_list", json!({"environmentId": "env-peer"}))
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.starts_with("Linked environments is off on this machine"));
}

#[tokio::test(flavor = "current_thread")]
async fn a_peer_links_work_stays_within_its_link() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-fence",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers),
    );
    let mut swamp = Client::open(&f.service, client(true)).await;
    let own = launch_as_swamp(&mut swamp, "own", "hang", "auto", "default").await;
    let mut link = Client::open(&f.service, linked("auto")).await;
    let started = link
        .ok(
            "conn_thread_launch",
            json!({"projectId": project_id(), "title": "linked", "message": "hang",
                "modelSelection": {"instanceId": "claudeAgent", "model": "claude-haiku-5-5"}}),
        )
        .await;
    let projection = f
        .service
        .config
        .engine
        .get_thread_projection(conn_contract::ThreadId::from(
            started["threadId"].as_str().unwrap(),
        ))
        .await
        .unwrap();
    assert_eq!(
        projection["thread"]["linkOrigin"],
        json!({"sessionId": "link-session", "label": "T3 Code · other", "access": "auto"}),
        "the thread carries its link"
    );
    let (code, message) = link
        .failure(
            "conn_thread_send",
            json!({"threadId": own, "message": "x", "mode": "queue"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.contains("it may change only threads that link started"));
    link.ok(
        "conn_thread_send",
        json!({"threadId": started["threadId"], "message": "x", "mode": "queue"}),
    )
    .await;
    let (code, message) = link.failure("conn_environment_links", json!({})).await;
    assert_eq!(code, "capability_denied");
    assert!(
        message.contains("it cannot use this environment's links"),
        "{message}"
    );
    let (code, _) = link
        .failure(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    // A full-access link is not fenced.
    let mut full = Client::open(&f.service, linked("full-access")).await;
    full.ok(
        "conn_thread_send",
        json!({"threadId": own, "message": "x", "mode": "queue"}),
    )
    .await;
}

/// A native bearer session keeps its scopes on `/mcp`: `orchestration:operate` alone is not
/// enough to change settings or links.
#[tokio::test(flavor = "current_thread")]
async fn a_native_session_needs_the_scopes_settings_and_links_need() {
    let f = fixture_full(
        "peers-scopes",
        None,
        FakeProvider::new("claudeAgent"),
        Some(Arc::new(StandIn {
            enabled: true,
            ..StandIn::default()
        })),
    );
    let operate_only = Caller::Client(ClientCaller {
        session_id: "device".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
        ]),
        ..ClientCaller::default()
    });
    let mut device = Client::open(&f.service, operate_only).await;
    for (tool, args, scope) in [
        (
            "conn_environment_preferences_update",
            json!({"newWorktreesStartFromOrigin": false}),
            "settings:write",
        ),
        (
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
            "access:write",
        ),
        ("conn_environment_links", json!({}), "access:read"),
    ] {
        let (code, message) = device.failure(tool, args).await;
        assert_eq!(code, "capability_denied", "{tool}");
        assert!(message.contains(scope), "{tool}: {message}");
    }
    let granted = Caller::Client(ClientCaller {
        session_id: "admin".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(
            [
                "orchestration:read",
                "orchestration:operate",
                "access:read",
                "access:write",
            ]
            .map(String::from)
            .to_vec(),
        ),
        ..ClientCaller::default()
    });
    let mut admin = Client::open(&f.service, granted).await;
    admin
        .ok(
            "conn_environment_unlink",
            json!({"environmentId": "env-peer"}),
        )
        .await;
    admin.ok("conn_environment_links", json!({})).await;
}

/// The fence fails closed: when the calling thread cannot be read, the caller is not taken for
/// one that acts for no link.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_thread_read_does_not_open_the_fence() {
    let f = fixture("peers-fence-closed");
    let caller = Caller::Thread(ThreadCaller {
        thread_id: "thread:missing".into(),
        provider_session_id: "p".into(),
        provider_instance_id: "claudeAgent".into(),
        preview: false,
        device: false,
        subagent: false,
    });
    let cx = crate::tools::Cx {
        service: &f.service,
        caller: &caller,
        origin: None,
    };
    assert!(
        cx.link_origin().await.is_err(),
        "an unread thread is not \"no link\""
    );
    assert!(cx.fencing_link().await.is_err());
    assert!(cx.assert_not_linked("change this").await.is_err());
}

/// A native session without `settings:write` cannot change preferences on a linked
/// environment either: refused here, and nothing reaches the peer.
#[tokio::test(flavor = "current_thread")]
async fn a_native_sessions_scopes_hold_for_a_linked_environment() {
    let peers = Arc::new(StandIn {
        enabled: true,
        ..StandIn::default()
    });
    let f = fixture_full(
        "peers-scopes-remote",
        None,
        FakeProvider::new("claudeAgent"),
        Some(peers.clone()),
    );
    let operate_only = Caller::Client(ClientCaller {
        session_id: "device".into(),
        max_runtime_mode: Some("full-access"),
        scopes: Some(vec![
            "orchestration:read".into(),
            "orchestration:operate".into(),
        ]),
        ..ClientCaller::default()
    });
    let mut device = Client::open(&f.service, operate_only).await;
    let (code, message) = device
        .failure(
            "conn_environment_preferences_update",
            json!({"environmentId": "env-peer", "newWorktreesStartFromOrigin": false}),
        )
        .await;
    assert_eq!(code, "capability_denied");
    assert!(message.contains("settings:write"), "{message}");
    assert!(
        crate::lock(&peers.calls).is_empty(),
        "nothing went to the peer"
    );
}
