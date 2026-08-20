package expo.modules.t3glbviewer

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal const val GLB_HEADER_SIZE = 12
internal const val MAX_GLB_MB = 100
internal const val MAX_GLB_BYTES = MAX_GLB_MB * 1024L * 1024L
internal const val OVERSIZE_MESSAGE =
  "This GLB is larger than the $MAX_GLB_MB MB mobile preview limit."
internal const val MAX_ANIMATION_PREVIEW_SECONDS = 10f

private const val GLB_MAGIC = 0x46546C67
private const val GLB_VERSION = 2

internal class GlbLoadException(message: String) : Exception(message)

internal data class GlbAnimationFrame(
  val sampleSeconds: Float,
  val completed: Boolean
)

internal fun validateGlbHeader(headerBytes: ByteArray, fileSize: Long) {
  if (headerBytes.size < GLB_HEADER_SIZE) {
    throw GlbLoadException("The file is too small to be a GLB model.")
  }
  val header = ByteBuffer.wrap(headerBytes, 0, GLB_HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN)
  val magic = header.int
  val version = header.int
  val declaredLength = header.int.toLong() and 0xffffffffL
  if (magic != GLB_MAGIC || version != GLB_VERSION || declaredLength != fileSize) {
    throw GlbLoadException("The file is not a valid GLB 2.0 model.")
  }
}

/** Samples a bounded first pass, then jumps to and holds the model's actual final pose. */
internal fun glbAnimationFrame(durationSeconds: Float, elapsedSeconds: Float): GlbAnimationFrame =
  when {
    !durationSeconds.isFinite() || durationSeconds <= 0f ->
      GlbAnimationFrame(sampleSeconds = 0f, completed = true)
    !elapsedSeconds.isFinite() ||
      elapsedSeconds >= durationSeconds.coerceAtMost(MAX_ANIMATION_PREVIEW_SECONDS) ->
      GlbAnimationFrame(sampleSeconds = durationSeconds, completed = true)
    else -> GlbAnimationFrame(sampleSeconds = elapsedSeconds.coerceAtLeast(0f), completed = false)
  }

internal fun shouldContinueGlbFrames(
  settleFrames: Int,
  loadEventPending: Boolean,
  hasPlayingAnimation: Boolean
): Boolean = settleFrames > 0 || loadEventPending || hasPlayingAnimation
