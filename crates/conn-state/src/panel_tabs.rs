//! The right panel's open tabs, as Conn's `rightPanelStore.ts`: an ordered list of surfaces and
//! the one that shows. Browser tabs are peers in that list (`browser:<tabId>`), so any number
//! of them can be open; every other kind opens once.

use std::collections::HashMap;

use crate::layout::{BrowserTabId, PanelSurface, RightPanelTab};

/// The right panel's open tabs and the active one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RightPanelTabs {
    tabs: Vec<PanelSurface>,
    active: Option<PanelSurface>,
    /// Browser tabs by when they last showed, oldest first. The newest still open is the one
    /// the Browser toggle and automation come back to (`activeTabId`, `latestSnapshot`).
    browser_recency: Vec<BrowserTabId>,
    next_browser: BrowserTabId,
}

/// What [`RightPanelTabs::close`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedTab {
    /// The tab that shows now, if the closed one was active and another is left.
    pub activated: Option<PanelSurface>,
    /// No tab is left, so the panel closes (`isOpen: surfaces.length > 0`).
    pub was_last: bool,
}

impl RightPanelTabs {
    /// The open tabs, in strip order.
    #[must_use]
    pub fn tabs(&self) -> &[PanelSurface] {
        &self.tabs
    }

    /// The tab that shows, if any is open.
    #[must_use]
    pub fn active(&self) -> Option<&PanelSurface> {
        self.active.as_ref()
    }

    /// The browser tab the panel shows now or showed most recently, of those still open; a
    /// tab never shown (a background link) comes after those, in strip order.
    #[must_use]
    pub fn last_browser(&self) -> Option<BrowserTabId> {
        self.browser_recency
            .iter()
            .rev()
            .copied()
            .find(|id| self.tabs.contains(&PanelSurface::Browser(*id)))
            .or_else(|| self.browser_ids().next())
    }

    /// The ids of the open browser tabs, in strip order.
    pub fn browser_ids(&self) -> impl Iterator<Item = BrowserTabId> + '_ {
        self.tabs.iter().filter_map(|tab| match tab {
            PanelSurface::Browser(id) => Some(*id),
            _ => None,
        })
    }

    /// Shows `surface`, appending it when it is not open yet (`upsertSurface`).
    pub fn activate(&mut self, surface: PanelSurface) {
        if let PanelSurface::Browser(id) = surface {
            self.browser_recency.retain(|shown| *shown != id);
            self.browser_recency.push(id);
        }
        if !self.tabs.contains(&surface) {
            self.tabs.push(surface.clone());
        }
        self.active = Some(surface);
    }

    /// Appends a new, empty browser tab and shows it (`addBrowserSurface`).
    pub fn new_browser(&mut self) -> BrowserTabId {
        let id = self.allocate_browser();
        self.activate(PanelSurface::Browser(id));
        id
    }

    /// Appends a new browser tab behind the active one, as a page's background-tab link does
    /// (`openUrlInPreview` with `background`).
    pub fn new_background_browser(&mut self) -> BrowserTabId {
        let id = self.allocate_browser();
        self.tabs.push(PanelSurface::Browser(id));
        if self.active.is_none() {
            self.activate(PanelSurface::Browser(id));
        }
        id
    }

    /// The add menu's choice: Browser always adds a new tab (`createBrowserSurface`); other
    /// kinds show their one tab.
    pub fn add(&mut self, tab: RightPanelTab) -> PanelSurface {
        if tab == RightPanelTab::Browser {
            PanelSurface::Browser(self.new_browser())
        } else {
            self.open(tab)
        }
    }

    /// Shows the surface of kind `tab`. For Browser that is the tab shown last, else the first
    /// open one, else a new tab (`togglePreviewPanel`, `open(ref, "preview")`).
    pub fn open(&mut self, tab: RightPanelTab) -> PanelSurface {
        let surface = if tab == RightPanelTab::Browser {
            match self.last_browser() {
                Some(id) => PanelSurface::Browser(id),
                None => PanelSurface::Browser(self.allocate_browser()),
            }
        } else {
            PanelSurface::Kind(tab)
        };
        self.activate(surface.clone());
        surface
    }

    /// Closes `surface` (`closeSurface`): the tab now at its place shows, else the last one.
    /// `None` when it was not open.
    pub fn close(&mut self, surface: &PanelSurface) -> Option<ClosedTab> {
        let index = self.tabs.iter().position(|tab| tab == surface)?;
        self.tabs.remove(index);
        if let PanelSurface::Browser(id) = surface {
            self.browser_recency.retain(|shown| shown != id);
        }
        let mut activated = None;
        if self.active.as_ref() == Some(surface) {
            let fallback = self
                .tabs
                .get(index.min(self.tabs.len().saturating_sub(1)))
                .cloned();
            self.active = None;
            if let Some(next) = fallback {
                self.activate(next.clone());
                activated = Some(next);
            }
        }
        Some(ClosedTab {
            activated,
            was_last: self.tabs.is_empty(),
        })
    }

    fn allocate_browser(&mut self) -> BrowserTabId {
        self.next_browser += 1;
        self.next_browser
    }
}

