//! Fractional order keys for the Pinned and Active sections (`pinOrderKey`, `activeOrderKey`),
//! and the sorts and reorder plans that use them (`packages/shared/src/pinOrderKey.ts`,
//! `packages/client-runtime/src/state/threadSort.ts`). Plain data in and out.
//!
//! Keys are lowercase letter strings compared as plain strings; a smaller key sorts higher.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use conn_contract::OrchestrationV2ThreadShell as ThreadShell;

use crate::thread::parse_iso8601_epoch_ms;

const DIGITS: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const BASE: usize = DIGITS.len();

fn is_valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.bytes().all(|b| DIGITS.contains(&b))
        && key.bytes().next_back() != Some(DIGITS[0])
}

/// Index of the first byte of `text` in [`DIGITS`]; 0 for an empty `text`.
fn digit_at(text: &str, empty: usize) -> usize {
    text.bytes()
        .next()
        .map_or(empty, |b| DIGITS.iter().position(|d| *d == b).unwrap_or(0))
}

/// Midpoint of two digit strings read as fractions in (0, 1); "" is the open bound on either
/// side. Needs `a < b` (`b` empty means no upper bound).
fn midpoint(a: &str, b: &str) -> String {
    if !b.is_empty() {
        let mut shared = 0;
        let (a_bytes, b_bytes) = (a.as_bytes(), b.as_bytes());
        while shared < b_bytes.len()
            && a_bytes.get(shared).copied().unwrap_or(DIGITS[0]) == b_bytes[shared]
        {
            shared += 1;
        }
        if shared > 0 {
            let a_rest = a.get(shared..).unwrap_or("");
            return format!("{}{}", &b[..shared], midpoint(a_rest, &b[shared..]));
        }
    }
    let digit_a = digit_at(a, 0);
    let digit_b = digit_at(b, BASE);
    if digit_b - digit_a > 1 {
        // `Math.round` of a half rounds up.
        return char::from(DIGITS[(digit_a + digit_b).div_ceil(2)]).to_string();
    }
    if b.len() > 1 {
        return b[..1].to_owned();
    }
    format!(
        "{}{}",
        char::from(DIGITS[digit_a]),
        midpoint(a.get(1..).unwrap_or(""), "")
    )
}

/// A key that sorts strictly between two neighbours; `None` bounds are the top of the pinned
/// block and the bottom of the keyed run. `None` back when a key is corrupt or the bounds are out
/// of order (`pinOrderKeyBetween`): the caller then rewrites the section.
#[must_use]
pub fn order_key_between(before: Option<&str>, after: Option<&str>) -> Option<String> {
    let (a, b) = (before.unwrap_or(""), after.unwrap_or(""));
    if (!a.is_empty() && !is_valid_key(a)) || (!b.is_empty() && !is_valid_key(b)) {
        return None;
    }
    if !b.is_empty() && a >= b {
        return None;
    }
    Some(midpoint(a, b))
}

/// `count` keys spread evenly over the key space (`generateSpreadPinOrderKeys`).
#[must_use]
pub fn spread_order_keys(count: usize) -> Vec<String> {
    let mut width: usize = 2;
    let mut space = BASE.pow(2) as f64;
    while space <= ((count + 1) * 2) as f64 {
        width += 1;
        space *= BASE as f64;
    }
    let step = space / (count + 1) as f64;
    (0..count)
        .map(|i| {
            let mut value = (step * (i + 1) as f64 + 0.5).floor() as usize;
            if value.is_multiple_of(BASE) {
                value += 1;
            }
            let mut key = vec![b'a'; width];
            for slot in key.iter_mut().rev() {
                *slot = DIGITS[value % BASE];
                value /= BASE;
            }
            String::from_utf8(key).unwrap_or_default()
        })
        .collect()
}

/// One order key to write: `thread.pin.reorder`, `thread.active.reorder` or the `orderKey` of a
/// `thread.pin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderAssignment {
    pub id: String,
    pub order_key: String,
}

