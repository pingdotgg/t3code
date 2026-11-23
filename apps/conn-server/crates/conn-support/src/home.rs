//! T3's `pathExpansion.ts` (`provider-core/src/server`): `~` in a path, and only in the
//! variables that name a home folder. Providers and terminals expand the same way.

/// `HOME_PATH_VARIABLES` (`provider-core/src/server/pathExpansion.ts`): the only instance
/// variables whose `~` names the home folder. The ACP probe check compares the list with the
/// monorepo's.
pub const HOME_PATH_VARIABLES: [&str; 3] = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"];

/// `expandHomeVariable`.
pub fn expand_home_variable(name: &str, value: &str, home: &str) -> String {
    if HOME_PATH_VARIABLES.contains(&name) {
        expand_home_path(value, home)
    } else {
        value.to_owned()
    }
}

/// `expandHomePath`: `~`, `~/…` and `~\…`, joined as Node's `path.join` joins (normalized).
pub fn expand_home_path(value: &str, home: &str) -> String {
    if value == "~" {
        return home.to_owned();
    }
    let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    else {
        return value.to_owned();
    };
    let joined = format!("{home}/{rest}");
    let absolute = joined.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    let trailing = joined.ends_with('/') && !body.is_empty();
    let mut out = if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".into()
    } else {
        body
    };
    if trailing {
        out.push('/');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_as_path_join() {
        assert_eq!(expand_home_path("~/a/../b//c", "/h"), "/h/b/c");
        assert_eq!(expand_home_path("~", "/h"), "/h");
        assert_eq!(expand_home_path("~x", "/h"), "~x");
        assert_eq!(expand_home_path("/abs/~/x", "/h"), "/abs/~/x");
        assert_eq!(expand_home_variable("PATH", "~/bin", "/h"), "~/bin");
        assert_eq!(expand_home_variable("CODEX_HOME", "~/c", "/h"), "/h/c");
        assert_eq!(expand_home_variable("MARKER", "$HOME/x", "/h"), "$HOME/x");
    }
}
