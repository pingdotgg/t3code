//! Project lookup for server workflows.
use serde_json::Value;
pub(crate) async fn resolve(
    engine: &dyn conn_engine::Engine,
    cwd: &str,
    thread: Option<&str>,
    explicit: Option<&str>,
) -> Option<Value> {
    let thread_project = if let Some(thread) = thread {
        engine
            .get_thread_projection(thread.into())
            .await
            .ok()
            .and_then(|p| {
                p.pointer("/thread/projectId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
    } else {
        None
    };
    let id = thread_project.as_deref().or(explicit);
    let projects = engine.projects_snapshot().await.ok()?;
    projects
        .iter()
        .find(|p| {
            p.get("deletedAt").is_none_or(Value::is_null)
                && match id {
                    Some(id) => p.get("id").and_then(Value::as_str) == Some(id),
                    None => p.get("workspaceRoot").and_then(Value::as_str) == Some(cwd),
                }
        })
        .cloned()
}
