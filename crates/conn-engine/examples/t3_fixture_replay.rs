//! The Rust half of `tools/t3-fixture-replay/check.mjs`: runs one T3 `testkit` fixture's
//! scenario steps through this engine and a real provider, and writes what T3's
//! `runOrchestratorV2Scenario` returns, so T3's own assertions can run on it.
//!
//! `cargo run -p conn-engine --example t3_fixture_replay -- <plan.json>`
//!
//! The plan holds the steps T3's `materializeFixtureInput` made (run ids already in this
//! engine's form), the replay workspace, the runtime policy override and the provider's stub
//! binary. The provider talks to a stub executable that replays the recorded transcript; no
//! model is called. The result file holds every stored event (the log is never pruned), each
//! thread's projection, the shell snapshot and the snapshots the steps captured.
//!
//! A step this driver cannot run (the replay gate, a held run) ends the run with an error
//! that names it; the check then reports the fixture as failed for that reason.

#![expect(
    clippy::print_stderr,
    reason = "a test tool: its errors go to the check's log"
)]

use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use conn_contract::from_json;
use conn_engine::{Engine, EngineConfig, RuntimePolicyOverride, SqliteEngine};
use conn_provider::Provider;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

/// T3's `SCENARIO_WAIT_DEADLINE_MS`.
const WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(5);

