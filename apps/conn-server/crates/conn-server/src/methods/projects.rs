//! `projects.*` methods that add, change and remove projects, backed by
//! [`conn_engine::Engine::call`]. Owner: the engine track. The file methods of `projects.*`
//! (`readFile`, `listEntries`, ...) are the files track's, in `files.rs`.

use conn_contract::rpc::projects::{create_from_thread, create_new, ensure_scratch, mutate};

use super::Deps;
use super::orchestration::engine_unary;
use crate::table::MethodTable;

pub(super) fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(engine) = deps.engine.as_ref() else {
        return;
    };
    engine_unary::<mutate::Payload, mutate::Success, mutate::Error>(
        table,
        engine,
        "projects.mutate",
    );
    engine_unary::<ensure_scratch::Payload, ensure_scratch::Success, ensure_scratch::Error>(
        table,
        engine,
        "projects.ensureScratch",
    );
    engine_unary::<create_new::Payload, create_new::Success, create_new::Error>(
        table,
        engine,
        "projects.createNew",
    );
    engine_unary::<
        create_from_thread::Payload,
        create_from_thread::Success,
        create_from_thread::Error,
    >(table, engine, "projects.createFromThread");
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_engine::{Engine, EngineConfig, SqliteEngine};
    use serde_json::json;

    use super::*;
    use crate::table::{CallContext, Failure, Handler};

    #[tokio::test(flavor = "current_thread")]
    async fn project_methods_answer_in_contract_types() {
        let dir = std::env::temp_dir().join(format!("conn-server-projects-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo")).unwrap();
        let engine: Arc<dyn Engine> =
            Arc::new(SqliteEngine::open(EngineConfig::new(dir.join("engine.sqlite"))).unwrap());
        let deps = Deps {
            engine: Some(engine),
            ..Deps::default()
        };
        let mut table = MethodTable::new();
        register(&mut table, &deps);
        let Some(Handler::Unary(mutate)) = table.get("projects.mutate") else {
            panic!("projects.mutate is registered")
        };
        let root = dir.join("repo").to_string_lossy().into_owned();
        let project = mutate(
            CallContext::default(),
            json!({"type": "project.create", "commandId": "c1", "projectId": "p1",
                   "title": "Repo", "workspaceRoot": root}),
        )
        .await
        .unwrap();
        assert_eq!(project["workspaceRoot"], root.as_str());
        let Err(Failure::Fail(error)) = mutate(
            CallContext::default(),
            json!({"type": "project.update", "commandId": "c2", "projectId": "nope", "title": "X"}),
        )
        .await
        else {
            panic!("expected a typed failure")
        };
        assert_eq!(error["_tag"], "ProjectMutationError");
        assert_eq!(error["commandId"], "c2");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
