package expo.modules.t3voicetranscription

import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.google.mlkit.genai.common.audio.AudioSource
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import java.util.concurrent.atomic.AtomicBoolean

internal class PcmPipe private constructor(
  val source: AudioSource,
  private val writer: ParcelFileDescriptor,
  verificationReader: ParcelFileDescriptor
) : PcmOutput {
  private val closed = AtomicBoolean()
  private val reader = ParcelFileDescriptor.AutoCloseInputStream(verificationReader)
  override suspend fun write(buffer: ByteArray, count: Int) {
    try {
      withTimeout(5000) {
        var offset = 0
        while (offset < count) {
          currentCoroutineContext().ensureActive()
          try {
            val written = Os.write(writer.fileDescriptor, buffer, offset, count - offset)
            requireCompleteAudio(written > 0) { "On-device speech stopped reading the recording." }
            offset += written
          } catch (e: ErrnoException) {
            if (e.errno != OsConstants.EAGAIN) {
              throw VoiceTranscriptionException(
                "incomplete-audio",
                "On-device speech stopped reading the complete recording. No transcript was added. Retry dictation.",
                e
              )
            }
            delay(10)
          }
        }
      }
    } catch (e: TimeoutCancellationException) {
      throw VoiceTranscriptionException(
        "incomplete-audio",
        "On-device speech could not read the complete recording. No transcript was added. Retry dictation.",
        e
      )
    }
  }
  override fun finish() = writer.close()
  override fun verifyConsumed() {
    requireCompleteAudio(reader.available() == 0) {
      "Speech recognition ended with unread recorded audio. No transcript was added. Retry dictation."
    }
  }
  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    try {
      writer.close()
    } finally {
      try {
        reader.close()
      } finally {
        source.close()
      }
    }
  }
  companion object {
    fun open(): PcmPipe {
      val ends = ParcelFileDescriptor.createPipe()
      var sdkReader: ParcelFileDescriptor? = null
      var retained = false
      try {
        Os.fcntlInt(ends[1].fileDescriptor, OsConstants.F_SETFL, OsConstants.O_NONBLOCK)
        // The SDK closes its descriptor; verification must retain a separate read end.
        sdkReader = ends[0].dup()
        val pipe = PcmPipe(
          AudioSource.fromPfd(sdkReader, AudioSource.Mode.STREAMING),
          ends[1],
          ends[0]
        )
        retained = true
        return pipe
      } finally {
        if (!retained) closeFailedPipe(sdkReader, ends)
      }
    }
    private fun closeFailedPipe(
      sdkReader: ParcelFileDescriptor?,
      ends: Array<ParcelFileDescriptor>
    ) {
      try {
        sdkReader?.close()
      } finally {
        try {
          ends[0].close()
        } finally {
          ends[1].close()
        }
      }
    }
  }
}