/// One thread's right panel: its tabs and whether it shows (`ThreadRightPanelState` and
/// `ThreadPanelVisibility.inlineOpen`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThreadPanel {
    pub tabs: RightPanelTabs,
    pub open: bool,
}

/// Every thread's right panel, as `rightPanelStore.byThreadKey`. The shown thread's panel lives
/// with the caller; the others wait here. Browser tab ids are unique across threads, so one
/// browser per id can stay alive, page state and all, while its thread is not shown.
#[derive(Clone, Debug, Default)]
pub struct ThreadPanels {
    owner: Option<String>,
    parked: HashMap<String, ThreadPanel>,
    next_browser: BrowserTabId,
}

impl ThreadPanels {
    /// The thread whose panel the caller holds.
    #[must_use]
    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    /// Makes `owner` the shown thread: parks `current` for the old owner and puts the new
    /// owner's panel in its place. `false` when `owner` already shows.
    pub fn switch(&mut self, owner: Option<String>, current: &mut ThreadPanel) -> bool {
        if self.owner == owner {
            return false;
        }
        let next = owner
            .as_ref()
            .and_then(|key| self.parked.remove(key))
            .unwrap_or_default();
        let old = std::mem::replace(current, next);
        self.next_browser = self.next_browser.max(old.tabs.next_browser);
        if let Some(key) = self.owner.take()
            && (old.open || !old.tabs.tabs().is_empty())
        {
            self.parked.insert(key, old);
        }
        current.tabs.next_browser = self.next_browser;
        self.owner = owner;
        true
    }

    /// Opens a tab of kind `tab` on a thread that is not shown, so it is there when the thread
    /// shows (`preparePanel`). `shown` is the shown thread's tabs, which share the id range.
    pub fn prepare(&mut self, owner: &str, tab: RightPanelTab, shown: &mut RightPanelTabs) {
        debug_assert_ne!(
            self.owner.as_deref(),
            Some(owner),
            "the caller opens tabs on the shown thread itself"
        );
        let panel = self.parked.entry(owner.to_owned()).or_default();
        panel.tabs.next_browser = self.next_browser.max(shown.next_browser);
        panel.tabs.open(tab);
        panel.open = true;
        self.next_browser = panel.tabs.next_browser;
        shown.next_browser = self.next_browser;
    }

    /// A draft became thread `new`: its panel goes with it.
    pub fn rename(&mut self, old: &str, new: String) {
        if self.owner.as_deref() == Some(old) {
            self.owner = Some(new);
        } else if let Some(panel) = self.parked.remove(old) {
            self.parked.insert(new, panel);
        }
    }

    /// Drops a deleted thread's or expired draft's parked panel and returns its browser tabs,
    /// whose browsers the caller closes.
    pub fn forget(&mut self, owner: &str) -> Vec<BrowserTabId> {
        self.parked
            .remove(owner)
            .map(|panel| panel.tabs.browser_ids().collect())
            .unwrap_or_default()
    }
}

