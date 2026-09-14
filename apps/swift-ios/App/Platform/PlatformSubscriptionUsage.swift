import Foundation
import WidgetKit

struct PlatformSubscriptionUsageObservationKey: Equatable {
    let isActive: Bool
    let environments: [FeatureEnvironment]
}

enum PlatformSubscriptionUsageSnapshot {
    static func make(_ environments: [FeatureEnvironmentUsageLimits]) -> T3SubscriptionUsageSnapshot {
        let pools = UsageLimitPooling.pools(UsageLimitPooling.accounts(environments), now: .distantPast)
        return T3SubscriptionUsageSnapshot(providers: ["codex", "claudeAgent"].map { driver in
            let pool = pools.first { $0.driver == driver }
            let checked = pool?.accounts.map { UsageFormat.isoDate($0.limits.checkedAt) } ?? []
            let checkedAt = checked.contains(where: { $0 == nil }) ? nil : checked.compactMap { $0 }.min()
            let expiresAt = checkedAt.map { checkedAt in
                min(checkedAt.addingTimeInterval(15 * 60), pool?.windows.flatMap(\.resets).map(\.at).min() ?? .distantFuture)
            }
            let ordered = pool?.windows.sorted { $0.remainingPercent < $1.remainingPercent } ?? []
            let primary = [ordered.first { $0.kind == .session }, ordered.first { $0.kind == .weekly }].compactMap { $0 }
            let selected = Array((primary + ordered.filter { row in !primary.contains(where: { $0.id == row.id }) }).prefix(6))
                .sorted { $0.remainingPercent < $1.remainingPercent }
            let partial = environments.contains { environment in
                environment.isPending || !environment.isConnected || environment.errorMessage != nil
                    || environment.sources.contains { source in
                        source.error != nil || source.accounts.contains {
                            $0.driver == driver && $0.usageLimits.unavailable?.reason != .unsupported
                                && UsageLimitsPresentation.limitsNotice($0.usageLimits) != nil
                        }
                    }
                    || UsageLimitsPresentation.providersWithLimits(environment.providers).contains {
                        $0.driver == driver && $0.usageLimits?.unavailable?.reason != .unsupported
                            && $0.usageLimits.map { UsageLimitsPresentation.limitsNotice($0) != nil } == true
                    }
            }
            return .init(
                id: driver, name: UsageLimitsPresentation.providerLabel(driver: driver),
                accountCount: pool?.accounts.count ?? 0,
                checkedAt: checkedAt, expiresAt: expiresAt,
                windows: selected.map { window in
                    .init(id: window.id, kind: window.kind.rawValue, label: String(window.label.prefix(120)), remaining: window.remainingPercent, resetAt: window.resets.first?.at)
                },
                totalWindows: ordered.count, hasPartialData: partial
            )
        })
    }
}

/// The foreground host observes config updates and makes one refresh attempt on
/// activation. No timer, background socket, or widget-owned transport is needed.
@MainActor
final class PlatformSubscriptionUsageCoordinator {
    private var environments: [FeatureEnvironmentUsageLimits] = []
    private var generation = 0
    private var lastRefresh: Date?

    func observe(client: any FeatureClient, environmentIDs: [String]) async {
        generation += 1
        let currentGeneration = generation
        environments = environments.filter { environmentIDs.contains($0.id) }
        await publish()
        guard !environmentIDs.isEmpty else { return }
        let hasWidget = await withCheckedContinuation { continuation in
            WidgetCenter.shared.getCurrentConfigurations { result in
                continuation.resume(returning: (try? result.get())?.contains {
                    $0.kind == T3SubscriptionUsageSnapshotStore.kind
                } ?? false)
            }
        }
        guard hasWidget, !Task.isCancelled, generation == currentGeneration else { return }

        // Bound probes across rapid scene and connection changes.
        let shouldRefresh = lastRefresh.map { Date().timeIntervalSince($0) >= 5 * 60 } ?? true
        if shouldRefresh { lastRefresh = Date() }
        await withTaskGroup(of: Void.self) { group in
            if shouldRefresh {
                group.addTask {
                    // Refresh emits config events. Do not overwrite newer stream
                    // data with the operation result if the two complete out of order.
                    _ = try? await client.refreshUsageLimits()
                }
            }
            do {
                for try await rows in client.usageLimitsUpdates() {
                    guard !Task.isCancelled, generation == currentGeneration else { break }
                    environments = UsageLimitsPresentation.retainingPendingRows(rows, previous: environments)
                    await publish()
                }
            } catch {
                guard !Task.isCancelled, generation == currentGeneration else { return }
                environments = environments.map {
                    .init(environmentID: $0.id, label: $0.label, providers: $0.providers, sources: $0.sources,
                          isConnected: false, errorMessage: "Could not read limits.")
                }
                await publish()
            }
            group.cancelAll()
        }
    }

    private func publish() async {
        let snapshot = PlatformSubscriptionUsageSnapshot.make(environments)
        let saved = await PlatformSubscriptionUsageWriter.shared.save(snapshot, generation: generation)
        if saved { WidgetCenter.shared.reloadTimelines(ofKind: T3SubscriptionUsageSnapshotStore.kind) }
    }
}

private actor PlatformSubscriptionUsageWriter {
    static let shared = PlatformSubscriptionUsageWriter()
    private var generation = 0
    private var previous: T3SubscriptionUsageSnapshot?

    func save(_ snapshot: T3SubscriptionUsageSnapshot, generation: Int) -> Bool {
        guard generation >= self.generation else { return false }
        self.generation = generation
        guard snapshot != previous else { return false }
        do {
            try T3SubscriptionUsageSnapshotStore.save(snapshot)
            previous = snapshot
            return true
        } catch { return false }
    }
}
