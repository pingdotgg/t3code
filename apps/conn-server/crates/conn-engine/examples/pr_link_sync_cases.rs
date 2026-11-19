//! Answers pull request link sync cases for `crates/conn-server/tools/pr-link-sync-diff.mjs`:
//! one JSON array of cases on stdin, one JSON array of answers on stdout. Each case runs the
//! link sweep (`conn_source_control::pull_requests::link_sync`) or the branch lookup minute by
//! minute on scripted host answers, and applies its own commands with this engine's deciders,
//! so a drift in what a sync writes shows up in a later step.

use std::io::Read;

use conn_engine::pull_request_sync::{decide_branch_sync, decide_link, decide_link_sync};
use conn_source_control::pull_requests::link_sync::{
    self, BranchProject, BranchSync, LinkSync, ReadFailure, Scope, StackNeed, StackRead,
};
use conn_support::time::iso_from_ms;
use serde_json::{Map, Value, json};

const MINUTE: u64 = 60_000;

fn strip(mut command: Value) -> Value {
    if let Some(map) = command.as_object_mut() {
        map.remove("commandId");
    }
    command
}

fn apply(threads: &mut [Value], command: &Value, now: &str) {
    for thread in threads.iter_mut() {
        if thread["id"] != command["threadId"] {
            continue;
        }
        let updated = match command["type"].as_str() {
            Some("thread.pull-request-link.sync") => decide_link_sync(thread, command),
            Some("thread.pull-request.link") => decide_link(thread, command, now),
            Some("thread.pull-request.sync") => Some(decide_branch_sync(thread, command, now)),
            _ => None,
        };
        if let Some(updated) = updated {
            *thread = updated;
        }
    }
}

/// One link sweep at `now` on the step's answers; returns the reads and the commands.
fn link_sweep(
    sync: &mut LinkSync,
    threads: &mut [Value],
    step: &Value,
    scope: Scope,
    now: u64,
) -> (Vec<Value>, Vec<Value>) {
    let iso = iso_from_ms(now);
    let mut reads = Vec::new();
    let mut commands = Vec::new();
    for group in sync.begin(threads, scope, now as f64) {
        let key = group
            .entries
            .first()
            .map(|e| link_sync::pull_request_key(&e.link))
            .unwrap_or_default();
        reads.push(json!(key));
        let answer = &step["summaries"][&key];
        match answer["error"].as_str() {
            Some("missing") => {
                sync.read_failed(&group, ReadFailure::Missing, now as f64);
                continue;
            }
            Some(_) => {
                sync.read_failed(&group, ReadFailure::Failed, now as f64);
                continue;
            }
            None => {}
        }
        let stack = match sync.stack_need(&group, answer) {
            StackNeed::Keep => StackRead::Kept,
            StackNeed::Unstacked => StackRead::Read(Value::Null),
            StackNeed::Read => {
                reads.push(json!(format!("stack {key}")));
                let stack = &step["stacks"][&key];
                match stack["error"].as_str() {
                    Some("rate-limited") => StackRead::Limited,
                    Some(_) => StackRead::Failed,
                    None => StackRead::Read(link_sync::native_stack(stack)),
                }
            }
        };
        let mut n = 0;
        for command in sync.finish(&group, answer, stack, now as f64, &iso, &mut || {
            n += 1;
            n.to_string()
        }) {
            apply(threads, &command, &iso);
            commands.push(strip(command));
        }
    }
    (reads, commands)
}

