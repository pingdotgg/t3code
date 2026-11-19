//! `peerLinks.*`: links from this environment to others (`crate::peers`). Reference: the
//! `peerLinks` handlers in `apps/server/src/ws.ts`.

use serde_json::{Value, json};

use super::Deps;
use crate::peers::LinkInput;
use crate::table::{Failure, MethodTable};

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(peers) = deps.peers.clone() else {
        return;
    };
    let list = peers.clone();
    table.unary("peerLinks.list", move |_, _: Value| {
        let peers = list.clone();
        async move {
            peers
                .list()
                .await
                .map(|links| json!({"links": links}))
                .map_err(|e| Failure::Fail(e.to_contract()))
        }
    });
    let link = peers.clone();
    table.unary("peerLinks.link", move |_, input: LinkInput| {
        let peers = link.clone();
        async move {
            peers
                .link(input)
                .await
                .map_err(|e| Failure::Fail(e.to_contract()))
        }
    });
    let unlink = peers.clone();
    table.unary("peerLinks.unlink", move |_, input: Value| {
        let peers = unlink.clone();
        async move {
            let id = input["environmentId"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            peers
                .unlink(&id)
                .await
                .map(|removed| json!({"removed": removed}))
                .map_err(|e| Failure::Fail(e.to_contract()))
        }
    });
    table.unary("peerLinks.answerRequest", move |_, input: Value| {
        let peers = peers.clone();
        async move {
            // The payload decoded as `PeerLinkRequestAnswerInput` in the table's checks.
            conn_contract::from_json::<conn_contract::PeerLinkRequestAnswerInput>(input.clone())
                .map_err(|e| Failure::die(format!("Invalid answer: {e}")))?;
            peers.answer(input).await.map_err(Failure::Fail)
        }
    });
}
