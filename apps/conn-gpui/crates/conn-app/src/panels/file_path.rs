//! Path helpers for the Files panel's breadcrumbs and folder menu, ported from web Conn's
//! `components/files/filePath.ts` (`fileBreadcrumbs`, `fileBreadcrumbChildren`,
//! `fileBreadcrumbParent`). Workspace-relative paths only: host paths belong to the web client's
//! "open a file outside the workspace" flow, which the native app does not have.

use std::cmp::Ordering;

use conn_contract::{ProjectEntry, ProjectEntryKind};

/// One crumb: the project root first, then each folder, then the file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Crumb {
    pub(crate) label: String,
    /// The workspace-relative path; empty for the project root.
    pub(crate) path: String,
    pub(crate) is_file: bool,
}

/// The crumbs for `relative_path`, led by `project_name` for the workspace root.
pub(crate) fn breadcrumbs(project_name: &str, relative_path: &str) -> Vec<Crumb> {
    let parts: Vec<&str> = relative_path.split('/').filter(|p| !p.is_empty()).collect();
    let mut crumbs = vec![Crumb {
        label: project_name.to_owned(),
        path: String::new(),
        is_file: false,
    }];
    for (index, part) in parts.iter().enumerate() {
        crumbs.push(Crumb {
            label: (*part).to_owned(),
            path: parts[..=index].join("/"),
            is_file: index + 1 == parts.len(),
        });
    }
    crumbs
}

/// A row of a folder's contents menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Child {
    pub(crate) label: String,
    pub(crate) path: String,
    pub(crate) kind: ProjectEntryKind,
    pub(crate) ignored: bool,
}

/// The direct children of `directory` among `entries`, folders first, then by name with numbers
/// in natural order and case ignored (`Intl.Collator` with `numeric` and `base` sensitivity).
pub(crate) fn breadcrumb_children(entries: &[ProjectEntry], directory: &str) -> Vec<Child> {
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut children: Vec<Child> = entries
        .iter()
        .filter_map(|entry| {
            let label = entry.path.strip_prefix(&prefix)?;
            if label.is_empty() || label.contains('/') {
                return None;
            }
            Some(Child {
                label: label.to_owned(),
                path: entry.path.clone(),
                kind: entry.kind,
                ignored: entry.ignored.unwrap_or(false),
            })
        })
        .collect();
    children.sort_by(|a, b| {
        let a_dir = a.kind == ProjectEntryKind::Directory;
        let b_dir = b.kind == ProjectEntryKind::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| natural_cmp(&a.label, &b.label))
    });
    children
}

/// The folder above `directory`: `None` at the root, `Some("")` for a top-level folder.
pub(crate) fn breadcrumb_parent(directory: &str) -> Option<String> {
    if directory.is_empty() {
        return None;
    }
    Some(
        directory
            .rsplit_once('/')
            .map_or_else(String::new, |(parent, _)| parent.to_owned()),
    )
}

/// A folder path's last segment, or `project_name` for the root.
pub(crate) fn path_label(path: &str, project_name: &str) -> String {
    match path.rsplit_once('/') {
        Some((_, last)) if !last.is_empty() => last.to_owned(),
        _ if path.is_empty() => project_name.to_owned(),
        _ => path.to_owned(),
    }
}

/// Splits `path:line[:column]` into the path and its line (`splitFilePathPosition`).
pub(crate) fn split_line_suffix(path: &str) -> (&str, Option<usize>) {
    let mut current = path;
    let mut numbers: Vec<usize> = Vec::new();
    for _ in 0..2 {
        match current.rsplit_once(':') {
            Some((prefix, suffix))
                if !prefix.is_empty()
                    && !suffix.is_empty()
                    && suffix.bytes().all(|b| b.is_ascii_digit()) =>
            {
                numbers.push(suffix.parse().unwrap_or(0));
                current = prefix;
            }
            _ => break,
        }
    }
    // `a.rs:42:7` lists the column first when read from the right; the line is the last number.
    let line = numbers.last().copied().filter(|line| *line > 0);
    (current, line)
}

