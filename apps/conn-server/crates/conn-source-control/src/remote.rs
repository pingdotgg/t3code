//! Remote and clone URL text, as the T3 server reads it: `packages/shared/src/cloneUrl.ts`,
//! `parseGitRemoteRepository` and `normalizeGitRemoteUrl` (`packages/shared/src/git.ts`), the
//! registry's `repositoryKeyFromRemote`, and the redaction helpers of
//! `SourceControlRepositoryService.ts`.
//!
//! The T3 code uses regular expressions and the WHATWG URL parser. Each function here says
//! which pattern it follows; none needs a regex engine.

use crate::hosts::github::encode_uri_component;

/// `CloneProtocol`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloneProtocol {
    Ssh,
    Https,
}

/// `parseCloneUrl`'s answer.
#[derive(Clone, Debug, PartialEq, Eq)]
struct CloneUrl<'a> {
    protocol: CloneProtocol,
    host: &'a str,
    path: &'a str,
    custom_port: bool,
    scp: bool,
}

/// JavaScript's `\s`.
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// What `.` does not match without the `s` flag.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `.+` up to `$`: one or more characters, none a line terminator.
fn rest_of_line(text: &str) -> Option<&str> {
    (!text.is_empty() && !text.chars().any(is_line_terminator)).then_some(text)
}

/// `(\[[^\]@/\s]+\]|<plain>+)` followed by `(:\d+)?` and nothing else, where `plain` says
/// which characters a bare host may hold. Returns the host and whether a port followed.
fn host_and_port(text: &str, plain: impl Fn(char) -> bool) -> Option<(&str, bool)> {
    let (host, after) = if text.starts_with('[') {
        let close = text.find(']')?;
        let host = text.get(..=close)?;
        let inner = host.get(1..host.len() - 1)?;
        if inner.is_empty()
            || inner
                .chars()
                .any(|c| c == ']' || c == '@' || c == '/' || is_space(c))
        {
            return None;
        }
        (host, text.get(close + 1..)?)
    } else {
        let end = text.find(|c: char| !plain(c)).unwrap_or(text.len());
        (text.get(..end)?, text.get(end..)?)
    };
    if host.is_empty() {
        return None;
    }
    match after {
        "" => Some((host, false)),
        port => {
            let digits = port.strip_prefix(':')?;
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                .then_some((host, true))
        }
    }
}

/// `SSH_URL` and `HTTPS_URL`: `<scheme>(?:[^/\s]*@)?<host>(:\d+)?/(.+)`.
fn parse_scheme_url<'a>(
    text: &'a str,
    scheme_len: usize,
    protocol: CloneProtocol,
) -> Option<CloneUrl<'a>> {
    let rest = text.get(scheme_len..)?;
    let slash = rest.find('/')?;
    let authority = rest.get(..slash)?;
    let path = rest_of_line(rest.get(slash + 1..)?)?;
    let host_port = match authority.rfind('@') {
        Some(at) => {
            let user = authority.get(..at)?;
            if user.chars().any(is_space) {
                return None;
            }
            authority.get(at + 1..)?
        }
        None => authority,
    };
    let (host, custom_port) = host_and_port(host_port, |c| {
        !(c == '@' || c == ':' || c == '/' || is_space(c))
    })?;
    Some(CloneUrl {
        protocol,
        host,
        path,
        custom_port,
        scp: false,
    })
}

/// `SCP_LIKE_URL`: `^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s[\]]+):(?!\/)(.+)$`.
fn parse_scp_url(text: &str) -> Option<CloneUrl<'_>> {
    fn attempt(text: &str) -> Option<CloneUrl<'_>> {
        let plain = |c: char| !(c == ':' || c == '/' || c == '[' || c == ']' || is_space(c));
        let (host, path) = if text.starts_with('[') {
            let close = text.find(']')?;
            let host = text.get(..=close)?;
            host_and_port(host, plain)?;
            (host, text.get(close + 1..)?.strip_prefix(':')?)
        } else {
            let end = text.find(|c: char| !plain(c)).unwrap_or(text.len());
            let host = text.get(..end)?;
            (host, text.get(end..)?.strip_prefix(':')?)
        };
        if host.is_empty() || path.starts_with('/') {
            return None;
        }
        Some(CloneUrl {
            protocol: CloneProtocol::Ssh,
            host,
            path: rest_of_line(path)?,
            custom_port: false,
            scp: true,
        })
    }
    let with_user = text.split_once('@').and_then(|(user, rest)| {
        let valid = !user.is_empty() && !user.chars().any(|c| c == '/' || is_space(c));
        if valid { attempt(rest) } else { None }
    });
    with_user.or_else(|| attempt(text))
}

