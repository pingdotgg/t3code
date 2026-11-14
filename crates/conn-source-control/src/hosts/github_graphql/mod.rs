//! GitHub's GraphQL operations, as T3 sends them. `generated.rs` holds every operation's text
//! and document template, printed from the monorepo by `tools/gen-graphql.mjs` (never by
//! hand). This module renders an operation once (`Operation::document`) or batched under
//! aliases, as `GraphQLResolver.aliased` does (`render_slices`, Effect's `renderSlices`).

pub mod generated;

/// `query` or `mutation`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationKind {
    Query,
    Mutation,
}

impl OperationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OperationKind::Query => "query",
            OperationKind::Mutation => "mutation",
        }
    }
}

/// One `$name: Type` of an operation.
#[derive(Debug)]
pub struct Variable {
    pub name: &'static str,
    pub body: &'static str,
}

/// A root field: its alias, its name (absent for a spread) and its body parts. Odd parts are
/// names that take a slice's prefix.
#[derive(Debug)]
pub struct Selection {
    pub alias: Option<&'static str>,
    pub name: Option<&'static str>,
    pub body: &'static [&'static str],
}

/// A fragment; one with a single body part names no variable and is shared by every slice.
#[derive(Debug)]
pub struct Fragment {
    pub name: &'static str,
    pub body: &'static [&'static str],
}

/// Effect's `DocumentTemplate`.
#[derive(Debug)]
pub struct Template {
    pub variables: &'static [Variable],
    pub directives: Option<&'static [&'static str]>,
    pub selections: &'static [Selection],
    pub fragments: &'static [Fragment],
}

/// One operation: its printed text and its template.
#[derive(Debug)]
pub struct Operation {
    pub kind: OperationKind,
    pub name: &'static str,
    /// The text of a single request, as `effect/graphql` sends it.
    pub document: &'static str,
    pub template: Template,
}

/// Effect's `concat`: a space only where two non-punctuators would touch.
fn concat(out: &mut String, piece: &str) {
    let word = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '"' | '-');
    if out.ends_with(word) && piece.starts_with(word) {
        out.push(' ');
    }
    out.push_str(piece);
}

/// Effect's `renderParts`: every odd part takes the prefix.
fn render_parts(parts: &[&str], prefix: &str) -> String {
    let mut out = String::new();
    for (index, part) in parts.iter().enumerate() {
        if index % 2 == 1 {
            out.push_str(prefix);
        }
        out.push_str(part);
    }
    out
}

impl Template {
    /// Effect's `templateUnsliceableReason` is `undefined`.
    fn sliceable(&self) -> bool {
        self.directives.is_none_or(|d| d.len() <= 1) && self.selections.iter().all(|s| s.name.is_some())
    }
}

/// Why `render_slices` refused an operation.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("cannot render slices of operation {0}")]
pub struct Unsliceable(pub &'static str);

impl Operation {
    /// Effect's `render` for `prefixes`; the empty prefix alone gives `document`.
    fn render(&self, prefixes: &[&str]) -> String {
        let t = &self.template;
        let mut out = String::new();
        concat(&mut out, self.kind.as_str());
        concat(&mut out, self.name);
        if !t.variables.is_empty() {
            let mut vars = String::new();
            for prefix in prefixes {
                for variable in t.variables {
                    concat(&mut vars, &format!("${prefix}{}:{}", variable.name, variable.body));
                }
            }
            concat(&mut out, &format!("({vars})"));
        }
        if let Some(directives) = t.directives {
            concat(&mut out, &render_parts(directives, ""));
        }
        let mut body = String::new();
        for prefix in prefixes {
            for selection in t.selections {
                let key = if prefix.is_empty() {
                    selection.alias.map(str::to_owned)
                } else {
                    Some(format!("{prefix}{}", selection.alias.or(selection.name).unwrap_or_default()))
                };
                let key = key.map(|k| format!("{k}:")).unwrap_or_default();
                let piece = format!(
                    "{key}{}{}",
                    selection.name.unwrap_or_default(),
                    render_parts(selection.body, prefix)
                );
                concat(&mut body, &piece);
            }
        }
        concat(&mut out, &format!("{{{body}}}"));
        for fragment in t.fragments {
            let shared = fragment.body.len() <= 1;
            let fragment_prefixes: &[&str] = if shared { &[""] } else { prefixes };
            for prefix in fragment_prefixes {
                let mut piece = String::new();
                concat(&mut piece, "fragment");
                concat(&mut piece, &format!("{prefix}{}", fragment.name));
                concat(&mut piece, &render_parts(fragment.body, prefix));
                concat(&mut out, &piece);
            }
        }
        out
    }

    /// `renderSlices`: the operation repeated once per prefix in one request. Prefixes are
    /// `_<i>_`, as `GraphQLResolver.aliased` names them.
    pub fn render_slices(&self, count: usize) -> Result<String, Unsliceable> {
        if count == 0 || !self.template.sliceable() {
            return Err(Unsliceable(self.name));
        }
        let prefixes: Vec<String> = (0..count).map(|i| format!("_{i}_")).collect();
        let shared: Vec<&str> = self
            .template
            .fragments
            .iter()
            .filter(|f| f.body.len() <= 1)
            .map(|f| f.name)
            .collect();
        let collides = self.template.fragments.iter().filter(|f| f.body.len() > 1).any(|f| {
            prefixes.iter().any(|p| shared.contains(&format!("{p}{}", f.name).as_str()))
        });
        if collides {
            return Err(Unsliceable(self.name));
        }
        let refs: Vec<&str> = prefixes.iter().map(String::as_str).collect();
        Ok(self.render(&refs))
    }

    /// The text `joinTemplate` gives, which must equal `document`.
    pub fn joined(&self) -> String {
        self.render(&[""])
    }
}

#[cfg(test)]
mod tests {
    use super::generated::{ALL, TWO_SLICES};

    #[test]
    fn every_template_joins_to_its_document() {
        for operation in ALL {
            assert_eq!(operation.joined(), operation.document, "{}", operation.name);
        }
    }

    #[test]
    fn two_slices_render_as_effect_renders_them() {
        assert!(!TWO_SLICES.is_empty(), "the generator printed slices");
        for (name, expected) in TWO_SLICES {
            let operation = ALL.iter().find(|o| o.name == *name).expect("operation");
            assert_eq!(operation.render_slices(2).as_deref(), Ok(*expected), "{name}");
        }
    }
}
