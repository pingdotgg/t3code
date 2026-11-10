package expo.modules.t3voicetranscription

import android.content.res.Resources
import android.os.Build
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.modules.ModuleDefinitionBuilder
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
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
  private val recorders = ConcurrentHashMap<String, LiveVoiceRecorder>()

  override fun definition() = ModuleDefinition {
    Name("T3VoiceTranscription")

    defineDecodeRecording()

    AsyncFunction("checkAvailability").Coroutine<Map<String, Any>?> {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        null
      } else {
        withContext(Dispatchers.IO) {
          val context = requireNotNull(appContext.reactContext)
          val locale = speechLocale(Resources.getSystem().configuration.locales[0])
          probeGoogleVoiceTranscription { MlKitSpeechClient(context, locale, it) }?.let {
            mapOf(
              "language" to locale.displayName,
              "advanced" to (it.mode == SpeechRecognizerOptions.Mode.MODE_ADVANCED),
              "downloaded" to it.downloaded
            )
          }
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
        val locale = speechLocale(Resources.getSystem().configuration.locales[0])
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

    AsyncFunction("startLive") {
        id: Int,
        uri: String,
        language: String,
        mode: Int,
        promise: Promise
      ->
      runOperation(id, promise, "transcription-failed") {
        val recorder = recorders.values.firstOrNull { it.uri == uri }
          ?: error("The voice recording is no longer available.")
        val context = requireNotNull(appContext.reactContext)
        MlKitSpeechClient(context, Locale.forLanguageTag(language), mode).use {
          recorder.transcribe(uri, it)
        }
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      defineLiveRecorder()
    }

    AsyncFunction("cancel") { id: Int, promise: Promise ->
      scope.launch {
        val job = synchronized(lock) { operation?.takeIf { it.first == id }?.second }
        job?.cancelAndJoin()
        promise.resolve(null)
      }
    }

    OnDestroy {
      recorders.values.toList().forEach { it.sharedObjectDidRelease() }
      scope.cancel()
    }
  }

  private fun ModuleDefinitionBuilder.defineDecodeRecording() {
    AsyncFunction("decodeRecording").Coroutine { uri: String ->
      val context = requireNotNull(appContext.reactContext)
      withContext(Dispatchers.IO) {
        require(android.net.Uri.parse(uri).scheme == "file") { "Expected a local recording." }
        withRecordedPcm(context, uri) { pcm ->
          requireCompleteAudio(pcm.length() <= 16000L * 2 * 301) {
            "Recording exceeds five minutes."
          }
          pcm.readBytes()
        }
      }
    }
  }

  private fun ModuleDefinitionBuilder.defineLiveRecorder() {
    Class(LiveVoiceRecorder::class) {
      Constructor {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
        LiveVoiceRecorder(requireNotNull(appContext.reactContext), appContext, scope) {
          recorders.remove(it)
        }.also { recorders[it.id] = it }
      }
      Property("uri") { recorder -> recorder.uri }
      AsyncFunction("prepareToRecordAsync") Coroutine { recorder: LiveVoiceRecorder ->
        withContext(Dispatchers.IO) { recorder.prepare() }
      }
      Function("record") { recorder: LiveVoiceRecorder, options: Map<String, Double> ->
        recorder.record(options["forDuration"] ?: 300.0)
      }
      AsyncFunction("stop") Coroutine { recorder: LiveVoiceRecorder -> recorder.stop() }
      Function("getStatus") { recorder: LiveVoiceRecorder -> recorder.status() }
      Function("getAvailableInputs") { recorder: LiveVoiceRecorder -> recorder.inputs() }
      AsyncFunction("setInput") Coroutine { recorder: LiveVoiceRecorder, uid: String ->
        recorder.setInput(uid)
      }
      Function("cancelInputSelection") { recorder: LiveVoiceRecorder ->
        recorder.cancelInputSelection()
      }
    }
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
        promise.reject("busy", "Another voice transcription is already active.", null)
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
          val code = voiceTranscriptionErrorCode(error, errorCode)
          promise.reject(code, error.message, error)
        }
      )
    }
    job.start()
  }
}
