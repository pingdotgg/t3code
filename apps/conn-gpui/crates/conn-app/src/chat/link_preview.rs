//! The hover preview card of a pull request or issue link in a chat message.
//!
//! Port of `PullRequestLinkPreview.tsx` and `IssueLinkPreview.tsx`, wired in by `ChatMarkdown.tsx`.
//! Web wraps the link in a Base UI `PreviewCard` with `delay={350}` and `closeDelay={120}`. The
//! card opens above the link (`side="top"`, `align="center"`, `sideOffset={6}`, flipping below
//! when it does not fit), stays open while the pointer is on the link or the card, and shows
//! nothing until its data has arrived (no spinner, and on an error no card at all).
//!
//! The data is `pullRequests.preview` (`PullRequestPreview`) for a pull request and
//! `issues.detail` for an issue, read only once the card has opened and kept for 60 seconds
//! (`staleTimeMs: 60_000` of web's `previewCard` atom), so hovering the same link again does not
//! fetch again.
//!
//! The hover rules, the target parsing, the card model and the placement are plain functions and
//! types here, without GPUI, so they carry unit tests. `markdown.rs` reports the pointer
//! ([`LinkHoverEvent`]); [`ChatView`] owns the state and draws the card.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use conn_client::Connection;
use conn_contract::rpc::issues::detail as issue_detail;
use conn_contract::rpc::pull_requests::preview as pull_request_preview;
use conn_contract::{
    IssueActor, IssueDetail, IssueRef, IssueState, IssueStateCategory, PullRequestPreview,
    PullRequestRef, PullRequestState,
};
use conn_theme::{Tokens, color_mix_srgb};
use gpui_kit::{
    Anchor, AnyElement, Context, FontWeight, Hsla, InteractiveElement as _, IntoElement as _,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window,
    anchored, deferred, div, point, px,
};

use super::ChatView;
use crate::a11y::ConnA11yExt as _;
use crate::icons;
use crate::panels::chrome::actor_avatar;
use crate::panels::linked_items::pr_link::{
    format_relative_time, now_epoch_ms, parse_change_request_url,
};
use crate::theme::hsla;

/// `delay={350}` of the `PreviewCardTrigger`.
pub(super) const OPEN_DELAY: Duration = Duration::from_millis(350);
/// `closeDelay={120}` of the `PreviewCardTrigger`.
pub(super) const CLOSE_DELAY: Duration = Duration::from_millis(120);
/// `staleTimeMs: 60_000` of the `previewCard` query.
const STALE_AFTER: Duration = Duration::from_secs(60);

/// `w-80`.
const CARD_WIDTH_PX: f32 = 320.0;
/// `max-w-[calc(100vw-2rem)]`.
const CARD_VIEWPORT_GUTTER_PX: f32 = 32.0;
/// `sideOffset={6}`.
const SIDE_OFFSET_PX: f32 = 6.0;
/// Space kept between the card and the window edge when it flips or snaps.
const COLLISION_PADDING_PX: f32 = 8.0;
/// `rounded-lg`.
const CARD_RADIUS_PX: f32 = 8.0;
/// `p-3`.
const CARD_PADDING_PX: f32 = 12.0;
/// Top padding: a little tighter than the sides (Nick, 2026-11-24).
const CARD_PADDING_TOP_PX: f32 = 10.0;
/// Gap between the repo header and the title.
const HEADER_GAP_PX: f32 = 8.0;
/// Gap between the title and the author row.
const ROW_GAP_PX: f32 = 10.0;
/// `text-2xs` (`0.6875rem`) and its line height.
const REPO_FONT_PX: f32 = 11.0;
const REPO_LINE_PX: f32 = 16.0;
/// `text-sm leading-snug`.
const TITLE_FONT_PX: f32 = 14.0;
const TITLE_LINE_PX: f32 = 19.25;
/// `text-xs`.
const AUTHOR_FONT_PX: f32 = 12.0;
const AUTHOR_LINE_PX: f32 = 16.0;
/// `size-3` state glyph and `size-4` avatar.
const STATE_ICON_PX: f32 = 12.0;
const AVATAR_PX: f32 = 16.0;
/// Characters of a title that fit one line of the card (about 7px each at 14px, medium).
const TITLE_CHARS_PER_LINE: usize = 42;

// ---------------------------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------------------------

/// One read that can fill the card of a link.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PreviewRequest {
    /// `pullRequests.preview`.
    PullRequest {
        host: String,
        repository: String,
        number: i64,
    },
    /// `issues.detail`.
    Issue {
        tracker: &'static str,
        host: String,
        scope: String,
        key: String,
    },
}

/// The reads that can fill the card of `url`, in the order to try them: a pull request link reads
/// the pull request; an issue link reads the issue. GitHub writes every bare reference through
/// `/issues/`, pull requests included, so its issue link falls back to the pull request (web's
/// `onOpenFallback` runs the other way round, for `#123` autolinks).
#[must_use]
pub(super) fn preview_requests(url: &str) -> Vec<PreviewRequest> {
    if let Some(parsed) = parse_change_request_url(url) {
        return vec![PreviewRequest::PullRequest {
            host: parsed.host,
            repository: parsed.repository,
            number: parsed.number,
        }];
    }
    let Some(issue) = parse_issue_url(url) else {
        return Vec::new();
    };
    let mut requests = vec![PreviewRequest::Issue {
        tracker: issue.tracker,
        host: issue.host.clone(),
        scope: issue.scope.clone(),
        key: issue.key.clone(),
    }];
    if issue.tracker == "github"
        && let Ok(number) = issue.key.parse::<i64>()
    {
        requests.push(PreviewRequest::PullRequest {
            host: issue.host,
            repository: issue.original_scope,
            number,
        });
    }
    requests
}