type Failure = String;

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, Failure> {
    value.get(key).ok_or_else(|| format!("plan: missing {key}"))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Failure> {
    field(value, key)?
        .as_str()
        .ok_or_else(|| format!("plan: {key} is not a string"))
}

fn provider(plan: &Value) -> Result<Arc<dyn Provider>, Failure> {
    let driver = text(plan, "driver")?;
    match driver {
        "codex" => {
            let config = conn_provider_codex::CodexConfig {
                binary: PathBuf::from(text(plan, "binary")?),
                home_path: Some(PathBuf::from(text(plan, "providerHome")?)),
                ..conn_provider_codex::CodexConfig::default()
            };
            Ok(Arc::new(conn_provider_codex::CodexProvider::new(
                "codex".into(),
                config,
            )))
        }
        other => Err(format!("driver {other} is not offered by this replay")),
    }
}

struct Run {
    engine: Arc<SqliteEngine>,
    background: HashMap<String, JoinHandle<Result<(), Failure>>>,
    anonymous: usize,
    captured: Map<String, Value>,
}

const ACTIVE: [&str; 5] = ["preparing", "queued", "starting", "running", "waiting"];

impl Run {
    async fn projection(&self, thread_id: &str) -> Result<Value, Failure> {
        self.engine
            .get_thread_projection(thread_id.into())
            .await
            .map_err(|e| format!("getThreadProjection {thread_id}: {e:?}"))
    }

    async fn shell(&self) -> Result<Value, Failure> {
        self.engine
            .shell_snapshot()
            .await
            .map_err(|e| format!("shell snapshot: {e:?}"))
    }

    /// Polls `check` on the thread's projection until it holds, or fails with `step`.
    async fn wait_for(
        &self,
        thread_id: &str,
        step: &str,
        check: impl Fn(&Value) -> bool,
    ) -> Result<Value, Failure> {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let projection = self.projection(thread_id).await?;
            if check(&projection) {
                return Ok(projection);
            }
            if tokio::time::Instant::now() >= deadline {
                let runs: Vec<String> = rows(&projection, "runs")
                    .map(|r| format!("{}:{}", r["id"], r["status"]))
                    .collect();
                return Err(format!("{step}: runs={}", runs.join(",")));
            }
            tokio::time::sleep(POLL).await;
        }
    }

    async fn dispatch(engine: &SqliteEngine, command: &Value) -> Result<(), Failure> {
        let typed = from_json(command.clone()).map_err(|e| format!("command decode: {e}"))?;
        engine
            .dispatch(typed)
            .await
            .map(|_| ())
            .map_err(|e| format!("dispatch {}: {e:?}", command["type"]))
    }

    async fn await_key(&mut self, key: &str) -> Result<(), Failure> {
        let handle = self
            .background
            .remove(key)
            .ok_or_else(|| format!("await:{key}"))?;
        handle.await.map_err(|e| format!("await {key}: {e}"))?
    }

    async fn step(&mut self, step: &Value) -> Result<(), Failure> {
        let kind = text(step, "type")?;
        let thread = || text(step, "threadId");
        let run_id = || text(step, "runId");
        match kind {
            "dispatch" => {
                let command = field(step, "command")?;
                if step["await"].as_bool().unwrap_or(true) {
                    return Self::dispatch(&self.engine, command).await;
                }
                self.anonymous += 1;
                let key = step["key"]
                    .as_str()
                    .map_or_else(|| format!("dispatch:{}", self.anonymous), str::to_owned);
                let engine = self.engine.clone();
                let command = command.clone();
                self.background.insert(
                    key,
                    tokio::spawn(async move { Self::dispatch(&engine, &command).await }),
                );
                Ok(())
            }
            "await" => self.await_key(text(step, "key")?).await,
            "await_all" => {
                let mut keys: Vec<String> = self.background.keys().cloned().collect();
                keys.sort();
                for key in keys {
                    self.await_key(&key).await?;
                }
                Ok(())
            }
            "advance_clock" => {
                if step.get("awaitProviderSessionRelease").is_some() {
                    return Err("advance_clock: an idle release on a test clock".into());
                }
                Ok(())
            }
            "await_thread_idle" => {
                let tid = thread()?;
                self.wait_for(tid, &format!("await_thread_idle:{tid}"), |p| {
                    !rows(p, "runs").any(|r| ACTIVE.contains(&r["status"].as_str().unwrap_or("")))
                })
                .await
                .map(drop)
            }
            "await_no_background_work" => {
                let tid = thread()?.to_owned();
                let deadline = tokio::time::Instant::now() + WAIT;
                loop {
                    let shell = self.shell().await?;
                    let pending = shell["threads"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|t| t["id"] == tid.as_str())
                        .and_then(|t| t["pendingBackgroundTasks"].as_array())
                        .map_or(0, Vec::len);
                    if pending == 0 {
                        return Ok(());
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(format!("await_no_background_work:{tid}:pending={pending}"));
                    }
                    tokio::time::sleep(POLL).await;
                }
            }
            "await_run_steerable" => {
                let rid = run_id()?.to_owned();
                self.wait_for(thread()?, &format!("await_run_steerable:{rid}"), |p| {
                    let Some(run) = rows(p, "runs").find(|r| r["id"] == rid.as_str()) else {
                        return false;
                    };
                    run["status"] == "running"
                        && !run["activeAttemptId"].is_null()
                        && rows(p, "providerTurns").any(|t| {
                            t["runAttemptId"] == run["activeAttemptId"] && t["status"] == "running"
                        })
                })
                .await
                .map(drop)
            }
            "await_run_status" => {
                let rid = run_id()?.to_owned();
                let status = text(step, "status")?.to_owned();
                self.wait_for(
                    thread()?,
                    &format!("await_run_status:{rid}:{status}"),
                    |p| rows(p, "runs").any(|r| r["id"] == rid.as_str() && r["status"] == status.as_str()),
                )
                .await
                .map(drop)
            }
            "await_run_turn_item" => {
                let rid = run_id()?.to_owned();
                let item_type = text(step, "itemType")?.to_owned();
                let status = step["itemStatus"].as_str().map(str::to_owned);
                let matches = |item: &Value| {
                    item["type"] == item_type.as_str()
                        && status.as_ref().is_none_or(|s| item["status"] == s.as_str())
                };
                let tid = thread()?.to_owned();
                let name = format!("await_run_turn_item:{rid}:{item_type}");
                if step["inSubagentThreads"] == true {
                    let deadline = tokio::time::Instant::now() + WAIT;
                    loop {
                        let projection = self.projection(&tid).await?;
                        for subagent in rows(&projection, "subagents") {
                            let Some(child) = subagent["childThreadId"].as_str() else {
                                continue;
                            };
                            if subagent["runId"] != rid.as_str() {
                                continue;
                            }
                            if rows(&self.projection(child).await?, "turnItems").any(matches) {
                                return Ok(());
                            }
                        }
                        if tokio::time::Instant::now() >= deadline {
                            return Err(name);
                        }
                        tokio::time::sleep(POLL).await;
                    }
                }
                self.wait_for(&tid, &name, |p| {
                    rows(p, "turnItems").any(|i| i["runId"] == rid.as_str() && matches(i))
                })
                .await
                .map(drop)
            }
            "capture_shell_snapshot" => {
                let snapshot = self.shell().await?;
                self.captured.insert(text(step, "key")?.to_owned(), snapshot);
                Ok(())
            }
            "respond_to_next_runtime_request" => {
                let tid = thread()?;
                let projection = self
                    .wait_for(tid, &format!("respond_to_next_runtime_request:{tid}"), |p| {
                        rows(p, "runtimeRequests").any(|r| r["status"] == "pending")
                    })
                    .await?;
                if let Some(key) = step["shellSnapshotKeyWhilePending"].as_str() {
                    let snapshot = self.shell().await?;
                    self.captured.insert(key.to_owned(), snapshot);
                }
                let request = rows(&projection, "runtimeRequests")
                    .find(|r| r["status"] == "pending")
                    .ok_or("no pending request")?;
                let mut command = json!({
                    "type": "runtime-request.respond",
                    "commandId": step["commandId"],
                    "threadId": tid,
                    "requestId": request["id"],
                });
                for key in ["decision", "answers"] {
                    if let Some(value) = step.get(key) {
                        command[key] = value.clone();
                    }
                }
                Self::dispatch(&self.engine, &command).await
            }
            other => Err(format!("{other}: not run by this replay driver")),
        }
    }
}

