package expo.modules.t3voicetranscription

import com.google.mlkit.genai.common.GenAiException
import kotlinx.coroutines.CancellationException

internal fun voiceTranscriptionErrorCode(
  error: Throwable,
  fallback: String
): String = when (error) {
  is CancellationException -> "cancelled"
  is VoiceTranscriptionException -> error.code
  is GenAiException -> when {
    error.message.orEmpty().contains("NO_SPEECH_DETECTED") -> "no-speech"
    error.errorCode == GenAiException.ErrorCode.NOT_ENOUGH_DISK_SPACE -> "storage"
    error.errorCode == GenAiException.ErrorCode.PER_APP_BATTERY_USE_QUOTA_EXCEEDED -> "quota"
    error.errorCode == GenAiException.ErrorCode.BUSY -> "busy"
    error.errorCode == GenAiException.ErrorCode.AUDIO_BUFFER_OVERFLOW -> "audio-overflow"
    error.errorCode == GenAiException.ErrorCode.NEEDS_SYSTEM_UPDATE ||
      error.errorCode == GenAiException.ErrorCode.AICORE_INCOMPATIBLE -> "needs-update"
    error.message.orEmpty().contains("DOWNLOAD_ERROR") -> "download-failed"
    else -> fallback
  }
  else -> fallback
}
