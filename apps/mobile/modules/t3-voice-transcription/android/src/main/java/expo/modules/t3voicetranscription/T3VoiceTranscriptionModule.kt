package expo.modules.t3voicetranscription

import android.content.res.Resources
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class T3VoiceTranscriptionModule : Module() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Any()
  private var operation: Pair<Int, Job>? = null

  override fun definition() = ModuleDefinition {
    Name("T3VoiceTranscription")

    Function("isAvailable") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.S }

    AsyncFunction("checkAvailability").Coroutine<Boolean> {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        false
      } else {
        withContext(Dispatchers.IO) {
          val context = requireNotNull(appContext.reactContext)
          val locale = Resources.getSystem().configuration.locales[0]
          isGoogleVoiceTranscriptionSupported { MlKitSpeechClient(context, locale, it) }
        }
      }
    }

    AsyncFunction("prepare") { id: Int, promise: Promise ->
      runOperation(id, promise, "preparation-failed") {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
          throw VoiceTranscriptionException(
            "unavailable",
            "Voice transcription requires Android 12 or later."
          )
        }
        val context = requireNotNull(appContext.reactContext)
        val locale = Resources.getSystem().configuration.locales[0]
        val mode = prepareGoogleVoiceTranscription { MlKitSpeechClient(context, locale, it) }
        mapOf("locale" to locale.toLanguageTag(), "mode" to mode)
      }
    }

    AsyncFunction("transcribe") {
        id: Int,
        uri: String,
        language: String,
        mode: Int,
        promise: Promise
      ->
      runOperation(id, promise, "transcription-failed") {
        val context = requireNotNull(appContext.reactContext)
        MlKitSpeechClient(context, Locale.forLanguageTag(language), mode).use { it.transcribe(uri) }
      }
    }

    AsyncFunction("cancel") { id: Int, promise: Promise ->
      scope.launch {
        val job = synchronized(lock) { operation?.takeIf { it.first == id }?.second }
        job?.cancelAndJoin()
        promise.resolve(null)
      }
    }

    OnDestroy { scope.cancel() }
  }

  private fun runOperation(
    id: Int,
    promise: Promise,
    errorCode: String,
    block: suspend () -> Any?
  ) {
    var result: Result<Any?>? = null
    val job = scope.launch(start = CoroutineStart.LAZY) {
      result = runCatching { block() }
    }
    synchronized(lock) {
      if (operation != null) {
        job.cancel()
        promise.reject(errorCode, "Another voice transcription is already active.", null)
        return
      }
      operation = id to job
    }
    job.invokeOnCompletion { cause ->
      synchronized(lock) { if (operation?.first == id) operation = null }
      val outcome = cause?.let { Result.failure<Any?>(it) } ?: result
        ?: Result.failure(CancellationException("Voice transcription was cancelled."))
      outcome.fold(
        onSuccess = { promise.resolve(it) },
        onFailure = { error ->
          val code = when (error) {
            is CancellationException -> "cancelled"
            is VoiceTranscriptionException -> error.code
            else -> errorCode
          }
          promise.reject(code, error.message, error)
        }
      )
    }
    job.start()
  }
}