/// A browser tab's title (`surfaceTitle`): the page title, else the page's host, else Browser.
/// Chromium reports the URL as the title of a page without one; that counts as none.
#[must_use]
pub fn browser_tab_title(title: &str, url: &str) -> String {
    let title = title.trim();
    if !title.is_empty() && title != url.trim() {
        return title.to_owned();
    }
    url_host(url).map_or_else(|| "Browser".to_owned(), str::to_owned)
}

/// The host of an absolute URL with an authority, such as `localhost:3000`.
fn url_host(url: &str) -> Option<&str> {
    let (_, rest) = url.trim().split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?;
    (!host.is_empty()).then_some(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILES: PanelSurface = PanelSurface::Kind(RightPanelTab::Files);

    #[test]
    fn adding_browser_twice_opens_two_tabs() {
        let mut tabs = RightPanelTabs::default();
        let first = tabs.add(RightPanelTab::Browser);
        let second = tabs.add(RightPanelTab::Browser);
        assert_ne!(first, second);
        assert_eq!(tabs.tabs(), [first, second.clone()]);
        assert_eq!(tabs.active(), Some(&second));
        assert_eq!(tabs.browser_ids().count(), 2);
    }

    #[test]
    fn other_kinds_open_once() {
        let mut tabs = RightPanelTabs::default();
        tabs.add(RightPanelTab::Files);
        tabs.add(RightPanelTab::Files);
        assert_eq!(tabs.tabs(), [FILES]);
    }

    #[test]
    fn opening_browser_brings_back_the_last_shown_tab() {
        let mut tabs = RightPanelTabs::default();
        // No browser tab yet: the toggle makes one.
        let first = tabs.open(RightPanelTab::Browser);
        let second = tabs.add(RightPanelTab::Browser);
        tabs.activate(first.clone());
        tabs.open(RightPanelTab::Files);
        assert_eq!(tabs.open(RightPanelTab::Browser), first);
        assert_eq!(tabs.tabs().len(), 3);
        // The last-shown tab closed: the first open browser tab shows.
        tabs.close(&first);
        assert_eq!(tabs.open(RightPanelTab::Browser), second);
    }

    #[test]
    fn closing_the_last_shown_browser_falls_back_to_the_most_recent_one() {
        let mut tabs = RightPanelTabs::default();
        let a = tabs.add(RightPanelTab::Browser);
        let b = tabs.add(RightPanelTab::Browser);
        let c = tabs.add(RightPanelTab::Browser);
        // Shown in the order a, c, b; then Files covers them.
        for surface in [&a, &c, &b] {
            tabs.activate(surface.clone());
        }
        tabs.open(RightPanelTab::Files);
        tabs.close(&b);
        // `c` showed after `a`, so it comes back, not `a`, the first in the strip.
        assert_eq!(
            tabs.last_browser().map(PanelSurface::Browser),
            Some(c.clone())
        );
        assert_eq!(tabs.open(RightPanelTab::Browser), c);
    }

    #[test]
    fn a_background_tab_leaves_the_active_tab() {
        let mut tabs = RightPanelTabs::default();
        let page = tabs.add(RightPanelTab::Browser);
        let id = tabs.new_background_browser();
        assert_eq!(tabs.active(), Some(&page));
        assert_eq!(tabs.tabs().last(), Some(&PanelSurface::Browser(id)));
        // With nothing open, it shows.
        let mut empty = RightPanelTabs::default();
        let id = empty.new_background_browser();
        assert_eq!(empty.active(), Some(&PanelSurface::Browser(id)));
    }

    #[test]
    fn closing_the_active_tab_shows_the_one_at_its_place() {
        let mut tabs = RightPanelTabs::default();
        let a = tabs.add(RightPanelTab::Browser);
        let b = tabs.add(RightPanelTab::Browser);
        let c = tabs.add(RightPanelTab::Browser);
        tabs.activate(b.clone());
        let closed = tabs.close(&b);
        assert_eq!(
            closed,
            Some(ClosedTab {
                activated: Some(c.clone()),
                was_last: false
            })
        );
        // The last tab: the one before it shows.
        assert_eq!(tabs.close(&c).and_then(|c| c.activated), Some(a.clone()));
        // An inactive tab: the active one stays.
        tabs.add(RightPanelTab::Files);
        assert_eq!(tabs.close(&a).and_then(|c| c.activated), None);
        assert_eq!(tabs.active(), Some(&FILES));
        assert_eq!(
            tabs.close(&FILES),
            Some(ClosedTab {
                activated: None,
                was_last: true
            })
        );
        assert_eq!(tabs.active(), None);
        assert_eq!(tabs.close(&FILES), None);
    }

    #[test]
    fn browser_ids_are_never_reused() {
        let mut tabs = RightPanelTabs::default();
        let first = tabs.add(RightPanelTab::Browser);
        tabs.close(&first);
        assert_ne!(tabs.add(RightPanelTab::Browser), first);
    }

    #[test]
    fn each_thread_keeps_its_own_tabs_and_browser_ids_stay_unique() {
        let mut panels = ThreadPanels::default();
        let mut shown = ThreadPanel::default();
        assert!(panels.switch(Some("env:a".into()), &mut shown));
        let a1 = shown.tabs.add(RightPanelTab::Browser);
        let a2 = shown.tabs.add(RightPanelTab::Browser);
        shown.open = true;
        let a = shown.clone();
        // An agent opens a tab on a thread the user is not looking at.
        panels.prepare("env:c", RightPanelTab::Browser, &mut shown.tabs);

        assert!(panels.switch(Some("env:b".into()), &mut shown));
        assert!(
            shown.tabs.tabs().is_empty() && !shown.open,
            "a new thread starts closed and empty"
        );
        let b1 = shown.tabs.add(RightPanelTab::Browser);
        assert!(
            ![&a1, &a2].contains(&&b1),
            "ids never repeat across threads"
        );

        assert!(panels.switch(Some("env:a".into()), &mut shown));
        assert_eq!((shown.tabs.tabs(), shown.open), (a.tabs.tabs(), a.open));
        assert!(!panels.switch(Some("env:a".into()), &mut shown));

        // The prepared tab waits for its thread to show.
        panels.switch(Some("env:c".into()), &mut shown);
        assert!(shown.open);
        let [c1] = shown.tabs.tabs() else {
            panic!("one prepared tab")
        };
        assert!(![&a1, &a2, &b1].contains(&c1));

        // Deleting a thread hands back its browsers to close.
        let forgotten: Vec<_> = panels
            .forget("env:b")
            .into_iter()
            .map(PanelSurface::Browser)
            .collect();
        assert_eq!(forgotten, [b1]);
        assert!(panels.forget("env:b").is_empty());
    }

    #[test]
    fn a_draft_keeps_its_panel_when_it_becomes_a_thread() {
        let mut panels = ThreadPanels::default();
        let mut shown = ThreadPanel::default();
        panels.switch(Some("env:draft".into()), &mut shown);
        shown.tabs.add(RightPanelTab::Files);
        panels.rename("env:draft", "env:thread".into());
        assert_eq!(panels.owner(), Some("env:thread"));
        assert!(!panels.switch(Some("env:thread".into()), &mut shown));
        assert_eq!(shown.tabs.tabs(), [FILES]);
        // A parked draft moves too.
        panels.switch(Some("env:draft2".into()), &mut shown);
        shown.tabs.add(RightPanelTab::Diff);
        panels.switch(Some("env:thread".into()), &mut shown);
        panels.rename("env:draft2", "env:thread2".into());
        panels.switch(Some("env:thread2".into()), &mut shown);
        assert_eq!(shown.tabs.tabs(), [PanelSurface::Kind(RightPanelTab::Diff)]);
    }

    #[test]
    fn browser_tabs_title_by_page_then_host() {
        assert_eq!(browser_tab_title(" Docs ", "https://a.dev/x"), "Docs");
        assert_eq!(
            browser_tab_title("", "http://user@localhost:3000/a?b"),
            "localhost:3000"
        );
        assert_eq!(browser_tab_title("", "about:blank"), "Browser");
        assert_eq!(browser_tab_title("about:blank", "about:blank"), "Browser");
        assert_eq!(
            browser_tab_title("localhost:3000/a", "http://localhost:3000/a"),
            "localhost:3000/a"
        );
        assert_eq!(browser_tab_title("", ""), "Browser");
    }
}
