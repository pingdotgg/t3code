//! `thread.pull-request.link` and `thread.pull-request.unlink`, as T3's decider writes them
//! (`Orchestrator.ts`, the `thread.pull-request.link | unlink | -link.sync` case). Keys are
//! the registry's (`normalizeThreadPullRequestKey`, `legacyThreadPullRequestKey`): host and
//! repository lower case and canonical. URLs keep the caller's spelling.
//! Unlinking a stack member leaves a `stack-dismissed` tombstone, and
//! linking it again by hand lifts it.

use conn_source_control::registry::thread_keys::{
    KeySource, ThreadPullRequestKey, legacy_thread_pull_request_key,
    normalize_thread_pull_request_key,
};
use serde_json::{Value, json};

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn number(value: &Value) -> u64 {
    value.get("number").and_then(Value::as_u64).unwrap_or(0)
}

/// `normalizeThreadPullRequestKey` of a link, a command or a parsed URL.
fn key_of(value: &Value) -> ThreadPullRequestKey {
    normalize_thread_pull_request_key(KeySource {
        host: text(value, "host"),
        repository: text(value, "repository"),
        number: number(value),
        authority: value.get("authority").and_then(Value::as_str),
        url: value.get("url").and_then(Value::as_str),
    })
}

/// `legacyThreadPullRequestKey` of a `ThreadLinkedPullRequest`.
fn legacy_key(linked: &Value) -> ThreadPullRequestKey {
    legacy_thread_pull_request_key(
        text(linked, "repository"),
        number(linked),
        text(linked, "url"),
        None,
    )
}

fn key_json(key: &ThreadPullRequestKey) -> Value {
    json!({"host": key.host, "repository": key.repository, "number": key.number})
}

/// `threadPullRequestsOf`: the links, or the older single `linkedPullRequest` as one link.
fn links_of(thread: &Value) -> Vec<Value> {
    if let Some(links) = thread.get("pullRequests").and_then(Value::as_array) {
        return links.clone();
    }
    match thread.get("linkedPullRequest").filter(|l| l.is_object()) {
        Some(linked) => {
            let mut link = key_json(&legacy_key(linked));
            if let Some(map) = link.as_object_mut() {
                map.insert("url".into(), linked["url"].clone());
                map.insert("source".into(), json!("manual"));
                map.insert("linkedAt".into(), json!("1970-01-01T00:00:00.000Z"));
                map.insert("snapshot".into(), Value::Null);
                map.insert("stack".into(), Value::Null);
            }
            vec![link]
        }
        None => Vec::new(),
    }
}

fn is_dismissed(link: &Value) -> bool {
    link["source"] == "stack-dismissed"
}

/// `withPullRequestWatch(link, undefined)`: the watch ends and is kept as `endedWatch`.
fn without_watch(link: &Value) -> Value {
    let mut link = link.clone();
    if let Some(map) = link.as_object_mut() {
        let previous = map.remove("watch");
        let ended = map.remove("endedWatch");
        if let Some(ended) = previous.or(ended) {
            map.insert("endedWatch".into(), ended);
        }
    }
    link
}

/// The thread after `command`, or `None` when T3's decider returns the thread unchanged.
/// T3 emits `thread.pull-request-synced` with the thread either way.
pub(crate) fn decide(thread: &Value, command: &Value, now: &str) -> Option<Value> {
    let key = key_of(command);
    let links = links_of(thread);
    let existing = links.iter().position(|link| key_of(link) == key);
    let pull_requests = if command["type"] == "thread.pull-request.link" {
        link(thread, command, now, &key, &links, existing)?
    } else {
        unlink(&key, &links, existing?)
    };
    let mut updated = thread.clone();
    let keeps_legacy = thread
        .get("linkedPullRequest")
        .filter(|l| l.is_object())
        .is_some_and(|linked| {
            let legacy = legacy_key(linked);
            pull_requests
                .iter()
                .any(|link| !is_dismissed(link) && key_of(link) == legacy)
        });
    if let Some(map) = updated.as_object_mut() {
        map.insert("pullRequests".into(), json!(pull_requests));
        if !keeps_legacy {
            map.insert("linkedPullRequest".into(), Value::Null);
        }
        map.insert("updatedAt".into(), json!(now));
    }
    Some(updated)
}

