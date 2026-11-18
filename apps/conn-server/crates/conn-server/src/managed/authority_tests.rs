//! The authority rules, one contract row at a time.

use std::time::Duration;

use tokio::time::Instant;

use super::*;

const ENV: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
/// A token expiry far ahead of every test.
fn far() -> Instant {
    Instant::now() + Duration::from_secs(86_400)
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

struct Lab {
    a: Authority,
    t0: Instant,
    n: u64,
}

impl Lab {
    fn new() -> Self {
        let mut a = Authority::new(ENV.into(), 1);
        a.set_notice_link(true);
        Self {
            a,
            t0: Instant::now(),
            n: 0,
        }
    }

    fn at(&self, offset: u64) -> Instant {
        self.t0 + ms(offset)
    }

    fn probe(&mut self, at: u64) -> Probe {
        self.n += 1;
        self.a
            .begin_probe(format!("nonce-{}", self.n), self.at(at), at)
            .expect("no probe outstanding")
    }

    fn reply(&mut self, probe: &Probe, kind: &str, head: u64, at: u64) -> Effects {
        self.reply_with(probe, kind, head, None, None, vec![], at)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "a test helper that spells out a reply"
    )]
    fn reply_with(
        &mut self,
        probe: &Probe,
        kind: &str,
        head: u64,
        edges: Option<Vec<u64>>,
        revisions: Option<Vec<(u64, Vec<u64>)>>,
        owed: Vec<(u64, Vec<u64>)>,
        at: u64,
    ) -> Effects {
        let reply = AuthorityReply {
            nonce: probe.nonce.clone(),
            environment_id: ENV.into(),
            generation: 1,
            head_revision: head,
            server_time: Some(conn_support::time::iso_from_ms(at)),
            kind: kind.into(),
            edges: edges.map(|e| {
                e.into_iter()
                    .map(|edge_id| SnapshotEdge {
                        edge_id,
                        consumer_node_id: edge_id + 100,
                    })
                    .collect()
            }),
            revisions: revisions.map(|r| {
                r.into_iter()
                    .map(|(revision, edge_ids)| RevisionEdges { revision, edge_ids })
                    .collect()
            }),
            owed: owed
                .into_iter()
                .map(|(revision, edge_ids)| RevisionEdges { revision, edge_ids })
                .collect(),
        };
        self.a.apply_reply(&reply, self.at(at), at)
    }

    /// Snapshot at revision `head` listing `edges`, sent at `at`, applied 10 ms later.
    fn open(&mut self, head: u64, edges: Vec<u64>, at: u64) {
        let probe = self.probe(at);
        self.reply_with(&probe, "snapshot", head, Some(edges), None, vec![], at + 10);
        assert!(self.a.available(self.at(at + 10)));
    }

    fn admit(&mut self, edge: u64, at: u64) -> (u64, watch::Receiver<bool>) {
        let epoch = self.a.epoch();
        self.a
            .admit(
                edge,
                self.a.applied().unwrap_or(0),
                far(),
                epoch,
                None,
                self.at(at),
                at,
            )
            .expect("admitted")
    }

    /// A removed edge stays refused once its fence is settled and forgotten: a claim read
    /// before the applied revision is stale.
    fn refuses_stale(&mut self, edge: u64) -> bool {
        let applied = self.a.applied().unwrap_or(0);
        let epoch = self.a.epoch();
        applied > 0
            && matches!(
                self.a
                    .admit(edge, applied - 1, far(), epoch, None, self.t0, 0),
                Err(Refusal::Stale)
            )
    }

    fn notice(&mut self, revision: u64, edges: Vec<u64>, at: u64) -> Effects {
        self.a.notice(
            &Notice {
                environment_id: ENV.into(),
                generation: 1,
                revision,
                edge_ids: edges,
            },
            self.at(at),
            at,
        )
    }
}

#[test]
fn starts_closed_and_only_a_snapshot_opens_it() {
    let mut lab = Lab::new();
    assert!(!lab.a.available(lab.at(0)));
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(1, 0, far(), epoch, None, lab.at(0), 0)
            .unwrap_err(),
        Refusal::Unavailable
    );
    let probe = lab.probe(0);
    assert_eq!(
        probe.after_revision, None,
        "a closed target asks for a snapshot"
    );
    lab.reply_with(&probe, "snapshot", 4, Some(vec![1, 2]), None, vec![], 20);
    assert!(lab.a.available(lab.at(20)));
    assert_eq!(lab.a.applied(), Some(4));
    // The lease runs from the probe's send time, not the reply's arrival.
    assert_eq!(lab.a.lease_until(), Some(lab.at(0) + LEASE));
}

