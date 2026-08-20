package expo.modules.t3glbviewer

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class GlbPreviewPolicyTest {
  @Test
  fun `validates a matching GLB 2 header`() {
    validateGlbHeader(glbHeader(fileSize = 24), fileSize = 24)
  }

  @Test
  fun `rejects truncated and mismatched headers`() {
    assertThrows(GlbLoadException::class.java) {
      validateGlbHeader(ByteArray(GLB_HEADER_SIZE - 1), fileSize = GLB_HEADER_SIZE - 1L)
    }
    assertThrows(GlbLoadException::class.java) {
      validateGlbHeader(glbHeader(fileSize = 24), fileSize = 25)
    }
  }

  @Test
  fun `plays a normal animation once and holds its final pose`() {
    assertEquals(GlbAnimationFrame(1.5f, completed = false), glbAnimationFrame(3f, 1.5f))
    assertEquals(GlbAnimationFrame(3f, completed = true), glbAnimationFrame(3f, 3f))
  }

  @Test
  fun `bounds long and invalid animation durations`() {
    assertEquals(
      GlbAnimationFrame(MAX_ANIMATION_PREVIEW_SECONDS - 1f, completed = false),
      glbAnimationFrame(60f, MAX_ANIMATION_PREVIEW_SECONDS - 1f),
    )
    assertEquals(
      GlbAnimationFrame(60f, completed = true),
      glbAnimationFrame(60f, MAX_ANIMATION_PREVIEW_SECONDS),
    )
    assertEquals(GlbAnimationFrame(0f, completed = true), glbAnimationFrame(Float.NaN, 1f))
    assertEquals(
      GlbAnimationFrame(0f, completed = true),
      glbAnimationFrame(Float.POSITIVE_INFINITY, 1f),
    )
  }

  @Test
  fun `parks unless work remains`() {
    assertFalse(shouldContinueGlbFrames(0, loadEventPending = false, hasPlayingAnimation = false))
    assertTrue(shouldContinueGlbFrames(1, loadEventPending = false, hasPlayingAnimation = false))
    assertTrue(shouldContinueGlbFrames(0, loadEventPending = true, hasPlayingAnimation = false))
    assertTrue(shouldContinueGlbFrames(0, loadEventPending = false, hasPlayingAnimation = true))
  }

  private fun glbHeader(fileSize: Int): ByteArray =
    ByteBuffer.allocate(GLB_HEADER_SIZE)
      .order(ByteOrder.LITTLE_ENDIAN)
      .putInt(0x46546C67)
      .putInt(2)
      .putInt(fileSize)
      .array()
}
