import SwiftUI

// MARK: - Density

/// How much room the chat header's git bar has to spend on words.
///
/// The bar shows the same chips at every density — nothing disappears — but
/// each chip trades its prose for its glyph as the window narrows: "3 files
/// changed +267 −113" becomes a document glyph with the two deltas, then just
/// the file count; "Conflicts" becomes its warning triangle; "Comments · 4"
/// becomes a bubble and a 4. Every collapsed chip keeps the full sentence in
/// its tooltip and its accessibility label, so nothing is lost, only folded.
enum HeaderBarDensity: Comparable, CaseIterable, Sendable {
    case minimal, compact, full

    /// Whether chips spell their labels out.
    var showsLabels: Bool { self == .full }

    /// How much of a branch name the branch chip will show before it
    /// middle-truncates.
    var branchWidth: CGFloat {
        switch self {
        case .full: 200
        case .compact: 132
        case .minimal: 96
        }
    }

    /// Width cap for the transient git-action outcome chip, whose title is a
    /// server string of no bounded length. `nil` at the tier where the chip
    /// folds to its glyph and the title lives only in the tooltip.
    var outcomeChipWidth: CGFloat? {
        switch self {
        case .full: 320
        case .compact: 190
        case .minimal: nil
        }
    }
}

// MARK: - Inventory

/// Everything the git bar has to show for one repository state, in the form
/// the bar and its width estimate both read from.
///
/// One type rather than two parallel lists: the density is chosen from an
/// estimate of how wide the bar will be, and an estimate that drifts from what
/// the bar actually renders is worse than no estimate at all — it would pick
/// `.full` for a row that does not fit and hand the overflow to the scrolling
/// strip on every repository update.
struct GitBarInventory: Equatable, Sendable {
    var branch: String
    var changedFiles: Int
    var insertions: Int
    var deletions: Int
    var ahead: Int
    var behind: Int
    var prNumber: Int?
    var prIsMerged: Bool
    var prIsDraft: Bool
    var showsConflicts: Bool
    /// Unresolved review threads; `nil` when the count is unknown but the
    /// chip still shows.
    var comments: Int?
    var showsComments: Bool
    var showsReadyForReview: Bool
    var showsMerge: Bool
    /// Title of the transient git-action outcome pill, when one is up.
    var outcomeTitle: String?

    init(status: VcsStatus, outcomeTitle: String? = nil) {
        branch = status.branch ?? "no branch"
        changedFiles = status.changedFileCount
        insertions = status.insertions
        deletions = status.deletions
        ahead = status.aheadCount
        behind = status.behindCount
        prNumber = status.prURL == nil ? nil : status.prNumber
        prIsMerged = status.prState == .merged
        prIsDraft = status.isDraftPR == true
        showsConflicts = status.prState == .open && status.hasPrConflicts
        comments = status.unresolvedReviewThreadCount
        showsComments = status.prNumber != nil
        showsReadyForReview = status.prState == .open && status.isDraftPR == true
        showsMerge = MergeReadiness.isReady(for: status)
        self.outcomeTitle = outcomeTitle
    }

    // MARK: Labels
    //
    // The bar renders these strings; the estimate measures them. Both go
    // through here so they cannot disagree.

    /// Whether the working-tree chip shows at all.
    var showsWorkingTree: Bool { changedFiles > 0 }
    var showsDivergence: Bool { ahead > 0 || behind > 0 }

    /// Grouped, so a five-digit repository reads as "12,345" rather than a run
    /// of digits — and shared with the folded tiers so the same number does not
    /// change shape as the bar folds.
    var changedFilesCount: String { changedFiles.formatted() }
    var aheadCount: String { ahead.formatted() }
    var behindCount: String { behind.formatted() }

    var filesChangedLabel: String {
        "\(changedFilesCount) \(changedFiles == 1 ? "file" : "files") changed"
    }

    var insertionsLabel: String? { insertions > 0 ? "+\(insertions)" : nil }
    var deletionsLabel: String? { deletions > 0 ? "−\(deletions)" : nil }

    func prLabel(at density: HeaderBarDensity) -> String? {
        guard let prNumber else { return nil }
        switch density {
        case .full:
            return "PR #\(prNumber)"
                + (prIsMerged ? " · Merged" : prIsDraft ? " · Draft" : "")
        case .compact: return "#\(prNumber)"
        case .minimal: return nil
        }
    }

    func commentsLabel(at density: HeaderBarDensity) -> String? {
        guard showsComments else { return nil }
        switch density {
        case .full: return comments.map { "Comments · \($0.formatted())" } ?? "Comments"
        // A PR number is never grouped ("#1234"), but a comment count is a
        // quantity like any other.
        case .compact, .minimal: return comments.map { $0.formatted() }
        }
    }

    func readyLabel(at density: HeaderBarDensity) -> String? {
        switch density {
        case .full: "Ready for Review"
        case .compact: "Ready"
        case .minimal: nil
        }
    }

    func mergeLabel(at density: HeaderBarDensity) -> String? {
        switch density {
        case .full: "Merge PR"
        case .compact: "Merge"
        case .minimal: nil
        }
    }

    /// The git-actions menu keeps its word until the bar is at its narrowest —
    /// it is the primary action and the last control the user should have to
    /// guess at.
    func gitLabel(at density: HeaderBarDensity) -> String? {
        density == .minimal ? nil : "Git"
    }
}

// MARK: - Width estimate