/// Whether `url` can have a preview card.
#[must_use]
pub(super) fn is_previewable(url: &str) -> bool {
    !preview_requests(url).is_empty()
}

struct IssueLink {
    tracker: &'static str,
    host: String,
    /// Lower-cased, as the tracker binding names it (`parseIssuePath`).
    scope: String,
    original_scope: String,
    key: String,
}

/// `GitHub` and `GitLab` issue links (`parseIssueUrl` of both definitions). A host whose name does
/// not say which forge it is would need a project binding to vouch for it, so it stays a link.
fn parse_issue_url(raw: &str) -> Option<IssueLink> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    let number = |segment: Option<&&str>| {
        segment
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
    };
    // `^/([^/]+/[^/]+)/issues/(\d+)(?:/|$)`
    if is_github_host(&host)
        && segments.len() >= 4
        && segments[2] == "issues"
        && let Some(key) = number(segments.get(3))
    {
        let original_scope = format!("{}/{}", segments[0], segments[1]);
        return Some(IssueLink {
            tracker: "github",
            host,
            scope: original_scope.to_ascii_lowercase(),
            original_scope,
            key: key.to_string(),
        });
    }
    // `^/([^/]+(?:/[^/]+)+)/-/(?:issues|work_items)/(\d+)(?:/|$)`
    if host.split('.').any(|part| part == "gitlab")
        && let Some(pos) = segments
            .windows(2)
            .position(|w| w[0] == "-" && matches!(w[1], "issues" | "work_items"))
        && pos >= 2
        && let Some(key) = number(segments.get(pos + 2))
    {
        let original_scope = segments[..pos].join("/");
        return Some(IssueLink {
            tracker: "gitlab",
            host,
            scope: original_scope.to_ascii_lowercase(),
            original_scope,
            key: key.to_string(),
        });
    }
    None
}

/// `isGitHubHost`.
fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".ghe.com") || host.split('.').any(|p| p == "github")
}

// ---------------------------------------------------------------------------------------------
// Card model
// ---------------------------------------------------------------------------------------------

/// The ink of a state chip: green for open, grey for draft, red for closed, violet for merged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum StateTone {
    Open,
    Draft,
    Closed,
    Merged,
}

/// The state chip of the card header: glyph and label in one tone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StateChip {
    pub(super) label: String,
    pub(super) icon: &'static str,
    pub(super) tone: StateTone,
}

/// `resolvePullRequestState`: a draft is an open pull request marked as one.
#[must_use]
pub(super) fn pull_request_chip(state: PullRequestState, is_draft: bool) -> StateChip {
    let (label, icon, tone) = match (state, is_draft) {
        (PullRequestState::Open, true) => (
            "Draft",
            "superhero/pull-request-draft.svg",
            StateTone::Draft,
        ),
        (PullRequestState::Open, false) => ("Open", "superhero/pull-request.svg", StateTone::Open),
        (PullRequestState::Closed, _) => (
            "Closed",
            "superhero/pull-request-closed.svg",
            StateTone::Closed,
        ),
        (PullRequestState::Merged, _) => ("Merged", "superhero/merge.svg", StateTone::Merged),
    };
    StateChip {
        label: label.to_owned(),
        icon,
        tone,
    }
}

/// `issueStatePresentation`: the tracker's own state name is the label. Open borrows the open
/// ink, completed the merged ink, and closed any other way the draft grey.
#[must_use]
pub(super) fn issue_chip(state: &IssueState) -> StateChip {
    let (icon, tone) = match state.category {
        IssueStateCategory::Open => ("superhero/circle-dot.svg", StateTone::Open),
        IssueStateCategory::Closed
            if state
                .close_reason
                .as_deref()
                .is_some_and(|reason| reason != "completed") =>
        {
            // `CircleSlash` is `blocked` in the superheroicons manifest.
            ("superhero/blocked.svg", StateTone::Draft)
        }
        IssueStateCategory::Closed => ("superhero/check-circle.svg", StateTone::Merged),
    };
    StateChip {
        label: state.name.clone(),
        icon,
        tone,
    }
}

/// The author line's name: `ghost` for a deleted account, `Name (@login)` when the name differs
/// from the login, else the login.
#[must_use]
pub(super) fn author_label(author: Option<&IssueActor>) -> String {
    let Some(author) = author else {
        return "ghost".to_owned();
    };
    match author.name.as_deref() {
        Some(name) if !name.is_empty() && name != author.login => {
            format!("{name} (@{})", author.login)
        }
        _ => author.login.clone(),
    }
}

/// `opened 55m ago` (`<RelativeTime>`), or `None` for a timestamp that does not parse.
#[must_use]
pub(super) fn opened_label(created_at: &str, now_ms: i64) -> Option<String> {
    format_relative_time(created_at, now_ms).map(|relative| format!("opened {relative}"))
}

/// What the card shows.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct CardModel {
    /// `owner/repo` of a pull request, the scope of an issue.
    pub(super) scope: String,
    /// `#329`.
    pub(super) number: String,
    pub(super) chip: StateChip,
    pub(super) title: String,
    pub(super) author: Option<IssueActor>,
    pub(super) created_at: String,
}

#[must_use]
pub(super) fn card_from_pull_request(preview: &PullRequestPreview) -> CardModel {
    CardModel {
        scope: preview.repository.clone(),
        number: format!("#{}", preview.number),
        chip: pull_request_chip(preview.state, preview.is_draft),
        title: preview.title.clone(),
        author: preview.author.clone(),
        created_at: preview.created_at.clone(),
    }
}

