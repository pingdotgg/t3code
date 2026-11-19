//! Answers pull request watch cases for `tools/pr-watch-diff.mjs`: one JSON array of cases on
//! stdin, one JSON array of answers on stdout, in the shape T3's `pullRequestWatch.ts` returns.

use std::io::Read;

use conn_source_control::pull_requests::watch::{self, Wake};
use serde_json::{Value, json};

fn wake_json(wake: &Wake) -> Value {
    json!({"text": wake.text, "notification": wake.notification()})
}

fn answer(case: &Value) -> Value {
    match case["kind"].as_str() {
        Some("snippet") => json!(watch::snippet(case["body"].as_str().unwrap_or_default())),
        Some("combine") => {
            let wakes: Vec<Wake> = case["wakes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|w| Wake {
                    text: w["text"].as_str().unwrap_or_default().to_owned(),
                    outcome: match w["notification"]["outcome"].as_str() {
                        Some("failed") => "failed",
                        Some("completed") => "completed",
                        _ => "updated",
                    },
                    summary: w["notification"]["summary"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                })
                .collect();
            watch::combine(&wakes).map_or(Value::Null, |w| wake_json(&w))
        }
        _ => {
            let mut current = case["watch"].clone();
            let mut out = Vec::new();
            for step in case["steps"].as_array().into_iter().flatten() {
                let remarks = step["remarks"].as_array().map(Vec::as_slice);
                let now = step["now"].as_f64().unwrap_or(0.0);
                let report = watch::evaluate(&current, &step["detail"], remarks, now);
                let wake = (!report.changes.is_empty()).then(|| {
                    wake_json(&watch::message(
                        case["number"].as_u64().unwrap_or(1),
                        case["url"].as_str().unwrap_or_default(),
                        step["detail"]["baseBranch"].as_str().unwrap_or("main"),
                        report.next["headSha"].as_str(),
                        &report,
                    ))
                });
                out.push(json!({
                    "changes": report.changes.iter().map(watch::Change::to_json).collect::<Vec<_>>(),
                    "next": report.next,
                    "exhausted": report.exhausted,
                    "wake": wake,
                }));
                current = report.next;
            }
            json!(out)
        }
    }
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        std::process::exit(2);
    }
    let Ok(Value::Array(cases)) = serde_json::from_str::<Value>(&input) else {
        std::process::exit(2);
    };
    let answers: Vec<Value> = cases.iter().map(answer).collect();
    println!("{}", Value::Array(answers));
}
