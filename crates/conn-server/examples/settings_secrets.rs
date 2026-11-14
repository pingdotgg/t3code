//! For `tools/secrets-interop.mjs`: opens a state folder's settings as the server does at start
//! (inline secrets move to the store), then checks the settings it reads against the expected
//! values on stdin. It prints only the paths that differ, never a value.
//!
//!   settings_secrets <state dir> < expected.json

use std::io::Read;

use serde_json::Value;

/// Pushes every path where `actual` does not hold `expected`'s leaf.
fn compare(expected: &Value, actual: &Value, path: &str, out: &mut Vec<String>) {
    match expected {
        Value::Object(fields) => {
            for (key, value) in fields {
                let next = actual.get(key).unwrap_or(&Value::Null);
                compare(value, next, &format!("{path}.{key}"), out);
            }
        }
        Value::Array(items) => {
            for (index, value) in items.iter().enumerate() {
                let next = actual.get(index).unwrap_or(&Value::Null);
                compare(value, next, &format!("{path}[{index}]"), out);
            }
        }
        leaf if leaf != actual => out.push(path.to_owned()),
        _ => {}
    }
}

fn main() {
    let Some(state_dir) = std::env::args().nth(1) else {
        eprintln!("usage: settings_secrets <state dir> < expected.json");
        std::process::exit(2);
    };
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("could not read stdin");
        std::process::exit(2);
    }
    let Ok(expected) = serde_json::from_str::<Value>(&input) else {
        eprintln!("stdin is not JSON");
        std::process::exit(2);
    };
    let store = conn_server::settings::SettingsStore::open(
        std::path::Path::new(&state_dir).join("settings.json"),
    );
    let actual = Value::Object(store.raw());
    let mut differs = Vec::new();
    compare(&expected, &actual, "", &mut differs);
    if differs.is_empty() {
        println!("ok");
    } else {
        for path in differs {
            println!("differs at {path}");
        }
        std::process::exit(1);
    }
}
