//! Pure Rust filtering and ranking for the `Cmd+K` command palette.
//!
//! Kept UI-free so `cargo test -p conn-app` can verify ranking, subsequence
//! matching, and `>` actions-only mode without a window server.

use conn_state::RightPanelTab;
use conn_theme::{Appearance, Rgba};

/// Thread entry shown in the command palette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaletteThread {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) project_title: String,
    pub(crate) branch: Option<String>,
    pub(crate) is_current: bool,
}

/// Project entry shown in the command palette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaletteProject {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) workspace_root: String,
}

/// Theme entry shown in the command palette.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PaletteTheme {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) appearance: Appearance,
    pub(crate) is_current: bool,
    pub(crate) swatch_bg: Rgba,
    pub(crate) swatch_primary: Rgba,
    pub(crate) swatch_accent: Rgba,
}

/// Orbit Node or Instance target shown in the command palette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PaletteTarget {
    pub(crate) server_id: String,
    pub(crate) title: String,
    pub(crate) subtitle: String,
    pub(crate) is_node: bool,
    pub(crate) is_current: bool,
}

/// Shell action triggered from the command palette.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PaletteAction {
    NewThread,
    ToggleSidebar,
    ToggleRightPanel,
    OpenPanel(RightPanelTab),
    SelectProject(String),
    OpenSettings,
}

/// Input catalog passed into [`super::CommandPalette::new`].
#[derive(Clone, Debug, Default)]
pub(crate) struct PaletteItems {
    pub(crate) threads: Vec<PaletteThread>,
    pub(crate) projects: Vec<PaletteProject>,
    pub(crate) targets: Vec<PaletteTarget>,
    pub(crate) themes: Vec<PaletteTheme>,
}

/// One built-in shell action entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ActionEntry {
    pub(crate) title: &'static str,
    pub(crate) keywords: &'static str,
    pub(crate) shortcut: Option<&'static [&'static str]>,
    pub(crate) action: PaletteAction,
}

/// Built-in actions available in the command palette.
pub(crate) const BUILTIN_ACTIONS: &[ActionEntry] = &[
    ActionEntry {
        title: "New thread",
        keywords: "new thread compose create chat start draft",
        shortcut: Some(&["⌘", "N"]),
        action: PaletteAction::NewThread,
    },
    ActionEntry {
        title: "Toggle sidebar",
        keywords: "sidebar rail navigation panel left",
        shortcut: Some(&["⌘", "B"]),
        action: PaletteAction::ToggleSidebar,
    },
    ActionEntry {
        title: "Toggle right panel",
        keywords: "right panel inspector drawer",
        shortcut: Some(&["⌘", "⌥", "B"]),
        action: PaletteAction::ToggleRightPanel,
    },
    ActionEntry {
        title: "Open Files panel",
        keywords: "files tree explorer browser right panel",
        shortcut: None,
        action: PaletteAction::OpenPanel(RightPanelTab::Files),
    },
    ActionEntry {
        title: "Open Diff panel",
        keywords: "diff git changes review right panel",
        shortcut: None,
        action: PaletteAction::OpenPanel(RightPanelTab::Diff),
    },
    ActionEntry {
        title: "Open Terminal panel",
        keywords: "terminal shell console right panel",
        shortcut: None,
        action: PaletteAction::OpenPanel(RightPanelTab::Terminal),
    },
    ActionEntry {
        title: "Open Browser panel",
        keywords: "browser web preview right panel",
        shortcut: None,
        action: PaletteAction::OpenPanel(RightPanelTab::Browser),
    },
    ActionEntry {
        title: "Open Settings",
        keywords: "settings preferences theme appearance connections keyboard",
        shortcut: Some(&["⌘", ","]),
        action: PaletteAction::OpenSettings,
    },
];

/// A selectable row inside a filtered palette group.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PaletteRow {
    Thread(PaletteThread),
    Project(PaletteProject),
    Target(PaletteTarget),
    Theme(PaletteTheme),
    Action(ActionEntry),
}

