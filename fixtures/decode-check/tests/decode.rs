//! Every line of `../sessions/*.ndjson` (not `*.http.ndjson`) decodes with `conn_wire`:
//! `FromClient` for `"dir":"in"`, `FromServer` for `"dir":"out"`.

use conn_wire::{FromClient, FromServer};
use serde_json::Value;
use std::path::Path;

#[test]
fn every_recorded_frame_decodes() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../sessions");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("sessions dir")
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.ends_with(".ndjson") && !name.ends_with(".http.ndjson")
        })
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no recordings in {}", dir.display());

    let mut failures = Vec::new();
    let mut total = 0;
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let text = std::fs::read_to_string(file).unwrap();
        let (mut ins, mut outs) = (0, 0);
        for (n, line) in text
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
        {
            total += 1;
            let at = format!("{name}:{}", n + 1);
            let record: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(e) => {
                    failures.push(format!("{at}: line is not JSON: {e}"));
                    continue;
                }
            };
            let Some(frame) = record.get("frame").cloned() else {
                failures.push(format!("{at}: no `frame` field"));
                continue;
            };
            let result = match record.get("dir").and_then(Value::as_str) {
                Some("in") => {
                    ins += 1;
                    serde_json::from_value::<FromClient>(frame).map(drop)
                }
                Some("out") => {
                    outs += 1;
                    serde_json::from_value::<FromServer>(frame).map(drop)
                }
                other => {
                    failures.push(format!("{at}: bad dir {other:?}"));
                    continue;
                }
            };
            if let Err(e) = result {
                let tag = record["frame"]["_tag"].as_str().unwrap_or("?").to_owned();
                failures.push(format!("{at}: {tag}: {e}"));
            }
        }
        println!("{name}: {ins} in, {outs} out");
    }
    println!(
        "{total} frames in {} files, {} failures",
        files.len(),
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "frames that do not decode:\n{}",
        failures.join("\n")
    );
}
