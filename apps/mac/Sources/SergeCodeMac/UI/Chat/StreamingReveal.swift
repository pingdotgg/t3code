import Foundation

/// Pacing policy for the smooth streaming-text reveal.
///
/// Provider deltas arrive pre-batched at ~30 Hz (see `LiveBackend` and
/// `AppModel` flushes), and model output itself is bursty. Rendering each
/// burst as it lands makes the tail of a message jump, then stall, then
/// jump again. Instead the view buffers the incoming string and reveals it
/// a few bytes per display frame, paced by this policy.
///
/// The policy deliberately trades time-to-first-token for an even glide:
/// this is a coding client, not a chat toy, so a few extra seconds of lag
/// behind the stream is fine if the text never visibly stutters. Three
/// mechanisms do that:
///
/// 1. A warm-up hold buffers the first burst of a live stream before
///    revealing anything, so short responses effectively appear all at
///    once (at stream end) and then type out smoothly.
/// 2. A multi-second catch-up window spreads every burst over seconds at
///    a slowly-varying rate instead of ~150 ms, keeping the reveal speed
///    nearly constant while the stream is live.
/// 3. A faster final window drains the remaining backlog briskly once the
///    stream ends, so a finished message never trails for long.
///
/// Pure and SwiftUI-free so the pacing is directly testable, the same
/// split `MotionProfile` and `EntrancePolicy` use.
struct StreamingRevealPolicy: Equatable, Sendable {
    let reduceMotion: Bool
    /// True once the message's stream has ended. A final target skips the
    /// warm-up hold (a short response buffered in full should start its
    /// glide immediately) and drains its backlog over `finalCatchUpWindow`.
    let isFinal: Bool

    init(reduceMotion: Bool, isFinal: Bool = false) {
        self.reduceMotion = reduceMotion
        self.isFinal = isFinal
    }

    /// Seconds of backlog the reveal keeps behind a live stream. Long on
    /// purpose: the lag stays roughly this many seconds no matter how
    /// bursty the deltas are, so the on-screen rate barely changes when a
    /// chunk lands. Bursts are absorbed into the backlog, not flashed.
    let catchUpWindow = 4.0
    /// Once the stream ends, the remaining backlog glides out over this
    /// shorter window — the message is done, so the tail should finish in
    /// a couple of seconds rather than trail by the full live window.
    let finalCatchUpWindow = 1.5
    /// A live stream reveals nothing until this many bytes have buffered.
    /// Roughly two lines of text: long enough that the first reveal starts
    /// with a comfortable runway, short enough that a model emits it in a
    /// second or two. Final targets skip the hold entirely.
    ///
    /// Static as well as instance-readable because `StreamingRevealAdoption`
    /// reuses it as the "more text than a fresh stream could have buffered"
    /// threshold, and the two must not drift apart.
    static let warmUpStartBytes = 480
    var warmUpStartBytes: Int { Self.warmUpStartBytes }
    /// Floor on reveal speed so a slow trickle still glides instead of
    /// stalling between flushes. ~2 bytes per frame at 120 Hz.
    let minRevealBytesPerSecond = 240.0
    /// Above this backlog the reveal snaps to the target immediately —
    /// hydration, reconnect replays, and huge pastes must never type out
    /// seconds behind reality. Well above any backlog a live stream can
    /// accumulate at the `catchUpWindow` lag, so normal streaming never
    /// snaps mid-message.
    let instantSnapBacklog = 16_384

    /// Next reveal position as a UTF-8 byte count into the target. `current`
    /// is the policy's own desired position (which may sit inside a grapheme;
    /// the store rounds down to a `Character` boundary when materializing).
    func advancedRevealCount(
        current: Int,
        target: Int,
        elapsed: TimeInterval
    ) -> Int {
        guard !reduceMotion else { return target }
        let backlog = target - current
        guard backlog > 0 else { return current }
        if backlog >= instantSnapBacklog { return target }
        // Warm-up hold: a live stream stays hidden until enough has
        // buffered to glide without immediately starving. Once revealing
        // (or once the stream is final) this never applies again.
        if current == 0 && !isFinal && target < warmUpStartBytes { return 0 }

        let dt = max(0, min(elapsed, 0.1))
        let window = isFinal ? finalCatchUpWindow : catchUpWindow
        let catchUpStep = Double(backlog) * (dt / window)
        let minStep = minRevealBytesPerSecond * dt
        let step = max(1, Int(max(catchUpStep, minStep).rounded(.up)))
        return min(target, current + step)
    }
}

