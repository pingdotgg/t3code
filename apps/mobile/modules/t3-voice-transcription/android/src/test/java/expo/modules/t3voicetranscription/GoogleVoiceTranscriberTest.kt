package expo.modules.t3voicetranscription

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleVoiceTranscriberTest {
  @Test
  fun preservesUtterancesAndTheirSpacingWithoutDuplicatingHypotheses() = runBlocking {
    for ((finals, trailing, expected) in listOf(
      Triple(
        listOf("The beginning.", " The middle.", " Repeat this.", " Repeat this."),
        emptyList(),
        "The beginning. The middle. Repeat this. Repeat this."
      ),
      Triple(listOf("最初の文。", "次の文。"), emptyList(), "最初の文。次の文。"),
      Triple(
        listOf("The beginning."),
        listOf(" An unfinished ending", " The final sentence."),
        "The beginning. The final sentence."
      )
    )) {
      val responses = flow {
        for (text in finals) {
          emit(SpeechRecognizerResponse.PartialTextResponse("Unfinished hypothesis"))
          emit(SpeechRecognizerResponse.FinalTextResponse(text, emptyList()))
        }
        for (text in trailing) emit(SpeechRecognizerResponse.PartialTextResponse(text))
        emit(SpeechRecognizerResponse.CompletedResponse)
      }
      assertEquals(expected, collectGoogleVoiceTranscript(responses))
    }
  }

  private class Client(
    var status: Int,
    val onStatus: () -> Unit = {},
    val onDownload: suspend () -> Unit = {}
  ) : GoogleSpeechClient {
    var closed = false
    var downloads = 0

    override suspend fun checkStatus(): Int {
      onStatus()
      return status
    }

    override suspend fun download() {
      downloads += 1
      onDownload()
      status = FeatureStatus.AVAILABLE
    }

    override fun close() {
      closed = true
    }
  }

  @Test
  fun checksSupportWithoutDownloadingAndClosesProbedClients() = runBlocking {
    for ((advancedStatus, basicStatus, supported) in listOf(
      Triple(FeatureStatus.AVAILABLE, FeatureStatus.UNAVAILABLE, true),
      Triple(FeatureStatus.DOWNLOADABLE, FeatureStatus.UNAVAILABLE, true),
      Triple(FeatureStatus.DOWNLOADING, FeatureStatus.UNAVAILABLE, true),
      Triple(FeatureStatus.UNAVAILABLE, FeatureStatus.AVAILABLE, true),
      Triple(FeatureStatus.UNAVAILABLE, FeatureStatus.DOWNLOADABLE, true),
      Triple(FeatureStatus.UNAVAILABLE, FeatureStatus.DOWNLOADING, true),
      Triple(FeatureStatus.UNAVAILABLE, FeatureStatus.UNAVAILABLE, false)
    )) {
      val clients = mutableListOf<Client>()
      assertEquals(
        supported,
        isGoogleVoiceTranscriptionSupported { mode ->
          Client(
            if (mode == SpeechRecognizerOptions.Mode.MODE_ADVANCED) advancedStatus else basicStatus
          ).also { clients.add(it) }
        }
      )
      assertTrue(clients.all { it.closed && it.downloads == 0 })
      assertEquals(if (advancedStatus == FeatureStatus.UNAVAILABLE) 2 else 1, clients.size)
    }
  }

  @Test
  fun preparesAdvancedBeforeConsideringBasic() = runBlocking {
    for (status in listOf(
      FeatureStatus.AVAILABLE,
      FeatureStatus.DOWNLOADABLE,
      FeatureStatus.DOWNLOADING
    )) {
      val client = Client(status)
      val mode = prepareGoogleVoiceTranscription {
        assertEquals(SpeechRecognizerOptions.Mode.MODE_ADVANCED, it)
        client
      }
      assertEquals(SpeechRecognizerOptions.Mode.MODE_ADVANCED, mode)
      assertEquals(if (status == FeatureStatus.AVAILABLE) 0 else 1, client.downloads)
      assertTrue(client.closed)
    }
  }

  @Test
  fun fallsBackToBasicOnlyForUnavailableAdvancedModels() = runBlocking {
    for ((duringDownload, errorCode) in listOf(
      false to null,
      false to GenAiException.ErrorCode.NOT_AVAILABLE,
      false to GenAiException.ErrorCode.NOT_SUPPORTED,
      true to GenAiException.ErrorCode.NOT_AVAILABLE,
      true to GenAiException.ErrorCode.NOT_SUPPORTED
    )) {
      val advanced = Client(
        if (duringDownload) FeatureStatus.DOWNLOADABLE else FeatureStatus.UNAVAILABLE,
        onStatus = {
          if (!duringDownload && errorCode != null) {
            throw GenAiException(Exception("Unavailable"), errorCode)
          }
        },
        onDownload = {
          if (duringDownload && errorCode != null) {
            throw GenAiException(Exception("Unavailable"), errorCode)
          }
        }
      )
      val basic = Client(FeatureStatus.DOWNLOADABLE)
      val mode = prepareGoogleVoiceTranscription {
        if (it == SpeechRecognizerOptions.Mode.MODE_ADVANCED) advanced else basic
      }
      assertEquals(SpeechRecognizerOptions.Mode.MODE_BASIC, mode)
      assertTrue(advanced.closed && basic.closed)
      assertEquals(1, basic.downloads)
    }
    val clients = mutableListOf<Client>()
    val result = runCatching {
      prepareGoogleVoiceTranscription { Client(FeatureStatus.UNAVAILABLE).also { clients.add(it) } }
    }
    assertEquals("unavailable", (result.exceptionOrNull() as VoiceTranscriptionException).code)
    assertTrue(clients.all { it.closed })
  }

  @Test
  fun preservesDownloadAndQuotaFailuresInsteadOfSilentlyFallingBack() = runBlocking {
    for (errorCode in listOf(
      GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE,
      GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED
    )) {
      val error = GenAiException(Exception("Preparation failed"), errorCode)
      val client = Client(FeatureStatus.DOWNLOADABLE, onDownload = { throw error })
      val result = runCatching {
        prepareGoogleVoiceTranscription {
          assertEquals(SpeechRecognizerOptions.Mode.MODE_ADVANCED, it)
          client
        }
      }
      assertEquals(error, result.exceptionOrNull())
      assertTrue(client.closed)
    }
  }

  @Test
  fun cancellationClosesTheDownloadingClientWithoutStartingBasic() = runBlocking {
    val enteredDownload = CompletableDeferred<Unit>()
    val download = CompletableDeferred<Unit>()
    val client = Client(FeatureStatus.DOWNLOADABLE, onDownload = {
      enteredDownload.complete(Unit)
      download.await()
    })
    val job = launch {
      prepareGoogleVoiceTranscription {
        assertEquals(SpeechRecognizerOptions.Mode.MODE_ADVANCED, it)
        client
      }
    }
    enteredDownload.await()
    job.cancelAndJoin()
    assertTrue(client.closed)
    assertEquals(FeatureStatus.DOWNLOADABLE, client.status)
  }
}
