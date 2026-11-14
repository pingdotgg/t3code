//! Checkpoints per turn, diffs, rollback: the fake provider on scratch git repositories.

use std::path::PathBuf;

use super::*;

/// A scratch repository with one commit, removed on drop.
pub(super) struct Repo(PathBuf);

impl Repo {
    pub(super) fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-repo-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(dir).unwrap();
        let repo = Self(dir);
        repo.git(&["init", "-q", "-b", "main"]);
        repo.write("README.md", "hello\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-qm", "init"]);
        repo
    }

    /// A folder with no repository.
    pub(super) fn plain(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("conn-engine-plain-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(std::fs::canonicalize(dir).unwrap())
    }

    pub(super) fn root(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }

    pub(super) fn git(&self, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .current_dir(&self.0)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    pub(super) fn write(&self, path: &str, text: &str) {
        let file = self.0.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    pub(super) fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(path)).ok()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn open_repo(db: &TempDb, repo: &Repo) -> (SqliteEngine, Arc<FakeProvider>) {
    let provider = Arc::new(FakeProvider::new("claudeAgent"));
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: repo.root(),
    }];
    config.providers = vec![provider.clone()];
    config.checkpoints = true;
    (SqliteEngine::open(config).unwrap(), provider)
}

pub(super) fn create_in(repo: &Repo, thread: &str, command: &str) -> Value {
    let mut command = create(thread, command);
    command["projectId"] = json!(SqliteEngine::project_id_for(&repo.root()));
    command
}

/// Sends `text` and waits for the run to be final (a completed run waits for its checkpoint).
pub(super) async fn turn<E: serde::Serialize>(
    engine: &SqliteEngine,
    stream: &mut Subscription<conn_contract::ThreadStreamItem, E>,
    command: &str,
    text: &str,
) -> Vec<(String, Value)> {
    dispatch(engine, message("t1", command, text)).await;
    until_run_ends(stream).await
}

