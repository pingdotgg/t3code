package expo.modules.t3voicetranscription

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessingPipeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import com.google.common.collect.ImmutableList
import java.nio.ByteBuffer

@OptIn(UnstableApi::class)
internal class RecordingPcmConverter(
  sampleRate: Int,
  channels: Int,
  private val consume: (ByteBuffer) -> Unit
) : AutoCloseable {
  private val frameSize = channels * 2
  private val pipeline = AudioProcessingPipeline(
    ImmutableList.of(
      ChannelMixingAudioProcessor().apply {
        putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(channels, 1))
      },
      SonicAudioProcessor().apply { setOutputSampleRateHz(16000) }
    )
  )

  init {
    pipeline.configure(AudioProcessor.AudioFormat(sampleRate, channels, C.ENCODING_PCM_16BIT))
    pipeline.flush()
  }

  fun write(input: ByteBuffer) {
    requireCompleteAudio(input.remaining() % frameSize == 0) {
      "Decoded audio contains an incomplete sample."
    }
    if (!pipeline.isOperational) {
      consume(input)
      return
    }
    while (input.hasRemaining()) {
      val before = input.remaining()
      pipeline.queueInput(input)
      val output = pipeline.output
      val produced = output.remaining()
      consume(output)
      requireCompleteAudio(input.remaining() < before || produced > 0) {
        "Audio conversion stopped before the recording ended."
      }
    }
  }

  fun finish() {
    if (!pipeline.isOperational) return
    pipeline.queueEndOfStream()
    while (!pipeline.isEnded) {
      val output = pipeline.output
      requireCompleteAudio(output.hasRemaining() || pipeline.isEnded) {
        "Audio conversion did not finish the recording."
      }
      consume(output)
    }
  }

  override fun close() = pipeline.reset()
}