/// When buffered backlog stops being *arriving* text and has to be adopted
/// wholesale instead of typed out.
///
/// The reveal exists to smooth arrival: bursty ~30 Hz flushes glide onto the
/// screen instead of jumping. That contract only holds while somebody is
/// watching. Two situations leave a session holding text nobody saw arrive,
/// and typing those out is what reads as a finished message regenerating
/// itself:
///
/// 1. The session stopped ticking. A mounted, visible reveal advances every
///    display frame; a gap means the view driving it went away — the thread
///    was deselected, or the `LazyVStack` un-realized the row — while the
///    stream kept running without it.
/// 2. The session was created against a message that was already substantial,
///    which is exactly what selecting a thread mid-run does.
///
/// Pure and SwiftUI-free for the same reason `StreamingRevealPolicy` is.
struct StreamingRevealAdoption: Equatable, Sendable {
    /// Longest gap between ticks that still counts as a live reveal. Two
    /// 30 Hz flushes are 33 ms apart and a display tick is 8 ms, so this is
    /// an order of magnitude above anything a watched stream produces while
    /// staying short enough that a glance away and back adopts.
    let staleTickInterval: TimeInterval = 0.75

    /// Byte count at or above which a *newly created* session adopts its
    /// target rather than typing it. A genuinely fresh stream's first render
    /// happens at its first flush, far below the warm-up buffer; a session
    /// created against more text than that hold would ever accumulate means
    /// the view mounted into a message that already existed.
    let mountAdoptionBytes = StreamingRevealPolicy.warmUpStartBytes

    /// A brand-new session for an already-substantial message adopts it.
    func shouldAdoptOnCreate(targetUTF8Count: Int) -> Bool {
        targetUTF8Count >= mountAdoptionBytes
    }

    /// An existing session that has not ticked recently adopts whatever
    /// arrived while it was not being driven.
    func shouldAdoptOnResume(lastTick: Date?, now: Date) -> Bool {
        guard let lastTick else { return false }
        return now.timeIntervalSince(lastTick) > staleTickInterval
    }
}

/// Per-message reveal state backing the smooth streaming text render.
///
/// Keyed by (scopedThreadKey, messageID) like `StreamingMarkdownCache`, so
/// the reveal survives view recreation (a `LazyVStack` un-realizing and
/// re-realizing the tail row mid-stream) instead of rewinding to empty — but
/// only for as long as something keeps driving it. Once it goes quiet, or
/// once it opens against a message that already has real text,
/// `StreamingRevealAdoption` takes over and the store snaps rather than
/// replaying text nobody was there to watch arrive.
///
/// `revealed` is always a grapheme-safe prefix of every target seen so far,
/// which is exactly the append-only invariant `StreamingMarkdownCache`
/// requires of its input; adopting a whole target preserves that.
@MainActor
enum StreamingRevealStore {
    private struct SessionKey: Equatable {
        let threadID: String
        let messageID: String
    }

    private static var sessions: [String: [String: StreamingRevealSession]] = [:]
    private static var insertionOrder: [SessionKey] = []
    private static let maxSessionCount = 8
    private static let adoption = StreamingRevealAdoption()

    /// Times a session detected a non-append-only target and restarted.
    private(set) static var resetCount = 0
    /// Times a session adopted its target instead of typing it out — the
    /// thread-switch and scrolled-away cases. Exposed so tests can prove the
    /// adoption actually fired rather than inferring it from the text.
    private(set) static var adoptionCount = 0