fn rows<'a>(projection: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    projection[key].as_array().into_iter().flatten()
}

async fn replay(plan: &Value) -> Result<Value, Value> {
    let state = PathBuf::from(text(plan, "stateDir").map_err(Value::String)?);
    let mut config = EngineConfig::new(state.join("state.sqlite"));
    config.home = Some(state.clone());
    // No project: T3's fixtures name a project its store never saw, and the turn's folder
    // comes from the policy override, as in T3's harness.
    config.providers = vec![provider(plan).map_err(Value::String)?];
    config.checkpoints = true;
    let policy = &plan["runtimePolicyOverride"];
    config.runtime_policy_override = Some(RuntimePolicyOverride {
        cwd: policy["cwd"].as_str().map(str::to_owned),
        approval_policy: policy.get("approvalPolicy").cloned(),
        sandbox_policy: policy.get("sandboxPolicy").cloned(),
    });
    let engine = Arc::new(SqliteEngine::open(config).map_err(Value::String)?);
    let mut run = Run {
        engine: engine.clone(),
        background: HashMap::new(),
        anonymous: 0,
        captured: Map::new(),
    };
    let steps = field(plan, "steps").map_err(Value::String)?.clone();
    let mut failure = None;
    for (index, step) in steps.as_array().into_iter().flatten().enumerate() {
        if let Err(e) = run.step(step).await {
            failure = Some(format!("step {index} ({}): {e}", step["type"]));
            break;
        }
    }
    if failure.is_none() {
        let mut keys: Vec<String> = run.background.keys().cloned().collect();
        keys.sort();
        for key in keys {
            if let Err(e) = run.await_key(&key).await {
                failure = Some(e);
                break;
            }
        }
    }
    let result = collect(&run, plan).await;
    engine.shutdown().await;
    match (failure, result) {
        (None, Ok(result)) => Ok(result),
        (Some(f), Ok(mut result)) => {
            result["error"] = json!(f);
            Err(result)
        }
        (Some(f), Err(e)) => Err(json!({"error": format!("{f}; then {e}")})),
        (None, Err(e)) => Err(json!({"error": e})),
    }
}

/// What `runOrchestratorV2Scenario` returns: stored events, projections of the scenario's
/// threads and every thread in the shell, the shell snapshot, the captured snapshots.
async fn collect(run: &Run, plan: &Value) -> Result<Value, Failure> {
    let shell = run.shell().await?;
    let mut ids: Vec<String> = plan["projectionThreadIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    for thread in shell["threads"].as_array().into_iter().flatten() {
        if let Some(id) = thread["id"].as_str()
            && !ids.iter().any(|i| i == id)
        {
            ids.push(id.to_owned());
        }
    }
    let mut projections = Map::new();
    for id in ids {
        let projection = run.projection(&id).await?;
        projections.insert(id, projection);
    }
    let mut events = vec![];
    loop {
        let after = events
            .last()
            .and_then(|e: &Value| e["sequence"].as_u64())
            .unwrap_or(0);
        let page = run.engine.stored_events(after, 500).await?;
        let done = page.len() < 500;
        events.extend(page);
        if done {
            break;
        }
    }
    Ok(json!({
        "storedEvents": events,
        "projections": projections,
        "shellSnapshot": shell,
        "capturedShellSnapshots": run.captured,
    }))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: t3_fixture_replay <plan.json>");
        std::process::exit(2);
    };
    let plan: Value = match std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
    {
        Ok(plan) => plan,
        Err(e) => {
            eprintln!("{path}: {e}");
            std::process::exit(2);
        }
    };
    let (code, result) = match replay(&plan).await {
        Ok(result) => (0, result),
        Err(result) => (1, result),
    };
    let out = plan["out"].as_str().unwrap_or("result.json");
    if let Err(e) = std::fs::write(out, result.to_string()) {
        eprintln!("{out}: {e}");
        std::process::exit(2);
    }
    std::process::exit(code);
}