#[must_use]
pub(super) fn card_from_issue(detail: &IssueDetail) -> CardModel {
    CardModel {
        scope: detail.scope.clone(),
        number: detail.display_key.clone(),
        chip: issue_chip(&detail.state),
        title: detail.title.clone(),
        author: detail.author.clone(),
        created_at: detail.created_at.clone(),
    }
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

/// What one URL has read so far.
#[derive(Debug, Default)]
struct Entry {
    card: Option<CardModel>,
    fetched_at: Option<Instant>,
    in_flight: bool,
}

/// Cards by URL, so hovering a link again does not read again. A card read within the last 60
/// seconds is fresh; an older one still shows while a new read replaces it, as web's query does.
#[derive(Debug, Default)]
pub(super) struct PreviewCache {
    entries: HashMap<String, Entry>,
}

impl PreviewCache {
    /// Whether opening the card of `url` needs a read.
    #[must_use]
    pub(super) fn needs_fetch(&self, url: &str, now: Instant) -> bool {
        match self.entries.get(url) {
            None => true,
            Some(entry) if entry.in_flight => false,
            Some(entry) => entry
                .fetched_at
                .is_none_or(|at| now.saturating_duration_since(at) > STALE_AFTER),
        }
    }

    pub(super) fn begin(&mut self, url: &str) {
        self.entries.entry(url.to_owned()).or_default().in_flight = true;
    }

    /// Stores the read's result. A failed read keeps the older card and is tried again on the
    /// next open.
    pub(super) fn finish(&mut self, url: &str, card: Option<CardModel>, now: Instant) {
        let entry = self.entries.entry(url.to_owned()).or_default();
        entry.in_flight = false;
        if card.is_some() {
            entry.card = card;
            entry.fetched_at = Some(now);
        }
    }

    #[must_use]
    pub(super) fn card(&self, url: &str) -> Option<&CardModel> {
        self.entries.get(url)?.card.as_ref()
    }
}

// ---------------------------------------------------------------------------------------------
// Hover state
// ---------------------------------------------------------------------------------------------

/// A rectangle in window pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Rect {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) w: f32,
    pub(crate) h: f32,
}

impl Rect {
    fn bottom(self) -> f32 {
        self.y + self.h
    }

    fn center_x(self) -> f32 {
        self.x + self.w / 2.0
    }
}

/// What the markdown paragraphs report about the pointer.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum LinkHoverEvent {
    /// The pointer is over the text of the link `url` of paragraph `source`.
    Enter {
        source: String,
        url: String,
        anchor: Rect,
    },
    /// The pointer is on paragraph `source` outside any link, or has left it.
    Leave { source: String },
    /// A button went down on a link: the card gives way.
    Press,
}

/// The rectangle the card anchors to for a link whose text runs from `start` to `end` (window
/// positions of its first and last byte, top left of the glyph). A link on one line anchors to
/// its own extent. A link that wraps anchors to the line under the pointer, across the paragraph.
#[must_use]
pub(crate) fn link_anchor(
    start: Option<(f32, f32)>,
    end: Option<(f32, f32)>,
    line_height: f32,
    pointer: (f32, f32),
    text: Rect,
) -> Rect {
    let (Some(start), Some(end)) = (start, end) else {
        return Rect {
            x: pointer.0,
            y: pointer.1,
            w: 0.0,
            h: 0.0,
        };
    };
    if (start.1 - end.1).abs() < 1.0 {
        return Rect {
            x: start.0,
            y: start.1,
            w: (end.0 - start.0).max(0.0),
            h: line_height,
        };
    }
    let line = ((pointer.1 - start.1) / line_height).floor().max(0.0);
    let last_line = ((end.1 - start.1) / line_height).round().max(0.0);
    Rect {
        x: text.x,
        y: start.1 + line.min(last_line) * line_height,
        w: text.w,
        h: line_height,
    }
}

/// The timers a hover change asks for. Each carries the epoch it was asked in; a timer that
/// fires after a later change finds the epoch moved on and does nothing.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Schedule {
    pub(super) open: Option<u64>,
    pub(super) close: Option<u64>,
}

#[derive(Clone, Debug)]
struct HoverLink {
    source: String,
    url: String,
    anchor: Rect,
}

/// The card that is showing.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct OpenCard {
    pub(super) url: String,
    pub(super) anchor: Rect,
}

/// Base UI's `PreviewCard` rules: open after [`OPEN_DELAY`] on the link, close [`CLOSE_DELAY`]
/// after the pointer has left both the link and the card.
#[derive(Debug, Default)]
pub(super) struct HoverState {
    link: Option<HoverLink>,
    card_hovered: bool,
    open: Option<OpenCard>,
    epoch: u64,
}

impl HoverState {
    #[must_use]
    pub(super) fn open_card(&self) -> Option<&OpenCard> {
        self.open.as_ref()
    }

    fn bump(&mut self) -> u64 {
        self.epoch += 1;
        self.epoch
    }

    /// The pointer is on a link. Moving along the same link changes nothing.
    pub(super) fn enter_link(&mut self, source: &str, url: &str, anchor: Rect) -> Schedule {
        if let Some(link) = &mut self.link
            && link.url == url
        {
            link.source = source.to_owned();
            link.anchor = anchor;
            return Schedule::default();
        }
        let epoch = self.bump();
        self.link = Some(HoverLink {
            source: source.to_owned(),
            url: url.to_owned(),
            anchor,
        });
        let open_other = self.open.as_ref().is_some_and(|open| open.url != url);
        let open_same = self.open.as_ref().is_some_and(|open| open.url == url);
        Schedule {
            open: (!open_same).then_some(epoch),
            close: open_other.then_some(epoch),
        }
    }