#[test]
fn a_next_revision_notice_fences_only_its_edges_at_once() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    let (_, closed_1) = lab.admit(1, 20);
    let (_, closed_2) = lab.admit(2, 20);
    let effects = lab.notice(1, vec![1], 100);
    assert!(effects.probe_now, "a notice asks for a probe");
    assert!(
        *closed_1.borrow(),
        "the revoked edge's handler is told to close"
    );
    assert!(!*closed_2.borrow(), "the other edge keeps its stream");
    assert!(lab.a.is_fenced(1));
    assert!(
        lab.a.available(lab.at(100)),
        "other edges keep their live lease"
    );
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(1, 0, far(), epoch, None, lab.at(100), 100)
            .unwrap_err(),
        Refusal::Fenced
    );
}

#[test]
fn stale_and_duplicate_notices_change_nothing() {
    let mut lab = Lab::new();
    lab.open(3, vec![1, 2], 0);
    assert_eq!(lab.notice(3, vec![2], 50), Effects::default(), "stale");
    assert!(!lab.a.is_fenced(2));
    lab.notice(4, vec![1], 60);
    assert_eq!(lab.notice(4, vec![2], 70), Effects::default(), "duplicate");
    assert!(!lab.a.is_fenced(2));
}

#[test]
fn a_revision_ahead_without_its_predecessor_blocks_everything() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    let (handler, _) = lab.admit(2, 10);
    lab.notice(2, vec![1], 50);
    assert!(!lab.a.available(lab.at(50)));
    assert!(!lab.a.handler_allowed(handler, far(), lab.at(50)));
    // A probe that applies the head unblocks it.
    let probe = lab.probe(60);
    lab.reply_with(
        &probe,
        "delta",
        2,
        None,
        Some(vec![(1, vec![]), (2, vec![1])]),
        vec![],
        70,
    );
    assert!(lab.a.available(lab.at(70)));
    assert!(lab.a.handler_allowed(handler, far(), lab.at(70)));
    assert!(lab.refuses_stale(1));
}

#[test]
fn a_delta_confirms_and_clears_what_it_does_not_name() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2, 3], 0);
    lab.notice(1, vec![1, 3], 50);
    let probe = lab.probe(60);
    lab.reply_with(
        &probe,
        "delta",
        1,
        None,
        Some(vec![(1, vec![1])]),
        vec![(1, vec![1])],
        70,
    );
    assert!(lab.a.is_confirmed(1));
    assert!(
        !lab.a.is_fenced(3),
        "a provisional ID the verified state does not name is cleared"
    );
    assert!(lab.a.available(lab.at(70)));
    // Edge 1 had no handler: its close is the fence itself, and the ACK is observed.
    let ack = lab.a.next_ack().expect("ack ready");
    assert_eq!(ack.revision, 1);
    assert_eq!(ack.kind, AckKind::Observed);
    assert_eq!(ack.notice_received_ms, Some(50));
    assert_eq!(ack.fenced_ms, Some(50));
    assert_eq!(ack.handlers_closed_ms, Some(50));
}

#[test]
fn the_ack_waits_for_the_last_handler_and_reports_its_close() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let (handler, _) = lab.admit(1, 5);
    lab.notice(1, vec![1], 50);
    let probe = lab.probe(60);
    lab.reply_with(
        &probe,
        "delta",
        1,
        None,
        Some(vec![(1, vec![1])]),
        vec![(1, vec![1])],
        70,
    );
    assert_eq!(lab.a.next_ack(), None, "a handler is still open");
    lab.a.unregister(handler, lab.at(90));
    let ack = lab.a.next_ack().expect("ack ready");
    assert_eq!(
        (ack.fenced_ms, ack.handlers_closed_ms),
        (Some(50), Some(90))
    );
    // A lost ACK stays owed; a confirmed one is settled.
    lab.a.ack_started(1);
    assert_eq!(lab.a.next_ack(), None, "one at a time");
    lab.a.ack_finished(1, false);
    assert!(lab.a.next_ack().is_some(), "sent again while owed");
    lab.a.ack_started(1);
    lab.a.ack_finished(1, true);
    assert_eq!(lab.a.next_ack(), None);
}

#[test]
fn a_notice_without_a_revision_is_disproved_only_by_a_later_probe() {
    let mut lab = Lab::new();
    lab.open(4, vec![1, 2], 0);
    // A probe sent before the notice arrived cannot clear it.
    let early = lab.probe(100);
    lab.notice(5, vec![2], 150);
    lab.reply(&early, "current", 4, 160);
    assert!(lab.a.is_fenced(2));
    // A probe sent after it, whose head is below the notice's revision, disproves it.
    let late = lab.probe(200);
    lab.reply(&late, "current", 4, 210);
    assert!(
        !lab.a.is_fenced(2),
        "the notice named a revision that does not exist"
    );
    assert!(lab.a.available(lab.at(210)));
}

#[test]
fn a_late_reply_cannot_renew_the_lease_or_reopen() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let probe = lab.probe(1_000);
    // The old lease ended at 3 s; this reply arrives after the new one would have too.
    lab.a.check_lease(lab.at(3_000));
    assert!(!lab.a.is_open(), "the lease timer failed closed at 3 s");
    lab.reply(&probe, "current", 0, 4_100);
    assert!(!lab.a.available(lab.at(4_100)));
}

