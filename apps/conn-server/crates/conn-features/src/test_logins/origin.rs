//! Which saved test-login URLs may fill which origins (`credentials/credentialOrigin.ts`):
//! same host (ignoring `www.`), same port, and https unless the saved URL says http
//! (loopback, `.localhost` and `.test` may use http).

/// `DEVELOPMENT_HOST`.
fn development_host(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    if lower == "localhost"
        || lower == "[::1]"
        || lower.ends_with(".localhost")
        || lower.ends_with(".test")
    {
        return true;
    }
    let mut parts = lower.split('.');
    parts.next() == Some("127")
        && parts.clone().count() == 3
        && parts.all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

fn strip_www(host: &str) -> &str {
    match host.get(..4) {
        Some(prefix) if prefix.eq_ignore_ascii_case("www.") => host.get(4..).unwrap_or(host),
        _ => host,
    }
}

/// A saved URL's host, port and schemes (`parseSavedUrl`).
#[derive(Debug)]
pub struct SavedTarget {
    pub host: String,
    pub port: Option<u16>,
    pub schemes: Vec<&'static str>,
}

fn explicit_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// `parseSavedUrl`.
pub fn parse_saved_url(saved: &str) -> Option<SavedTarget> {
    let trimmed = conn_support::text::js_trim(saved);
    if trimmed.is_empty() {
        return None;
    }
    let explicit = explicit_scheme(trimmed);
    let url = url::Url::parse(&if explicit {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    })
    .ok()?;
    let scheme: &'static str = match url.scheme() {
        "https" => "https",
        "http" => "http",
        _ => return None,
    };
    let hostname = url.host_str().filter(|h| !h.is_empty())?;
    let mut schemes = vec![scheme];
    if !explicit && development_host(hostname) && scheme != "http" {
        schemes.push("http");
    }
    Some(SavedTarget {
        host: strip_www(&hostname.to_lowercase()).to_owned(),
        port: url.port(),
        schemes,
    })
}

fn default_port(scheme: &str) -> u16 {
    if scheme == "http" { 80 } else { 443 }
}

/// `matchingOrigin`: the tab's origin when a saved URL matches it. Subdomains never match
/// here: T3 allows them under `allowSubdomains` with a public-suffix check this server does
/// not carry.
pub fn matching_origin(saved_urls: &[String], tab_url: &str) -> Option<String> {
    let tab = url::Url::parse(tab_url).ok()?;
    let scheme = match tab.scheme() {
        "https" => "https",
        "http" => "http",
        _ => return None,
    };
    let host = strip_www(&tab.host_str()?.to_lowercase()).to_owned();
    let port = tab.port().unwrap_or_else(|| default_port(scheme));
    saved_urls.iter().find_map(|saved| {
        let target = parse_saved_url(saved)?;
        (target.schemes.contains(&scheme)
            && target.host == host
            && target.port.unwrap_or_else(|| default_port(scheme)) == port)
            .then(|| tab.origin().ascii_serialization())
    })
}
