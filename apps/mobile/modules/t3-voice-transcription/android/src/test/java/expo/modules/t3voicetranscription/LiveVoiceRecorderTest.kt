package expo.modules.t3voicetranscription

import android.media.AudioRecord
import com.facebook.react.bridge.BridgeReactContext
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import java.lang.ref.WeakReference
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [31])
class LiveVoiceRecorderTest {
  @Test fun preparingAgainReleasesTheUnusedMicrophone() = runTest {
    val context = RuntimeEnvironment.getApplication()
    val reactContext = BridgeReactContext(context)
    val appContext = AppContext(
      object : ModulesProvider {
        override fun getModulesMap() = emptyMap<Class<out Module>, String?>()
      },
      expo.modules.core.ModuleRegistry(emptyList(), emptyList()),
      WeakReference(reactContext)
    )
    val recorder = LiveVoiceRecorder(context, appContext, this) {}
    try {
      recorder.prepare()
      val previous = ReflectionHelpers.getField<AudioRecord>(recorder, "audio")
      assertEquals(AudioRecord.STATE_INITIALIZED, previous.state)
      recorder.prepare()
      assertEquals(AudioRecord.STATE_UNINITIALIZED, previous.state)
    } finally {
      recorder.sharedObjectDidRelease()
      appContext.javaClass.declaredMethods.first {
        it.name.startsWith("onDestroy") && it.parameterCount == 0
      }
        .invoke(appContext)
      reactContext.destroy()
    }
  }
}
