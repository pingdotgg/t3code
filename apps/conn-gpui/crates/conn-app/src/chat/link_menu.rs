//! The right-click menu of a link in a chat message.
//!
//! Port of web's `externalLinkContextMenu.ts` (items, order, labels) and of the `onContextMenu`
//! of `ChatMarkdown.tsx` (which items show). Conn draws it as a native context menu; GPUI draws
//! the shared menu surface at the pointer, with the same blue row highlight.

use conn_client::Connection;
use conn_contract::{
    OrchestrationV2Command, OrchestrationV2CommandThreadPullRequestLink,
    OrchestrationV2CommandThreadPullRequestUnlink, ThreadPullRequestLinkSource, lit,
};
use conn_theme::Tokens;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, ClipboardItem, Context, InteractiveElement as _, IntoElement as _, KeyDownEvent,
    ParentElement as _, Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, anchored, deferred, div, px,
};

use super::{ChatEvent, ChatView};
use crate::a11y::ConnA11yExt as _;
use crate::panels::linked_items::pr_link::{now_epoch_ms, parse_change_request_url};
use crate::sidebar::thread_menu::{
    MENU_FONT_PX, MENU_LINE_PX, MENU_ROW_HEIGHT_PX, MENU_ROW_RADIUS_PX, MenuHighlight, menu_surface,
};
use crate::theme::hsla;

/// One row of the link menu (`ExternalLinkContextMenuAction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LinkMenuAction {
    LinkToThread,
    UnlinkFromThread,
    OpenInPreview,
    OpenExternal,
    CopyLink,
}

impl LinkMenuAction {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::LinkToThread => "Link to thread",
            Self::UnlinkFromThread => "Unlink from thread",
            Self::OpenInPreview => "Open in integrated browser",
            Self::OpenExternal => "Open in system browser",
            Self::CopyLink => "Copy Link",
        }
    }

    fn ax_id(self) -> &'static str {
        match self {
            Self::LinkToThread => "chat.link-menu.link-to-thread",
            Self::UnlinkFromThread => "chat.link-menu.unlink-from-thread",
            Self::OpenInPreview => "chat.link-menu.open-in-preview",
            Self::OpenExternal => "chat.link-menu.open-external",
            Self::CopyLink => "chat.link-menu.copy-link",
        }
    }
}

/// Whether a pull request link can be tied to, or cut from, the open thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThreadLinkAction {
    Link,
    Unlink,
}

/// A pull request the open thread already links, as the shell row carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LinkedPullRequest {
    /// `host/repository#number`, lower-cased (`threadPullRequestKeyOf`).
    pub(crate) key: String,
    pub(crate) host: String,
    pub(crate) repository: String,
    pub(crate) number: i64,
}

impl LinkedPullRequest {
    /// The thread's own link, keyed as `threadPullRequestKeyOf` does.
    #[must_use]
    pub(crate) fn new(host: &str, repository: &str, number: i64) -> Self {
        Self {
            key: pull_request_key_of(host, repository, number),
            host: host.to_owned(),
            repository: repository.to_owned(),
            number,
        }
    }
}

/// `resolveExternalWebLinkHref`: the link as an absolute `http(s)` URL, or `None` for anything
/// else (a `javascript:` link, a relative path, a `mailto:`). Only these links get the menu.
#[must_use]
pub(crate) fn resolve_external_web_link(href: &str) -> Option<String> {
    let raw = href.trim();
    let candidate = match raw.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => raw.to_owned(),
    };
    let url = url::Url::parse(&candidate).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

/// The thread-link row of the menu (`threadLinkAction` in `ChatMarkdown.tsx`): `Unlink` for a
/// pull request the thread already links, `Link` for any other pull request link while the thread
/// is loaded (`resolveThreadPullRequest`), nothing for a link that is not a pull request.
#[must_use]
pub(crate) fn thread_link_action(
    href: &str,
    thread_loaded: bool,
    linked: &[LinkedPullRequest],
) -> Option<ThreadLinkAction> {
    if !thread_loaded {
        return None;
    }
    let parsed = parse_change_request_url(href)?;
    let key = pull_request_key_of(&parsed.host, &parsed.repository, parsed.number);
    if linked.iter().any(|entry| entry.key == key) {
        Some(ThreadLinkAction::Unlink)
    } else {
        Some(ThreadLinkAction::Link)
    }
}