/// `parseCloneUrl`.
fn parse_clone_url(url: &str) -> Option<CloneUrl<'_>> {
    let trimmed = url.trim();
    if trimmed.starts_with("ssh://")
        && let Some(parsed) = parse_scheme_url(trimmed, "ssh://".len(), CloneProtocol::Ssh)
    {
        return Some(parsed);
    }
    for scheme in ["https://", "http://"] {
        if trimmed.starts_with(scheme)
            && let Some(parsed) = parse_scheme_url(trimmed, scheme.len(), CloneProtocol::Https)
        {
            return Some(parsed);
        }
    }
    parse_scp_url(trimmed)
}

/// `cloneUrlProtocol`.
pub fn clone_url_protocol(url: &str) -> Option<CloneProtocol> {
    parse_clone_url(url).map(|parsed| parsed.protocol)
}

/// `decodeURIComponent`: `None` where JavaScript throws.
pub(crate) fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            // Two hex digits exactly: `from_str_radix` would also take a sign.
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let text = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(text, 16).ok()?);
            index += 3;
        } else {
            out.push(byte);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `cloneUrlForProtocol`: the same repository over the other protocol, or `None` when it
/// cannot be rewritten safely (a custom port, a bad escape).
pub fn clone_url_for_protocol(url: &str, protocol: CloneProtocol) -> Option<String> {
    let parsed = parse_clone_url(url)?;
    if parsed.protocol == protocol {
        return Some(url.trim().to_owned());
    }
    if parsed.custom_port {
        return None;
    }
    match protocol {
        CloneProtocol::Ssh => Some(format!(
            "git@{}:{}",
            parsed.host,
            decode_uri_component(parsed.path)?
        )),
        CloneProtocol::Https => {
            let path = if parsed.scp {
                parsed
                    .path
                    .split('/')
                    .map(encode_uri_component)
                    .collect::<Vec<_>>()
                    .join("/")
            } else {
                parsed.path.to_owned()
            };
            Some(format!("https://{}/{path}", parsed.host))
        }
    }
}

/// `canonicalPathSegment`: decode, lower, encode, lower; lower only where decoding throws.
/// Lowering before encoding matters: lowering the escape `%C3%84` never reaches the `Ä` it names.
fn canonical_path_segment(segment: &str) -> String {
    match decode_uri_component(segment) {
        Some(decoded) => {
            crate::hosts::github::encode_uri_component(&decoded.to_lowercase()).to_lowercase()
        }
        None => segment.to_lowercase(),
    }
}

/// `canonicalRepositoryPath`: a repository path in one lower-case spelling, so `a%20(b)`,
/// `a%20%28b%29` and `a (b)` compare equal.
pub fn canonical_repository_path(path: &str) -> String {
    path.split('/')
        .map(canonical_path_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// `stripGitSuffix`, or the path as written when `keep_git_suffix`.
fn drop_git_suffix(path: &str, keep_git_suffix: bool) -> &str {
    if keep_git_suffix {
        return path;
    }
    match path
        .len()
        .checked_sub(4)
        .and_then(|at| path.get(at..).map(|s| (at, s)))
    {
        Some((at, suffix)) if suffix.eq_ignore_ascii_case(".git") => path.get(..at).unwrap_or(path),
        _ => path,
    }
}

/// `lowerCaseRemote`.
fn lower_case_remote(value: &str, keep_git_suffix: bool) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    drop_git_suffix(trimmed, keep_git_suffix).to_lowercase()
}

/// `parseGitRemoteRepository`: the host and repository path a remote names, lower case and
/// without a port, or `None` for a remote that names no host, such as a local path. The path
/// drops a `.git` suffix and takes `canonicalRepositoryPath`'s spelling.
///
/// A URL goes through the WHATWG parser (`url`), as `new URL` reads it.
pub fn parse_git_remote_repository(value: &str) -> Option<(String, String)> {
    parse_git_remote_repository_with(value, false)
}

/// `parseGitRemoteRepository(value, { keepGitSuffix })`.
fn parse_git_remote_repository_with(
    value: &str,
    keep_git_suffix: bool,
) -> Option<(String, String)> {
    let normalized = lower_case_remote(value, keep_git_suffix);
    let is_url = ["ssh://", "https://", "http://", "git://"]
        .iter()
        .any(|scheme| normalized.starts_with(scheme));
    if is_url {
        // `new URL(value.trim().toLowerCase())`: the WHATWG parser, IDNA and escapes included.
        let url = url::Url::parse(&value.trim().to_lowercase()).ok()?;
        let hostname = url.host_str().unwrap_or_default();
        let path = drop_git_suffix(url.path().trim_end_matches('/'), keep_git_suffix);
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        return (!hostname.is_empty() && segments.len() > 1).then(|| {
            (
                hostname.to_owned(),
                canonical_repository_path(&segments.join("/")),
            )
        });
    }
    // A userless one-letter prefix is a Windows drive, not an SCP host.
    let mut chars = normalized.chars();
    if chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':') {
        return None;
    }
    // `^(?:[a-zA-Z0-9._-]+@)?(\[[0-9a-f:.]+\]|[^@:/\\\s[\]]+):\/?([^/\s]+(?:\/[^/\s]+)+)$`
    fn attempt(text: &str) -> Option<(String, String)> {
        let (host, path) = if text.starts_with('[') {
            let (inside, rest) = text.get(1..)?.split_once(']')?;
            let valid = !inside.is_empty()
                && inside
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || matches!(b, b':' | b'.'));
            if !valid {
                return None;
            }
            (text.get(..inside.len() + 2)?, rest.strip_prefix(':')?)
        } else {
            let (host, path) = text.split_once(':')?;
            if host.is_empty()
                || host
                    .chars()
                    .any(|c| matches!(c, '@' | '/' | '\\' | '[' | ']') || is_space(c))
            {
                return None;
            }
            (host, path)
        };
        let path = path.strip_prefix('/').unwrap_or(path);
        let segments: Vec<&str> = path.split('/').collect();
        let valid = segments.len() > 1
            && segments
                .iter()
                .all(|s| !s.is_empty() && !s.chars().any(is_space));
        if !valid {
            return None;
        }
        let path = canonical_repository_path(path);
        if !host.starts_with('[') {
            return Some((host.to_owned(), path));
        }
        // Spell an IPv6 host as the URL branch does, so `[::1]:a/b` and `ssh://[::1]/a/b` share
        // a key.
        let url = url::Url::parse(&format!("ssh://{host}")).ok()?;
        Some((url.host_str()?.to_owned(), path))
    }
    let with_user = normalized.split_once('@').and_then(|(user, rest)| {
        let valid = !user.is_empty()
            && user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if valid { attempt(rest) } else { None }
    });
    with_user.or_else(|| attempt(&normalized))
}