    /// The pointer left the link of paragraph `source`, or the paragraph. A link of another
    /// paragraph stays hovered.
    pub(super) fn leave_link(&mut self, source: &str) -> Schedule {
        if self.link.as_ref().is_none_or(|link| link.source != source) {
            return Schedule::default();
        }
        self.link = None;
        let epoch = self.bump();
        Schedule {
            open: None,
            close: (self.open.is_some() && !self.card_hovered).then_some(epoch),
        }
    }

    /// The pointer entered or left the card.
    pub(super) fn set_card_hovered(&mut self, hovered: bool) -> Schedule {
        if self.card_hovered == hovered {
            return Schedule::default();
        }
        self.card_hovered = hovered;
        let epoch = self.bump();
        Schedule {
            open: None,
            close: (!hovered && self.open.is_some() && self.link.is_none()).then_some(epoch),
        }
    }

    /// The open timer of `epoch` fired. Returns the URL whose card opens.
    pub(super) fn elapse_open(&mut self, epoch: u64) -> Option<String> {
        if epoch != self.epoch {
            return None;
        }
        let link = self.link.as_ref()?;
        let card = OpenCard {
            url: link.url.clone(),
            anchor: link.anchor,
        };
        let url = card.url.clone();
        self.open = Some(card);
        Some(url)
    }

    /// The close timer of `epoch` fired. Returns whether the card closed.
    pub(super) fn elapse_close(&mut self, epoch: u64) -> bool {
        if epoch != self.epoch || self.card_hovered {
            return false;
        }
        let Some(open) = &self.open else {
            return false;
        };
        if self.link.as_ref().is_some_and(|link| link.url == open.url) {
            return false;
        }
        self.open = None;
        true
    }

    /// Closes the card at once (a press on a link, a menu, another thread). The pointer stays
    /// recorded on its link, so the card does not come back until the pointer leaves and returns.
    pub(super) fn dismiss(&mut self) -> bool {
        self.card_hovered = false;
        self.bump();
        self.open.take().is_some()
    }
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

/// Which side of the link the card sits on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Side {
    Above,
    Below,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Placement {
    pub(super) side: Side,
    /// The card's horizontal centre (`align="center"`).
    pub(super) center_x: f32,
    /// The card's bottom edge when above, its top edge when below.
    pub(super) edge_y: f32,
}

/// Above the link (`side="top"`, 6px off it), below when it does not fit above but fits below.
#[must_use]
pub(super) fn place_card(anchor: Rect, card_height: f32, viewport_height: f32) -> Placement {
    let above_edge = anchor.y - SIDE_OFFSET_PX;
    let below_edge = anchor.bottom() + SIDE_OFFSET_PX;
    let fits_above = above_edge - card_height >= COLLISION_PADDING_PX;
    let fits_below = below_edge + card_height <= viewport_height - COLLISION_PADDING_PX;
    if fits_above || !fits_below {
        Placement {
            side: Side::Above,
            center_x: anchor.center_x(),
            edge_y: above_edge,
        }
    } else {
        Placement {
            side: Side::Below,
            center_x: anchor.center_x(),
            edge_y: below_edge,
        }
    }
}

/// `w-80 max-w-[calc(100vw-2rem)]`.
#[must_use]
pub(super) fn card_width(viewport_width: f32) -> f32 {
    CARD_WIDTH_PX.min((viewport_width - CARD_VIEWPORT_GUTTER_PX).max(0.0))
}

/// The card's height before it is laid out, for deciding which side it fits: the padding and
/// border, the header, the author line, and as many title lines as its length suggests.
#[must_use]
pub(super) fn estimated_card_height(title: &str) -> f32 {
    let lines = title.chars().count().div_ceil(TITLE_CHARS_PER_LINE).max(1);
    // `as f32`: a handful of lines.
    #[expect(
        clippy::cast_precision_loss,
        reason = "a title has a few lines at most"
    )]
    let lines = lines as f32;
    2.0 + CARD_PADDING_TOP_PX
        + CARD_PADDING_PX
        + REPO_LINE_PX
        + HEADER_GAP_PX
        + lines * TITLE_LINE_PX
        + ROW_GAP_PX
        + AUTHOR_LINE_PX
}

// ---------------------------------------------------------------------------------------------
// ChatView
// ---------------------------------------------------------------------------------------------

/// The preview state of one chat view.
#[derive(Debug, Default)]
pub(super) struct LinkPreview {
    pub(super) hover: HoverState,
    pub(super) cache: PreviewCache,
}

impl ChatView {
    /// A paragraph reported the pointer on or off a link.
    pub(super) fn link_hover(&mut self, event: LinkHoverEvent, cx: &mut Context<'_, Self>) {
        let schedule = match event {
            LinkHoverEvent::Enter {
                source,
                url,
                anchor,
            } => self.link_preview.hover.enter_link(&source, &url, anchor),
            LinkHoverEvent::Leave { source } => self.link_preview.hover.leave_link(&source),
            LinkHoverEvent::Press => {
                self.dismiss_link_preview(cx);
                return;
            }
        };
        self.run_link_preview_schedule(&schedule, cx);
    }

    fn link_card_hover(&mut self, hovered: bool, cx: &mut Context<'_, Self>) {
        let schedule = self.link_preview.hover.set_card_hovered(hovered);
        self.run_link_preview_schedule(&schedule, cx);
    }

    /// Closes the card (a menu opens, the thread changes).
    pub(super) fn dismiss_link_preview(&mut self, cx: &mut Context<'_, Self>) {
        if self.link_preview.hover.dismiss() {
            cx.notify();
        }
    }

