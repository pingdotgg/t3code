//! Thread shells for unit tests, built through the real contract types.

use conn_contract::{OrchestrationV2ThreadShell as ThreadShell, from_json};
use serde_json::{Value, json};

/// The wire JSON of a top-level active thread. `edit` changes it.
pub(crate) fn thread_json(id: &str, project_id: &str, edit: impl FnOnce(&mut Value)) -> Value {
    let mut value = json!({
        "createdBy": "user",
        "creationSource": "web",
        "id": id,
        "projectId": project_id,
        "title": format!("Thread {id}"),
        "providerInstanceId": "claudeAgent",
        "modelSelection": { "instanceId": "claudeAgent", "model": "claude-haiku-5-5" },
        "runtimeMode": "full-access",
        "interactionMode": "default",
        "branch": null,
        "worktreePath": null,
        "lineage": { "rootThreadId": id, "parentThreadId": null, "relationshipToParent": null },
        "forkedFrom": null,
        "activeProviderThreadId": null,
        "latestRunId": null,
        "activeRunId": null,
        "status": "idle",
        "pendingRuntimeRequest": null,
        "latestVisibleMessage": null,
        "latestUserMessageAt": null,
        "hasActionableProposedPlan": false,
        "itemCount": 0,
        "visibleItemCount": 0,
        "createdAt": "2026-11-13T09:00:00.000Z",
        "updatedAt": "2026-11-13T09:00:00.000Z",
        "archivedAt": null,
        "settledOverride": null,
        "settledAt": null,
        "deletedAt": null
    });
    edit(&mut value);
    value
}

/// A top-level active thread. `edit` changes the JSON before it decodes.
pub(crate) fn thread(id: &str, project_id: &str, edit: impl FnOnce(&mut Value)) -> ThreadShell {
    let value = thread_json(id, project_id, edit);
    match from_json(value) {
        Ok(thread) => thread,
        Err(error) => panic!("test thread {id} does not decode: {error}"),
    }
}