/// One titled section of filtered results.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FilteredGroup {
    pub(crate) label: &'static str,
    pub(crate) rows: Vec<PaletteRow>,
}

/// Filters and ranks `items` + [`BUILTIN_ACTIONS`] against `raw_query`.
///
/// A leading `>` restricts results to Actions only, matching Conn's
/// `CommandPalette.tsx`.
#[must_use]
pub(crate) fn filter_items(items: &PaletteItems, raw_query: &str) -> Vec<FilteredGroup> {
    let trimmed = raw_query.trim();
    let (actions_only, query) = match trimmed.strip_prefix('>') {
        Some(rest) => (true, rest.trim()),
        None => (false, trimmed),
    };

    let mut groups = Vec::with_capacity(4);

    if !actions_only {
        let threads = rank_slice(&items.threads, query, |t| {
            let branch = t.branch.as_deref().unwrap_or("");
            (t.title.as_str(), [&t.project_title, branch])
        });
        if !threads.is_empty() {
            groups.push(FilteredGroup {
                label: "Threads",
                rows: threads.into_iter().map(PaletteRow::Thread).collect(),
            });
        }

        let projects = rank_slice(&items.projects, query, |p| {
            (p.title.as_str(), [p.workspace_root.as_str(), ""])
        });
        if !projects.is_empty() {
            groups.push(FilteredGroup {
                label: "Projects",
                rows: projects.into_iter().map(PaletteRow::Project).collect(),
            });
        }

        let targets = rank_slice(&items.targets, query, |t| {
            let kind = if t.is_node {
                "orbit node server"
            } else {
                "orbit instance server"
            };
            (t.title.as_str(), [t.subtitle.as_str(), kind])
        });
        if !targets.is_empty() {
            groups.push(FilteredGroup {
                label: "Nodes & Instances",
                rows: targets.into_iter().map(PaletteRow::Target).collect(),
            });
        }

        let themes = rank_slice(&items.themes, query, |t| {
            let mode = match t.appearance {
                Appearance::Light => "light theme",
                Appearance::Dark => "dark theme",
            };
            (t.name.as_str(), [t.id.as_str(), mode])
        });
        if !themes.is_empty() {
            groups.push(FilteredGroup {
                label: "Themes",
                rows: themes.into_iter().map(PaletteRow::Theme).collect(),
            });
        }
    }

    let actions = rank_slice(BUILTIN_ACTIONS, query, |a| (a.title, [a.keywords, ""]));
    if !actions.is_empty() {
        groups.push(FilteredGroup {
            label: "Actions",
            rows: actions.into_iter().map(PaletteRow::Action).collect(),
        });
    }

    groups
}

/// Counts total selectable rows across all groups.
#[must_use]
pub(crate) fn total_rows(groups: &[FilteredGroup]) -> usize {
    groups.iter().map(|g| g.rows.len()).sum()
}

/// Returns the `flat_index`-th selectable row across `groups`, if in range.
#[must_use]
pub(crate) fn row_at(groups: &[FilteredGroup], flat_index: usize) -> Option<&PaletteRow> {
    let mut offset = 0;
    for group in groups {
        if flat_index < offset + group.rows.len() {
            return group.rows.get(flat_index - offset);
        }
        offset += group.rows.len();
    }
    None
}

/// Maps a selectable `flat_index` to its child index inside a rendered list
/// where each group emits 1 heading element followed by its row elements.
#[must_use]
pub(crate) fn scroll_child_index(groups: &[FilteredGroup], flat_index: usize) -> Option<usize> {
    let mut flat = 0;
    let mut child = 0;
    for group in groups {
        child += 1; // group heading
        if flat_index < flat + group.rows.len() {
            return Some(child + (flat_index - flat));
        }
        flat += group.rows.len();
        child += group.rows.len();
    }
    None
}