    fn run_link_preview_schedule(&self, schedule: &Schedule, cx: &mut Context<'_, Self>) {
        if let Some(epoch) = schedule.open {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(OPEN_DELAY).await;
                let _ = this.update(cx, |view, cx| {
                    if let Some(url) = view.link_preview.hover.elapse_open(epoch) {
                        view.load_link_preview(&url, cx);
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        if let Some(epoch) = schedule.close {
            cx.spawn(async move |this, cx| {
                cx.background_executor().timer(CLOSE_DELAY).await;
                let _ = this.update(cx, |view, cx| {
                    if view.link_preview.hover.elapse_close(epoch) {
                        cx.notify();
                    }
                });
            })
            .detach();
        }
    }

    /// Reads the card of `url` unless a fresh one is cached.
    fn load_link_preview(&mut self, url: &str, cx: &mut Context<'_, Self>) {
        let (Some(conn), Some(project_id)) = (self.connection.clone(), self.project_id.clone())
        else {
            return;
        };
        let requests = preview_requests(url);
        if requests.is_empty() || !self.link_preview.cache.needs_fetch(url, Instant::now()) {
            return;
        }
        self.link_preview.cache.begin(url);
        let key = url.to_owned();
        cx.spawn(async move |this, cx| {
            let card = fetch_card(&conn, &project_id, &requests).await;
            let _ = this.update(cx, |view, cx| {
                view.link_preview.cache.finish(&key, card, Instant::now());
                cx.notify();
            });
        })
        .detach();
    }

    /// The card, anchored over its link, once its data is in.
    pub(super) fn render_link_preview(
        &mut self,
        window: &Window,
        tokens: &Tokens,
        cx: &mut Context<'_, Self>,
    ) -> Option<AnyElement> {
        let open = self.link_preview.hover.open_card()?;
        let model = self.link_preview.cache.card(&open.url)?;
        let viewport = window.viewport_size();
        let viewport_width = f32::from(viewport.width);
        let placement = place_card(
            open.anchor,
            estimated_card_height(&model.title),
            f32::from(viewport.height),
        );
        let card = card_element(model, card_width(viewport_width), tokens, cx);
        let (corner, edge_y) = match placement.side {
            Side::Above => (Anchor::BottomCenter, placement.edge_y),
            Side::Below => (Anchor::TopCenter, placement.edge_y),
        };
        Some(
            deferred(
                anchored()
                    .anchor(corner)
                    .position(point(px(placement.center_x), px(edge_y)))
                    .snap_to_window_with_margin(px(COLLISION_PADDING_PX))
                    .child(card),
            )
            .with_priority(5)
            .into_any_element(),
        )
    }
}

/// Reads the first request that answers.
async fn fetch_card(
    conn: &Connection,
    project_id: &str,
    requests: &[PreviewRequest],
) -> Option<CardModel> {
    for request in requests {
        match request {
            PreviewRequest::PullRequest {
                host,
                repository,
                number,
            } => {
                let payload = PullRequestRef {
                    project_id: project_id.to_owned(),
                    host: Some(host.clone()),
                    expected_account_id: None,
                    allow_stale: None,
                    repository: repository.clone(),
                    number: *number,
                };
                if let Ok(preview) = conn
                    .call::<pull_request_preview::Payload, pull_request_preview::Success>(
                        "pullRequests.preview",
                        &payload,
                    )
                    .await
                {
                    return Some(card_from_pull_request(&preview));
                }
            }
            PreviewRequest::Issue {
                tracker,
                host,
                scope,
                key,
            } => {
                let payload = IssueRef {
                    project_id: project_id.to_owned(),
                    tracker: (*tracker).to_owned(),
                    host: Some(host.clone()),
                    scope: scope.clone(),
                    key: key.clone(),
                };
                if let Ok(detail) = conn
                    .call::<issue_detail::Payload, issue_detail::Success>("issues.detail", &payload)
                    .await
                {
                    return Some(card_from_issue(&detail));
                }
            }
        }
    }
    None
}

fn tone_color(tokens: &Tokens, tone: StateTone) -> Hsla {
    match tone {
        StateTone::Open => hsla(tokens.success),
        StateTone::Draft => hsla(tokens.muted_foreground),
        StateTone::Closed => hsla(tokens.destructive),
        // The merged violet of the Linked items panel and the task board.
        StateTone::Merged => hsla(color_mix_srgb(
            tokens.info_foreground,
            0.52,
            tokens.destructive,
        )),
    }
}

/// The card: `rounded-lg border bg-popover shadow-lg`, `p-3` inside.
fn card_element(
    model: &CardModel,
    width: f32,
    tokens: &Tokens,
    cx: &mut Context<'_, ChatView>,
) -> AnyElement {
    let muted = hsla(tokens.muted_foreground);
    let tone = tone_color(tokens, model.chip.tone);
    let dot = || div().flex_shrink_0().child("\u{b7}");

    let header = div()
        .id("chat-link-preview-header")
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .min_w_0()
        .text_size(px(REPO_FONT_PX))
        .line_height(px(REPO_LINE_PX))
        .text_color(muted)
        .child(div().min_w_0().truncate().child(model.scope.clone()))
        .child(div().flex_shrink_0().child(model.number.clone()))
        .child(dot())
        .child(
            div()
                .flex()
                .flex_row()
                .flex_shrink_0()
                .items_center()
                .gap(px(4.0))
                .child(icons::concept(model.chip.icon, STATE_ICON_PX, tone))
                .child(div().text_color(muted).child(model.chip.label.clone())),
        );

    let title = div()
        .id("chat-link-preview-title")
        .a11y(
            gpui_kit::Role::Heading,
            "chat.link-preview.title",
            model.title.clone(),
        )
        .mt(px(HEADER_GAP_PX))
        .text_size(px(TITLE_FONT_PX))
        .line_height(px(TITLE_LINE_PX))
        .font_weight(FontWeight::MEDIUM)
        .text_color(hsla(tokens.foreground))
        .child(model.title.clone());

    let author_name = author_label(model.author.as_ref());
    let mut author = div()
        .id("chat-link-preview-author")
        .a11y_group("chat.link-preview.author", format!("Author {author_name}"))
        .mt(px(ROW_GAP_PX))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(6.0))
        .min_w_0()
        .text_size(px(AUTHOR_FONT_PX))
        .line_height(px(AUTHOR_LINE_PX))
        .text_color(muted)
        .child(actor_avatar(
            tokens,
            model.author.as_ref(),
            AVATAR_PX,
            None,
            false,
        ))
        .child(div().min_w_0().truncate().child(author_name));
    if let Some(opened) = opened_label(&model.created_at, now_epoch_ms()) {
        author = author
            .child(dot())
            .child(div().flex_shrink_0().child(SharedString::from(opened)));
    }

    div()
        .id("chat-link-preview")
        .a11y_group(
            "chat.link-preview",
            format!("{} {}: {}", model.scope, model.number, model.title),
        )
        .occlude()
        .w(px(width))
        .rounded(px(CARD_RADIUS_PX))
        .p(px(CARD_PADDING_PX))
        .pt(px(CARD_PADDING_TOP_PX))
        .bg(hsla(tokens.popover))
        .text_color(hsla(tokens.popover_foreground))
        .border_1()
        .border_color(hsla(tokens.glass_divider))
        .shadow_lg()
        .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
            this.link_card_hover(*hovered, cx);
        }))
        .child(div().min_w_0().child(header).child(title).child(author))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PR: &str = "https://github.com/nckrtl/conn/pull/329";

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    fn actor(login: &str, name: Option<&str>) -> IssueActor {
        IssueActor {
            is_bot: None,
            login: login.to_owned(),
            name: name.map(str::to_owned),
            avatar_url: None,
        }
    }