fn pull_request_key_of(host: &str, repository: &str, number: i64) -> String {
    format!(
        "{}/{}#{number}",
        host.trim().to_ascii_lowercase(),
        repository.trim().to_ascii_lowercase()
    )
}

/// `externalLinkContextMenuItems`: the thread-link row first, then `Open in integrated browser`
/// (only when the browser panel can open the page), `Open in system browser` and `Copy Link`.
#[must_use]
pub(crate) fn link_menu_items(
    can_open_in_preview: bool,
    thread_link: Option<ThreadLinkAction>,
) -> Vec<LinkMenuAction> {
    let mut items = Vec::with_capacity(4);
    match thread_link {
        Some(ThreadLinkAction::Link) => items.push(LinkMenuAction::LinkToThread),
        Some(ThreadLinkAction::Unlink) => items.push(LinkMenuAction::UnlinkFromThread),
        None => {}
    }
    if can_open_in_preview {
        items.push(LinkMenuAction::OpenInPreview);
    }
    items.push(LinkMenuAction::OpenExternal);
    items.push(LinkMenuAction::CopyLink);
    items
}

/// Moves the highlight one row down (`forward`) or up, wrapping at the ends.
#[must_use]
fn step_cursor(cursor: Option<usize>, len: usize, forward: bool) -> Option<usize> {
    if len == 0 {
        return None;
    }
    Some(match (cursor, forward) {
        (None, true) => 0,
        (None, false) => len - 1,
        (Some(i), true) => (i + 1) % len,
        (Some(i), false) => (i + len - 1) % len,
    })
}

/// The open link menu.
pub(super) struct LinkMenu {
    href: String,
    position: Point<Pixels>,
    items: Vec<LinkMenuAction>,
    cursor: Option<usize>,
    /// What had the keyboard when the menu opened; it gets it back when the menu closes.
    return_focus: Option<gpui_kit::FocusHandle>,
}

impl ChatView {
    /// Opens the menu for the link `href` at the window position `position`. A link the menu does
    /// not cover (not `http(s)`) opens nothing.
    pub(super) fn open_link_menu(
        &mut self,
        href: &str,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(href) = resolve_external_web_link(href) else {
            return;
        };
        let thread_loaded =
            self.has_thread && self.thread_id.is_some() && self.connection.is_some();
        let can_open_in_preview = self.has_thread && self.thread_id.is_some();
        let thread_link = thread_link_action(&href, thread_loaded, &self.linked_pull_requests);
        let return_focus = window.focused(cx);
        self.link_menu = Some(LinkMenu {
            href,
            position,
            items: link_menu_items(can_open_in_preview, thread_link),
            cursor: None,
            return_focus,
        });
        self.link_menu_focus_pending = true;
        cx.notify();
    }

    /// Closes the menu and hands the keyboard back.
    pub(super) fn close_link_menu(&mut self, window: &mut Window, cx: &mut Context<'_, Self>) {
        if let Some(menu) = self.link_menu.take() {
            if let Some(handle) = menu.return_focus {
                window.focus(&handle, cx);
            }
            cx.notify();
        }
    }

    fn highlight_link_menu_row(&mut self, index: usize, cx: &mut Context<'_, Self>) {
        if let Some(menu) = &mut self.link_menu
            && menu.cursor != Some(index)
        {
            menu.cursor = Some(index);
            cx.notify();
        }
    }

