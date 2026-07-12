import Foundation
import os

enum PerfSignpost {
    static let poster = OSSignposter(subsystem: "com.sergecode.mac", category: "perf")

    @inline(__always)
    static func interval<T>(
        _ name: StaticString, body: () throws -> T
    ) rethrows -> T {
        let state = poster.beginInterval(name)
        defer { poster.endInterval(name, state) }
        return try body()
    }
}

/// Nonisolated timing breadcrumbs for actor and detached-task work. These are
/// deliberately stateless so they can be called from any execution context.
enum PerfLog {
    static let enabled = ProcessInfo.processInfo.environment["SERGECODE_PERF"] == "1"

    private static let clock = ContinuousClock()
    private static let logger = Logger(subsystem: "com.sergecode.mac", category: "perf")

    static func now() -> ContinuousClock.Instant? {
        guard enabled else { return nil }
        return clock.now
    }

    static func elapsedMilliseconds(since start: ContinuousClock.Instant?) -> Double {
        guard enabled, let start else { return 0 }
        return milliseconds(start.duration(to: clock.now))
    }

    static func event(_ label: String, ms: Double, details: String? = nil) {
        guard enabled else { return }
        var line = "SERGECODE_PERF \(label) ms=\(String(format: "%.3f", ms))"
        if let details, !details.isEmpty {
            line += " \(details)"
        }
        logger.info("\(line, privacy: .public)")
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }

    private static func milliseconds(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }
}

@MainActor
enum PerfMetrics {
    static let enabled = ProcessInfo.processInfo.environment["SERGECODE_PERF"] == "1"

    private struct Timing {
        var count = 0
        var totalMilliseconds = 0.0
        var maximumMilliseconds = 0.0
    }

    private static let clock = ContinuousClock()
    private static var timings: [String: Timing] = [:]
    private static var counters: [String: Int] = [:]

    static func measure<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }

        let startedAt = clock.now
        do {
            let value = try body()
            record(label, duration: startedAt.duration(to: clock.now))
            return value
        } catch {
            record(label, duration: startedAt.duration(to: clock.now))
            throw error
        }
    }

    static func count(_ label: String, by n: Int = 1) {
        guard enabled else { return }
        counters[label, default: 0] += n
    }

    static func report() -> String {
        let timingLines = timings.keys.sorted().map { label in
            let timing = timings[label] ?? Timing()
            return "\(label) count=\(timing.count) total_ms=\(String(format: "%.3f", timing.totalMilliseconds)) max_ms=\(String(format: "%.3f", timing.maximumMilliseconds))"
        }
        let counterLines = counters.keys.sorted().map { label in
            "counter \(label) value=\(counters[label] ?? 0)"
        }
        return (timingLines + counterLines).joined(separator: "\n")
    }

    static func reset() {
        timings.removeAll(keepingCapacity: true)
        counters.removeAll(keepingCapacity: true)
    }

    private static func record(_ label: String, duration: Duration) {
        let milliseconds = durationMilliseconds(duration)
        var timing = timings[label] ?? Timing()
        timing.count += 1
        timing.totalMilliseconds += milliseconds
        timing.maximumMilliseconds = max(timing.maximumMilliseconds, milliseconds)
        timings[label] = timing
    }

    private static func durationMilliseconds(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) * 1_000
            + Double(components.attoseconds) / 1_000_000_000_000_000
    }
}
