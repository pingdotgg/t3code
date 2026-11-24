//! What the Browser panel's address bar does with what was typed (web Conn's
//! `resolveAddressBarInput` and `normalizePreviewUrl` in `packages/shared/src/preview.ts`).
//!
//! A full URL loads as it is. A host such as `example.com` or `localhost:3000` gets a scheme:
//! `http` for this machine and the local network (a dev server there rarely speaks TLS), `https`
//! for everything else, so the first request is not an `http` one that the site redirects. Text
//! that is not a host, such as `rust lifetimes`, is searched for (web's default engine is
//! DuckDuckGo).

/// Where a search for the typed text goes (`BROWSER_SEARCH_URL_TEMPLATES.duckduckgo`).
const SEARCH_URL: &str = "https://duckduckgo.com/?q=";

/// The URL to load for `raw`; an empty address is the blank page.
pub(crate) fn resolve_address(raw: &str) -> String {
    let typed = raw.trim();
    if typed.is_empty() {
        return "about:blank".to_owned();
    }
    if has_scheme_with_authority(typed) || is_opaque_url(typed) {
        return typed.to_owned();
    }
    if !typed.contains(char::is_whitespace)
        && let Some(host) = host_of(typed)
    {
        let scheme = if is_local_host(&host) {
            "http"
        } else {
            "https"
        };
        return format!("{scheme}://{typed}");
    }
    format!("{SEARCH_URL}{}", encode_uri_component(typed))
}

/// `scheme://`, as `http://` or `file://`.
fn has_scheme_with_authority(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Schemes without `//` that the address bar passes on untouched.
fn is_opaque_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["about:", "data:", "blob:", "file:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// The host of `text` when it reads as an address (`ADDRESS_HOST_PATTERN`): `localhost`, an IP,
/// a name with a dot, or anything with a port.
fn host_of(text: &str) -> Option<String> {
    let authority = text.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, has_port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            (host, true)
        }
        _ => (authority, false),
    };
    if host.is_empty() {
        return None;
    }
    let is_ip_literal = host.starts_with('[') && host.ends_with(']');
    let is_dotted = {
        let trimmed = host.trim_end_matches('.');
        let labels: Vec<&str> = trimmed.split('.').collect();
        labels.len() >= 2 && labels.iter().all(|label| !label.is_empty())
    };
    let is_valid_chars = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']' | ':'));
    if !is_valid_chars {
        return None;
    }
    (has_port || is_ip_literal || host.eq_ignore_ascii_case("localhost") || is_dotted)
        .then(|| host.to_ascii_lowercase())
}

/// This machine or the local network: `localhost`, loopback and private IPv4 addresses, `*.local`
/// and `*.localhost`.
fn is_local_host(host: &str) -> bool {
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "[::1]"
        || host == "[::]"
    {
        return true;
    }
    let octets: Vec<u8> = host
        .split('.')
        .filter_map(|part| part.parse::<u8>().ok())
        .collect();
    if octets.len() != 4 || host.split('.').count() != 4 {
        return false;
    }
    matches!(
        (octets[0], octets[1]),
        (127, _) | (10, _) | (192, 168) | (0, _) | (169, 254)
    ) || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

/// `encodeURIComponent`: everything except letters, digits and `-_.!~*'()` is percent-encoded.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_the_blank_page() {
        assert_eq!(resolve_address("  "), "about:blank");
    }

    #[test]
    fn full_urls_and_opaque_urls_load_as_typed() {
        assert_eq!(
            resolve_address("https://a.com/x?y=1"),
            "https://a.com/x?y=1"
        );
        assert_eq!(
            resolve_address("http://localhost:3000"),
            "http://localhost:3000"
        );
        assert_eq!(resolve_address("file:///tmp/a.html"), "file:///tmp/a.html");
        assert_eq!(resolve_address("about:blank"), "about:blank");
        assert_eq!(resolve_address("data:text/html,hi"), "data:text/html,hi");
    }

    #[test]
    fn a_public_host_gets_https_first() {
        assert_eq!(resolve_address("example.com"), "https://example.com");
        assert_eq!(resolve_address("docs.rs/serde"), "https://docs.rs/serde");
        assert_eq!(resolve_address("a.dev:8443/x"), "https://a.dev:8443/x");
    }

    #[test]
    fn this_machine_and_the_local_network_get_http() {
        assert_eq!(resolve_address("localhost"), "http://localhost");
        assert_eq!(
            resolve_address("localhost:3000/app"),
            "http://localhost:3000/app"
        );
        assert_eq!(resolve_address("127.0.0.1:8080"), "http://127.0.0.1:8080");
        assert_eq!(
            resolve_address("192.168.1.20:5173"),
            "http://192.168.1.20:5173"
        );
        assert_eq!(resolve_address("my-mac.local"), "http://my-mac.local");
        assert_eq!(resolve_address("[::1]:3000"), "http://[::1]:3000");
    }

    #[test]
    fn a_name_with_a_port_is_a_host_even_without_a_dot() {
        assert_eq!(resolve_address("devbox:4000"), "https://devbox:4000");
    }

    #[test]
    fn other_text_is_searched_for() {
        assert_eq!(
            resolve_address("rust lifetimes"),
            "https://duckduckgo.com/?q=rust%20lifetimes"
        );
        assert_eq!(resolve_address("hello"), "https://duckduckgo.com/?q=hello");
        assert_eq!(
            resolve_address("what is 2+2?"),
            "https://duckduckgo.com/?q=what%20is%202%2B2%3F"
        );
    }
}