fn link(
    thread: &Value,
    command: &Value,
    now: &str,
    key: &ThreadPullRequestKey,
    links: &[Value],
    existing: Option<usize>,
) -> Option<Vec<Value>> {
    let source = &command["source"];
    let existing_link = existing.and_then(|i| links.get(i));
    let undismisses =
        existing_link.is_some_and(is_dismissed) && source != "stack" && source != "stack-dismissed";
    if existing_link.is_some() && !undismisses {
        return None;
    }
    let url = text(command, "url");
    let mut link = match existing_link {
        Some(existing) => existing.clone(),
        None => {
            let mut fresh = key_json(key);
            if let Some(map) = fresh.as_object_mut() {
                map.insert("url".into(), json!(url));
            }
            fresh
        }
    };
    if let Some(map) = link.as_object_mut() {
        if existing_link.is_some() {
            map.insert("source".into(), source.clone());
            map.insert("url".into(), json!(url));
        }
        if let Some(web) = command.get("repositoryWebUrl").filter(|w| w.is_string()) {
            map.insert("repositoryWebUrl".into(), web.clone());
        }
        if existing_link.is_none() {
            map.insert("source".into(), source.clone());
            map.insert("linkedAt".into(), json!(now));
            map.insert("snapshot".into(), Value::Null);
            map.insert("stack".into(), Value::Null);
        }
    }
    let mut out = Vec::new();
    // A first manual link keeps the branch's own pull request beside it.
    if let Some(branch) = thread.get("branchPullRequest").filter(|b| b.is_object()) {
        let branch_key = legacy_key(branch);
        let visible = links.iter().filter(|l| !is_dismissed(l)).count();
        if source == "manual"
            && visible == 0
            && branch_key != *key
            && !links.iter().any(|entry| key_of(entry) == branch_key)
        {
            let mut entry = key_json(&branch_key);
            if let Some(map) = entry.as_object_mut() {
                map.insert("url".into(), json!(text(branch, "url")));
                map.insert("source".into(), json!("manual"));
                map.insert("linkedAt".into(), json!(now));
                map.insert("snapshot".into(), Value::Null);
                map.insert("stack".into(), Value::Null);
            }
            out.push(entry);
        }
    }
    out.extend(links.iter().filter(|entry| key_of(entry) != *key).cloned());
    out.push(link);
    Some(out)
}

