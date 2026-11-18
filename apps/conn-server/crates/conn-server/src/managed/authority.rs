//! The target's view of the Gateway's managed authority, as Orbit's "Managed grant
//! revocation" contract defines it: the applied revision, the lease, the provisional and
//! confirmed fenced sets, the admitted edges, the open handlers and the owed
//! acknowledgements.
//!
//! This file holds only state and rules. It does no I/O, takes the time as arguments and
//! never blocks, so every rule is a plain test. [`super::Shared`] wraps it in one lock: an
//! admission, a fence and a data-boundary check all see the same state.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Deserialize;
use tokio::{sync::watch, time::Instant};

pub type EdgeId = u64;
pub type Revision = u64;

/// Lab values from the contract ("Lease"): probe every second, lease ends 3 seconds after the
/// send time of the last applied probe. Measurements set the production values later.
pub const PROBE_EVERY: std::time::Duration = std::time::Duration::from_secs(1);
pub const LEASE: std::time::Duration = std::time::Duration::from_secs(3);

/// One edge of a `snapshot` reply.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct SnapshotEdge {
    pub edge_id: EdgeId,
    pub consumer_node_id: u64,
}

/// One revision of a `delta` reply or of `owed`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct RevisionEdges {
    pub revision: Revision,
    pub edge_ids: Vec<EdgeId>,
}

/// `POST /authority` reply `data`.
#[derive(Clone, Debug, Deserialize)]
pub struct AuthorityReply {
    pub nonce: String,
    pub environment_id: String,
    pub generation: u64,
    pub head_revision: Revision,
    /// Required: without it the clock offset, and so token expiry, has no bound.
    pub server_time: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub edges: Option<Vec<SnapshotEdge>>,
    #[serde(default)]
    pub revisions: Option<Vec<RevisionEdges>>,
    /// Required: an omitted list must not read as "nothing owed".
    pub owed: Vec<RevisionEdges>,
}

/// The data of a `conn.authority.revoked` notice.
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Notice {
    pub environment_id: String,
    pub generation: u64,
    pub revision: Revision,
    pub edge_ids: Vec<EdgeId>,
}

/// The probe the target has outstanding. One at a time.
#[derive(Clone, Debug)]
pub struct Probe {
    pub nonce: String,
    pub after_revision: Option<Revision>,
    pub sent: Instant,
    /// Wall time of the send, for the clock offset bounds.
    pub sent_wall_ms: u64,
}

/// What a registered handler may do now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateState {
    Open,
    /// A revision is known without its edges: no dispatch and no output until a probe
    /// applies the head. The handler stays registered.
    Paused,
    /// Fenced, expired or authority lost: the handler must end.
    Closed,
}

/// A ticket's binding, checked again when it is redeemed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TicketBinding {
    pub edge: EdgeId,
    /// The ticket must be redeemed before this monotonic instant.
    pub redeem_by: Instant,
    /// The pool's own number for the ticket; set when it is minted.
    pub id: u64,
}

/// The most unspent managed tickets kept.
pub const MAX_TICKETS: usize = 256;

/// An unspent managed ticket. Kept with the authority, so a fence of its edge deletes it in
/// the same step as it closes the edge's handlers.
struct PoolTicket {
    token: String,
    route: &'static str,
    binding: TicketBinding,
    /// Being redeemed: it stays in the pool until its handler registers, so a fence or a
    /// fail-closed during the redemption's introspection still cancels it.
    reserved: bool,
}

/// Why a ticket could not be minted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintRefusal {
    Fenced,
    Full,
}

/// Why access was refused. The ingress maps each to a response; none of them falls through
/// to native auth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Failed closed, recovering, blocked behind an unknown revision, or the lease ended.
    Unavailable,
    /// The claims name a revision this target has not applied: reconcile, then introspect
    /// again.
    Reconcile,
    /// The edge is fenced, provisionally or for good.
    Fenced,
    /// The token expired.
    Expired,
    /// A snapshot barrier dropped this introspection: introspect again.
    Stale,
}

/// Why the target failed closed. Kept for the log and the tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loss {
    ProbeFailed,
    LeaseExpired,
    WrongIdentity,
    MissingRevision,
    UnexpectedKind,
    NoticeLinkClosed,
    /// More notices than the target keeps pending.
    NoticeOverflow,
}

/// The most notices kept while their revisions are not applied, and the most edges one
/// notice may name. A Gateway that floods past either fails the target closed; a snapshot
/// recovers from the Gateway's own state, so nothing a dropped notice said is needed.
pub const MAX_PENDING_NOTICES: usize = 1_024;
pub const MAX_NOTICE_EDGES: usize = 1_024;

/// The kind of an acknowledgement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AckKind {
    Observed,
    Recovered,
}

/// One `/ack` the target owes and can send now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ack {
    pub revision: Revision,
    pub kind: AckKind,
    pub notice_received_ms: Option<u64>,
    pub fenced_ms: Option<u64>,
    pub handlers_closed_ms: Option<u64>,
    pub recovered_ms: Option<u64>,
}

/// What the target knows about one revision.
#[derive(Clone, Debug, Default)]
struct RevisionRecord {
    edges: BTreeSet<EdgeId>,
    /// Learned from a verified `delta`, `owed` or snapshot; only then can it be acknowledged.
    verified: bool,
    notice_received_ms: Option<u64>,
    fenced_ms: Option<u64>,
    handlers_closed_ms: Option<u64>,
    /// Set when the target applied a snapshot without having observed the close itself.
    recovered_ms: Option<u64>,
}