fn links_case(case: &Value) -> Value {
    let mut threads: Vec<Value> = case["threads"].as_array().cloned().unwrap_or_default();
    let mut sync = LinkSync::default();
    let mut now = case["start"].as_u64().unwrap_or(0);
    let steps = case["steps"].as_array().cloned().unwrap_or_default();
    // T3 sweeps once as it starts, on the first step's answers.
    let first = steps.first().cloned().unwrap_or(Value::Null);
    let (reads, commands) = link_sweep(&mut sync, &mut threads, &first, Scope::All, now);
    let mut out = vec![json!({"at": now, "reads": reads, "commands": commands})];
    for step in &steps {
        if let Some(keys) = step["request"].as_array() {
            for key in keys {
                sync.request(key.as_str().unwrap_or_default().to_owned());
            }
            let (reads, commands) =
                link_sweep(&mut sync, &mut threads, step, Scope::Requested, now);
            out.push(json!({"at": now, "reads": reads, "commands": commands}));
            continue;
        }
        for _ in 0..step["minutes"].as_u64().unwrap_or(1) {
            now += MINUTE;
            let (reads, commands) = link_sweep(&mut sync, &mut threads, step, Scope::All, now);
            out.push(json!({"at": now, "reads": reads, "commands": commands}));
        }
    }
    json!({"steps": out, "threads": threads})
}

fn branch_pass(
    sync: &mut BranchSync,
    threads: &mut [Value],
    case: &Value,
    thread: Option<&str>,
    now: u64,
) -> Value {
    let iso = iso_from_ms(now);
    let project = &case["project"];
    let target = BranchProject {
        id: project["id"].as_str().unwrap_or_default(),
        workspace_root: project["workspaceRoot"].as_str().unwrap_or_default(),
        repository: project["repository"].as_str().unwrap_or_default(),
    };
    let mut lookups = Vec::new();
    let mut commands = Vec::new();
    for group in sync.groups(threads, thread, now as f64) {
        let detected = match group.branch() {
            Some(branch) => {
                lookups.push(json!(branch));
                let found = case["detected"]
                    .get(branch)
                    .filter(|d| !d.is_null())
                    .cloned();
                sync.record(&group.key, now as f64, found.is_some());
                found
            }
            None => None,
        };
        let checked_out = detected.as_ref().is_some_and(|d| {
            link_sync::needs_checkout_check(&group, &target, Some(d))
                && case["checkedOut"].get(group.branch().unwrap_or_default()) == Some(&d["url"])
        });
        let mut previous = Map::new();
        for saved in link_sync::previous_to_check(&group, &target, detected.as_ref(), checked_out) {
            let url = saved["url"].as_str().unwrap_or_default();
            if let Some(summary) = case["previous"].get(url) {
                previous.insert(url.to_owned(), summary.clone());
            }
        }
        let mut n = 0;
        let plan = link_sync::plan_branch(
            &group,
            &target,
            detected.as_ref(),
            checked_out,
            &previous,
            case["snapshotSequence"].as_u64().unwrap_or(0),
            &mut || {
                n += 1;
                n.to_string()
            },
        );
        let writing: Vec<String> = plan.writing().into_iter().map(str::to_owned).collect();
        let writing: Vec<&str> = writing.iter().map(String::as_str).collect();
        sync.finish(&group, &plan.failed, &writing);
        for command in plan.commands {
            apply(threads, &command, &iso);
            if let Some(id) = command["threadId"].as_str() {
                sync.written(id);
            }
            commands.push(strip(command));
        }
    }
    json!({"at": now, "lookups": lookups, "commands": commands})
}

fn branch_case(case: &Value) -> Value {
    let mut threads: Vec<Value> = case["threads"].as_array().cloned().unwrap_or_default();
    let mut sync = BranchSync::default();
    let mut now = case["start"].as_u64().unwrap_or(0);
    sync.start_backfill(&threads);
    let mut out = vec![branch_pass(&mut sync, &mut threads, case, None, now)];
    for step in case["steps"].as_array().into_iter().flatten() {
        if let Some(thread) = step["thread"].as_str() {
            out.push(branch_pass(
                &mut sync,
                &mut threads,
                case,
                Some(thread),
                now,
            ));
            continue;
        }
        for _ in 0..step["minutes"].as_u64().unwrap_or(1) {
            now += MINUTE;
            out.push(branch_pass(&mut sync, &mut threads, case, None, now));
        }
    }
    json!({"steps": out, "threads": threads})
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        std::process::exit(2);
    }
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap_or_default();
    let answers: Vec<Value> = cases
        .iter()
        .map(|case| match case["kind"].as_str() {
            Some("branch") => branch_case(case),
            _ => links_case(case),
        })
        .collect();
    println!("{}", Value::Array(answers));
}