#[test]
fn replies_with_another_nonce_are_dropped_and_renew_nothing() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let probe = lab.probe(1_000);
    let forged = Probe {
        nonce: "never-sent".into(),
        ..probe.clone()
    };
    lab.reply(&forged, "current", 0, 1_010);
    assert_eq!(lab.a.lease_until(), Some(lab.at(0) + LEASE), "not renewed");
    lab.reply(&probe, "current", 0, 1_020);
    assert_eq!(lab.a.lease_until(), Some(lab.at(1_000) + LEASE));
    // The same reply again: consumed, dropped.
    lab.reply(&probe, "current", 0, 1_030);
    assert!(lab.a.available(lab.at(1_030)));
}

#[test]
fn a_wrong_generation_or_a_missing_revision_fails_closed() {
    let mut lab = Lab::new();
    lab.open(2, vec![1], 0);
    let probe = lab.probe(100);
    lab.reply_with(
        &probe,
        "delta",
        4,
        None,
        Some(vec![(4, vec![1])]),
        vec![],
        110,
    );
    assert!(!lab.a.is_open(), "revision 3 is missing");
    assert_eq!(lab.a.last_loss, Some(Loss::MissingRevision));

    let mut lab = Lab::new();
    lab.open(2, vec![1], 0);
    let probe = lab.probe(100);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 2,
        head_revision: 2,
        server_time: Some(conn_support::time::iso_from_ms(110)),
        kind: "current".into(),
        edges: None,
        revisions: None,
        owed: vec![],
    };
    lab.a.apply_reply(&reply, lab.at(110), 110);
    assert!(!lab.a.is_open());
    assert_eq!(lab.a.last_loss, Some(Loss::WrongIdentity));
}

#[test]
fn after_failing_closed_only_a_snapshot_reopens_and_a_revoked_edge_stays_refused() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    let (_, closed_1) = lab.admit(1, 5);
    let (_, closed_2) = lab.admit(2, 5);
    let probe = lab.probe(1_000);
    lab.a.probe_failed(&probe.nonce);
    assert!(
        *closed_1.borrow() && *closed_2.borrow(),
        "all managed access fails closed"
    );
    // While closed the next probe is a snapshot, never a delta.
    let probe = lab.probe(2_000);
    assert_eq!(probe.after_revision, None);
    // Edge 1 was removed during the outage; the snapshot no longer lists it.
    lab.reply_with(
        &probe,
        "snapshot",
        1,
        Some(vec![2]),
        None,
        vec![(1, vec![1])],
        2_010,
    );
    assert!(lab.a.available(lab.at(2_010)));
    assert!(
        lab.a.is_confirmed(1),
        "the admitted edge the snapshot does not list is fenced"
    );
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(1, 1, far(), epoch, None, lab.at(2_020), 2_020)
            .unwrap_err(),
        Refusal::Fenced
    );
    assert!(
        lab.a
            .admit(2, 1, far(), epoch, None, lab.at(2_020), 2_020)
            .is_ok(),
        "the unrelated edge recovers"
    );
}

#[test]
fn a_restarted_target_sends_a_recovered_ack_for_each_owed_revision() {
    let mut lab = Lab::new();
    let probe = lab.probe(0);
    lab.reply_with(
        &probe,
        "snapshot",
        2,
        Some(vec![3]),
        None,
        vec![(1, vec![1]), (2, vec![2])],
        15,
    );
    let ack = lab.a.next_ack().expect("ack");
    assert_eq!(ack.revision, 1);
    assert_eq!(ack.kind, AckKind::Recovered);
    assert_eq!(ack.recovered_ms, Some(15));
    assert_eq!(
        (
            ack.fenced_ms,
            ack.handlers_closed_ms,
            ack.notice_received_ms
        ),
        (None, None, None)
    );
    lab.a.ack_started(1);
    lab.a.ack_finished(1, true);
    assert_eq!(lab.a.next_ack().map(|a| a.revision), Some(2));
    assert!(lab.refuses_stale(1) && lab.refuses_stale(2));
}

#[test]
fn admission_needs_the_claims_revision_and_the_current_barrier() {
    let mut lab = Lab::new();
    lab.open(3, vec![1], 0);
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(1, 3, lab.at(10), epoch, None, lab.at(10), 10)
            .unwrap_err(),
        Refusal::Expired
    );
    let (handler, _) = lab.admit(1, 10);
    assert_eq!(
        lab.a
            .admit(1, 5, far(), epoch, None, lab.at(10), 10)
            .unwrap_err(),
        Refusal::Reconcile,
        "the Gateway read a revision this target has not applied"
    );
    // Revisions 4 and 5 are unknown: every boundary pauses, without closing, until a probe
    // applies them.
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(11)),
        GateState::Paused
    );
    // A snapshot barrier drops introspections that started before it.
    let probe = lab.probe(20);
    lab.a.probe_failed(&probe.nonce);
    lab.open(5, vec![1], 30);
    assert_eq!(
        lab.a
            .admit(1, 3, far(), epoch, None, lab.at(50), 50)
            .unwrap_err(),
        Refusal::Stale
    );
}

