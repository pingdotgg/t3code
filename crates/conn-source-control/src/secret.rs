//! A host credential that never shows itself.
//!
//! Tokens come from the server's settings, the environment or a host CLI. A [`Secret`] keeps
//! one in memory and only [`Secret::expose`] gives the text out, at the one place that builds a
//! request header or a child's environment. `Debug` and `Display` print a fixed marker, so a
//! token cannot reach a log line, an error text or a recording by accident.

use std::fmt;

/// A token or password. Its text leaves only through [`Secret::expose`].
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wraps a credential. Leading and trailing white space is dropped, as the T3 server's
    /// settings (`TrimmedString`) and its CLI token reads trim it.
    pub fn new(value: impl Into<String>) -> Self {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.len() == value.len() {
            Self(value)
        } else {
            Self(trimmed.to_owned())
        }
    }

    /// `None` for an empty or blank value: the T3 server treats those as unset.
    pub fn non_empty(value: impl Into<String>) -> Option<Self> {
        let secret = Self::new(value);
        (!secret.0.is_empty()).then_some(secret)
    }

    /// The credential's text. Use it only to build a request header or a child's environment.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[cfg(test)]
mod tests {
    use super::Secret;

    #[test]
    fn never_prints_its_value() {
        let secret = Secret::new("  ghp_example  ");
        assert_eq!(secret.expose(), "ghp_example", "trimmed");
        assert!(!format!("{secret:?}").contains("ghp"), "Debug hides it");
        assert!(!format!("{secret}").contains("ghp"), "Display hides it");
        assert!(Secret::non_empty("   ").is_none(), "blank is unset");
    }
}
