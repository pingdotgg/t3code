//! Which items Conn adds to Chromium's right-click menu for the clicked element.
//!
//! CEF's Alloy menu has Back, Forward, Reload and the edit items, but nothing for links or
//! images. Conn adds those in Chrome's grouping and order (link items, image items, then
//! Chromium's own), and ends the menu with "Inspect". The choice lives here, free of CEF
//! types, so it can be tested without a browser.

/// First command id CEF leaves to the embedder (`MENU_ID_USER_FIRST`).
const USER_FIRST: i32 = 26_500;

/// `MENU_ID_PRINT` and `MENU_ID_VIEW_SOURCE`: both open separate windows, so Conn removes them.
pub(crate) const REMOVED_COMMAND_IDS: [i32; 2] = [131, 132];

/// An item Conn adds to the context menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ContextCommand {
    Inspect,
    OpenLink,
    CopyLink,
    CopyEmail,
    OpenImage,
    SaveImage,
    CopyImage,
    CopyImageAddress,
}

impl ContextCommand {
    const ALL: [Self; 8] = [
        Self::Inspect,
        Self::OpenLink,
        Self::CopyLink,
        Self::CopyEmail,
        Self::OpenImage,
        Self::SaveImage,
        Self::CopyImage,
        Self::CopyImageAddress,
    ];

    /// The menu command id (above `MENU_ID_USER_FIRST`).
    pub(crate) fn id(self) -> i32 {
        USER_FIRST
            + Self::ALL
                .iter()
                .position(|c| *c == self)
                .map_or(0, |i| i32::try_from(i).unwrap_or(0))
    }

    /// The command for a menu command id, if it is one of Conn's.
    pub(crate) fn from_id(id: i32) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.id() == id)
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Inspect => "Inspect",
            Self::OpenLink => "Open link in system browser",
            Self::CopyLink => "Copy link address",
            Self::CopyEmail => "Copy email address",
            Self::OpenImage => "Open image in system browser",
            Self::SaveImage => "Save image as…",
            Self::CopyImage => "Copy image",
            Self::CopyImageAddress => "Copy image address",
        }
    }
}

/// A row Conn inserts at the top of the menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Entry {
    Item(ContextCommand),
    Separator,
}

/// What the right-click landed on (the parts of `ContextMenuParams` that matter here).
#[derive(Clone, Debug, Default)]
pub(crate) struct MenuParams {
    /// The link's URL after Chromium's filtering (empty for `javascript:` and the like).
    pub(crate) link_url: String,
    /// The link's URL as written, unfiltered.
    pub(crate) unfiltered_link_url: String,
    /// The image's URL, or empty.
    pub(crate) source_url: String,
    /// The click is on an image (or on one with image contents).
    pub(crate) is_image: bool,
}

/// What a clicked link is, for the items it gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LinkTarget {
    /// An `http(s)` link: opens in the system browser and copies as an address.
    Web(String),
    /// A `mailto:` link: copies as an email address only.
    Mail(String),
    /// Any other link (such as `javascript:`): copies as written, never opens.
    Other(String),
}

/// An `http` or `https` URL, the only kind Conn hands to the system.
pub(crate) fn is_web_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The address in a `mailto:` URL, without its query, or `None` for other URLs.
fn mailto_address(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed.split_once(':')?;
    if !scheme.eq_ignore_ascii_case("mailto") {
        return None;
    }
    let address = rest.split('?').next().unwrap_or_default().trim();
    (!address.is_empty()).then(|| address.to_owned())
}

/// The clicked link, if any.
pub(crate) fn link_target(params: &MenuParams) -> Option<LinkTarget> {
    let url = if params.link_url.is_empty() {
        params.unfiltered_link_url.as_str()
    } else {
        params.link_url.as_str()
    };
    if url.is_empty() {
        return None;
    }
    Some(if is_web_url(url) {
        LinkTarget::Web(url.to_owned())
    } else if let Some(address) = mailto_address(url) {
        LinkTarget::Mail(address)
    } else {
        LinkTarget::Other(url.to_owned())
    })
}

/// The rows to insert at the top of the menu, in Chrome's order: link items, a separator,
/// image items, a separator. Empty when the click is on neither a link nor an image.
pub(crate) fn leading_entries(params: &MenuParams) -> Vec<Entry> {
    let mut entries = Vec::new();

    match link_target(params) {
        Some(LinkTarget::Web(_)) => {
            entries.push(Entry::Item(ContextCommand::OpenLink));
            entries.push(Entry::Item(ContextCommand::CopyLink));
            entries.push(Entry::Separator);
        }
        Some(LinkTarget::Mail(_)) => {
            entries.push(Entry::Item(ContextCommand::CopyEmail));
            entries.push(Entry::Separator);
        }
        Some(LinkTarget::Other(_)) => {
            entries.push(Entry::Item(ContextCommand::CopyLink));
            entries.push(Entry::Separator);
        }
        None => {}
    }

    if params.is_image && !params.source_url.is_empty() {
        if is_web_url(&params.source_url) {
            entries.push(Entry::Item(ContextCommand::OpenImage));
        }
        entries.push(Entry::Item(ContextCommand::SaveImage));
        entries.push(Entry::Item(ContextCommand::CopyImage));
        entries.push(Entry::Item(ContextCommand::CopyImageAddress));
        entries.push(Entry::Separator);
    }

    entries
}