#[test]
fn a_closed_notice_link_fails_closed_and_blocks_recovery_until_it_returns() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let (_, closed) = lab.admit(1, 5);
    lab.a.set_notice_link(false);
    assert!(*closed.borrow());
    assert!(
        lab.a.begin_probe("x".into(), lab.at(100), 100).is_none(),
        "no snapshot without the link"
    );
    lab.a.set_notice_link(true);
    lab.open(0, vec![1], 200);
}

#[test]
fn a_notice_of_another_generation_fails_closed() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    lab.a.notice(
        &Notice {
            environment_id: ENV.into(),
            generation: 2,
            revision: 1,
            edge_ids: vec![1],
        },
        lab.at(10),
        10,
    );
    assert!(!lab.a.is_open());
}

#[test]
fn a_notice_ahead_pauses_until_a_probe_applies_it_even_after_the_gap_fills() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2, 3], 0);
    let (handler, closed) = lab.admit(3, 5);
    lab.notice(12, vec![1], 50);
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(51)),
        GateState::Paused
    );
    assert!(
        !*closed.borrow(),
        "an unrelated stream pauses, it is not closed"
    );
    lab.notice(11, vec![2], 60);
    assert!(
        lab.a.blocked(),
        "notices never unblock; only a verified probe does"
    );
    let probe = lab.probe(70);
    lab.reply_with(
        &probe,
        "delta",
        12,
        None,
        Some(vec![(11, vec![2]), (12, vec![1])]),
        vec![],
        80,
    );
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(81)),
        GateState::Open
    );
}

#[test]
fn an_edge_named_by_two_notices_stays_fenced_until_both_are_settled() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2], 0);
    lab.notice(11, vec![1, 2], 50);
    // This probe left before notice 12 arrived, so its reply cannot disprove 12.
    let probe = lab.probe(55);
    lab.notice(12, vec![1], 60);
    let epoch = lab.a.epoch();
    // Revision 11 removed only edge 2; notice 12 still covers edge 1.
    lab.reply_with(
        &probe,
        "delta",
        11,
        None,
        Some(vec![(11, vec![2])]),
        vec![],
        80,
    );
    assert!(lab.a.is_fenced(1), "notice 12 still fences edge 1");
    assert!(lab.refuses_stale(2));
    // Clearing a provisional fence later drops introspections that started before it.
    let probe = lab.probe(1_000);
    lab.reply(&probe, "current", 11, 1_010);
    assert!(!lab.a.is_fenced(1), "notice 12 was disproved");
    assert_ne!(lab.a.epoch(), epoch);
}

#[test]
fn a_fence_deletes_its_edges_tickets_for_good() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    let t0 = lab.t0;
    let binding = move |edge, until: u64| TicketBinding {
        edge,
        redeem_by: t0 + Duration::from_millis(until),
        id: 0,
    };
    let (b1, b2) = (binding(1, 10_000), binding(2, 10_000));
    lab.a
        .mint_ticket("t1".into(), "tok1".into(), "rpc", b1, lab.at(10))
        .unwrap();
    lab.a
        .mint_ticket("t2".into(), "tok2".into(), "rpc", b2, lab.at(10))
        .unwrap();
    lab.notice(1, vec![1], 50);
    let probe = lab.probe(100);
    lab.reply(&probe, "current", 0, 110);
    assert!(!lab.a.is_fenced(1), "the notice was disproved");
    assert!(
        lab.a.take_ticket("t1", "rpc", lab.at(120)).is_none(),
        "the fence deleted it"
    );
    assert!(
        lab.a.take_ticket("t2", "media", lab.at(120)).is_none(),
        "wrong route: spent, refused"
    );
    assert_eq!(lab.a.ticket_count(), 0);
    // A fenced edge mints nothing; a full pool refuses with its own answer.
    lab.notice(1, vec![1], 200);
    assert_eq!(
        lab.a.mint_ticket(
            "t3".into(),
            "tok".into(),
            "rpc",
            binding(1, 10_000),
            lab.at(210)
        ),
        Err(MintRefusal::Fenced)
    );
    for n in 0..MAX_TICKETS {
        lab.a
            .mint_ticket(
                format!("p{n}"),
                "tok".into(),
                "rpc",
                binding(2, 10_000),
                lab.at(210),
            )
            .unwrap();
    }
    assert_eq!(
        lab.a.mint_ticket(
            "x".into(),
            "tok".into(),
            "rpc",
            binding(2, 10_000),
            lab.at(210)
        ),
        Err(MintRefusal::Full)
    );
    // Expired tickets leave the pool at the next mint.
    assert!(
        lab.a
            .mint_ticket(
                "y".into(),
                "tok".into(),
                "rpc",
                binding(2, 20_000),
                lab.at(10_001)
            )
            .is_ok()
    );
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(2, 0, far(), epoch, Some(binding(2, 100)), lab.at(120), 120)
            .unwrap_err(),
        Refusal::Expired,
        "the ticket's own deadline holds at registration"
    );
}

