// Cell keys stay below 2^30 so V8 keeps them as small integers in the Map.
const OFFSET = 16384;
const ROW = 32768;
const MAX_CELLS_PER_NODE = 1024;

/**
 * Uniform-grid spatial index over world AABBs keyed by dense node index.
 * Nodes that would cover more than `MAX_CELLS_PER_NODE` cells live in a
 * separate list that every query scans.
 */
export class SpatialGrid {
  private cellSize: number;
  private inv: number;
  private readonly cells = new Map<number, number[]>();
  private cellEntries = 0;
  private range = new Int32Array(0);
  private bigSlot = new Int32Array(0);
  private readonly big: number[] = [];
  private stamp = new Uint32Array(0);
  private stampValue = 0;
  results = new Int32Array(1024);

  constructor(cellSize = 256) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
  }

  get size() {
    return this.cellSize;
  }

  /** Clears the index and picks a new cell size. */
  reset(cellSize: number) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.cells.clear();
    this.cellEntries = 0;
    this.big.length = 0;
    this.range.fill(0);
    this.bigSlot.fill(-1);
  }

  /** Pre-sizes per-node storage for indices below `count`. */
  reserve(count: number) {
    if (count > 0) this.ensure(count - 1);
  }

  private ensure(index: number) {
    if (index < this.stamp.length) return;
    const size = Math.max(index + 1, this.stamp.length * 2, 256);
    const range = new Int32Array(size * 5);
    range.set(this.range);
    this.range = range;
    const bigSlot = new Int32Array(size).fill(-1);
    bigSlot.set(this.bigSlot);
    this.bigSlot = bigSlot;
    const stamp = new Uint32Array(size);
    stamp.set(this.stamp);
    this.stamp = stamp;
  }

  private cell(value: number) {
    return Math.min(OFFSET - 1, Math.max(-OFFSET, Math.floor(value * this.inv))) + OFFSET;
  }

  insert(index: number, minX: number, minY: number, maxX: number, maxY: number) {
    this.ensure(index);
    const x0 = this.cell(minX);
    const y0 = this.cell(minY);
    const x1 = this.cell(maxX);
    const y1 = this.cell(maxY);
    const base = index * 5;
    this.range[base] = 1;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_NODE) {
      this.range[base] = 2;
      this.bigSlot[index] = this.big.length;
      this.big.push(index);
      return;
    }
    this.range[base + 1] = x0;
    this.range[base + 2] = y0;
    this.range[base + 3] = x1;
    this.range[base + 4] = y1;
    this.cellEntries += (x1 - x0 + 1) * (y1 - y0 + 1);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx * ROW + cy;
        const list = this.cells.get(key);
        if (list) list.push(index);
        else this.cells.set(key, [index]);
      }
    }
  }

  remove(index: number) {
    if (index >= this.stamp.length) return;
    const base = index * 5;
    const kind = this.range[base];
    this.range[base] = 0;
    if (kind === 2) {
      const slot = this.bigSlot[index]!;
      const last = this.big.pop()!;
      if (last !== index) {
        this.big[slot] = last;
        this.bigSlot[last] = slot;
      }
      this.bigSlot[index] = -1;
      return;
    }
    if (kind !== 1) return;
    const x0 = this.range[base + 1]!;
    const y0 = this.range[base + 2]!;
    const x1 = this.range[base + 3]!;
    const y1 = this.range[base + 4]!;
    this.cellEntries -= (x1 - x0 + 1) * (y1 - y0 + 1);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cx * ROW + cy;
        const list = this.cells.get(key);
        if (!list) continue;
        const at = list.indexOf(index);
        if (at < 0) continue;
        list[at] = list[list.length - 1]!;
        list.pop();
        if (list.length === 0) this.cells.delete(key);
      }
    }
  }

  update(index: number, minX: number, minY: number, maxX: number, maxY: number) {
    if (index < this.stamp.length && this.range[index * 5] === 1) {
      const base = index * 5;
      if (
        this.range[base + 1] === this.cell(minX) &&
        this.range[base + 2] === this.cell(minY) &&
        this.range[base + 3] === this.cell(maxX) &&
        this.range[base + 4] === this.cell(maxY)
      ) {
        return;
      }
    }
    this.remove(index);
    this.insert(index, minX, minY, maxX, maxY);
  }

  private push(count: number, index: number) {
    if (count >= this.results.length) {
      const next = new Int32Array(this.results.length * 2);
      next.set(this.results);
      this.results = next;
    }
    this.results[count] = index;
  }

  private nextStamp() {
    this.stampValue = (this.stampValue + 1) >>> 0;
    if (this.stampValue === 0) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    return this.stampValue;
  }

  /** Writes candidate indices intersecting the rect into `results`, returns the count. */
  queryRect(minX: number, minY: number, maxX: number, maxY: number): number {
    const stampValue = this.nextStamp();
    const stamp = this.stamp;
    let count = 0;
    const x0 = this.cell(minX);
    const y0 = this.cell(minY);
    const x1 = this.cell(maxX);
    const y1 = this.cell(maxY);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size * 2) {
      // Dense nodes can occupy many cells. Scan each stored range once when
      // that costs less than visiting their repeated cell memberships.
      if (this.range.length / 5 <= this.cellEntries) {
        const range = this.range;
        for (let base = 0; base < range.length; base += 5) {
          if (
            range[base] !== 1 ||
            range[base + 1]! > x1 ||
            range[base + 2]! > y1 ||
            range[base + 3]! < x0 ||
            range[base + 4]! < y0
          )
            continue;
          this.push(count++, base / 5);
        }
      } else {
        for (const [key, list] of this.cells) {
          const cx = Math.floor(key / ROW);
          const cy = key % ROW;
          if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
          for (let k = 0; k < list.length; k++) {
            const index = list[k]!;
            if (stamp[index] === stampValue) continue;
            stamp[index] = stampValue;
            this.push(count++, index);
          }
        }
      }
    } else {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const list = this.cells.get(cx * ROW + cy);
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const index = list[k]!;
            if (stamp[index] === stampValue) continue;
            stamp[index] = stampValue;
            this.push(count++, index);
          }
        }
      }
    }
    for (let k = 0; k < this.big.length; k++) this.push(count++, this.big[k]!);
    return count;
  }

  queryPoint(x: number, y: number): number {
    let count = 0;
    const list = this.cells.get(this.cell(x) * ROW + this.cell(y));
    if (list) for (let k = 0; k < list.length; k++) this.push(count++, list[k]!);
    for (let k = 0; k < this.big.length; k++) this.push(count++, this.big[k]!);
    return count;
  }
}
