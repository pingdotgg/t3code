package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class ThreadStreamPolicyTest {
  @Test
  fun publishes_snapshot_then_batches_replay_until_synchronized() {
    assertEquals(
      ThreadStreamPolicy(publish = true, persist = false),
      threadStreamPolicy("snapshot", wasSynchronized = false, isSynchronized = false, isActive = false),
    )
    assertEquals(
      ThreadStreamPolicy(publish = false, persist = false),
      threadStreamPolicy("event", wasSynchronized = false, isSynchronized = false, isActive = false),
    )
    assertEquals(
      ThreadStreamPolicy(publish = true, persist = true),
      threadStreamPolicy("synchronized", wasSynchronized = false, isSynchronized = true, isActive = false),
    )
  }

  @Test
  fun publishes_live_events_but_only_persists_settled_state() {
    assertEquals(
      ThreadStreamPolicy(publish = true, persist = false),
      threadStreamPolicy("event", wasSynchronized = true, isSynchronized = true, isActive = true),
    )
    assertEquals(
      ThreadStreamPolicy(publish = true, persist = true),
      threadStreamPolicy("event", wasSynchronized = true, isSynchronized = true, isActive = false),
    )
  }
}
