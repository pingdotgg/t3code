import CoreGraphics
import Testing

@testable import SergeCodeMac

/// The chat header's git bar picks how much prose it can afford from the
/// header's width and from the strings it is about to draw. SwiftUI layout
/// cannot be hosted in the CLT test bundle, so these cover the arithmetic that
/// decides the tier — the part that has to be monotonic, has to shrink when it
/// folds, and must never let a busy repository claim the widest tier in a
/// narrow window.
@Suite("Chat header bar density")
struct HeaderBarDensityTests {
    /// The repository state from the report that prompted the redesign: a
    /// branch, three changed files with large deltas, a commit ahead, an open
    /// PR with conflicts, and four unresolved comments.
    private func busyStatus(branch: String = "sergecode/thinking-aura-alignment")
        -> VcsStatus
    {
        VcsStatus(
            isRepo: true, branch: branch, isDefaultBranch: false, changedFileCount: 3,
            insertions: 267, deletions: 113, aheadCount: 1, behindCount: 0, hasUpstream: true,
            hasPrimaryRemote: true, prNumber: 267, prTitle: "Fix random macOS window resizing",
            prURL: "https://github.com/SergeSerb2/SergeCode/pull/267", prState: .open,
            isDraftPR: false, unresolvedReviewThreadCount: 4, prMergeStateStatus: "dirty")
    }

    private func quietStatus() -> VcsStatus {
        VcsStatus(
            isRepo: true, branch: "main", isDefaultBranch: true, changedFileCount: 0,
            insertions: 0, deletions: 0, aheadCount: 0, behindCount: 0, hasUpstream: true)
    }

    private func density(_ width: CGFloat, _ status: VcsStatus) -> HeaderBarDensity {
        HeaderBarDensity.resolve(
            headerWidth: width, inventory: GitBarInventory(status: status),
            providerName: "Claude Code", statusText: "Fixing")
    }

    @Test("folding a tier never makes the bar wider")
    func foldingNeverGrows() {
        for status in [busyStatus(), quietStatus()] {
            let inventory = GitBarInventory(status: status)
            #expect(inventory.estimatedWidth(at: .compact) <= inventory.estimatedWidth(at: .full))
            #expect(
                inventory.estimatedWidth(at: .minimal)
                    <= inventory.estimatedWidth(at: .compact))
        }
    }

    @Test("folding a busy bar actually saves width at every tier")
    func foldingShrinksABusyBar() {
        // Every lifecycle keeps the same slots; the density tier is the only
        // mechanism that changes the bar's width.
        let inventory = GitBarInventory(status: busyStatus())
        #expect(inventory.estimatedWidth(at: .compact) < inventory.estimatedWidth(at: .full))
        #expect(inventory.estimatedWidth(at: .minimal) < inventory.estimatedWidth(at: .compact))
    }

    @Test("density never increases as the header narrows")
    func densityIsMonotonic() {
        let status = busyStatus()
        var previous = HeaderBarDensity.minimal
        for width in stride(from: 280.0, through: 2400.0, by: 20.0) {
            let resolved = density(width, status)
            #expect(resolved >= previous)
            previous = resolved
        }
    }

    @Test("a busy repository in a laptop-width pane does not claim the full tier")
    func busyRepositoryFoldsAtLaptopWidth() {
        // The reported case: a ~920pt chat pane with every chip showing. The
        // old bar tried to draw all of it and let SwiftUI squeeze the chips
        // into unreadable stacks of wrapped text.
        #expect(density(920, busyStatus()) < .full)
    }

    @Test("a busy repository on a wide display gets the full tier")
    func busyRepositoryIsFullOnAWideDisplay() {
        #expect(density(1800, busyStatus()) == .full)
    }

    @Test("a quiet repository keeps the same stable geometry")
    func quietRepositoryKeepsStableGeometry() {
        let busy = GitBarInventory(status: busyStatus())
        let quiet = GitBarInventory(status: quietStatus())
        for tier in HeaderBarDensity.allCases {
            #expect(busy.estimatedWidth(at: tier) == quiet.estimatedWidth(at: tier))
        }
    }

    @Test("an unmeasured header renders at full width")
    func zeroWidthFallsBackToFull() {
        // The first layout pass reports nothing; starting minimal would make
        // every header flash its collapsed form on open.
        #expect(density(0, busyStatus()) == .full)
    }

    @Test("the identity reserve is clamped at both ends")
    func identityReserveIsClamped() {
        #expect(HeaderBarDensity.identityReserve(headerWidth: 300) == 180)
        #expect(HeaderBarDensity.identityReserve(headerWidth: 1000) == 280)
        #expect(HeaderBarDensity.identityReserve(headerWidth: 4000) == 360)
    }

    @Test("labels fold rather than disappear")
    func labelsFold() {
        let inventory = GitBarInventory(status: busyStatus())
        #expect(inventory.prLabel(at: .full) == "PR #267")
        #expect(inventory.prLabel(at: .compact) == "#267")
        #expect(inventory.prLabel(at: .minimal) == nil)
        #expect(inventory.commentsLabel(at: .full) == "Comments · 4")
        #expect(inventory.commentsLabel(at: .compact) == "4")
        #expect(inventory.gitLabel(at: .compact) == "Git")
        #expect(inventory.gitLabel(at: .minimal) == nil)
        #expect(inventory.filesChangedLabel == "3 files changed")
        #expect(inventory.insertionsLabel == "+267")
        #expect(inventory.deletionsLabel == "−113")

        var mergedStatus = busyStatus()
        mergedStatus.prState = .merged
        let merged = GitBarInventory(status: mergedStatus)
        #expect(merged.prLabel(at: .full) == "Merged #267")
    }

    @Test("the branch cap tightens with the tier")
    func branchCapTightens() {
        #expect(HeaderBarDensity.full.branchWidth > HeaderBarDensity.compact.branchWidth)
        #expect(HeaderBarDensity.compact.branchWidth > HeaderBarDensity.minimal.branchWidth)
    }

    @Test("branch length cannot change the bar width")
    func branchLengthKeepsStableWidth() {
        let long = GitBarInventory(status: busyStatus(branch: String(repeating: "x", count: 400)))
        let short = GitBarInventory(status: busyStatus(branch: "x"))
        for tier in HeaderBarDensity.allCases {
            #expect(long.estimatedWidth(at: tier) == short.estimatedWidth(at: tier))
        }
    }

    @Test("the inventory reads the chips a status actually shows")
    func inventoryMirrorsStatus() {
        let busy = GitBarInventory(status: busyStatus())
        #expect(busy.showsWorkingTree)
        #expect(busy.showsDivergence)
        #expect(busy.showsConflicts)
        #expect(busy.showsComments)
        #expect(!busy.showsReadyForReview)
        // Conflicts alone disqualify the merge affordance.
        #expect(!busy.showsMerge)

        let quiet = GitBarInventory(status: quietStatus())
        #expect(!quiet.showsWorkingTree)
        #expect(!quiet.showsDivergence)
        #expect(!quiet.showsConflicts)
        #expect(!quiet.showsComments)
        #expect(!quiet.showsMerge)
    }

    @Test("an action outcome reuses the repository slot")
    func outcomeReusesRepositorySlot() {
        let bare = GitBarInventory(status: busyStatus())
        let withOutcome = GitBarInventory(
            status: busyStatus(), outcomeTitle: "Pushed 3 commits to origin")
        for tier in HeaderBarDensity.allCases {
            #expect(withOutcome.estimatedWidth(at: tier) == bare.estimatedWidth(at: tier))
        }
    }
}
