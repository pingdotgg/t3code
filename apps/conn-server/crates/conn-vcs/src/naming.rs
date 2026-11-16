//! Pure branch naming rules shared by checkout and commit actions.
pub fn worktree_branch(number: i64, head: &str, cross: bool, branches: &[String]) -> String {
    if !cross {
        return head.into();
    }
    let suffix = branch_fragment(head);
    let creatable = |name: &str| {
        !branches
            .iter()
            .any(|b| name.starts_with(&format!("{b}/")) || b.starts_with(&format!("{name}/")))
    };
    let preferred = format!("t3code/pr-{number}/{suffix}");
    if creatable(&preferred) {
        return preferred;
    }
    let flat = format!("t3code-pr-{number}-{}", suffix.replace('/', "-"));
    let mut name = flat.clone();
    for n in 2..=branches.len().saturating_add(2) {
        if creatable(&name) {
            return name;
        }
        name = format!("{flat}-{n}");
    }
    name
}

pub fn branch_fragment(raw: &str) -> String {
    let mut result = String::new();
    let folded = raw
        .chars()
        .map(|c| {
            crate::generated::LATIN_FOLDS
                .iter()
                .find(|(from, _)| from.contains(c))
                .map(|(_, to)| (*to).to_owned())
                .unwrap_or_else(|| c.to_string())
        })
        .collect::<String>();
    for c in folded
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !('̀'..='ͯ').contains(c))
    {
        if matches!(c, '\'' | '"' | '`') {
            continue;
        }
        let c = if c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-') {
            c
        } else {
            '-'
        };
        if matches!(c, '-' | '/') && result.ends_with(c) {
            continue;
        }
        result.push(c);
    }
    let result = result
        .trim_matches(['.', '/', '_', '-'])
        .chars()
        .take(64)
        .collect::<String>();
    let result = result.trim_end_matches(['.', '/', '_', '-']);
    if result.is_empty() {
        "update".into()
    } else {
        result.into()
    }
}

pub fn feature_branch(raw: &str, names: &[String]) -> String {
    let fragment = branch_fragment(raw);
    let base = if fragment.contains('/') {
        fragment
    } else {
        format!("feature/{fragment}")
    };
    let names = names.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>();
    let mut branch = String::new();
    let segments = base.split('/').count();
    for (index, part) in base.split('/').enumerate() {
        let prefix = if branch.is_empty() {
            part.into()
        } else {
            format!("{branch}/{part}")
        };
        let mut candidate = prefix.clone();
        for n in 2..=names.len().saturating_add(2) {
            if !names.iter().any(|name| {
                name == &candidate
                    || (index + 1 == segments && name.starts_with(&format!("{candidate}/")))
            }) {
                break;
            }
            candidate = format!("{prefix}-{n}");
        }
        branch = candidate;
    }
    branch
}
