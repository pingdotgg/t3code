//! The toolbar's table sorting and flyout sizing (`apps/web/src/laravelToolbar/ui/tableSort.tsx`
//! and `panelResize.ts`), without the drawing.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

/// The direction of a sorted column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    Ascending,
    Descending,
}

/// A table's sort (`TableSort`): none shows the source order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSort {
    pub column: String,
    pub direction: SortDirection,
}

/// A cell value to sort by (`SortValue`).
#[derive(Debug, Clone, PartialEq)]
pub enum SortValue {
    Number(f64),
    Text(String),
}

impl From<f64> for SortValue {
    fn from(value: f64) -> Self {
        Self::Number(value)
    }
}

impl From<&str> for SortValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for SortValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

/// Ascending, then descending, then the original order; another column starts ascending.
#[must_use]
pub fn next_table_sort(sort: Option<&TableSort>, column: &str) -> Option<TableSort> {
    match sort {
        Some(current) if current.column == column => match current.direction {
            SortDirection::Ascending => Some(TableSort {
                column: column.to_owned(),
                direction: SortDirection::Descending,
            }),
            SortDirection::Descending => None,
        },
        _ => Some(TableSort {
            column: column.to_owned(),
            direction: SortDirection::Ascending,
        }),
    }
}

/// `localeCompare(..., { numeric: true, sensitivity: "base" })`: digits compare as numbers, case
/// and accents are ignored.
fn natural_compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut digits = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        it.next();
                    }
                    digits.trim_start_matches('0').to_owned()
                };
                let (dl, dr) = (take(&mut left), take(&mut right));
                let by_length = dl.len().cmp(&dr.len()).then_with(|| dl.cmp(&dr));
                if by_length != Ordering::Equal {
                    return by_length;
                }
            }
            (Some(x), Some(y)) => {
                left.next();
                right.next();
                if x != y {
                    return x.cmp(&y);
                }
            }
        }
    }
}

/// The rows in the order of `sort`. Missing values stay at the bottom in either direction and
/// equal values keep their source order.
#[must_use]
pub fn sort_table_rows<T: Clone>(
    rows: &[T],
    sort: Option<&TableSort>,
    value: impl Fn(&T, &str) -> Option<SortValue>,
) -> Vec<T> {
    let Some(sort) = sort else {
        return rows.to_vec();
    };
    let mut keyed: Vec<(Option<SortValue>, T)> = rows
        .iter()
        .map(|row| (value(row, &sort.column), row.clone()))
        .collect();
    keyed.sort_by(|(a, _), (b, _)| match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => {
            let compared = match (a, b) {
                (SortValue::Number(a), SortValue::Number(b)) => {
                    a.partial_cmp(b).unwrap_or(Ordering::Equal)
                }
                (a, b) => natural_compare(&text_of(a), &text_of(b)),
            };
            match sort.direction {
                SortDirection::Ascending => compared,
                SortDirection::Descending => compared.reverse(),
            }
        }
    });
    keyed.into_iter().map(|(_, row)| row).collect()
}

fn text_of(value: &SortValue) -> String {
    match value {
        SortValue::Number(number) => number.to_string(),
        SortValue::Text(text) => text.clone(),
    }
}

/// The flyout's default height (`DEFAULT_HEIGHT`).
pub const DEFAULT_PANEL_HEIGHT: f32 = 384.0;
const MIN_PANEL_HEIGHT: f32 = 192.0;
/// The floating sheet keeps this gap to the page edges and the bar (`TOOLBAR_SHEET_INSET`).
pub const TOOLBAR_SHEET_INSET: f32 = 6.0;

/// The flyout's size limits and current height (`useToolbarPanelResize`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelResize {
    pub preferred: f32,
    /// The space above the bar the sheet may use.
    pub available: f32,
}

impl PanelResize {
    #[must_use]
    pub fn min_height(&self) -> f32 {
        MIN_PANEL_HEIGHT.min(self.available)
    }

    #[must_use]
    pub fn clamp(&self, value: f32) -> f32 {
        value.clamp(self.min_height(), self.available.max(self.min_height()))
    }

    /// The height the flyout has: the preferred one, within the limits.
    #[must_use]
    pub fn height(&self) -> f32 {
        self.clamp(self.preferred)
    }

    /// A drag to `value`: the new preferred height.
    pub fn drag_to(&mut self, value: f32) -> f32 {
        self.preferred = self.clamp(value);
        self.preferred
    }

    /// A key on the separator: arrows step by 10 (40 with Shift), Home and End go to the limits.
    /// `None` for a key it does not handle.
    pub fn key(&mut self, key: &str, shift: bool) -> Option<f32> {
        let step = if shift { 40.0 } else { 10.0 };
        let height = self.height();
        let next = match key {
            "up" | "ArrowUp" => height + step,
            "down" | "ArrowDown" => height - step,
            "home" | "Home" => self.min_height(),
            "end" | "End" => self.available,
            _ => return None,
        };
        Some(self.drag_to(next))
    }
}

/// Where the preferred height is kept, beside the other desktop state.
#[must_use]
pub fn panel_height_path(config_dir: &Path) -> PathBuf {
    config_dir.join("laravel-toolbar-panel-height.json")
}

