package com.t3tools.android.nativeapp

import com.t3tools.android.protocol.RpcTransportException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxPolicyTest {
  @Test
  fun schedules_retry_with_connection_policy_delays() {
    assertEquals(3_000L, OutboxPolicy.nextAttemptAt(0, 0))
    assertEquals(4_000L, OutboxPolicy.nextAttemptAt(0, 1))
    assertEquals(16_000L, OutboxPolicy.nextAttemptAt(0, 99))
  }

  @Test
  fun treats_transport_and_io_as_transient() {
    assertTrue(OutboxPolicy.isTransient(RpcTransportException("socket closed")))
    assertTrue(OutboxPolicy.isTransient(IOException("reset")))
    assertTrue(OutboxPolicy.isTransient(RuntimeException(IOException("wrapped"))))
    assertFalse(OutboxPolicy.isTransient(IllegalStateException("bad command")))
  }

  @Test
  fun blocks_auth_and_credential_failures() {
    assertTrue(OutboxPolicy.isBlockedConnection(IllegalStateException("No saved credential.")))
    assertTrue(OutboxPolicy.isBlockedConnection(IllegalStateException("HTTP 401 Unauthorized")))
    assertFalse(OutboxPolicy.isBlockedConnection(IllegalStateException("timeout")))
  }

  @Test
  fun requeues_in_flight_work_after_process_death() {
    assertEquals(PendingTaskStatus.Queued, OutboxPolicy.normalizeRestoredStatus(PendingTaskStatus.Sending))
    assertEquals(PendingTaskStatus.Failed, OutboxPolicy.normalizeRestoredStatus(PendingTaskStatus.Failed))
  }

  @Test
  fun drains_only_when_connected_and_shell_is_live_and_due() {
    assertTrue(
      OutboxPolicy.canDrain(
        ConnectionPhase.Connected,
        SyncPhase.Synchronized,
        nowMs = 100,
        nextAttemptAt = 100,
      ),
    )
    assertFalse(
      OutboxPolicy.canDrain(
        ConnectionPhase.Connected,
        SyncPhase.Synchronized,
        nowMs = 100,
        nextAttemptAt = 101,
      ),
    )
    assertFalse(
      OutboxPolicy.canDrain(
        ConnectionPhase.Offline,
        SyncPhase.Synchronized,
        nowMs = 100,
        nextAttemptAt = 0,
      ),
    )
    assertFalse(
      OutboxPolicy.canDrain(
        ConnectionPhase.Connected,
        SyncPhase.Cached,
        nowMs = 100,
        nextAttemptAt = 0,
      ),
    )
  }
}