    #[test]
    fn a_pull_request_link_reads_the_pull_request() {
        assert_eq!(
            preview_requests(PR),
            vec![PreviewRequest::PullRequest {
                host: "github.com".to_owned(),
                repository: "nckrtl/conn".to_owned(),
                number: 329,
            }]
        );
        assert_eq!(
            preview_requests("https://github.com/nckrtl/conn/pull/329/files#diff"),
            preview_requests(PR)
        );
    }

    #[test]
    fn a_github_issue_link_reads_the_issue_then_the_pull_request() {
        assert_eq!(
            preview_requests("https://github.com/NckRtl/Conn/issues/12"),
            vec![
                PreviewRequest::Issue {
                    tracker: "github",
                    host: "github.com".to_owned(),
                    scope: "nckrtl/conn".to_owned(),
                    key: "12".to_owned(),
                },
                PreviewRequest::PullRequest {
                    host: "github.com".to_owned(),
                    repository: "NckRtl/Conn".to_owned(),
                    number: 12,
                },
            ]
        );
    }

    #[test]
    fn a_gitlab_issue_link_reads_the_issue() {
        assert_eq!(
            preview_requests("https://gitlab.com/org/sub/repo/-/issues/7"),
            vec![PreviewRequest::Issue {
                tracker: "gitlab",
                host: "gitlab.com".to_owned(),
                scope: "org/sub/repo".to_owned(),
                key: "7".to_owned(),
            }]
        );
        assert!(
            is_previewable("https://gitlab.com/org/repo/-/work_items/3"),
            "work items are issues"
        );
    }

    #[test]
    fn other_links_have_no_card() {
        for url in [
            "https://example.com/",
            "https://example.com/a/b/issues/3",
            "https://github.com/nckrtl/conn",
            "https://github.com/nckrtl/conn/issues/abc",
            "https://github.com/nckrtl/conn/issues/0",
            "https://github.com/nckrtl/conn/issues",
            "mailto:me@example.com",
            "not a url",
        ] {
            assert!(!is_previewable(url), "{url}");
        }
    }

    #[test]
    fn pull_request_states_name_glyph_and_tone() {
        let chip = |state, draft| {
            let chip = pull_request_chip(state, draft);
            (chip.label, chip.icon, chip.tone)
        };
        assert_eq!(
            chip(PullRequestState::Open, false),
            (
                "Open".to_owned(),
                "superhero/pull-request.svg",
                StateTone::Open
            )
        );
        assert_eq!(
            chip(PullRequestState::Open, true),
            (
                "Draft".to_owned(),
                "superhero/pull-request-draft.svg",
                StateTone::Draft
            )
        );
        assert_eq!(
            chip(PullRequestState::Closed, true),
            (
                "Closed".to_owned(),
                "superhero/pull-request-closed.svg",
                StateTone::Closed
            ),
            "a closed draft is closed"
        );
        assert_eq!(
            chip(PullRequestState::Merged, false),
            (
                "Merged".to_owned(),
                "superhero/merge.svg",
                StateTone::Merged
            )
        );
    }

