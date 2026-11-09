package expo.modules.t3voicetranscription

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31])
class RecordingPcmConverterTest {
  @Test fun preservesAlreadyCompatiblePcmAndResamplesStereoThroughItsTail() {
    for ((rate, channels) in listOf(16000 to 1, 44100 to 2, 48000 to 2)) {
      val frames = rate * 2 + 37
      val input = ByteBuffer.allocateDirect(frames * channels * 2).order(ByteOrder.nativeOrder())
      repeat(frames) { frame ->
        val level = if (frame < rate) 6000 else 18000
        repeat(channels) { input.putShort(level.toShort()) }
      }
      input.flip()
      val original = ByteArray(input.remaining()).also { input.duplicate().get(it) }
      val result = ByteArrayOutputStream()
      RecordingPcmConverter(rate, channels) { buffer ->
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        result.write(bytes)
      }.use { converter ->
        while (input.hasRemaining()) {
          val end = minOf(input.limit(), input.position() + channels * 2 * 317)
          val block = input.slice().order(ByteOrder.nativeOrder())
          block.limit(end - input.position())
          converter.write(block)
          input.position(end)
        }
        converter.finish()
      }
      val bytes = result.toByteArray()
      if (rate == 16000) assertArrayEquals(original, bytes)
      val samples = ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()).asShortBuffer()
      assertTrue(abs(samples.remaining() * rate.toLong() - frames * 16000L) <= rate)
      assertEquals(6000, samples[8000].toInt())
      assertEquals(18000, samples[samples.limit() - 10].toInt())
    }
  }
}
