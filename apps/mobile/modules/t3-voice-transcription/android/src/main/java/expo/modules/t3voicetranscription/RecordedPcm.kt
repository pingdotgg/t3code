package expo.modules.t3voicetranscription

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.Closeable
import java.io.File
import java.io.OutputStream
import java.nio.ByteOrder
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

internal suspend fun <T> withRecordedPcm(
  context: Context,
  uri: String,
  transcribe: suspend (File) -> T
): T {
  val pcm = File.createTempFile("dictation-", ".pcm", context.cacheDir)
  try {
    try {
      withTimeout(30000) { decodeRecording(context, Uri.parse(uri), pcm) }
    } catch (_: TimeoutCancellationException) {
      throw VoiceTranscriptionException(
        "incomplete-audio",
        "Audio decoding did not finish the recording. Retry dictation."
      )
    }
    requireCompleteAudio(pcm.length() > 0 && pcm.length() % 2 == 0L) {
      "The recording did not contain complete audio samples."
    }
    return transcribe(pcm)
  } finally {
    pcm.delete()
  }
}

private suspend fun decodeRecording(context: Context, uri: Uri, output: File) {
  val extractor = MediaExtractor()
  Closeable { extractor.release() }.use {
    extractor.setDataSource(context, uri, null)
    val track = (0 until extractor.trackCount).firstOrNull {
      extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
    } ?: throw VoiceTranscriptionException("incomplete-audio", "The recording has no audio track.")
    extractor.selectTrack(track)
    decodeTrack(extractor, extractor.getTrackFormat(track), output)
  }
}

private suspend fun decodeTrack(extractor: MediaExtractor, format: MediaFormat, output: File) {
  format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
  val decoder = MediaCodec.createDecoderByType(
    requireNotNull(format.getString(MediaFormat.KEY_MIME))
  )
  Closeable { decoder.release() }.use {
    decoder.configure(format, null, null, 0)
    decoder.start()
    Closeable { decoder.stop() }.use {
      output.outputStream().buffered().use { stream -> decodeBuffers(decoder, extractor, stream) }
    }
  }
}

private suspend fun decodeBuffers(
  decoder: MediaCodec,
  extractor: MediaExtractor,
  stream: OutputStream
) {
  var converter: RecordingPcmConverter? = null
  var decodedFormat: Triple<Int, Int, Int>? = null
  try {
    var inputEnded = false
    var outputEnded = false
    val info = MediaCodec.BufferInfo()
    while (!outputEnded) {
      currentCoroutineContext().ensureActive()
      if (!inputEnded) inputEnded = queueDecoderInput(decoder, extractor)
      val index = decoder.dequeueOutputBuffer(info, 10000)
      when {
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          val next = pcmFormat(decoder.outputFormat, decodedFormat)
          decodedFormat = next
          converter = converter ?: createConverter(next, stream)
        }
        index >= 0 -> {
          consumeDecodedBuffer(decoder, index, info, requireNotNull(converter))
          outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
        }
      }
    }
    requireCompleteAudio(inputEnded) {
      "Audio decoding ended before reading the complete recording."
    }
    converter?.finish()
  } finally {
    converter?.close()
  }
}

private fun pcmFormat(
  format: MediaFormat,
  previous: Triple<Int, Int, Int>?
): Triple<Int, Int, Int> {
  val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
    format.getInteger(MediaFormat.KEY_PCM_ENCODING)
  } else {
    AudioFormat.ENCODING_PCM_16BIT
  }
  requireCompleteAudio(encoding == AudioFormat.ENCODING_PCM_16BIT) {
    "The decoder did not provide 16-bit audio."
  }
  val next = Triple(
    format.getInteger(MediaFormat.KEY_SAMPLE_RATE),
    format.getInteger(MediaFormat.KEY_CHANNEL_COUNT),
    encoding
  )
  requireCompleteAudio(previous == null || previous == next) {
    "The recording changed audio format while decoding."
  }
  return next
}

private fun createConverter(
  format: Triple<Int, Int, Int>,
  stream: OutputStream
): RecordingPcmConverter {
  val bytes = ByteArray(8192)
  return RecordingPcmConverter(format.first, format.second) { buffer ->
    while (buffer.hasRemaining()) {
      val count = minOf(buffer.remaining(), bytes.size)
      buffer.get(bytes, 0, count)
      stream.write(bytes, 0, count)
    }
  }
}

private fun queueDecoderInput(decoder: MediaCodec, extractor: MediaExtractor): Boolean {
  val index = decoder.dequeueInputBuffer(10000)
  if (index < 0) return false
  val buffer = requireNotNull(decoder.getInputBuffer(index))
  val count = extractor.readSampleData(buffer, 0)
  return if (count < 0) {
    decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
    true
  } else {
    decoder.queueInputBuffer(index, 0, count, extractor.sampleTime, 0)
    extractor.advance()
    false
  }
}

private fun consumeDecodedBuffer(
  decoder: MediaCodec,
  index: Int,
  info: MediaCodec.BufferInfo,
  converter: RecordingPcmConverter
) {
  try {
    if (info.size <= 0 || info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) return
    val buffer = requireNotNull(decoder.getOutputBuffer(index))
    buffer.position(info.offset)
    buffer.limit(info.offset + info.size)
    buffer.order(ByteOrder.nativeOrder())
    converter.write(buffer)
  } finally {
    decoder.releaseOutputBuffer(index, false)
  }
}