    fn link_menu_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(menu) = &mut self.link_menu else {
            return;
        };
        match event.keystroke.key.as_str() {
            "down" | "up" => {
                menu.cursor =
                    step_cursor(menu.cursor, menu.items.len(), event.keystroke.key == "down");
                cx.notify();
            }
            "enter" | "space" => {
                if let Some(action) = menu.cursor.and_then(|i| menu.items.get(i)).copied() {
                    self.run_link_menu_action(action, window, cx);
                }
            }
            "escape" | "tab" => self.close_link_menu(window, cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    /// Runs the chosen row on the menu's link and closes the menu.
    pub(super) fn run_link_menu_action(
        &mut self,
        action: LinkMenuAction,
        window: &mut Window,
        cx: &mut Context<'_, Self>,
    ) {
        let Some(href) = self.link_menu.as_ref().map(|menu| menu.href.clone()) else {
            return;
        };
        self.close_link_menu(window, cx);
        match action {
            LinkMenuAction::OpenInPreview => cx.emit(ChatEvent::OpenInBrowser(href)),
            LinkMenuAction::OpenExternal => cx.open_url(&href),
            LinkMenuAction::CopyLink => cx.write_to_clipboard(ClipboardItem::new_string(href)),
            LinkMenuAction::LinkToThread => self.update_thread_pull_request_link(&href, true, cx),
            LinkMenuAction::UnlinkFromThread => {
                self.update_thread_pull_request_link(&href, false, cx);
            }
        }
    }

    /// `updateThreadPullRequestLink`: the same `thread.pull-request.link` / `.unlink` command the
    /// Linked items panel sends. A refusal shows in the chat's error banner.
    fn update_thread_pull_request_link(
        &mut self,
        href: &str,
        linked: bool,
        cx: &mut Context<'_, Self>,
    ) {
        let (Some(conn), Some(thread_id), Some(parsed)) = (
            self.connection.clone(),
            self.thread_id.clone(),
            parse_change_request_url(href),
        ) else {
            return;
        };
        self.link_command_seq = self.link_command_seq.wrapping_add(1);
        let command_id = format!(
            "chat-link-menu-{}-{}-{}",
            if linked { "link" } else { "unlink" },
            now_epoch_ms(),
            self.link_command_seq
        );
        let command = if linked {
            OrchestrationV2Command::ThreadPullRequestLink(
                OrchestrationV2CommandThreadPullRequestLink {
                    r#type: lit::ThreadPullRequestLink,
                    command_id,
                    thread_id,
                    host: parsed.host,
                    repository: parsed.repository,
                    number: parsed.number,
                    url: parsed.url,
                    source: ThreadPullRequestLinkSource::Manual,
                    repository_web_url: None,
                },
            )
        } else {
            // The thread's own link carries the host and repository as they were linked.
            let key = pull_request_key_of(&parsed.host, &parsed.repository, parsed.number);
            let (host, repository) = self
                .linked_pull_requests
                .iter()
                .find(|entry| entry.key == key)
                .map_or((parsed.host, parsed.repository), |entry| {
                    (entry.host.clone(), entry.repository.clone())
                });
            OrchestrationV2Command::ThreadPullRequestUnlink(
                OrchestrationV2CommandThreadPullRequestUnlink {
                    r#type: lit::ThreadPullRequestUnlink,
                    command_id,
                    thread_id,
                    host,
                    repository,
                    number: parsed.number,
                },
            )
        };
        cx.spawn(async move |this, cx| {
            let result = run_command(conn, command).await;
            let _ = this.update(cx, |view, cx| {
                if let Err(message) = result {
                    view.error_banner = Some(format!(
                        "Unable to {} pull request: {message}",
                        if linked { "link" } else { "unlink" }
                    ));
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Replaces the pull requests the open thread links (from its shell row).
    pub(crate) fn set_linked_pull_requests(
        &mut self,
        linked: Vec<LinkedPullRequest>,
        cx: &mut Context<'_, Self>,
    ) {
        if self.linked_pull_requests != linked {
            self.linked_pull_requests = linked;
            cx.notify();
        }
    }

    /// The menu, anchored at its pointer position above everything else.
    pub(super) fn render_link_menu(
        &mut self,
        window: &mut Window,
        tokens: &Tokens,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let menu = self.link_menu.as_ref()?;
        if self.link_menu_focus_pending {
            self.link_menu_focus_pending = false;
            window.focus(&self.link_menu_focus, cx);
        }
        let highlight = MenuHighlight::new(tokens);
        let fg = hsla(tokens.popover_foreground);
        let mut list = menu_surface(SharedString::from("chat-link-menu"), tokens)
            .a11y(gpui_kit::Role::Menu, "chat.link-menu", "Link menu")
            .track_focus(&self.link_menu_focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                this.link_menu_key(event, window, cx);
            }))
            .on_mouse_down_out(cx.listener(|this, _, window, cx| this.close_link_menu(window, cx)));
        for (index, action) in menu.items.iter().copied().enumerate() {
            let highlighted = menu.cursor == Some(index);
            list = list.child(
                div()
                    .id(SharedString::from(format!("chat-link-menu-{index}")))
                    .a11y(gpui_kit::Role::MenuItem, action.ax_id(), action.label())
                    .aria_selected(highlighted)
                    .flex()
                    .items_center()
                    .w_full()
                    .min_h(px(MENU_ROW_HEIGHT_PX))
                    .px(px(8.0))
                    .py(px(4.0))
                    .rounded(px(MENU_ROW_RADIUS_PX))
                    .text_size(px(MENU_FONT_PX))
                    .line_height(px(MENU_LINE_PX))
                    .text_color(if highlighted { highlight.fg } else { fg })
                    .when(highlighted, |row| row.bg(highlight.bg))
                    .cursor_pointer()
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered {
                            this.highlight_link_menu_row(index, cx);
                        }
                    }))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.run_link_menu_action(action, window, cx);
                    }))
                    .child(div().flex_1().min_w_0().truncate().child(action.label())),
            );
        }
        Some(
            deferred(
                anchored()
                    .position(menu.position)
                    .snap_to_window_with_margin(px(8.0))
                    .child(list),
            )
            .with_priority(6)
            .into_any_element(),
        )
    }
}

