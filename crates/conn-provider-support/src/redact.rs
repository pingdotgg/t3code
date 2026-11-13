//! Failure text a provider may show the user, with secrets removed and the length capped:
//! `redactProviderFailureText` and `boundedText` in `packages/provider-core/src/server/
//! failure.ts`, which the T3 server applies to every `ProviderFailure` message and code.
//!
//! In order, as TS does:
//! 1. control characters other than tab and line breaks become spaces
//! 2. `http(s)://` URLs lose user info, query and fragment (unparsable: `[REDACTED_URL]`)
//! 3. `Bearer <x>` / `Basic <x>` (any whitespace between) become `<scheme> [REDACTED]`
//! 4. JSON-style `"<…credential word>": "<value>"` gets `[REDACTED]` as value
//! 5. `<…credential word>: value` / `=value` gets `[REDACTED]` as value
//! 6. `sk-` tokens of 16 or more characters become `[REDACTED]`
//! 7. the ends are trimmed
//!
//! Credential words: `access_token` (or `-`, or none), `api_key` (likewise), `authorization`,
//! `credential`, `password`, `secret`, `token`, matched at the end of a key, any case.
//! Hand-written: the T3 patterns use look-behind, which the `regex` crate lacks, and no
//! regex engine is in the build.

/// `MAX_PROVIDER_FAILURE_MESSAGE_LENGTH`, in UTF-16 code units as JavaScript counts.
pub const MAX_MESSAGE_LENGTH: usize = 4_096;
/// `MAX_PROVIDER_FAILURE_CODE_LENGTH`.
pub const MAX_CODE_LENGTH: usize = 128;

const CREDENTIAL_WORDS: &[&str] = &[
    "access_token",
    "access-token",
    "accesstoken",
    "api_key",
    "api-key",
    "apikey",
    "authorization",
    "credential",
    "password",
    "secret",
    "token",
];

/// JavaScript `\w` without the `u`-flag extensions: ASCII letters, digits, `_`.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_key_char(c: char) -> bool {
    is_word(c) || c == '-'
}

/// JavaScript `\s`.
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn ends_with_credential_word(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    CREDENTIAL_WORDS.iter().any(|w| key.ends_with(w))
}

/// `redactProviderFailureText`.
pub fn redact(text: &str) -> String {
    let text: String = text
        .chars()
        .map(|c| match c as u32 {
            0..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f => ' ',
            _ => c,
        })
        .collect();
    let text = urls(&text);
    let text = auth_schemes(&text);
    let text = json_credentials(&text);
    let text = key_value_credentials(&text);
    let text = sk_tokens(&text);
    text.trim_matches(is_space).to_owned()
}

/// `boundedText`: redacted, then cut to `max` UTF-16 units with `…` (never inside a
/// surrogate pair).
pub fn bounded(text: &str, max: usize) -> String {
    let redacted = redact(text);
    if redacted.encode_utf16().count() <= max {
        return redacted;
    }
    let budget = max.saturating_sub(1);
    let mut used = 0;
    let mut out = String::new();
    for c in redacted.chars() {
        let width = c.len_utf16();
        if used + width > budget {
            break;
        }
        used += width;
        out.push(c);
    }
    out.push('…');
    out
}

fn chars(text: &str) -> Vec<char> {
    text.chars().collect()
}

fn starts_with_ignore_case(chars: &[char], at: usize, word: &str) -> bool {
    let mut i = at;
    for w in word.chars() {
        match chars.get(i) {
            Some(c) if c.eq_ignore_ascii_case(&w) => i += 1,
            _ => return false,
        }
    }
    true
}