/// `normalizeGitRemoteUrl`: `host/path` for a remote that names a host, else the remote itself,
/// lower case.
pub fn normalize_git_remote_url(value: &str) -> String {
    match parse_git_remote_repository(value) {
        Some((host, path)) => format!("{host}/{path}"),
        None => lower_case_remote(value, false),
    }
}

/// The registry's `repositoryKeyFromRemote`, with only the GitHub definition registered.
pub fn repository_key_from_remote(remote_url: &str) -> String {
    normalize_git_remote_url(remote_url)
}

/// `scheme://` at `index`: `[a-z][a-z0-9+.-]*://`, case-insensitive. Returns the index after
/// the `://`.
fn scheme_at(text: &str, index: usize) -> Option<usize> {
    let rest = text.get(index..)?;
    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
        .unwrap_or(rest.len());
    rest.get(end..)?
        .starts_with("://")
        .then_some(index + end + 3)
}

/// `\b` before a letter at `index`: the character before is not a word character.
fn word_boundary_before(text: &str, index: usize) -> bool {
    text.get(..index)
        .and_then(|before| before.chars().next_back())
        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
}

/// One pass of a global replace: at each index where `matcher` finds a match `(end,
/// replacement)`, the matched text is replaced and the scan continues after it.
fn replace_all(text: &str, matcher: impl Fn(&str, usize) -> Option<(usize, String)>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        if let Some((end, replacement)) = matcher(text, index) {
            out.push_str(&replacement);
            index = end;
            continue;
        }
        let Some(c) = text.get(index..).and_then(|rest| rest.chars().next()) else {
            break;
        };
        out.push(c);
        index += c.len_utf8();
    }
    out
}