/// Indices (highest first) of separators to remove so the menu has none at its start or end
/// and never two in a row. `is_separator[i]` says whether row `i` is a separator.
pub(crate) fn separators_to_remove(is_separator: &[bool]) -> Vec<usize> {
    let mut remove = Vec::new();
    let mut previous_kept_is_separator = true; // a separator at the start is dropped
    for (index, &separator) in is_separator.iter().enumerate() {
        if separator {
            if previous_kept_is_separator {
                remove.push(index);
            } else {
                previous_kept_is_separator = true;
            }
        } else {
            previous_kept_is_separator = false;
        }
    }
    // A separator left last is dropped too.
    let mut last_kept = None;
    for (index, &separator) in is_separator.iter().enumerate() {
        if !remove.contains(&index) {
            last_kept = Some((index, separator));
        }
    }
    if let Some((index, true)) = last_kept {
        remove.push(index);
    }
    remove.sort_unstable_by(|a, b| b.cmp(a));
    remove
}

#[cfg(test)]
mod tests {
    use super::*;
    use ContextCommand::*;
    use Entry::{Item, Separator};

    fn params(link: &str, image: &str) -> MenuParams {
        MenuParams {
            link_url: link.to_owned(),
            unfiltered_link_url: link.to_owned(),
            source_url: image.to_owned(),
            is_image: !image.is_empty(),
        }
    }

    #[test]
    fn plain_page_adds_nothing_before_chromiums_items() {
        assert_eq!(leading_entries(&MenuParams::default()), vec![]);
    }

    #[test]
    fn web_link_gets_open_and_copy() {
        assert_eq!(
            leading_entries(&params("https://example.com/a", "")),
            vec![Item(OpenLink), Item(CopyLink), Separator]
        );
    }

    #[test]
    fn mailto_link_copies_only_the_address() {
        let p = params("mailto:nick@example.com?subject=Hi", "");
        assert_eq!(
            link_target(&p),
            Some(LinkTarget::Mail("nick@example.com".to_owned()))
        );
        assert_eq!(leading_entries(&p), vec![Item(CopyEmail), Separator]);
    }

    #[test]
    fn script_link_never_opens() {
        let p = MenuParams {
            unfiltered_link_url: "javascript:void(0)".to_owned(),
            ..MenuParams::default()
        };
        assert_eq!(leading_entries(&p), vec![Item(CopyLink), Separator]);
    }

    #[test]
    fn web_image_gets_all_four_items() {
        assert_eq!(
            leading_entries(&params("", "https://example.com/a.png")),
            vec![
                Item(OpenImage),
                Item(SaveImage),
                Item(CopyImage),
                Item(CopyImageAddress),
                Separator
            ]
        );
    }

    #[test]
    fn data_url_image_cannot_open_externally() {
        assert_eq!(
            leading_entries(&params("", "data:image/png;base64,AAAA")),
            vec![
                Item(SaveImage),
                Item(CopyImage),
                Item(CopyImageAddress),
                Separator
            ]
        );
    }

    #[test]
    fn image_without_a_source_gets_no_image_items() {
        let p = MenuParams {
            is_image: true,
            ..MenuParams::default()
        };
        assert_eq!(leading_entries(&p), vec![]);
    }

    #[test]
    fn image_inside_a_link_gets_link_group_then_image_group() {
        assert_eq!(
            leading_entries(&params("https://example.com", "https://example.com/a.png")),
            vec![
                Item(OpenLink),
                Item(CopyLink),
                Separator,
                Item(OpenImage),
                Item(SaveImage),
                Item(CopyImage),
                Item(CopyImageAddress),
                Separator
            ]
        );
    }

    #[test]
    fn only_web_urls_are_handed_to_the_system() {
        assert!(is_web_url("HTTP://example.com"));
        assert!(is_web_url("https://example.com"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("javascript:alert(1)"));
        assert!(!is_web_url("data:text/html,hi"));
    }

    #[test]
    fn command_ids_are_distinct_user_ids_that_round_trip() {
        let mut seen = std::collections::HashSet::new();
        for command in ContextCommand::ALL {
            let id = command.id();
            assert!((USER_FIRST..USER_FIRST + 100).contains(&id));
            assert!(seen.insert(id), "duplicate id for {command:?}");
            assert_eq!(ContextCommand::from_id(id), Some(command));
        }
        assert_eq!(ContextCommand::from_id(113), None);
        assert_eq!(Inspect.id(), USER_FIRST);
    }

    #[test]
    fn removed_ids_are_print_and_view_source() {
        assert_eq!(REMOVED_COMMAND_IDS, [131, 132]);
    }

    #[test]
    fn separator_cleanup_drops_edges_and_doubles() {
        // [sep, item, sep, sep, item, sep] -> keep item, one sep, item
        assert_eq!(
            separators_to_remove(&[true, false, true, true, false, true]),
            vec![5, 3, 0]
        );
        assert_eq!(
            separators_to_remove(&[false, true, false]),
            Vec::<usize>::new()
        );
        assert_eq!(separators_to_remove(&[]), Vec::<usize>::new());
        assert_eq!(separators_to_remove(&[true, true]), vec![1, 0]);
    }
}