/// The saved preferred height, or the default.
#[must_use]
pub fn read_panel_height(path: &Path) -> f32 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse::<f32>().ok())
        .filter(|height| height.is_finite() && *height > 0.0)
        .unwrap_or(DEFAULT_PANEL_HEIGHT)
}

/// Keeps the preferred height; resizing still works when it cannot be written.
pub fn save_panel_height(path: &Path, height: f32) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, height.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::laravel_toolbar::model::parse_duration;

    fn sort(direction: SortDirection) -> TableSort {
        TableSort {
            column: "c".to_owned(),
            direction,
        }
    }

    #[test]
    fn cycles_ascending_descending_original_order_and_starts_new_columns_ascending() {
        let ascending = next_table_sort(None, "duration").expect("ascending");
        assert_eq!(ascending.direction, SortDirection::Ascending);
        let descending = next_table_sort(Some(&ascending), "duration").expect("descending");
        assert_eq!(descending.direction, SortDirection::Descending);
        assert_eq!(next_table_sort(Some(&descending), "duration"), None);
        let other = next_table_sort(Some(&descending), "status").expect("another column");
        assert_eq!(
            (other.column.as_str(), other.direction),
            ("status", SortDirection::Ascending)
        );
    }

    #[test]
    fn sorts_durations_across_units_and_restores_untouched_source_order() {
        let rows = vec!["1.2 s", "9ms", "100ms", "500µs", "2 min"];
        let value = |row: &&str, _: &str| parse_duration(Some(row)).map(SortValue::Number);
        assert_eq!(
            sort_table_rows(&rows, Some(&sort(SortDirection::Ascending)), value),
            ["500µs", "9ms", "100ms", "1.2 s", "2 min"]
        );
        assert_eq!(
            sort_table_rows(&rows, Some(&sort(SortDirection::Descending)), value),
            ["2 min", "1.2 s", "100ms", "9ms", "500µs"]
        );
        assert_eq!(sort_table_rows(&rows, None, value), rows);
    }

    #[test]
    fn keeps_missing_values_last_and_tied_rows_stable_in_either_direction() {
        let rows = vec![(1, None), (2, Some(3.0)), (3, Some(3.0)), (4, Some(9.0))];
        let value = |row: &(i32, Option<f64>), _: &str| row.1.map(SortValue::Number);
        let ids =
            |sorted: Vec<(i32, Option<f64>)>| sorted.into_iter().map(|r| r.0).collect::<Vec<_>>();
        assert_eq!(
            ids(sort_table_rows(
                &rows,
                Some(&sort(SortDirection::Ascending)),
                value
            )),
            [2, 3, 4, 1]
        );
        assert_eq!(
            ids(sort_table_rows(
                &rows,
                Some(&sort(SortDirection::Descending)),
                value
            )),
            [4, 2, 3, 1]
        );
    }

    #[test]
    fn uses_natural_ordering_for_package_versions_and_numeric_names() {
        let rows = vec!["3.10.0", "3.2.0", "3.9.0"];
        let value = |row: &&str, _: &str| Some(SortValue::from(*row));
        assert_eq!(
            sort_table_rows(&rows, Some(&sort(SortDirection::Ascending)), value),
            ["3.2.0", "3.9.0", "3.10.0"]
        );
        let names = vec!["Zed", "alpha", "Beta"];
        assert_eq!(
            sort_table_rows(
                &names,
                Some(&sort(SortDirection::Ascending)),
                |r: &&str, _: &str| Some(SortValue::from(*r))
            ),
            ["alpha", "Beta", "Zed"]
        );
    }

    #[test]
    fn the_flyout_clamps_to_the_space_above_the_bar_and_steps_with_the_keys() {
        let mut resize = PanelResize {
            preferred: DEFAULT_PANEL_HEIGHT,
            available: 660.0,
        };
        assert_eq!(resize.height(), 384.0);
        assert_eq!(resize.drag_to(2000.0), 660.0);
        assert_eq!(resize.drag_to(10.0), 192.0);
        assert_eq!(resize.key("up", false), Some(202.0));
        assert_eq!(
            resize.key("down", true),
            Some(192.0),
            "never under the minimum"
        );
        assert_eq!(resize.key("end", false), Some(660.0));
        assert_eq!(resize.key("home", false), Some(192.0));
        assert_eq!(resize.key("x", false), None);
        // A page too short for the minimum height shrinks the minimum with it.
        let short = PanelResize {
            preferred: 384.0,
            available: 120.0,
        };
        assert_eq!((short.min_height(), short.height()), (120.0, 120.0));
    }

    #[test]
    fn the_preferred_height_is_kept_between_launches_and_bad_values_fall_back() {
        let dir = std::env::temp_dir().join(format!("conn-toolbar-height-{}", std::process::id()));
        let path = panel_height_path(&dir);
        assert_eq!(read_panel_height(&path), DEFAULT_PANEL_HEIGHT);
        save_panel_height(&path, 301.0);
        assert_eq!(read_panel_height(&path), 301.0);
        std::fs::write(&path, "-4").expect("write");
        assert_eq!(read_panel_height(&path), DEFAULT_PANEL_HEIGHT);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
