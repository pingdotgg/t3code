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
        kind("https://gitlab.example.com/g/p").as_deref(),
        Some("gitlab"),
        "gitlab label"
    );
    assert_eq!(
        kind("git@git.cafe:o/r.git").as_deref(),
        Some("gitcafe"),
        "gitcafe"
    );
    // `gitea.github.example`: Forgejo is asked before GitHub.
    assert_eq!(
        kind("https://gitea.github.example/o/r").as_deref(),
        Some("forgejo"),
        "overlap"
    );
    assert_eq!(
        kind("git@ssh.dev.azure.com:v3/o/p/r").as_deref(),
        Some("azure-devops"),
        "azure"
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
    let (host, parsed) = parse_change_request_url("https://git.cafe/o/r/pull/3").expect("parsed");
    assert_eq!(
        host,
        HostKind::GitCafe,
        "GitCafe claims its own hosts first"
    );
    assert_eq!(parsed.link.number, 3, "number");
    let (host, _) = parse_change_request_url("https://ghe.example/o/r/pull/3").expect("parsed");
    assert_eq!(host, HostKind::GitHub, "any host serves GitHub's route");
    let (host, parsed) =
        parse_change_request_url("https://cursor.com/codebase/O/R/pull/5").expect("parsed");
    assert_eq!(host, HostKind::CursorOrigin, "origin");
    assert_eq!(
        parsed.link.host, "origin.cursor.com",
        "keyed under the git host"
    );
    assert_eq!(parsed.link.repository, "o/r", "lower case");
    let (host, parsed) =
        parse_change_request_url("http://forge.example:3000/a/b/pulls/7").expect("parsed");
    assert_eq!(host, HostKind::Forgejo, "forgejo");
    assert_eq!(
        parsed.link.authority.as_deref(),
        Some("forge.example:3000"),
        "authority"
    );
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
    assert_eq!(
        HostKind::GitLab
            .change_request_url(input("gitlab.com", "g/s/p"))
            .as_deref(),
        Some("https://gitlab.com/g/s/p/-/merge_requests/12"),
        "gitlab"
    );
    assert_eq!(
        HostKind::AzureDevOps
            .change_request_url(input("ssh.dev.azure.com", "v3/o/p/r"))
            .as_deref(),
        Some("https://dev.azure.com/o/p/_git/r/pullrequest/12"),
        "azure in its web spelling"
    );
    let forgejo = ChangeRequestUrlInput {
        remote_url: Some("http://forge.example:3000/a/b.git"),
        ..input("forge.example:3000", "a/b")
    };
    assert_eq!(
        HostKind::Forgejo.change_request_url(forgejo).as_deref(),
        Some("http://forge.example:3000/a/b/pulls/12"),
        "an HTTP remote names the origin"
    );
}

#[test]
fn repository_keys_and_selectors() {
    assert_eq!(
        canonical_repository_key("org.visualstudio.com/defaultcollection/p/_git/r"),
        "dev.azure.com/org/p/_git/r",
        "legacy azure"
    );
    assert_eq!(
        canonical_repository_key("github.com/o/r"),
        "github.com/o/r",
        "unchanged"
    );
    let identity = ProjectIdentity {
        provider: Some("azure-devops".into()),
        display_name: Some("org/p/_git/my%20repo".into()),
        ..ProjectIdentity::default()
    };
    assert_eq!(
        repository_selector(&identity).as_deref(),
        Some("my repo"),
        "azure decodes"
    );
    assert_eq!(
        canonicalize_gitcafe_pull_request_url("https://git.cafe/o/r/pull/4?x=1"),
        "https://git.cafe/o/r/pulls/4",
        "gitcafe spelling"
    );
}

#[test]
fn thread_keys_are_canonical() {
    let key = normalize_thread_pull_request_key(KeySource {
        host: "SSH.dev.azure.com",
        repository: "v3/O/P/R",
        number: 3,
        authority: None,
        url: None,
    });
    assert_eq!(key.text(), "dev.azure.com/o/p/_git/r#3", "azure");
    let key = normalize_thread_pull_request_key(KeySource {
        host: "forge.example",
        repository: "a/b",
        number: 7,
        authority: None,
        url: Some("http://forge.example:3000/a/b/pulls/7"),
    });
    assert_eq!(key.host, "forge.example:3000", "the URL's authority");
    let legacy = legacy_thread_pull_request_key("O/R", 2, "https://github.com/o/r/pull/2", None);
    assert_eq!(legacy.text(), "github.com/o/r#2", "legacy");
}
