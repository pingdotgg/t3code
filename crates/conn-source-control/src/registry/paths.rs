//! The URL path routes of the host definitions, without a regex engine. Each function names the
//! T3 pattern it follows. JavaScript's `\d` under the `u` flag is ASCII digits only, and
//! `[^/]+` is one non-empty path segment.

/// A route match: the repository path (as written in the URL's path) and the number's digits.
pub(crate) struct RouteMatch<'a> {
    pub repository: &'a str,
    pub digits: &'a str,
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// The path's segments after its leading `/`, with the byte offset each starts at.
fn segments(path: &str) -> Option<Vec<(usize, &str)>> {
    let rest = path.strip_prefix('/')?;
    let mut offset = 1;
    let mut out = Vec::new();
    for part in rest.split('/') {
        out.push((offset, part));
        offset += part.len() + 1;
    }
    Some(out)
}

/// The text of segments `from..to` (exclusive), as one slice of `path`.
fn span<'a>(path: &'a str, parts: &[(usize, &'a str)], from: usize, to: usize) -> Option<&'a str> {
    let (start, _) = parts.get(from)?;
    let (last_start, last) = parts.get(to.checked_sub(1)?)?;
    path.get(*start..last_start + last.len())
}

/// `^/([^/]+/[^/]+)/<keyword>/(\d+)(?:/|$)` with `skip` fixed leading segments that must equal
/// `prefix` (Cursor Origin's `/codebase`).
pub(crate) fn two_segment_route<'a>(
    path: &'a str,
    prefix: Option<&str>,
    keywords: &[&str],
) -> Option<RouteMatch<'a>> {
    let parts = segments(path)?;
    let skip = usize::from(prefix.is_some());
    if let Some(prefix) = prefix
        && parts.first().map(|(_, s)| *s) != Some(prefix)
    {
        return None;
    }
    let owner = parts.get(skip)?.1;
    let name = parts.get(skip + 1)?.1;
    let keyword = parts.get(skip + 2)?.1;
    let digits = parts.get(skip + 3)?.1;
    if owner.is_empty() || name.is_empty() || !keywords.contains(&keyword) || !is_digits(digits) {
        return None;
    }
    Some(RouteMatch {
        repository: span(path, &parts, skip, skip + 2)?,
        digits,
    })
}

/// `^/([^/]+(?:/[^/]+)+)/<marker...>/(\d+)(?:/|$)`: a repository of two or more segments, then
/// the marker segments, then the number. The greedy group takes the last place that matches.
pub(crate) fn nested_route<'a>(path: &'a str, marker: &[&str]) -> Option<RouteMatch<'a>> {
    let parts = segments(path)?;
    // Every repository segment must be non-empty, so only the first empty segment bounds it.
    let first_empty = parts
        .iter()
        .position(|(_, s)| s.is_empty())
        .unwrap_or(parts.len());
    let mut end = first_empty.min(parts.len());
    while end >= 2 {
        let tail = parts.get(end..)?;
        let marker_ok = marker
            .iter()
            .enumerate()
            .all(|(i, m)| tail.get(i).map(|(_, s)| *s) == Some(*m));
        let digits = tail.get(marker.len()).map(|(_, s)| *s);
        if marker_ok && let Some(digits) = digits.filter(|d| is_digits(d)) {
            return Some(RouteMatch {
                repository: span(path, &parts, 0, end)?,
                digits,
            });
        }
        end -= 1;
    }
    None
}

