//! `annotations.*`: the store in `conn_features::annotations`, as the T3 server mounts it
//! (`apps/server/src/wsFork.ts`). Owner: the Conn-only areas track.
//!
//! Scopes: `scopes.rs` (subscribe needs `orchestration:read`, the writes `preview:operate`).

use conn_contract::{AnnotationCreateInput, AnnotationProjectInput, AnnotationRemoveInput};
use conn_features::annotations::{AnnotationError, Annotations, is_annotation_id};
use serde_json::json;
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{Failure, MethodTable};

fn fail(error: &AnnotationError) -> Failure {
    Failure::Fail(error.to_contract())
}

/// `AnnotationId`'s pattern is part of the schema: an id outside it does not decode.
fn require_ids<'a>(mut ids: impl Iterator<Item = &'a String>) -> Result<(), Failure> {
    match ids.find(|id| !is_annotation_id(id)) {
        Some(id) => Err(Failure::die(format!(
            "Expected a string matching the RegExp ^[a-zA-Z0-9][a-zA-Z0-9_-]{{0,199}}$, got {id:?}"
        ))),
        None => Ok(()),
    }
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(store) = deps.annotations.clone() else {
        return;
    };

    let annotations = store.clone();
    table.stream(
        "annotations.subscribe",
        move |_, input: AnnotationProjectInput| {
            let annotations = annotations.clone();
            async move {
                let mut lists = annotations
                    .subscribe(&input.project_id)
                    .await
                    .map_err(|e| fail(&e))?;
                let (tx, rx) = mpsc::channel(1);
                tokio::spawn(async move {
                    while let Some(list) = lists.recv().await {
                        if tx.send(list.map_err(|e| fail(&e))).await.is_err() {
                            return;
                        }
                    }
                });
                Ok(rx)
            }
        },
    );

    let annotations = store.clone();
    table.unary(
        "annotations.create",
        move |_, input: AnnotationCreateInput| {
            let annotations = annotations.clone();
            async move {
                require_ids(std::iter::once(&input.annotation.id))?;
                annotations
                    .create(&input.project_id, input.annotation)
                    .await
                    .map(|annotation| json!({ "annotation": annotation }))
                    .map_err(|e| fail(&e))
            }
        },
    );

    let annotations: Annotations = store;
    table.unary(
        "annotations.remove",
        move |_, input: AnnotationRemoveInput| {
            let annotations = annotations.clone();
            async move {
                require_ids(input.ids.iter().flatten())?;
                annotations
                    .remove(&input.project_id, input.ids, input.scope)
                    .await
                    .map(|removed| json!({ "removedIds": removed }))
                    .map_err(|e| fail(&e))
            }
        },
    );
}
