//! A thread pull request link's identity, as T3's `makeThreadPullRequests` binds it to the
//! registry (`packages/source-control-core/src/shared/threadPullRequests.ts`):
//! `normalizeThreadPullRequestKey`, `legacyThreadPullRequestKey` and `threadPullRequestKeyOf`.

use super::{
    canonical_repository_key, find_by_repository_key, parse_change_request_url, parse_url,
};

/// `ThreadPullRequestKey`: lower case host and repository, and the number.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ThreadPullRequestKey {
    pub host: String,
    pub repository: String,
    pub number: u64,
}

impl ThreadPullRequestKey {
    /// `threadPullRequestKeyOf` of a normalized key: `host/repository#number`.
    pub fn text(&self) -> String {
        format!("{}/{}#{}", self.host, self.repository, self.number)
    }
}

/// What a key is read from: a link or a parsed URL (`ThreadPullRequestKeySource`).
#[derive(Clone, Copy, Debug)]
pub struct KeySource<'a> {
    pub host: &'a str,
    pub repository: &'a str,
    pub number: u64,
    pub authority: Option<&'a str>,
    pub url: Option<&'a str>,
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `normalizeThreadPullRequestKey`.
pub fn normalize_thread_pull_request_key(key: KeySource<'_>) -> ThreadPullRequestKey {
    let authority = key.authority.map(str::to_owned).or_else(|| {
        let parsed = key.url.and_then(parse_change_request_url)?.1.link;
        (parsed.repository == js_trim(key.repository).to_lowercase() && parsed.number == key.number)
            .then_some(parsed.authority)
            .flatten()
    });
    let host = authority.as_deref().unwrap_or(key.host);
    let canonical = canonical_repository_key(&format!(
        "{}/{}",
        js_trim(host).to_lowercase(),
        js_trim(key.repository).to_lowercase()
    ));
    // `slice(0, indexOf("/"))`: the key always holds the `/` written above.
    let (host, repository) = canonical
        .split_once('/')
        .unwrap_or(("", canonical.as_str()));
    ThreadPullRequestKey {
        host: host.to_owned(),
        repository: repository.to_owned(),
        number: key.number,
    }
}

/// `threadPullRequestKeyOf`.
pub fn thread_pull_request_key_of(key: KeySource<'_>) -> String {
    normalize_thread_pull_request_key(key).text()
}

/// `threadPullRequestKeysEqual`.
pub fn thread_pull_request_keys_equal(left: KeySource<'_>, right: KeySource<'_>) -> bool {
    thread_pull_request_key_of(left) == thread_pull_request_key_of(right)
}

/// `legacyThreadPullRequestKey`: the key of an older single `linkedPullRequest`.
pub fn legacy_thread_pull_request_key(
    repository: &str,
    number: u64,
    url: &str,
    fallback_host: Option<&str>,
) -> ThreadPullRequestKey {
    if let Some((_, parsed)) = parse_change_request_url(url) {
        let link = &parsed.link;
        if link.number == number
            && (link.authority.is_some()
                || find_by_repository_key(&format!("{}/{}", link.host, link.repository)).is_some())
        {
            return normalize_thread_pull_request_key(KeySource {
                host: &link.host,
                repository: &link.repository,
                number: link.number,
                authority: link.authority.as_deref(),
                url: None,
            });
        }
    }
    let host = match fallback_host {
        Some(host) => host.to_owned(),
        None => parse_url(url).map_or_else(|| "unknown".to_owned(), |u| super::hostname(&u)),
    };
    let host = js_trim(&host).to_lowercase();
    ThreadPullRequestKey {
        host: if host.is_empty() {
            "unknown".to_owned()
        } else {
            host
        },
        repository: js_trim(repository).to_lowercase(),
        number,
    }
}