struct HandlerEntry {
    edge: EdgeId,
    close: watch::Sender<bool>,
    /// The token's expiry on the Gateway's clock. Its local deadline is recomputed from
    /// every verified probe, so a Gateway clock that moves ahead shortens it.
    expires_gateway_ms: Option<u64>,
}

struct NoticeRecord {
    edges: Vec<EdgeId>,
    received: Instant,
}

/// The state behind one managed target.
pub struct Authority {
    environment_id: String,
    generation: u64,
    /// `false` at start and after failing closed: only a snapshot opens it.
    open: bool,
    /// Whether the notice subscription is live. Access needs it (see `notices.rs`).
    notice_link: bool,
    applied: Option<Revision>,
    lease_until: Option<Instant>,
    confirmed: HashSet<EdgeId>,
    /// Edge to the revisions of every outstanding notice that fenced it. Never empty.
    provisional: HashMap<EdgeId, BTreeSet<Revision>>,
    /// A revision known without a contiguous edge list: everything pauses until a probe
    /// applies at least this revision.
    gap_notices: BTreeSet<Revision>,
    /// The greatest revision an introspection named that is not applied yet, and when.
    introspected: Option<(Revision, Instant)>,
    /// Snapshots applied in this process; the first one recovers a restart.
    snapshots: u64,
    /// Raised each time an edge is fenced; a ticket minted before a fence never redeems.
    tickets: HashMap<String, PoolTicket>,
    next_ticket: u64,
    /// Bounds of (Gateway clock − target clock) in ms, from applied probes.
    offset_bounds: Option<(i64, i64)>,
    notices: BTreeMap<Revision, NoticeRecord>,
    admitted: HashSet<EdgeId>,
    probe: Option<Probe>,
    /// A greater revision became known while a probe ran: probe again at once.
    rerun: bool,
    /// Raised by every snapshot barrier; an introspection started under an older epoch is
    /// dropped.
    epoch: u64,
    handlers: HashMap<u64, HandlerEntry>,
    next_handler: u64,
    /// Wall time each currently fenced edge was blocked.
    fenced_at: HashMap<EdgeId, u64>,
    /// The monotonic instant of each fence, so a close time is the fence's wall time plus
    /// elapsed monotonic time: a wall clock step never makes a close precede its fence.
    fence_mark: HashMap<EdgeId, Instant>,
    /// The monotonic time of the change being applied (set by `notice` and `apply_reply`).
    clock: Option<Instant>,
    /// The latest verified Gateway time and the monotonic send time of its probe.
    anchor: Option<(Instant, i64)>,
    /// Wall time a fenced edge was verified to have no handler left.
    closed_at: HashMap<EdgeId, u64>,
    revisions: BTreeMap<Revision, RevisionRecord>,
    /// Revisions the last verified reply listed as owed and not yet acknowledged since.
    owed: BTreeSet<Revision>,
    /// The ACK in flight, so one revision is acknowledged at a time.
    ack_in_flight: Option<Revision>,
    pub last_loss: Option<Loss>,
}

impl std::fmt::Debug for Authority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authority")
            .field("open", &self.open)
            .field("applied", &self.applied)
            .field("confirmed", &self.confirmed)
            .field("provisional", &self.provisional)
            .field("handlers", &self.handlers.len())
            .finish_non_exhaustive()
    }
}

/// Milliseconds of an RFC 3339 time, rounded up when it carries digits below the
/// millisecond.
pub fn ceil_millis_from_iso(text: &str) -> Option<i64> {
    let ms = conn_support::time::millis_from_iso(text)?;
    let below = text
        .split_once('.')
        .map(|(_, rest)| {
            rest.bytes()
                .take_while(u8::is_ascii_digit)
                .skip(3)
                .any(|d| d != b'0')
        })
        .unwrap_or(false);
    Some(if below { ms + 1 } else { ms })
}

/// What a caller must do after a change.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Effects {
    /// Probe again now.
    pub probe_now: bool,
    /// An ACK may be ready.
    pub ack: bool,
}

impl Authority {
    pub fn new(environment_id: String, generation: u64) -> Self {
        Self {
            environment_id,
            generation,
            open: false,
            notice_link: false,
            applied: None,
            lease_until: None,
            confirmed: HashSet::new(),
            provisional: HashMap::new(),
            gap_notices: BTreeSet::new(),
            introspected: None,
            snapshots: 0,
            tickets: HashMap::new(),
            next_ticket: 1,
            offset_bounds: None,
            notices: BTreeMap::new(),
            admitted: HashSet::new(),
            probe: None,
            rerun: false,
            epoch: 0,
            handlers: HashMap::new(),
            next_handler: 1,
            fenced_at: HashMap::new(),
            fence_mark: HashMap::new(),
            clock: None,
            anchor: None,
            closed_at: HashMap::new(),
            revisions: BTreeMap::new(),
            owed: BTreeSet::new(),
            ack_in_flight: None,
            last_loss: None,
        }
    }