/// Azure DevOps: `^/((?:[^/]+/)*_git/[^/]+)/pullrequest/(\d+)(?:/|$)`. The greedy prefix takes
/// the last `_git` that matches.
pub(crate) fn azure_route(path: &str) -> Option<RouteMatch<'_>> {
    let parts = segments(path)?;
    let first_empty = parts
        .iter()
        .position(|(_, s)| s.is_empty())
        .unwrap_or(parts.len());
    let mut index = first_empty.min(parts.len());
    while index > 0 {
        index -= 1;
        // The repository ends at `_git/<name>`; the segments up to it are non-empty.
        let git = index;
        let name_index = git + 1;
        if name_index >= first_empty {
            continue;
        }
        if parts.get(git).map(|(_, s)| *s) != Some("_git") {
            continue;
        }
        if parts.get(name_index + 1).map(|(_, s)| *s) != Some("pullrequest") {
            continue;
        }
        let Some(digits) = parts
            .get(name_index + 2)
            .map(|(_, s)| *s)
            .filter(|d| is_digits(d))
        else {
            continue;
        };
        return Some(RouteMatch {
            repository: span(path, &parts, 0, name_index + 1)?,
            digits,
        });
    }
    None
}

/// `Number(digits)` when it is a safe integer above zero, as `parseChangeRequestPath` checks.
pub(crate) fn change_request_number(digits: &str) -> Option<u64> {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() || trimmed.len() > 16 {
        return None;
    }
    let number: u64 = trimmed.parse().ok()?;
    (number <= MAX_SAFE_INTEGER).then_some(number)
}

/// JavaScript's `Number.MAX_SAFE_INTEGER`.
pub(crate) const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `/^[\w.-]+$/u` on a GitHub owner or repository name, and not `.` or `..`.
pub(crate) fn is_github_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(m: Option<RouteMatch<'_>>) -> Option<(String, String)> {
        m.map(|m| (m.repository.to_owned(), m.digits.to_owned()))
    }

    #[test]
    fn two_segment_routes_match_as_the_patterns_do() {
        let pull = |p| route(two_segment_route(p, None, &["pull"]));
        assert_eq!(
            pull("/a/b/pull/12"),
            Some(("a/b".into(), "12".into())),
            "plain"
        );
        assert_eq!(
            pull("/a/b/pull/12/files"),
            Some(("a/b".into(), "12".into())),
            "below"
        );
        assert_eq!(pull("/a/b/pull/12x"), None, "digits only");
        assert_eq!(pull("/a//pull/1"), None, "empty segment");
        assert_eq!(pull("/a/b/pulls/1"), None, "other keyword");
        let origin = |p| route(two_segment_route(p, Some("codebase"), &["pull"]));
        assert_eq!(
            origin("/codebase/a/b/pull/3"),
            Some(("a/b".into(), "3".into())),
            "origin"
        );
        assert_eq!(origin("/a/b/pull/3"), None, "origin needs its prefix");
    }

    #[test]
    fn nested_routes_take_the_last_match() {
        let mr = |p| route(nested_route(p, &["-", "merge_requests"]));
        assert_eq!(
            mr("/g/s/p/-/merge_requests/4"),
            Some(("g/s/p".into(), "4".into())),
            "nested"
        );
        assert_eq!(mr("/p/-/merge_requests/4"), None, "two segments at least");
        assert_eq!(
            mr("/a/b/-/merge_requests/1/-/merge_requests/2"),
            Some(("a/b/-/merge_requests/1".into(), "2".into())),
            "greedy"
        );
        assert_eq!(mr("/a//b/-/merge_requests/1"), None, "empty segment before");
    }

    #[test]
    fn azure_routes() {
        let az = |p| route(azure_route(p));
        assert_eq!(
            az("/o/p/_git/r/pullrequest/9"),
            Some(("o/p/_git/r".into(), "9".into())),
            "dev"
        );
        assert_eq!(
            az("/_git/r/pullrequest/9"),
            Some(("_git/r".into(), "9".into())),
            "no prefix"
        );
        assert_eq!(az("/o/p/_git//pullrequest/9"), None, "empty name");
    }

    #[test]
    fn numbers_are_safe_integers_above_zero() {
        assert_eq!(change_request_number("0012"), Some(12), "leading zeros");
        assert_eq!(change_request_number("0"), None, "zero");
        assert_eq!(
            change_request_number("9007199254740991"),
            Some(MAX_SAFE_INTEGER),
            "max"
        );
        assert_eq!(change_request_number("9007199254740992"), None, "above max");
    }
}
