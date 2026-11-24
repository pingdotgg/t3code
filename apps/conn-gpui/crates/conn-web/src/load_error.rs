//! A page that failed to load, as the host shows it: Chromium's net error code, its name and a
//! plain sentence. Free of CEF types.

/// `ERR_ABORTED`: a navigation that was replaced or cancelled. Not an error to show.
pub(crate) const ERR_ABORTED: i32 = -3;

/// A main-frame load that failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadError {
    /// The address that failed.
    pub url: String,
    /// Chromium's net error code (negative).
    pub code: i32,
    /// Chromium's own text for the error.
    pub text: String,
}

impl LoadError {
    /// `ERR_NAME_NOT_RESOLVED` and the like.
    #[must_use]
    pub fn name(&self) -> &'static str {
        net_error_name(self.code)
    }

    /// One sentence for the page area.
    #[must_use]
    pub fn message(&self) -> String {
        let host = host_of(&self.url);
        match self.code {
            -105 | -137 => format!("{host}’s server could not be found."),
            -106 => "You are not connected to the internet.".to_owned(),
            -102 => format!("{host} refused to connect."),
            -100 | -101 | -104 | -324 => format!("The connection to {host} was interrupted."),
            -7 | -118 => format!("{host} took too long to respond."),
            -109 | -21 => format!("{host} could not be reached."),
            -220..=-200 => format!("The certificate of {host} is not valid."),
            -310 => format!("{host} redirected too many times."),
            _ => format!("The page at {host} could not be loaded."),
        }
    }
}

/// The host of `url`, or the whole text when it has none.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    if host.is_empty() { url } else { host }.to_owned()
}

/// Chromium's name for a net error code; `"ERR_UNKNOWN"` for one not listed.
#[must_use]
pub fn net_error_name(code: i32) -> &'static str {
    match code {
        -2 => "ERR_FAILED",
        -3 => "ERR_ABORTED",
        -6 => "ERR_FILE_NOT_FOUND",
        -7 => "ERR_TIMED_OUT",
        -20 => "ERR_BLOCKED_BY_CLIENT",
        -21 => "ERR_NETWORK_CHANGED",
        -27 => "ERR_BLOCKED_BY_RESPONSE",
        -100 => "ERR_CONNECTION_CLOSED",
        -101 => "ERR_CONNECTION_RESET",
        -102 => "ERR_CONNECTION_REFUSED",
        -104 => "ERR_CONNECTION_FAILED",
        -105 => "ERR_NAME_NOT_RESOLVED",
        -106 => "ERR_INTERNET_DISCONNECTED",
        -107 => "ERR_SSL_PROTOCOL_ERROR",
        -109 => "ERR_ADDRESS_UNREACHABLE",
        -118 => "ERR_CONNECTION_TIMED_OUT",
        -130 => "ERR_PROXY_CONNECTION_FAILED",
        -137 => "ERR_NAME_RESOLUTION_FAILED",
        -200 => "ERR_CERT_COMMON_NAME_INVALID",
        -201 => "ERR_CERT_DATE_INVALID",
        -202 => "ERR_CERT_AUTHORITY_INVALID",
        -310 => "ERR_TOO_MANY_REDIRECTS",
        -324 => "ERR_EMPTY_RESPONSE",
        -501 => "ERR_INSECURE_RESPONSE",
        _ => "ERR_UNKNOWN",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error(url: &str, code: i32) -> LoadError {
        LoadError {
            url: url.to_owned(),
            code,
            text: String::new(),
        }
    }

    #[test]
    fn codes_have_chromiums_names() {
        assert_eq!(net_error_name(-105), "ERR_NAME_NOT_RESOLVED");
        assert_eq!(net_error_name(-3), "ERR_ABORTED");
        assert_eq!(net_error_name(-9999), "ERR_UNKNOWN");
        assert_eq!(
            error("https://a.test", -106).name(),
            "ERR_INTERNET_DISCONNECTED"
        );
    }

    #[test]
    fn messages_name_the_host() {
        assert_eq!(
            error("https://tweakers.net/nieuws?x=1", -105).message(),
            "tweakers.net’s server could not be found."
        );
        assert_eq!(
            error("http://localhost:3000/", -102).message(),
            "localhost:3000 refused to connect."
        );
        assert_eq!(
            error("https://a.test/", -106).message(),
            "You are not connected to the internet."
        );
        assert_eq!(
            error("https://a.test/", -1234).message(),
            "The page at a.test could not be loaded."
        );
        assert_eq!(
            error("https://expired.test/", -201).message(),
            "The certificate of expired.test is not valid."
        );
    }
}
