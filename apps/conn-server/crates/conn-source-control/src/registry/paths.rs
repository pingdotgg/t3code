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

/// GitHub's `^/([^/]+/[^/]+)/pull/(\d+)(?:/|$)` route.
pub(crate) fn github_route(path: &str) -> Option<RouteMatch<'_>> {
    let parts = segments(path)?;
    let owner = parts.first()?.1;
    let name = parts.get(1)?.1;
    let keyword = parts.get(2)?.1;
    let digits = parts.get(3)?.1;
    if owner.is_empty() || name.is_empty() || keyword != "pull" || !is_digits(digits) {
        return None;
    }
    Some(RouteMatch {
        repository: span(path, &parts, 0, 2)?,
        digits,
    })
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
    fn github_routes_match_the_pattern() {
        let pull = |p| route(github_route(p));
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
