package expo.modules.t3voicetranscription

import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LivePcmCaptureTest {
  private class Source : PcmCaptureSource {
    override val capacityBytes = 32000
    val chunks = Channel<ByteArray>(Channel.UNLIMITED)
    val reading = Channel<Unit>(Channel.UNLIMITED)
    var released = false
    override fun start() = Unit
    override suspend fun read(buffer: ByteArray, blocking: Boolean): Int {
      reading.send(Unit)
      val chunk = if (blocking) chunks.receive() else chunks.tryReceive().getOrNull() ?: return 0
      chunk.copyInto(buffer)
      return chunk.size
    }
    override fun stop() = Unit
    override fun release() {
      released = true
    }
  }

  private class Output(private val gate: CompletableDeferred<Unit>? = null) : PcmOutput {
    val bytes = ByteArrayOutputStream()
    val first = CompletableDeferred<Unit>()
    val writing = CompletableDeferred<Unit>()
    val ended = CompletableDeferred<Unit>()
    var unread = false
    override suspend fun write(buffer: ByteArray, count: Int) {
      writing.complete(Unit)
      gate?.await()
      bytes.write(buffer, 0, count)
      first.complete(Unit)
    }
    override fun finish() {
      ended.complete(Unit)
    }
    override fun verifyConsumed() = requireCompleteAudio(!unread) { "Unread captured audio." }
    override fun close() = Unit
  }

  @Test fun transcribesDuringCaptureAndDrainsTheShortTailAfterStop() = runTest {
    val source = Source()
    val output = Output()
    val file = File.createTempFile("live-capture-test-", ".pcm")
    val first = ByteArray(3200) { (it % 251).toByte() }
    val tail = byteArrayOf(1, 2, 3, 4, 5, 6)
    val capture = LivePcmCapture(source, file, output, testScheduler.timeSource)
    try {
      capture.start(this, 300.0) {}
      source.chunks.send(first)
      output.first.await()
      assertTrue(capture.isRecording)
      assertFalse(output.ended.isCompleted)
      assertArrayEquals(first, output.bytes.toByteArray())
      source.reading.receive()
      source.reading.receive()

      val stopped = async(start = CoroutineStart.UNDISPATCHED) { capture.stop() }
      source.chunks.send(tail)
      stopped.await()
      assertTrue(source.released)
      assertFalse(capture.isRecording)
      val text = collectGoogleVoiceTranscript(
        livePcmResponses(capture, output) {
          flow {
            output.ended.await()
            emit(
              SpeechRecognizerResponse.FinalTextResponse("Opening. Repeat. Repeat.", emptyList())
            )
            emit(SpeechRecognizerResponse.FinalTextResponse(" 中間。", emptyList()))
            emit(SpeechRecognizerResponse.PartialTextResponse(" An unfinished ending"))
            emit(SpeechRecognizerResponse.PartialTextResponse(" End."))
            emit(SpeechRecognizerResponse.CompletedResponse)
          }
        }
      )
      assertEquals("Opening. Repeat. Repeat. 中間。 End.", text)
      assertArrayEquals(first + tail, output.bytes.toByteArray())
      assertArrayEquals(first + tail, file.readBytes())
    } finally {
      capture.cancel()
      file.delete()
    }
  }

  @Test fun rejectsPrematureRecognitionAndUnreadCapturedAudio() = runTest {
    for (early in listOf(true, false)) {
      val source = Source()
      val output = Output().apply { unread = !early }
      val file = File.createTempFile("live-capture-test-", ".pcm")
      val capture = LivePcmCapture(source, file, output, testScheduler.timeSource)
      try {
        capture.start(this, if (early) 300.0 else 0.1) {}
        source.chunks.send(ByteArray(3200))
        val result = runCatching {
          collectGoogleVoiceTranscript(
            livePcmResponses(capture, output) {
              flow {
                if (!early) output.ended.await()
                emit(SpeechRecognizerResponse.FinalTextResponse("Incomplete.", emptyList()))
                emit(SpeechRecognizerResponse.CompletedResponse)
              }
            }
          )
        }
        assertEquals(
          "incomplete-audio",
          (result.exceptionOrNull() as VoiceTranscriptionException).code
        )
        assertTrue(source.released)
      } finally {
        capture.cancel()
        file.delete()
      }
    }
  }

  @Test fun durationLimitDrainsQueuedPcmBeforeReleasingTheMicrophone() = runTest {
    val source = Source()
    val output = Output()
    val file = File.createTempFile("live-capture-test-", ".pcm")
    val expected = ByteArray(6400) { (it % 251).toByte() } + byteArrayOf(42, 0)
    val capture = LivePcmCapture(source, file, output, testScheduler.timeSource)
    val stopped = CompletableDeferred<Unit>()
    try {
      source.chunks.send(expected.copyOfRange(0, 3200))
      source.chunks.send(expected.copyOfRange(3200, 6400))
      source.chunks.send(expected.copyOfRange(6400, expected.size))
      capture.start(this, 0.1) { stopped.complete(Unit) }
      stopped.await()
      assertTrue(source.released)
      assertEquals(expected.size.toLong(), file.length())
      capture.awaitFinished()
      assertArrayEquals(expected, output.bytes.toByteArray())
    } finally {
      capture.cancel()
      file.delete()
    }
  }

  @Test fun cancellationWaitsForCaptureAndFeederCleanup() = runTest {
    for (phase in listOf("prepared", "reading", "writing")) {
      val source = Source()
      val output = Output(if (phase == "writing") CompletableDeferred() else null)
      val file = File.createTempFile("live-capture-test-", ".pcm")
      val capture = LivePcmCapture(source, file, output, testScheduler.timeSource)
      try {
        if (phase != "prepared") {
          capture.start(this, 300.0) {}
          source.reading.receive()
          if (phase == "writing") {
            source.chunks.send(ByteArray(3200))
            output.writing.await()
          }
        }
        capture.cancel()
        assertTrue(source.released)
        assertTrue(output.ended.isCompleted)
        assertTrue(capture.isFinished)
        assertTrue(runCatching { capture.awaitFinished() }.isFailure)
      } finally {
        file.delete()
      }
    }
  }
}