#[test]
fn a_stale_notice_at_the_notice_bound_changes_nothing() {
    let mut lab = Lab::new();
    lab.open(5, vec![1], 0);
    let (_, closed) = lab.admit(1, 5);
    for revision in 7..7 + MAX_PENDING_NOTICES as u64 {
        lab.notice(revision, vec![revision + 100], 10);
    }
    lab.notice(3, vec![1], 20);
    assert!(
        lab.a.is_open() && !*closed.borrow(),
        "a stale notice is ignored, even at the bound"
    );
}

#[test]
fn a_reply_with_a_wrong_nonce_retires_the_probe_without_renewing() {
    let mut lab = Lab::new();
    let probe = lab.probe(0);
    let forged = Probe {
        nonce: "never-sent".into(),
        ..probe.clone()
    };
    lab.reply_with(&forged, "snapshot", 0, Some(vec![1]), None, vec![], 10);
    lab.a.retire_probe(&probe.nonce);
    assert!(!lab.a.available(lab.at(10)));
    lab.open(0, vec![1], 1_000);
}

#[test]
fn a_notice_before_the_first_snapshot_still_gives_a_recovered_ack() {
    let mut lab = Lab::new();
    lab.notice(1, vec![1], 5);
    let probe = lab.probe(10);
    lab.reply_with(
        &probe,
        "snapshot",
        1,
        Some(vec![2]),
        None,
        vec![(1, vec![1])],
        20,
    );
    let ack = lab.a.next_ack().expect("ack");
    assert_eq!(ack.kind, AckKind::Recovered);
    assert_eq!(ack.recovered_ms, Some(20));
}

#[test]
fn settled_revisions_are_pruned_and_offset_bounds_recorded() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    lab.notice(1, vec![1], 50);
    let probe = lab.probe(60);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 1,
        head_revision: 1,
        server_time: Some(conn_support::time::iso_from_ms(1_000_065)),
        kind: "delta".into(),
        edges: None,
        revisions: Some(vec![RevisionEdges {
            revision: 1,
            edge_ids: vec![1],
        }]),
        owed: vec![RevisionEdges {
            revision: 1,
            edge_ids: vec![1],
        }],
    };
    lab.a.apply_reply(&reply, lab.at(70), 70);
    // Gateway clock minus target clock: between 1_000_065 - 70 and 1_000_065 - 60.
    assert_eq!(lab.a.offset_bounds(), Some((999_994, 1_000_006)));
    lab.a.ack_started(1);
    lab.a.ack_finished(1, true);
    assert_eq!(lab.a.revision_records(), 0);
    assert_eq!(
        lab.a.confirmed_fences(),
        0,
        "the settled fence is forgotten"
    );
    assert!(lab.refuses_stale(1), "and the edge stays refused");
}

#[test]
fn the_greatest_introspected_revision_holds_the_pause() {
    let mut lab = Lab::new();
    lab.open(10, vec![1], 0);
    let (handler, _) = lab.admit(1, 5);
    lab.a.note_revision(12, lab.at(10));
    let probe = lab.probe(20);
    lab.a.note_revision(13, lab.at(25));
    lab.reply_with(
        &probe,
        "delta",
        12,
        None,
        Some(vec![(11, vec![]), (12, vec![])]),
        vec![],
        30,
    );
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(31)),
        GateState::Paused,
        "13 is still unknown"
    );
    let probe = lab.probe(40);
    lab.reply_with(
        &probe,
        "delta",
        13,
        None,
        Some(vec![(13, vec![])]),
        vec![],
        50,
    );
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(51)),
        GateState::Open
    );
}

#[test]
fn a_disproved_gap_notice_ends_the_pause_without_a_probe_storm() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2], 0);
    let (handler, _) = lab.admit(2, 5);
    lab.notice(12, vec![1], 50);
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(51)),
        GateState::Paused
    );
    let probe = lab.probe(100);
    let effects = lab.reply(&probe, "current", 10, 110);
    assert!(!effects.probe_now, "no endless probing");
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(111)),
        GateState::Open
    );
}

