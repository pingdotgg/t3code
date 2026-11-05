package expo.modules.t3voicetranscription

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import androidx.annotation.RequiresApi
import expo.modules.audio.RecordingInputRoute
import expo.modules.audio.getMapFromDeviceInfo
import expo.modules.audio.recordingInputs
import expo.modules.audio.recordingInputUid
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job

@RequiresApi(31)
internal class LiveVoiceRecorder(
  private val context: Context,
  appContext: AppContext,
  private val scope: CoroutineScope,
  private val onRelease: (String) -> Unit
) : SharedObject(appContext) {
  val id = UUID.randomUUID().toString()
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val route = RecordingInputRoute(manager)
  private var audio: AudioRecord? = null
  private var pipe: PcmPipe? = null
  private var capture: LivePcmCapture? = null
  private var inputSelection: Job? = null
  private var inputCanceled = false
  private var inferenceStarted = false
  val uri: String? get() = capture?.file?.let { Uri.fromFile(it).toString() }

  @Suppress("TooGenericExceptionCaught") // Release native handles for every setup failure.
  fun prepare() {
    check(capture?.isRecording != true) { "Another voice recording is active." }
    pipe?.close()
    inputCanceled = false
    inferenceStarted = false
    val capacity = maxOf(
      32000,
      AudioRecord.getMinBufferSize(
        16000,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
    )
    val recorder = AudioRecord.Builder()
      .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
      .setAudioFormat(
        AudioFormat.Builder().setSampleRate(16000)
          .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
      )
      .setBufferSizeInBytes(capacity)
      .build()
    try {
      check(recorder.state == AudioRecord.STATE_INITIALIZED) { "The microphone could not prepare." }
      val output = PcmPipe.open()
      try {
        val file = File.createTempFile("dictation-live-", ".pcm", context.cacheDir)
        capture = LivePcmCapture(
          object : PcmCaptureSource {
            override val capacityBytes = capacity
            override fun start() {
              recorder.startRecording()
              check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                "The microphone could not start."
              }
            }
            override suspend fun read(buffer: ByteArray, blocking: Boolean) = recorder.read(
              buffer,
              0,
              buffer.size,
              if (blocking) AudioRecord.READ_BLOCKING else AudioRecord.READ_NON_BLOCKING
            )
            override fun stop() {
              if (recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) recorder.stop()
            }
            override fun release() {
              try {
                recorder.release()
              } finally {
                route.close()
              }
            }
          },
          file,
          output
        )
        audio = recorder
        pipe = output
      } catch (error: Throwable) {
        output.close()
        throw error
      }
    } catch (error: Throwable) {
      recorder.release()
      throw error
    }
  }

  fun record(seconds: Double) {
    val recording = requireNotNull(capture) { "The microphone is not prepared." }
    recording.start(scope, seconds) { error ->
      emit(
        "recordingStatusUpdate",
        mapOf(
          "id" to id,
          "isFinished" to true,
          "hasError" to (error != null),
          "error" to error?.message,
          "url" to Uri.fromFile(recording.file).toString()
        )
      )
    }
  }

  suspend fun stop() {
    val selection = synchronized(this) { inputSelection }
    selection?.cancel()
    selection?.join()
    capture?.stop()
    if (!inferenceStarted) pipe?.close()
  }

  fun status() = mapOf(
    "canRecord" to (capture != null),
    "isRecording" to (capture?.isRecording == true),
    "durationMillis" to (capture?.bytes?.div(32) ?: 0),
    "fileSize" to (capture?.file?.length() ?: 0),
    "metering" to (capture?.metering ?: -160.0),
    "mediaServicesDidReset" to false,
    "url" to uri
  )

  fun inputs() = recordingInputs(manager).let { inputs ->
    inputs.map { getMapFromDeviceInfo(it, inputs) }
  }

  // Release the preferred route on cancellation as well as selection errors.
  @Suppress("TooGenericExceptionCaught")
  suspend fun setInput(uid: String) {
    val job = currentCoroutineContext().job
    synchronized(this) {
      check(!inputCanceled) { "Microphone selection was cancelled." }
      inputSelection = job
    }
    try {
      val inputs = recordingInputs(manager)
      val selected = inputs.firstOrNull { recordingInputUid(it, inputs) == uid }
        ?: error("The preferred microphone is disconnected.")
      route.select(selected)
      val routed = recordingInputs(manager)
      val source = routed.firstOrNull { it.isSource && recordingInputUid(it, routed) == uid }
        ?: error("The preferred microphone is disconnected.")
      check(audio?.setPreferredDevice(source) == true) { "Could not select the microphone." }
    } catch (error: Throwable) {
      route.close()
      throw error
    } finally {
      synchronized(this) { if (inputSelection === job) inputSelection = null }
    }
  }

  @Synchronized fun cancelInputSelection() {
    inputCanceled = true
    inputSelection?.cancel()
  }

  suspend fun transcribe(uri: String, client: MlKitSpeechClient): String {
    check(this.uri == uri && !inferenceStarted) { "The voice recording is no longer available." }
    inferenceStarted = true
    return client.transcribeLive(requireNotNull(capture), requireNotNull(pipe))
  }

  override fun sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    cancelInputSelection()
    capture?.abort()
    pipe?.close()
    onRelease(id)
  }
}
