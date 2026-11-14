//! Cases from `apps/server/src/annotations/AnnotationStore.test.ts`, in its order.

use std::{path::PathBuf, sync::Arc};

use conn_contract::{AnnotationCapture, AnnotationRemoveInputScope, from_json};
use conn_engine::BoxFuture;
use serde_json::{Value, json};

use super::{AnnotationError, Annotations, ProjectLookup, is_annotation_id};
use crate::clock::SystemClock;

const PROJECT: &str = "project:annotations";
const OTHER: &str = "project:other";

#[derive(Debug)]
struct Known;

impl ProjectLookup for Known {
    fn exists(&self, project_id: String) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move { Ok(project_id == PROJECT || project_id == OTHER) })
    }
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn store(name: &str) -> (Annotations, Dir) {
    let dir = std::env::temp_dir().join(format!(
        "conn-annotations-{name}-{}-{}",
        std::process::id(),
        conn_support::uuid_v4()
    ));
    (open(&dir), Dir(dir))
}

fn open(dir: &std::path::Path) -> Annotations {
    Annotations::new(dir, Arc::new(SystemClock), Arc::new(Known))
}

fn capture(id: &str) -> AnnotationCapture {
    with_comment(id, "Make it bigger")
}

fn with_comment(id: &str, comment: &str) -> AnnotationCapture {
    from_json(json!({"id": id, "comment": comment})).expect("capture")
}