    /// The currently revealed prefix. Runs the divergence and staleness
    /// checks but does not advance the reveal; call `advance` from a
    /// display-linked tick for that.
    static func revealed(
        threadID: String, messageID: String, target: String, at now: Date = Date()
    ) -> String {
        let session = session(threadID: threadID, messageID: messageID, target: target, at: now)
        if diverged(session: session, target: target) {
            reset(session)
        }
        if adoption.shouldAdoptOnResume(lastTick: session.lastTick, now: now) {
            adopt(session, target: target, at: now)
        }
        return session.revealed
    }

    /// Advances the reveal toward `target` per `policy`. Returns true when
    /// the revealed text changed and the view should re-render.
    static func advance(
        threadID: String,
        messageID: String,
        target: String,
        at now: Date,
        policy: StreamingRevealPolicy
    ) -> Bool {
        let session = session(threadID: threadID, messageID: messageID, target: target, at: now)
        if diverged(session: session, target: target) {
            reset(session)
        }
        // Nobody drove this session for a while — the thread was deselected,
        // or the row scrolled out — so the backlog is history, not arrival.
        if adoption.shouldAdoptOnResume(lastTick: session.lastTick, now: now) {
            return adopt(session, target: target, at: now)
        }

        let targetCount = target.utf8.count
        let elapsed = session.lastTick.map { now.timeIntervalSince($0) } ?? (1.0 / 60)
        session.lastTick = now

        session.desiredUTF8Count = policy.advancedRevealCount(
            current: session.desiredUTF8Count, target: targetCount, elapsed: elapsed)
        // Desired advances on a raw byte budget and can sit mid-grapheme;
        // materialize only down to a Character boundary so no partial emoji
        // or combining sequence ever renders.
        let newCount = graphemeSafeRevealCount(of: target, utf8ByteCount: session.desiredUTF8Count)
        guard newCount > session.revealedUTF8Count else { return false }

        let utf8 = target.utf8
        let from = utf8.index(utf8.startIndex, offsetBy: session.revealedUTF8Count)
        let to = utf8.index(utf8.startIndex, offsetBy: newCount)
        session.revealed += String(decoding: utf8[from..<to], as: UTF8.self)
        session.revealedUTF8Count = newCount
        session.fingerprint = Array(session.revealed.utf8.suffix(64))
        return true
    }

    /// True when a session exists with unrevealed backlog for `target`.
    /// Lets a message whose stream has just ended keep rendering through
    /// the reveal path until the buffered text has fully glided out, so
    /// completion never pops the remaining tail in at once. Creates no
    /// session, so finished messages rendered from history stay settled.
    ///
    /// A stale session adopts here rather than reporting backlog: this is the
    /// question `AssistantMarkdownView.init` asks when a row mounts, and
    /// answering "yes" for a thread the user left mid-run and came back to
    /// after it finished is what made a settled message type itself out again.
    static func hasPendingReveal(
        threadID: String, messageID: String, target: String, at now: Date = Date()
    ) -> Bool {
        guard let session = sessions[threadID]?[messageID] else { return false }
        if diverged(session: session, target: target) {
            reset(session)
        }
        if adoption.shouldAdoptOnResume(lastTick: session.lastTick, now: now) {
            adopt(session, target: target, at: now)
        }
        return session.revealedUTF8Count < target.utf8.count
    }

    static func finish(threadID: String, messageID: String) {
        guard var threadSessions = sessions[threadID], threadSessions[messageID] != nil else {
            return
        }
        threadSessions[messageID] = nil
        sessions[threadID] = threadSessions.isEmpty ? nil : threadSessions
        insertionOrder.removeAll { $0.threadID == threadID && $0.messageID == messageID }
    }

    static func evict(threadID: String) {
        sessions[threadID] = nil
        insertionOrder.removeAll { $0.threadID == threadID }
    }

    static func resetForTesting() {
        sessions.removeAll(keepingCapacity: true)
        insertionOrder.removeAll(keepingCapacity: true)
        resetCount = 0
        adoptionCount = 0
    }

