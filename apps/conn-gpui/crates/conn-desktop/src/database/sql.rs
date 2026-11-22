//! SQL text helpers for the read-only runner: the reading-statement check and the
//! first-statement cut for SQLite.

/// The keywords a statement may start with to count as reading
/// (`READING_STATEMENT` in Conn's `database.ts`).
const READING_KEYWORDS: [&str; 9] = [
    "select", "with", "show", "describe", "desc", "explain", "values", "table", "pragma",
];

/// The message for a statement the panel refuses to send.
pub(crate) const READ_ONLY_MESSAGE: &str =
    "The Database panel is read-only. Run select, with, show, describe or explain statements.";

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Drops leading whitespace and comments, so `-- note\nselect 1` counts as a select.
pub(crate) fn first_keyword(sql: &str) -> &str {
    let mut rest = sql;
    loop {
        let trimmed = rest.trim_start();
        if let Some(after) = trimmed.strip_prefix("--") {
            rest = after.find('\n').map_or("", |end| &after[end + 1..]);
        } else if let Some(after) = trimmed.strip_prefix("/*") {
            match after.find("*/") {
                Some(end) => rest = &after[end + 2..],
                // An unclosed comment is not stripped, as with the reference's regex.
                None => return trimmed,
            }
        } else {
            return trimmed;
        }
    }
}

/// Whether `sql` starts with a reading statement, after leading comments.
pub(crate) fn is_reading(sql: &str) -> bool {
    let start = first_keyword(sql);
    let end = start.find(|c: char| !is_word(c)).unwrap_or(start.len());
    let word = start[..end].to_ascii_lowercase();
    READING_KEYWORDS.contains(&word.as_str())
}

/// `Err` with the read-only message unless `sql` is a reading statement.
pub(crate) fn assert_reading(sql: &str) -> Result<(), String> {
    if is_reading(sql) {
        Ok(())
    } else {
        Err(READ_ONLY_MESSAGE.to_owned())
    }
}

/// The first statement of `sql`: everything up to the first `;` outside quotes and comments.
///
/// Node's `DatabaseSync.prepare` compiles only the first statement; sqlx's SQLite driver runs
/// them all, so the runner cuts the text first.
pub(crate) fn first_statement(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b';' => return &sql[..index],
            quote @ (b'\'' | b'"' | b'`') => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == quote {
                        // A doubled quote is an escaped quote inside the literal.
                        if bytes.get(index + 1) == Some(&quote) {
                            index += 1;
                        } else {
                            break;
                        }
                    }
                    index += 1;
                }
            }
            b'[' => {
                while index < bytes.len() && bytes[index] != b']' {
                    index += 1;
                }
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index < bytes.len()
                    && !(bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/'))
                {
                    index += 1;
                }
                index += 1;
            }
            _ => {}
        }
        index += 1;
    }
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_statements_pass_after_comments() {
        for sql in [
            "select 1",
            "  SELECT 1",
            "-- newest first\nselect id from users",
            "/* x */ with a as (select 1) select * from a",
            "show tables",
            "desc users",
            "explain select 1",
            "pragma table_info(users)",
            "select*from users",
        ] {
            assert!(is_reading(sql), "{sql} should count as reading");
        }
    }

    #[test]
    fn writing_statements_are_refused() {
        for sql in [
            "delete from users",
            "drop table users",
            "/* x */ update users set name = ''",
            "selection",
            "-- only a comment",
            "",
        ] {
            assert_eq!(
                assert_reading(sql),
                Err(READ_ONLY_MESSAGE.to_owned()),
                "{sql} should be refused"
            );
        }
    }

    #[test]
    fn first_statement_skips_quoted_semicolons() {
        assert_eq!(first_statement("select 1; delete from users"), "select 1");
        assert_eq!(first_statement("select ';' as a; drop"), "select ';' as a");
        assert_eq!(first_statement("select 'it''s;' ; x"), "select 'it''s;' ");
        assert_eq!(
            first_statement("select \"a;b\" from t"),
            "select \"a;b\" from t"
        );
        assert_eq!(first_statement("select 1 -- ;\n; x"), "select 1 -- ;\n");
        assert_eq!(first_statement("select /* ; */ 1; x"), "select /* ; */ 1");
        assert_eq!(
            first_statement("select [a;b] from t; x"),
            "select [a;b] from t"
        );
    }
}
