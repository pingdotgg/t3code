package expo.modules.t3voicetranscription

import java.io.File
import kotlin.math.abs
import kotlin.math.log10
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

internal interface PcmCaptureSource {
  val capacityBytes: Int
  fun start()
  suspend fun read(buffer: ByteArray, blocking: Boolean): Int
  fun stop()
  fun release()
}

internal class LivePcmCapture(
  private val source: PcmCaptureSource,
  val file: File,
  private val output: PcmOutput,
  private val clock: TimeSource = TimeSource.Monotonic
) {
  private var worker: Job? = null
  private val completion = CompletableDeferred<Result<Unit>>()
  private val microphoneStopped = CompletableDeferred<Result<Unit>>()

  @Volatile private var stopping = false
  private var sourceStopped = false
  private var sourceReleased = false

  @Volatile var bytes = 0L
    private set

  @Volatile var metering = -160.0
    private set
  val isFinished get() = completion.isCompleted

  @Volatile var inputExhausted = false
    private set
  val isRecording get() = worker != null && !microphoneStopped.isCompleted

  fun start(scope: CoroutineScope, seconds: Double, onFinished: (Throwable?) -> Unit) {
    check(worker == null && !sourceReleased) { "The microphone is not prepared." }
    worker = scope.launch {
      var result = runCatching {
        source.start()
        writeCapture(seconds, onFinished)
        requireCompleteAudio(bytes > 0 && file.length() == bytes) {
          "The microphone did not finish its captured audio."
        }
      }
      result = finishSource(result)
      inputExhausted = result.isSuccess
      result = runCatching { output.finish() }.fold(
        onSuccess = { result },
        onFailure = { failure -> mergeFailure(result, failure) }
      )
      if (microphoneStopped.complete(result)) onFinished(result.exceptionOrNull())
      completion.complete(result)
    }.also { job ->
      job.invokeOnCompletion { error ->
        if (!completion.isCompleted) {
          val result =
            finishSource(Result.failure(error ?: CancellationException("Capture stopped.")))
          completion.complete(result)
          microphoneStopped.complete(result)
          runCatching { output.finish() }
        }
      }
    }
  }

  private suspend fun writeCapture(
    seconds: Double,
    onFinished: (Throwable?) -> Unit
  ) = coroutineScope {
    val started = clock.markNow()
    val chunks = Channel<ByteArray>(100)
    var sent = 0L
    val sender = launch {
      var deadline = 0L
      for (chunk in chunks) {
        deadline = maxOf(
          deadline + (chunk.size * 1000L + 31999) / 32000,
          started.elapsedNow().inWholeMilliseconds
        )
        delay((deadline - started.elapsedNow().inWholeMilliseconds).coerceAtLeast(0))
        output.write(chunk, chunk.size)
        deadline = started.elapsedNow().inWholeMilliseconds
        sent += chunk.size
      }
    }
    val result = finishSource(runCatching { captureChunks(seconds, chunks) })
    microphoneStopped.complete(result)
    if (result.exceptionOrNull() !is CancellationException) onFinished(result.exceptionOrNull())
    chunks.close()
    result.getOrThrow()
    sender.join()
    requireCompleteAudio(sent == bytes) { "Speech recognition did not receive all captured audio." }
  }

  private suspend fun captureChunks(seconds: Double, chunks: Channel<ByteArray>) {
    val buffer = ByteArray(3200)
    var drained = 0
    file.outputStream().use { stream ->
      while (true) {
        currentCoroutineContext().ensureActive()
        val draining = stopping || bytes >= seconds * 32000
        val count = source.read(buffer, !draining)
        requireCompleteAudio(count in 0..buffer.size && count % 2 == 0) {
          "The microphone returned incomplete audio."
        }
        if (count == 0) {
          requireCompleteAudio(draining) { "The microphone stopped supplying audio." }
          break
        }
        if (draining) {
          drained += count
          requireCompleteAudio(drained <= source.capacityBytes + buffer.size) {
            "The microphone audio queue did not drain."
          }
        }
        stream.write(buffer, 0, count)
        // Keep draining the microphone while inference starts or applies backpressure.
        if (!chunks.trySend(buffer.copyOf(count)).isSuccess) {
          throw VoiceTranscriptionException(
            "audio-overflow",
            "Speech recognition fell behind capture."
          )
        }
        bytes += count
        var peak = 0
        for (i in 0 until count step 2) {
          val sample = ((buffer[i].toInt() and 255) or (buffer[i + 1].toInt() shl 8)).toShort()
          peak = maxOf(peak, abs(sample.toInt()))
        }
        metering = if (peak == 0) -160.0 else 20 * log10(peak / 32768.0)
      }
    }
  }

  suspend fun stop() {
    stopping = true
    if (worker == null) {
      finishSource(Result.success(Unit)).getOrThrow()
      output.finish()
      return
    }
    try {
      withTimeout(2000) { microphoneStopped.await().getOrThrow() }
    } catch (error: TimeoutCancellationException) {
      cancel()
      throw VoiceTranscriptionException("incomplete-audio", "The microphone did not stop.", error)
    }
  }

  suspend fun awaitFinished() = completion.await().getOrThrow()

  fun abort() {
    stopping = true
    worker?.cancel()
    runCatching { stopSource() }
    runCatching { output.finish() }
    if (worker == null) {
      val result = finishSource(Result.failure(CancellationException("Capture was cancelled.")))
      completion.complete(result)
      microphoneStopped.complete(result)
    }
  }

  suspend fun cancel() = withContext(NonCancellable) {
    abort()
    worker?.join()
    finishSource(Result.success(Unit))
  }

  @Synchronized private fun stopSource() {
    if (sourceStopped) return
    sourceStopped = true
    source.stop()
  }

  @Synchronized private fun finishSource(result: Result<Unit>): Result<Unit> {
    if (sourceReleased) return result
    sourceReleased = true
    var outcome = runCatching { stopSource() }.fold(
      onSuccess = { result },
      onFailure = { mergeFailure(result, it) }
    )
    outcome = runCatching { source.release() }.fold(
      onSuccess = { outcome },
      onFailure = { mergeFailure(outcome, it) }
    )
    return outcome
  }
}

private fun mergeFailure(result: Result<Unit>, failure: Throwable): Result<Unit> {
  val original = result.exceptionOrNull() ?: return Result.failure(failure)
  if (original !== failure) original.addSuppressed(failure)
  return result
}
