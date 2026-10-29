package expo.modules.t3voicetranscription

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GoogleVoiceTranscriberTest {
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
    for (errorCode in listOf(
      null,
      GenAiException.ErrorCode.NOT_AVAILABLE,
      GenAiException.ErrorCode.NOT_SUPPORTED
    )) {
      val advanced = Client(FeatureStatus.UNAVAILABLE, onStatus = {
        if (errorCode != null) throw GenAiException(Exception("Unavailable"), errorCode)
      })
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
      GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED,
      GenAiException.ErrorCode.NOT_SUPPORTED
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