/// `redactUrlCredentials`: drops a URL's query (also inside quotes) and its userinfo from a
/// line of git's stderr.
pub fn redact_url_credentials(text: &str) -> String {
    // QUOTED_URL_QUERY: (['"])(<scheme>://[^\s?]*)\?.*\1(?=[\s:]|$) -> $1$2$1
    let quoted = replace_all(text, |text, index| {
        let quote = text
            .get(index..)?
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"'))?;
        let url_start = index + 1;
        let after_scheme = scheme_at(text, url_start)?;
        let rest = text.get(after_scheme..)?;
        let stop = rest.find(|c: char| c == '?' || is_space(c))?;
        if !rest.get(stop..)?.starts_with('?') {
            return None;
        }
        let query_start = after_scheme + stop;
        let tail = text.get(query_start + 1..)?;
        let line = tail.find(is_line_terminator).unwrap_or(tail.len());
        let tail = tail.get(..line)?;
        // `.*` is greedy: the last quote on the line that `(?=[\s:]|$)` accepts. A line
        // terminator after it counts as `\s`.
        let full_tail = text.get(query_start + 1..)?;
        let close = tail.char_indices().rev().find_map(|(i, c)| {
            let next = full_tail.get(i + c.len_utf8()..)?.chars().next();
            (c == quote && next.is_none_or(|n| is_space(n) || n == ':')).then_some(i)
        })?;
        let url = text.get(url_start..query_start)?;
        Some((query_start + 1 + close + 1, format!("{quote}{url}{quote}")))
    });
    // URL_QUERY: \b(<scheme>://[^\s?]*)\?[^\s]* -> $1
    let queried = replace_all(&quoted, |text, index| {
        if !word_boundary_before(text, index) {
            return None;
        }
        let after_scheme = scheme_at(text, index)?;
        let rest = text.get(after_scheme..)?;
        let stop = rest.find(|c: char| c == '?' || is_space(c))?;
        if !rest.get(stop..)?.starts_with('?') {
            return None;
        }
        let query_start = after_scheme + stop;
        let tail = text.get(query_start..)?;
        let end = tail.find(is_space).unwrap_or(tail.len());
        Some((query_start + end, text.get(index..query_start)?.to_owned()))
    });
    // URL_WITH_USERINFO: \b(<scheme>://)[^\s/?#]+@ -> $1
    replace_all(&queried, |text, index| {
        if !word_boundary_before(text, index) {
            return None;
        }
        let after_scheme = scheme_at(text, index)?;
        let rest = text.get(after_scheme..)?;
        let run = rest
            .find(|c: char| matches!(c, '/' | '?' | '#') || is_space(c))
            .unwrap_or(rest.len());
        let at = rest.get(..run)?.rfind('@')?;
        (at > 0).then(|| {
            (
                after_scheme + at + 1,
                text.get(index..after_scheme).unwrap_or_default().to_owned(),
            )
        })
    })
}

