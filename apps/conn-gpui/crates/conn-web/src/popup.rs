//! Which page requests become Conn browser tabs (Conn's `previewWindowOpenAction`). A link with
//! `target=_blank`, or one opened with Cmd or the middle button, asks for a new tab; Conn opens
//! it as a peer browser tab. The view is windowless, so it cannot show a popup window.
//!
//! CEF asks in two places. `OnBeforePopup` covers `target=_blank` and `window.open`; it is
//! always suppressed, and a tab opens only for a user gesture, so a script cannot open tabs on
//! its own. `OnOpenURLFromTab` covers Cmd-click and middle-click on ordinary links; a tab
//! request there is consumed so the page does not also navigate.

/// How the page asked to open the URL (the parts of CEF's `WindowOpenDisposition` that matter).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Disposition {
    ForegroundTab,
    BackgroundTab,
    Other,
}

/// A page's request for a new browser tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewTabRequest {
    pub url: String,
    /// Opened behind the current tab (Cmd-click, middle click).
    pub background: bool,
}

/// What to do with a request CEF hands over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Decision {
    /// The tab to open, if any.
    pub(crate) tab: Option<NewTabRequest>,
    /// Stop CEF's own handling (the popup, or the navigation).
    pub(crate) cancel: bool,
}

fn is_web_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The tab a request asks for: a tab disposition, an `http(s)` URL (`POPUP_PROTOCOLS`) and a
/// user gesture.
fn new_tab_for(disposition: Disposition, url: &str, user_gesture: bool) -> Option<NewTabRequest> {
    let background = match disposition {
        Disposition::ForegroundTab => false,
        Disposition::BackgroundTab => true,
        Disposition::Other => return None,
    };
    (user_gesture && is_web_url(url)).then(|| NewTabRequest {
        url: url.trim().to_owned(),
        background,
    })
}

/// `OnBeforePopup`: every popup is suppressed; a tab opens as [`new_tab_for`] allows.
pub(crate) fn before_popup(disposition: Disposition, url: &str, user_gesture: bool) -> Decision {
    Decision {
        tab: new_tab_for(disposition, url, user_gesture),
        cancel: true,
    }
}

/// `OnOpenURLFromTab`: a tab request for an `http(s)` URL is Conn's, so CEF's handling stops
/// (with or without a gesture); anything else goes on as CEF would.
pub(crate) fn open_url_from_tab(
    disposition: Disposition,
    url: &str,
    user_gesture: bool,
) -> Decision {
    let tab_request = disposition != Disposition::Other && is_web_url(url);
    Decision {
        tab: new_tab_for(disposition, url, user_gesture),
        cancel: tab_request,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(url: &str, background: bool) -> Option<NewTabRequest> {
        Some(NewTabRequest {
            url: url.into(),
            background,
        })
    }

    #[test]
    fn target_blank_links_with_a_gesture_open_tabs() {
        assert_eq!(
            before_popup(Disposition::ForegroundTab, "https://a.dev/x", true),
            Decision {
                tab: tab("https://a.dev/x", false),
                cancel: true
            }
        );
        assert_eq!(
            before_popup(Disposition::BackgroundTab, "HTTP://localhost:3000", true).tab,
            tab("HTTP://localhost:3000", true)
        );
    }

    #[test]
    fn scripted_window_open_without_a_gesture_is_suppressed() {
        // `window.open(url, "_blank")` from a timer or load handler.
        assert_eq!(
            before_popup(Disposition::ForegroundTab, "https://a.dev", false),
            Decision {
                tab: None,
                cancel: true
            }
        );
        // The same call from a click opens a tab.
        assert_eq!(
            before_popup(Disposition::ForegroundTab, "https://a.dev", true).tab,
            tab("https://a.dev", false)
        );
    }

    #[test]
    fn popups_and_other_schemes_stay_suppressed() {
        for (disposition, url) in [
            (Disposition::Other, "https://a.dev"),
            (Disposition::ForegroundTab, "about:blank"),
            (Disposition::ForegroundTab, "javascript:alert(1)"),
        ] {
            assert_eq!(
                before_popup(disposition, url, true),
                Decision {
                    tab: None,
                    cancel: true
                }
            );
        }
    }

    #[test]
    fn modified_clicks_on_ordinary_links_open_tabs_and_stop_the_navigation() {
        // Cmd-click: background tab; Cmd-Shift-click: foreground tab.
        assert_eq!(
            open_url_from_tab(Disposition::BackgroundTab, "https://a.dev/b", true),
            Decision {
                tab: tab("https://a.dev/b", true),
                cancel: true
            }
        );
        assert_eq!(
            open_url_from_tab(Disposition::ForegroundTab, "https://a.dev/f", true),
            Decision {
                tab: tab("https://a.dev/f", false),
                cancel: true
            }
        );
        // Without a gesture no tab opens, and the page does not navigate either.
        assert_eq!(
            open_url_from_tab(Disposition::ForegroundTab, "https://a.dev", false),
            Decision {
                tab: None,
                cancel: true
            }
        );
    }

    #[test]
    fn other_open_url_requests_go_on_as_cef_would() {
        for (disposition, url) in [
            (Disposition::Other, "https://a.dev"),
            (Disposition::BackgroundTab, "mailto:a@b.dev"),
        ] {
            assert_eq!(
                open_url_from_tab(disposition, url, true),
                Decision {
                    tab: None,
                    cancel: false
                }
            );
        }
    }
}
