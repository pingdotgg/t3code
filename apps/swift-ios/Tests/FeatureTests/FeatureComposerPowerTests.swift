import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Composer power features")
struct FeatureComposerPowerTests {
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
            ) == 110
        )
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

    @Test(
        "The traits menu renders every supported descriptor in catalog order",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func traitsMenuIncludesReasoningAndServiceTierWithDescriptorMetadata() throws {
        let control = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: .init(
                    providerID: "codex",
                    modelID: "gpt-5.6-sol",
                    options: [.init(id: "reasoningEffort", value: .string("high"))]
                ),
                inherited: nil,
                providers: [Self.solProvider],
                materializesDefaultSelection: true
            )
        )

        #expect(control.sections.map(\.id) == ["reasoningEffort", "serviceTier"])
        #expect(control.sections.map(\.label) == ["Reasoning", "Service Tier"])
        let reasoning = try #require(control.sections.first)
        #expect(reasoning.choices.map(\.id) == ["low", "medium", "high", "xhigh", "max", "ultra"])
        #expect(reasoning.choices.first?.isDefault == true)
        #expect(reasoning.currentChoiceID == "high")
        let serviceTier = try #require(control.sections.last)
        #expect(serviceTier.choices.map(\.label) == ["Standard", "Fast"])
        #expect(serviceTier.choices.first?.isDefault == true)
        #expect(serviceTier.currentChoiceID == "default")
        #expect(serviceTier.choices.last?.detail == "1.5x speed, increased usage.")
    }

    @Test(
        "The traits trigger matches Electron's Standard and Fast display",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func traitsTriggerUsesReasoningTextAndFastModeBolt() throws {
        let standard = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: .init(
                    providerID: "codex",
                    modelID: "gpt-5.6-sol",
                    options: [
                        .init(id: "reasoningEffort", value: .string("high")),
                        .init(id: "serviceTier", value: .string("default")),
                    ]
                ),
                inherited: nil,
                providers: [Self.solProvider],
                materializesDefaultSelection: true
            )
        )
        let fastSelection = standard.selection(choosing: "priority", in: "serviceTier")
        let fast = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: fastSelection,
                inherited: nil,
                providers: [Self.solProvider],
                materializesDefaultSelection: true
            )
        )

        #expect(standard.triggerLabel == "High")
        #expect(!standard.showsFastModeIcon)
        #expect(fast.triggerLabel == "High")
        #expect(fast.showsFastModeIcon)
    }

    @Test(
        "Trait choices materialize defaults and persist through subsequent turns",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func traitChoicesPersistBothEffectiveSelectionsOnTheSubmissionPath() throws {
        let inherited = FeatureSelection(
            providerID: "codex",
            modelID: "gpt-5.6-sol",
            options: [.init(id: "futureOption", value: .string("preserve-me"))]
        )
        let initial = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: nil,
                inherited: inherited,
                providers: [Self.solProvider],
                materializesDefaultSelection: false
            )
        )
        let reasoningSelection = initial.selection(choosing: "xhigh", in: "reasoningEffort")
        let afterReasoning = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: reasoningSelection,
                inherited: inherited,
                providers: [Self.solProvider],
                materializesDefaultSelection: false
            )
        )
        let effectiveSelection = afterReasoning.selection(
            choosing: "priority",
            in: "serviceTier"
        )
        let submission = FeatureMessageSubmission(
            threadID: "thread-1",
            text: "Continue",
            selection: effectiveSelection
        )

        #expect(submission.selection?.providerID == "codex")
        #expect(submission.selection?.modelID == "gpt-5.6-sol")
        #expect(
            submission.selection?.options.first(where: { $0.id == "reasoningEffort" })?.value
                == .string("xhigh")
        )
        #expect(
            submission.selection?.options.first(where: { $0.id == "serviceTier" })?.value
                == .string("priority")
        )
        #expect(
            submission.selection?.options.first(where: { $0.id == "futureOption" })?.value
                == .string("preserve-me")
        )
        #expect(submission.selection?.options.filter { $0.id == "reasoningEffort" }.count == 1)
        #expect(submission.selection?.options.filter { $0.id == "serviceTier" }.count == 1)
    }

    @Test(
        "Defaults, inherited selections, and provider changes resolve independently",
        .bug("https://github.com/pingdotgg/t3code/pull/7344#discussion_r3826822638")
    )
    func traitsFollowTheEffectiveModelSelection() throws {
        let defaultControl = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: .init(providerID: "codex", modelID: "missing"),
                inherited: nil,
                providers: [Self.solProvider],
                materializesDefaultSelection: true
            )
        )
        #expect(defaultControl.sections.map(\.currentChoiceID) == ["low", "default"])

        let inheritedControl = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: nil,
                inherited: .init(
                    providerID: "codex",
                    modelID: "gpt-5.6-sol",
                    options: [
                        .init(id: "reasoningEffort", value: .string("max")),
                        .init(id: "serviceTier", value: .string("priority")),
                    ]
                ),
                providers: [Self.solProvider],
                materializesDefaultSelection: false
            )
        )
        #expect(inheritedControl.sections.map(\.currentChoiceID) == ["max", "priority"])

        let plainProvider = FeatureProvider(
            id: "plain",
            name: "Plain",
            driver: "grok",
            models: [FeatureModel(id: "basic", name: "Basic")]
        )
        #expect(
            FeatureComposerTraitsControl.resolve(
                explicit: .init(providerID: "plain", modelID: "basic"),
                inherited: nil,
                providers: [Self.solProvider, plainProvider],
                materializesDefaultSelection: true
            ) == nil
        )
    }

    @Test(
        "Unsupported descriptors hide while boolean descriptors remain selectable",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func unsupportedDescriptorsDoNotCreateSections() throws {
        let provider = FeatureProvider(
            id: "mixed",
            name: "Mixed",
            driver: "cursor",
            models: [
                FeatureModel(
                    id: "mixed-model",
                    name: "Mixed model",
                    isDefault: true,
                    options: [
                        .init(id: "empty", label: "Empty", kind: .select),
                        .init(
                            id: "promptEffort",
                            label: "Prompt effort",
                            kind: .select,
                            choices: [.init(id: "ultrathink", label: "Ultrathink")],
                            promptInjectedValues: ["ultrathink"]
                        ),
                        .init(
                            id: "thinking",
                            label: "Thinking",
                            kind: .boolean,
                            defaultValue: .boolean(false)
                        ),
                    ]
                ),
            ]
        )
        let control = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: nil,
                inherited: nil,
                providers: [provider],
                materializesDefaultSelection: true
            )
        )

        #expect(control.sections.map(\.id) == ["thinking"])
        #expect(control.sections[0].choices.map(\.id) == ["on", "off"])
        #expect(control.sections[0].currentChoiceID == "off")
        #expect(control.sections[0].choices.allSatisfy { !$0.isDefault })
        #expect(control.triggerLabel == "Thinking Off")
    }

    @Test(
        "Changing a visible trait preserves a hidden prompt-injected selection",
        .bug("https://github.com/saphid/t3code-personal/issues/110")
    )
    func visibleTraitChangesPreservePromptInjectedSelections() throws {
        var provider = Self.solProvider
        provider.models[0].options[0].promptInjectedValues = ["ultrathink"]
        let control = try #require(
            FeatureComposerTraitsControl.resolve(
                explicit: .init(
                    providerID: "codex",
                    modelID: "gpt-5.6-sol",
                    options: [
                        .init(id: "reasoningEffort", value: .string("ultrathink")),
                        .init(id: "serviceTier", value: .string("default")),
                    ]
                ),
                inherited: nil,
                providers: [provider],
                materializesDefaultSelection: true
            )
        )

        #expect(control.sections[0].choices.allSatisfy { $0.id != "ultrathink" })
        #expect(control.sections[0].currentChoiceID == "ultrathink")
        let selection = control.selection(choosing: "priority", in: "serviceTier")
        #expect(
            selection.options.first(where: { $0.id == "reasoningEffort" })?.value
                == .string("ultrathink")
        )
        #expect(
            selection.options.first(where: { $0.id == "serviceTier" })?.value
                == .string("priority")
        )
    }

    /// Mirrors the live Codex descriptors Alex supplied for `gpt-5.6-sol`.
    private static let solProvider = FeatureProvider(
        id: "codex",
        name: "Codex",
        driver: "codex",
        models: [
            FeatureModel(
                id: "gpt-5.6-sol",
                name: "GPT-5.6-Sol",
                isDefault: true,
                options: [
                    .init(
                        id: "reasoningEffort",
                        label: "Reasoning",
                        kind: .select,
                        choices: [
                            .init(id: "low", label: "Low", isDefault: true),
                            .init(id: "medium", label: "Medium"),
                            .init(id: "high", label: "High"),
                            .init(id: "xhigh", label: "Extra High"),
                            .init(id: "max", label: "Max"),
                            .init(id: "ultra", label: "Ultra"),
                        ]
                    ),
                    .init(
                        id: "serviceTier",
                        label: "Service Tier",
                        kind: .select,
                        choices: [
                            .init(id: "default", label: "Standard", isDefault: true),
                            .init(
                                id: "priority",
                                label: "Fast",
                                detail: "1.5x speed, increased usage."
                            ),
                        ]
                    ),
                ]
            ),
        ]
    )

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
