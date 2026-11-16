//! Cases from T3's `definition.test.ts` files. `tools/registry-diff.mjs` runs many more against
//! T3's own registry.

use super::thread_keys::{
    KeySource, legacy_thread_pull_request_key, normalize_thread_pull_request_key,
};
use super::*;

fn kind(remote: &str) -> Option<String> {
    recognize_remote(remote).map(|p| p.kind)
}

#[test]
fn remotes_are_recognized_in_the_registry_order() {
    assert_eq!(
        kind("git@github.com:o/r.git").as_deref(),
        Some("github"),
        "github scp"
    );
    assert_eq!(
        kind("https://git.example.com/o/r").as_deref(),
        Some("unknown"),
        "unknown"
    );
    assert_eq!(kind("/srv/repo.git"), None, "a local path names no host");
    let enterprise = recognize_remote("https://github.acme.com:8443/o/r").expect("a host");
    assert_eq!(enterprise.name, "GitHub Self-Hosted", "self-hosted name");
    assert_eq!(
        enterprise.base_url, "https://github.acme.com:8443",
        "keeps the HTTP port"
    );
    let ssh = recognize_remote("ssh://git@github.acme.com:2222/o/r").expect("a host");
    assert_eq!(ssh.base_url, "https://github.acme.com", "drops an SSH port");
}

#[test]
fn change_request_urls_are_claimed_in_order() {
    let (host, parsed) = parse_change_request_url("https://github.com/O/R/pull/3").expect("parsed");
    assert_eq!(host, HostKind::GitHub);
    assert_eq!(parsed.link.repository, "o/r");
    assert_eq!(parsed.link.number, 3);
    let (host, _) = parse_change_request_url("https://ghe.example/o/r/pull/3").expect("parsed");
    assert_eq!(host, HostKind::GitHub, "any host serves GitHub's route");
    assert!(
        parse_change_request_url("ftp://github.com/o/r/pull/1").is_none(),
        "HTTP only"
    );
    assert!(
        parse_change_request_url("https://github.com/o/r/pull/0").is_none(),
        "above zero"
    );
}

#[test]
fn change_request_urls_are_built_per_host() {
    let input = |host, repository| ChangeRequestUrlInput {
        host,
        repository,
        number: 12,
        remote_url: None,
        web_url: None,
    };
    assert_eq!(
        HostKind::GitHub
            .change_request_url(input("github.com", "o/r"))
            .as_deref(),
        Some("https://github.com/o/r/pull/12"),
        "github"
    );
    assert_eq!(
        HostKind::GitHub.change_request_url(input("github.com", "o/r/x")),
        None,
        "github paths are owner/name"
    );
}

#[test]
fn repository_keys_and_selectors() {
    assert_eq!(canonical_repository_key("github.com/o/r"), "github.com/o/r");
    let identity = ProjectIdentity {
        provider: Some("unknown".into()),
        display_name: Some("group/project/repo".into()),
        ..ProjectIdentity::default()
    };
    assert_eq!(
        repository_selector(&identity).as_deref(),
        Some("group/project/repo")
    );
}

#[test]
fn thread_keys_are_canonical() {
    let key = normalize_thread_pull_request_key(KeySource {
        host: "GitHub.com",
        repository: "O/R",
        number: 3,
        authority: None,
        url: None,
    });
    assert_eq!(key.text(), "github.com/o/r#3");
    let legacy = legacy_thread_pull_request_key("O/R", 2, "https://github.com/o/r/pull/2", None);
    assert_eq!(legacy.text(), "github.com/o/r#2");
}

#[test]
fn removed_hosts_use_the_unknown_remote_fallback() {
    for host in [
        "gitlab.com",
        "git.cafe",
        "staging.git.cafe",
        "origin.cursor.com",
        "codeberg.org",
        "forgejo.example",
        "gitea.example",
        "bitbucket.org",
        "dev.azure.com",
    ] {
        let remote = format!("https://{host}/owner/repo.git");
        assert_eq!(
            recognize_remote(&remote),
            Some(ProviderInfo {
                kind: "unknown".into(),
                name: host.into(),
                base_url: format!("https://{host}"),
            }),
            "{remote}"
        );
        assert_eq!(
            repository_key_from_remote(&remote),
            format!("{host}/owner/repo")
        );
        assert_eq!(find_by_public_host(host), None, "{host}");
    }
}
