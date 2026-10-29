package expo.modules.t3voicetranscription

import android.content.Context
import android.net.Uri
import com.google.mlkit.genai.common.DownloadStatus
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.common.audio.AudioSource
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

internal class VoiceTranscriptionException(val code: String, message: String) : Exception(message)

internal interface GoogleSpeechClient : Closeable {
  suspend fun checkStatus(): Int
  suspend fun download()
}

internal suspend fun prepareGoogleVoiceTranscription(
  createClient: (Int) -> GoogleSpeechClient
): Int {
  for (mode in listOf(
    SpeechRecognizerOptions.Mode.MODE_ADVANCED,
    SpeechRecognizerOptions.Mode.MODE_BASIC
  )) {
    createClient(mode).use { client ->
      val status = checkModelSupport(client)
      when (status) {
        FeatureStatus.UNAVAILABLE -> return@use
        FeatureStatus.DOWNLOADABLE, FeatureStatus.DOWNLOADING -> client.download()
      }
      if (client.checkStatus() != FeatureStatus.AVAILABLE) {
        throw VoiceTranscriptionException(
          "preparation-failed",
          "Voice transcription could not prepare this language."
        )
      }
      return mode
    }
  }
  throw VoiceTranscriptionException(
    "unavailable",
    "On-device voice transcription is not available for this device language."
  )
}

private suspend fun checkModelSupport(client: GoogleSpeechClient): Int = try {
  client.checkStatus()
} catch (error: GenAiException) {
  if (error.errorCode != GenAiException.ErrorCode.NOT_AVAILABLE &&
    error.errorCode != GenAiException.ErrorCode.NOT_SUPPORTED
  ) {
    throw error
  }
  FeatureStatus.UNAVAILABLE
}

internal suspend fun collectGoogleVoiceTranscript(
  responses: Flow<SpeechRecognizerResponse>
): String {
  val text = StringBuilder()
  var partial = ""
  responses.collect { response ->
    when (response) {
      // ONE_SHOT files can emit multiple final utterances, with separators supplied by the SDK.
      is SpeechRecognizerResponse.FinalTextResponse -> {
        text.append(response.text)
        partial = ""
      }
      is SpeechRecognizerResponse.PartialTextResponse -> partial = response.text
      is SpeechRecognizerResponse.ErrorResponse -> throw response.e
      else -> Unit
    }
  }
  // Some file sessions complete with a trailing partial instead of another final event.
  return text.append(partial).toString().trim()
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

  suspend fun transcribe(uri: String): String = AudioSource.fromUri(
    context,
    Uri.parse(uri)
  ).use { source ->
    val request = speechRecognizerRequest { audioSource = source }
    try {
      collectGoogleVoiceTranscript(recognizer.startRecognition(request))
    } finally {
      // Stop inference before closing its audio descriptor, including coroutine cancellation.
      withContext(NonCancellable) { runCatching { recognizer.stopRecognition() } }
    }
  }

  override fun close() = recognizer.close()
}