/// `redactRemoteUrl`: a clone URL without its userinfo and query, as the client may see it.
/// Text that is not a `scheme://` URL is kept as it is.
pub fn redact_remote_url(remote_url: &str) -> String {
    let Some(after_scheme) = scheme_at(remote_url, 0) else {
        return remote_url.to_owned();
    };
    let Some(rest) = remote_url.get(after_scheme..) else {
        return remote_url.to_owned();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = rest.get(..authority_end).unwrap_or_default();
    let userinfo = authority.rfind('@');
    let tail = rest.get(authority_end..).unwrap_or_default();
    let fragment_start = tail.find('#').unwrap_or(tail.len());
    let before_fragment = tail.get(..fragment_start).unwrap_or_default();
    let query = before_fragment.find('?');
    if userinfo.is_none() && query.is_none_or(|q| q + 1 == before_fragment.len()) {
        return remote_url.to_owned();
    }
    let host = userinfo.map_or(authority, |at| authority.get(at + 1..).unwrap_or_default());
    let path = query.map_or(before_fragment, |q| {
        before_fragment.get(..q).unwrap_or_default()
    });
    let scheme = remote_url.get(..after_scheme).unwrap_or_default();
    format!(
        "{scheme}{host}{path}{}",
        tail.get(fragment_start..).unwrap_or_default()
    )
}

/// `normalizedCloneUrl` in `runClone`: git misreads `@` in a pathless URL's query as userinfo,
/// so `scheme://host?query` gets a `/` before the `?`.
pub fn normalize_clone_url(clone_url: &str) -> String {
    if let Some(after_scheme) = scheme_at(clone_url, 0)
        && let Some(rest) = clone_url.get(after_scheme..)
    {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        if end > 0 && rest.get(end..).is_some_and(|t| t.starts_with('?')) {
            let split = after_scheme + end;
            return format!(
                "{}/{}",
                clone_url.get(..split).unwrap_or_default(),
                clone_url.get(split..).unwrap_or_default()
            );
        }
    }
    clone_url.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_url_protocol_follows_clone_url_ts() {
        assert_eq!(
            clone_url_protocol("git@github.com:o/r.git"),
            Some(CloneProtocol::Ssh)
        );
        assert_eq!(
            clone_url_protocol("ssh://git@host:22/o/r"),
            Some(CloneProtocol::Ssh)
        );
        assert_eq!(
            clone_url_protocol("https://github.com/o/r"),
            Some(CloneProtocol::Https)
        );
        assert_eq!(clone_url_protocol("/local/path"), None);
        assert_eq!(
            clone_url_protocol("C:/x"),
            None,
            "`(?!\\/)` refuses a slash after the colon"
        );
    }

    #[test]
    fn rewrites_to_the_other_protocol() {
        assert_eq!(
            clone_url_for_protocol("git@github.com:o/r.git", CloneProtocol::Https).as_deref(),
            Some("https://github.com/o/r.git")
        );
        assert_eq!(
            clone_url_for_protocol("https://github.com/o/r", CloneProtocol::Ssh).as_deref(),
            Some("git@github.com:o/r")
        );
        assert_eq!(
            clone_url_for_protocol("ssh://git@host:2222/o/r", CloneProtocol::Https),
            None,
            "custom port"
        );
        assert_eq!(
            clone_url_for_protocol("git@host:a b/c", CloneProtocol::Https).as_deref(),
            Some("https://host/a%20b/c"),
            "SCP paths are literal and get encoded"
        );
        assert_eq!(
            clone_url_for_protocol("https://host/a%zz", CloneProtocol::Ssh),
            None,
            "bad escape"
        );
    }

    #[test]
    fn repository_keys_follow_the_registry() {
        assert_eq!(
            repository_key_from_remote("git@GitHub.com:Owner/Repo.git"),
            "github.com/owner/repo"
        );
        assert_eq!(
            repository_key_from_remote("https://github.com/owner/repo/"),
            "github.com/owner/repo"
        );
        assert_eq!(
            repository_key_from_remote("ssh://user@host:2222/owner/repo.git"),
            "host/owner/repo"
        );
        assert_eq!(
            repository_key_from_remote("git@ssh.dev.azure.com:v3/org/proj/repo"),
            "ssh.dev.azure.com/v3/org/proj/repo"
        );
        assert_eq!(
            repository_key_from_remote("/srv/repos/x.git"),
            "/srv/repos/x"
        );
        assert_eq!(
            repository_key_from_remote("C:/repos/x"),
            "c:/repos/x",
            "a drive"
        );
        // Escaped names and IPv6 SCP hosts keep the shared git spelling.
        assert_eq!(
            repository_key_from_remote("https://github.com/o/a%20%28B%29.git"),
            "github.com/o/a%20(b)"
        );
        assert_eq!(
            repository_key_from_remote("https://dev.azure.com/o/p/_git/r.git"),
            "dev.azure.com/o/p/_git/r"
        );
        assert_eq!(repository_key_from_remote("git@[::1]:o/r.git"), "[::1]/o/r");
        assert_eq!(canonical_repository_path("A%C3%84/%zz"), "a%c3%a4/%zz");
    }

    // SourceControlRepositoryService.test.ts: "strips embedded credentials from the remote URL
    // it reports" and "redacts query tokens and userinfo containing '@' from reported URLs".
    #[test]
    fn redacts_remote_urls() {
        assert_eq!(
            redact_remote_url("https://user:secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            redact_remote_url("https://us@er:p@ss@host/o/r?token=abc"),
            "https://host/o/r"
        );
        assert_eq!(
            redact_remote_url("git@github.com:o/r.git"),
            "git@github.com:o/r.git"
        );
        assert_eq!(
            redact_remote_url("https://github.com/o/r"),
            "https://github.com/o/r"
        );
    }

    #[test]
    fn redacts_credentials_in_git_text() {
        assert_eq!(
            redact_url_credentials("fatal: unable to access 'https://u:p@host/r?x=1': error"),
            "fatal: unable to access 'https://host/r': error"
        );
        assert_eq!(
            redact_url_credentials("remote: https://a@b@host/x?tok=1 failed"),
            "remote: https://host/x failed"
        );
        assert_eq!(redact_url_credentials("no url here"), "no url here");
    }

    #[test]
    fn normalizes_a_pathless_query() {
        assert_eq!(
            normalize_clone_url("https://host?x=a@b"),
            "https://host/?x=a@b"
        );
        assert_eq!(normalize_clone_url("https://host/o/r"), "https://host/o/r");
    }
}