/// The order keys to write so `moved_id` holds its place in `ordered_ids` (`planPinnedReorder`).
/// One key between its neighbours when both have a usable key; otherwise the whole section is
/// rewritten with spread keys. `keys_by_id` also holds the keys of rows that are not listed:
/// they are reserved and never written.
#[must_use]
pub fn plan_reorder(
    ordered_ids: &[String],
    keys_by_id: &HashMap<String, Option<String>>,
    moved_id: &str,
) -> Vec<OrderAssignment> {
    let listed: HashSet<&str> = ordered_ids.iter().map(String::as_str).collect();
    let reserved: HashSet<&str> = keys_by_id
        .iter()
        .filter(|(id, _)| !listed.contains(id.as_str()))
        .filter_map(|(_, key)| key.as_deref())
        .collect();
    let Some(moved) = ordered_ids.iter().position(|id| id == moved_id) else {
        return Vec::new();
    };
    let key_of = |index: Option<usize>| {
        index
            .and_then(|i| ordered_ids.get(i))
            .and_then(|id| keys_by_id.get(id))
            .and_then(Option::as_deref)
    };
    let before_index = moved.checked_sub(1);
    let after_index = (moved + 1 < ordered_ids.len()).then_some(moved + 1);
    let (before_key, after_key) = (key_of(before_index), key_of(after_index));
    let usable = (before_index.is_none() || before_key.is_some())
        && (after_index.is_none() || after_key.is_some());
    if usable {
        let mut key = order_key_between(before_key, after_key);
        while let Some(candidate) = &key
            && reserved.contains(candidate.as_str())
        {
            key = order_key_between(Some(candidate), after_key);
        }
        if let Some(key) = key {
            return vec![OrderAssignment {
                id: moved_id.to_owned(),
                order_key: key,
            }];
        }
    }
    let keys = spread_order_keys(ordered_ids.len() + reserved.len())
        .into_iter()
        .filter(|key| !reserved.contains(key.as_str()))
        .take(ordered_ids.len());
    ordered_ids
        .iter()
        .zip(keys)
        .filter(|(id, key)| keys_by_id.get(*id).and_then(Option::as_deref) != Some(key.as_str()))
        .map(|(id, order_key)| OrderAssignment {
            id: id.clone(),
            order_key,
        })
        .collect()
}

/// A key to put a newly pinned thread at the top of the pinned run (`topOfPinnedRunOrderKey`).
#[must_use]
pub fn top_of_pinned_run_key<'a>(
    existing: impl IntoIterator<Item = Option<&'a str>>,
) -> Option<String> {
    let first = existing.into_iter().flatten().min();
    order_key_between(None, first)
}

fn pin_key(thread: &ThreadShell) -> Option<&str> {
    thread.pin_order_key.as_ref().and_then(Option::as_deref)
}

fn active_key(thread: &ThreadShell) -> Option<&str> {
    thread.active_order_key.as_ref().and_then(Option::as_deref)
}

fn millis(iso: &str) -> i64 {
    parse_iso8601_epoch_ms(iso).unwrap_or(0)
}

