package expo.modules.t3reviewdiff

import android.app.Activity
import android.graphics.Color
import android.os.Looper
import expo.modules.kotlin.AppContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

internal object TokenDecodeProbe {
  val entries = AtomicInteger()
  val publications = AtomicInteger()

  @Volatile var onEntry: ((Int) -> Unit)? = null

  fun reset() {
    entries.set(0)
    publications.set(0)
    onEntry = null
  }

  fun enter() {
    val entry = entries.incrementAndGet()
    onEntry?.invoke(entry)
  }
  fun publish() {
    publications.incrementAndGet()
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@LooperMode(LooperMode.Mode.PAUSED)
class ReviewDiffTokenDecodeTest {
  @Test
  fun queuedFullReplacementSkipsOnlyObsoleteWorkAndPreservesPatchOrdering() {
    for (case in queuedCases()) {
      fixture { view, executor ->
        TokenDecodeProbe.reset()
        view.setContentResetKey("content")
        view.setTokensResetKey("tokens")
        view.setTokensJson(payload("seed"))
        drain(executor)
        TokenDecodeProbe.reset()
        val entered = CountDownLatch(1)
        val release = Semaphore(0)
        executor.execute {
          entered.countDown()
          release.acquire()
        }
        entered.await()
        val acknowledgements = mutableListOf<Boolean>()
        try {
          case.enqueue(view) { id, chunk ->
            view.setTokensPatchJson(patchPayload(id, chunk)) { acknowledgements.add(it) }
          }
        } finally {
          release.release()
        }
        drain(executor)
        assertEquals("${case.name} decoder entry", case.entries, TokenDecodeProbe.entries.get())
        // Android's malformed full payload publishes its existing empty-map fallback.
        assertEquals(
          "${case.name} retained full publication",
          case.entries,
          TokenDecodeProbe.publications.get()
        )
        assertEquals("${case.name} token output", expected(case.ids), tokens(view))
        assertEquals("${case.name} patch acknowledgements", case.acks, acknowledgements)
        println(
          "Passed tokens: ${case.name}, decoder entries=${case.entries}, " +
            "retained full publications=${case.entries}"
        )
      }
    }
  }

  private data class QueuedCase(
    val name: String,
    val ids: List<String> = listOf("b"),
    val entries: Int = 1,
    val acks: List<Boolean> = emptyList(),
    val enqueue: (T3ReviewDiffView, (String, Int) -> Unit) -> Unit
  )

  private fun queuedCases() = listOf(
    QueuedCase("A B C burst", ids = listOf("c")) { view, _ ->
      listOf("a", "b", "c").forEach { view.setTokensJson(payload(it)) }
    },
    QueuedCase("content reset", ids = emptyList(), entries = 0) { view, _ ->
      view.setTokensJson(payload("a"))
      view.setContentResetKey("new")
    },
    QueuedCase("reset then B") { view, _ ->
      view.setTokensJson(payload("a"))
      view.setContentResetKey("new")
      view.setTokensJson(payload("b"))
    },
    QueuedCase("same content key") { view, _ ->
      view.setTokensJson(payload("b"))
      view.setContentResetKey("content")
    },
    QueuedCase("token reset preserves full") { view, _ ->
      view.setTokensJson(payload("b"))
      view.setTokensResetKey("new")
    },
    QueuedCase("same token key") { view, _ ->
      view.setTokensJson(payload("b"))
      view.setTokensResetKey("tokens")
    },
    QueuedCase("current full") { view, _ -> view.setTokensJson(payload("b")) },
    QueuedCase("current malformed", ids = emptyList()) { view, _ ->
      view.setTokensJson("invalid JSON")
    },
    QueuedCase("obsolete malformed") { view, _ ->
      view.setTokensJson("invalid JSON")
      view.setTokensJson(payload("b"))
    },
    QueuedCase("full patch full", acks = listOf(true)) { view, patch ->
      view.setTokensJson(payload("a"))
      patch("patch", 0)
      view.setTokensJson(payload("b"))
    },
    QueuedCase(
      "full then patches",
      ids = listOf("b", "one", "two"),
      acks = listOf(true, true)
    ) { view, patch ->
      view.setTokensJson(payload("b"))
      patch("one", 0)
      patch("two", 1)
    },
    QueuedCase("patches then full", acks = listOf(true, true)) { view, patch ->
      patch("one", 0)
      patch("two", 1)
      view.setTokensJson(payload("b"))
    },
    QueuedCase(
      "additive patches",
      ids = listOf("seed", "one", "two"),
      entries = 0,
      acks = listOf(true, true)
    ) { _, patch ->
      patch("one", 0)
      patch("two", 1)
    },
    QueuedCase("reset rejects old patch", acks = listOf(false)) { view, patch ->
      patch("old", 0)
      view.setContentResetKey("new")
      view.setTokensJson(payload("b"))
    },
  )

  @Test
  fun enteredFullSuccessAndErrorFinishButOnlyTheReplacementPublishes() {
    for (invalid in listOf(false, true)) {
      fixture { view, executor ->
        TokenDecodeProbe.reset()
        val entered = CountDownLatch(1)
        val release = Semaphore(0)
        TokenDecodeProbe.onEntry = { entry ->
          if (entry == 1) {
            entered.countDown()
            release.acquire()
          }
        }
        view.setTokensJson(if (invalid) "invalid JSON" else payload("a"))
        entered.await()
        try {
          view.setContentResetKey("new")
          view.setTokensJson(payload("b"))
        } finally {
          release.release()
        }
        drain(executor)
        assertEquals(2, TokenDecodeProbe.entries.get())
        assertEquals(1, TokenDecodeProbe.publications.get())
        assertEquals(expected(listOf("b")), tokens(view))
        println(
          "Passed entered tokens invalid=$invalid, decoder entries=2, retained full publications=1"
        )
      }
    }
  }

  @Test
  fun cleanupDiscardsQueuedFullWorkOnTheProductionExecutor() {
    fixture { view, executor ->
      TokenDecodeProbe.reset()
      val entered = CountDownLatch(1)
      val worker = AtomicReference<Thread>()
      val release = Semaphore(0)
      executor.execute {
        worker.set(Thread.currentThread())
        entered.countDown()
        try {
          release.acquire()
        } catch (
          _: InterruptedException
        ) {
          Thread.currentThread().interrupt()
        }
      }
      entered.await()
      view.setTokensJson(payload("discarded"))
      view.cleanup()
      worker.get().join()
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(0, TokenDecodeProbe.entries.get())
      assertEquals(0, TokenDecodeProbe.publications.get())
      assertTrue(tokens(view).isEmpty())
      println("Passed cleanup before entry, decoder entries=0, retained full publications=0")
    }
  }

  @Test
  fun cleanupAfterEntryKeepsTheExistingCurrentFullPublication() {
    fixture { view, _ ->
      TokenDecodeProbe.reset()
      val entered = CountDownLatch(1)
      val release = Semaphore(0)
      val worker = AtomicReference<Thread>()
      TokenDecodeProbe.onEntry = {
        worker.set(Thread.currentThread())
        entered.countDown()
        // shutdownNow interrupts this worker; entered decoding must still finish.
        release.acquireUninterruptibly()
      }
      view.setTokensJson(payload("entered"))
      entered.await()
      try {
        view.cleanup()
      } finally {
        release.release()
      }
      worker.get().join()
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(1, TokenDecodeProbe.entries.get())
      assertEquals(1, TokenDecodeProbe.publications.get())
      assertEquals(expected(listOf("entered")), tokens(view))
      println("Passed cleanup after entry, decoder entries=1, retained full publications=1")
    }
  }

  private fun fixture(run: (T3ReviewDiffView, ExecutorService) -> Unit) {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val view = T3ReviewDiffView(controller.get(), AppContext())
    controller.get().setContentView(view)
    val executor = field(view, "payloadDecodeExecutor") as ExecutorService
    try {
      run(view, executor)
    } finally {
      view.cleanup()
      TokenDecodeProbe.reset()
      controller.pause().stop().destroy()
    }
  }

  private fun drain(executor: ExecutorService) {
    executor.submit {}.get()
    shadowOf(Looper.getMainLooper()).idle()
  }

  private fun field(target: Any, name: String): Any = target.javaClass.getDeclaredField(name)
    .apply { isAccessible = true }.get(target)

  private fun tokens(view: T3ReviewDiffView) = field(
    view.getChildAt(0),
    "tokensByRowId"
  ) as Map<*, *>

  private fun expected(ids: List<String>) = ids.associateWith {
    listOf(DiffToken("漢字 👨‍👩‍👧‍👦 é", Color.RED, 3), DiffToken("tail", null, 0))
  }

  private fun payload(id: String) =
    """{"$id":[{"content":"漢字 👨‍👩‍👧‍👦 é","color":"#ff0000","fontStyle":3},{"content":"tail","fontStyle":0}]}"""

  private fun patchPayload(id: String, chunk: Int) =
    """{"resetKey":"tokens","chunkIndex":$chunk,"tokensByRowId":${payload(id)}}"""
}