fn unlink(key: &ThreadPullRequestKey, links: &[Value], existing: usize) -> Vec<Value> {
    let Some(found) = links.get(existing) else {
        return links.to_vec();
    };
    // `existing.stack !== null`: an absent stack counts as one, as in JavaScript.
    let belongs_to_stack = found["source"] == "stack"
        || found.get("stack") != Some(&Value::Null)
        || links.iter().any(|link| {
            text(link, "host").to_lowercase() == key.host
                && text(link, "repository").to_lowercase() == key.repository
                && link["stack"]["layers"]
                    .as_array()
                    .is_some_and(|layers| layers.iter().any(|l| number(l) == key.number))
        });
    if belongs_to_stack {
        links
            .iter()
            .enumerate()
            .map(|(index, link)| {
                if index == existing {
                    let mut dismissed = without_watch(link);
                    dismissed["source"] = json!("stack-dismissed");
                    dismissed
                } else {
                    link.clone()
                }
            })
            .collect()
    } else {
        links
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != existing)
            .map(|(_, link)| link.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-14T00:00:00.000Z";

    fn link_command(host: &str, repository: &str, number: u64, url: &str, source: &str) -> Value {
        json!({"type": "thread.pull-request.link", "threadId": "t", "commandId": "c",
               "host": host, "repository": repository, "number": number, "url": url, "source": source})
    }

    #[test]
    fn links_are_keyed_canonically_and_urls_preserved() {
        let thread = json!({"pullRequests": []});
        let command = link_command(
            "Git.Cafe",
            "O/R",
            4,
            "https://git.cafe/O/R/pull/4?x",
            "agent",
        );
        let updated = decide(&thread, &command, NOW).expect("linked");
        let link = &updated["pullRequests"][0];
        assert_eq!(link["host"], "git.cafe", "lower case");
        assert_eq!(link["repository"], "o/r", "lower case");
        assert_eq!(
            link["url"], "https://git.cafe/O/R/pull/4?x",
            "unknown host URL is preserved"
        );
        assert_eq!(updated["updatedAt"], NOW, "updated");
        assert_eq!(
            decide(&updated, &command, NOW),
            None,
            "a second link changes nothing"
        );
    }

    #[test]
    fn an_unknown_link_keeps_the_explicit_host() {
        let command = link_command(
            "forge.example",
            "a/b",
            7,
            "http://forge.example:3000/a/b/pulls/7",
            "manual",
        );
        let updated = decide(&json!({}), &command, NOW).expect("linked");
        assert_eq!(
            updated["pullRequests"][0]["host"], "forge.example",
            "unknown host"
        );
    }

    #[test]
    fn unlinking_a_stack_member_leaves_a_tombstone_that_a_manual_link_lifts() {
        let member = json!({"host": "github.com", "repository": "o/r", "number": 2,
            "url": "https://github.com/o/r/pull/2", "source": "stack", "linkedAt": NOW,
            "snapshot": null, "stack": null, "watch": {"startedAt": NOW}});
        let thread = json!({"pullRequests": [member]});
        let unlink = json!({"type": "thread.pull-request.unlink", "threadId": "t", "commandId": "c",
            "host": "GitHub.com", "repository": "O/R", "number": 2});
        let dismissed = decide(&thread, &unlink, NOW).expect("unlinked");
        let link = &dismissed["pullRequests"][0];
        assert_eq!(link["source"], "stack-dismissed", "tombstone");
        assert_eq!(
            link["endedWatch"],
            json!({"startedAt": NOW}),
            "the watch ended"
        );
        assert!(link.get("watch").is_none(), "no watch");
        let again = link_command(
            "github.com",
            "o/r",
            2,
            "https://github.com/o/r/pull/2",
            "stack",
        );
        assert_eq!(
            decide(&dismissed, &again, NOW),
            None,
            "a stack sync does not lift it"
        );
        let manual = link_command(
            "github.com",
            "o/r",
            2,
            "https://github.com/o/r/pull/2",
            "manual",
        );
        let lifted = decide(&dismissed, &manual, NOW).expect("lifted");
        assert_eq!(lifted["pullRequests"][0]["source"], "manual", "lifted");
    }

    #[test]
    fn a_first_manual_link_keeps_the_branch_pull_request() {
        let thread = json!({
            "pullRequests": [],
            "branchPullRequest": {"repository": "o/r", "number": 1, "url": "https://github.com/o/r/pull/1"}
        });
        let command = link_command(
            "github.com",
            "o/r",
            2,
            "https://github.com/o/r/pull/2",
            "manual",
        );
        let updated = decide(&thread, &command, NOW).expect("linked");
        let numbers: Vec<u64> = updated["pullRequests"]
            .as_array()
            .map(|l| l.iter().map(number).collect())
            .unwrap_or_default();
        assert_eq!(numbers, vec![1, 2], "branch first, then the new link");
    }

    #[test]
    fn a_legacy_single_link_is_read_and_kept_while_linked() {
        let thread = json!({"linkedPullRequest": {"repository": "o/r", "number": 3,
            "url": "https://github.com/o/r/pull/3"}});
        let command = link_command(
            "github.com",
            "o/r",
            5,
            "https://github.com/o/r/pull/5",
            "agent",
        );
        let updated = decide(&thread, &command, NOW).expect("linked");
        assert_eq!(
            updated["pullRequests"].as_array().map(Vec::len),
            Some(2),
            "both links"
        );
        assert!(updated["linkedPullRequest"].is_object(), "legacy kept");
        let unlink = json!({"type": "thread.pull-request.unlink", "threadId": "t", "commandId": "c",
            "host": "github.com", "repository": "o/r", "number": 3});
        let updated = decide(&updated, &unlink, NOW).expect("unlinked");
        assert!(updated["linkedPullRequest"].is_null(), "legacy cleared");
    }
}
