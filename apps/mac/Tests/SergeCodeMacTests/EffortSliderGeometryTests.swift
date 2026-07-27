import Testing

@testable import SergeCodeMac

@Suite("Effort slider geometry")
struct EffortSliderGeometryTests {
    /// 5 stops on a 330pt track with a 30pt knob: span 300, one detent per 75pt.
    private let geometry = EffortSliderGeometry(stopCount: 5, width: 330, inset: 15)

    @Test("end detents sit a knob radius inside the track")
    func endInsets() {
        #expect(geometry.x(of: 0) == 15)
        #expect(geometry.x(of: 4) == 315)
        #expect(geometry.span == 300)
    }

    @Test("detents are evenly spaced across the span")
    func evenSpacing() {
        let positions = (0..<5).map { geometry.x(of: $0) }
        let gaps = zip(positions, positions.dropFirst()).map { $1 - $0 }
        #expect(gaps.allSatisfy { $0 == 75 })
    }

    @Test("a pointer claims the nearest detent, halves rounding up")
    func nearestDetent() {
        #expect(geometry.index(atX: 15) == 0)
        // Just short of the midpoint between stop 0 and stop 1.
        #expect(geometry.index(atX: 51) == 0)
        #expect(geometry.index(atX: 52.5) == 1)
        #expect(geometry.index(atX: 90) == 1)
        #expect(geometry.index(atX: 315) == 4)
    }

    @Test("a drag leaving the track parks on the end detent")
    func clampsOutsideTheTrack() {
        #expect(geometry.index(atX: -400) == 0)
        #expect(geometry.index(atX: 4000) == 4)
        #expect(geometry.progress(atX: -400) == 0)
        #expect(geometry.progress(atX: 4000) == 1)
    }

    @Test("continuous position and detent position agree on the detents")
    func continuousMatchesDiscrete() {
        for index in 0..<5 {
            #expect(geometry.x(atProgress: geometry.progress(of: index)) == geometry.x(of: index))
        }
    }

    @Test("a zero-width track degrades instead of dividing by zero")
    func degenerateTrack() {
        let empty = EffortSliderGeometry(stopCount: 5, width: 0, inset: 15)
        #expect(empty.span == 0)
        #expect(empty.index(atX: 40) == 0)
        #expect(empty.progress(atX: 40) == 0)
    }

    @Test("a single choice has one detent and no range to travel")
    func singleStop() {
        let single = EffortSliderGeometry(stopCount: 1, width: 330, inset: 15)
        #expect(single.index(atX: 300) == 0)
        #expect(single.progress(of: 0) == 0)
        #expect(EffortSliderGeometry.step(from: 0, by: 1, stopCount: 1) == 0)
    }

    @Test("end labels are pulled inside the track instead of hanging off it")
    func labelsStayInside() {
        // An 80pt label centered on either end detent would overhang by 25pt.
        #expect(geometry.labelX(of: 0, labelWidth: 80) == 40)
        #expect(geometry.labelX(of: 4, labelWidth: 80) == 290)
        // Interior labels are narrow enough to stay where their detent is.
        #expect(geometry.labelX(of: 2, labelWidth: 80) == geometry.x(of: 2))
        // A label wider than the track collapses to its center rather than
        // inverting the clamp.
        #expect(geometry.labelX(of: 0, labelWidth: 900) == 165)
    }

    @Test("arrow steps clamp at the ends rather than wrapping around the ramp")
    func stepsClamp() {
        #expect(EffortSliderGeometry.step(from: 2, by: 1, stopCount: 5) == 3)
        #expect(EffortSliderGeometry.step(from: 2, by: -1, stopCount: 5) == 1)
        #expect(EffortSliderGeometry.step(from: 0, by: -1, stopCount: 5) == 0)
        #expect(EffortSliderGeometry.step(from: 4, by: 1, stopCount: 5) == 4)
        #expect(EffortSliderGeometry.step(from: 99, by: 1, stopCount: 5) == 4)
    }

    @Test("mid-ramp steps tick, the ends thud, and staying put is silent")
    func haptics() {
        #expect(EffortSliderGeometry.feedback(from: 1, to: 2, stopCount: 5) == .step)
        #expect(EffortSliderGeometry.feedback(from: 1, to: 0, stopCount: 5) == .boundary)
        #expect(EffortSliderGeometry.feedback(from: 3, to: 4, stopCount: 5) == .boundary)
        #expect(EffortSliderGeometry.feedback(from: 2, to: 2, stopCount: 5) == nil)
    }
}
