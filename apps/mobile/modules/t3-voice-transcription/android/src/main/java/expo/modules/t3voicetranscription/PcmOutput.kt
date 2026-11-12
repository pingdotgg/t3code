package expo.modules.t3voicetranscription

import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

internal interface PcmOutput : AutoCloseable {
  suspend fun write(buffer: ByteArray, count: Int)
  fun finish()
  fun verifyConsumed()
}

private suspend fun replayPcm(file: File, output: PcmOutput) {
  val expected = file.length()
  var sent = 0L
  file.inputStream().use { input ->
    val buffer = ByteArray(3200)
    while (true) {
      val count = input.read(buffer)
      if (count == -1) break
      requireCompleteAudio(count > 0 && count % 2 == 0) {
        "Recorded PCM contains an incomplete audio frame."
      }
      // STREAMING requires real-time delivery, including the final short buffer.
      delay((count * 1000L + 31999) / 32000)
      output.write(buffer, count)
      sent += count
    }
  }
  requireCompleteAudio(sent == expected && file.length() == expected) {
    "The recording changed while speech recognition was reading it. No transcript was added."
  }
}

internal fun pacedRecordedResponses(
  file: File,
  output: PcmOutput,
  responses: () -> Flow<SpeechRecognizerResponse>
): Flow<SpeechRecognizerResponse> = flow {
  coroutineScope {
    val exhausted = AtomicBoolean()
    val sender = async {
      replayPcm(file, output)
      exhausted.set(true)
      output.finish()
    }
    try {
      withTimeout(file.length() / 32 + 30000) {
        responses().collect { emit(it) }
        requireCompleteAudio(exhausted.get()) {
          "Speech recognition ended before receiving the complete recording. " +
            "No transcript was added. Retry dictation."
        }
        sender.await()
        output.verifyConsumed()
      }
    } catch (e: TimeoutCancellationException) {
      throw VoiceTranscriptionException(
        "incomplete-audio",
        "Speech recognition did not finish the complete recording. No transcript was added. Retry dictation.",
        e
      )
    } finally {
      sender.cancel()
      try {
        output.finish()
      } finally {
        withContext(NonCancellable) { sender.join() }
      }
    }
  }
}

internal fun livePcmResponses(
  capture: LivePcmCapture,
  output: PcmOutput,
  responses: () -> Flow<SpeechRecognizerResponse>
): Flow<SpeechRecognizerResponse> = flow {
  try {
    withTimeout(330000) {
      responses().collect { emit(it) }
      requireCompleteAudio(capture.inputExhausted) {
        "Speech recognition ended before receiving the complete recording."
      }
      capture.awaitFinished()
      output.verifyConsumed()
    }
  } catch (e: TimeoutCancellationException) {
    throw VoiceTranscriptionException(
      "incomplete-audio",
      "Speech recognition did not finish the complete recording. No transcript was added. Retry dictation.",
      e
    )
  } finally {
    capture.cancel()
  }
}

internal inline fun requireCompleteAudio(condition: Boolean, message: () -> String) {
  if (!condition) throw VoiceTranscriptionException("incomplete-audio", message())
}
