import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Composer power features")
struct FeatureComposerPowerTests {
    @Test func workspaceSkillsStayInTheirWorkspace() {
        var provider = FeatureProvider(id: "claude", name: "Claude", skills: [.init(name: "global")])
        provider.workspaceSnapshots = [
            FeatureProviderWorkspace(cwd: "/a", slashCommands: [], skills: [.init(name: "a-only")]),
            FeatureProviderWorkspace(cwd: "/b", slashCommands: [], skills: [.init(name: "b-only")]),
        ]
        #expect(provider.workspaceCatalog(cwd: "/a").skills.map(\.name) == ["a-only"])
        #expect(provider.workspaceCatalog(cwd: "/b").skills.map(\.name) == ["b-only"])
        #expect(provider.workspaceCatalog(cwd: "/c").skills.isEmpty)
        provider.workspaceSnapshots = nil
        #expect(provider.workspaceCatalog(cwd: "/c").skills.map(\.name) == ["global"])
    }

    @Test func skillInvocationHonorsProviderRules() {
        var userOnly = FeatureProviderSkill(name: "deploy")
        userOnly.userInvocationOnly = true
        var agentOnly = FeatureProviderSkill(name: "internal")
        agentOnly.userInvocable = false
        #expect(userOnly.invocation == "/deploy ")
        #expect(agentOnly.invocation == "$internal ")
        let items = FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .slashCommand, query: "", range: 0..<1),
            providers: [], currentSelection: nil, threadSelection: nil,
            powerFeatures: .init(skills: [userOnly, agentOnly]), pathEntries: []
        )
        #expect(items.contains { $0.id == "skill:deploy" })
        #expect(!items.contains { $0.id == "skill:internal" })
    }

    @Test(
        "Composer input grows past the former seven-line cap",
        .bug("https://github.com/saphid/t3code-personal/issues/105")
    )
    func composerTextInputGrowsBeyondSevenLines() {
        let lineHeight: CGFloat = 22
        let sevenLines = FeatureComposerTextInputSizing.height(
            fittingHeight: lineHeight * 7,
            lineHeight: lineHeight
        )
        let elevenLines = FeatureComposerTextInputSizing.height(
            fittingHeight: lineHeight * 11,
            lineHeight: lineHeight
        )

        #expect(sevenLines == lineHeight * 7)
        #expect(elevenLines == lineHeight * 11)
    }

    @Test(
        "A very tall composer input caps at its line bound and scrolls inside",
        .bug("https://github.com/saphid/t3code-personal/issues/105")
    )
    func composerTextInputCapsAtItsLineBound() {
        #expect(
            FeatureComposerTextInputSizing.height(
                fittingHeight: 2_200,
                lineHeight: 22
            ) == 22 * FeatureComposerTextInputSizing.maximumLines
        )
    }

    @Test
    func composerTextInputReservesRoomForControlsInAConstrainedViewport() {
        #expect(
            FeatureComposerTextInputSizing.height(
                fittingHeight: 440,
                lineHeight: 22,
                availableHeight: 150
            ) == 150
        )
        #expect(
            FeatureComposerTextInputSizing.height(
                fittingHeight: 440,
                lineHeight: 22,
                availableHeight: 80
            ) == 80
        )
        #expect(
            FeatureComposerTextInputSizing.height(
                fittingHeight: 440,
                lineHeight: 22,
                availableHeight: 0
            ) == 0
        )
    }

    @Test
    @MainActor
    func compressedComposerViewportKeepsItsLastLineAboveTheFooter() throws {
        let textView = FeatureComposerUITextView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 1)
        )
        textView.configureComposerViewport()
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.text = (1...30).map { "Attachment draft line \($0)" }
            .joined(separator: "\n")
        textView.selectedRange = NSRange(location: textView.text.utf16.count, length: 0)

        let measured = textView.sizeThatFits(
            CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)
        )
        let font = try #require(textView.font)
        let keyboardAndAttachmentBound: CGFloat = 80
        let viewportHeight = FeatureComposerTextInputSizing.height(
            fittingHeight: measured.height,
            lineHeight: font.lineHeight,
            availableHeight: keyboardAndAttachmentBound
        )
        textView.frame.size.height = viewportHeight
        textView.setNeedsLayout()
        textView.layoutIfNeeded()
        textView.scrollSelectionIntoView()

        #expect(textView.bounds.height == keyboardAndAttachmentBound)
        #expect(textView.contentOverflows)
        let selection = try #require(textView.selectedTextRange)
        let caret = textView.caretRect(for: selection.end)
        let visibleTop = textView.contentOffset.y
        let visibleBottom = visibleTop + textView.bounds.height
        #expect(caret.minY >= visibleTop)
        #expect(caret.maxY <= visibleBottom - 1)
    }

    @Test
    @MainActor
    func uiTextViewMeasurementGrowsBeforeTheViewportCap() throws {
        let textView = FeatureComposerUITextView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 1)
        )
        textView.configureComposerViewport()
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        let font = try #require(textView.font)

        textView.text = "First line\nSecond line"
        let shortMeasurement = textView.sizeThatFits(
            CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)
        )
        textView.text = (1...8).map { "Draft line \($0)" }.joined(separator: "\n")
        let tallMeasurement = textView.sizeThatFits(
            CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude)
        )

        let shortHeight = FeatureComposerTextInputSizing.height(
            fittingHeight: shortMeasurement.height,
            lineHeight: font.lineHeight,
            availableHeight: 400
        )
        let tallHeight = FeatureComposerTextInputSizing.height(
            fittingHeight: tallMeasurement.height,
            lineHeight: font.lineHeight,
            availableHeight: 400
        )

        #expect(tallHeight > shortHeight)
        #expect(tallHeight == tallMeasurement.height)
    }

    @Test
    func newTaskUsesCompactContextForDraftsAndAttachments() {
        #expect(!NewThreadComposerLayout.usesCompactContext(
            prompt: "", isFocused: false, hasAttachments: false
        ))
        #expect(NewThreadComposerLayout.usesCompactContext(
            prompt: "", isFocused: true, hasAttachments: false
        ))
        #expect(NewThreadComposerLayout.usesCompactContext(
            prompt: "A draft", isFocused: false, hasAttachments: false
        ))
        #expect(NewThreadComposerLayout.usesCompactContext(
            prompt: "", isFocused: false, hasAttachments: true
        ))
    }

    @Test
    @MainActor
    func longComposerDraftStaysClippedAndScrollsToItsLastLine() {
        let textView = FeatureComposerUITextView(
            frame: CGRect(x: 0, y: 0, width: 320, height: 110)
        )
        textView.configureComposerViewport()
        textView.font = UIFont.preferredFont(forTextStyle: .body)
        textView.text = (1...40).map { "A long pasted draft line \($0)" }
            .joined(separator: "\n")
        textView.layoutIfNeeded()
        textView.selectedRange = NSRange(location: textView.text.utf16.count, length: 0)
        textView.scrollSelectionIntoView()
        textView.layoutIfNeeded()

        #expect(textView.clipsToBounds)
        #expect(textView.contentOverflows)
        if let selection = textView.selectedTextRange {
            let caret = textView.caretRect(for: selection.end)
            #expect(caret.maxY <= textView.contentOffset.y + textView.bounds.height)
        } else {
            Issue.record("Expected a visible selection at the end of the pasted draft")
        }
    }

    @Test
    func replacementCursorLandsAfterInsertedTextInUTF16() {
        // "🧪 " occupies three characters but four UTF-16 units; the caret
        // location must count the latter or it drifts on emoji-bearing drafts.
        let original = "🧪 Use $dep please"
        let range = 6..<10

        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocation(
                afterReplacing: range,
                in: original,
                with: "$dependency "
            ) == "🧪 Use $dependency ".utf16.count
        )
    }

    @Test
    func restoredDraftPlacesCaretAtUTF16End() {
        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                previousText: "",
                newText: "🧪 restored draft",
                selectedLocation: 0
            ) == "🧪 restored draft".utf16.count
        )
    }

    @Test
    func externalRewriteClampsCaretIntoTheNewText() {
        #expect(
            FeatureComposerTextSelectionPolicy.cursorLocationAfterBindingUpdate(
                previousText: "a much longer draft",
                newText: "short",
                selectedLocation: 19
            ) == 5
        )
    }

    @Test
    @MainActor
    func imageCapableComposerAdvertisesImagesToTheNativePasteMenu() {
        let textView = FeatureComposerUITextView()

        textView.acceptsImages = true

        #expect(
            textView.pasteConfiguration?.acceptableTypeIdentifiers.contains(
                UTType.image.identifier
            ) == true
        )
        #expect(
            textView.pasteConfiguration?.acceptableTypeIdentifiers.contains(
                UTType.text.identifier
            ) == true
        )

        textView.acceptsImages = false

        #expect(textView.pasteConfiguration == nil)
    }

    @Test
    @MainActor
    func textViewDeclinesImageDropsSoTheComposerSurfaceOwnsThem() {
        let textView = FeatureComposerUITextView()
        textView.acceptsImages = true

        let image = NSItemProvider()
        image.registerDataRepresentation(
            forTypeIdentifier: UTType.png.identifier,
            visibility: .all
        ) { completion in
            completion(Data([0x89, 0x50, 0x4E, 0x47]), nil)
            return nil
        }
        let text = NSItemProvider(object: "caption" as NSString)

        #expect(!textView.canPaste([image]))
        #expect(!textView.canPaste([text, image]))
        #expect(textView.canPaste([text]))
    }

    @Test
    func downwardDragDismissalRespectsDraftScrolling() {
        #expect(FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: false, isAtTop: true
        ))
        // Scrolling back through a capped draft must not drop the keyboard…
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: true, isAtTop: false
        ))
        // …but a drag that begins at the top of the draft only rubber-bands,
        // and is the capped composer's one escape hatch.
        #expect(FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 2, translationY: 20, isScrollable: true, isAtTop: true
        ))
        // Mostly-horizontal drags are caret adjustments, not dismissals.
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 30, translationY: 12, isScrollable: false, isAtTop: true
        ))
        #expect(!FeatureComposerDragDismissPolicy.shouldDismiss(
            translationX: 0, translationY: 8, isScrollable: false, isAtTop: true
        ))
    }

    @Test
    func nativePasteDetectionUsesImageTypeConformance() {
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        pasteboard.items = [
            [UTType.heic.identifier: Data([0x00])],
        ]

        #expect(!pasteboard.hasImages)
        #expect(FeatureComposerPasteboardPolicy.containsImage(in: pasteboard))
    }

    @Test
    func nativePasteDetectionChecksEveryPasteboardItem() {
        let pasteboard = UIPasteboard.withUniqueName()
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        pasteboard.items = [
            [UTType.plainText.identifier: "caption"],
            [UTType.png.identifier: Data([0x89, 0x50, 0x4E, 0x47])],
        ]

        #expect(FeatureComposerPasteboardPolicy.containsImage(in: pasteboard))
    }

    @Test
    func detectsCommandsModelsSkillsAndPathsAtTheCursor() {
        #expect(
            FeatureComposerTriggerParser.detect(in: "/re")
                == FeatureComposerTrigger(kind: .slashCommand, query: "re", range: 0..<3)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "/model claude")
                == FeatureComposerTrigger(kind: .model, query: "claude", range: 0..<13)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "Use $dep")
                == FeatureComposerTrigger(kind: .skill, query: "dep", range: 4..<8)
        )
        #expect(
            FeatureComposerTriggerParser.detect(in: "Read @Sources/App")
                == FeatureComposerTrigger(kind: .path, query: "Sources/App", range: 5..<17)
        )

        let editedText = "Use @Sources/App then continue"
        #expect(
            FeatureComposerTriggerParser.detect(in: editedText, cursorOffset: 16)
                == FeatureComposerTrigger(kind: .path, query: "Sources/App", range: 4..<16)
        )
    }

    @Test
    func replacementsPreserveTextOutsideTheActiveTrigger() {
        let text = "Review @Sources/App please"
        let result = FeatureComposerTriggerParser.replacing(
            7..<19,
            in: text,
            with: "[App](Sources/App) "
        )
        #expect(result == "Review [App](Sources/App)  please")
    }

    @Test
    func fileLinksMatchTheSharedComposerFormat() {
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "path/to/package.json")
                == "[package.json](path/to/package.json)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "docs/My File (draft).md")
                == "[My File (draft).md](docs/My%20File%20%28draft%29.md)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "C:\\repo\\src\\index.ts")
                == "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)"
        )
        #expect(
            FeatureComposerFileLinkSerializer.markdownLink(for: "@scope/package.json")
                == "[package.json](@scope/package.json)"
        )
    }

    @Test
    func commandMenuIncludesProviderCommandsButNotRemovedMobileModes() throws {
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/"))
        let powerFeatures = FeatureComposerPowerFeatures(
            slashCommands: [
                FeatureProviderSlashCommand(name: "review", description: "Review changes"),
                FeatureProviderSlashCommand(name: "plan", description: "Legacy mode"),
                FeatureProviderSlashCommand(name: "default", description: "Legacy mode"),
            ]
        )
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: powerFeatures,
            pathEntries: []
        )

        #expect(items.map(\.label) == ["/model", "/review"])
    }

    @Test
    func slashMenuIncludesEnabledSkillsAndSuppressesMatchingCommands() throws {
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/"))
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(
                slashCommands: [
                    FeatureProviderSlashCommand(name: "deploy", description: "Old command"),
                    FeatureProviderSlashCommand(name: "review", description: "Review changes"),
                ],
                skills: [
                    FeatureProviderSkill(name: "deploy", displayName: "Deploy project"),
                    FeatureProviderSkill(name: "disabled", isEnabled: false),
                ]
            ),
            pathEntries: []
        )

        #expect(items.map(\.label) == ["/model", "/review", "Deploy project"])
    }

    @Test
    func skillMenusDedupeEnabledNamesBeforeSearchAndSorting() throws {
        let skills = [
            FeatureProviderSkill(name: " deploy ", displayName: "First deploy", isEnabled: false),
            FeatureProviderSkill(name: "Deploy", displayName: "Enabled deploy"),
            FeatureProviderSkill(name: " DEPLOY ", displayName: "Duplicate matching search"),
            FeatureProviderSkill(name: "review", displayName: "Review"),
        ]
        let allSkillsTrigger = try #require(FeatureComposerTriggerParser.detect(in: "$"))
        let searchedSkillsTrigger = try #require(
            FeatureComposerTriggerParser.detect(in: "$matching")
        )
        let searchedSlashTrigger = try #require(
            FeatureComposerTriggerParser.detect(in: "/skill:matching")
        )

        let allItems = FeatureComposerMenuBuilder.items(
            trigger: allSkillsTrigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(skills: skills),
            pathEntries: []
        )
        let searchedItems = FeatureComposerMenuBuilder.items(
            trigger: searchedSkillsTrigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(skills: skills),
            pathEntries: []
        )
        let searchedSlashItems = FeatureComposerMenuBuilder.items(
            trigger: searchedSlashTrigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(skills: skills),
            pathEntries: []
        )

        #expect(allItems.map(\.label) == ["Enabled deploy", "Review"])
        #expect(searchedItems.isEmpty)
        #expect(searchedSlashItems.isEmpty)
    }

    @Test
    func slashCommandsUseNormalizedNamesAndAllEnabledSkillsForSuppression() throws {
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/"))
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(
                slashCommands: [
                    FeatureProviderSlashCommand(name: " DEPLOY "),
                    FeatureProviderSlashCommand(name: " MODEL "),
                ],
                skills: [FeatureProviderSkill(name: "deploy", displayName: "Release project")]
            ),
            pathEntries: []
        )

        #expect(items.map(\.label) == ["/model", "Release project"])
    }

    @Test
    func slashSkillPrefixFiltersSkillsWithoutProviderCommands() throws {
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/skill:fix"))
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(
                slashCommands: [FeatureProviderSlashCommand(name: "fix")],
                skills: [
                    FeatureProviderSkill(name: "gh-fix-ci", displayName: "Fix CI"),
                    FeatureProviderSkill(name: "deploy"),
                ]
            ),
            pathEntries: []
        )

        #expect(items.map(\.label) == ["Fix CI"])
    }

    @Test
    func skillSourcesFollowProviderScopeAndPluginPaths() {
        #expect(FeatureProviderSkill(name: "repo", scope: "repository").source == .repository)
        #expect(FeatureProviderSkill(name: "local", scope: "workspace").source == .project)
        #expect(FeatureProviderSkill(name: "mine", scope: "user").source == .personal)
        #expect(FeatureProviderSkill(name: "built-in", scope: "system").source == .system)
        #expect(
            FeatureProviderSkill(
                name: "plugin",
                path: "/Users/theo/.codex/plugins/example/SKILL.md",
                scope: "user"
            ).source == .app
        )
    }

    @Test
    func appApprovalDecisionsKeepTheServerWireValues() {
        let decisions: [(FeatureApprovalDecision, String)] = [
            (.allowOnce, "accept"),
            (.allowForSession, "acceptForSession"),
            (.allowAlways, "acceptAlways"),
            (.deny, "decline"),
            (.cancel, "cancel"),
        ]

        for (decision, wireValue) in decisions {
            #expect(decision.wireValue == wireValue)
            #expect(FeatureApprovalDecision(wireValue: wireValue) == decision)
        }
        #expect(FeatureApprovalDecision(wireValue: "unsupported") == nil)
    }

    @Test
    func codexFeedbackCommandParsesOptionalReasonsWithoutMatchingOtherCommands() {
        #expect(FeatureCodexFeedbackCommand.parse(" /feedback ")?.reason == nil)
        #expect(
            FeatureCodexFeedbackCommand.parse("/feedback The agent stopped early.")?.reason
                == "The agent stopped early."
        )
        #expect(
            FeatureCodexFeedbackCommand.parse("/FEEDBACK  First line\nSecond line")?.reason
                == "First line\nSecond line"
        )
        #expect(FeatureCodexFeedbackCommand.parse("/feedback-status") == nil)
        #expect(FeatureCodexFeedbackCommand.parse("Please send /feedback") == nil)
    }

    @Test
    func modelAndSkillMenusFilterTheirCatalogs() throws {
        let provider = FeatureProvider(
            id: "claude",
            name: "Claude",
            models: [
                FeatureModel(id: "sonnet", name: "Sonnet"),
                FeatureModel(id: "opus", name: "Opus"),
            ]
        )
        let modelTrigger = try #require(
            FeatureComposerTriggerParser.detect(in: "/model op")
        )
        let modelItems = FeatureComposerMenuBuilder.items(
            trigger: modelTrigger,
            providers: [provider],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: .disabled,
            pathEntries: []
        )
        #expect(modelItems.map(\.label) == ["Opus"])

        let skillTrigger = try #require(FeatureComposerTriggerParser.detect(in: "$fix"))
        let skillItems = FeatureComposerMenuBuilder.items(
            trigger: skillTrigger,
            providers: [provider],
            currentSelection: nil,
            threadSelection: nil,
            powerFeatures: FeatureComposerPowerFeatures(
                skills: [
                    FeatureProviderSkill(
                        name: "gh-fix-ci",
                        displayName: "Fix CI",
                        shortDescription: "Repair failing checks"
                    ),
                    FeatureProviderSkill(name: "deploy", displayName: "Deploy")
                ]
            ),
            pathEntries: []
        )
        #expect(skillItems.map(\.label) == ["Fix CI"])
    }

    @Test
    func modelCommandHonorsProvidersThatLockAThreadModel() throws {
        let provider = FeatureProvider(
            id: "locked",
            name: "Locked provider",
            requiresNewThreadForModelChange: true,
            models: [
                FeatureModel(id: "current", name: "Current"),
                FeatureModel(id: "other", name: "Other"),
            ]
        )
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/model"))
        let currentSelection = FeatureSelection(
            providerID: "locked",
            modelID: "current",
            options: [FeatureModelOptionSelection(id: "reasoning", value: .string("high"))]
        )
        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [provider],
            currentSelection: currentSelection,
            threadSelection: currentSelection,
            powerFeatures: .disabled,
            pathEntries: []
        )

        #expect(items.map(\.label) == ["Current"])
        if case let .model(selection, _, _) = try #require(items.first) {
            #expect(selection.options == currentSelection.options)
        } else {
            Issue.record("Expected a model menu item")
        }
    }

    @Test
    func establishedThreadsKeepModelChoicesOnTheirProvider() throws {
        let currentProvider = FeatureProvider(
            id: "codex",
            name: "Codex",
            models: [
                FeatureModel(id: "current", name: "Current"),
                FeatureModel(id: "other", name: "Other"),
            ]
        )
        let otherProvider = FeatureProvider(
            id: "claude",
            name: "Claude",
            models: [FeatureModel(id: "sonnet", name: "Sonnet")]
        )
        let selection = FeatureSelection(providerID: "codex", modelID: "current")
        let trigger = try #require(FeatureComposerTriggerParser.detect(in: "/model"))

        let items = FeatureComposerMenuBuilder.items(
            trigger: trigger,
            providers: [currentProvider, otherProvider],
            currentSelection: selection,
            threadSelection: selection,
            powerFeatures: .disabled,
            pathEntries: []
        )

        #expect(items.map(\.label) == ["Current", "Other"])
    }

    @Test
    func inlineSkillTokensUseProviderLabelsAndWebBoundaries() throws {
        let skills = [
            FeatureProviderSkill(name: "file-pr", displayName: "File PR"),
            FeatureProviderSkill(name: "review-follow-up"),
        ]

        let completed = FeatureInlineSkillParser.descriptors(
            in: "Use $file-pr then ",
            skills: skills,
            allowsEndBoundary: false
        )
        #expect(completed.map(\.rawText) == ["$file-pr"])
        #expect(completed.map(\.displayName) == ["File PR"])

        #expect(
            FeatureInlineSkillParser.descriptors(
                in: "$review-follow-up",
                skills: skills,
                allowsEndBoundary: true
            ).map(\.displayName) == ["Review Follow Up"]
        )
        #expect(
            FeatureInlineSkillParser.descriptors(
                in: "$file-pr",
                skills: skills,
                allowsEndBoundary: false
            ).isEmpty
        )
        #expect(
            FeatureInlineSkillParser.descriptors(
                in: "prefix$file-pr ",
                skills: skills,
                allowsEndBoundary: true
            ).isEmpty
        )
    }

    @Test @MainActor
    func inlineSkillAttachmentsRoundTripPlainTextAndSelectionOffsets() throws {
        let source = "Use $file-pr now"
        let descriptors = FeatureInlineSkillParser.descriptors(
            in: source,
            skills: [FeatureProviderSkill(name: "file-pr", displayName: "File PR")],
            allowsEndBoundary: false
        )
        let font = UIFont.preferredFont(forTextStyle: .body)
        let attributed = FeatureInlineSkillPillRenderer.attributedText(
            source: source,
            descriptors: descriptors,
            baseAttributes: [.font: font],
            font: font,
            traits: UITraitCollection(userInterfaceStyle: .dark)
        )

        #expect(FeatureInlineSkillProjection.plainText(from: attributed) == source)
        #expect(FeatureInlineSkillProjection.signatures(in: attributed).count == 1)
        #expect(attributed.string == "Use \u{FFFC} now")

        let plainAfterSkill = NSMaxRange(try #require(descriptors.first).range)
        let displaySelection = FeatureInlineSkillProjection.displayRange(
            for: NSRange(location: plainAfterSkill, length: 0),
            in: attributed
        )
        #expect(displaySelection == NSRange(location: 5, length: 0))
        #expect(
            FeatureInlineSkillProjection.plainRange(
                for: displaySelection,
                in: attributed
            ) == NSRange(location: plainAfterSkill, length: 0)
        )
    }

    @Test @MainActor
    func inlineSkillProjectionIgnoresPillMetadataInheritedByTypedText() throws {
        let source = "$file-pr"
        let descriptors = FeatureInlineSkillParser.descriptors(
            in: source,
            skills: [FeatureProviderSkill(name: "file-pr", displayName: "File PR")],
            allowsEndBoundary: true
        )
        let font = UIFont.preferredFont(forTextStyle: .body)
        let attributed = FeatureInlineSkillPillRenderer.attributedText(
            source: source,
            descriptors: descriptors,
            baseAttributes: [.font: font],
            font: font,
            traits: UITraitCollection(userInterfaceStyle: .dark)
        )
        let typedTextAttributes = attributed.attributes(at: 0, effectiveRange: nil)
            .filter { $0.key != .attachment }
        let afterTyping = NSMutableAttributedString(attributedString: attributed)
        afterTyping.append(NSAttributedString(string: "x", attributes: typedTextAttributes))

        #expect(FeatureInlineSkillProjection.plainText(from: afterTyping) == "$file-prx")
        #expect(FeatureInlineSkillProjection.signatures(in: afterTyping).count == 1)
    }

    @Test
    func completedComposerPillSurvivesDeletingItsTrailingSpace() throws {
        let skill = FeatureProviderSkill(name: "file-pr", displayName: "File PR")
        let completed = try #require(
            FeatureInlineSkillParser.descriptors(
                in: "$file-pr ",
                skills: [skill],
                allowsEndBoundary: false
            ).first
        )
        #expect(
            FeatureInlineSkillParser.descriptors(
                in: "$file-pr",
                skills: [skill],
                allowsEndBoundary: false,
                preservingTrailing: completed
            ) == [completed]
        )
    }

    @Test
    func changingInputQuestionsKeepsAValidActiveQuestionAndDropsStaleAnswers() {
        #expect(
            FeatureComposerQuestionReconciliation.index(
                current: 2,
                previousQuestionIDs: ["one", "two", "three"],
                currentQuestionIDs: ["one"]
            ) == 0
        )
        #expect(
            FeatureComposerQuestionReconciliation.index(
                current: 1,
                previousQuestionIDs: ["one", "two", "three"],
                currentQuestionIDs: ["three", "two"]
            ) == 1
        )

        let reconciled = FeatureComposerQuestionReconciliation.answers(
            [
                "one": .text("keep"),
                "removed": .text("drop"),
            ],
            currentQuestionIDs: ["one"]
        )
        #expect(reconciled == ["one": .text("keep")])
    }

    @Test
    func onlyTheExplicitComposerButtonCanSend() {
        #expect(
            FeatureComposerSubmissionPolicy.allowsSend(for: .explicitButton)
        )
        #expect(
            !FeatureComposerSubmissionPolicy.allowsSend(for: .returnKey)
        )
    }
}
