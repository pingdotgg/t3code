//! Splits SQL into the fragments the Database panel colours (`SQL_TOKENS` of
//! `apps/web/src/laravelToolbar/ui/panels.tsx`): keywords muted, identifiers plain, strings
//! green and numbers blue.

/// What a fragment of a statement is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlKind {
    /// Anything between the tokens.
    Plain,
    Keyword,
    /// A `'string'`.
    String,
    /// A `` `name` `` or `"name"`.
    Identifier,
    Number,
}

const KEYWORDS: &[&str] = &[
    "select", "from", "where", "and", "or", "in", "is", "not", "null", "order", "by", "asc",
    "desc", "limit", "offset", "count", "as", "update", "set", "insert", "into", "values",
    "delete", "join", "left", "inner", "on", "group", "having", "exists", "distinct",
];

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The fragments of `sql`, in order; joined they give `sql` back.
#[must_use]
pub fn sql_fragments(sql: &str) -> Vec<(SqlKind, String)> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out: Vec<(SqlKind, String)> = Vec::new();
    let mut plain = String::new();
    let flush = |plain: &mut String, out: &mut Vec<(SqlKind, String)>| {
        if !plain.is_empty() {
            out.push((SqlKind::Plain, std::mem::take(plain)));
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let previous_is_word = i > 0 && is_word(chars[i - 1]);
        match c {
            '\'' => {
                let mut j = i + 1;
                let mut closed = false;
                while j < chars.len() {
                    if chars[j] == '\'' {
                        if chars.get(j + 1) == Some(&'\'') {
                            j += 2;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    j += 1;
                }
                if closed {
                    flush(&mut plain, &mut out);
                    out.push((SqlKind::String, chars[i..=j].iter().collect()));
                    i = j + 1;
                } else {
                    plain.push(c);
                    i += 1;
                }
            }
            '`' | '"' => match chars[i + 1..].iter().position(|&x| x == c) {
                Some(offset) => {
                    let end = i + 1 + offset;
                    flush(&mut plain, &mut out);
                    out.push((SqlKind::Identifier, chars[i..=end].iter().collect()));
                    i = end + 1;
                }
                None => {
                    plain.push(c);
                    i += 1;
                }
            },
            _ if c.is_ascii_digit() && !previous_is_word => {
                let mut j = i;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                if chars.get(j) == Some(&'.') && chars.get(j + 1).is_some_and(char::is_ascii_digit)
                {
                    j += 1;
                    while j < chars.len() && chars[j].is_ascii_digit() {
                        j += 1;
                    }
                }
                if chars.get(j).is_some_and(|&x| is_word(x)) {
                    // `1abc`: part of a name, not a number.
                    plain.extend(&chars[i..j]);
                } else {
                    flush(&mut plain, &mut out);
                    out.push((SqlKind::Number, chars[i..j].iter().collect()));
                }
                i = j;
            }
            _ if is_word(c) => {
                let mut j = i;
                while j < chars.len() && is_word(chars[j]) {
                    j += 1;
                }
                let word: String = chars[i..j].iter().collect();
                if KEYWORDS.contains(&word.to_lowercase().as_str()) {
                    flush(&mut plain, &mut out);
                    out.push((SqlKind::Keyword, word));
                } else {
                    plain.push_str(&word);
                }
                i = j;
            }
            _ => {
                plain.push(c);
                i += 1;
            }
        }
    }
    flush(&mut plain, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_keywords_strings_identifiers_and_numbers() {
        let fragments = sql_fragments("select * from `users` where id = 12 and name = 'O''Brien'");
        let kinds: Vec<SqlKind> = fragments.iter().map(|(kind, _)| *kind).collect();
        assert!(kinds.contains(&SqlKind::Keyword));
        assert!(fragments.contains(&(SqlKind::Identifier, "`users`".to_owned())));
        assert!(fragments.contains(&(SqlKind::Number, "12".to_owned())));
        assert!(fragments.contains(&(SqlKind::String, "'O''Brien'".to_owned())));
        let joined: String = fragments.iter().map(|(_, text)| text.as_str()).collect();
        assert_eq!(
            joined,
            "select * from `users` where id = 12 and name = 'O''Brien'"
        );
    }

    #[test]
    fn a_word_that_contains_a_keyword_or_digit_stays_plain() {
        let fragments = sql_fragments("selected t1 order_id 3.5");
        assert!(
            fragments
                .iter()
                .all(|(kind, text)| *kind == SqlKind::Plain || text == "3.5")
        );
        assert!(fragments.contains(&(SqlKind::Number, "3.5".to_owned())));
    }

    #[test]
    fn an_unclosed_quote_is_plain_text() {
        let fragments = sql_fragments("where a = 'oops");
        assert!(fragments.iter().all(|(kind, _)| *kind != SqlKind::String));
    }
}
