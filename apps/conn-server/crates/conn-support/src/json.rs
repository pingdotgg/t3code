//! JSON helpers ported from `@t3tools/shared/schemaJson`.

/// `fromLenientJson`: comments and trailing commas outside strings are dropped first.
pub fn parse_lenient<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_str(&strip_lenient(text)).ok()
}

fn strip_lenient(input: &str) -> String {
    // Comments become a space; strings stay as they are.
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push(c);
                let mut escaped = false;
                for s in chars.by_ref() {
                    out.push(s);
                    if escaped {
                        escaped = false;
                    } else if s == '\\' {
                        escaped = true;
                    } else if s == '"' {
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                while chars.peek().is_some_and(|&n| n != '\r' && n != '\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = '\0';
                let mut closed = false;
                for s in chars.by_ref() {
                    if prev == '*' && s == '/' {
                        closed = true;
                        break;
                    }
                    prev = s;
                }
                if closed {
                    out.push(' ');
                } else {
                    // An unclosed block is no comment to the regex: keep it, so the parse fails.
                    out.push_str("/*");
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas before `}` or `]`, outside strings.
    let mut result = String::with_capacity(out.len());
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            result.push(c);
            let mut escaped = false;
            for s in chars.by_ref() {
                result.push(s);
                if escaped {
                    escaped = false;
                } else if s == '\\' {
                    escaped = true;
                } else if s == '"' {
                    break;
                }
            }
        } else if c == ',' {
            let rest: String = chars.clone().collect();
            let next = rest.trim_start().chars().next();
            if !matches!(next, Some('}' | ']')) {
                result.push(c);
            }
        } else {
            result.push(c);
        }
    }
    result
}