fn ids(list: &Value) -> Vec<String> {
    list["annotations"]
        .as_array()
        .expect("list")
        .iter()
        .map(|a| a["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn numbers_new_annotations_and_keeps_the_number_when_one_is_edited() {
    let (store, _dir) = store("numbers");
    let first = store.create(PROJECT, capture("a")).await.expect("a");
    let second = store.create(PROJECT, capture("b")).await.expect("b");
    assert_eq!(
        (first["number"].clone(), second["number"].clone()),
        (json!(1), json!(2))
    );
    assert_eq!(first["status"], "todo");
    assert!(
        second["revision"].as_u64() > first["revision"].as_u64(),
        "revision rises"
    );
    store.claim(PROJECT, Some("a".into())).await.expect("claim");
    let edited = store
        .create(PROJECT, with_comment("a", "  Bigger  "))
        .await
        .expect("edit");
    assert_eq!(edited["number"], 1);
    assert_eq!(edited["comment"], "Bigger");
    assert_eq!(edited["status"], "in_progress");
    let other = store
        .create(OTHER, capture("a"))
        .await
        .expect("other project");
    assert_eq!(other["number"], 1);
    let list = store.list(PROJECT).await.expect("list");
    let pairs: Vec<(String, u64)> = list["annotations"]
        .as_array()
        .expect("array")
        .iter()
        .map(|a| {
            (
                a["id"].as_str().unwrap_or_default().to_owned(),
                a["number"].as_u64().unwrap_or(0),
            )
        })
        .collect();
    assert_eq!(pairs, [("a".to_owned(), 1), ("b".to_owned(), 2)]);
}

#[tokio::test(flavor = "current_thread")]
async fn refuses_an_empty_comment_an_unknown_project_and_a_removed_id() {
    let (store, _dir) = store("refuses");
    let empty = store.create(PROJECT, with_comment("a", "   ")).await;
    assert!(
        matches!(empty, Err(AnnotationError::Invalid { .. })),
        "{empty:?}"
    );
    let unknown = store.create("project:gone", capture("a")).await;
    assert!(
        matches!(unknown, Err(AnnotationError::ProjectNotFound { .. })),
        "{unknown:?}"
    );
    store.create(PROJECT, capture("a")).await.expect("a");
    let removed = store
        .remove(PROJECT, Some(vec!["a".into(), "missing".into()]), None)
        .await
        .expect("remove");
    assert_eq!(removed, ["a"]);
    let again = store.create(PROJECT, capture("a")).await;
    assert_eq!(again, Err(AnnotationError::Removed { id: "a".into() }));
    let next = store.create(PROJECT, capture("b")).await.expect("b");
    assert_eq!(next["number"], 2, "numbers are not reused");
}

#[tokio::test(flavor = "current_thread")]
async fn claims_the_oldest_todo_that_is_not_a_question_and_by_id_only_from_todo() {
    let (store, _dir) = store("claims");
    for id in ["a", "b", "c"] {
        store.create(PROJECT, capture(id)).await.expect("create");
    }
    let first = store
        .claim(PROJECT, None)
        .await
        .expect("claim")
        .expect("one");
    assert_eq!(first["id"], "a");
    store
        .release(PROJECT, "a".into(), Some("Which colour?".into()), true)
        .await
        .expect("question");
    let second = store
        .claim(PROJECT, None)
        .await
        .expect("claim")
        .expect("one");
    assert_eq!(
        (second["id"].clone(), second["status"].clone()),
        (json!("b"), json!("in_progress"))
    );
    assert!(second["claimedAt"].is_string());
    let conflict = store.claim(PROJECT, Some("b".into())).await;
    assert!(
        matches!(conflict, Err(AnnotationError::Conflict { .. })),
        "{conflict:?}"
    );
    let missing = store.claim(PROJECT, Some("zzz".into())).await;
    assert!(
        matches!(missing, Err(AnnotationError::NotFound { .. })),
        "{missing:?}"
    );
    let third = store
        .claim(PROJECT, None)
        .await
        .expect("claim")
        .expect("one");
    assert_eq!(third["id"], "c");
    assert_eq!(
        store.claim(PROJECT, None).await.expect("claim"),
        None,
        "nothing waits"
    );
    let answered = store
        .claim(PROJECT, Some("a".into()))
        .await
        .expect("claim")
        .expect("one");
    assert_eq!(answered["status"], "in_progress");
    assert!(answered.get("question").is_none(), "{answered}");
    assert!(answered.get("summary").is_none(), "{answered}");
}

#[tokio::test(flavor = "current_thread")]
async fn completes_and_releases_idempotently_and_only_from_in_progress() {
    let (store, _dir) = store("complete");
    store.create(PROJECT, capture("a")).await.expect("a");
    store.create(PROJECT, capture("b")).await.expect("b");
    let early = store
        .complete(PROJECT, "a".into(), Some("Done".into()))
        .await;
    assert!(
        matches!(early, Err(AnnotationError::Conflict { .. })),
        "{early:?}"
    );
    let unchanged = store
        .release(PROJECT, "a".into(), Some("Blocked".into()), false)
        .await
        .expect("release");
    assert_eq!(unchanged["status"], "todo");
    assert!(unchanged.get("summary").is_none());
    store.claim(PROJECT, Some("a".into())).await.expect("claim");
    let done = store
        .complete(
            PROJECT,
            "a".into(),
            Some("Made it bigger; lint passes.".into()),
        )
        .await
        .expect("done");
    assert_eq!(done["status"], "done");
    assert!(done["completedAt"].is_string());
    let again = store
        .complete(PROJECT, "a".into(), Some("Other".into()))
        .await
        .expect("again");
    assert_eq!(again, done, "unchanged");
    let late = store.release(PROJECT, "a".into(), None, false).await;
    assert!(
        matches!(late, Err(AnnotationError::Conflict { .. })),
        "{late:?}"
    );
    store.claim(PROJECT, Some("b".into())).await.expect("claim");
    let question = store
        .release(PROJECT, "b".into(), Some("  ".into()), true)
        .await;
    assert!(
        matches!(question, Err(AnnotationError::Invalid { .. })),
        "{question:?}"
    );
    let released = store
        .release(PROJECT, "b".into(), Some("Tests are red.".into()), false)
        .await
        .expect("released");
    assert_eq!(released["status"], "todo");
    assert_eq!(released["summary"], "Tests are red.");
    assert!(released.get("claimedAt").is_none());
    assert!(released.get("question").is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn removes_done_ones_or_everything_not_in_progress() {
    let (store, _dir) = store("scopes");
    for id in ["a", "b", "c"] {
        store.create(PROJECT, capture(id)).await.expect("create");
    }
    store.claim(PROJECT, Some("a".into())).await.expect("claim");
    store
        .complete(PROJECT, "a".into(), None)
        .await
        .expect("complete");
    store.claim(PROJECT, Some("b".into())).await.expect("claim");
    let done = store
        .remove(PROJECT, None, Some(AnnotationRemoveInputScope::Done))
        .await
        .expect("done");
    assert_eq!(done, ["a"]);
    let idle = store
        .remove(PROJECT, None, Some(AnnotationRemoveInputScope::Idle))
        .await
        .expect("idle");
    assert_eq!(idle, ["c"]);
    assert_eq!(ids(&store.list(PROJECT).await.expect("list")), ["b"]);
}

#[tokio::test(flavor = "current_thread")]
async fn reloads_records_numbers_and_removals_from_disk() {
    let (store, dir) = store("reload");
    store.create(PROJECT, capture("a")).await.expect("a");
    store.create(PROJECT, capture("b")).await.expect("b");
    store.claim(PROJECT, Some("b".into())).await.expect("claim");
    store
        .remove(PROJECT, Some(vec!["a".into()]), None)
        .await
        .expect("remove");
    let before = store.list(PROJECT).await.expect("list");
    let reopened = open(&dir.0);
    assert_eq!(reopened.list(PROJECT).await.expect("list"), before);
    let next = reopened.create(PROJECT, capture("c")).await.expect("c");
    assert_eq!(next["number"], 3);
    assert!(next["revision"].as_u64() > before["annotations"][0]["revision"].as_u64());
    let removed = reopened.create(PROJECT, capture("a")).await;
    assert_eq!(removed, Err(AnnotationError::Removed { id: "a".into() }));
}

#[tokio::test(flavor = "current_thread")]
async fn stores_the_screenshot_as_a_file_and_returns_its_path() {
    let (store, _dir) = store("screenshot");
    let bytes = b"not really a png";
    let mut shot = capture("a");
    shot.screenshot = Some(format!(
        "data:image/png;base64,{}",
        conn_support::base64::encode(bytes)
    ));
    let record = store.create(PROJECT, shot).await.expect("a");
    assert_eq!(record["hasScreenshot"], true);
    assert!(record.get("screenshot").is_none(), "{record}");
    let file = store
        .screenshot_path(PROJECT, "a".into())
        .await
        .expect("path")
        .expect("a file");
    assert!(file.ends_with("a.png"), "{}", file.display());
    assert_eq!(std::fs::read(&file).expect("read"), bytes);
    assert_eq!(
        store.screenshot_path(PROJECT, "missing".into()).await,
        Ok(None)
    );
    let mut invalid = capture("b");
    invalid.screenshot = Some("data:text/plain;base64,aGk=".into());
    assert!(matches!(
        store.create(PROJECT, invalid).await,
        Err(AnnotationError::Invalid { .. })
    ));
    store
        .remove(PROJECT, Some(vec!["a".into()]), None)
        .await
        .expect("remove");
    assert!(!file.exists(), "the screenshot goes with it");
}

#[tokio::test(flavor = "current_thread")]
async fn streams_the_list_on_subscribe_and_after_each_change_in_the_project() {
    let (store, _dir) = store("stream");
    let mut lists = store.subscribe(PROJECT).await.expect("subscribe");
    assert!(next(&mut lists).await.is_empty());
    store
        .create(OTHER, capture("elsewhere"))
        .await
        .expect("other");
    store.create(PROJECT, capture("a")).await.expect("a");
    assert_eq!(next(&mut lists).await, ["a:todo"]);
    store.claim(PROJECT, None).await.expect("claim");
    assert_eq!(next(&mut lists).await, ["a:in_progress"]);
}

async fn next(
    lists: &mut tokio::sync::mpsc::Receiver<Result<Value, AnnotationError>>,
) -> Vec<String> {
    let list = lists.recv().await.expect("item").expect("list");
    list["annotations"]
        .as_array()
        .expect("array")
        .iter()
        .map(|a| {
            format!(
                "{}:{}",
                a["id"].as_str().unwrap_or_default(),
                a["status"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

/// Ids name files: only the contract's id form gets a path.
#[test]
fn only_contract_ids_name_files() {
    for good in ["a", "A1_b-c", &"x".repeat(200)] {
        assert!(is_annotation_id(good), "{good}");
    }
    for bad in [
        "",
        "_a",
        "-a",
        "../a",
        "a/b",
        "a.b",
        "a b",
        &"x".repeat(201),
    ] {
        assert!(!is_annotation_id(bad), "{bad}");
    }
}

/// The T3 server's files are read as they are: a record it wrote loads here.
#[tokio::test(flavor = "current_thread")]
async fn reads_the_t3_servers_files() {
    let (store, dir) = store("t3-files");
    let folder = dir.0.join("annotations").join("project_annotations");
    std::fs::create_dir_all(&folder).expect("dir");
    std::fs::write(
        folder.join("_sequence.json"),
        r#"{"lastNumber":4,"revision":9}"#,
    )
    .expect("seq");
    std::fs::write(folder.join("_deleted.json"), r#"["gone"]"#).expect("deleted");
    std::fs::write(
        folder.join("t3.json"),
        json!({"id": "t3", "comment": "From T3", "projectId": PROJECT, "number": 4, "revision": 9,
               "status": "todo", "hasScreenshot": false, "createdAt": "2026-11-01T00:00:00.000Z"})
        .to_string(),
    )
    .expect("record");
    std::fs::write(folder.join("gone.json"), "{}").expect("stale");
    assert_eq!(ids(&store.list(PROJECT).await.expect("list")), ["t3"]);
    assert!(
        !folder.join("gone.json").exists(),
        "a stopped removal finishes"
    );
    let next = store.create(PROJECT, capture("new")).await.expect("new");
    assert_eq!(
        (next["number"].clone(), next["revision"].clone()),
        (json!(5), json!(10))
    );
}

#[derive(Debug)]
struct Any;

impl ProjectLookup for Any {
    fn exists(&self, _project_id: String) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async { Ok(true) })
    }
}

/// Every file under `dir`, with its bytes, outside `dir/annotations/<one folder>`.
fn files_outside_project_folders(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).expect("state dir") {
        let path = entry.expect("entry").path();
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if name == "annotations" {
            for inner in std::fs::read_dir(&path).expect("root") {
                let inner = inner.expect("entry").path();
                assert!(inner.is_dir(), "a file in the annotations root: {inner:?}");
            }
        } else {
            found.push((name, std::fs::read(&path).expect("read")));
        }
    }
    found.sort();
    found
}

/// Finding 1: no project id reaches a file outside its own folder under the annotations
/// root. The state files survive every call with every hostile id, and an id made only of
/// dots gets an escaped folder of its own.
#[tokio::test(flavor = "current_thread")]
async fn no_project_id_leaves_the_annotations_root() {
    let dir = std::env::temp_dir().join(format!(
        "conn-annotations-hostile-{}-{}",
        std::process::id(),
        conn_support::uuid_v4()
    ));
    let _guard = Dir(dir.clone());
    std::fs::create_dir_all(&dir).expect("dir");
    std::fs::write(dir.join("auth.json"), r#"{"version":1,"sessions":[]}"#).expect("auth");
    std::fs::write(dir.join("settings.json"), "{}").expect("settings");
    let before = files_outside_project_folders(&dir);
    let store = Annotations::new(&dir, Arc::new(SystemClock), Arc::new(Any));
    let long = "a".repeat(300);
    let hostile = [
        "..",
        ".",
        "...",
        "",
        "/",
        "../..",
        "../../etc",
        "a/../..",
        "/tmp",
        "\\..",
        "..\0",
        "\0",
        ".. ",
        " ..",
        "%2E%2E",
        "annotations",
        "~",
        long.as_str(),
    ];
    for id in hostile {
        for file in ["auth", "settings", "_sequence", "_deleted"] {
            if let Ok(created) = store.create(id, capture(file)).await {
                assert_eq!(created["projectId"], id);
            }
            let _ = store.list(id).await;
            let _ = store.claim(id, None).await;
            let _ = store.subscribe(id).await;
            let _ = store.screenshot_path(id, file.to_owned()).await;
            let _ = store.remove(id, Some(vec![file.into()]), None).await;
            let _ = store.remove(id, None, None).await;
        }
        assert_eq!(files_outside_project_folders(&dir), before, "id {id:?}");
    }
    let root = dir.join("annotations");
    assert!(root.join("%2E%2E").is_dir(), "`..` has its own folder");
    assert!(root.join("%2E").is_dir(), "`.` has its own folder");
    assert!(
        store.create("", capture("a")).await.is_err(),
        "an empty id names no folder"
    );
}

/// Finding 1: two ids that map to one folder share one lock and change counter.
#[tokio::test(flavor = "current_thread")]
async fn ids_that_share_a_folder_share_a_lock() {
    let (_, dir) = store("shared-lock");
    let store = Annotations::new(&dir.0, Arc::new(SystemClock), Arc::new(Any));
    store.create("a:b", capture("one")).await.expect("a:b");
    store.create("a_b", capture("two")).await.expect("a_b");
    let entries = store.inner.entries.lock().expect("entries").len();
    assert_eq!(entries, 1);
}

/// Finding 1: the engine refuses `.` and `..` as project ids.
#[tokio::test(flavor = "current_thread")]
async fn the_engine_refuses_dot_project_ids() {
    let dir = std::env::temp_dir().join(format!(
        "conn-annotations-dotdot-{}-{}",
        std::process::id(),
        conn_support::uuid_v4()
    ));
    let _guard = Dir(dir.clone());
    std::fs::create_dir_all(dir.join("repo")).expect("repo");
    let engine: Arc<dyn conn_engine::Engine> = Arc::new(
        conn_engine::SqliteEngine::open(conn_engine::EngineConfig::new(dir.join("engine.sqlite")))
            .expect("engine"),
    );
    for id in [".", ".."] {
        let created = engine
            .call(
                "projects.mutate",
                json!({"type": "project.create", "commandId": format!("c{id}"), "projectId": id,
                       "title": "x", "workspaceRoot": dir.join("repo").to_string_lossy()}),
            )
            .await;
        let Err(conn_engine::EngineError::Rejected(error)) = created else {
            panic!("`{id}` is refused as a contract error: {created:?}");
        };
        assert_eq!(error["cause"]["_tag"], "ProjectInvalidError", "{error}");
    }
}