fn rank_slice<T: Clone>(
    slice: &[T],
    query: &str,
    fields: impl Fn(&T) -> (&str, [&str; 2]),
) -> Vec<T> {
    if query.is_empty() {
        return slice.to_vec();
    }

    let mut scored: Vec<(i32, usize, T)> = slice
        .iter()
        .enumerate()
        .filter_map(|(idx, item)| {
            let (primary, secondary) = fields(item);
            let mut best = fuzzy_score(primary, query).map(|s| s + 200);
            for extra in secondary {
                if !extra.is_empty()
                    && let Some(score) = fuzzy_score(extra, query)
                {
                    best = Some(best.map_or(score, |prev| prev.max(score)));
                }
            }
            best.map(|score| (score, idx, item.clone()))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().map(|(_, _, item)| item).collect()
}

/// Case-insensitive subsequence scorer.
///
/// Higher score = stronger match:
/// - Exact match > prefix match > word-boundary match > contiguous substring > subsequence.
/// - Returns `None` when `query` is not a subsequence of `candidate`.
#[must_use]
pub(crate) fn fuzzy_score(candidate: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let cand_lower: Vec<char> = candidate.to_lowercase().chars().collect();
    let query_lower: Vec<char> = query.to_lowercase().chars().collect();

    if cand_lower == query_lower {
        return Some(1000);
    }

    let cand_str: String = cand_lower.iter().collect();
    let query_str: String = query_lower.iter().collect();

    if cand_str.starts_with(&query_str) {
        let len_penalty =
            i32::try_from(cand_lower.len().saturating_sub(query_lower.len())).unwrap_or(i32::MAX);
        return Some(800 - len_penalty.min(200));
    }

    if let Some(pos) = cand_str.find(&query_str) {
        let boundary_bonus = if pos == 0
            || cand_str[..pos]
                .chars()
                .next_back()
                .is_some_and(is_word_separator)
        {
            120
        } else {
            0
        };
        let pos_penalty = i32::try_from(pos).unwrap_or(i32::MAX).min(150);
        return Some(550 + boundary_bonus - pos_penalty);
    }

    // Subsequence match with consecutive and word-boundary bonuses.
    let mut score = 200_i32;
    let mut qi = 0;
    let mut prev_match: Option<usize> = None;
    for (ci, &ch) in cand_lower.iter().enumerate() {
        if qi < query_lower.len() && ch == query_lower[qi] {
            if let Some(prev) = prev_match {
                if ci == prev + 1 {
                    score += 24;
                } else {
                    let gap = i32::try_from(ci - prev - 1).unwrap_or(30).min(30);
                    score -= gap;
                }
            }
            if ci == 0 || is_word_separator(cand_lower[ci - 1]) {
                score += 30;
            }
            prev_match = Some(ci);
            qi += 1;
        }
    }

    if qi == query_lower.len() {
        Some(score)
    } else {
        None
    }
}

fn is_word_separator(ch: char) -> bool {
    matches!(ch, ' ' | '-' | '_' | '/' | '.' | ':')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_items() -> PaletteItems {
        PaletteItems {
            threads: vec![
                PaletteThread {
                    id: "t-1".into(),
                    title: "Fix GPUI sidebar alignment".into(),
                    project_title: "conn-gpui".into(),
                    branch: Some("feat/sidebar".into()),
                    is_current: true,
                },
                PaletteThread {
                    id: "t-2".into(),
                    title: "Investigate WebSocket reconnect".into(),
                    project_title: "conn-server".into(),
                    branch: Some("main".into()),
                    is_current: false,
                },
            ],
            projects: vec![
                PaletteProject {
                    id: "p-1".into(),
                    title: "conn-gpui".into(),
                    workspace_root: "/Users/dev/apps/conn-gpui".into(),
                },
                PaletteProject {
                    id: "p-2".into(),
                    title: "conn-server".into(),
                    workspace_root: "/Users/dev/apps/conn-server".into(),
                },
            ],
            targets: vec![],
            themes: vec![
                PaletteTheme {
                    id: "dark-ocean".into(),
                    name: "Dark Ocean".into(),
                    appearance: Appearance::Dark,
                    is_current: true,
                    swatch_bg: Rgba::hex(0x0d0f12),
                    swatch_primary: Rgba::hex(0x4b7bb5),
                    swatch_accent: Rgba::hex(0x253f63),
                },
                PaletteTheme {
                    id: "t3-code-light".into(),
                    name: "T3 Code Light".into(),
                    appearance: Appearance::Light,
                    is_current: false,
                    swatch_bg: Rgba::hex(0xfcfcfc),
                    swatch_primary: Rgba::hex(0x2145a1),
                    swatch_accent: Rgba::hex(0xe4e4e7),
                },
            ],
        }
    }

    #[test]
    fn empty_query_returns_all_groups_in_order() {
        let groups = filter_items(&sample_items(), "");
        let labels: Vec<&str> = groups.iter().map(|g| g.label).collect();
        assert_eq!(
            labels,
            vec!["Threads", "Projects", "Themes", "Actions"],
            "empty query should list all four groups in canonical order"
        );
        assert_eq!(
            total_rows(&groups),
            2 + 2 + 2 + BUILTIN_ACTIONS.len(),
            "empty query should include every item"
        );
    }

    #[test]
    fn exact_and_prefix_rank_above_subsequence() {
        let exact = fuzzy_score("Dark Ocean", "dark ocean");
        let prefix = fuzzy_score("Dark Ocean", "dark");
        let boundary = fuzzy_score("Dark Ocean", "ocean");
        let subseq = fuzzy_score("Dark Ocean", "dko");

        assert!(exact.is_some(), "exact match must succeed");
        assert!(prefix.is_some(), "prefix match must succeed");
        assert!(boundary.is_some(), "word-boundary match must succeed");
        assert!(subseq.is_some(), "subsequence match must succeed");
        assert!(
            exact > prefix && prefix > boundary && boundary > subseq,
            "ranking order violated: exact={exact:?}, prefix={prefix:?}, boundary={boundary:?}, subseq={subseq:?}"
        );
    }

    #[test]
    fn subsequence_matches_themes_and_secondary_project_matches_threads() {
        let items = sample_items();

        let theme_groups = filter_items(&items, "dko");
        assert!(
            theme_groups.iter().any(|g| g.label == "Themes"
                && matches!(
                    g.rows.first(),
                    Some(PaletteRow::Theme(t)) if t.id == "dark-ocean"
                )),
            "subsequence 'dko' should match Dark Ocean theme"
        );

        let project_groups = filter_items(&items, "conn-server");
        let thread_group = project_groups.iter().find(|g| g.label == "Threads");
        assert!(
            matches!(
                thread_group.and_then(|g| g.rows.first()),
                Some(PaletteRow::Thread(t)) if t.id == "t-2"
            ),
            "searching by project title should match threads in that project"
        );
    }

    #[test]
    fn actions_only_prefix_filters_other_groups() {
        let groups = filter_items(&sample_items(), "> terminal");
        assert_eq!(
            groups.len(),
            1,
            "leading '>' must return only the Actions group"
        );
        assert_eq!(groups[0].label, "Actions", "only Actions group should show");
        assert!(
            matches!(
                groups[0].rows.first(),
                Some(PaletteRow::Action(a)) if a.action == PaletteAction::OpenPanel(RightPanelTab::Terminal)
            ),
            "expected Open Terminal panel action"
        );
    }

    #[test]
    fn non_matching_query_returns_empty_and_scroll_index_maps_correctly() {
        let items = sample_items();
        let empty = filter_items(&items, "zzzz-no-match-999");
        assert!(
            empty.is_empty(),
            "non-matching query should produce no groups"
        );
        assert_eq!(total_rows(&empty), 0, "total_rows must be 0 when empty");
        assert!(
            row_at(&empty, 0).is_none(),
            "row_at(0) must be None when empty"
        );

        let all = filter_items(&items, "");
        // Group 0 ("Threads") has heading at child 0, rows at children 1 and 2.
        // Group 1 ("Projects") has heading at child 3, rows at children 4 and 5.
        assert_eq!(
            scroll_child_index(&all, 0),
            Some(1),
            "first thread row sits after first heading"
        );
        assert_eq!(
            scroll_child_index(&all, 2),
            Some(4),
            "first project row sits after second heading"
        );
    }
}
