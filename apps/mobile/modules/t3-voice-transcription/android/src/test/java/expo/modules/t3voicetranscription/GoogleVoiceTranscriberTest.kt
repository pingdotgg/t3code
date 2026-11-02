package expo.modules.t3voicetranscription

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class GoogleVoiceTranscriberTest {
  @Test
  fun keepsEveryUtteranceAcrossPauses() = runBlocking {
    val responses = flow {
      emit(SpeechRecognizerResponse.PartialTextResponse("The beg"))
      emit(SpeechRecognizerResponse.FinalTextResponse("The beginning.", emptyList()))
      emit(SpeechRecognizerResponse.FinalTextResponse(" The middle.", emptyList()))
      emit(SpeechRecognizerResponse.PartialTextResponse(" The end."))
      emit(SpeechRecognizerResponse.CompletedResponse)
    }
    assertEquals(
      "The beginning. The middle. The end.",
      collectGoogleVoiceTranscript(responses)
    )
  }

  private class Client(var status: Int) : GoogleSpeechClient {
    override suspend fun checkStatus() = status

    override suspend fun download() {
      status = FeatureStatus.AVAILABLE
    }

    override fun close() = Unit
  }

  @Test
  fun prefersAdvancedAndFallsBackToBasicOnlyWhenUnsupported() = runBlocking {
    for ((advanced, expected) in listOf(
      FeatureStatus.DOWNLOADABLE to SpeechRecognizerOptions.Mode.MODE_ADVANCED,
      FeatureStatus.UNAVAILABLE to SpeechRecognizerOptions.Mode.MODE_BASIC
    )) {
      val mode = prepareGoogleVoiceTranscription {
        Client(if (it == SpeechRecognizerOptions.Mode.MODE_ADVANCED) advanced else FeatureStatus.AVAILABLE)
      }
      assertEquals(expected, mode)
    }
  }
}