    #[test]
    fn issue_states_borrow_the_pull_request_ink() {
        let state = |category, name: &str, reason: Option<&str>| IssueState {
            category,
            name: name.to_owned(),
            close_reason: reason.map(str::to_owned),
        };
        let open = issue_chip(&state(IssueStateCategory::Open, "In Review", None));
        assert_eq!(
            (open.label.as_str(), open.icon, open.tone),
            ("In Review", "superhero/circle-dot.svg", StateTone::Open)
        );
        let done = issue_chip(&state(
            IssueStateCategory::Closed,
            "Closed",
            Some("completed"),
        ));
        assert_eq!(
            (done.icon, done.tone),
            ("superhero/check-circle.svg", StateTone::Merged)
        );
        let bare = issue_chip(&state(IssueStateCategory::Closed, "Done", None));
        assert_eq!(
            bare.tone,
            StateTone::Merged,
            "no reason counts as completed"
        );
        let dropped = issue_chip(&state(
            IssueStateCategory::Closed,
            "Not planned",
            Some("not_planned"),
        ));
        assert_eq!(
            (dropped.icon, dropped.tone),
            ("superhero/blocked.svg", StateTone::Draft)
        );
    }

    #[test]
    fn the_author_line_names_the_person() {
        assert_eq!(author_label(None), "ghost");
        assert_eq!(
            author_label(Some(&actor("nckrtl", Some("Nick Retel")))),
            "Nick Retel (@nckrtl)"
        );
        assert_eq!(author_label(Some(&actor("nckrtl", None))), "nckrtl");
        assert_eq!(author_label(Some(&actor("nckrtl", Some("")))), "nckrtl");
        assert_eq!(
            author_label(Some(&actor("nckrtl", Some("nckrtl")))),
            "nckrtl"
        );
    }

    #[test]
    fn opened_reads_like_the_relative_time() {
        let created = "2026-11-24T10:00:00.000Z";
        let at = |minutes: i64| {
            let base = 1_795_514_400_000_i64; // 2026-11-24T10:00:00Z
            base + minutes * 60_000
        };
        assert_eq!(
            opened_label(created, at(0)).as_deref(),
            Some("opened just now")
        );
        assert_eq!(
            opened_label(created, at(55)).as_deref(),
            Some("opened 55m ago")
        );
        assert_eq!(
            opened_label(created, at(180)).as_deref(),
            Some("opened 3h ago")
        );
        assert_eq!(
            opened_label(created, at(3 * 24 * 60)).as_deref(),
            Some("opened 3d ago")
        );
        assert_eq!(opened_label("not a date", at(0)), None);
    }

    fn card(title: &str) -> CardModel {
        CardModel {
            scope: "nckrtl/conn".to_owned(),
            number: "#329".to_owned(),
            chip: pull_request_chip(PullRequestState::Open, false),
            title: title.to_owned(),
            author: None,
            created_at: "2026-11-24T10:00:00Z".to_owned(),
        }
    }

    #[test]
    fn a_fresh_card_is_not_read_again() {
        let mut cache = PreviewCache::default();
        let t0 = Instant::now();
        assert!(cache.needs_fetch(PR, t0));
        cache.begin(PR);
        assert!(!cache.needs_fetch(PR, t0), "a read is under way");
        cache.finish(PR, Some(card("Title")), t0);
        assert_eq!(cache.card(PR).map(|c| c.title.as_str()), Some("Title"));
        assert!(!cache.needs_fetch(PR, t0 + Duration::from_secs(59)));
        assert!(cache.needs_fetch(PR, t0 + Duration::from_secs(61)));
    }

    #[test]
    fn a_failed_read_is_tried_again_and_keeps_the_old_card() {
        let mut cache = PreviewCache::default();
        let t0 = Instant::now();
        cache.begin(PR);
        cache.finish(PR, None, t0);
        assert!(cache.card(PR).is_none());
        assert!(cache.needs_fetch(PR, t0), "an error is not cached");

        cache.begin(PR);
        cache.finish(PR, Some(card("Old")), t0);
        let later = t0 + Duration::from_secs(120);
        cache.begin(PR);
        cache.finish(PR, None, later);
        assert_eq!(cache.card(PR).map(|c| c.title.as_str()), Some("Old"));
        assert!(cache.needs_fetch(PR, later));
    }

    const A: &str = "https://github.com/nckrtl/conn/pull/1";
    const B: &str = "https://github.com/nckrtl/conn/pull/2";

    #[test]
    fn the_card_opens_after_the_pointer_rests_on_the_link() {
        let mut hover = HoverState::default();
        let schedule = hover.enter_link("p1", A, rect(10.0, 100.0, 40.0, 20.0));
        let epoch = schedule.open.expect("an open timer");
        assert_eq!(schedule.close, None);
        assert_eq!(hover.elapse_open(epoch).as_deref(), Some(A));
        assert_eq!(hover.open_card().map(|c| c.url.as_str()), Some(A));
    }

    #[test]
    fn moving_along_the_link_does_not_restart_the_delay() {
        let mut hover = HoverState::default();
        let epoch = hover
            .enter_link("p1", A, rect(10.0, 100.0, 40.0, 20.0))
            .open
            .expect("open timer");
        assert_eq!(
            hover.enter_link("p1", A, rect(10.0, 100.0, 40.0, 20.0)),
            Schedule::default()
        );
        assert!(hover.elapse_open(epoch).is_some());
    }

    #[test]
    fn leaving_the_link_before_the_delay_cancels_the_card() {
        let mut hover = HoverState::default();
        let epoch = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("open timer");
        assert_eq!(hover.leave_link("p1"), Schedule::default());
        assert_eq!(hover.elapse_open(epoch), None);
        assert!(hover.open_card().is_none());
    }

    #[test]
    fn the_card_closes_after_the_pointer_leaves_link_and_card() {
        let mut hover = HoverState::default();
        let open = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("timer");
        hover.elapse_open(open);
        let close = hover.leave_link("p1").close.expect("a close timer");
        assert!(hover.elapse_close(close));
        assert!(hover.open_card().is_none());
    }

