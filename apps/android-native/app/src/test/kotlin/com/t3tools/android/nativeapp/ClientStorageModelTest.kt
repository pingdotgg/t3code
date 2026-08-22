package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Test

class ClientStorageModelTest {
  @Test
  fun formats_storage_sizes_for_settings() {
    assertEquals("900 B", formatStorageBytes(900))
    assertEquals("2 KB", formatStorageBytes(2_048))
    assertEquals("1.5 MB", formatStorageBytes(1_572_864))
  }
}
