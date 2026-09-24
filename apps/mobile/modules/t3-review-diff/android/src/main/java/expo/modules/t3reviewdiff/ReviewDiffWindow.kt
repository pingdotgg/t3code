package expo.modules.t3reviewdiff

internal data class DiffSourceAnchor(val rowId: String, val source: Int, val offset: Int)

/** Maps the rendered viewport to source rows without depending on Android drawing or scrolling. */
internal class DiffSourceViewport(
  private val rows: List<DiffRow>,
  private val offsets: IntArray,
  private val rowHeight: Int
) {
  fun rowIndexAt(offset: Int): Int {
    val index = offsets.binarySearch(offset)
    return (if (index >= 0) index else -index - 2).coerceIn(0, rows.lastIndex.coerceAtLeast(0))
  }

  fun anchor(offset: Int): DiffSourceAnchor? {
    val first = rowIndexAt(offset)
    val row = rows.getOrNull(first)?.takeIf { it.kind != "file" && it.sourceRow != null }
    return row?.let {
      val within = (offset - offsets[first]).coerceAtLeast(0)
      val preceding = if (it.kind == "placeholder") within / rowHeight else 0
      DiffSourceAnchor(
        it.id,
        requireNotNull(it.sourceRow) + preceding,
        within - preceding * rowHeight
      )
    }
  }

  fun offset(anchor: DiffSourceAnchor): Int? {
    val exact = rows.indexOfFirst { row ->
      row.id == anchor.rowId && (
        row.kind != "placeholder" || row.sourceRow?.let { start ->
          anchor.source >= start && anchor.source < start + row.rowCount
        } == true
        )
    }
    val index = if (exact >= 0) {
      exact
    } else {
      rows.indexOfFirst { row ->
        row.kind != "file" && row.sourceRow?.let { start ->
          val count = if (row.kind == "placeholder") row.rowCount else 1
          anchor.source >= start && anchor.source < start + count
        } == true
      }
    }
    return index.takeIf { it >= 0 }?.let {
      val row = rows[it]
      val start = row.sourceRow ?: anchor.source
      val preceding = if (row.kind == "placeholder") anchor.source - start else 0
      offsets[it] + preceding * rowHeight + anchor.offset
    }
  }

  fun requestedRow(first: Int, last: Int, offset: Int): Int? {
    if (rows.isEmpty()) return null
    val visible = first..last.coerceAtMost(rows.lastIndex)
    val index = visible.firstOrNull { rows[it].kind == "placeholder" }
      ?: visible.firstOrNull { rows[it].kind != "file" && rows[it].sourceRow != null }
      ?: first
    val row = rows[index]
    return row.sourceRow?.let { source ->
      val preceding = if (row.kind == "placeholder") {
        ((offset - offsets[index]) / rowHeight).coerceIn(0, row.rowCount - 1)
      } else {
        0
      }
      source + preceding
    }
  }
}
