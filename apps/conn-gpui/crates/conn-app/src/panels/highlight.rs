//! Syntect-backed syntax highlighting whose colors derive purely from [`conn_theme::Tokens`].

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use conn_theme::{Rgba, Tokens, color_mix_srgb};
use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(SyntaxSet::load_defaults_newlines);

/// One styled span within a single source line.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HighlightSpan {
    pub(crate) text: String,
    pub(crate) color: Rgba,
    pub(crate) bold: bool,
    pub(crate) italic: bool,
}

/// Highlights `source` for the file at `path` into one `Vec<HighlightSpan>` per line.
///
/// Falls back to plain `tokens.code_foreground` spans when the file extension has no
/// matching syntect grammar or for files exceeding `MAX_HIGHLIGHT_BYTES`.
#[must_use]
pub(crate) fn highlight_lines(
    path: &str,
    source: &str,
    tokens: &Tokens,
) -> Vec<Vec<HighlightSpan>> {
    const MAX_HIGHLIGHT_BYTES: usize = 512 * 1024;
    if source.is_empty() {
        return Vec::new();
    }
    if source.len() > MAX_HIGHLIGHT_BYTES {
        return plain_lines(source, tokens.code_foreground);
    }
    let Some(syntax) = syntax_for_path(path) else {
        return plain_lines(source, tokens.code_foreground);
    };

    let syntaxes = &*SYNTAX_SET;
    let mut parser = ParseState::new(syntax);
    let mut scopes = ScopeStack::new();
    let mut scope_cache: HashMap<Scope, Option<TokenStyle>> = HashMap::new();
    let mut result = Vec::new();

    for raw_line in LinesWithEndings::from(source) {
        let display_line = raw_line
            .strip_suffix('\n')
            .unwrap_or(raw_line)
            .strip_suffix('\r')
            .unwrap_or(raw_line.strip_suffix('\n').unwrap_or(raw_line));
        let display_len = display_line.len();
        let mut spans: Vec<HighlightSpan> = Vec::new();

        if let Ok(ops) = parser.parse_line(raw_line, syntaxes) {
            let mut cursor = 0usize;
            for (idx, op) in ops {
                let end = idx.min(display_len);
                if end > cursor {
                    push_span(
                        &mut spans,
                        &display_line[cursor..end],
                        resolve_style(&scopes, &mut scope_cache, tokens),
                    );
                }
                let _ = scopes.apply(&op);
                cursor = idx.min(display_len);
            }
            if cursor < display_len {
                push_span(
                    &mut spans,
                    &display_line[cursor..display_len],
                    resolve_style(&scopes, &mut scope_cache, tokens),
                );
            }
        } else {
            push_span(
                &mut spans,
                display_line,
                TokenStyle::plain(tokens.code_foreground),
            );
        }

        result.push(spans);
    }

    result
}

fn plain_lines(source: &str, color: Rgba) -> Vec<Vec<HighlightSpan>> {
    source
        .lines()
        .map(|line| {
            vec![HighlightSpan {
                text: line.to_owned(),
                color,
                bold: false,
                italic: false,
            }]
        })
        .collect()
}

fn syntax_for_path(path: &str) -> Option<&'static SyntaxReference> {
    let syntaxes = &*SYNTAX_SET;
    let p = Path::new(path);
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        let normalized = match ext.to_ascii_lowercase().as_str() {
            "tsx" | "jsx" => "js",
            "ts" | "mts" | "cts" => "js",
            "mjs" | "cjs" => "js",
            "toml" => "yaml",
            _ => ext,
        };
        if let Some(s) = syntaxes
            .find_syntax_by_extension(ext)
            .or_else(|| syntaxes.find_syntax_by_extension(normalized))
            .filter(|s| s.name != "Plain Text")
        {
            return Some(s);
        }
    }
    let name = p.file_name().and_then(|n| n.to_str())?;
    syntaxes
        .find_syntax_by_token(name)
        .filter(|s| s.name != "Plain Text")
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct TokenStyle {
    color: Rgba,
    bold: bool,
    italic: bool,
}

impl TokenStyle {
    const fn plain(color: Rgba) -> Self {
        Self {
            color,
            bold: false,
            italic: false,
        }
    }
}

fn push_span(spans: &mut Vec<HighlightSpan>, text: &str, style: TokenStyle) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.color == style.color
        && last.bold == style.bold
        && last.italic == style.italic
    {
        last.text.push_str(text);
        return;
    }
    spans.push(HighlightSpan {
        text: text.to_owned(),
        color: style.color,
        bold: style.bold,
        italic: style.italic,
    });
}

fn resolve_style(
    scopes: &ScopeStack,
    cache: &mut HashMap<Scope, Option<TokenStyle>>,
    tokens: &Tokens,
) -> TokenStyle {
    for scope in scopes.scopes.iter().rev() {
        let resolved = *cache
            .entry(*scope)
            .or_insert_with(|| style_for_scope(*scope, tokens));
        if let Some(style) = resolved {
            return style;
        }
    }
    TokenStyle::plain(tokens.code_foreground)
}

fn style_for_scope(scope: Scope, tokens: &Tokens) -> Option<TokenStyle> {
    let name = scope.build_string();
    let has = |prefix: &str| {
        name == prefix
            || name
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('.'))
    };

    if has("comment") {
        Some(TokenStyle {
            color: tokens.muted_foreground,
            bold: false,
            italic: true,
        })
    } else if has("string") {
        Some(TokenStyle::plain(tokens.success))
    } else if has("constant.numeric") || has("constant.language") {
        Some(TokenStyle::plain(tokens.warning))
    } else if has("keyword") || has("storage.type") || has("storage.modifier") {
        Some(TokenStyle {
            color: color_mix_srgb(tokens.primary, 0.80, tokens.foreground),
            bold: false,
            italic: false,
        })
    } else if has("entity.name.function") || has("support.function") {
        Some(TokenStyle::plain(tokens.info))
    } else if has("entity.name.type")
        || has("entity.name.struct")
        || has("entity.name.enum")
        || has("support.type")
    {
        Some(TokenStyle::plain(color_mix_srgb(
            tokens.warning,
            0.70,
            tokens.foreground,
        )))
    } else if has("constant") || has("variable.language") {
        Some(TokenStyle::plain(tokens.destructive))
    } else if has("punctuation") {
        Some(TokenStyle::plain(color_mix_srgb(
            tokens.code_foreground,
            0.75,
            tokens.muted_foreground,
        )))
    } else {
        None
    }
}