    #[test]
    fn the_card_stays_while_the_pointer_is_on_it() {
        let mut hover = HoverState::default();
        let open = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("timer");
        hover.elapse_open(open);
        let close = hover.leave_link("p1").close.expect("a close timer");
        // The pointer crosses the gap onto the card before the timer fires.
        assert_eq!(hover.set_card_hovered(true), Schedule::default());
        assert!(!hover.elapse_close(close), "the card was entered");
        assert!(hover.open_card().is_some());
        let close = hover.set_card_hovered(false).close.expect("a close timer");
        assert!(hover.elapse_close(close));
    }

    #[test]
    fn coming_back_to_the_link_keeps_the_card() {
        let mut hover = HoverState::default();
        let open = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("timer");
        hover.elapse_open(open);
        let close = hover.leave_link("p1").close.expect("a close timer");
        let schedule = hover.enter_link("p1", A, Rect::default());
        assert_eq!(schedule, Schedule::default(), "nothing to reopen or close");
        assert!(!hover.elapse_close(close));
        assert!(hover.open_card().is_some());
    }

    #[test]
    fn another_link_replaces_the_open_card() {
        let mut hover = HoverState::default();
        let open = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("timer");
        hover.elapse_open(open);
        let schedule = hover.enter_link("p1", B, Rect::default());
        let (open_b, close_a) = (schedule.open.expect("open"), schedule.close.expect("close"));
        assert!(hover.elapse_close(close_a), "the old card goes first");
        assert!(hover.open_card().is_none());
        assert_eq!(hover.elapse_open(open_b).as_deref(), Some(B));
    }

    #[test]
    fn a_paragraph_only_ends_its_own_link() {
        let mut hover = HoverState::default();
        hover.enter_link("p1", A, Rect::default());
        // The pointer went to a link of paragraph two; paragraph one reports leaving after it.
        hover.enter_link("p2", B, Rect::default());
        assert_eq!(hover.leave_link("p1"), Schedule::default());
        let open = hover.enter_link("p2", B, Rect::default());
        assert_eq!(open, Schedule::default(), "still on B");
        assert!(hover.leave_link("p2").open.is_none());
    }

    #[test]
    fn a_press_closes_the_card_until_the_pointer_comes_back() {
        let mut hover = HoverState::default();
        let open = hover
            .enter_link("p1", A, Rect::default())
            .open
            .expect("timer");
        hover.elapse_open(open);
        assert!(hover.dismiss());
        assert!(hover.open_card().is_none());
        assert_eq!(
            hover.enter_link("p1", A, Rect::default()),
            Schedule::default(),
            "moving on the same link does not reopen it"
        );
        hover.leave_link("p1");
        assert!(hover.enter_link("p1", A, Rect::default()).open.is_some());
    }

    #[test]
    fn a_link_on_one_line_anchors_to_its_extent() {
        let anchor = link_anchor(
            Some((100.0, 50.0)),
            Some((160.0, 50.0)),
            20.0,
            (120.0, 60.0),
            rect(0.0, 40.0, 600.0, 60.0),
        );
        assert_eq!(anchor, rect(100.0, 50.0, 60.0, 20.0));
    }

    #[test]
    fn a_wrapped_link_anchors_to_the_line_under_the_pointer() {
        let text = rect(0.0, 40.0, 600.0, 60.0);
        let first = link_anchor(
            Some((500.0, 40.0)),
            Some((80.0, 60.0)),
            20.0,
            (520.0, 45.0),
            text,
        );
        assert_eq!(first, rect(0.0, 40.0, 600.0, 20.0));
        let second = link_anchor(
            Some((500.0, 40.0)),
            Some((80.0, 60.0)),
            20.0,
            (40.0, 65.0),
            text,
        );
        assert_eq!(second, rect(0.0, 60.0, 600.0, 20.0));
        let unknown = link_anchor(None, None, 20.0, (7.0, 9.0), text);
        assert_eq!(unknown, rect(7.0, 9.0, 0.0, 0.0));
    }

    #[test]
    fn the_card_sits_above_the_link_and_flips_below_at_the_top() {
        let anchor = rect(100.0, 400.0, 60.0, 20.0);
        let above = place_card(anchor, 110.0, 900.0);
        assert_eq!(above.side, Side::Above);
        assert!(
            (above.edge_y - 394.0).abs() < f32::EPSILON,
            "6px off the link"
        );
        assert!(
            (above.center_x - 130.0).abs() < f32::EPSILON,
            "centred on it"
        );

        let near_top = rect(100.0, 60.0, 60.0, 20.0);
        let below = place_card(near_top, 110.0, 900.0);
        assert_eq!(below.side, Side::Below);
        assert!((below.edge_y - 86.0).abs() < f32::EPSILON);
    }

    #[test]
    fn the_card_stays_above_when_neither_side_fits() {
        let tiny = place_card(rect(10.0, 40.0, 30.0, 20.0), 300.0, 200.0);
        assert_eq!(tiny.side, Side::Above);
    }

    #[test]
    fn the_card_is_w_80_but_never_wider_than_the_window_less_two_rem() {
        assert!((card_width(1440.0) - 320.0).abs() < f32::EPSILON);
        assert!((card_width(300.0) - 268.0).abs() < f32::EPSILON);
        assert!(card_width(10.0).abs() < f32::EPSILON);
    }

    #[test]
    fn a_long_title_makes_the_card_taller() {
        let short = estimated_card_height("Short");
        let long = estimated_card_height(&"x".repeat(100));
        assert!(long > short);
        assert!(
            (long - short - 2.0 * TITLE_LINE_PX).abs() < 0.001,
            "3 lines vs 1"
        );
    }
}
