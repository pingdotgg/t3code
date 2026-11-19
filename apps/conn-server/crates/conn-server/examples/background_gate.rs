//! Answers client-activity gate cases for `crates/conn-source-control/tools/pr-link-sync-diff.mjs`:
//! one JSON array of `{settings, reports}` on stdin; for each, whether this server's
//! `shouldRunOpportunisticWork` lets the periodic branch lookup run after the reports.

use std::io::Read;

use conn_server::methods::provider::ProviderStatus;
use serde_json::Value;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        std::process::exit(2);
    }
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap_or_default();
    let answers: Vec<bool> = cases
        .iter()
        .map(|case| {
            let status = ProviderStatus::default();
            for report in case["reports"].as_array().into_iter().flatten() {
                status.report_activity(report);
            }
            let settings = case["settings"].as_object().cloned().unwrap_or_default();
            status.opportunistic(&settings)
        })
        .collect();
    println!("{}", serde_json::json!(answers));
}
