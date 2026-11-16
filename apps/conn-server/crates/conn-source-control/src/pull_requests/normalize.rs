//! Contract shapes of GitHub's generated reads; no transport or retained state.
use serde_json::{Value, json};
pub fn array(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}
pub(super) fn nodes(value: &Value) -> &[Value] {
    array(value.get("nodes"))
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub(super) fn trimmed(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}
pub(super) fn cursor(value: &Value) -> Value {
    if value.pointer("/pageInfo/hasNextPage") == Some(&Value::Bool(true)) {
        trimmed(value.pointer("/pageInfo/endCursor"))
    } else {
        Value::Null
    }
}
pub fn state(raw: &Value) -> &'static str {
    if !trimmed(raw.get("mergedAt")).is_null() {
        return "merged";
    }
    match text(raw, "state").trim().to_uppercase().as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ => "open",
    }
}
pub fn actor(raw: Option<&Value>, host: &str) -> Value {
    let Some(raw) = raw else {
        return Value::Null;
    };
    let login = trimmed(raw.get("login"));
    if login.is_null() {
        return Value::Null;
    }
    let mut actor = json!({"login":login,"name":trimmed(raw.get("name")),"avatarUrl":trimmed(raw.get("avatarUrl"))});
    if actor.get("avatarUrl").is_none_or(Value::is_null) {
        let name = login.as_str().unwrap_or("");
        if (1..=39).contains(&name.len())
            && name
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            actor["avatarUrl"] = json!(format!(
                "https://{host}/{}.png?size=80",
                super::diff::encode(name)
            ));
        }
    }
    if text(raw, "__typename") == "Bot" {
        actor["isBot"] = json!(true);
    }
    actor
}
pub(super) fn mergeability(raw: &Value) -> &'static str {
    match text(raw, "mergeable").trim().to_uppercase().as_str() {
        "MERGEABLE" => "mergeable",
        "CONFLICTING" => "conflicting",
        _ => "unknown",
    }
}
fn review_decision(raw: &Value) -> Value {
    let base = match text(raw, "reviewDecision").trim().to_uppercase().as_str() {
        "APPROVED" => Some("approved"),
        "CHANGES_REQUESTED" => Some("changes-requested"),
        "REVIEW_REQUIRED" => Some("review-required"),
        _ => None,
    };
    if matches!(base, Some("approved" | "changes-requested")) {
        return json!(base);
    }
    let reviews = nodes(raw.get("latestReviews").unwrap_or(&Value::Null));
    if reviews.iter().any(|r| {
        r.get("isMinimized") != Some(&Value::Bool(true)) && text(r, "state") == "CHANGES_REQUESTED"
    }) {
        json!("changes-requested")
    } else if base.is_none()
        && reviews.iter().any(|r| {
            r.get("isMinimized") != Some(&Value::Bool(true)) && text(r, "state") == "APPROVED"
        })
    {
        json!("approved")
    } else {
        json!(base)
    }
}
pub(super) fn labels(raw: &Value) -> Vec<Value> {
    nodes(raw).iter().filter(|l|!trimmed(l.get("name")).is_null()).map(|l| json!({"name":trimmed(l.get("name")),"color":trimmed(l.get("color")),"description":trimmed(l.get("description"))})).collect()
}
pub(super) fn stack(raw: &Value) -> Option<Value> {
    let s = raw.get("stack").filter(|v| !v.is_null())?;
    let entry = raw.get("stackEntry").filter(|v| !v.is_null())?;
    Some(
        json!({"number":s.get("number"),"size":s.get("size"),"base":s.get("baseRefName"),"position":entry.get("position")}),
    )
}
pub fn summary(raw: &Value, host: &str) -> Value {
    let mut value = json!({"number":raw.get("number"),"title":raw.get("title"),"url":raw.get("url"),"headBranch":raw.get("headRefName"),"baseBranch":raw.get("baseRefName"),"state":state(raw),"isDraft":raw.get("isDraft"),"closedAt":trimmed(raw.get("closedAt")),"mergedAt":trimmed(raw.get("mergedAt")),"updatedAt":raw.get("updatedAt"),"author":actor(raw.get("author"),host),"additions":raw.get("additions"),"deletions":raw.get("deletions"),"changedFiles":raw.get("changedFiles"),"reviewDecision":review_decision(raw),"checksState":rollup(&nodes(raw.get("commits").unwrap_or(&Value::Null)).iter().filter_map(|n| n.pointer("/commit/statusCheckRollup/state")).map(|s|check_status(&json!({"state":s}))).collect::<Vec<_>>()),"mergeability":mergeability(raw)});
    if raw.get("stack").is_some() {
        value["stack"] = stack(raw).unwrap_or(Value::Null);
    }
    value
}
fn check_status(raw: &Value) -> &'static str {
    let status = text(raw, "status").trim().to_uppercase();
    if !status.is_empty() && status != "COMPLETED" {
        return "pending";
    }
    match raw
        .get("conclusion")
        .filter(|v| !v.is_null())
        .or_else(|| raw.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_uppercase()
        .as_str()
    {
        "SUCCESS" => "success",
        "ACTION_REQUIRED" => "action-required",
        "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE" => "failure",
        "CANCELLED" => "cancelled",
        "SKIPPED" => "skipped",
        "PENDING" | "EXPECTED" => "pending",
        _ => "neutral",
    }
}
pub(super) fn rollup(statuses: &[&str]) -> Value {
    if statuses
        .iter()
        .any(|s| matches!(*s, "failure" | "cancelled"))
    {
        json!("failing")
    } else if statuses
        .iter()
        .any(|s| matches!(*s, "pending" | "action-required"))
    {
        json!("pending")
    } else if statuses.contains(&"success") {
        json!("passing")
    } else {
        Value::Null
    }
}
pub fn checks(raw: &[Value]) -> Vec<Value> {
    let mut kept: Vec<(String, String, Value)> = Vec::new();
    for check in raw {
        let name = trimmed(check.get("name"));
        let name = if name.is_null() {
            trimmed(check.get("context"))
        } else {
            name
        };
        let Some(name) = name.as_str() else {
            continue;
        };
        let workflow = check
            .get("workflowName")
            .and_then(Value::as_str)
            .or_else(|| {
                check
                    .pointer("/checkSuite/workflowRun/workflow/name")
                    .and_then(Value::as_str)
            })
            .unwrap_or("");
        let key = format!("{workflow}\0{name}");
        let status = check_status(check);
        let real_at = |key| {
            check
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "0001-01-01T00:00:00Z")
        };
        let at = if status == "pending" {
            "9999-12-31T23:59:59Z"
        } else {
            real_at("completedAt")
                .or_else(|| real_at("startedAt"))
                .unwrap_or("")
        };
        let mut value = json!({"name":name,"status":status,"description":trimmed(check.get("description")),"url":if trimmed(check.get("detailsUrl")).is_null(){trimmed(check.get("targetUrl"))}else{trimmed(check.get("detailsUrl"))}});
        if let Some(required) = check.get("isRequired").filter(|v| v.is_boolean()) {
            value["required"] = required.clone();
        }
        if let Some(entry) = kept.iter_mut().find(|(k, _, _)| k == &key) {
            if at_least_as_new(at, &entry.1) {
                entry.1 = at.into();
                entry.2 = value;
            }
        } else {
            kept.push((key, at.into(), value));
        }
    }
    let names: Vec<String> = kept
        .iter()
        .map(|(_, _, c)| text(c, "name").into())
        .collect();
    let mut result: Vec<Value> = kept
        .into_iter()
        .map(|(key, _, mut check)| {
            let name = text(&check, "name");
            let workflow = key.split('\0').next().unwrap_or("");
            if !workflow.is_empty() && names.iter().filter(|n| n.as_str() == name).count() > 1 {
                check["name"] = json!(format!("{workflow} / {name}"));
            }
            check
        })
        .collect();
    result.sort_by_key(|c| !matches!(text(c, "status"), "failure" | "cancelled"));
    result
}