/// The composer's file mention for `path` (`serializeComposerFileLink`): a Markdown link whose
/// label is the file name and whose address is the percent-encoded path.
pub(crate) fn mention(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let label: String = name
        .chars()
        .flat_map(|c| match c {
            '\\' | '[' | ']' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    let destination: String = path
        .chars()
        .flat_map(|c| match c {
            ' ' => "%20".chars().collect::<Vec<_>>(),
            '(' => "%28".chars().collect(),
            ')' => "%29".chars().collect(),
            c => vec![c],
        })
        .collect();
    format!("[{label}]({destination})")
}

/// What the composer holds after a mention is added (`insertTextAtEnd(`${mention} `,
/// { ensureLeadingBoundary: true })`): the mention and a space at the end, with a space
/// before it unless the text is empty or already ends in whitespace.
pub(crate) fn append_mention(current: &str, mention: &str) -> String {
    let boundary = current.is_empty() || current.ends_with(char::is_whitespace);
    format!("{current}{}{mention} ", if boundary { "" } else { " " })
}

/// A file row dragged from the Files tree: dropped on the composer, it becomes a mention.
#[derive(Clone, Debug)]
pub(crate) struct FileMentionDrag {
    /// The workspace-relative path.
    pub(crate) path: String,
}

/// The absolute path of workspace-relative `relative` under `root`.
pub(crate) fn absolute_path(root: &str, relative: &str) -> String {
    format!(
        "{}/{}",
        root.trim_end_matches('/'),
        relative.trim_start_matches('/')
    )
}

/// Case-insensitive comparison that orders runs of digits by value (`file2` before `file10`).
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut left = a.chars().peekable();
    let mut right = b.chars().peekable();
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(l), Some(r)) if l.is_ascii_digit() && r.is_ascii_digit() => {
                let mut ln = String::new();
                while let Some(&c) = left.peek().filter(|c| c.is_ascii_digit()) {
                    ln.push(c);
                    left.next();
                }
                let mut rn = String::new();
                while let Some(&c) = right.peek().filter(|c| c.is_ascii_digit()) {
                    rn.push(c);
                    right.next();
                }
                let (lt, rt) = (ln.trim_start_matches('0'), rn.trim_start_matches('0'));
                let order = lt.len().cmp(&rt.len()).then_with(|| lt.cmp(rt));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(l), Some(r)) => {
                let order = l.to_lowercase().cmp(r.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left.next();
                right.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, kind: ProjectEntryKind) -> ProjectEntry {
        ProjectEntry {
            path: path.to_owned(),
            kind,
            ignored: None,
        }
    }

    #[test]
    fn crumbs_start_at_the_project_and_end_at_the_file() {
        let crumbs = breadcrumbs("conn", "src/panels/files.rs");
        let labels: Vec<_> = crumbs.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["conn", "src", "panels", "files.rs"]);
        let paths: Vec<_> = crumbs.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, ["", "src", "src/panels", "src/panels/files.rs"]);
        assert!(crumbs[3].is_file && !crumbs[2].is_file && !crumbs[0].is_file);
    }

    #[test]
    fn a_root_file_has_two_crumbs() {
        let crumbs = breadcrumbs("conn", "README.md");
        assert_eq!(crumbs.len(), 2);
        assert_eq!(crumbs[1].path, "README.md");
    }

    #[test]
    fn children_are_direct_folders_first_in_natural_order() {
        let entries = [
            entry("src/b.rs", ProjectEntryKind::File),
            entry("src/file10.rs", ProjectEntryKind::File),
            entry("src/file2.rs", ProjectEntryKind::File),
            entry("src/Zed", ProjectEntryKind::Directory),
            entry("src/a/deep.rs", ProjectEntryKind::File),
            entry("src/alpha", ProjectEntryKind::Directory),
            entry("other/x.rs", ProjectEntryKind::File),
        ];
        let labels: Vec<_> = breadcrumb_children(&entries, "src")
            .into_iter()
            .map(|c| c.label)
            .collect();
        assert_eq!(labels, ["alpha", "Zed", "b.rs", "file2.rs", "file10.rs"]);
    }

    #[test]
    fn root_children_have_no_prefix() {
        let entries = [
            entry("a.txt", ProjectEntryKind::File),
            entry("dir", ProjectEntryKind::Directory),
            entry("dir/b.txt", ProjectEntryKind::File),
        ];
        let labels: Vec<_> = breadcrumb_children(&entries, "")
            .into_iter()
            .map(|c| c.label)
            .collect();
        assert_eq!(labels, ["dir", "a.txt"]);
    }

    #[test]
    fn parents_walk_up_to_the_root() {
        assert_eq!(breadcrumb_parent("a/b/c").as_deref(), Some("a/b"));
        assert_eq!(breadcrumb_parent("a").as_deref(), Some(""));
        assert_eq!(breadcrumb_parent(""), None);
    }

    #[test]
    fn mentions_are_markdown_links_with_an_encoded_path() {
        assert_eq!(mention("src/lib.rs"), "[lib.rs](src/lib.rs)");
        assert_eq!(
            mention("my dir/a (1).md"),
            "[a (1).md](my%20dir/a%20%281%29.md)"
        );
        assert_eq!(mention("a/[x].md"), "[\\[x\\].md](a/[x].md)");
    }

    #[test]
    fn a_line_and_column_suffix_splits_off() {
        assert_eq!(split_line_suffix("src/a.rs:42"), ("src/a.rs", Some(42)));
        assert_eq!(split_line_suffix("src/a.rs:42:7"), ("src/a.rs", Some(42)));
        assert_eq!(split_line_suffix("src/a.rs"), ("src/a.rs", None));
        assert_eq!(split_line_suffix("a:b.rs"), ("a:b.rs", None));
        assert_eq!(split_line_suffix("a.rs:0"), ("a.rs", None));
    }

    #[test]
    fn a_mention_is_appended_with_a_boundary_and_a_trailing_space() {
        assert_eq!(append_mention("", "[a](a)"), "[a](a) ");
        assert_eq!(append_mention("look at", "[a](a)"), "look at [a](a) ");
        assert_eq!(append_mention("look at ", "[a](a)"), "look at [a](a) ");
        assert_eq!(append_mention("line\n", "[a](a)"), "line\n[a](a) ");
    }

    #[test]
    fn absolute_paths_join_without_doubled_slashes() {
        assert_eq!(
            absolute_path("/work/app/", "src/a.rs"),
            "/work/app/src/a.rs"
        );
        assert_eq!(absolute_path("/work/app", "/a.rs"), "/work/app/a.rs");
    }

    #[test]
    fn labels_use_the_last_segment_or_the_project() {
        assert_eq!(path_label("a/b", "conn"), "b");
        assert_eq!(path_label("", "conn"), "conn");
    }
}
