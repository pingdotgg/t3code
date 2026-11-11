import UIKit

enum TranscriptDebug {
    /// `T3_DEBUG_SELECTABLE_TEXT=1` renders every message the way "Select Text"
    /// does, to compare against the drawn text. Always false in release builds.
    static let forcesSelectableText: Bool = {
        #if DEBUG
        ProcessInfo.processInfo.environment["T3_DEBUG_SELECTABLE_TEXT"] == "1"
        #else
        false
        #endif
    }()
}

#if DEBUG

/// Debug-only scroll benchmark. With `T3_SCROLL_BENCHMARK=1` in the launch
/// environment, the first transcript on screen is flung to the top and back
/// at a fixed speed while a display link counts main-thread hitches. Results
/// go to the console prefixed with `T3BENCH`. The first pass meets unmeasured
/// rows; the second pass shows the cost once sizes are known.
///
/// The simulator draws at 60 Hz, so frame gaps alone hide work that misses a
/// 120 Hz device frame (8.3 ms). A run-loop observer also sums main-thread
/// busy time per frame; `over8` is the count a ProMotion device would drop.
@MainActor
final class TranscriptScrollBenchmark: NSObject {
    private static var didStart = false
    private static var active: TranscriptScrollBenchmark?

    private weak var view: BottomAnchoredTranscriptCollectionView?
    private var link: CADisplayLink?
    private let speed: CGFloat
    private var direction: CGFloat = -1
    private var pass = 1
    private var lastTimestamp: CFTimeInterval?
    private var frames = 0
    private var hitches = 0
    private var hitchTime: CFTimeInterval = 0
    private var worst: CFTimeInterval = 0
    private var duration: CFTimeInterval = 0
    private var observer: CFRunLoopObserver?
    private var busySince: CFTimeInterval?
    private var frameBusy: CFTimeInterval = 0
    private var busyFrames: [CFTimeInterval] = []

    private init(view: BottomAnchoredTranscriptCollectionView, speed: CGFloat) {
        self.view = view
        self.speed = speed
    }

    static func startIfRequested(on view: BottomAnchoredTranscriptCollectionView) {
        let environment = ProcessInfo.processInfo.environment
        // `T3_SCROLL_PARK=0.4` parks the transcript at that fraction of its height,
        // for screenshots of a fixed spot without UI automation.
        if !didStart, let park = environment["T3_SCROLL_PARK"].flatMap(Double.init) {
            didStart = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 16) { [weak view] in
                guard let view else { return }
                view.maintainsBottomAnchor = false
                view.contentOffset.y = CGFloat(park) * max(0, view.contentSize.height - view.bounds.height)
            }
            return
        }
        guard !didStart, environment["T3_SCROLL_BENCHMARK"] == "1" else { return }
        didStart = true
        let speed = environment["T3_SCROLL_BENCHMARK_SPEED"].flatMap(Double.init).map { CGFloat($0) } ?? 3_000
        let benchmark = TranscriptScrollBenchmark(view: view, speed: speed)
        active = benchmark
        // Let the thread load and settle at the bottom first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { benchmark.begin() }
    }

    private func begin() {
        guard let view else { return }
        view.maintainsBottomAnchor = false
        print("T3BENCH start items=\(view.numberOfItems(inSection: 0)) contentHeight=\(Int(view.contentSize.height)) speed=\(Int(speed))")
        let observer = CFRunLoopObserverCreateWithHandler(
            nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0
        ) { [weak self] _, activity in
            MainActor.assumeIsolated { self?.record(activity) }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        self.observer = observer
        let link = CADisplayLink(target: self, selector: #selector(step))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func record(_ activity: CFRunLoopActivity) {
        let now = CACurrentMediaTime()
        if activity == .afterWaiting {
            busySince = now
        } else if let busySince {
            frameBusy += now - busySince
            self.busySince = nil
        }
    }

    @objc private func step(_ link: CADisplayLink) {
        guard let view else { return finish() }
        if let busySince {
            frameBusy += CACurrentMediaTime() - busySince
            self.busySince = CACurrentMediaTime()
        }
        busyFrames.append(frameBusy)
        frameBusy = 0
        let expected = link.targetTimestamp - link.timestamp
        defer { lastTimestamp = link.timestamp }
        guard let lastTimestamp else { return }
        let elapsed = link.timestamp - lastTimestamp
        frames += 1
        duration += elapsed
        if elapsed > expected * 1.5 {
            hitches += 1
            hitchTime += elapsed - expected
        }
        worst = max(worst, elapsed)

        let top = -view.adjustedContentInset.top
        let bottom = max(top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
        let next = min(bottom, max(top, view.contentOffset.y + direction * speed * CGFloat(elapsed)))
        view.contentOffset.y = next
        if direction < 0, next <= top {
            report("up")
            direction = 1
        } else if direction > 0, next >= bottom {
            report("down")
            if pass == 2 { return finish() }
            pass += 1
            direction = -1
        }
    }

    private func report(_ leg: String) {
        let ratio = duration > 0 ? hitchTime * 1000 / duration : 0
        let busy = busyFrames.sorted()
        let p95 = busy.isEmpty ? 0 : busy[min(busy.count - 1, Int(Double(busy.count) * 0.95))]
        print(String(
            format: "T3BENCH pass=%d leg=%@ frames=%d hitches=%d hitchTime=%.0fms ratio=%.1fms/s worst=%.0fms duration=%.1fs"
                + " busy: over8=%d over16=%d p95=%.1fms max=%.1fms mean=%.2fms",
            pass, leg, frames, hitches, hitchTime * 1000, ratio, worst * 1000, duration,
            busy.filter { $0 > 1.0 / 120 }.count, busy.filter { $0 > 1.0 / 60 }.count,
            p95 * 1000, (busy.last ?? 0) * 1000, busy.reduce(0, +) / Double(max(1, busy.count)) * 1000
        ))
        frames = 0; hitches = 0; hitchTime = 0; worst = 0; duration = 0; busyFrames = []
    }

    private func finish() {
        link?.invalidate()
        link = nil
        if let observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), observer, .commonModes) }
        observer = nil
        print("T3BENCH done")
        Self.active = nil
    }
}
#endif
