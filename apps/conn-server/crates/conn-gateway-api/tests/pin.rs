//! The pin holds, and generated operations build requests and decode answers.

use conn_gateway_api::ops::{
    ConnEnvironmentSession, ConnEnvironmentSessionSuccess, ConnManagedAck, ConnMe, OPERATION_IDS,
    OperationShow,
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
            socket_id: "1.2".to_owned(),
            channel_name: "private-x".to_owned(),
        },
    };
    let body = serde_json::to_value(ack.body()).expect("body encodes");
    assert_eq!(
        body,
        serde_json::json!({"socket_id": "1.2", "channel_name": "private-x"}),
        "body"
    );
}

#[test]
fn decodes_answers_by_status() {
    let operation = br#"{"data": {"id": 7, "status": "running"}, "meta": {"request_id": "r"}}"#;
    let answer = OperationShow::decode_success(200, operation).expect("200 decodes");
    assert_eq!(answer.data.id, Some(7), "operation id");

    match ConnEnvironmentSession::decode_success(202, operation).expect("202 decodes") {
        ConnEnvironmentSessionSuccess::Status202(reply) => {
            assert_eq!(reply.data.id, Some(7), "202 is the Operation");
        }
        other @ ConnEnvironmentSessionSuccess::Status200(_) => panic!("wrong variant: {other:?}"),
    }

    let error = br#"{"error": {"code": "node_access.required", "message": "no", "details": {}}}"#;
    let decoded = OperationShow::decode_error(403, error).expect("403 decodes");
    assert_eq!(decoded.error.code, "node_access.required", "error code");

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
