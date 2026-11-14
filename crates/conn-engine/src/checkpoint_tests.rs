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
    config.stream_flush = Duration::from_millis(20);
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
