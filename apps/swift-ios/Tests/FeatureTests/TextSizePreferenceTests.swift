import Foundation
import SwiftUI
import Testing
import UIKit
@testable import T3Code

@Suite("Text and code size preferences")
struct TextSizePreferenceTests {
    @Test
    func shiftingComposesWithTheReadersDynamicTypeSizeRatherThanReplacingIt() {
        // The same preference lands in a different place depending on where the
        // reader's system text size already sits — that is the whole point of
        // shifting instead of pinning to an absolute size.
        #expect(DynamicTypeSize.large.t3Shifted(by: 1) == .xLarge)
        #expect(DynamicTypeSize.small.t3Shifted(by: 1) == .medium)
        #expect(DynamicTypeSize.accessibility3.t3Shifted(by: 1) == .accessibility4)
        #expect(DynamicTypeSize.large.t3Shifted(by: -2) == .small)
        #expect(DynamicTypeSize.large.t3Shifted(by: 0) == .large)
    }

    @Test
    func shiftingSaturatesAtBothEndsOfTheDynamicTypeScale() {
        #expect(DynamicTypeSize.xSmall.t3Shifted(by: -2) == .xSmall)
        #expect(DynamicTypeSize.small.t3Shifted(by: -2) == .xSmall)
        #expect(DynamicTypeSize.accessibility5.t3Shifted(by: 3) == .accessibility5)
        #expect(DynamicTypeSize.accessibility4.t3Shifted(by: 3) == .accessibility5)
    }

    @Test
    func windowContentSizeCategoryShiftsTheReadersOwnCategory() {
        // The app text size crosses sheets and UIKit-hosted cells as a window
        // trait override, so this UIKit-side ladder has to shift and saturate
        // exactly like the SwiftUI-side one.
        #expect(T3TextSizing.contentSizeCategory(system: .large, steps: 3) == .extraExtraExtraLarge)
        #expect(T3TextSizing.contentSizeCategory(system: .large, steps: -2) == .small)
        #expect(T3TextSizing.contentSizeCategory(system: .large, steps: 0) == .large)
        #expect(
            T3TextSizing.contentSizeCategory(system: .accessibilityLarge, steps: 1)
                == .accessibilityExtraLarge
        )
        #expect(T3TextSizing.contentSizeCategory(system: .extraSmall, steps: -2) == .extraSmall)
        #expect(
            T3TextSizing.contentSizeCategory(
                system: .accessibilityExtraExtraExtraLarge,
                steps: 3
            ) == .accessibilityExtraExtraExtraLarge
        )
        // An unknown category must pass through rather than snap to a default.
        #expect(T3TextSizing.contentSizeCategory(system: .unspecified, steps: 2) == .unspecified)
    }

    @Test
    func adjustmentClampsToItsSupportedRange() {
        #expect(FeatureTextSizeAdjustment(steps: 99).steps == FeatureTextSizeAdjustment.range.upperBound)
        #expect(FeatureTextSizeAdjustment(steps: -99).steps == FeatureTextSizeAdjustment.range.lowerBound)
        #expect(FeatureTextSizeAdjustment.standard.steps == 0)
    }

    @Test
    func adjustmentEncodesAsABareStepCountAndClampsOnDecode() throws {
        let encoded = try JSONEncoder.t3.encode(FeatureTextSizeAdjustment(steps: 2))
        #expect(String(decoding: encoded, as: UTF8.self) == "2")

        // A payload written by a future build with a wider range must not widen
        // this one's range when it is read back.
        let outOfRange = try JSONDecoder.t3.decode(
            FeatureTextSizeAdjustment.self,
            from: Data("9".utf8)
        )
        #expect(outOfRange.steps == FeatureTextSizeAdjustment.range.upperBound)
    }

    @Test
    func settingsDefaultToSystemSizesAndSurviveEncodingRoundTrip() throws {
        #expect(FeatureSettings().textSize == .standard)
        #expect(FeatureSettings().codeSize == .standard)

        var settings = FeatureSettings()
        settings.textSize = FeatureTextSizeAdjustment(steps: 2)
        settings.codeSize = FeatureTextSizeAdjustment(steps: -1)
        let roundTrip = try JSONDecoder.t3.decode(
            FeatureSettings.self,
            from: JSONEncoder.t3.encode(settings)
        )

        #expect(roundTrip.textSize.steps == 2)
        #expect(roundTrip.codeSize.steps == -1)
    }

    @Test
    func settingsSavedBeforeSizePreferencesExistedDecodeAtTheSystemSize() throws {
        let legacy = Data(
            #"{"appearance":"dark","hapticsEnabled":false,"notificationsEnabled":true}"#.utf8
        )
        let decoded = try JSONDecoder.t3.decode(FeatureSettings.self, from: legacy)

        #expect(decoded.appearance == .dark)
        #expect(decoded.textSize == .standard)
        #expect(decoded.codeSize == .standard)
        #expect(!decoded.hapticsEnabled)
    }
}
