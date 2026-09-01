import Foundation
import SwiftUI
import Testing
import UIKit
@testable import T3Code

@Suite("Text and code size preferences")
struct TextSizePreferenceTests {
    @Test
    func shiftsComposeWithDynamicTypeAndSaturateAtTheEnds() {
        #expect(DynamicTypeSize.large.t3Shifted(by: 1) == .xLarge)
        #expect(DynamicTypeSize.small.t3Shifted(by: 1) == .medium)
        #expect(DynamicTypeSize.large.t3Shifted(by: -2) == .small)
        #expect(DynamicTypeSize.xSmall.t3Shifted(by: -2) == .xSmall)
        #expect(DynamicTypeSize.accessibility5.t3Shifted(by: 3) == .accessibility5)
    }

    @Test
    func windowCategoryShiftUsesTheSameSaturatingScale() {
        #expect(T3TextSizing.contentSizeCategory(system: .large, steps: 3) == .extraExtraExtraLarge)
        #expect(T3TextSizing.contentSizeCategory(system: .large, steps: -2) == .small)
        #expect(T3TextSizing.contentSizeCategory(system: .extraSmall, steps: -2) == .extraSmall)
        #expect(
            T3TextSizing.contentSizeCategory(
                system: .accessibilityExtraExtraExtraLarge,
                steps: 3
            ) == .accessibilityExtraExtraExtraLarge
        )
        #expect(T3TextSizing.contentSizeCategory(system: .unspecified, steps: 2) == .unspecified)
    }

    @Test
    func adjustmentClampsAndRoundTripsAsAStepCount() throws {
        #expect(FeatureTextSizeAdjustment(steps: 99).steps == 3)
        #expect(FeatureTextSizeAdjustment(steps: -99).steps == -2)
        let encoded = try JSONEncoder.t3.encode(FeatureTextSizeAdjustment(steps: 2))
        #expect(String(decoding: encoded, as: UTF8.self) == "2")
        let decoded = try JSONDecoder.t3.decode(
            FeatureTextSizeAdjustment.self,
            from: Data("9".utf8)
        )
        #expect(decoded.steps == 3)
    }

    @Test
    func legacySettingsDecodeAtSystemSizes() throws {
        let legacy = Data(
            #"{"appearance":"dark","hapticsEnabled":false,"notificationsEnabled":true}"#.utf8
        )
        let decoded = try JSONDecoder.t3.decode(FeatureSettings.self, from: legacy)

        #expect(decoded.appearance == .dark)
        #expect(decoded.textSize == .standard)
        #expect(decoded.codeSize == .standard)
        #expect(!decoded.hapticsEnabled)
    }

    @Test
    func settingsRoundTripBothSizeChoices() throws {
        var settings = FeatureSettings()
        settings.textSize = FeatureTextSizeAdjustment(steps: 2)
        settings.codeSize = FeatureTextSizeAdjustment(steps: -1)

        let decoded = try JSONDecoder.t3.decode(
            FeatureSettings.self,
            from: JSONEncoder.t3.encode(settings)
        )

        #expect(decoded.textSize.steps == 2)
        #expect(decoded.codeSize.steps == -1)
    }

    @Test
    func staleFailedSaveCannotRollbackANewerSliderChoice() {
        #expect(
            !SettingsView.shouldRollbackTextSizes(
                currentTextSize: .init(steps: 3),
                currentCodeSize: .init(steps: 1),
                failedTextSize: .init(steps: 2),
                failedCodeSize: .init(steps: 1)
            )
        )
        #expect(
            SettingsView.shouldRollbackTextSizes(
                currentTextSize: .init(steps: 2),
                currentCodeSize: .init(steps: 1),
                failedTextSize: .init(steps: 2),
                failedCodeSize: .init(steps: 1)
            )
        )
    }
}
