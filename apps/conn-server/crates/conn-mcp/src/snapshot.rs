//! T3's snapshot text budget keeps locator-bearing content while shedding old diagnostics.
use serde_json::{Value, json};

const SHED: [&str; 4] = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
];
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}
fn cut(text: &str, max: usize) -> String {
    if length(text) <= max {
        return text.into();
    }
    format!("{}…", conn_support::text::utf16_prefix(text, max))
}
fn halve(chars: usize) -> usize {
    if chars > 2000 {
        (chars / 2).max(2000)
    } else {
        chars / 2
    }
}
fn strings(entry: &Value) -> impl Iterator<Item = &str> {
    entry
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(Value::as_str)
}
fn cut_entry(mut entry: Value) -> Value {
    if let Some(fields) = entry.as_object_mut() {
        for value in fields.values_mut() {
            if let Some(text) = value.as_str() {
                *value = json!(cut(text, 500));
            }
        }
    }
    entry
}

/// Returns bounded metadata, its JSON text, and T3's list of omissions.
pub fn bound_metadata(mut metadata: Value) -> (Value, String, Vec<String>) {
    let mut omitted = Vec::new();
    let tree = metadata
        .as_object_mut()
        .and_then(|m| m.remove("accessibilityTree"));
    let aria = tree.as_ref().and_then(Value::as_str).map(str::to_owned);
    if tree.is_some() && aria.is_none() {
        omitted.push(
            "accessibilityTree (use interactiveElements locators or preview_evaluate)".into(),
        );
    }
    let visible = metadata
        .get("visibleText")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if ["url", "title"].iter().any(|key| {
        metadata
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|s| length(s) > 2048)
    }) {
        omitted.push("url or title after 2048 characters".into());
    }
    let elements = metadata
        .get("interactiveElements")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if elements.iter().any(|e| {
        e.get("name")
            .and_then(Value::as_str)
            .is_some_and(|s| length(s) > 200)
    }) {
        omitted.push("element names longer than 200 characters".into());
    }
    for key in ["url", "title"] {
        if let Some(text) = metadata.get(key).and_then(Value::as_str) {
            metadata[key] = json!(cut(text, 2048));
        }
    }
    metadata["interactiveElements"] = json!(
        elements
            .into_iter()
            .map(|mut e| {
                if let Some(name) = e.get("name").and_then(Value::as_str) {
                    e["name"] = json!(cut(name, 200));
                }
                e
            })
            .collect::<Vec<_>>()
    );
    for (key, label) in [
        ("consoleEntries", "console entries"),
        ("networkEntries", "network entries"),
        ("actionTimeline", "action timeline entries"),
    ] {
        let entries = metadata
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if entries.len() > 40 {
            omitted.push(format!("{} older {label}", entries.len() - 40));
        }
        let kept = entries
            .into_iter()
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>();
        if kept.iter().any(|e| strings(e).any(|s| length(s) > 500)) {
            omitted.push(format!("{label} text after 500 characters"));
        }
        metadata[key] = json!(kept.into_iter().map(cut_entry).collect::<Vec<_>>());
    }
    let mut visible_chars = length(&visible).min(8000);
    let mut aria_chars = aria.as_ref().map_or(0, |s| length(s).min(20_000));
    let mut dropped = [0usize; 4];
    let build = |base: &Value, visible_chars: usize, aria_chars: usize| {
        let mut result = base.clone();
        result["visibleText"] = json!(cut(&visible, visible_chars));
        if let Some(aria) = &aria {
            result["accessibilityTree"] = json!(cut(aria, aria_chars));
        }
        result
    };
    let mut value = build(&metadata, visible_chars, aria_chars);
    let mut text = value.to_string();
    while text.len() > 20_000 {
        let logs = SHED.iter().take(3).copied().find(|key| {
            metadata
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
        });
        let key = logs.or_else(|| {
            if visible_chars > 2000 && (aria_chars <= 2000 || visible_chars >= aria_chars / 2) {
                Some("visibleText")
            } else if aria_chars > 2000 {
                Some("accessibilityTree")
            } else if visible_chars > 0 {
                Some("visibleText")
            } else if metadata
                .get("interactiveElements")
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
            {
                Some("interactiveElements")
            } else if aria_chars > 0 {
                Some("accessibilityTree")
            } else {
                None
            }
        });
        let Some(key) = key else {
            break;
        };
        if key == "visibleText" {
            visible_chars = halve(visible_chars);
        } else if key == "accessibilityTree" {
            aria_chars = halve(aria_chars);
        } else if let Some(entries) = metadata.get_mut(key).and_then(Value::as_array_mut) {
            let keep = entries.len() / 2;
            if let Some(index) = SHED.iter().position(|candidate| *candidate == key)
                && let Some(count) = dropped.get_mut(index)
            {
                *count += entries.len() - keep;
            }
            if key == "interactiveElements" {
                entries.truncate(keep);
            } else {
                entries.drain(..entries.len() - keep);
            }
        }
        value = build(&metadata, visible_chars, aria_chars);
        text = value.to_string();
    }
    if visible_chars < length(&visible) {
        omitted.push(format!(
            "visibleText after {visible_chars} characters (use preview_evaluate for more)"
        ));
    }
    if aria.as_ref().is_some_and(|s| aria_chars < length(s)) {
        omitted.push(format!("accessibilityTree after {aria_chars} characters"));
    }
    for (key, count) in SHED.into_iter().zip(dropped) {
        if count > 0 {
            let original = value.get(key).and_then(Value::as_array).map_or(0, Vec::len) + count;
            omitted.push(format!("{count} of {original} {key}"));
        }
    }
    (value, text, omitted)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_multibyte_text_and_diagnostics_before_shedding_locator_refs() {
        let metadata = json!({"url":"http://localhost/","title":"Fixture","visibleText":"😀".repeat(20_000),"accessibilityTree":"- button [ref=t3-test-e1]".repeat(1000),"interactiveElements":[],"consoleEntries":(0..200).map(|i|json!({"level":"log","text":format!("{i} {}","x".repeat(1000)),"timestamp":"now"})).collect::<Vec<_>>(),"networkEntries":[],"actionTimeline":[]});
        let (value, text, omitted) = bound_metadata(metadata);
        assert!(text.len() <= 20_000);
        assert!(
            value["accessibilityTree"]
                .as_str()
                .unwrap()
                .contains("ref=t3-test-e1")
        );
        assert!(omitted.iter().any(|s| s == "160 older console entries"));
        assert!(serde_json::from_str::<Value>(&text).is_ok());
    }
}
