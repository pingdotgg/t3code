//! How the Files panel previews a file, by its name (web Conn's `filePreviewMode.ts`,
//! `FilePreviewPanel.tsx` and `DelimitedTablePreview.tsx`), and the CSV reader the table preview
//! uses. Pure, so it can be tested without a window.

/// What kind of preview a path gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreviewKind {
    /// Source text with syntax colours, as for any file.
    Text,
    /// `.md` and friends: source, or rendered Markdown.
    Markdown,
    /// `.csv` / `.tsv`: source, or a table.
    Delimited { delimiter: char },
    /// An image the client can paint, as bytes from the server.
    Image(&'static str),
    /// `.html` / `.htm`: source here, and the Browser panel for the page itself.
    Html,
    /// `.pdf`: shown by the Browser panel's Chromium.
    Pdf,
}

/// The preview kind for `path`.
pub(crate) fn preview_kind(path: &str) -> PreviewKind {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map_or("", |(_, ext)| ext);
    match ext {
        "md" | "mdx" | "markdown" | "mdown" | "mkd" => PreviewKind::Markdown,
        "csv" => PreviewKind::Delimited { delimiter: ',' },
        "tsv" => PreviewKind::Delimited { delimiter: '\t' },
        "html" | "htm" => PreviewKind::Html,
        "pdf" => PreviewKind::Pdf,
        "png" => PreviewKind::Image("image/png"),
        "jpg" | "jpeg" => PreviewKind::Image("image/jpeg"),
        "gif" => PreviewKind::Image("image/gif"),
        "webp" => PreviewKind::Image("image/webp"),
        "svg" => PreviewKind::Image("image/svg+xml"),
        "bmp" => PreviewKind::Image("image/bmp"),
        _ => PreviewKind::Text,
    }
}

impl PreviewKind {
    /// Whether the file has a rendered view next to its source, which a toggle switches to.
    pub(crate) fn has_rendered_view(self) -> bool {
        matches!(self, Self::Markdown | Self::Delimited { .. })
    }

    /// Whether the rendered view is on when the file opens: a table is, Markdown is not
    /// (`renderTablePreferred` is `true` and `renderMarkdownPreferred` `false` by default).
    pub(crate) fn rendered_by_default(self) -> bool {
        matches!(self, Self::Delimited { .. })
    }

    /// Whether the Browser panel can show the file's page (`openFileInPreview`).
    pub(crate) fn opens_in_browser(self) -> bool {
        matches!(self, Self::Html | Self::Pdf)
    }
}

/// The most rows the table preview reads, so a huge file does not stall a frame.
pub(crate) const MAX_TABLE_ROWS: usize = 1_000;

/// Reads `text` as delimiter-separated values (RFC 4180 quoting: `"` wraps a field, `""` is a
/// quote, and a quoted field may hold the delimiter and line breaks). Stops after `max_rows`.
pub(crate) fn parse_delimited(text: &str, delimiter: char, max_rows: usize) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_quotes = true,
            c if c == delimiter => row.push(std::mem::take(&mut field)),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                if rows.len() >= max_rows {
                    return rows;
                }
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                if rows.len() >= max_rows {
                    return rows;
                }
            }
            c => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_follow_the_extension_case_insensitively() {
        assert_eq!(preview_kind("README.md"), PreviewKind::Markdown);
        assert_eq!(preview_kind("a/b/NOTES.MDX"), PreviewKind::Markdown);
        assert_eq!(
            preview_kind("data.CSV"),
            PreviewKind::Delimited { delimiter: ',' }
        );
        assert_eq!(
            preview_kind("data.tsv"),
            PreviewKind::Delimited { delimiter: '\t' }
        );
        assert_eq!(preview_kind("logo.PNG"), PreviewKind::Image("image/png"));
        assert_eq!(preview_kind("a.jpeg"), PreviewKind::Image("image/jpeg"));
        assert_eq!(preview_kind("a.svg"), PreviewKind::Image("image/svg+xml"));
        assert_eq!(preview_kind("a.webp"), PreviewKind::Image("image/webp"));
        assert_eq!(preview_kind("a.gif"), PreviewKind::Image("image/gif"));
        assert_eq!(preview_kind("index.html"), PreviewKind::Html);
        assert_eq!(preview_kind("doc.pdf"), PreviewKind::Pdf);
        assert_eq!(preview_kind("main.rs"), PreviewKind::Text);
        assert_eq!(preview_kind("Makefile"), PreviewKind::Text);
    }

    #[test]
    fn kinds_decide_how_a_file_is_read_and_shown() {
        assert!(PreviewKind::Markdown.has_rendered_view());
        assert!(!PreviewKind::Text.has_rendered_view());
        assert!(!PreviewKind::Markdown.rendered_by_default());
        assert!(PreviewKind::Delimited { delimiter: ',' }.rendered_by_default());
        assert!(PreviewKind::Html.opens_in_browser() && PreviewKind::Pdf.opens_in_browser());
        assert!(!PreviewKind::Markdown.opens_in_browser());
    }

    fn rows(text: &str) -> Vec<Vec<String>> {
        parse_delimited(text, ',', 100)
    }

    #[test]
    fn plain_rows_and_a_missing_final_newline() {
        assert_eq!(rows("a,b\n1,2"), vec![vec!["a", "b"], vec!["1", "2"]]);
        assert_eq!(rows("a,b\r\n1,2\r\n"), vec![vec!["a", "b"], vec!["1", "2"]]);
    }

    #[test]
    fn quoted_fields_keep_commas_quotes_and_line_breaks() {
        assert_eq!(
            rows("name,note\n\"Doe, J\",\"said \"\"hi\"\"\"\nx,\"two\nlines\""),
            vec![
                vec!["name", "note"],
                vec!["Doe, J", "said \"hi\""],
                vec!["x", "two\nlines"],
            ]
        );
    }

    #[test]
    fn empty_fields_and_empty_input() {
        assert_eq!(rows("a,,c\n"), vec![vec!["a", "", "c"]]);
        assert!(rows("").is_empty());
    }

    #[test]
    fn tabs_split_tsv_and_the_row_cap_stops_reading() {
        assert_eq!(
            parse_delimited("a\tb\nc\td\ne\tf", '\t', 2),
            vec![vec!["a", "b"], vec!["c", "d"]]
        );
    }
}
