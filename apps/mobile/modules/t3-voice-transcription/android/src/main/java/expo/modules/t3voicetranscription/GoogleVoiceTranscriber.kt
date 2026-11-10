package expo.modules.t3voicetranscription

import android.content.Context
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import com.google.mlkit.genai.speechrecognition.speechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.speechRecognizerRequest
import java.io.Closeable
import java.util.Locale
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext

internal class VoiceTranscriptionException(
  val code: String,
  message: String,
  cause: Throwable? = null
) : Exception(message, cause)

// ML Kit reports every mode UNAVAILABLE for tags with Unicode extensions, which Android adds
// for regional preferences such as the temperature unit (en-US-u-mu-celsius).
internal fun speechLocale(systemLocale: Locale): Locale = systemLocale.stripExtensions()

private val recognitionModes = listOf(
  SpeechRecognizerOptions.Mode.MODE_ADVANCED,
  SpeechRecognizerOptions.Mode.MODE_BASIC
)

internal data class GoogleVoiceSupport(val mode: Int, val downloaded: Boolean)

/** The mode `prepareGoogleVoiceTranscription` would pick, without downloading its model. */
internal suspend fun probeGoogleVoiceTranscription(
  createClient: (Int) -> GoogleSpeechClient
): GoogleVoiceSupport? {
  for (mode in recognitionModes) {
    val status = createClient(mode).use { checkModelSupport(it) }
    if (status in supportedStatuses) {
      return GoogleVoiceSupport(mode, downloaded = status == FeatureStatus.AVAILABLE)
    }
  }
  return null
}

private val supportedStatuses = setOf(
  FeatureStatus.AVAILABLE,
  FeatureStatus.DOWNLOADABLE,
  FeatureStatus.DOWNLOADING
)

internal suspend fun prepareGoogleVoiceTranscription(
  createClient: (Int) -> GoogleSpeechClient
): Int {
  for (mode in recognitionModes) {
    createClient(mode).use { client ->
      if (prepareModel(client)) return mode
    }
  }
  throw VoiceTranscriptionException(
    "unavailable",
    "On-device voice transcription is not available for this device language."
  )
}

private suspend fun prepareModel(client: GoogleSpeechClient): Boolean = try {
  val status = client.checkStatus()
  if (status == FeatureStatus.UNAVAILABLE) {
    false
  } else {
    if (status == FeatureStatus.DOWNLOADABLE ||
      status == FeatureStatus.DOWNLOADING
    ) {
      client.download()
    }
    when (client.checkStatus()) {
      FeatureStatus.UNAVAILABLE -> false
      FeatureStatus.AVAILABLE -> true
      else -> throw VoiceTranscriptionException(
        "preparation-failed",
        "Voice transcription could not prepare this language."
      )
    }
  }
} catch (error: GenAiException) {
  if (!isModelUnavailable(error)) throw error
  false
}

// Any probe failure for one mode means "try the next mode"; prepare surfaces the real error.
private suspend fun checkModelSupport(client: GoogleSpeechClient): Int = try {
  client.checkStatus()
} catch (_: GenAiException) {
  FeatureStatus.UNAVAILABLE
}

private fun isModelUnavailable(error: GenAiException): Boolean = when (error.errorCode) {
  GenAiException.ErrorCode.NOT_AVAILABLE,
  GenAiException.ErrorCode.NOT_SUPPORTED,
  GenAiException.ErrorCode.AICORE_INCOMPATIBLE,
  GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE -> true
  else -> false
}

internal suspend fun collectGoogleVoiceTranscript(
  responses: Flow<SpeechRecognizerResponse>
): String {
  val text = StringBuilder()
  var partial = ""
  var completed = false
  responses.collect { response ->
    when (response) {
      // Separators between final utterances are supplied by the SDK.
      is SpeechRecognizerResponse.FinalTextResponse -> {
        text.append(response.text)
        partial = ""
      }
      is SpeechRecognizerResponse.PartialTextResponse -> partial = response.text
      is SpeechRecognizerResponse.ErrorResponse -> throw response.e
      is SpeechRecognizerResponse.CompletedResponse -> completed = true
      else -> Unit
    }
  }
  requireCompleteAudio(completed) { "Speech recognition did not complete the recording." }
  // Some sessions complete with a trailing partial instead of another final event.
  return text.append(partial).toString().trim()
}

internal interface GoogleSpeechClient : Closeable {
  suspend fun checkStatus(): Int
  suspend fun download()
}

internal class MlKitSpeechClient(context: Context, locale: Locale, mode: Int) : GoogleSpeechClient {
  private val context = context.applicationContext
  private val recognizer = SpeechRecognition.getClient(
    speechRecognizerOptions {
      this.locale = locale
      preferredMode = mode
    }
  )

  override suspend fun checkStatus() = recognizer.checkStatus()

  override suspend fun download() {
    val result = recognizer.download().first {
      it is DownloadStatus.DownloadCompleted || it is DownloadStatus.DownloadFailed
    }
    if (result is DownloadStatus.DownloadFailed) throw result.e
  }

  suspend fun transcribe(uri: String): String = withRecordedPcm(context, uri) { pcm ->
    PcmPipe.open().use { pipe ->
      val request = speechRecognizerRequest { audioSource = pipe.source }
      try {
        collectGoogleVoiceTranscript(
          pacedRecordedResponses(pcm, pipe) {
            recognizer.startRecognition(request)
          }
        )
      } finally {
        // Stop inference before closing the SDK-owned descriptor, including cancellation.
        withContext(NonCancellable) { runCatching { recognizer.stopRecognition() } }
      }
    }
  }

  suspend fun transcribeLive(capture: LivePcmCapture, pipe: PcmPipe): String = pipe.use {
    val request = speechRecognizerRequest { audioSource = pipe.source }
    try {
      collectGoogleVoiceTranscript(
        livePcmResponses(capture, pipe) { recognizer.startRecognition(request) }
      )
    } finally {
      withContext(NonCancellable) { runCatching { recognizer.stopRecognition() } }
    }
  }

  override fun close() = recognizer.close()
}