/// Keyed pinned threads by key, then keyless ones newest first (`sortPinnedThreadsByOrderKey`).
pub fn sort_pinned(threads: &mut [&ThreadShell]) {
    threads.sort_by(|left, right| match (pin_key(left), pin_key(right)) {
        (Some(l), Some(r)) => l.cmp(r).then_with(|| left.id.cmp(&right.id)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => millis(&right.created_at)
            .cmp(&millis(&left.created_at))
            .then_with(|| left.id.cmp(&right.id)),
    });
}

/// The time a keyless active thread sorts by: its creation, or the last time it was un-settled
/// (`activeThreadAnchorTimestampMs`).
fn anchor_millis(thread: &ThreadShell) -> i64 {
    let created = millis(&thread.created_at);
    let unsettled = thread
        .unsettled_at
        .as_ref()
        .and_then(Option::as_deref)
        .map_or(0, millis);
    created.max(unsettled)
}

/// Keyless active threads first, newest anchor first, then keyed ones by key
/// (`sortActiveThreadsByOrderKey`).
pub fn sort_active(threads: &mut [&ThreadShell]) {
    threads.sort_by(|left, right| match (active_key(left), active_key(right)) {
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(l), Some(r)) => l.cmp(r).then_with(|| left.id.cmp(&right.id)),
        (None, None) => anchor_millis(right)
            .cmp(&anchor_millis(left))
            .then_with(|| left.id.cmp(&right.id)),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(pairs: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        pairs
            .iter()
            .map(|(id, key)| ((*id).to_owned(), key.map(str::to_owned)))
            .collect()
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn a_key_between_sorts_strictly_between() {
        assert_eq!(order_key_between(None, None).as_deref(), Some("n"));
        assert_eq!(
            order_key_between(Some("b"), Some("d")).as_deref(),
            Some("c")
        );
        assert_eq!(order_key_between(None, Some("b")).as_deref(), Some("an"));
        let between = order_key_between(Some("m"), Some("n")).unwrap_or_default();
        assert!("m" < between.as_str() && between.as_str() < "n");
        let deep = order_key_between(Some("an"), Some("b")).unwrap_or_default();
        assert!("an" < deep.as_str() && deep.as_str() < "b");
    }

    #[test]
    fn keys_out_of_order_or_corrupt_give_none() {
        assert_eq!(order_key_between(Some("d"), Some("b")), None);
        assert_eq!(order_key_between(Some("b"), Some("b")), None);
        assert_eq!(order_key_between(Some("A"), None), None);
        assert_eq!(order_key_between(Some("ba"), None), None);
    }

    #[test]
    fn spread_keys_are_ordered_valid_and_the_requested_number() {
        for count in [0, 1, 3, 25, 700] {
            let spread = spread_order_keys(count);
            assert_eq!(spread.len(), count);
            assert!(spread.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(spread.iter().all(|key| is_valid_key(key)));
        }
    }

    #[test]
    fn a_move_between_keyed_neighbours_writes_one_key() {
        let plan = plan_reorder(
            &ids(&["a", "b", "c"]),
            &keys(&[("a", Some("b")), ("b", Some("x")), ("c", Some("d"))]),
            "b",
        );
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].id, "b");
        assert!("b" < plan[0].order_key.as_str() && plan[0].order_key.as_str() < "d");
    }

    #[test]
    fn a_keyless_neighbour_rewrites_the_section_and_skips_reserved_keys() {
        let plan = plan_reorder(
            &ids(&["a", "b"]),
            &keys(&[("a", None), ("b", Some("c")), ("hidden", Some("hz"))]),
            "b",
        );
        assert_eq!(plan.len(), 2);
        assert!(plan[0].order_key < plan[1].order_key);
        assert!(plan.iter().all(|a| a.order_key != "hz"));
    }

    #[test]
    fn a_moved_thread_that_is_not_listed_plans_nothing() {
        assert!(plan_reorder(&ids(&["a"]), &keys(&[("a", Some("b"))]), "z").is_empty());
    }

    fn ordered(sorted: &[&ThreadShell]) -> Vec<String> {
        sorted.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn pinned_threads_sort_keyed_first_then_keyless_newest_first() {
        use crate::test_threads::thread;
        use serde_json::json;
        let keyed_late = thread("keyed-late", "p", |t| t["pinOrderKey"] = json!("m"));
        let keyed_early = thread("keyed-early", "p", |t| t["pinOrderKey"] = json!("c"));
        let old = thread("old", "p", |_| {});
        let new = thread("new", "p", |t| {
            t["createdAt"] = json!("2026-11-14T09:00:00.000Z")
        });
        let mut list = vec![&old, &keyed_late, &new, &keyed_early];
        sort_pinned(&mut list);
        assert_eq!(ordered(&list), ["keyed-early", "keyed-late", "new", "old"]);
    }

    #[test]
    fn active_threads_sort_keyless_by_anchor_then_keyed_by_key() {
        use crate::test_threads::thread;
        use serde_json::json;
        let keyed_b = thread("b", "p", |t| t["activeOrderKey"] = json!("b"));
        let keyed_a = thread("a", "p", |t| t["activeOrderKey"] = json!("a"));
        let created = thread("created", "p", |t| {
            t["createdAt"] = json!("2026-11-14T09:00:00.000Z");
        });
        // Un-settling moves the anchor later than the creation.
        let resumed = thread("resumed", "p", |t| {
            t["unsettledAt"] = json!("2026-11-15T09:00:00.000Z")
        });
        let mut list = vec![&keyed_b, &created, &keyed_a, &resumed];
        sort_active(&mut list);
        assert_eq!(ordered(&list), ["resumed", "created", "a", "b"]);
    }

    #[test]
    fn the_top_of_the_run_sorts_before_every_key() {
        let top = top_of_pinned_run_key([Some("c"), None, Some("b")]).unwrap_or_default();
        assert!(top.as_str() < "b");
        assert_eq!(top_of_pinned_run_key([None]).as_deref(), Some("n"));
    }
}
