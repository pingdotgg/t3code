package expo.modules.t3voicetranscription

import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PcmReplayTest {
  private class Output : PcmOutput {
    val bytes = ByteArrayOutputStream()
    val ended = CompletableDeferred<Unit>()
    var unread = false
    var closed = false

    override suspend fun write(buffer: ByteArray, count: Int) {
      bytes.write(buffer, 0, count)
    }
    override fun finish() {
      ended.complete(Unit)
    }
    override fun verifyConsumed() {
      requireCompleteAudio(!unread) { "Unread audio." }
    }
    override fun close() {
      closed = true
    }
  }

  @Test fun replaysTheEntireLongFileIncludingTheLastShortBuffer() = runTest {
    val pcm = ByteArray(1994140) { (it % 251).toByte() }
    val file = File.createTempFile("dictation-replay-", ".pcm").apply { writeBytes(pcm) }
    try {
      Output().use { output ->
        val responses = pacedRecordedResponses(file, output) {
          flow {
            output.ended.await()
            emit(SpeechRecognizerResponse.FinalTextResponse("Opening. ", emptyList()))
            emit(SpeechRecognizerResponse.FinalTextResponse("Repeat. Repeat. 中間。", emptyList()))
            emit(SpeechRecognizerResponse.PartialTextResponse(" A longer unfinished ending"))
            emit(SpeechRecognizerResponse.PartialTextResponse(" End."))
            emit(SpeechRecognizerResponse.CompletedResponse)
          }
        }
        assertEquals("Opening. Repeat. Repeat. 中間。 End.", collectGoogleVoiceTranscript(responses))
        assertArrayEquals(pcm, output.bytes.toByteArray())
        assertEquals(62317L, currentTime)
      }
    } finally {
      file.delete()
    }
  }

  @Test fun refusesSuccessfulSdkCompletionBeforeAllAudioIsConsumed() = runTest {
    val file = File.createTempFile("dictation-replay-", ".pcm").apply {
      writeBytes(ByteArray(6400))
    }
    try {
      for (early in listOf(true, false)) {
        Output().use { output ->
          output.unread = !early
          val result = runCatching {
            collectGoogleVoiceTranscript(
              pacedRecordedResponses(file, output) {
                flow {
                  if (!early) output.ended.await()
                  emit(
                    SpeechRecognizerResponse.FinalTextResponse(
                      "Plausible but incomplete.",
                      emptyList()
                    )
                  )
                  emit(SpeechRecognizerResponse.CompletedResponse)
                }
              }
            )
          }
          assertEquals(
            "incomplete-audio",
            (result.exceptionOrNull() as VoiceTranscriptionException).code
          )
          assertTrue(output.ended.isCompleted)
        }
      }
    } finally {
      file.delete()
    }
  }

  @Test fun cancellationSettlesTheSenderBeforeReleasingItsOutput() = runTest {
    val file = File.createTempFile("dictation-replay-", ".pcm").apply {
      writeBytes(ByteArray(6400))
    }
    val entered = CompletableDeferred<Unit>()
    val output = Output()
    try {
      val job = launch {
        output.use {
          collectGoogleVoiceTranscript(
            pacedRecordedResponses(file, it) {
              flow {
                entered.complete(Unit)
                CompletableDeferred<Unit>().await()
              }
            }
          )
        }
      }
      entered.await()
      job.cancelAndJoin()
      assertTrue(output.ended.isCompleted)
      assertTrue(output.closed)
    } finally {
      file.delete()
    }
  }
}