/// Step 2: `\bhttps?:\/\/[^\s<>"']+`, case-insensitive.
fn urls(text: &str) -> String {
    let c = chars(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let boundary = i == 0 || !is_word(c[i - 1]);
        let scheme = if starts_with_ignore_case(&c, i, "https://") {
            8
        } else if starts_with_ignore_case(&c, i, "http://") {
            7
        } else {
            0
        };
        if boundary && scheme > 0 {
            let mut end = i + scheme;
            while end < c.len() && !is_space(c[end]) && !matches!(c[end], '<' | '>' | '"' | '\'') {
                end += 1;
            }
            if end > i + scheme {
                let matched: String = c[i..end].iter().collect();
                out.push_str(&redact_url(&matched));
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// `redactUrl`: the URL without user info, query and fragment, as `URL.toString()` writes it;
/// trailing punctuation stays outside.
fn redact_url(matched: &str) -> String {
    let candidate = matched.trim_end_matches([')', ',', '.', ';', '!', '?']);
    let trailing = &matched[candidate.len()..];
    let Some((scheme, rest)) = candidate.split_once("://") else {
        return format!("[REDACTED_URL]{trailing}");
    };
    let scheme = scheme.to_ascii_lowercase();
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let (host, port) = match host_port.strip_prefix('[') {
        Some(v6) => match v6.split_once(']') {
            Some((h, after)) => (
                format!("[{}]", h.to_ascii_lowercase()),
                after.strip_prefix(':'),
            ),
            None => return format!("[REDACTED_URL]{trailing}"),
        },
        None => match host_port.rsplit_once(':') {
            Some((h, p)) => (h.to_ascii_lowercase(), Some(p)),
            None => (host_port.to_ascii_lowercase(), None),
        },
    };
    let host_ok = !host.is_empty()
        && !host
            .chars()
            .any(|ch| is_space(ch) || matches!(ch, '%' | '<' | '>' | '^' | '|' | '"'));
    let default_port = if scheme == "http" { "80" } else { "443" };
    let port = match port {
        None | Some("") => String::new(),
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n.to_string() == default_port => String::new(),
            Ok(n) => format!(":{n}"),
            Err(_) => return format!("[REDACTED_URL]{trailing}"),
        },
    };
    if !host_ok {
        return format!("[REDACTED_URL]{trailing}");
    }
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = tail[..path_end].replace('\\', "/");
    let path = if path.is_empty() {
        "/".to_owned()
    } else {
        path
    };
    format!("{scheme}://{host}{port}{path}{trailing}")
}

/// Step 3: `\b(Bearer|Basic)\s+[^\s,;]+`, case-insensitive → `$1 [REDACTED]`.
fn auth_schemes(text: &str) -> String {
    let c = chars(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let boundary = i == 0 || !is_word(c[i - 1]);
        let word = ["bearer", "basic"]
            .into_iter()
            .find(|w| boundary && starts_with_ignore_case(&c, i, w));
        if let Some(word) = word {
            let after = i + word.len();
            let mut j = after;
            while j < c.len() && is_space(c[j]) {
                j += 1;
            }
            let mut k = j;
            while k < c.len() && !is_space(c[k]) && !matches!(c[k], ',' | ';') {
                k += 1;
            }
            if j > after && k > j {
                out.extend(&c[i..after]);
                out.push_str(" [REDACTED]");
                i = k;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Step 4: `(["'][\w-]*WORD["']\s*:\s*["'])[^"']*(["'])` → `$1[REDACTED]$2`.
fn json_credentials(text: &str) -> String {
    let c = chars(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        if matches!(c[i], '"' | '\'') {
            let mut k = i + 1;
            while k < c.len() && is_key_char(c[k]) {
                k += 1;
            }
            let key: String = c[i + 1..k].iter().collect();
            if ends_with_credential_word(&key) && matches!(c.get(k), Some('"' | '\'')) {
                let mut j = k + 1;
                while j < c.len() && is_space(c[j]) {
                    j += 1;
                }
                if c.get(j) == Some(&':') {
                    j += 1;
                    while j < c.len() && is_space(c[j]) {
                        j += 1;
                    }
                    if matches!(c.get(j), Some('"' | '\'')) {
                        let mut v = j + 1;
                        while v < c.len() && !matches!(c[v], '"' | '\'') {
                            v += 1;
                        }
                        if v < c.len() {
                            out.extend(&c[i..=j]);
                            out.push_str("[REDACTED]");
                            out.push(c[v]);
                            i = v + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Step 5: `((?<![\w-])[\w-]*WORD\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)` → `$1[REDACTED]`.
fn key_value_credentials(text: &str) -> String {
    let c = chars(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let starts_key = is_key_char(c[i]) && (i == 0 || !is_key_char(c[i - 1]));
        if starts_key {
            let mut k = i;
            while k < c.len() && is_key_char(c[k]) {
                k += 1;
            }
            let key: String = c[i..k].iter().collect();
            if ends_with_credential_word(&key) {
                let mut j = k;
                while j < c.len() && is_space(c[j]) {
                    j += 1;
                }
                if matches!(c.get(j), Some(':' | '=')) {
                    j += 1;
                    while j < c.len() && is_space(c[j]) {
                        j += 1;
                    }
                    let quoted = match c.get(j) {
                        Some(&q @ ('"' | '\'')) => {
                            let close = c[j + 1..].iter().position(|&x| x == q);
                            close.map(|p| j + 1 + p + 1)
                        }
                        _ => None,
                    };
                    let end = quoted.unwrap_or_else(|| {
                        let mut v = j;
                        while v < c.len() && !is_space(c[v]) && !matches!(c[v], ',' | ';') {
                            v += 1;
                        }
                        v
                    });
                    if end > j {
                        out.extend(&c[i..j]);
                        out.push_str("[REDACTED]");
                        i = end;
                        continue;
                    }
                }
            }
            // Not a credential key: copy the whole key so its tail is not tried again.
            out.extend(&c[i..k]);
            i = k;
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// Step 6: `\bsk-[A-Za-z0-9_-]{16,}\b`.
fn sk_tokens(text: &str) -> String {
    let c = chars(text);
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let boundary = i == 0 || !is_word(c[i - 1]);
        if boundary && c[i] == 's' && c.get(i + 1) == Some(&'k') && c.get(i + 2) == Some(&'-') {
            let mut k = i + 3;
            while k < c.len() && is_key_char(c[k]) {
                k += 1;
            }
            // The match must end on a word character (`\b`), so trailing hyphens stay.
            let mut end = k;
            while end > i + 3 && c[end - 1] == '-' {
                end -= 1;
            }
            if end - (i + 3) >= 16 {
                out.push_str("[REDACTED]");
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `failure.test.ts`: "redacts credentials and URL secrets from provider failures".
    #[test]
    fn redacts_credentials_and_url_secrets() {
        let message = bounded(
            r#"request failed: Authorization: Bearer bearer-secret https://user:pass@example.test/path?access_token=url-secret#fragment {"token":"json-secret"} api_key=key-secret sk-abcdefghijklmnop"#,
            MAX_MESSAGE_LENGTH,
        );
        assert!(message.contains("[REDACTED]"));
        assert!(message.contains("https://example.test/path"), "{message}");
        for secret in [
            "bearer-secret",
            "user:pass",
            "url-secret",
            "json-secret",
            "key-secret",
            "sk-abcdefghijklmnop",
        ] {
            assert!(!message.contains(secret), "{secret} in {message}");
        }
        assert_eq!(
            bounded("provider_rejected", MAX_CODE_LENGTH),
            "provider_rejected"
        );
    }

    /// "redacts credentials whose key names end in a credential word".
    #[test]
    fn redacts_keys_ending_in_a_credential_word() {
        assert_eq!(
            bounded(r#"{"refresh_token":"code value"}"#, MAX_CODE_LENGTH),
            r#"{"refresh_token":"[REDACTED]"}"#
        );
        assert_eq!(
            bounded(
                r#"oauth refresh failed: client_secret=client-value refresh_token=refresh-value {"client_secret":"json-value"} clientSecret: camel-value X-Auth-Token: header-value max_tokens=4096"#,
                MAX_MESSAGE_LENGTH
            ),
            r#"oauth refresh failed: client_secret=[REDACTED] refresh_token=[REDACTED] {"client_secret":"[REDACTED]"} clientSecret: [REDACTED] X-Auth-Token: [REDACTED] max_tokens=4096"#
        );
    }

    /// "does not split a surrogate pair at the truncation boundary".
    #[test]
    fn never_cuts_inside_a_surrogate_pair() {
        let text = format!("{}🚀tail", "a".repeat(MAX_MESSAGE_LENGTH - 2));
        let message = bounded(&text, MAX_MESSAGE_LENGTH);
        assert_eq!(message.encode_utf16().count(), MAX_MESSAGE_LENGTH - 1);
        assert!(message.ends_with('…'));
        assert!(!message.contains('🚀'));
    }

    #[test]
    fn other_forms() {
        assert_eq!(
            redact("Basic\t\tYWxhZGRpbjpvcGVu, next"),
            "Basic [REDACTED], next"
        );
        assert_eq!(redact("see https://x.test/a?b=c."), "see https://x.test/a.");
        assert_eq!(redact("HTTP://Host.Test:80"), "http://host.test/");
        assert_eq!(redact("password='a b' ok"), "password=[REDACTED] ok");
        assert_eq!(redact("bell\u{7}x\n"), "bell x");
        assert_eq!(redact("sk-short ok"), "sk-short ok");
        assert_eq!(redact("tokens: 5"), "tokens: 5");
    }
}
