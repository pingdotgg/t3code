import Testing

@testable import SidecarKit

@Suite("Restart backoff schedule")
struct BackoffScheduleTests {
    // Mirrors DesktopBackendManager.ts's calculateRestartDelay:
    // Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY)
    // with INITIAL_RESTART_DELAY = 500ms and MAX_RESTART_DELAY = 10s.
    @Test(
        "doubles from 500ms, capping at 10s",
        arguments: [
            (0, 0.5),
            (1, 1.0),
            (2, 2.0),
            (3, 4.0),
            (4, 8.0),
            (5, 10.0),
            (6, 10.0),
            (20, 10.0),
        ]
    )
    func schedule(attempt: Int, expectedSeconds: Double) {
        let delay = ServerProcess.backoffDelay(forAttempt: attempt)
        #expect(abs(delay - expectedSeconds) < 0.0001)
    }

    @Test("never returns a negative delay for a negative attempt")
    func clampsNegativeAttempt() {
        let delay = ServerProcess.backoffDelay(forAttempt: -1)
        #expect(delay == 0.5)
    }
}
