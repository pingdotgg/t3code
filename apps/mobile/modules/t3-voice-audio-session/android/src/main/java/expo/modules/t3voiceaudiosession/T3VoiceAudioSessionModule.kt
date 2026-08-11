package expo.modules.t3voiceaudiosession

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3VoiceAudioSessionModule : Module() {
  private var audioManager: AudioManager? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var noisyReceiver: BroadcastReceiver? = null
  private var receiverContext: Context? = null
  private var currentActivationToken: Int? = null
  private var nextActivationToken = 0

  override fun definition() = ModuleDefinition {
    Name("T3VoiceAudioSession")
    Events("onVoiceAudioSessionEvent")

    Function("start") {
      startSession()
    }

    Function("stop") { activationToken: Int ->
      stopSession(activationToken)
    }

    OnDestroy {
      stopCurrentSession()
    }
  }

  private fun startSession(): Int {
    currentActivationToken?.let { return it }
    val context = appContext.reactContext
      ?: throw IllegalStateException("React context is unavailable")
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: throw IllegalStateException("Audio service is unavailable")
    val activationToken = allocateActivationToken()
    currentActivationToken = activationToken

    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      when (change) {
        AudioManager.AUDIOFOCUS_LOSS,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK ->
          emit("interruption", activationToken)
      }
    }
    val request = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener(listener)
        .build()
    } else {
      null
    }
    val focusResult = if (request != null) {
      manager.requestAudioFocus(request)
    } else {
      @Suppress("DEPRECATION")
      manager.requestAudioFocus(
        listener,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
      )
    }
    if (focusResult != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      currentActivationToken = null
      throw IllegalStateException("Voice audio focus was not granted")
    }

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
          emit("route_lost", activationToken)
        }
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.registerReceiver(
          receiver,
          IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
          Context.RECEIVER_NOT_EXPORTED,
        )
      } else {
        @Suppress("DEPRECATION")
        context.registerReceiver(
          receiver,
          IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
        )
      }
    } catch (error: Throwable) {
      currentActivationToken = null
      runCatching { context.unregisterReceiver(receiver) }
      abandonFocus(manager, request, listener)
      throw error
    }

    audioManager = manager
    audioFocusRequest = request
    focusListener = listener
    noisyReceiver = receiver
    receiverContext = context
    return activationToken
  }

  private fun allocateActivationToken(): Int {
    nextActivationToken = if (nextActivationToken == Int.MAX_VALUE) 1 else nextActivationToken + 1
    return nextActivationToken
  }

  private fun emit(kind: String, activationToken: Int) {
    if (currentActivationToken != activationToken) return
    sendEvent(
      "onVoiceAudioSessionEvent",
      mapOf("kind" to kind, "activationToken" to activationToken),
    )
  }

  private fun stopSession(activationToken: Int) {
    if (currentActivationToken != activationToken) return
    stopCurrentSession()
  }

  private fun stopCurrentSession() {
    if (currentActivationToken == null) return
    currentActivationToken = null
    val manager = audioManager
    val request = audioFocusRequest
    val listener = focusListener
    val receiver = noisyReceiver
    val context = receiverContext

    audioManager = null
    audioFocusRequest = null
    focusListener = null
    noisyReceiver = null
    receiverContext = null

    if (receiver != null && context != null) {
      runCatching { context.unregisterReceiver(receiver) }
    }
    if (manager != null && listener != null) {
      abandonFocus(manager, request, listener)
    }
  }

  private fun abandonFocus(
    manager: AudioManager,
    request: AudioFocusRequest?,
    listener: AudioManager.OnAudioFocusChangeListener,
  ) {
    runCatching {
      if (request != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.abandonAudioFocusRequest(request)
      } else {
        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(listener)
      }
    }
  }
}