    /// Edit-in-place and hydration can replace a target rather than append to
    /// it. Detect that the way `StreamingMarkdownCache` does: an O(1)
    /// trailing-window comparison at the reveal position instead of a full
    /// prefix scan.
    private static func diverged(session: StreamingRevealSession, target: String) -> Bool {
        let count = session.revealedUTF8Count
        guard count > 0 else { return false }
        let utf8 = target.utf8
        guard count <= utf8.count else { return true }
        let window = session.fingerprint
        guard !window.isEmpty else { return false }
        let end = utf8.index(utf8.startIndex, offsetBy: count)
        let start = utf8.index(end, offsetBy: -window.count)
        return !utf8[start..<end].elementsEqual(window)
    }

    private static func reset(_ session: StreamingRevealSession) {
        session.revealed = ""
        session.revealedUTF8Count = 0
        session.desiredUTF8Count = 0
        session.fingerprint = []
        resetCount += 1
    }

    /// Jumps the session straight to `target`, keeping every invariant the
    /// incremental path maintains (grapheme-safe by construction — a whole
    /// target always is — and a fingerprint over the new tail). Returns true
    /// when this actually moved the reveal.
    @discardableResult
    private static func adopt(
        _ session: StreamingRevealSession, target: String, at now: Date
    ) -> Bool {
        let count = target.utf8.count
        guard session.revealedUTF8Count < count else {
            session.lastTick = now
            return false
        }
        session.revealed = target
        session.revealedUTF8Count = count
        session.desiredUTF8Count = count
        session.fingerprint = Array(target.utf8.suffix(64))
        session.lastTick = now
        adoptionCount += 1
        return true
    }

    /// Largest UTF-8 byte count `<= utf8ByteCount` that ends on a `Character`
    /// boundary in `target`. Never splits a multi-byte scalar or a composed
    /// grapheme (flags, ZWJ sequences, combining marks).
    static func graphemeSafeRevealCount(of target: String, utf8ByteCount: Int) -> Int {
        let total = target.utf8.count
        guard utf8ByteCount > 0 else { return 0 }
        guard utf8ByteCount < total else { return total }

        let utf8 = target.utf8
        var index = utf8.index(utf8.startIndex, offsetBy: utf8ByteCount)
        // Back off to a scalar boundary if the budget landed mid-scalar.
        while String.Index(index, within: target) == nil {
            index = utf8.index(before: index)
        }
        var stringIndex = String.Index(index, within: target)!
        // Back off to a grapheme boundary if the scalar starts a combining
        // sequence with what precedes it.
        if stringIndex < target.endIndex {
            let sequence = target.rangeOfComposedCharacterSequence(at: stringIndex)
            if sequence.lowerBound != stringIndex {
                stringIndex = sequence.lowerBound
            }
        }
        return target[..<stringIndex].utf8.count
    }

    private static func session(
        threadID: String, messageID: String, target: String, at now: Date
    ) -> StreamingRevealSession {
        if let existing = sessions[threadID]?[messageID] {
            return existing
        }

        if insertionOrder.count >= maxSessionCount, let oldest = insertionOrder.first {
            insertionOrder.removeFirst()
            sessions[oldest.threadID]?[oldest.messageID] = nil
            if sessions[oldest.threadID]?.isEmpty == true {
                sessions[oldest.threadID] = nil
            }
        }

        let created = StreamingRevealSession()
        // Mounting into a message that already has real text means the view
        // was not here when it arrived — selecting a thread whose agent is
        // mid-run. Typing that out from empty is the "regenerating" replay.
        if adoption.shouldAdoptOnCreate(targetUTF8Count: target.utf8.count) {
            adopt(created, target: target, at: now)
        }
        sessions[threadID, default: [:]][messageID] = created
        insertionOrder.append(SessionKey(threadID: threadID, messageID: messageID))
        return created
    }
}

@MainActor
private final class StreamingRevealSession {
    /// Grapheme-safe revealed prefix of every target seen so far.
    var revealed = ""
    var revealedUTF8Count = 0
    /// Policy-driven position; may sit mid-grapheme and only advances, so a
    /// multi-byte grapheme straddling the budget never stalls the reveal.
    var desiredUTF8Count = 0
    var fingerprint: [UInt8] = []
    var lastTick: Date?
}
