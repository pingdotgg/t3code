//! The pin holds, and generated operations build requests and decode answers.

use conn_gateway_api::ops::{
    ConnEnvironmentList, ConnEnvironmentSession, ConnEnvironmentSessionSuccess, ConnManagedAck,
    ConnMe, OPERATION_IDS, OperationShow,
};
use conn_gateway_api::{AuthKind, DecodeError, GatewayOperation, Method, OPENAPI_SHA256, types};
use sha2::{Digest, Sha256};

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn read(name: &str) -> String {
    std::fs::read_to_string(format!("{ROOT}/{name}")).expect("crate file")
}

#[test]
fn digest_matches_the_pinned_document() {
    let bytes = std::fs::read(format!("{ROOT}/openapi.json")).expect("openapi.json");
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        digest, OPENAPI_SHA256,
        "regenerate after changing openapi.json"
    );
    assert!(
        read("openapi.source").contains(&format!("sha256 = \"{digest}\"")),
        "openapi.source records the digest"
    );
}

#[test]
fn generates_exactly_the_listed_operations() {
    let mut listed: Vec<&str> = Vec::new();
    let text = read("operations.txt");
    for line in text.lines() {
        let id = line.split('#').next().unwrap_or_default().trim();
        if !id.is_empty() {
            listed.push(id);
        }
    }
    listed.sort_unstable();
    assert_eq!(listed, OPERATION_IDS, "operations.txt and ops.rs agree");
}

#[test]
fn builds_a_request() {
    let op = OperationShow {
        operation: 42,
        after_sequence: Some(3),
    };
    assert_eq!(OperationShow::METHOD, Method::Get, "method");
    assert_eq!(
        OperationShow::PATH_TEMPLATE,
        "/api/v1/operations/{operation}",
        "template"
    );
    assert_eq!(
        op.path_and_query(),
        "/api/v1/operations/42?after_sequence=3",
        "path and query"
    );
    assert!(op.body().is_none(), "a GET sends no body");
    assert_eq!(ConnMe.path(), "/api/v1/conn/me", "no parameters");

    let session = ConnEnvironmentSession {
        environment: "env 1/x".to_owned(),
    };
    assert_eq!(
        session.path(),
        "/api/v1/conn/environments/env%201%2Fx/session",
        "encoded"
    );
}

#[test]
fn managed_routes_use_the_bearer() {
    assert_eq!(ConnManagedAck::AUTH, AuthKind::ManagedBearer, "managed");
    assert_eq!(ConnMe::AUTH, AuthKind::WireGuardPeer, "peer");
    let ack = ConnManagedAck {
        body: types::ConnManagedAckRequest {
            environment_id: "env-1".to_owned(),
            generation: 2,
            revision: 3,
            kind: types::ConnManagedAckRequestKind::Observed,
            notice_received_at: None,
            fenced_at: None,
            handlers_closed_at: None,
            recovered_at: None,
        },
    };
    let body = serde_json::to_value(ack.body()).expect("body encodes");
    assert_eq!(
        body,
        serde_json::json!({
            "environment_id": "env-1",
            "generation": 2,
            "revision": 3,
            "kind": "observed",
            "notice_received_at": null
        }),
        "body"
    );
}

#[test]
fn decodes_answers_by_status() {
    let operation = serde_json::to_vec(&serde_json::json!({
        "data": {
            "id": 7, "kind": "conn.pairing_create", "target_type": "conn_environment",
            "target_id": 1, "input": {}, "status": "running", "sequence": 1,
            "current_step": null, "failed_step": null, "error_code": null, "result": null,
            "cancel_requested": false, "attempts": 1, "triggered_by": null,
            "caller_node_id": null, "caller_node_name": null, "created_at": null,
            "started_at": null, "finished_at": null, "poll_after_seconds": 2,
            "assistance": null, "error": null, "current_step_started_at": null,
            "current_step_observed_at": null, "overdue_since": null,
            "hold_wait_reason": null, "ready_at": null
        },
        "meta": {"request_id": "r"}
    }))
    .expect("fixture encodes");
    let operation = operation.as_slice();
    let answer = OperationShow::decode_success(200, operation).expect("200 decodes");
    assert_eq!(answer.data.id, 7, "operation id");

    match ConnEnvironmentSession::decode_success(202, operation).expect("202 decodes") {
        ConnEnvironmentSessionSuccess::Status202(reply) => {
            assert_eq!(reply.data.id, 7, "202 is the Operation");
        }
        other @ ConnEnvironmentSessionSuccess::Status200(_) => panic!("wrong variant: {other:?}"),
    }

    let error = br#"{"error": {"code": "node_access.required", "message": "no", "details": {}}}"#;
    let decoded = OperationShow::decode_error(403, error).expect("403 decodes");
    assert_eq!(decoded.error.code, "node_access.required", "error code");
    let empty_details = br#"{"error": {"code": "x", "message": "no", "details": []}}"#;
    assert!(
        OperationShow::decode_error(403, empty_details).is_ok(),
        "an empty `details` list decodes"
    );

    assert!(
        matches!(
            OperationShow::decode_success(204, b""),
            Err(DecodeError::UnexpectedStatus(204))
        ),
        "an undocumented status is refused"
    );
    assert!(
        matches!(
            OperationShow::decode_error(500, error),
            Err(DecodeError::UnexpectedStatus(500))
        ),
        "an undocumented error status is refused"
    );
}

#[test]
fn decodes_environments_from_gateways_before_release_2214() {
    let answer = serde_json::to_vec(&serde_json::json!({
        "data": [{
            "admin_session_expires_at": "2026-11-24T00:00:00Z", "cleanup_pending": false,
            "cleanup_version": 0, "environment_id": "env-1", "instance_id": null,
            "instance_name": null, "instance_url": null, "label": "mini", "node_name": "mini",
            "power_state": null, "project_id": null, "project_name": null, "project_slug": null,
            "registered_at": "2026-11-24T00:00:00Z", "registered_by": "mini",
            "renewal_checked_at": null, "renewal_error_code": null, "reservation_id": null,
            "server_version": null, "status": "registered", "url": "http://10.44.0.8:3773"
        }],
        "meta": {"request_id": "r"}
    }))
    .expect("fixture encodes");
    let list = ConnEnvironmentList::decode_success(200, &answer)
        .expect("a row without roles or is_primary_agent decodes");
    let row = list.data.first().expect("one row");
    assert!(!row.is_primary_agent, "is_primary_agent defaults to false");
    assert!(row.roles.is_empty(), "roles defaults to []");
}