fn files(checkpoint: &Value) -> Vec<String> {
    checkpoint["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            format!(
                "{} {} +{} -{}",
                f["path"].as_str().unwrap(),
                f["kind"].as_str().unwrap(),
                f["additions"],
                f["deletions"]
            )
        })
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn each_turn_is_captured_as_the_t3_server_captures_it() {
    let db = TempDb::new("checkpoints");
    let repo = Repo::new("checkpoints");
    let (engine, _) = open_repo(&db, &repo);
    dispatch(&engine, create_in(&repo, "t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;

    let first = turn(&engine, &mut thread, "c2", "write a.txt one").await;
    let kinds = kinds(&first);
    assert!(
        kinds
            .iter()
            .any(|k| k == "checkpoint-scope.created root_run"),
        "the scope is created with the run: {kinds:?}"
    );
    assert!(
        kinds.contains(&"run.updated waiting".to_owned()),
        "a completed provider turn waits for its checkpoint: {kinds:?}"
    );
    let tail: Vec<&String> = kinds.iter().rev().take(4).collect();
    assert_eq!(
        tail,
        [
            "run.updated completed",
            "turn-item.updated checkpoint completed",
            "checkpoint.captured ready",
            "checkpoint.captured ready",
        ],
        "the capture command's events: {kinds:?}"
    );
    turn(&engine, &mut thread, "c3", "write b.txt two").await;

    let p = projection(&engine, "t1").await;
    let scopes = p["checkpointScopes"].as_array().unwrap();
    assert_eq!(scopes.len(), 1, "one root scope: {scopes:?}");
    let scope = &scopes[0];
    assert_eq!(
        scope["id"], "checkpoint-scope:thread:t1:name:root",
        "scope id"
    );
    assert_eq!(scope["kind"], "root_run", "kind");
    assert_eq!(scope["cwd"], repo.root(), "cwd");
    assert_eq!(scope["advancesAppRunCount"], true, "advances");

    let checkpoints = p["checkpoints"].as_array().unwrap();
    let by_ordinal = |n: u64| {
        checkpoints
            .iter()
            .find(|c| c["ordinalWithinScope"] == n)
            .unwrap_or_else(|| panic!("checkpoint {n}: {checkpoints:?}"))
    };
    assert_eq!(
        checkpoints.len(),
        3,
        "baseline and two turns: {checkpoints:?}"
    );
    let base = by_ordinal(0);
    assert_eq!(
        base["id"], "checkpoint:scope:checkpoint-scope%3Athread%3At1%3Aname%3Aroot:name:0",
        "id"
    );
    assert_eq!(base["status"], "ready", "baseline");
    assert!(
        base["runId"].is_null() && base["appRunOrdinal"].is_null(),
        "{base}"
    );
    let one = by_ordinal(1);
    assert_eq!(one["runId"], "run:t1:1", "run");
    assert_eq!(one["appRunOrdinal"], 1, "app ordinal");
    assert_eq!(one["parentCheckpointId"], base["id"], "parent");
    assert_eq!(files(one), ["a.txt modified +1 -0"], "turn 1 files");
    assert_eq!(
        files(by_ordinal(2)),
        ["b.txt modified +1 -0"],
        "turn 2 files"
    );
    assert!(
        one["ref"]
            .as_str()
            .unwrap()
            .starts_with("refs/t3/orchestration-v2/checkpoints/"),
        "{one}"
    );
    assert!(
        repo.git(&["show-ref"])
            .contains(one["ref"].as_str().unwrap()),
        "the ref is in the project's repository"
    );

    let runs = p["runs"].as_array().unwrap();
    for run in runs {
        assert_eq!(run["status"], "completed", "{run}");
        assert!(run["checkpointId"].is_string(), "{run}");
    }
    let item = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["type"] == "checkpoint" && i["runId"] == "run:t1:1")
        .expect("checkpoint item");
    let last_of_run = p["turnItems"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["runId"] == "run:t1:1" && i["type"] != "checkpoint")
        .filter_map(|i| i["ordinal"].as_u64())
        .max()
        .unwrap();
    assert!(
        item["ordinal"].as_u64().unwrap() > last_of_run,
        "the checkpoint item ends the turn (T3: run ordinal * 100 + 99): {item}"
    );
    assert_eq!(item["checkpointId"], one["id"], "item names the checkpoint");
    assert_eq!(
        item["id"],
        format!(
            "turn-item:provider:claudeAgent:native-item:{}",
            conn_support::ids::encode_component(&format!(
                "checkpoint:{}",
                one["id"].as_str().unwrap()
            ))
        ),
        "item id"
    );
    let node = p["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == runs[0]["rootNodeId"])
        .unwrap();
    assert_eq!(node["checkpointScopeId"], scope["id"], "{node}");
    assert_eq!(node["status"], "completed", "{node}");
    assert_eq!(
        repo.read("a.txt").as_deref(),
        Some("one\n"),
        "the turn's file"
    );
    assert!(
        !repo.git(&["status", "--porcelain"]).contains("A "),
        "the user's index is untouched"
    );
}

async fn call(engine: &SqliteEngine, method: &str, input: Value) -> Result<Value, Value> {
    match engine.call(method, input).await {
        Ok(value) => Ok(value),
        Err(EngineError::Rejected(e)) => Err(e),
        Err(EngineError::Internal(e)) => panic!("internal: {e}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn turn_and_full_thread_diffs_follow_get_turn_diff() {
    let db = TempDb::new("diffs");
    let repo = Repo::new("diffs");
    let (engine, _) = open_repo(&db, &repo);
    dispatch(&engine, create_in(&repo, "t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    turn(&engine, &mut thread, "c2", "write a.txt one").await;
    turn(&engine, &mut thread, "c3", "write b.txt two").await;

    let diff =
        |from: u64, to: u64| json!({"threadId": "t1", "fromTurnCount": from, "toTurnCount": to});
    let second = call(&engine, "orchestration.getTurnDiff", diff(1, 2))
        .await
        .unwrap();
    assert_eq!(second["threadId"], "t1", "{second}");
    assert_eq!(
        (
            second["fromTurnCount"].clone(),
            second["toTurnCount"].clone()
        ),
        (json!(1), json!(2)),
        "range"
    );
    let text = second["diff"].as_str().unwrap();
    assert!(
        text.contains("diff --git a/b.txt b/b.txt") && text.contains("+two"),
        "{text}"
    );
    assert!(!text.contains("a.txt"), "{text}");

    let full = call(
        &engine,
        "orchestration.getFullThreadDiff",
        json!({"threadId": "t1", "toTurnCount": 2}),
    )
    .await
    .unwrap();
    let text = full["diff"].as_str().unwrap();
    assert!(text.contains("+one") && text.contains("+two"), "{text}");
    assert_eq!(full["fromTurnCount"], 0, "from the thread start");

    let same = call(&engine, "orchestration.getTurnDiff", diff(2, 2))
        .await
        .unwrap();
    assert_eq!(same["diff"], "", "an empty range");
    let zero = call(
        &engine,
        "orchestration.getFullThreadDiff",
        json!({"threadId": "t1", "toTurnCount": 0}),
    )
    .await
    .unwrap();
    assert_eq!(zero["diff"], "", "nothing before the first turn");

    let past = call(&engine, "orchestration.getTurnDiff", diff(1, 3))
        .await
        .unwrap_err();
    assert_eq!(
        past,
        json!({"_tag": "OrchestrationGetTurnDiffError", "message": "Failed to load turn diff",
            "cause": {"_tag": "CheckpointTurnRangeUnavailableError",
                "message": "Checkpoint unavailable for thread t1 turn 3: Turn diff range exceeds current turn count: requested 3, current 2."}}),
        "past the last turn"
    );
    let unknown = call(
        &engine,
        "orchestration.getFullThreadDiff",
        json!({"threadId": "nope", "toTurnCount": 1}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        unknown["_tag"], "OrchestrationGetFullThreadDiffError",
        "{unknown}"
    );
    assert_eq!(
        unknown["message"], "Failed to load full thread diff",
        "{unknown}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_folder_without_git_records_missing_checkpoints() {
    let db = TempDb::new("no-git");
    let folder = Repo::plain("no-git");
    let (engine, _) = open_repo(&db, &folder);
    dispatch(&engine, create_in(&folder, "t1", "c1")).await;
    let mut thread = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut thread).await;
    turn(&engine, &mut thread, "c2", "write a.txt one").await;
    let p = projection(&engine, "t1").await;
    let statuses: Vec<_> = p["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["ordinalWithinScope"].clone(), c["status"].clone()))
        .collect();
    assert_eq!(
        statuses,
        [(json!(0), json!("missing")), (json!(1), json!("missing"))],
        "no repository"
    );
    assert_eq!(
        p["runs"][0]["status"], "completed",
        "the run still completes"
    );
    let err = call(
        &engine,
        "orchestration.getTurnDiff",
        json!({"threadId": "t1", "fromTurnCount": 0, "toTurnCount": 1}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        err["cause"]["_tag"], "CheckpointTurnRangeUnavailableError",
        "no ready checkpoint: {err}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_restart_finishes_a_run_left_waiting_for_its_checkpoint() {
    let db = TempDb::new("waiting-restart");
    let repo = Repo::new("waiting-restart");
    {
        let (engine, _) = open_repo(&db, &repo);
        dispatch(&engine, create_in(&repo, "t1", "c1")).await;
        let mut thread = engine
            .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
            .await
            .unwrap();
        next(&mut thread).await;
        turn(&engine, &mut thread, "c2", "write a.txt one").await;
        // A kill between the provider's end and the capture leaves the run waiting.
        engine.test_force_waiting("t1", "run:t1:1").await;
    }
    let (engine, _) = open_repo(&db, &repo);
    let mut done = false;
    for _ in 0..200 {
        let p = projection(&engine, "t1").await;
        if p["runs"][0]["status"] == "completed" {
            done = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(done, "the restart captures and completes the run");
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][0]["status"], "completed", "{}", p["runs"]);
    assert!(p["runs"][0]["checkpointId"].is_string(), "{}", p["runs"]);
}

// ---------------------------------------------------------------------------------------
// Rollback

/// A thread whose worktree is `repo`, so its files may be restored.
fn create_worktree_thread(repo: &Repo) -> Value {
    let mut command = create_in(repo, "t1", "c1");
    command["worktreePath"] = json!(repo.root());
    command["branch"] = json!("main");
    command
}

fn rollback(command: &str, checkpoint: &Value, restore_files: Option<bool>) -> Value {
    let mut command = json!({
        "type": "checkpoint.rollback", "commandId": command, "threadId": "t1",
        "scopeId": checkpoint["scopeId"], "checkpointId": checkpoint["id"],
    });
    if let Some(restore) = restore_files {
        command["restoreFiles"] = json!(restore);
    }
    command
}

fn checkpoint_at(p: &Value, ordinal: u64) -> Value {
    p["checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["ordinalWithinScope"] == ordinal)
        .cloned()
        .unwrap_or_else(|| panic!("checkpoint {ordinal}"))
}

/// Waits until `done` holds for the thread's projection.
async fn until(engine: &SqliteEngine, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..250 {
        let p = projection(engine, "t1").await;
        if done(&p) {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "the thread never got there: {}",
        projection(engine, "t1").await
    )
}

async fn with_turns(
    db: &TempDb,
    repo: &Repo,
    provider: FakeProvider,
    thread: Value,
    texts: &[&str],
) -> (SqliteEngine, Arc<FakeProvider>) {
    let provider = Arc::new(provider);
    let mut config = EngineConfig::new(db.path());
    config.projects = vec![ProjectConfig {
        title: "Project".into(),
        workspace_root: repo.root(),
    }];
    config.providers = vec![provider.clone()];
    config.checkpoints = true;
    let engine = SqliteEngine::open(config).unwrap();
    dispatch(&engine, thread).await;
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    for (i, text) in texts.iter().enumerate() {
        turn(&engine, &mut stream, &format!("turn-{i}"), text).await;
    }
    (engine, provider)
}

#[tokio::test(flavor = "current_thread")]
async fn rollback_restores_files_cuts_later_runs_and_rolls_the_provider_back() {
    let db = TempDb::new("rollback");
    let repo = Repo::new("rollback");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_worktree_thread(&repo),
        &["write a.txt one", "write b.txt two", "write c.txt three"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    let (two, three) = (checkpoint_at(&p, 2), checkpoint_at(&p, 3));
    let target = checkpoint_at(&p, 1);
    dispatch(&engine, rollback("rb-1", &target, None)).await;

    let p = until(&engine, |p| p["runs"][2]["status"] == "rolled_back").await;
    assert_eq!(
        p["thread"]["rollbackRequestId"], "rb-1",
        "the request is the thread's"
    );
    assert!(p["thread"]["rollbackFailure"].is_null(), "{}", p["thread"]);
    let statuses: Vec<_> = p["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["status"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        statuses,
        ["completed", "rolled_back", "rolled_back"],
        "runs after the target"
    );
    for n in [2, 3] {
        assert_eq!(checkpoint_at(&p, n)["status"], "stale", "checkpoint {n}");
    }
    assert_eq!(
        *provider.rollbacks.lock().unwrap(),
        ["turn 1"],
        "the provider rolled back"
    );
    let pt = &p["providerThreads"][0];
    assert_eq!(pt["lastRunOrdinal"], 1, "{pt}");
    assert_eq!(repo.read("a.txt").as_deref(), Some("one\n"), "kept");
    assert_eq!(repo.read("b.txt"), None, "removed");
    assert_eq!(repo.read("c.txt"), None, "removed");
    let refs = repo.git(&["show-ref"]);
    assert!(
        !refs.contains(two["ref"].as_str().unwrap()),
        "stale ref deleted"
    );
    assert!(
        !refs.contains(three["ref"].as_str().unwrap()),
        "stale ref deleted"
    );
    let kinds: Vec<String> = engine
        .test_events("t1")
        .await
        .into_iter()
        .map(|(ty, _)| ty)
        .collect();
    assert!(
        kinds.contains(&"checkpoint.rollback-requested".to_owned()),
        "{kinds:?}"
    );

    // The thread goes on from the restored workspace.
    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t1"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    turn(&engine, &mut stream, "c9", "write d.txt four").await;
    let p = projection(&engine, "t1").await;
    assert_eq!(p["runs"][3]["status"], "completed", "{}", p["runs"]);
}

#[tokio::test(flavor = "current_thread")]
async fn rollback_to_the_thread_start_and_a_conversation_only_rewind() {
    let db = TempDb::new("rollback-start");
    let repo = Repo::new("rollback-start");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_in(&repo, "t1", "c1"),
        &["write a.txt one", "write b.txt two"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    let start = checkpoint_at(&p, 0);
    // A thread in the project root shares its folder: no file restore.
    let refused = engine
        .dispatch(from_json(rollback("rb-1", &start, None)).unwrap())
        .await;
    let Err(EngineError::Rejected(error)) = refused else {
        panic!("a file restore outside a worktree is refused")
    };
    assert!(
        to_json(&error)["message"]
            .as_str()
            .unwrap()
            .contains("File restore requires an isolated worktree."),
        "{}",
        to_json(&error)
    );
    dispatch(&engine, rollback("rb-2", &start, Some(false))).await;
    let p = until(&engine, |p| p["runs"][1]["status"] == "rolled_back").await;
    assert_eq!(p["runs"][0]["status"], "rolled_back", "every run");
    assert_eq!(
        *provider.rollbacks.lock().unwrap(),
        ["start"],
        "to the thread start"
    );
    assert!(
        p["providerThreads"][0]["lastRunOrdinal"].is_null(),
        "no run left"
    );
    assert_eq!(repo.read("b.txt").as_deref(), Some("two\n"), "files stay");
}

/// A message sent right after a rollback starts its turn only after the rollback ended, as
/// T3's effect outbox runs a thread's effects in order (`thread_rollback_after_restart`).
#[tokio::test(flavor = "current_thread")]
async fn a_turn_sent_during_a_rollback_starts_after_it() {
    let db = TempDb::new("rollback-then-send");
    let repo = Repo::new("rollback-then-send");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_in(&repo, "t1", "c1"),
        &["write a.txt one", "write b.txt two"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    let first = checkpoint_at(&p, 1);
    dispatch(&engine, rollback("rb-1", &first, Some(false))).await;
    dispatch(&engine, message("t1", "c3", "after")).await;
    let p = until(&engine, |p| p["runs"][2]["status"] == "completed").await;
    assert_eq!(p["runs"][1]["status"], "rolled_back", "{}", p["runs"]);
    assert_eq!(*provider.rollbacks.lock().unwrap(), ["turn 1"]);
    let events = engine.test_events("t1").await;
    let rolled_back = events
        .iter()
        .position(|(kind, payload)| kind == "run.updated" && payload["status"] == "rolled_back")
        .unwrap();
    let started = events
        .iter()
        .position(|(kind, payload)| kind == "run-attempt.created" && payload["runId"] == "run:t1:3")
        .unwrap();
    assert!(
        rolled_back < started,
        "the rollback commits before the next turn starts"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_failed_provider_rollback_changes_nothing_and_tells_the_client() {
    let db = TempDb::new("rollback-fail");
    let repo = Repo::new("rollback-fail");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent").with_failing_rollback(),
        create_worktree_thread(&repo),
        &["write a.txt one", "write b.txt two"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    dispatch(&engine, rollback("rb-1", &checkpoint_at(&p, 1), None)).await;
    let p = until(&engine, |p| p["thread"]["rollbackFailure"].is_object()).await;
    assert_eq!(
        p["thread"]["rollbackFailure"],
        json!({"requestId": "rb-1", "message": "The provider could not roll back this conversation. Try again; if it keeps failing, check the provider and server logs."}),
        "T3's message"
    );
    assert_eq!(p["runs"][1]["status"], "completed", "nothing rolled back");
    assert_eq!(
        repo.read("b.txt").as_deref(),
        Some("two\n"),
        "files untouched"
    );
    assert_eq!(
        provider.rollbacks.lock().unwrap().len(),
        5,
        "tried five times, as T3's effect worker"
    );
}

/// A rollback that fails and then works is not reported, and the send after it waits for it.
#[tokio::test(flavor = "current_thread")]
async fn a_rollback_that_fails_twice_then_works_is_retried() {
    let db = TempDb::new("rollback-retry");
    let repo = Repo::new("rollback-retry");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent").with_rollback_failures(2),
        create_in(&repo, "t1", "c1"),
        &["write a.txt one", "write b.txt two"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    dispatch(
        &engine,
        rollback("rb-1", &checkpoint_at(&p, 1), Some(false)),
    )
    .await;
    dispatch(&engine, message("t1", "c3", "after")).await;
    let p = until(&engine, |p| p["runs"][2]["status"] == "completed").await;
    assert_eq!(p["runs"][1]["status"], "rolled_back", "{}", p["runs"]);
    assert!(p["thread"]["rollbackFailure"].is_null(), "{}", p["thread"]);
    let calls = provider.calls.lock().unwrap().clone();
    assert_eq!(
        calls[calls.len() - 5..],
        [
            "rollback",
            "rollback",
            "rollback",
            "rolled back",
            "start run:t1:3"
        ]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn rollback_refuses_a_busy_or_unknown_target() {
    let db = TempDb::new("rollback-refuse");
    let repo = Repo::new("rollback-refuse");
    let (engine, _) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_worktree_thread(&repo),
        &["write a.txt one"],
    )
    .await;
    let p = projection(&engine, "t1").await;
    let mut unknown = checkpoint_at(&p, 1);
    unknown["id"] = json!("checkpoint:nope");
    let refused = engine
        .dispatch(from_json(rollback("rb-1", &unknown, None)).unwrap())
        .await;
    let Err(EngineError::Rejected(error)) = refused else {
        panic!("unknown checkpoint")
    };
    assert!(
        to_json(&error)["message"]
            .as_str()
            .unwrap()
            .contains("Checkpoint checkpoint:nope was not found."),
        "{}",
        to_json(&error)
    );
}

// ---------------------------------------------------------------------------------------
// Fork

fn refused<T, E: serde::Serialize>(result: Result<T, EngineError<E>>) -> String {
    match result {
        Err(EngineError::Rejected(e)) => to_json(&e)["message"].as_str().unwrap().to_owned(),
        _ => panic!("expected a refusal"),
    }
}

fn fork(command: &str, source_point: Value) -> Value {
    json!({
        "type": "thread.fork", "commandId": command, "sourceThreadId": "t1",
        "targetThreadId": "t2", "sourcePoint": source_point,
        "createdBy": "user", "creationSource": "web",
    })
}

#[tokio::test(flavor = "current_thread")]
async fn a_fork_starts_from_the_source_run_with_a_native_fork() {
    let db = TempDb::new("fork");
    let repo = Repo::new("fork");
    let (engine, provider) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_in(&repo, "t1", "c1"),
        &["write a.txt one", "write b.txt two"],
    )
    .await;
    dispatch(
        &engine,
        fork("f1", json!({"type": "run", "runId": "run:t1:1"})),
    )
    .await;
    let fork_view = projection(&engine, "t2").await;
    let thread = &fork_view["thread"];
    assert_eq!(thread["title"], "New thread fork", "{thread}");
    assert_eq!(
        thread["lineage"],
        json!({"parentThreadId": "t1", "relationshipToParent": "fork", "rootThreadId": "t1"}),
        "lineage"
    );
    assert_eq!(
        thread["forkedFrom"],
        json!({"type": "run", "threadId": "t1", "runId": "run:t1:1"}),
        "forkedFrom"
    );
    assert!(thread["activeProviderThreadId"].is_null(), "{thread}");
    let transfer = &fork_view["contextTransfers"][0];
    assert_eq!(transfer["type"], "fork", "{transfer}");
    assert_eq!(transfer["status"], "pending", "{transfer}");
    assert_eq!(transfer["sourcePoint"]["runId"], "run:t1:1", "{transfer}");
    assert!(
        transfer["id"]
            .as_str()
            .unwrap()
            .starts_with("context-transfer:type:fork:source-thread:t1:target-thread:t2:"),
        "{transfer}"
    );

    let mut stream = engine
        .subscribe_thread(from_json(json!({"threadId": "t2"})).unwrap())
        .await
        .unwrap();
    next(&mut stream).await;
    let mut first = message("t2", "f2", "go on");
    first["threadId"] = json!("t2");
    dispatch(&engine, first).await;
    until_run_ends(&mut stream).await;
    let fork_view = projection(&engine, "t2").await;
    assert_eq!(
        *provider.forks.lock().unwrap(),
        ["t2 turn:run:t1:1"],
        "the provider forked from the source run's turn"
    );
    assert_eq!(
        fork_view["runs"][0]["status"], "completed",
        "{}",
        fork_view["runs"]
    );
    assert_eq!(
        fork_view["thread"]["activeProviderThreadId"], "provider-thread:t2",
        "the forked native thread"
    );
    let transfer = &fork_view["contextTransfers"][0];
    assert_eq!(transfer["status"], "consumed", "{transfer}");
    assert_eq!(transfer["targetRunId"], "run:t2:1", "{transfer}");
    assert_eq!(
        transfer["resolution"]["strategy"], "native_fork",
        "{transfer}"
    );
    assert_eq!(
        transfer["resolution"]["providerThreadRef"]["nativeId"], "native-fork-t2",
        "{transfer}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_fork_refuses_a_missing_source_or_a_taken_target() {
    let db = TempDb::new("fork-refuse");
    let repo = Repo::new("fork-refuse");
    let (engine, _) = with_turns(
        &db,
        &repo,
        FakeProvider::new("claudeAgent"),
        create_in(&repo, "t1", "c1"),
        &["write a.txt one"],
    )
    .await;
    let missing = engine
        .dispatch(from_json(fork("f1", json!({"type": "run", "runId": "run:t1:9"}))).unwrap())
        .await;
    assert!(
        refused(missing).contains("No stable source run was found for fork source run."),
        "unknown run"
    );
    dispatch(&engine, create_in(&repo, "t2", "c2")).await;
    let taken = engine
        .dispatch(from_json(fork("f2", json!({"type": "latest_stable"}))).unwrap())
        .await;
    assert!(refused(taken).contains("t2"), "the target exists");
}
