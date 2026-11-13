//! Thread links in tool results (`packages/shared/src/threadLinks.ts`). T3 Code renders
//! `t3-thread://` links as thread chips; outside callers get the hosted link Copy thread makes.

use crate::{Caller, McpConfig};

pub fn thread_link(config: &McpConfig, caller: &Caller, thread_id: &str, title: &str) -> String {
    match caller {
        Caller::Thread(_) => {
            let href = format!("t3-thread://v2/{}/{thread_id}", config.environment_id);
            let destination = if href.contains(['(', ')']) {
                format!("<{href}>")
            } else {
                href.clone()
            };
            let label = title
                .replace(['[', ']', '\\', '\r', '\n'], " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if label.is_empty() {
                format!("<{href}>")
            } else {
                format!("[{label}]({destination})")
            }
        }
        Caller::Client(_) => format!(
            "{}/threads/{}/{}",
            config.hosted_app_url.trim_end_matches('/'),
            segment(&config.environment_id),
            segment(thread_id)
        ),
    }
}

/// `encodeURIComponent`, then `.!~*'()` too: a sentence's closing period never joins an id.
fn segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::segment;

    #[test]
    fn hosted_segments_escape_punctuation() {
        assert_eq!(segment("thread:a.b"), "thread%3Aa%2Eb");
        assert_eq!(segment("é"), "%C3%A9");
    }
}
