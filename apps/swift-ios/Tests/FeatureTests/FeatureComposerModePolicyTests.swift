import Foundation
import Testing
@testable import T3Code

@Suite("Composer modes and provider handoff")
struct FeatureComposerModePolicyTests {
    @Test
    func followUpsDefaultToQueueAndPersistTheSteerPreference() throws {
        let legacy = try JSONDecoder().decode(FeatureSettings.self, from: Data("{}".utf8))
        #expect(legacy.followUpBehavior == .queue)
        #expect(!legacy.legacyPlanModeEnabled)
        let settings = FeatureSettings(followUpBehavior: .steer, legacyPlanModeEnabled: true)
        let restored = try JSONDecoder().decode(FeatureSettings.self, from: JSONEncoder().encode(settings))
        #expect(restored.followUpBehavior == .steer)
        #expect(restored.legacyPlanModeEnabled)

        let queued = FeatureComposerSendPresentation.resolve(
            isWorking: true, canSteer: true, followUpBehavior: legacy.followUpBehavior
        )
        #expect(queued.delivery == .queue)
        #expect(queued.label == "Queue")
        #expect(queued.alternateDelivery == .auto)
        let steering = FeatureComposerSendPresentation.resolve(
            isWorking: true, canSteer: true, followUpBehavior: restored.followUpBehavior
        )
        #expect(steering.delivery == .auto)
        #expect(steering.label == "Steer")
        #expect(steering.alternateDelivery == .queue)
        let legacyDelivery = FeatureComposerSendPresentation.resolve(
            isWorking: true, canSteer: false, followUpBehavior: .queue, supportsExplicitDelivery: false
        )
        #expect(legacyDelivery.delivery == .auto)
        #expect(legacyDelivery.alternateDelivery == nil)
        #expect(FeatureComposerSendPresentation.resolve(
            isWorking: true, canSteer: false, followUpBehavior: .steer
        ).delivery == .queue)
        #expect(FeatureComposerSendPresentation.resolve(
            isWorking: false, canSteer: true, followUpBehavior: .queue
        ).label == "Send")
    }

    @Test
    func deliberateHandoffSurvivesPickerAndSlashMenuValidation() {
        let inherited = FeatureSelection(providerID: "first", modelID: "one")
        let override = FeatureSelection(providerID: "second", modelID: "two")
        let providers = Self.providers
        // Restored input survives a temporary loss of the handoff capability.
        #expect(ThreadComposerModelSelectionPolicy.preservedSelection(override, providers: providers) == override)
        #expect(ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: override, inherited: inherited, providers: providers, allowProviderSwitch: false
        ) == override)
        #expect(ProviderModelDraftPolicy.validated(
            override, providers: providers, inheriting: inherited, allowsProviderChange: false
        ) == nil)
        #expect(ThreadComposerModelSelectionPolicy.explicitSelection(
            override, inherited: inherited, providers: providers
        ) == nil)
        #expect(ThreadComposerModelSelectionPolicy.explicitSelection(
            override, inherited: inherited, providers: providers, allowProviderSwitch: true
        ) == override)
        #expect(ThreadComposerModelSelectionPolicy.resolvedSelection(
            explicit: nil, inherited: inherited, providers: providers, allowProviderSwitch: true
        ) == inherited)
        #expect(ProviderModelDraftPolicy.validated(
            override, providers: providers, inheriting: inherited, allowsProviderChange: true
        ) == override)
        let items = FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .model, query: "", range: 0..<7), providers: providers,
            currentSelection: nil, threadSelection: inherited, powerFeatures: .disabled,
            pathEntries: [], allowProviderSwitch: true
        )
        #expect(items.contains { $0.id == "model:second:two" })
    }

    @Test
    func handoffNeverUnlocksSameProviderModelsThatRequireANewThread() {
        var providers = Self.providers
        providers[0].requiresNewThreadForModelChange = true
        providers[0].models.append(.init(id: "other", name: "Other"))
        let inherited = FeatureSelection(providerID: "first", modelID: "one")
        let override = FeatureSelection(providerID: "first", modelID: "other")
        #expect(ThreadComposerModelSelectionPolicy.explicitSelection(
            override, inherited: inherited, providers: providers, allowProviderSwitch: true
        ) == nil)
        #expect(ProviderModelDraftPolicy.validated(
            override, providers: providers, inheriting: inherited, allowsProviderChange: true
        ) == nil)
        let items = FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .model, query: "", range: 0..<7), providers: providers,
            currentSelection: nil, threadSelection: inherited, powerFeatures: .disabled,
            pathEntries: [], allowProviderSwitch: true
        )
        #expect(!items.contains { $0.id == "model:first:other" })
        #expect(items.contains { $0.id == "model:second:two" })
    }

    @Test
    func handoffUsesV2SessionCapabilitiesAndDetachedHistory() {
        #expect(!FeatureProviderHandoffPolicy.allowsProviderSwitch(projection: nil))
        #expect(FeatureProviderHandoffPolicy.allowsProviderSwitch(projection: Self.projection()))
        #expect(FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "running", supportsHandoff: true)
        ))
        #expect(!FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "running", supportsHandoff: false)
        ))
        #expect(!FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "preparing")
        ))
        #expect(FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "completed", nativeThreadRef: .object(["id": .string("native")]))
        ))
        #expect(!FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "completed")
        ))
        #expect(FeatureProviderHandoffPolicy.allowsProviderSwitch(
            projection: Self.projection(runStatus: "completed", historyOrigin: "v1_import")
        ))
    }

    @Test
    func permissionChoicesUseModelCapabilitiesAndKeepSupportedDefaults() {
        var providers = Self.providers
        providers[0].models[0].supportedRuntimeModes = [.approvalRequired, .autoAcceptEdits]
        let choices = FeatureComposerModePolicy.runtimeModes(
            for: .init(providerID: "first", modelID: "one"), providers: providers
        )
        #expect(choices == [.approvalRequired, .autoAcceptEdits])
        #expect(FeatureComposerModePolicy.compatibleRuntimeMode(.autoAcceptEdits, choices: choices) == .autoAcceptEdits)
        #expect(FeatureComposerModePolicy.compatibleRuntimeMode(.fullAccess, choices: choices) == .approvalRequired)
        providers[0].models[0].supportedRuntimeModes = []
        #expect(FeatureComposerModePolicy.runtimeModes(
            for: .init(providerID: "first", modelID: "one"), providers: providers
        ) == [.approvalRequired, .autoAcceptEdits, .automatic, .fullAccess])
    }

    @Test
    func legacyPlanSwitchAndProviderNativeCommandRemainDistinct() {
        let items = FeatureComposerMenuBuilder.items(
            trigger: .init(kind: .slashCommand, query: "plan", range: 0..<5), providers: [],
            currentSelection: nil, threadSelection: nil,
            powerFeatures: .init(slashCommands: [.init(name: "plan", description: "Provider plan")]),
            pathEntries: [], allowInteractionMode: true
        )
        #expect(items.contains(.interactionMode(.plan)))
        #expect(items.contains(.providerCommand(.init(name: "plan", description: "Provider plan"))))
        #expect(Set(items.map(\.id)).count == 2)
        var provider = Self.providers[0]
        #expect(FeatureComposerModePolicy.interactionMode(.plan, provider: provider) == .plan)
        provider.showInteractionModeToggle = false
        #expect(FeatureComposerModePolicy.interactionMode(.plan, provider: provider) == .standard)
        #expect(FeatureInteractionMode.plan.mobileNormalized == .plan)
    }

    @Test
    func ordinaryFilesUseEnvironmentLimitsWithoutRequiringImages() {
        let file = FeatureDraftAttachment(data: Data("notes".utf8), filename: "notes.txt", mimeType: "text/plain")
        let image = FeatureDraftAttachment(data: Data([1]), filename: "photo.png", mimeType: "image/png")
        #expect(FeatureComposerAttachmentEligibility.validationMessage(
            attachments: [file], imagesAllowed: false, maximumFileBytes: 5
        ) == nil)
        #expect(FeatureComposerAttachmentEligibility.validationMessage(
            attachments: [file], imagesAllowed: false, maximumFileBytes: nil
        ) != nil)
        #expect(FeatureComposerAttachmentEligibility.validationMessage(
            attachments: [file], imagesAllowed: false, maximumFileBytes: 4
        ) != nil)
        #expect(FeatureComposerAttachmentEligibility.validationMessage(
            attachments: [file, image], imagesAllowed: false, maximumFileBytes: 5
        ) == "This model does not support images.")
    }

    @Test
    func retainedAttachmentsAllowSavingWithoutReuploadCapabilities() {
        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "", attachmentCount: 0, imagesAllowed: false,
            isSending: false, preparationState: .init(), retainedAttachmentCount: 1
        ))
        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "", attachmentCount: 0, imagesAllowed: false,
            isSending: false, preparationState: .init()
        ))
        // Existing uploads do not exempt a newly added image from model support.
        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "Edit", attachmentCount: 1, imagesAllowed: false,
            isSending: false, preparationState: .init(), retainedAttachmentCount: 1
        ))
    }

    @Test
    func retainedAndNewAttachmentsShareTheSubmissionLimit() {
        #expect(FeatureComposerSubmissionEligibility.canSend(
            text: "", attachmentCount: 1, imagesAllowed: false,
            filesAllowed: true, containsImages: false, containsFiles: true,
            isSending: false, preparationState: .init(), retainedAttachmentCount: 99
        ))
        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "Edit", attachmentCount: 1, imagesAllowed: true,
            isSending: false, preparationState: .init(), retainedAttachmentCount: 100
        ))
        #expect(!FeatureComposerSubmissionEligibility.canSend(
            text: "Edit", attachmentCount: 0, imagesAllowed: false,
            isSending: false, preparationState: .init(), retainedAttachmentCount: 101
        ))
    }

    private static var providers: [FeatureProvider] {
        [
            .init(id: "first", name: "First", models: [.init(id: "one", name: "One")]),
            .init(id: "second", name: "Second", models: [.init(id: "two", name: "Two")]),
        ]
    }

    private static func projection(
        runStatus: String? = nil,
        supportsHandoff: Bool? = nil,
        nativeThreadRef: JSONValue = .null,
        historyOrigin: String = "native"
    ) -> JSONValue {
        .object([
            "thread": .object([
                "id": .string("thread"), "historyOrigin": .string(historyOrigin),
                "activeProviderThreadId": .string("provider-thread"),
                "modelSelection": .object(["instanceId": .string("first")]),
            ]),
            "runs": .array(runStatus.map { [.object([
                "status": .string($0), "providerThreadId": .string("provider-thread"),
            ])] } ?? []),
            "providerThreads": .array([.object([
                "id": .string("provider-thread"), "appThreadId": .string("thread"),
                "providerInstanceId": .string("first"), "nativeThreadRef": nativeThreadRef,
                "providerSessionId": supportsHandoff == nil ? .null : .string("session"),
            ])]),
            "providerSessions": .array(supportsHandoff.map { [.object([
                "id": .string("session"), "status": .string("ready"),
                "capabilities": .object(["sessions": .object([
                    "supportsProviderSwitchingViaHandoff": .bool($0),
                ])]),
            ])] } ?? []),
        ])
    }
}
