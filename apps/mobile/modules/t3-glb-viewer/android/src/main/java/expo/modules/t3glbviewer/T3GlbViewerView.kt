package expo.modules.t3glbviewer

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import com.google.android.filament.IndirectLight
import com.google.android.filament.Renderer
import com.google.android.filament.View as FilamentView
import com.google.android.filament.utils.ModelViewer
import com.google.android.filament.utils.Utils
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.channels.FileChannel
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

private const val CONNECT_TIMEOUT_MS = 15_000
private const val READ_TIMEOUT_MS = 60_000
private const val LOAD_TIMEOUT_MS = 90_000L
private const val TARGET_FRAME_INTERVAL_MS = 33L
private const val DOWNLOAD_CHUNK_BYTES = 32_768
private const val MEMORY_MESSAGE =
  "This 3D model requires too much memory to preview on this device."

/** Frames drawn after a gesture so the camera settles before the loop idles again. */
private const val SETTLE_FRAMES = 4

class T3GlbViewerView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  companion object {
    init {
      Utils.init()
    }
  }

  private val onLoadStart by EventDispatcher()
  private val onLoad by EventDispatcher()
  private val onError by EventDispatcher()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val loader: ExecutorService = Executors.newSingleThreadExecutor()
  private val frameCallback = Choreographer.FrameCallback(::renderFrame)
  private val replayDetector = GestureDetector(
    context,
    object : GestureDetector.SimpleOnGestureListener() {
      override fun onSingleTapUp(event: MotionEvent): Boolean {
        replayAnimation()
        return false
      }
    },
  )
  private val surfaceCallback =
    object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) {
        if (surfaceView?.holder !== holder) return
        surfaceReady = true
        redraw()
      }

      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (surfaceView?.holder === holder) redraw()
      }

      override fun surfaceDestroyed(holder: SurfaceHolder) {
        if (surfaceView?.holder !== holder) return
        surfaceReady = false
        stopRendering()
      }
    }
  private var surfaceView: SurfaceView? = null
  private var surfaceReady = false
  private var modelViewer: ModelViewer? = null
  private var loadTask: Future<*>? = null
  private var loadGeneration = 0
  private var requestedUri = ""
  private var backgroundColorValue = Color.parseColor("#0e0e0e")
  private var animationStartTimeNanos = 0L
  private var animationCompleted = false
  private var settleFrames = 0
  private var frameScheduled = false
  private var loadEventPending = false
  private var loadTimeoutTask: Runnable? = null
  private var renderingFailed = false
  private var disposed = false

  @Volatile
  private var activeConnection: HttpURLConnection? = null

  init {
    contentDescription = "Interactive 3D model preview"
    clipChildren = true
    clipToPadding = true
    setBackgroundColor(backgroundColorValue)
  }

  fun setModelUri(uri: String) {
    if (requestedUri == uri) return
    requestedUri = uri
    beginLoad()
  }

  fun setViewerBackgroundColor(color: String) {
    backgroundColorValue = parseColor(color, backgroundColorValue)
    setBackgroundColor(backgroundColorValue)
    modelViewer?.let(::applyBackground)
    requestFrame()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (disposed) return
    ensureRenderer()
    beginLoad()
    redraw()
  }

  override fun onDetachedFromWindow() {
    stopRendering()
    cancelLoad()
    destroyRenderer()
    super.onDetachedFromWindow()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    if (visibility == View.VISIBLE) {
      redraw()
    } else {
      stopRendering()
    }
  }

  fun cleanup() {
    if (disposed) return
    disposed = true
    stopRendering()
    cancelLoad()
    destroyRenderer()
    loader.shutdownNow()
  }

  private fun ensureRenderer() {
    if (modelViewer != null || disposed) return

    val nextSurfaceView = SurfaceView(context).apply {
      setZOrderOnTop(false)
      setZOrderMediaOverlay(false)
      holder.setFormat(PixelFormat.OPAQUE)
    }
    val nextViewer = ModelViewer(nextSurfaceView)
    configureViewer(nextViewer)
    nextSurfaceView.setOnTouchListener { view, event ->
      replayDetector.onTouchEvent(event)
      val handled = nextViewer.onTouch(view, event)
      redraw()
      handled
    }
    surfaceView = nextSurfaceView
    modelViewer = nextViewer
    nextSurfaceView.holder.addCallback(surfaceCallback)
    addView(
      nextSurfaceView,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )
  }

  private fun destroyRenderer() {
    val currentSurfaceView = surfaceView
    surfaceReady = false
    modelViewer = null
    surfaceView = null
    currentSurfaceView?.holder?.removeCallback(surfaceCallback)
    // ModelViewer destroys its engine from its view-detach listener. Calling destroy() here too can
    // race ResourceLoader cleanup while a native-stack transition removes this screen.
    if (currentSurfaceView?.parent === this) removeView(currentSurfaceView)
  }

  private fun configureViewer(viewer: ModelViewer) {
    // Animation timing is bounded below; Filament's built-in auto-play would otherwise apply a
    // second, continuously advancing sample inside ModelViewer.render().
    viewer.autoPlayAnimations = false
    applyBackground(viewer)
    viewer.view.apply {
      renderQuality = renderQuality.apply { hdrColorBuffer = FilamentView.QualityLevel.MEDIUM }
      dynamicResolutionOptions = dynamicResolutionOptions.apply {
        enabled = true
        quality = FilamentView.QualityLevel.MEDIUM
      }
      multiSampleAntiAliasingOptions = multiSampleAntiAliasingOptions.apply { enabled = true }
      antiAliasing = FilamentView.AntiAliasing.FXAA
      ambientOcclusionOptions = ambientOcclusionOptions.apply { enabled = true }
    }

    val lightManager = viewer.engine.lightManager
    val lightInstance = lightManager.getInstance(viewer.light)
    lightManager.setDirection(lightInstance, -0.6f, -1.0f, -0.8f)
    lightManager.setIntensity(lightInstance, 85_000f)
    viewer.scene.indirectLight =
      IndirectLight.Builder()
        .irradiance(1, floatArrayOf(0.65f, 0.65f, 0.65f))
        .intensity(20_000f)
        .build(viewer.engine)
  }

  private fun applyBackground(viewer: ModelViewer) {
    val red = Color.red(backgroundColorValue) / 255.0
    val green = Color.green(backgroundColorValue) / 255.0
    val blue = Color.blue(backgroundColorValue) / 255.0
    viewer.renderer.clearOptions =
      Renderer.ClearOptions().apply {
        clearColor = doubleArrayOf(red, green, blue, 1.0)
        clear = true
        discard = true
      }
  }

  @Suppress("TooGenericExceptionCaught") // Any transport failure must reach the user.
  private fun beginLoad() {
    val viewer = modelViewer ?: return
    if (!isAttachedToWindow || requestedUri.isBlank() || disposed) return

    cancelLoad()
    val generation = loadGeneration
    val uri = requestedUri
    viewer.destroyModel()
    loadEventPending = false
    renderingFailed = false
    animationStartTimeNanos = 0L
    animationCompleted = false
    onLoadStart(emptyMap<String, Any>())
    scheduleLoadTimeout(generation)

    loadTask =
      loader.submit {
        try {
          val downloadedFile = downloadGlb(uri)
          mainHandler.post { finishLoad(generation, downloadedFile) }
        } catch (_: InterruptedIOException) {
          // A newer request or a detached view owns the next visible state.
        } catch (_: OutOfMemoryError) {
          mainHandler.post { failLoad(generation, MEMORY_MESSAGE) }
        } catch (error: Exception) {
          mainHandler.post { failLoad(generation, userFacingMessage(error)) }
        }
      }
  }

  @Suppress("TooGenericExceptionCaught") // Filament rejects malformed assets with varied types.
  private fun finishLoad(generation: Int, downloadedFile: File) {
    if (!isCurrentLoad(generation)) {
      downloadedFile.delete()
      return
    }
    loadTask = null
    val viewer = modelViewer
    if (viewer == null) {
      downloadedFile.delete()
      return
    }
    try {
      FileInputStream(downloadedFile).channel.use { channel ->
        viewer.loadModelGlb(channel.map(FileChannel.MapMode.READ_ONLY, 0, channel.size()))
      }
      if (viewer.asset == null) {
        throw GlbLoadException("The file is not a supported GLB model.")
      }
      viewer.transformToUnitCube()
      loadEventPending = true
      requestFrame()
    } catch (_: OutOfMemoryError) {
      failLoad(generation, MEMORY_MESSAGE)
    } catch (error: Exception) {
      failLoad(generation, userFacingMessage(error))
    } finally {
      downloadedFile.delete()
    }
  }

  private fun failLoad(generation: Int, message: String) {
    if (!isCurrentLoad(generation)) return
    cancelLoadTimeout()
    loadTask?.cancel(true)
    loadTask = null
    activeConnection?.disconnect()
    activeConnection = null
    loadEventPending = false
    renderingFailed = true
    animationCompleted = true
    stopRendering()
    modelViewer?.destroyModel()
    onError(mapOf("message" to message))
  }

  private fun cancelLoad() {
    loadGeneration += 1
    cancelLoadTimeout()
    loadTask?.cancel(true)
    loadTask = null
    activeConnection?.disconnect()
    activeConnection = null
  }

  private fun scheduleLoadTimeout(generation: Int) {
    cancelLoadTimeout()
    val task = Runnable {
      failLoad(generation, "The 3D model took too long to load. Try again.")
    }
    loadTimeoutTask = task
    mainHandler.postDelayed(task, LOAD_TIMEOUT_MS)
  }

  private fun cancelLoadTimeout() {
    loadTimeoutTask?.let(mainHandler::removeCallbacks)
    loadTimeoutTask = null
  }

  private fun isCurrentLoad(generation: Int): Boolean =
    !disposed && !renderingFailed && isAttachedToWindow && generation == loadGeneration

  private fun downloadGlb(uri: String): File {
    val connection =
      (URL(uri).openConnection() as? HttpURLConnection)
        ?: throw GlbLoadException("The 3D model URL is not supported.")
    val outputFile = File.createTempFile("t3-glb-", ".glb", context.cacheDir)
    var completed = false
    activeConnection = connection
    return try {
      configureConnection(connection)
      val contentLength = validatedContentLength(connection)
      val fileSize =
        connection.inputStream.use { input ->
          FileOutputStream(outputFile).use { output -> copyBoundedBody(input, output) }
        }
      validateGlbFile(outputFile, fileSize, contentLength)
      completed = true
      outputFile
    } finally {
      connection.disconnect()
      if (activeConnection === connection) activeConnection = null
      if (!completed) outputFile.delete()
    }
  }

  /** Streams the body through, stopping at the preview size limit or when the load is cancelled. */
  private fun copyBoundedBody(input: InputStream, output: OutputStream): Long {
    var totalBytes = 0L
    val buffer = ByteArray(DOWNLOAD_CHUNK_BYTES)
    while (true) {
      if (Thread.currentThread().isInterrupted) throw InterruptedIOException()
      val count = input.read(buffer)
      if (count < 0) break
      totalBytes += count
      if (totalBytes > MAX_GLB_BYTES) throw GlbLoadException(OVERSIZE_MESSAGE)
      output.write(buffer, 0, count)
    }
    return totalBytes
  }

  /** Rejects error responses and oversized models before any of the body is read. */
  private fun validatedContentLength(connection: HttpURLConnection): Long {
    val responseCode = connection.responseCode
    if (responseCode !in 200..299) {
      throw GlbLoadException("The server returned HTTP $responseCode for this model.")
    }
    val contentLength = connection.contentLengthLong
    if (contentLength > MAX_GLB_BYTES) throw GlbLoadException(OVERSIZE_MESSAGE)
    return contentLength
  }

  /** Rejects a transfer that ended early, then anything that is not a GLB 2.0 container. */
  private fun validateGlbFile(file: File, fileSize: Long, contentLength: Long) {
    if (contentLength >= 0L && fileSize != contentLength) {
      throw GlbLoadException("The 3D model download ended before it finished.")
    }
    val header = ByteArray(GLB_HEADER_SIZE)
    val headerSize = FileInputStream(file).use { it.read(header) }
    validateGlbHeader(if (headerSize < 0) ByteArray(0) else header.copyOf(headerSize), fileSize)
  }

  private fun configureConnection(connection: HttpURLConnection) {
    connection.connectTimeout = CONNECT_TIMEOUT_MS
    connection.readTimeout = READ_TIMEOUT_MS
    connection.instanceFollowRedirects = true
    connection.setRequestProperty("Accept", "model/gltf-binary, application/octet-stream")
  }

  private fun requestFrame(delayMillis: Long = 0L) {
    if (frameScheduled || !shouldRender()) return
    frameScheduled = true
    Choreographer.getInstance().postFrameCallbackDelayed(frameCallback, delayMillis)
  }

  /** Wakes the parked loop and keeps it running long enough for the scene to settle. */
  private fun redraw() {
    settleFrames = SETTLE_FRAMES
    requestFrame()
  }

  private fun stopRendering() {
    if (frameScheduled) Choreographer.getInstance().removeFrameCallback(frameCallback)
    frameScheduled = false
    settleFrames = 0
  }

  private fun shouldRender(): Boolean =
    !disposed &&
      !renderingFailed &&
      surfaceReady &&
      isAttachedToWindow &&
      windowVisibility == View.VISIBLE &&
      modelViewer != null

  private fun renderFrame(frameTimeNanos: Long) {
    frameScheduled = false
    if (!shouldRender()) return
    val rendered = renderModelCatching(frameTimeNanos) ?: return
    // Filament can reject frames while its swap chain is coming up. Do not spend the settle budget
    // or report success until a frame was actually submitted to the renderer.
    if (rendered && settleFrames > 0) settleFrames -= 1
    if (needsAnotherFrame()) {
      // Budget from the frame timestamp; delaying from "now" would round past the next vsync and
      // drop the sustained rate to ~20fps on a 60Hz display.
      val renderedMillis = (System.nanoTime() - frameTimeNanos) / 1_000_000L
      requestFrame((TARGET_FRAME_INTERVAL_MS - renderedMillis).coerceAtLeast(0L))
    }
  }

  /** Renders one frame, or reports the failure and yields `null` so the loop stops. */
  private fun renderModelCatching(frameTimeNanos: Long): Boolean? =
    try {
      renderModel(frameTimeNanos)
    } catch (_: OutOfMemoryError) {
      reportRenderFailure(MEMORY_MESSAGE)
      null
    } catch (_: Exception) {
      reportRenderFailure("The 3D model could not be rendered.")
      null
    }

  private fun reportRenderFailure(message: String) = failLoad(loadGeneration, message)

  /** A still model parks after settling and wakes only when the scene changes again. */
  private fun needsAnotherFrame(): Boolean =
    modelViewer != null &&
      shouldContinueGlbFrames(
        settleFrames = settleFrames,
        loadEventPending = loadEventPending,
        hasPlayingAnimation = playingAnimator != null,
      )

  /** The animator of a loaded model that still has animation left in its first pass. */
  private val playingAnimator
    get() =
      modelViewer?.animator?.takeIf {
        it.animationCount > 0 && animationStartTimeNanos > 0L && !animationCompleted
      }

  /** Restarts the first animation; the loop parks again once it reaches the end. */
  private fun replayAnimation() {
    val animator = modelViewer?.animator ?: return
    if (animator.animationCount == 0 || loadEventPending) return
    animationStartTimeNanos = System.nanoTime()
    animationCompleted = false
    redraw()
  }

  private fun renderModel(frameTimeNanos: Long): Boolean {
    val viewer = modelViewer ?: return false
    playingAnimator?.let { animator ->
      val elapsedSeconds = (frameTimeNanos - animationStartTimeNanos) / 1_000_000_000f
      val animationFrame = glbAnimationFrame(animator.getAnimationDuration(0), elapsedSeconds)
      animator.applyAnimation(0, animationFrame.sampleSeconds)
      animationCompleted = animationFrame.completed
      animator.updateBoneMatrices()
    }
    val rendered = viewer.render(frameTimeNanos)
    if (rendered && loadEventPending && viewer.progress >= 0.999f) {
      loadEventPending = false
      cancelLoadTimeout()
      val hasAnimation = (viewer.animator?.animationCount ?: 0) > 0
      if (hasAnimation) animationStartTimeNanos = frameTimeNanos
      // Draw a few more frames so late texture uploads land before the loop parks.
      settleFrames = SETTLE_FRAMES
      onLoad(mapOf("hasAnimation" to hasAnimation))
    }
    return rendered
  }

  private fun userFacingMessage(error: Exception): String =
    if (error is GlbLoadException) {
      error.message.orEmpty()
    } else {
      "The 3D model could not be loaded."
    }

  private fun parseColor(value: String, fallback: Int): Int =
    try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      fallback
    }
}