    pub fn environment_id(&self) -> &str {
        &self.environment_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn applied(&self) -> Option<Revision> {
        self.applied
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn lease_until(&self) -> Option<Instant> {
        self.lease_until
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn open_handlers(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_fenced(&self, edge: EdgeId) -> bool {
        self.confirmed.contains(&edge) || self.provisional.contains_key(&edge)
    }

    pub fn is_confirmed(&self, edge: EdgeId) -> bool {
        self.confirmed.contains(&edge)
    }

    /// A revision ahead of the next one is known without a contiguous edge list, and no
    /// probe has applied it yet.
    pub fn blocked(&self) -> bool {
        let unapplied = |r: Revision| self.applied.is_none_or(|applied| applied < r);
        // An introspected revision whose edges no notice names yet.
        // Latched: only a verified probe that applies it ends the pause, never notices.
        self.introspected.is_some_and(|(r, _)| unapplied(r))
            || self.gap_notices.iter().any(|r| unapplied(*r))
    }

    /// The first revision after the applied one whose edges are not known from a notice.
    fn next_unknown(&self) -> Revision {
        let mut next = self.applied.map_or(0, |a| a + 1);
        while self.notices.contains_key(&next) {
            next += 1;
        }
        next
    }

    /// A revision named by an introspection or a notice. One the target cannot place in a
    /// contiguous list pauses every managed boundary until a probe applies it.
    pub fn note_revision(&mut self, revision: Revision, now: Instant) -> Effects {
        if self.applied.is_some_and(|applied| revision <= applied) {
            return Effects::default();
        }
        // Recorded even when a notice names it: HTTPS proved it exists, so no later probe may
        // disprove that notice, and a head below it is a missing revision.
        if self.introspected.is_none_or(|(r, _)| revision > r) {
            self.introspected = Some((revision, now));
        }
        if self.probe.is_some() {
            self.rerun = true;
        }
        Effects {
            probe_now: true,
            ..Effects::default()
        }
    }

    /// Keeps a new ticket for `binding.edge`, unless the edge is fenced or the pool is full.
    /// Expired tickets leave the pool first.
    pub fn mint_ticket(
        &mut self,
        ticket: String,
        token: String,
        route: &'static str,
        mut binding: TicketBinding,
        now: Instant,
    ) -> Result<(), MintRefusal> {
        self.tickets.retain(|_, t| t.binding.redeem_by > now);
        if self.is_fenced(binding.edge) {
            return Err(MintRefusal::Fenced);
        }
        if self.tickets.len() >= MAX_TICKETS {
            return Err(MintRefusal::Full);
        }
        binding.id = self.next_ticket;
        self.next_ticket += 1;
        self.tickets.insert(
            ticket,
            PoolTicket {
                token,
                route,
                binding,
                reserved: false,
            },
        );
        Ok(())
    }

    /// Reserves a ticket for redemption: its token and binding, if it is in the pool for
    /// `route`, unexpired and not already being redeemed. It stays in the pool until the
    /// handler registers ([`Self::admit`] consumes it). Anything else spends it at once.
    pub fn take_ticket(
        &mut self,
        ticket: &str,
        route: &'static str,
        now: Instant,
    ) -> Option<(String, TicketBinding)> {
        let usable = self
            .tickets
            .get(ticket)
            .is_some_and(|t| t.route == route && t.binding.redeem_by > now && !t.reserved);
        if !usable {
            self.tickets.remove(ticket);
            return None;
        }
        let entry = self.tickets.get_mut(ticket)?;
        entry.reserved = true;
        Some((entry.token.clone(), entry.binding))
    }

    /// The pool key of the reserved ticket with this binding, if it is still there.
    fn reserved_ticket(&self, binding: &TicketBinding) -> Option<String> {
        self.tickets
            .iter()
            .find(|(_, t)| t.reserved && t.binding.id == binding.id)
            .map(|(key, _)| key.clone())
    }

    /// Drops one ticket (a mint that could not answer).
    pub fn drop_ticket(&mut self, ticket: &str) {
        self.tickets.remove(ticket);
    }

    pub fn ticket_count(&self) -> usize {
        self.tickets.len()
    }

    pub fn offset_bounds(&self) -> Option<(i64, i64)> {
        self.offset_bounds
    }

    /// A Gateway wall time on the target's wall clock, on the safe (early) side: the
    /// Gateway's time minus the signed upper bound of (Gateway − target).
    pub fn local_wall_ms(&self, gateway_ms: u64) -> i64 {
        let ahead = self.offset_bounds.map_or(0, |(_, high)| high);
        i64::try_from(gateway_ms)
            .unwrap_or(i64::MAX)
            .saturating_sub(ahead)
    }

    /// The target monotonic deadline of a Gateway wall time, on the safe side and without
    /// the target's wall clock: the Gateway read `server_time` no earlier than the probe's
    /// monotonic send, so it reaches `gateway_ms` no earlier than that send plus the
    /// difference. Without an applied probe the deadline is now (expired).
    pub fn local_deadline(&self, gateway_ms: u64, now: Instant, _wall_ms: u64) -> Instant {
        let Some((sent, server)) = self.anchor else {
            return now;
        };
        let left = i64::try_from(gateway_ms)
            .unwrap_or(i64::MAX)
            .saturating_sub(server);
        sent + std::time::Duration::from_millis(u64::try_from(left).unwrap_or(0))
    }

    /// Removes `revision` from `edge`'s provisional fences. When none is left the edge is
    /// no longer fenced; every introspection started before is dropped, so reopening it needs
    /// a fresh one. Its closed sockets stay closed.
    fn clear_provisional(&mut self, edge: EdgeId, revision: Revision) {
        let Some(revisions) = self.provisional.get_mut(&edge) else {
            return;
        };
        revisions.remove(&revision);
        if revisions.is_empty() {
            self.provisional.remove(&edge);
            if !self.confirmed.contains(&edge) {
                self.fenced_at.remove(&edge);
                self.fence_mark.remove(&edge);
                self.closed_at.remove(&edge);
            }
            self.epoch += 1;
        }
    }

    fn lease_live(&self, now: Instant) -> bool {
        self.lease_until.is_some_and(|until| now < until)
    }

    /// Managed authority is held: open, lease live, notices subscribed. A blocked target
    /// still holds it, but pauses.
    fn held(&self, now: Instant) -> bool {
        self.open && self.notice_link && self.lease_live(now)
    }

    /// Managed access can be admitted now.
    pub fn available(&self, now: Instant) -> bool {
        self.held(now) && !self.blocked()
    }

    /// The check at every admission, dispatch and frame boundary.
    pub fn allows(&self, edge: EdgeId, expires: Instant, now: Instant) -> bool {
        self.available(now) && !self.is_fenced(edge) && now < expires
    }

    /// What a registered handler may do now.
    pub fn handler_state(&self, handler: u64, expires: Instant, now: Instant) -> GateState {
        let Some(entry) = self.handlers.get(&handler) else {
            return GateState::Closed;
        };
        // A handler told to close stays closed, even after authority recovers.
        if *entry.close.borrow()
            || !self.held(now)
            || self.is_fenced(entry.edge)
            || now >= self.handler_deadline(entry, expires, now)
        {
            GateState::Closed
        } else if self.blocked() {
            GateState::Paused
        } else {
            GateState::Open
        }
    }

    /// Whether a registered handler may still run now.
    pub fn handler_allowed(&self, handler: u64, expires: Instant, now: Instant) -> bool {
        self.handler_state(handler, expires, now) == GateState::Open
    }

    /// Admits a verified introspection and registers its handler in the same step, so a fence
    /// cannot fall between the check and the registration. `claims_revision` is the Gateway's
    /// committed revision when it read the token; `expires` is the token's expiry as a target
    /// monotonic deadline (see [`Self::local_deadline`]).
    #[expect(
        clippy::too_many_arguments,
        reason = "one atomic check of every admission input"
    )]
    pub fn admit(
        &mut self,
        edge: EdgeId,
        claims_revision: Revision,
        expires: Instant,
        epoch: u64,
        ticket: Option<TicketBinding>,
        now: Instant,
        _wall_ms: u64,
    ) -> Result<(u64, watch::Receiver<bool>), Refusal> {
        if epoch != self.epoch {
            return Err(Refusal::Stale);
        }
        if let Some(ticket) = ticket {
            // A ticket redeems only for its own edge and before its deadline. A fence of the
            // edge already deleted its unspent tickets.
            if ticket.edge != edge {
                return Err(Refusal::Fenced);
            }
            if now >= ticket.redeem_by {
                return Err(Refusal::Expired);
            }
            // Still reserved in the pool: no fence or fail-closed cancelled it meanwhile.
            if self.reserved_ticket(&ticket).is_none() {
                return Err(Refusal::Fenced);
            }
        }
        if !self.available(now) {
            return Err(Refusal::Unavailable);
        }
        if self.applied.is_none_or(|applied| claims_revision > applied) {
            self.note_revision(claims_revision, now);
            return Err(Refusal::Reconcile);
        }
        // Stricter than "not greater": the Gateway must have read the token at exactly the
        // applied revision. A reply read before a removal this target already applied can
        // then never admit the removed edge, so a confirmed fence is needed only until its
        // handlers drain and its ACK settles, and is pruned then (bounded memory).
        if self
            .applied
            .is_some_and(|applied| claims_revision < applied)
        {
            return Err(Refusal::Stale);
        }
        if self.is_fenced(edge) {
            return Err(Refusal::Fenced);
        }
        if now >= expires {
            return Err(Refusal::Expired);
        }
        // The redemption is consumed in the same step as the handler registers.
        if let Some(key) = ticket.and_then(|t| self.reserved_ticket(&t)) {
            self.tickets.remove(&key);
        }
        self.admitted.insert(edge);
        Ok(self.register(edge))
    }

    /// Records the Gateway expiry of a just-admitted handler.
    pub fn set_handler_expiry(&mut self, handler: u64, gateway_ms: u64) {
        if let Some(entry) = self.handlers.get_mut(&handler) {
            entry.expires_gateway_ms = Some(gateway_ms);
        }
    }

    /// The deadline a handler has now: its admission deadline, or an earlier one the last
    /// verified Gateway time sets.
    fn handler_deadline(&self, entry: &HandlerEntry, admitted: Instant, now: Instant) -> Instant {
        entry
            .expires_gateway_ms
            .map_or(admitted, |ms| admitted.min(self.local_deadline(ms, now, 0)))
    }

    /// A handler's deadline now, for its close timer.
    pub fn handler_deadline_of(&self, handler: u64, admitted: Instant, now: Instant) -> Instant {
        self.handlers
            .get(&handler)
            .map_or(now, |entry| self.handler_deadline(entry, admitted, now))
    }

    /// Closes every handler whose token expired by the Gateway's verified time.
    fn close_expired(&self, now: Instant) {
        for entry in self.handlers.values() {
            if entry
                .expires_gateway_ms
                .is_some_and(|ms| now >= self.local_deadline(ms, now, 0))
            {
                entry.close.send_replace(true);
            }
        }
    }

    fn register(&mut self, edge: EdgeId) -> (u64, watch::Receiver<bool>) {
        let id = self.next_handler;
        self.next_handler += 1;
        let (close, closed) = watch::channel(false);
        self.handlers.insert(
            id,
            HandlerEntry {
                edge,
                close,
                expires_gateway_ms: None,
            },
        );
        (id, closed)
    }

    /// A handler ended. Records the close time of every revision whose edges have no handler
    /// left.
    pub fn unregister(&mut self, handler: u64, now: Instant) -> Effects {
        let Some(entry) = self.handlers.remove(&handler) else {
            return Effects::default();
        };
        if let Some(fenced) = self.fenced_at.get(&entry.edge).copied()
            && !self.edge_has_handlers(entry.edge)
        {
            let elapsed = self.fence_mark.get(&entry.edge).map_or(0, |mark| {
                u64::try_from(now.saturating_duration_since(*mark).as_millis()).unwrap_or(u64::MAX)
            });
            self.closed_at
                .entry(entry.edge)
                .or_insert(fenced.saturating_add(elapsed));
        }
        let ack = self.settle_closes(0);
        self.sweep_confirmed();
        Effects {
            ack,
            ..Effects::default()
        }
    }

    fn edge_has_handlers(&self, edge: EdgeId) -> bool {
        self.handlers.values().any(|h| h.edge == edge)
    }

    /// Records `handlers_closed_ms` for fenced revisions whose edges all have no handler
    /// left: the latest of the edges' close times.
    fn settle_closes(&mut self, _wall_ms: u64) -> bool {
        let mut changed = false;
        for record in self.revisions.values_mut() {
            if record.handlers_closed_ms.is_some() || record.fenced_ms.is_none() {
                continue;
            }
            let times: Option<Vec<u64>> = record
                .edges
                .iter()
                .map(|e| self.closed_at.get(e).copied())
                .collect();
            if let Some(times) = times {
                record.handlers_closed_ms = Some(
                    times
                        .into_iter()
                        .max()
                        .unwrap_or_else(|| record.fenced_ms.unwrap_or_default()),
                );
                changed = true;
            }
        }
        changed
    }

    /// Blocks `edge` and tells each of its handlers to close.
    fn fence_edge(&mut self, edge: EdgeId, wall_ms: u64) {
        // The edge's unspent tickets go in the same step as its handlers.
        self.tickets.retain(|_, t| t.binding.edge != edge);
        self.fenced_at.entry(edge).or_insert(wall_ms);
        if let Some(now) = self.clock {
            self.fence_mark.entry(edge).or_insert(now);
        }
        self.admitted.remove(&edge);
        if !self.edge_has_handlers(edge) {
            self.closed_at.entry(edge).or_insert(wall_ms);
        }
        for handler in self.handlers.values() {
            if handler.edge == edge {
                handler.close.send_replace(true);
            }
        }
    }

    fn close_all_handlers(&self) {
        for handler in self.handlers.values() {
            handler.close.send_replace(true);
        }
    }

    /// Notes when a revision's edges were fenced, from the edges' own fence times.
    fn mark_revision_fenced(&mut self, revision: Revision, wall_ms: u64) {
        let fenced: Option<u64> = {
            let record = self.revisions.entry(revision).or_default();
            record
                .edges
                .iter()
                .map(|e| self.fenced_at.get(e).copied())
                .collect::<Option<Vec<u64>>>()
                .map(|times| times.into_iter().max().unwrap_or(wall_ms))
        };
        let record = self.revisions.entry(revision).or_default();
        if record.fenced_ms.is_none() {
            record.fenced_ms = Some(fenced.unwrap_or(wall_ms));
        }
    }

    /// Fails closed for all managed access. Recovery needs a snapshot with a live lease.
    pub fn fail_closed(&mut self, loss: Loss) {
        if self.open {
            self.last_loss = Some(loss);
        }
        self.open = false;
        self.lease_until = None;
        self.probe = None;
        self.tickets.clear();
        self.close_all_handlers();
    }

    /// The notice subscription came up or went down. Down fails closed.
    pub fn set_notice_link(&mut self, up: bool) -> Effects {
        self.notice_link = up;
        if !up {
            self.fail_closed(Loss::NoticeLinkClosed);
            return Effects::default();
        }
        Effects {
            probe_now: true,
            ..Effects::default()
        }
    }

    /// The independent lease timer, and every boundary that finds the lease over.
    pub fn check_lease(&mut self, now: Instant) {
        if self.open && !self.lease_live(now) {
            self.fail_closed(Loss::LeaseExpired);
        }
    }

    /// A `conn.authority.revoked` notice. It can only restrict access.
    pub fn notice(&mut self, notice: &Notice, now: Instant, wall_ms: u64) -> Effects {
        self.clock = Some(now);
        if notice.environment_id != self.environment_id || notice.generation != self.generation {
            self.fail_closed(Loss::WrongIdentity);
            return Effects::default();
        }
        let applied = self.applied.unwrap_or(0);
        let ahead = notice.revision > self.next_unknown();
        if (self.applied.is_some() && notice.revision <= applied)
            || self.notices.contains_key(&notice.revision)
            || self
                .revisions
                .get(&notice.revision)
                .is_some_and(|r| r.verified)
        {
            // Stale or duplicate.
            return Effects::default();
        }
        // Bounded, for new notices only: a flood fails closed instead of growing the
        // pending state.
        if notice.edge_ids.len() > MAX_NOTICE_EDGES || self.notices.len() >= MAX_PENDING_NOTICES {
            self.fail_closed(Loss::NoticeOverflow);
            return Effects {
                probe_now: true,
                ..Effects::default()
            };
        }
        for edge in &notice.edge_ids {
            self.provisional
                .entry(*edge)
                .or_default()
                .insert(notice.revision);
            self.fence_edge(*edge, wall_ms);
        }
        if ahead {
            // Revisions before this one are unknown: pause everything until a probe applies it
            // or disproves this notice.
            self.gap_notices.insert(notice.revision);
        }
        let record = self.revisions.entry(notice.revision).or_default();
        record.notice_received_ms.get_or_insert(wall_ms);
        self.notices.insert(
            notice.revision,
            NoticeRecord {
                edges: notice.edge_ids.clone(),
                received: now,
            },
        );
        if self.probe.is_some() {
            self.rerun = true;
        }
        Effects {
            probe_now: true,
            ..Effects::default()
        }
    }

    /// Starts the next probe, unless one runs. A snapshot probe raises the barrier epoch, so
    /// every outstanding introspection is dropped.
    pub fn begin_probe(&mut self, nonce: String, now: Instant, wall_ms: u64) -> Option<Probe> {
        if self.probe.is_some() {
            self.rerun = true;
            return None;
        }
        if !self.notice_link {
            return None;
        }
        self.rerun = false;
        let after_revision = if self.open { self.applied } else { None };
        if !self.open {
            self.epoch += 1;
        }
        let probe = Probe {
            nonce,
            after_revision,
            sent: now,
            sent_wall_ms: wall_ms,
        };
        self.probe = Some(probe.clone());
        Some(probe)
    }

    /// The probe got no usable answer: a transport error, a refusal or a timeout.
    pub fn probe_failed(&mut self, nonce: &str) {
        if self.probe.as_ref().is_some_and(|p| p.nonce == nonce) {
            self.probe = None;
            self.fail_closed(Loss::ProbeFailed);
        }
    }

    /// The call of probe `nonce` ended without a reply that matched it: retire it without
    /// renewing anything, so the next probe can go out.
    pub fn retire_probe(&mut self, nonce: &str) -> Effects {
        if self.probe.as_ref().is_some_and(|p| p.nonce == nonce) {
            // The next probe goes out on the timer, so a Gateway that keeps answering with
            // the wrong nonce is not hammered.
            self.probe = None;
        }
        Effects::default()
    }

    /// Applies a reply to the outstanding probe.
    pub fn apply_reply(&mut self, reply: &AuthorityReply, now: Instant, wall_ms: u64) -> Effects {
        self.clock = Some(now);
        let Some(probe) = self.probe.clone().filter(|p| p.nonce == reply.nonce) else {
            // Consumed or never sent: drop it, renew nothing.
            return Effects::default();
        };
        self.probe = None;
        if reply.environment_id != self.environment_id || reply.generation != self.generation {
            self.fail_closed(Loss::WrongIdentity);
            return self.after_reply();
        }
        // A reply after its lease ended cannot renew it or reopen access.
        self.check_lease(now);
        let new_lease = probe.sent + LEASE;
        if now >= new_lease {
            self.fail_closed(Loss::LeaseExpired);
            return self.after_reply();
        }
        // A reply without a readable server time or without its owed list is incomplete.
        if reply
            .server_time
            .as_deref()
            .and_then(conn_support::time::millis_from_iso)
            .is_none()
        {
            self.fail_closed(Loss::UnexpectedKind);
            return self.after_reply();
        }
        let first_snapshot = probe.after_revision.is_none() && self.snapshots == 0;
        let result = match (probe.after_revision, reply.kind.as_str()) {
            (None, "snapshot") if !self.open => self.apply_snapshot(reply, wall_ms),
            (Some(after), "delta") if self.open && self.applied == Some(after) => {
                self.apply_delta(after, reply, wall_ms)
            }
            (Some(after), "current") if self.open && self.applied == Some(after) => {
                if reply.head_revision == after {
                    Ok(())
                } else {
                    Err(Loss::MissingRevision)
                }
            }
            _ => Err(Loss::UnexpectedKind),
        };
        if let Err(loss) = result {
            self.fail_closed(loss);
            return self.after_reply();
        }
        if probe.after_revision.is_none() {
            self.snapshots += 1;
        }
        // An introspection that named a revision before this probe left proves the head
        // reached it: a head below it is a missing revision.
        if let Some((revision, noted)) = self.introspected {
            if self.applied.is_some_and(|applied| applied >= revision) {
                self.introspected = None;
            } else if noted < probe.sent {
                self.fail_closed(Loss::MissingRevision);
                return self.after_reply();
            }
        }
        self.apply_owed(&reply.owed, first_snapshot, wall_ms);
        self.prune_settled(reply.head_revision);
        // Only a `current` or `delta` reply disproves a notice; a snapshot keeps the
        // provisional fence, and the notice above its head asks for the next probe.
        if probe.after_revision.is_some() {
            self.disprove_notices(probe.sent, reply.head_revision, wall_ms);
        }
        let applied = self.applied;
        self.gap_notices.retain(|r| applied.is_none_or(|a| a < *r));
        self.record_offset(reply, probe.sent_wall_ms, wall_ms);
        // The Gateway sends microseconds: round its sample up, so the deadline errs early.
        if let Some(server) = reply.server_time.as_deref().and_then(ceil_millis_from_iso) {
            self.anchor = Some((probe.sent, server));
        }
        // A Gateway clock that moved ahead can end tokens sooner: close them now, idle or
        // stalled, rather than at their admission deadline.
        self.close_expired(now);
        self.open = true;
        self.lease_until = Some(new_lease);
        self.settle_closes(wall_ms);
        self.sweep_confirmed();
        self.after_reply()
    }

    /// Narrows the Gateway-to-target clock offset bounds: the Gateway read `server_time`
    /// between the probe's send and the reply's arrival.
    fn record_offset(&mut self, reply: &AuthorityReply, sent_ms: u64, received_ms: u64) {
        let Some(server) = reply
            .server_time
            .as_deref()
            .and_then(conn_support::time::millis_from_iso)
        else {
            return;
        };
        let (Ok(sent), Ok(received)) = (i64::try_from(sent_ms), i64::try_from(received_ms)) else {
            return;
        };
        // Every time here is truncated to the millisecond: widen by one on each side so the
        // interval still holds the true offset.
        let bounds = (server - received - 1, server - sent + 1);
        self.offset_bounds = Some(match self.offset_bounds {
            Some((low, high)) if bounds.0.max(low) <= bounds.1.min(high) => {
                (bounds.0.max(low), bounds.1.min(high))
            }
            _ => bounds,
        });
    }

    fn after_reply(&mut self) -> Effects {
        let known = self
            .notices
            .keys()
            .next_back()
            .copied()
            .max(self.introspected.map(|(r, _)| r));
        let behind = known.is_some_and(|k| self.applied.is_none_or(|a| k > a));
        let rerun = std::mem::take(&mut self.rerun);
        // Closed, recovery waits for the probe timer: a Gateway that keeps answering below a
        // proven revision is not probed at its round-trip speed.
        let probe_now = self.open && (rerun || behind);
        Effects {
            probe_now,
            ack: self.next_ack().is_some(),
        }
    }

    fn apply_snapshot(&mut self, reply: &AuthorityReply, wall_ms: u64) -> Result<(), Loss> {
        let Some(edges) = &reply.edges else {
            return Err(Loss::UnexpectedKind);
        };
        let head = reply.head_revision;
        // The same generation never goes back below a revision this target applied.
        if self.applied.is_some_and(|applied| head < applied) {
            return Err(Loss::MissingRevision);
        }
        let listed: HashSet<EdgeId> = edges.iter().map(|e| e.edge_id).collect();
        // Admitted before the barrier and gone now: confirm the fence.
        let gone: Vec<EdgeId> = self
            .admitted
            .iter()
            .copied()
            .filter(|e| !listed.contains(e))
            .collect();
        for edge in gone {
            self.confirmed.insert(edge);
            self.fence_edge(edge, wall_ms);
        }
        // Provisional fences of revisions the snapshot covers: confirmed when the edge is
        // gone, cleared when it is still listed.
        let covered: Vec<(EdgeId, Revision)> = self
            .provisional
            .iter()
            .flat_map(|(e, revisions)| revisions.iter().map(move |r| (*e, *r)))
            .filter(|(_, r)| *r <= head)
            .collect();
        for (edge, revision) in covered {
            if listed.contains(&edge) {
                self.clear_provisional(edge, revision);
            } else {
                self.provisional.remove(&edge);
                self.confirmed.insert(edge);
            }
        }
        self.notices.retain(|r, _| *r > head);
        // Listed edges are not admitted: each needs a fresh introspection.
        self.admitted.clear();
        self.applied = Some(head);
        Ok(())
    }

    fn apply_delta(
        &mut self,
        after: Revision,
        reply: &AuthorityReply,
        wall_ms: u64,
    ) -> Result<(), Loss> {
        let Some(revisions) = &reply.revisions else {
            return Err(Loss::UnexpectedKind);
        };
        let head = reply.head_revision;
        let contiguous = head > after
            && revisions.len() as u64 == head - after
            && revisions
                .iter()
                .enumerate()
                .all(|(i, r)| r.revision == after + 1 + i as u64);
        if !contiguous {
            return Err(Loss::MissingRevision);
        }
        for revision in revisions {
            self.apply_verified_revision(revision, wall_ms);
        }
        self.applied = Some(head);
        Ok(())
    }

    /// Verified state for one revision: confirm its edges, close what is still open, and
    /// clear the provisional fences of that revision it does not name.
    fn apply_verified_revision(&mut self, revision: &RevisionEdges, wall_ms: u64) {
        for edge in &revision.edge_ids {
            self.provisional.remove(edge);
            self.confirmed.insert(*edge);
            self.fence_edge(*edge, wall_ms);
        }
        let named: HashSet<EdgeId> = revision.edge_ids.iter().copied().collect();
        let unnamed: Vec<EdgeId> = self
            .provisional
            .iter()
            .filter(|(e, revisions)| revisions.contains(&revision.revision) && !named.contains(e))
            .map(|(e, _)| *e)
            .collect();
        for edge in unnamed {
            self.clear_provisional(edge, revision.revision);
        }
        self.notices.remove(&revision.revision);
        let record = self.revisions.entry(revision.revision).or_default();
        record.edges = named.into_iter().collect();
        record.verified = true;
        self.mark_revision_fenced(revision.revision, wall_ms);
    }

    fn apply_owed(&mut self, owed: &[RevisionEdges], first_snapshot: bool, wall_ms: u64) {
        self.owed.clear();
        for entry in owed {
            if first_snapshot {
                // A (re)started process observed no close: its handlers ended with the old
                // process, and no handler could open here before this snapshot.
                self.apply_verified_revision(entry, wall_ms);
                let record = self.revisions.entry(entry.revision).or_default();
                record.recovered_ms = Some(wall_ms);
                self.owed.insert(entry.revision);
                continue;
            }
            let known = self
                .revisions
                .get(&entry.revision)
                .is_some_and(|r| r.verified && r.fenced_ms.is_some());
            if !known {
                // Learned later in a running process: this process fences it now and measures
                // its own close. `recovered` is only for the first snapshot of a process.
                self.apply_verified_revision(entry, wall_ms);
            }
            self.owed.insert(entry.revision);
        }
    }

    /// A notice whose revision a later probe's head does not reach was not committed: clear
    /// its provisional fences. Only a probe sent after the notice arrived can disprove it.
    fn disprove_notices(&mut self, probe_sent: Instant, head: Revision, _wall_ms: u64) {
        let proven = self.introspected.map(|(r, _)| r);
        let disproved: Vec<Revision> = self
            .notices
            .iter()
            .filter(|(r, n)| **r > head && n.received < probe_sent)
            .filter(|(r, _)| proven.is_none_or(|p| **r > p))
            .map(|(r, _)| *r)
            .collect();
        for revision in disproved {
            self.gap_notices.remove(&revision);
            if let Some(notice) = self.notices.remove(&revision) {
                for edge in notice.edges {
                    self.clear_provisional(edge, revision);
                }
            }
            if self.revisions.get(&revision).is_some_and(|r| !r.verified) {
                self.revisions.remove(&revision);
            }
        }
    }

    /// The lowest owed revision that is ready to acknowledge, unless an ACK is in flight.
    pub fn next_ack(&self) -> Option<Ack> {
        if self.ack_in_flight.is_some() {
            return None;
        }
        let revision = *self.owed.iter().next()?;
        let record = self.revisions.get(&revision)?;
        if !record.verified {
            return None;
        }
        if let Some(recovered) = record.recovered_ms {
            if record.edges.iter().any(|e| self.edge_has_handlers(*e)) {
                return None;
            }
            return Some(Ack {
                revision,
                kind: AckKind::Recovered,
                notice_received_ms: None,
                fenced_ms: None,
                handlers_closed_ms: None,
                recovered_ms: Some(recovered),
            });
        }
        let closed = record.handlers_closed_ms?;
        Some(Ack {
            revision,
            kind: AckKind::Observed,
            notice_received_ms: record.notice_received_ms,
            fenced_ms: record.fenced_ms,
            handlers_closed_ms: Some(closed),
            recovered_ms: None,
        })
    }

    pub fn ack_started(&mut self, revision: Revision) {
        self.ack_in_flight = Some(revision);
    }

    /// The Gateway answered the ACK (`ok`) or it was lost. A lost ACK stays owed and is sent
    /// again while `owed` lists it.
    pub fn ack_finished(&mut self, revision: Revision, ok: bool) -> Effects {
        if self.ack_in_flight == Some(revision) {
            self.ack_in_flight = None;
        }
        if ok {
            self.owed.remove(&revision);
            self.prune(revision);
            self.sweep_confirmed();
        }
        Effects {
            ack: self.next_ack().is_some(),
            ..Effects::default()
        }
    }

    /// Drops the measurement record of a settled revision. The confirmed fence of its edges
    /// stays for the life of the generation.
    fn prune(&mut self, revision: Revision) {
        let Some(record) = self.revisions.remove(&revision) else {
            return;
        };
        for edge in record.edges {
            let referenced = self.revisions.values().any(|r| r.edges.contains(&edge));
            if !referenced
                && self.confirmed.contains(&edge)
                && !self.provisional.contains_key(&edge)
            {
                self.fenced_at.remove(&edge);
                self.fence_mark.remove(&edge);
                self.closed_at.remove(&edge);
            }
        }
    }

    /// A fresh verified reply that no longer owes a verified revision at or below its head
    /// settled it (its ACK answer may have been lost): drop its record.
    fn prune_settled(&mut self, head: Revision) {
        let settled: Vec<Revision> = self
            .revisions
            .iter()
            .filter(|(r, record)| {
                record.verified
                    && **r <= head
                    && !self.owed.contains(r)
                    && self.ack_in_flight != Some(**r)
            })
            .map(|(r, _)| *r)
            .collect();
        for revision in settled {
            self.prune(revision);
        }
    }

    /// Forgets confirmed fences that nothing needs any more: no handler of the edge is
    /// open, no unsettled revision names it, and no notice holds it. The strict admission
    /// rule (claims at exactly the applied revision) keeps a forgotten edge refused: the
    /// Gateway no longer has it.
    fn sweep_confirmed(&mut self) {
        let referenced: HashSet<EdgeId> = self
            .revisions
            .values()
            .flat_map(|r| r.edges.iter().copied())
            .collect();
        let open: HashSet<EdgeId> = self.handlers.values().map(|h| h.edge).collect();
        let done: Vec<EdgeId> = self
            .confirmed
            .iter()
            .copied()
            .filter(|e| {
                !referenced.contains(e) && !open.contains(e) && !self.provisional.contains_key(e)
            })
            .collect();
        for edge in done {
            self.confirmed.remove(&edge);
            self.fenced_at.remove(&edge);
            self.fence_mark.remove(&edge);
            self.closed_at.remove(&edge);
        }
    }

    /// Fences kept for the generation now.
    pub fn confirmed_fences(&self) -> usize {
        self.confirmed.len()
    }

    /// Records kept for unsettled revisions; settled ones are pruned.
    pub fn revision_records(&self) -> usize {
        self.revisions.len()
    }

    /// The wall time of the fence of `revision`, for the lab measurements.
    pub fn revision_times(&self, revision: Revision) -> Option<(Option<u64>, Option<u64>)> {
        self.revisions
            .get(&revision)
            .map(|r| (r.fenced_ms, r.handlers_closed_ms))
    }
}

#[cfg(test)]
#[path = "authority_tests.rs"]
mod tests;
