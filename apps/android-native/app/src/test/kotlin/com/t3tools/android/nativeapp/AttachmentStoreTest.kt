package com.t3tools.android.nativeapp

import java.io.ByteArrayInputStream
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class AttachmentStoreTest {
  @Test
  fun copies_an_image_at_the_size_limit() {
    val directory = createTempDirectory("attachment-store").toFile()
    try {
      val target = directory.resolve("image.tmp")

      val copied = copyOwnedAttachment(ByteArrayInputStream(byteArrayOf(1, 2, 3)), target, 3)

      assertEquals(3, copied)
      assertEquals(listOf<Byte>(1, 2, 3), target.readBytes().toList())
    } finally {
      directory.deleteRecursively()
    }
  }

  @Test
  fun rejects_invalid_images_without_leaving_a_partial_file() {
    listOf(byteArrayOf() to 3L, byteArrayOf(1, 2, 3, 4) to 3L).forEachIndexed { index, (bytes, limit) ->
      val directory = createTempDirectory("attachment-store-$index").toFile()
      try {
        val target = directory.resolve("image.tmp")

        assertThrows(IllegalArgumentException::class.java) {
          copyOwnedAttachment(ByteArrayInputStream(bytes), target, limit)
        }
        assertFalse(target.exists())
      } finally {
        directory.deleteRecursively()
      }
    }
  }
}