/// Sends `command` and returns the server's refusal, if any, as text.
async fn run_command(conn: Connection, command: OrchestrationV2Command) -> Result<(), String> {
    conn.dispatch_command(command)
        .await
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linked(host: &str, repository: &str, number: i64) -> LinkedPullRequest {
        LinkedPullRequest::new(host, repository, number)
    }

    const PR: &str = "https://github.com/hardimpactdev/orbit/pull/4195";

    #[test]
    fn a_pull_request_link_offers_link_to_thread_first() {
        let thread_link = thread_link_action(PR, true, &[]);
        assert_eq!(thread_link, Some(ThreadLinkAction::Link));
        let labels: Vec<&str> = link_menu_items(true, thread_link)
            .into_iter()
            .map(LinkMenuAction::label)
            .collect();
        assert_eq!(
            labels,
            vec![
                "Link to thread",
                "Open in integrated browser",
                "Open in system browser",
                "Copy Link",
            ]
        );
    }

    #[test]
    fn a_linked_pull_request_offers_unlink_whatever_the_case_or_sub_page() {
        let entries = [linked("github.com", "HardImpactDev/Orbit", 4195)];
        assert_eq!(
            thread_link_action(PR, true, &entries),
            Some(ThreadLinkAction::Unlink)
        );
        assert_eq!(
            thread_link_action(&format!("{PR}/files?x=1"), true, &entries),
            Some(ThreadLinkAction::Unlink),
            "a sub-page of the pull request is still that pull request"
        );
        assert_eq!(
            thread_link_action(
                "https://github.com/hardimpactdev/orbit/pull/4196",
                true,
                &entries
            ),
            Some(ThreadLinkAction::Link)
        );
    }

    #[test]
    fn a_plain_link_has_no_thread_row() {
        assert_eq!(
            thread_link_action("https://example.com/docs", true, &[]),
            None
        );
        assert_eq!(
            link_menu_items(true, None),
            vec![
                LinkMenuAction::OpenInPreview,
                LinkMenuAction::OpenExternal,
                LinkMenuAction::CopyLink
            ]
        );
    }

    #[test]
    fn no_loaded_thread_means_no_thread_row() {
        assert_eq!(thread_link_action(PR, false, &[]), None);
    }

    #[test]
    fn the_integrated_browser_row_needs_the_browser_panel() {
        assert_eq!(
            link_menu_items(false, Some(ThreadLinkAction::Unlink)),
            vec![
                LinkMenuAction::UnlinkFromThread,
                LinkMenuAction::OpenExternal,
                LinkMenuAction::CopyLink
            ]
        );
    }

    #[test]
    fn only_web_links_get_the_menu() {
        assert_eq!(
            resolve_external_web_link("https://example.com/docs?topic=a#b").as_deref(),
            Some("https://example.com/docs?topic=a#b")
        );
        assert_eq!(
            resolve_external_web_link("HTTP://EXAMPLE.COM").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(
            resolve_external_web_link("//example.com/path").as_deref(),
            Some("https://example.com/path")
        );
        for rejected in [
            "javascript:alert(document.domain)",
            " \nJaVaScRiPt:alert(document.domain)",
            "data:text/html,<script>alert(1)</script>",
            "file:///tmp/example.txt",
            "mailto:hello@example.com",
            "/relative/path",
            "not a URL",
            "",
        ] {
            assert_eq!(resolve_external_web_link(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn the_keyboard_highlight_wraps_at_both_ends() {
        assert_eq!(step_cursor(None, 4, true), Some(0));
        assert_eq!(step_cursor(None, 4, false), Some(3));
        assert_eq!(step_cursor(Some(3), 4, true), Some(0));
        assert_eq!(step_cursor(Some(0), 4, false), Some(3));
        assert_eq!(step_cursor(Some(1), 4, true), Some(2));
        assert_eq!(step_cursor(None, 0, true), None);
    }
}
