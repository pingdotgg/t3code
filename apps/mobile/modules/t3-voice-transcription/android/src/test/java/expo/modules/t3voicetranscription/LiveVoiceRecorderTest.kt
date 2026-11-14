package expo.modules.t3voicetranscription

import android.content.Context
import android.media.AudioRecord
import android.os.ParcelFileDescriptor
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.io.File
import java.lang.ref.WeakReference
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31])
class LiveVoiceRecorderTest {
  private class Source(private val failStop: Boolean = false) : PcmCaptureSource {
    override val capacityBytes = 32000
    val chunks = Channel<ByteArray>(Channel.UNLIMITED)
    val reading = Channel<Unit>(Channel.UNLIMITED)
    override fun start() = Unit
    override suspend fun read(buffer: ByteArray, blocking: Boolean): Int {
      reading.send(Unit)
      val chunk = if (blocking) chunks.receive() else chunks.tryReceive().getOrNull() ?: return 0
      chunk.copyInto(buffer)
      return chunk.size
    }
    override fun stop() {
      check(!failStop) { "The microphone could not stop." }
    }
    override fun release() = Unit
  }

  @Test fun preparingAgainReleasesTheUnusedMicrophone() = runTest {
    withAppContext { context, appContext ->
      val recorder = LiveVoiceRecorder(context, appContext, this) {}
      try {
        recorder.prepare()
        val previous = ReflectionHelpers.getField<AudioRecord>(recorder, "audio")
        assertEquals(AudioRecord.STATE_INITIALIZED, previous.state)
        recorder.prepare()
        assertEquals(AudioRecord.STATE_UNINITIALIZED, previous.state)
      } finally {
        recorder.sharedObjectDidRelease()
      }
    }
  }

  @Test fun stoppingBeforeInferencePreservesQueuedAudioAndClosesUnusedPipes() = runTest {
    withAppContext { context, appContext ->
      for (phase in listOf("prepared", "recording", "draining", "prepared-failure")) {
        val started = phase == "recording" || phase == "draining"
        val source = Source(phase == "prepared-failure")
        val pipe = PcmPipe.open()
        val reader = ReflectionHelpers.getField<ParcelFileDescriptor.AutoCloseInputStream>(
          pipe,
          "reader"
        )
        val file = File.createTempFile("recorder-stop-test-", ".pcm")
        val capture = LivePcmCapture(source, file, pipe, testScheduler.timeSource)
        val recorder = LiveVoiceRecorder(context, appContext, this) {}
        ReflectionHelpers.setField(recorder, "capture", capture)
        ReflectionHelpers.setField(recorder, "pipe", pipe)
        try {
          assertTrue(reader.fd.valid())
          if (started) {
            capture.start(this, 300.0) {}
            source.reading.receive()
            source.chunks.send(ByteArray(3200))
            source.reading.receive()
            val stopped = async(start = CoroutineStart.UNDISPATCHED) {
              if (phase == "draining") capture.stop() else recorder.stop()
            }
            source.chunks.send(byteArrayOf(1, 2))
            stopped.await()
            if (phase == "draining") recorder.stop()
            assertFalse(capture.isFinished)
          } else {
            assertEquals(phase == "prepared-failure", runCatching { recorder.stop() }.isFailure)
          }
          assertEquals(started, reader.fd.valid())
        } finally {
          capture.cancel()
          recorder.sharedObjectDidRelease()
          file.delete()
        }
      }
    }
  }

  private suspend fun withAppContext(block: suspend (Context, AppContext) -> Unit) {
    val context = RuntimeEnvironment.getApplication()
    val reactContext = BridgeReactContext(context)
    val appContext = AppContext(
      object : ModulesProvider {
        override fun getModulesMap() = emptyMap<Class<out Module>, String?>()
      },
      expo.modules.core.ModuleRegistry(emptyList(), emptyList()),
      WeakReference(reactContext)
    )
    try {
      block(context, appContext)
    } finally {
      appContext.javaClass.declaredMethods.first {
        it.name.startsWith("onDestroy") && it.parameterCount == 0
      }
        .invoke(appContext)
      reactContext.destroy()
    }
  }
}
