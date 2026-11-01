mod capture;
mod feedback;
mod ipc;
mod protocols;
#[cfg(test)]
mod transport_tests;

use std::{error::Error, io::Write, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn emit(value: serde_json::Value) -> Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}

/// Metadata of the captured window, or none if it changed while the capture ran.
fn captured_metadata(captured: &ipc::Window, after: Vec<ipc::Window>) -> Option<serde_json::Value> {
    // Never pair text with a different/closed window or stale geometry.
    after
        .into_iter()
        .find(|w| w.address == captured.address)
        .filter(|w| captured.matches_after_capture(w))
        .map(|_| captured.metadata())
}

fn run() -> Result<()> {
    ipc::session_directory()?;
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("check") => emit(serde_json::json!({"feedbackAvailable": capture::check()?})),
        Some("capture") if args.len() == 3 => {
            ipc::ensure_unlocked()?;
            let window = ipc::active_window()?;
            capture::capture(window.address()?, Path::new(&args[2]))?;
            ipc::ensure_unlocked()?;
            emit(serde_json::json!({"window": captured_metadata(&window, ipc::windows()?)}))
        }
        Some("activate") if args.len() == 4 => {
            ipc::activate(args[2].parse()?, &args[3])?;
            Ok(())
        }
        Some("feedback") if args.len() == 4 => {
            feedback::run(Path::new(&args[2]), serde_json::from_str(&args[3])?)
        }
        _ => Err("Expected check, capture <directory>, activate <pid> <title>, or feedback <directory> <options>".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    // Shaped like Hyprland's j/activewindow and j/clients replies, including fields we ignore.
    fn client(address: &str, title: &str, patch: Value) -> Value {
        let mut client = json!({
            "address": address, "mapped": true, "hidden": false,
            "at": [-1920, 20], "size": [1000, 800], "workspace": {"id": 2, "name": "2"},
            "floating": false, "monitor": 1, "class": "kitty", "title": title,
            "initialClass": "kitty", "initialTitle": "kitty", "pid": 4242, "xwayland": false,
        });
        client
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        client
    }

    fn parse<T: serde::de::DeserializeOwned>(reply: Value) -> T {
        serde_json::from_str(&reply.to_string()).unwrap()
    }

    fn metadata_after(before: Value, after: Vec<Value>) -> Option<Value> {
        captured_metadata(&parse(before), parse(Value::Array(after)))
    }

    #[test]
    fn keeps_captured_metadata_when_only_the_title_spinner_ticks() {
        for (before, after) in [("⠋ Document", "⠙ Document"), ("⠏ Document", "Document")] {
            let metadata = metadata_after(
                client("0xabc", before, json!({})),
                vec![
                    client("0xdef", "Other", json!({})),
                    client("0xabc", after, json!({})),
                ],
            )
            .unwrap_or_else(|| panic!("{before:?} -> {after:?} dropped metadata"));
            assert_eq!(metadata["title"], before);
            assert_eq!(metadata["processId"], 4242);
            assert_eq!(metadata["appName"], "kitty");
            assert_eq!(
                metadata["bounds"],
                json!({"x": -1920.0, "y": 20.0, "width": 1000.0, "height": 800.0})
            );
        }
    }

    #[test]
    fn drops_metadata_when_title_whitespace_changes() {
        for (before, after) in [
            ("Document", " Document "),
            ("Document", "Document "),
            (" Document", "Document"),
            ("⠋ Document", "⠙ Document "),
        ] {
            assert_eq!(
                metadata_after(
                    client("0xabc", before, json!({})),
                    vec![client("0xabc", after, json!({}))],
                ),
                None,
                "{before:?} -> {after:?}",
            );
        }
    }

    #[test]
    fn drops_metadata_when_the_window_identity_or_state_changed() {
        let before = || client("0xabc", "⠋ Document", json!({}));
        for after in [
            client("0xabc", "⠙ Other", json!({})),
            client("0xabc", "⠁ Document", json!({})),
            client("0xabc", "⠙Document", json!({})),
            client("0xabc", "⠙ Document", json!({"at": [-1900, 20]})),
            client("0xabc", "⠙ Document", json!({"size": [1000, 700]})),
            client("0xabc", "⠙ Document", json!({"pid": 99})),
            client("0xabc", "⠙ Document", json!({"class": "foot"})),
            client("0xabc", "⠙ Document", json!({"hidden": true})),
            client("0xabc", "⠙ Document", json!({"mapped": false})),
            client("0xdef", "⠋ Document", json!({})),
        ] {
            assert_eq!(
                metadata_after(before(), vec![after.clone()]),
                None,
                "{after}"
            );
        }
        assert_eq!(metadata_after(before(), vec![]), None);
    }
}