#[test]
fn token_expiry_is_a_local_deadline_on_the_safe_side_of_the_offset() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    // The opening snapshot read the Gateway at 10 between sends at 0 and 10: up to 10 ahead.
    assert_eq!(lab.a.offset_bounds(), Some((-1, 11)));
    assert_eq!(lab.a.local_deadline(10_000, lab.at(0), 0), lab.at(9_990));
    let probe = lab.probe(1_000);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 1,
        head_revision: 0,
        server_time: Some(conn_support::time::iso_from_ms(6_005)),
        kind: "current".into(),
        edges: None,
        revisions: None,
        owed: vec![],
    };
    lab.a.apply_reply(&reply, lab.at(1_010), 1_010);
    // The Gateway runs 4,995 to 5,005 ms ahead: its expiry comes up to 5,005 ms sooner here.
    assert_eq!(lab.a.offset_bounds(), Some((4_994, 5_006)));
    assert_eq!(
        lab.a.local_deadline(20_000, lab.at(1_010), 1_010),
        lab.at(1_010 + 20_000 - 5_005 - 1_010)
    );
    // The deadline comes from the probe's monotonic send and the verified Gateway time: a
    // step of the target's wall clock does not move it.
    assert_eq!(
        lab.a.local_deadline(20_000, lab.at(1_010), 0),
        lab.a.local_deadline(20_000, lab.at(1_010), 1_000_000)
    );
}

#[test]
fn notices_never_release_a_pause_an_introspection_started() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2, 3], 0);
    let (handler, _) = lab.admit(3, 5);
    lab.a.note_revision(12, lab.at(10));
    lab.notice(11, vec![1], 20);
    lab.notice(12, vec![2], 30);
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(31)),
        GateState::Paused
    );
    let probe = lab.probe(40);
    lab.reply_with(
        &probe,
        "delta",
        12,
        None,
        Some(vec![(11, vec![1]), (12, vec![2])]),
        vec![],
        50,
    );
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(51)),
        GateState::Open
    );
}

#[test]
fn a_close_never_precedes_its_fence_when_the_wall_clock_steps_back() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 4_900);
    let (handler, _) = lab.admit(1, 4_950);
    // The fence happens at wall 5,000. The close is the fence plus 40 ms of monotonic time,
    // whatever the wall clock reads when the handler ends.
    lab.notice(1, vec![1], 5_000);
    lab.a.unregister(handler, lab.at(5_040));
    let probe = lab.probe(5_100);
    lab.reply_with(
        &probe,
        "delta",
        1,
        None,
        Some(vec![(1, vec![1])]),
        vec![(1, vec![1])],
        5_110,
    );
    let ack = lab.a.next_ack().expect("ack");
    assert_eq!(
        (ack.fenced_ms, ack.handlers_closed_ms),
        (Some(5_000), Some(5_040))
    );
}

#[test]
fn a_revision_learned_by_a_later_snapshot_is_observed_with_its_times() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    let probe = lab.probe(100);
    lab.a.probe_failed(&probe.nonce);
    // Edge 2 went during the outage; this process never admitted it.
    let probe = lab.probe(200);
    lab.reply_with(
        &probe,
        "snapshot",
        1,
        Some(vec![1]),
        None,
        vec![(1, vec![2])],
        210,
    );
    let ack = lab.a.next_ack().expect("ack");
    assert_eq!(ack.kind, AckKind::Observed);
    assert_eq!(
        (ack.fenced_ms, ack.handlers_closed_ms),
        (Some(210), Some(210))
    );
}

#[test]
fn a_settled_revision_whose_ack_answer_was_lost_is_pruned() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    lab.notice(1, vec![1], 50);
    let probe = lab.probe(60);
    lab.reply_with(
        &probe,
        "delta",
        1,
        None,
        Some(vec![(1, vec![1])]),
        vec![(1, vec![1])],
        70,
    );
    lab.a.ack_started(1);
    lab.a.ack_finished(1, false);
    assert_eq!(lab.a.revision_records(), 1);
    // The Gateway did settle it; the next verified reply no longer owes it.
    let probe = lab.probe(1_000);
    lab.reply(&probe, "current", 1, 1_010);
    assert_eq!(lab.a.revision_records(), 0);
    assert_eq!(lab.a.next_ack(), None);
    assert!(lab.refuses_stale(1));
}

#[test]
fn an_introspected_revision_keeps_its_notice_and_a_lower_head_fails_closed() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2], 0);
    lab.notice(11, vec![1], 50);
    lab.a.note_revision(11, lab.at(60));
    // A probe sent after both reports head 10: it cannot disprove 11, which HTTPS proved.
    let probe = lab.probe(100);
    lab.reply(&probe, "current", 10, 110);
    assert!(
        !lab.a.is_open(),
        "a head below a proven revision is a missing revision"
    );
    assert!(lab.a.is_fenced(1), "the notice's fence stays");
    // Closed, it does not probe again at round-trip speed.
    let probe = lab.probe(1_000);
    let effects = lab.reply_with(
        &probe,
        "snapshot",
        10,
        Some(vec![1, 2]),
        None,
        vec![],
        1_010,
    );
    assert!(!effects.probe_now, "recovery waits for the timer");
    assert!(
        !lab.a.is_open(),
        "a snapshot below the proven revision does not reopen"
    );
}

