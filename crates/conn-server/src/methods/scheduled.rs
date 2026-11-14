//! `scheduledTasks.*`: the service in `conn_features::scheduled`. Owner: the Conn-only areas
//! track. The webhook methods (`rotateWebhookToken`, `listWebhookDeliveries`,
//! `getWebhookDelivery`) stay unregistered: this server runs no webhook tasks.
//!
//! Scopes: `scopes.rs`. The T3 server hides webhook URLs from sessions without
//! `orchestration:operate`; no task here has one.

use conn_contract::{ScheduledTaskSetEnabledInput, to_json};
use conn_features::scheduled::{Failure as TaskFailure, ScheduledTasks, TaskError, UpsertInput};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::Deps;
use crate::table::{Failure, MethodTable};

/// `ScheduledTaskDeleteInput` and `ScheduledTaskRunNowInput`: `{id}`.
#[derive(Debug, Deserialize)]
struct IdInput {
    id: String,
}

fn task_failure(error: &TaskError) -> Failure {
    Failure::Fail(error.to_contract())
}

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(service) = deps.scheduled_tasks.clone() else {
        return;
    };

    let tasks = service.clone();
    table.stream("scheduledTasks.subscribe", move |_, _: Value| {
        let mut updates = tasks.subscribe();
        async move {
            let (tx, rx) = mpsc::channel(1);
            tokio::spawn(async move {
                while let Some(list) = updates.recv().await {
                    if tx.send(Ok(to_json(&list))).await.is_err() {
                        return;
                    }
                }
            });
            Ok(rx)
        }
    });

    let tasks = service.clone();
    table.unary("scheduledTasks.upsert", move |_, input: UpsertInput| {
        let tasks = tasks.clone();
        async move {
            match tasks.upsert(input).await {
                Ok(task) => Ok(json!({ "task": task })),
                Err(TaskFailure::Task(error)) => Err(task_failure(&error)),
                // A payload the contract's schema refuses: a defect, as Effect answers it.
                Err(TaskFailure::Invalid(message)) => Err(Failure::die(message)),
            }
        }
    });

    let tasks = service.clone();
    table.unary(
        "scheduledTasks.setEnabled",
        move |_, input: ScheduledTaskSetEnabledInput| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .set_enabled(&input.id, input.enabled)
                    .await
                    .map(|task| json!({ "task": task }))
                    .map_err(|e| task_failure(&e))
            }
        },
    );

    let tasks = service.clone();
    table.unary("scheduledTasks.delete", move |_, input: IdInput| {
        let tasks = tasks.clone();
        async move {
            tasks
                .delete(&input.id)
                .await
                .map(|id| json!({ "id": id }))
                .map_err(|e| task_failure(&e))
        }
    });

    let tasks: ScheduledTasks = service;
    table.unary("scheduledTasks.runNow", move |_, input: IdInput| {
        let tasks = tasks.clone();
        async move {
            // The contract's result is `{task}`; the thread is for `/mcp`.
            tasks
                .run_now(&input.id)
                .await
                .map(|outcome| json!({ "task": outcome.task }))
                .map_err(|e| task_failure(&e))
        }
    });
}