fn at_least_as_new(candidate: &str, kept: &str) -> bool {
    let (Some(candidate_at), Some(kept_at)) = (
        conn_support::time::millis_from_iso(candidate),
        conn_support::time::millis_from_iso(kept),
    ) else {
        return candidate >= kept;
    };
    if candidate_at != kept_at {
        return candidate_at > kept_at;
    }
    let fraction = |value: &str| {
        value
            .split_once('.')
            .map(|(_, v)| {
                v.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .unwrap_or_default()
    };
    let mut left = fraction(candidate);
    let mut right = fraction(kept);
    let length = left.len().max(right.len());
    left.extend(std::iter::repeat_n('0', length - left.len()));
    right.extend(std::iter::repeat_n('0', length - right.len()));
    left >= right
}

pub fn breakdown(stats: &Value) -> Value {
    if stats.get("truncated") == Some(&Value::Bool(true)) {
        return Value::Null;
    }
    let mut result = json!({"code":{"additions":0,"deletions":0},"tests":{"additions":0,"deletions":0},"mocks":{"additions":0,"deletions":0},"generated":{"additions":0,"deletions":0},"docs":{"additions":0,"deletions":0}});
    for file in array(stats.get("files")) {
        let kind = classify(text(file, "path"));
        for field in ["additions", "deletions"] {
            let count = result
                .get(kind)
                .and_then(|v| v.get(field))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if let Some(bucket) = result.get_mut(kind) {
                bucket[field] = json!(
                    count.saturating_add(file.get(field).and_then(Value::as_u64).unwrap_or(0))
                );
            }
        }
    }
    result
}
fn classify(path: &str) -> &'static str {
    let path = path.replace('\\', "/");
    let mut parts: Vec<&str> = path.split('/').collect();
    let name = parts.pop().unwrap_or("");
    let lower = name.to_lowercase();
    let dir = |names: &[&str]| {
        parts
            .iter()
            .any(|p| names.contains(&p.to_lowercase().as_str()))
    };
    let locks = [
        "bun.lock",
        "bun.lockb",
        "cargo.lock",
        "composer.lock",
        "deno.lock",
        "flake.lock",
        "gemfile.lock",
        "go.sum",
        "gradle.lockfile",
        "mix.lock",
        "npm-shrinkwrap.json",
        "package-lock.json",
        "packages.lock.json",
        "pipfile.lock",
        "pnpm-lock.yaml",
        "podfile.lock",
        "poetry.lock",
        "pubspec.lock",
        "uv.lock",
        "yarn.lock",
    ];
    if locks.contains(&lower.as_str())
        || name.contains(".generated.")
        || name.contains(".gen.")
        || [
            ".g.dart",
            ".pb.go",
            "_pb2.py",
            "_pb2_grpc.py",
            ".pb.cc",
            ".pb.h",
            ".min.js",
            ".min.css",
            ".js.map",
            ".css.map",
        ]
        .iter()
        .any(|s| name.ends_with(s))
        || dir(&["__generated__", "_generated", "generated"])
    {
        return "generated";
    }
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    if name.ends_with(".snap")
        || [
            "mock", "mocks", "fixture", "fixtures", "stub", "stubs", "fake", "fakes",
        ]
        .iter()
        .any(|s| {
            stem.ends_with(&format!(".{s}"))
                || name.strip_prefix(s).is_some_and(|r| {
                    r.is_empty()
                        || r.starts_with(['-', '_', '.'])
                        || r.starts_with(char::is_uppercase)
                })
        })
        || dir(&[
            "__fixtures__",
            "__mocks__",
            "__snapshots__",
            "fakes",
            "fixture",
            "fixtures",
            "mock",
            "mocks",
            "stubs",
            "testdata",
        ])
    {
        return "mocks";
    }
    let test_stem = stem.to_lowercase();
    let class = [
        "java", "kt", "kts", "scala", "groovy", "cs", "php", "swift", "m",
    ]
    .contains(&name.rsplit('.').next().unwrap_or(""))
        && ["Test", "Tests", "Spec"].iter().any(|s| stem.ends_with(s));
    if [
        ".test", ".spec", ".e2e", ".eval", ".stories", "_test", "_spec",
    ]
    .iter()
    .any(|s| test_stem.ends_with(s))
        || (lower.starts_with("test_") && lower.ends_with(".py"))
        || lower == "conftest.py"
        || test_stem == "vitest.setup"
        || test_stem == "jest.setup"
        || class
        || dir(&[
            "__tests__",
            "__test__",
            "cypress",
            "e2e",
            "evals",
            "spec",
            "specs",
            "test",
            "tests",
        ])
    {
        return "tests";
    }
    if ["md", "mdx", "markdown", "rst", "adoc", "txt"]
        .contains(&lower.rsplit('.').next().unwrap_or(""))
        && !(lower.ends_with(".txt")
            && (lower.starts_with("requirements")
                || lower.starts_with("constraints")
                || ["cmakelists.txt", "robots.txt", "llms.txt"].contains(&lower.as_str())))
    {
        return "docs";
    }
    "code"
}