#[test]
fn an_incomplete_reply_renews_nothing() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let probe = lab.probe(1_000);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 1,
        head_revision: 0,
        server_time: None,
        kind: "current".into(),
        edges: None,
        revisions: None,
        owed: vec![],
    };
    lab.a.apply_reply(&reply, lab.at(1_010), 1_010);
    assert!(!lab.a.is_open(), "no server time, no lease");
    let without_owed = serde_json::json!({"nonce": "n", "environment_id": ENV, "generation": 1,
        "head_revision": 0, "server_time": "2026-11-18T00:00:00.000000+00:00", "kind": "current"});
    assert!(serde_json::from_value::<AuthorityReply>(without_owed).is_err());
}

#[test]
fn a_snapshot_below_the_applied_revision_does_not_reopen() {
    let mut lab = Lab::new();
    lab.open(12, vec![1], 0);
    let probe = lab.probe(100);
    lab.a.probe_failed(&probe.nonce);
    let probe = lab.probe(200);
    lab.reply_with(&probe, "snapshot", 10, Some(vec![1]), None, vec![], 210);
    assert!(!lab.a.is_open());
    assert_eq!(lab.a.applied(), Some(12));
}

#[test]
fn a_gateway_behind_the_target_does_not_expire_tokens_early() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 39_000);
    let probe = lab.probe(40_000);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 1,
        head_revision: 0,
        // The Gateway is 30 s behind: it reads 10,005 while the target reads 40,000..40,010.
        server_time: Some(conn_support::time::iso_from_ms(10_005)),
        kind: "current".into(),
        edges: None,
        revisions: None,
        owed: vec![],
    };
    lab.a.apply_reply(&reply, lab.at(40_010), 40_010);
    assert_eq!(lab.a.offset_bounds(), Some((-30_006, -29_994)));
    // A token the Gateway says ends at 30,005 (20 s from its now) ends here no sooner than
    // 30,005 + 29,995: the earliest target time the Gateway can read 30,005.
    assert_eq!(lab.a.local_wall_ms(30_005), 59_999);
}

#[test]
fn a_handler_told_to_close_stays_closed_after_recovery() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    // Its receiver is gone: the close must still be recorded.
    let (handler, _) = lab.admit(1, 5);
    let probe = lab.probe(100);
    lab.a.probe_failed(&probe.nonce);
    lab.open(0, vec![1], 200);
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(211)),
        GateState::Closed
    );
}

#[test]
fn a_recovery_snapshot_keeps_a_provisional_fence_above_its_head() {
    let mut lab = Lab::new();
    lab.open(10, vec![1, 2], 0);
    let probe = lab.probe(100);
    lab.a.probe_failed(&probe.nonce);
    lab.notice(11, vec![1], 150);
    let probe = lab.probe(200);
    let effects = lab.reply_with(&probe, "snapshot", 10, Some(vec![1, 2]), None, vec![], 210);
    assert!(
        lab.a.is_fenced(1),
        "only a current or delta reply disproves a notice"
    );
    assert!(
        effects.probe_now,
        "the notice above the head asks for the next probe"
    );
    let probe = lab.probe(300);
    lab.reply(&probe, "current", 10, 310);
    assert!(
        !lab.a.is_fenced(1),
        "disproved by a current reply sent after it"
    );
}

#[test]
fn a_gateway_time_with_microseconds_rounds_up() {
    assert_eq!(
        ceil_millis_from_iso("2026-11-18T12:00:00.999900+00:00"),
        conn_support::time::millis_from_iso("2026-11-18T12:00:01.000+00:00")
    );
    assert_eq!(
        ceil_millis_from_iso("2026-11-18T12:00:00.999000+00:00"),
        conn_support::time::millis_from_iso("2026-11-18T12:00:00.999Z")
    );
}

#[test]
fn a_gateway_clock_that_moves_ahead_ends_open_handlers_at_once() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let (handler, closed) = lab.admit(1, 5);
    // The token ends at Gateway time 60,000: about a minute from now.
    lab.a.set_handler_expiry(handler, 60_000);
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(10)),
        GateState::Open
    );
    // The next probe finds the Gateway two minutes ahead: the token is over there.
    let probe = lab.probe(1_000);
    let reply = AuthorityReply {
        nonce: probe.nonce,
        environment_id: ENV.into(),
        generation: 1,
        head_revision: 0,
        server_time: Some(conn_support::time::iso_from_ms(121_000)),
        kind: "current".into(),
        edges: None,
        revisions: None,
        owed: vec![],
    };
    lab.a.apply_reply(&reply, lab.at(1_010), 1_010);
    assert!(lab.a.is_open(), "the lease is live");
    assert!(*closed.borrow(), "the idle handler is told to close");
    assert_eq!(
        lab.a.handler_state(handler, far(), lab.at(1_011)),
        GateState::Closed
    );
}

