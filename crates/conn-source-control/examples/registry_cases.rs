//! Answers registry cases for `tools/registry-diff.mjs`: one JSON array of cases on stdin, one
//! JSON array of answers on stdout, in the shape T3's registry returns them.

use std::io::Read;

use conn_source_control::registry::thread_keys::{
    KeySource, ThreadPullRequestKey, legacy_thread_pull_request_key,
    normalize_thread_pull_request_key,
};
use conn_source_control::registry::{
    self, ChangeRequestLink, ChangeRequestUrlInput, HostKind, ProjectIdentity, ProviderInfo,
};
use serde_json::{Value, json};

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn provider(info: Option<ProviderInfo>) -> Value {
    info.map_or(
        Value::Null,
        |p| json!({"kind": p.kind, "name": p.name, "baseUrl": p.base_url}),
    )
}

fn link_json(link: &ChangeRequestLink) -> Value {
    let mut out = json!({"host": link.host, "repository": link.repository, "number": link.number});
    if let (Some(authority), Some(map)) = (&link.authority, out.as_object_mut()) {
        map.insert("authority".into(), json!(authority));
    }
    out
}

fn key_json(key: &ThreadPullRequestKey) -> Value {
    json!({"host": key.host, "repository": key.repository, "number": key.number})
}

fn identity(value: &Value) -> ProjectIdentity {
    let locator = value.get("locator");
    ProjectIdentity {
        canonical_key: text(value, "canonicalKey").unwrap_or_default(),
        remote_url: locator
            .and_then(|l| text(l, "remoteUrl"))
            .unwrap_or_default(),
        web_url: text(value, "webUrl"),
        display_name: text(value, "displayName"),
        owner: text(value, "owner"),
        name: text(value, "name"),
        provider: text(value, "provider"),
    }
}

fn link(value: &Value) -> ChangeRequestLink {
    ChangeRequestLink {
        host: text(value, "host").unwrap_or_default(),
        repository: text(value, "repository").unwrap_or_default(),
        number: value.get("number").and_then(Value::as_u64).unwrap_or(0),
        authority: text(value, "authority"),
    }
}

fn kind(value: &Value) -> Option<HostKind> {
    value
        .get("kind")
        .and_then(Value::as_str)
        .and_then(HostKind::parse)
}

fn answer(case: &Value) -> Value {
    let op = case.get("op").and_then(Value::as_str).unwrap_or_default();
    let s = |key| text(case, key).unwrap_or_default();
    match op {
        "recognizeRemote" => provider(registry::recognize_remote(&s("remote"))),
        "parseGitRemoteHost" => registry::parse_git_remote_host(&s("remote")).map_or(
            Value::Null,
            |r| json!({"remoteUrl": r.remote_url, "host": r.host, "hostname": r.hostname}),
        ),
        "parseChangeRequestUrl" => {
            registry::parse_change_request_url(&s("url")).map_or(Value::Null, |(kind, parsed)| {
                let mut link = link_json(&parsed.link);
                if let Some(map) = link.as_object_mut() {
                    map.insert("repositoryUrl".into(), json!(parsed.repository_url));
                }
                json!({"kind": kind.as_str(), "link": link})
            })
        }
        "changeRequestUrl" => {
            let input = case.get("input").cloned().unwrap_or(Value::Null);
            let (host, repository) = (text(&input, "host"), text(&input, "repository"));
            let (remote_url, web_url) = (text(&input, "remoteUrl"), text(&input, "webUrl"));
            let number = input.get("number").and_then(Value::as_u64).unwrap_or(0);
            kind(case)
                .and_then(|k| {
                    k.change_request_url(ChangeRequestUrlInput {
                        host: host.as_deref().unwrap_or_default(),
                        repository: repository.as_deref().unwrap_or_default(),
                        number,
                        remote_url: remote_url.as_deref(),
                        web_url: web_url.as_deref(),
                    })
                })
                .map_or(Value::Null, Value::String)
        }
        "canonicalRepositoryKey" => json!(registry::canonical_repository_key(&s("key"))),
        "findByRepositoryKey" => {
            registry::find_by_repository_key(&s("key")).map_or(Value::Null, |k| json!(k.as_str()))
        }
        "findByPublicHost" => {
            registry::find_by_public_host(&s("host")).map_or(Value::Null, |k| json!(k.as_str()))
        }
        "repositoryKeyFromRemote" => json!(registry::repository_key_from_remote(&s("remote"))),
        "repositorySelector" => {
            let id = identity(case.get("identity").unwrap_or(&Value::Null));
            registry::repository_selector(&id).map_or(Value::Null, Value::String)
        }
        "changeRequestHost" => {
            let id = identity(case.get("identity").unwrap_or(&Value::Null));
            let kind = text(case, "kind");
            registry::change_request_host(&id, kind.as_deref()).map_or(Value::Null, Value::String)
        }
        "isChangeRequestInRepository" | "canReadChangeRequestOnHost" => {
            let id = identity(case.get("identity").unwrap_or(&Value::Null));
            let l = link(case.get("link").unwrap_or(&Value::Null));
            kind(case).map_or(Value::Null, |k| {
                json!(if op == "isChangeRequestInRepository" {
                    k.is_change_request_in_repository(&id, &l)
                } else {
                    k.can_read_change_request_on_host(&id, &l)
                })
            })
        }
        "checkoutChangeRequestHost" => {
            let id = identity(case.get("identity").unwrap_or(&Value::Null));
            kind(case)
                .and_then(|k| k.checkout_change_request_host(&id))
                .map_or(Value::Null, Value::String)
        }
        "changeRequestHeadRef" => {
            let number = case.get("number").and_then(Value::as_u64).unwrap_or(0);
            kind(case)
                .and_then(|k| k.change_request_head_ref(number))
                .map_or(Value::Null, Value::String)
        }
        "isSameChangeRequest" => json!(registry::is_same_change_request(&s("left"), &s("right"))),
        "canonicalizeGitCafe" => json!(registry::canonicalize_gitcafe_pull_request_url(&s("url"))),
        "normalizeThreadKey" => {
            let key = case.get("key").cloned().unwrap_or(Value::Null);
            let (host, repository) = (text(&key, "host"), text(&key, "repository"));
            let (authority, url) = (text(&key, "authority"), text(&key, "url"));
            key_json(&normalize_thread_pull_request_key(KeySource {
                host: host.as_deref().unwrap_or_default(),
                repository: repository.as_deref().unwrap_or_default(),
                number: key.get("number").and_then(Value::as_u64).unwrap_or(0),
                authority: authority.as_deref(),
                url: url.as_deref(),
            }))
        }
        "legacyThreadKey" => {
            let linked = case.get("linked").cloned().unwrap_or(Value::Null);
            key_json(&legacy_thread_pull_request_key(
                &text(&linked, "repository").unwrap_or_default(),
                linked.get("number").and_then(Value::as_u64).unwrap_or(0),
                &text(&linked, "url").unwrap_or_default(),
                text(case, "fallbackHost").as_deref(),
            ))
        }
        other => json!({"error": format!("unknown op {other}")}),
    }
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        std::process::exit(2);
    }
    let cases: Vec<Value> = serde_json::from_str(&input).unwrap_or_default();
    let answers: Vec<Value> = cases.iter().map(answer).collect();
    println!("{}", Value::Array(answers));
}
