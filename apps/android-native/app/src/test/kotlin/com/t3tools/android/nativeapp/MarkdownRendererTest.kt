package com.t3tools.android.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MarkdownRendererTest {
  @Test
  fun appending_output_returns_only_the_new_chunk() {
    assertEquals(" world", markdownAppendChunk("Hello", "Hello world"))
    assertEquals("", markdownAppendChunk("Hello", "Hello"))
  }

  @Test
  fun rewritten_output_requires_a_fresh_parse() {
    assertNull(markdownAppendChunk("Hello world", "Hello there"))
  }
}