/// Typical advances of the bar's `.caption` (11pt) medium text and glyphs.
///
/// An estimate on purpose. SwiftUI cannot tell a view how wide its text will
/// be before it lays the text out, and the alternative — reacting to measured
/// overflow — is a feedback loop: a bar that collapses frees the space that
/// would immediately expand it again, and the header oscillates. So the
/// density is picked from arithmetic on the strings the bar is about to draw,
/// against a width the bar cannot influence (the header's own). Overestimating
/// costs one tier more density than strictly needed; underestimating hands the
/// row to the scrolling strip, which is the same safety net that already
/// catches a 300-character branch name.
private enum Ink {
    static let character: CGFloat = 6.2
    static let icon: CGFloat = 13
    static let chevron: CGFloat = 9
}

extension GitBarInventory {
    /// Estimated rendered width of the whole bar at `density`.
    func estimatedWidth(at density: HeaderBarDensity) -> CGFloat {
        var chips: [CGFloat] = []

        if let outcomeTitle {
            if let cap = density.outcomeChipWidth {
                chips.append(
                    min(cap, chip(icons: 2, textWidth: Ink.character * CGFloat(outcomeTitle.count)))
                )
            } else {
                chips.append(chip(icons: 2))
            }
        }

        // Branch: one glyph, a truncating name, a chevron.
        chips.append(
            chip(
                icons: 1,
                textWidth: min(density.branchWidth, Ink.character * CGFloat(branch.count)),
                chevron: true))

        if showsWorkingTree {
            let deltas = [insertionsLabel, deletionsLabel].compactMap(\.self)
            switch density {
            case .full:
                chips.append(chip(text: ([filesChangedLabel] + deltas).joined(separator: " ")))
            case .compact:
                chips.append(
                    chip(icons: 1, text: ([changedFilesCount] + deltas).joined(separator: " ")))
            case .minimal:
                chips.append(chip(icons: 1, text: changedFilesCount))
            }
        }

        if showsDivergence {
            let counts = [ahead > 0 ? aheadCount : nil, behind > 0 ? behindCount : nil]
                .compactMap(\.self)
            chips.append(chip(icons: counts.count, text: counts.joined(separator: " ")))
        }

        if prNumber != nil {
            chips.append(chip(icons: 1, text: prLabel(at: density)))
        }
        if showsConflicts {
            chips.append(chip(icons: 1, text: density.showsLabels ? "Conflicts" : nil))
        }
        if showsComments {
            chips.append(chip(icons: 1, text: commentsLabel(at: density)))
        }
        if showsReadyForReview {
            chips.append(chip(icons: 1, text: readyLabel(at: density)))
        }
        if showsMerge {
            chips.append(chip(icons: 1, text: mergeLabel(at: density)))
        }
        chips.append(chip(icons: 1, text: gitLabel(at: density), chevron: true))

        let gaps = CGFloat(max(0, chips.count - 1)) * HeaderChipMetrics.barSpacing
        return chips.reduce(0, +) + gaps
    }

    /// Width of one chip from its parts, mirroring `HeaderChipChrome`: content
    /// plus the gaps between its pieces plus the padding its shape adds.
    private func chip(
        icons: Int = 0, text: String? = nil, textWidth: CGFloat? = nil, chevron: Bool = false
    ) -> CGFloat {
        var content = CGFloat(icons) * Ink.icon
        var pieces = icons
        if let textWidth {
            content += textWidth
            pieces += 1
        } else if let text, !text.isEmpty {
            content += Ink.character * CGFloat(text.count)
            pieces += 1
        }
        if chevron {
            content += Ink.chevron
            pieces += 1
        }
        let isIconOnly = pieces == icons && !chevron
        let padding =
            2
            * (isIconOnly
                ? HeaderChipMetrics.iconOnlyPadding : HeaderChipMetrics.horizontalPadding)
        return content + CGFloat(max(0, pieces - 1)) * HeaderChipMetrics.contentSpacing + padding
    }
}

// MARK: - Resolving the density

extension HeaderBarDensity {
    /// `ChatHeaderView`'s own horizontal insets plus the four gaps in its
    /// top-level `HStack`.
    private static let headerChrome: CGFloat = 32 + 4 * 16

    /// The slice of the header the task identity keeps before the git bar gets
    /// a say. Proportional with a floor and a ceiling: on a narrow window the
    /// title has to give ground or the bar would be minimal at every width,
    /// and on a very wide one there is no reason to keep reserving more room
    /// for a title that has long since stopped truncating.
    static func identityReserve(headerWidth: CGFloat) -> CGFloat {
        min(360, max(180, headerWidth * 0.28))
    }

    /// Estimated width of the header's fixed trailing cluster — the provider
    /// label and the status badge, neither of which compresses.
    static func trailingClusterWidth(providerName: String, statusText: String) -> CGFloat {
        let provider = Ink.icon + 7 + Ink.character * CGFloat(providerName.count)
        let status = Ink.icon + 4 + Ink.character * CGFloat(statusText.count)
        return provider + status + 16
    }

    /// The densest tier whose estimated bar fits the room the header has left.
    ///
    /// `headerWidth` is the header's own width, which the bar cannot influence
    /// — that is what makes this stable. Everything else is arithmetic on the
    /// strings about to be drawn.
    static func resolve(
        headerWidth: CGFloat,
        inventory: GitBarInventory,
        providerName: String,
        statusText: String
    ) -> HeaderBarDensity {
        guard headerWidth > 0 else { return .full }
        let available =
            headerWidth - headerChrome
            - trailingClusterWidth(providerName: providerName, statusText: statusText)
            - identityReserve(headerWidth: headerWidth)
        if inventory.estimatedWidth(at: .full) <= available { return .full }
        if inventory.estimatedWidth(at: .compact) <= available { return .compact }
        return .minimal
    }
}