#[test]
fn a_claim_read_before_an_applied_removal_is_stale_and_settled_fences_are_forgotten() {
    let mut lab = Lab::new();
    lab.open(0, vec![1, 2], 0);
    lab.notice(1, vec![1], 50);
    let probe = lab.probe(60);
    lab.reply_with(
        &probe,
        "delta",
        1,
        None,
        Some(vec![(1, vec![1])]),
        vec![(1, vec![1])],
        70,
    );
    lab.a.ack_started(1);
    lab.a.ack_finished(1, true);
    // Settled and no handler left: the fence is forgotten, memory stays bounded.
    assert_eq!(lab.a.confirmed_fences(), 0);
    let epoch = lab.a.epoch();
    // A reply the Gateway read at revision 0, before the removal: refused as stale.
    assert_eq!(
        lab.a
            .admit(1, 0, far(), epoch, None, lab.at(80), 80)
            .unwrap_err(),
        Refusal::Stale
    );
    // The unrelated edge, read at the applied revision, is admitted.
    assert!(
        lab.a
            .admit(2, 1, far(), epoch, None, lab.at(80), 80)
            .is_ok()
    );
}

#[test]
fn many_removals_keep_no_state_once_settled() {
    let mut lab = Lab::new();
    lab.open(0, vec![], 0);
    let mut at = 10;
    for revision in 1..=500u64 {
        lab.notice(revision, vec![1_000 + revision], at);
        let probe = lab.probe(at + 1);
        lab.reply_with(
            &probe,
            "delta",
            revision,
            None,
            Some(vec![(revision, vec![1_000 + revision])]),
            vec![(revision, vec![1_000 + revision])],
            at + 2,
        );
        lab.a.ack_started(revision);
        lab.a.ack_finished(revision, true);
        at += 5;
    }
    assert_eq!(lab.a.confirmed_fences(), 0);
    assert_eq!(lab.a.revision_records(), 0);
}

#[test]
fn a_notice_flood_fails_closed_without_growing() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    for revision in 2..2 + MAX_PENDING_NOTICES as u64 {
        lab.notice(revision, vec![revision], 10);
    }
    assert!(lab.a.is_open(), "within the bound");
    lab.notice(5_000, vec![5_000], 20);
    assert!(!lab.a.is_open(), "past it, everything fails closed");
    assert!(
        !lab.a.is_fenced(5_000),
        "and the overflowing notice is not kept"
    );
    let wide: Vec<u64> = (0..=MAX_NOTICE_EDGES as u64).collect();
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    lab.notice(1, wide, 30);
    assert!(!lab.a.is_open());
}

/// A redemption in progress is cancelled by a fail-closed that lands during its
/// introspection: after recovery, the reserved ticket is gone and admission refuses it.
#[test]
fn a_redemption_in_flight_does_not_survive_a_fence() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let binding = TicketBinding {
        edge: 1,
        redeem_by: lab.at(10_000),
        id: 0,
    };
    lab.a
        .mint_ticket("t1".into(), "tok".into(), "rpc", binding, lab.at(10))
        .unwrap();
    let (_, reserved) = lab
        .a
        .take_ticket("t1", "rpc", lab.at(20))
        .expect("reserved");
    assert_eq!(
        lab.a.ticket_count(),
        1,
        "still in the pool while it is redeemed"
    );
    // The control link drops while the redemption's introspection is out; then it recovers.
    lab.a.set_notice_link(false);
    lab.a.set_notice_link(true);
    lab.open(0, vec![1], 100);
    let epoch = lab.a.epoch();
    assert_eq!(
        lab.a
            .admit(1, 0, far(), epoch, Some(reserved), lab.at(110), 110)
            .unwrap_err(),
        Refusal::Fenced,
        "the fail-closed cancelled the redemption"
    );
    // A clean redemption is consumed when its handler registers.
    lab.a
        .mint_ticket("t2".into(), "tok".into(), "rpc", binding, lab.at(120))
        .unwrap();
    let (_, reserved) = lab
        .a
        .take_ticket("t2", "rpc", lab.at(121))
        .expect("reserved");
    assert!(
        lab.a
            .admit(1, 0, far(), epoch, Some(reserved), lab.at(122), 122)
            .is_ok()
    );
    assert_eq!(lab.a.ticket_count(), 0);
}

#[test]
fn a_ticket_is_redeemed_once() {
    let mut lab = Lab::new();
    lab.open(0, vec![1], 0);
    let binding = TicketBinding {
        edge: 1,
        redeem_by: lab.at(10_000),
        id: 0,
    };
    lab.a
        .mint_ticket("t1".into(), "tok".into(), "rpc", binding, lab.at(10))
        .unwrap();
    assert!(lab.a.take_ticket("t1", "rpc", lab.at(20)).is_some());
    assert!(
        lab.a.take_ticket("t1", "rpc", lab.at(21)).is_none(),
        "one redemption at a time"
    );
}
