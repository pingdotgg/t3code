// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Local Cloudflare Stream simulator, adapted from Miniflare's stream plugin
 * workers (`workers-sdk/packages/miniflare/src/workers/stream/*`), collapsed
 * into a single worker hosting both halves:
 *
 * - `StreamBinding` (`binding.worker.ts` upstream) — the RPC entrypoint
 *   `stream` bindings target. Also serves stored video bytes at
 *   `/cdn-cgi/mf/stream/<id>/watch` via its `fetch` handler (routed to by the
 *   stream router middleware).
 * - `StreamObject` (`object.worker.ts` upstream) — a SQL-enabled Durable
 *   Object holding all video/caption/watermark/download metadata, with video
 *   and watermark bytes stored as blob files via the `stream:storage` disk
 *   service.
 *
 * This is a **local video store only** (mirroring upstream's fidelity
 * limits): no transcoding or HLS ladder — `hlsPlaybackUrl`/`dashPlaybackUrl`
 * point at a placeholder host — and no signed URLs (`generateToken` returns
 * a base64 JSON stub). `createDirectUpload` is unsupported, matching
 * upstream's exact error message.
 *
 * Upstream's `createTypedSql` statement/transaction helpers (`schemas.ts`,
 * `shared/sql.worker.ts`) are replaced with direct `state.storage.sql` calls
 * and `transactionSync`; upstream's per-call `getPublicUrl(loopback)`
 * (`shared/public-url.ts`) is preserved via this runtime's loopback server
 * (the plugin's node-side handler returns the latest entry URL).
 */
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { assert, BlobStore, Timers } from "../../internal/shared.worker.ts";
import {
  BINDING_STREAM_BLOBS,
  BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS,
  BINDING_STREAM_LOOPBACK,
  BINDING_STREAM_OBJECT,
  HEADER_STREAM_CONTROL_OP,
  PATH_STREAM_PUBLIC_URL,
  STREAM_OBJECT_NAME,
} from "./StreamOptions.shared.ts";

interface Env {
  [BINDING_STREAM_OBJECT]: DurableObjectNamespace<StreamObject>;
  [BINDING_STREAM_BLOBS]: Fetcher;
  [BINDING_STREAM_LOOPBACK]: Fetcher;
  [BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS]?: boolean;
}

// -----------------------------------------------------------------------------
// Errors (`workers/stream/errors.ts`)
// -----------------------------------------------------------------------------

export class StreamBindingError extends Error implements StreamError {
  constructor(
    message: string,
    readonly code: number,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "StreamBindingError";
  }
}

export class BadRequestError extends StreamBindingError {
  constructor(message = "Bad Request") {
    super(message, 10005, 400);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends StreamBindingError {
  constructor(message = "Not Found") {
    super(message, 10003, 404);
    this.name = "NotFoundError";
  }
}

export class InvalidURLError extends StreamBindingError {
  constructor(message = "Invalid URL") {
    super(message, 10010, 400);
    this.name = "InvalidURLError";
  }
}

// -----------------------------------------------------------------------------
// SQL schema and row types (`workers/stream/schemas.ts`)
// -----------------------------------------------------------------------------

const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS _mf_stream_videos (
  id                      TEXT PRIMARY KEY,
  creator                 TEXT,
  thumbnail               TEXT NOT NULL DEFAULT '',
  thumbnail_timestamp_pct REAL NOT NULL DEFAULT 0.0,
  ready_to_stream         INTEGER NOT NULL DEFAULT 1,
  ready_to_stream_at      TEXT,
  status_state            TEXT NOT NULL DEFAULT 'ready',
  status_pct_complete     TEXT,
  status_error_reason_code TEXT NOT NULL DEFAULT '',
  status_error_reason_text TEXT NOT NULL DEFAULT '',
  meta                    TEXT NOT NULL DEFAULT '{}',
  created                 TEXT NOT NULL,
  modified                TEXT NOT NULL,
  scheduled_deletion      TEXT,
  size                    INTEGER NOT NULL DEFAULT 0,
  allowed_origins         TEXT NOT NULL DEFAULT '[]',
  require_signed_urls     INTEGER,
  uploaded                TEXT,
  upload_expiry           TEXT,
  max_size_bytes          INTEGER,
  max_duration_seconds    INTEGER,
  duration                REAL NOT NULL DEFAULT -1.0,
  input_width             INTEGER NOT NULL DEFAULT 0,
  input_height            INTEGER NOT NULL DEFAULT 0,
  live_input_id           TEXT,
  clipped_from_id         TEXT,
  blob_id                 TEXT
);

CREATE TABLE IF NOT EXISTS _mf_stream_captions (
  video_id   TEXT NOT NULL,
  language   TEXT NOT NULL,
  generated  INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL DEFAULT '',
  status     TEXT,
  blob_id    TEXT,
  PRIMARY KEY (video_id, language),
  FOREIGN KEY (video_id) REFERENCES _mf_stream_videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS _mf_stream_watermarks (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  size            INTEGER NOT NULL DEFAULT 0,
  height          INTEGER NOT NULL DEFAULT 0,
  width           INTEGER NOT NULL DEFAULT 0,
  created         TEXT NOT NULL,
  downloaded_from TEXT,
  opacity         REAL NOT NULL DEFAULT 1.0,
  padding         REAL NOT NULL DEFAULT 0.05,
  scale           REAL NOT NULL DEFAULT 0.15,
  position        TEXT NOT NULL DEFAULT 'upperRight',
  blob_id         TEXT
);

CREATE TABLE IF NOT EXISTS _mf_stream_downloads (
  video_id         TEXT NOT NULL,
  download_type    TEXT NOT NULL DEFAULT 'default',
  status           TEXT NOT NULL DEFAULT 'ready',
  percent_complete REAL NOT NULL DEFAULT 100.0,
  url              TEXT,
  PRIMARY KEY (video_id, download_type),
  FOREIGN KEY (video_id) REFERENCES _mf_stream_videos(id) ON DELETE CASCADE
);
`;

export interface VideoRow extends Record<string, SqlStorageValue> {
  id: string;
  creator: string | null;
  thumbnail: string;
  thumbnail_timestamp_pct: number;
  ready_to_stream: number;
  ready_to_stream_at: string | null;
  status_state: string;
  status_pct_complete: string | null;
  status_error_reason_code: string;
  status_error_reason_text: string;
  meta: string;
  created: string;
  modified: string;
  scheduled_deletion: string | null;
  size: number;
  allowed_origins: string;
  require_signed_urls: number | null;
  uploaded: string | null;
  upload_expiry: string | null;
  max_size_bytes: number | null;
  max_duration_seconds: number | null;
  duration: number;
  input_width: number;
  input_height: number;
  live_input_id: string | null;
  clipped_from_id: string | null;
  blob_id: string | null;
}

export interface CaptionRow extends Record<string, SqlStorageValue> {
  video_id: string;
  language: string;
  generated: number;
  label: string;
  status: string | null;
  blob_id: string | null;
}

export interface WatermarkRow extends Record<string, SqlStorageValue> {
  id: string;
  name: string;
  size: number;
  height: number;
  width: number;
  created: string;
  downloaded_from: string | null;
  opacity: number;
  padding: number;
  scale: number;
  position: string;
  blob_id: string | null;
}

export interface DownloadRow extends Record<string, SqlStorageValue> {
  video_id: string;
  download_type: StreamDownloadType;
  status: string;
  percent_complete: number;
  url: string | null;
}

function rowToStreamVideo(row: VideoRow, entryUrl: URL): StreamVideo {
  const placeholderUrl = `https://customer-placeholder.cloudflarestream.com/${row.id}`;
  const videoUrl = `${entryUrl.origin}/cdn-cgi/mf/stream/${row.id}/watch`;
  return {
    id: row.id,
    creator: row.creator,
    thumbnail: row.thumbnail || `${placeholderUrl}/thumbnails/thumbnail.jpg`,
    thumbnailTimestampPct: row.thumbnail_timestamp_pct,
    readyToStream: row.ready_to_stream === 1,
    readyToStreamAt: row.ready_to_stream_at,
    status: {
      state: row.status_state,
      pctComplete: row.status_pct_complete ?? undefined,
      errorReasonCode: row.status_error_reason_code,
      errorReasonText: row.status_error_reason_text,
    },
    meta: JSON.parse(row.meta) as Record<string, string>,
    created: row.created,
    modified: row.modified,
    scheduledDeletion: row.scheduled_deletion,
    size: row.size,
    preview: videoUrl,
    allowedOrigins: JSON.parse(row.allowed_origins) as Array<string>,
    requireSignedURLs:
      row.require_signed_urls === null ? null : row.require_signed_urls === 1,
    uploaded: row.uploaded,
    uploadExpiry: row.upload_expiry,
    maxSizeBytes: row.max_size_bytes,
    maxDurationSeconds: row.max_duration_seconds,
    duration: row.duration,
    input: { width: row.input_width, height: row.input_height },
    hlsPlaybackUrl: `${placeholderUrl}/manifest/video.m3u8`,
    dashPlaybackUrl: `${placeholderUrl}/manifest/video.mpd`,
    watermark: null,
    liveInputId: row.live_input_id,
    clippedFromId: row.clipped_from_id,
    publicDetails: null,
  };
}

function rowToStreamCaption(row: CaptionRow): StreamCaption {
  return {
    language: row.language,
    label: row.label || row.language,
    generated: row.generated === 1,
    status: row.status as StreamCaption["status"],
  };
}

function rowToStreamWatermark(row: WatermarkRow): StreamWatermark {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    height: row.height,
    width: row.width,
    created: row.created,
    downloadedFrom: row.downloaded_from,
    opacity: row.opacity,
    padding: row.padding,
    scale: row.scale,
    position: row.position as StreamWatermarkPosition,
  };
}

function rowToStreamDownload(row: DownloadRow): {
  type: StreamDownloadType;
  download: StreamDownload;
} {
  return {
    type: row.download_type,
    download: {
      percentComplete: row.percent_complete,
      status: row.status as StreamDownloadStatus,
      url: row.url ?? undefined,
    },
  };
}

// -----------------------------------------------------------------------------
// Durable Object (`workers/stream/object.worker.ts`)
// -----------------------------------------------------------------------------

interface ControlOp {
  name: string;
  args?: Array<unknown>;
}

export class StreamObject extends DurableObject<Env> {
  readonly timers = new Timers();
  readonly #blob: BlobStore;
  readonly #sql: SqlStorage;

  #now() {
    return new Date(this.timers.now()).toISOString();
  }

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#sql = state.storage.sql;
    this.#sql.exec("PRAGMA foreign_keys = ON");
    this.#sql.exec(SQL_SCHEMA);
    this.#blob = new BlobStore(env[BINDING_STREAM_BLOBS], STREAM_OBJECT_NAME);
  }

  #getVideoRow(id: string): VideoRow | undefined {
    return this.#sql
      .exec<VideoRow>("SELECT * FROM _mf_stream_videos WHERE id = ?", id)
      .toArray()[0];
  }

  #getCaptionRow(videoId: string, language: string): CaptionRow | undefined {
    return this.#sql
      .exec<CaptionRow>(
        "SELECT * FROM _mf_stream_captions WHERE video_id = ? AND language = ?",
        videoId,
        language,
      )
      .toArray()[0];
  }

  #getWatermarkRow(id: string): WatermarkRow | undefined {
    return this.#sql
      .exec<WatermarkRow>(
        "SELECT * FROM _mf_stream_watermarks WHERE id = ?",
        id,
      )
      .toArray()[0];
  }

  #listDownloadRows(videoId: string): Array<DownloadRow> {
    return this.#sql
      .exec<DownloadRow>(
        "SELECT * FROM _mf_stream_downloads WHERE video_id = ?",
        videoId,
      )
      .toArray();
  }

  async createVideo(
    body: ReadableStream<Uint8Array> | null,
    params: StreamUrlUploadParams,
  ): Promise<VideoRow> {
    const id = crypto.randomUUID();
    const now = this.#now();

    let blobId: string | null = null;
    let size = 0;

    if (body !== null) {
      // Count bytes while streaming through to blob storage
      const { readable, writable } = new TransformStream<
        Uint8Array,
        Uint8Array
      >({
        transform(chunk, controller) {
          size += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      [blobId] = await Promise.all([
        this.#blob.put(readable),
        body.pipeTo(writable),
      ]);
    }

    this.#sql.exec(
      `INSERT INTO _mf_stream_videos (
        id, creator, meta, allowed_origins, require_signed_urls,
        scheduled_deletion, thumbnail_timestamp_pct, created, modified,
        uploaded, status_state, ready_to_stream, size, blob_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.creator ?? null,
      JSON.stringify(params.meta ?? {}),
      JSON.stringify(params.allowedOrigins ?? []),
      params.requireSignedURLs ? 1 : 0,
      params.scheduledDeletion ?? null,
      params.thumbnailTimestampPct ?? 0,
      now,
      now,
      body !== null ? now : null,
      body !== null ? "ready" : "pendingupload",
      body !== null ? 1 : 0,
      size,
      blobId,
    );

    const row = this.#getVideoRow(id);
    if (row === undefined) throw new NotFoundError(`Video not found: ${id}`);
    return row;
  }

  async getVideo(id: string): Promise<VideoRow> {
    const row = this.#getVideoRow(id);
    if (row === undefined) throw new NotFoundError(`Video not found: ${id}`);
    return row;
  }

  async updateVideo(
    id: string,
    params: StreamUpdateVideoParams,
  ): Promise<VideoRow> {
    return this.ctx.storage.transactionSync(() => {
      const current = this.#getVideoRow(id);
      if (current === undefined)
        throw new NotFoundError(`Video not found: ${id}`);

      this.#sql.exec(
        `UPDATE _mf_stream_videos SET
          modified = ?,
          creator = ?,
          meta = ?,
          allowed_origins = ?,
          require_signed_urls = ?,
          scheduled_deletion = ?,
          thumbnail_timestamp_pct = ?,
          max_duration_seconds = ?
        WHERE id = ?`,
        this.#now(),
        "creator" in params ? (params.creator ?? null) : current.creator,
        params.meta !== undefined ? JSON.stringify(params.meta) : current.meta,
        params.allowedOrigins !== undefined
          ? JSON.stringify(params.allowedOrigins)
          : current.allowed_origins,
        params.requireSignedURLs !== undefined
          ? params.requireSignedURLs
            ? 1
            : 0
          : current.require_signed_urls,
        "scheduledDeletion" in params
          ? (params.scheduledDeletion ?? null)
          : current.scheduled_deletion,
        params.thumbnailTimestampPct ?? current.thumbnail_timestamp_pct,
        params.maxDurationSeconds ?? current.max_duration_seconds,
        id,
      );

      const updated = this.#getVideoRow(id);
      if (updated === undefined)
        throw new NotFoundError(`Video not found: ${id}`);
      return updated;
    });
  }

  async deleteVideo(id: string): Promise<void> {
    const blobIds = this.ctx.storage.transactionSync(() => {
      // Collect caption blob_ids before CASCADE deletes rows
      const captionBlobs = this.#sql
        .exec<Pick<CaptionRow, "blob_id"> & Record<string, SqlStorageValue>>(
          "SELECT blob_id FROM _mf_stream_captions WHERE video_id = ?",
          id,
        )
        .toArray()
        .map((row) => row.blob_id)
        .filter((blobId): blobId is string => blobId !== null);

      this.#sql.exec("DELETE FROM _mf_stream_downloads WHERE video_id = ?", id);

      const videoRow = this.#sql
        .exec<Pick<VideoRow, "blob_id"> & Record<string, SqlStorageValue>>(
          "DELETE FROM _mf_stream_videos WHERE id = ? RETURNING blob_id",
          id,
        )
        .toArray()[0];
      if (videoRow === undefined)
        throw new NotFoundError(`Video not found: ${id}`);

      const blobIds = captionBlobs;
      if (videoRow.blob_id !== null) blobIds.push(videoRow.blob_id);
      return blobIds;
    });
    await Promise.all(blobIds.map((blobId) => this.#blob.delete(blobId)));
  }

  async listVideos(params?: StreamVideosListParams): Promise<Array<VideoRow>> {
    if (params?.before === undefined && params?.after === undefined) {
      if (params?.limit === undefined) {
        return this.#sql
          .exec<VideoRow>(
            "SELECT * FROM _mf_stream_videos ORDER BY created DESC",
          )
          .toArray();
      }
      return this.#sql
        .exec<VideoRow>(
          "SELECT * FROM _mf_stream_videos ORDER BY created DESC LIMIT ?",
          params.limit,
        )
        .toArray();
    }

    const compToSql: Record<string, string> = {
      eq: "=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };
    const conditions: Array<string> = [];
    const values: Array<string | number> = [];

    if (params.before !== undefined) {
      const op = compToSql[params.beforeComp ?? "lt"];
      if (op === undefined) {
        throw new BadRequestError(
          "Invalid comparison operator: " + String(params.beforeComp),
        );
      }
      conditions.push("created " + op + " ?");
      values.push(params.before);
    }
    if (params.after !== undefined) {
      const op = compToSql[params.afterComp ?? "gte"];
      if (op === undefined) {
        throw new BadRequestError(
          "Invalid comparison operator: " + String(params.afterComp),
        );
      }
      conditions.push("created " + op + " ?");
      values.push(params.after);
    }

    values.push(params.limit ?? 1000);
    const sql =
      "SELECT * FROM _mf_stream_videos WHERE " +
      conditions.join(" AND ") +
      " ORDER BY created DESC LIMIT ?";
    return this.#sql.exec<VideoRow>(sql, ...values).toArray();
  }

  async generateToken(id: string): Promise<string> {
    const row = this.#getVideoRow(id);
    if (row === undefined) throw new NotFoundError(`Video not found: ${id}`);

    const payload = {
      sub: id,
      kid: "local-mode-key",
      exp: Math.floor(this.timers.now() / 1000) + 6 * 60 * 60,
    };
    return btoa(JSON.stringify(payload));
  }

  async generateCaption(
    videoId: string,
    language: string,
  ): Promise<CaptionRow> {
    const video = this.#getVideoRow(videoId);
    if (video === undefined)
      throw new NotFoundError(`Video not found: ${videoId}`);

    const label =
      new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
      language;

    // Delete old blob if caption already exists
    const existing = this.#getCaptionRow(videoId, language);
    if (existing?.blob_id !== undefined && existing.blob_id !== null) {
      await this.#blob.delete(existing.blob_id);
    }

    this.#upsertCaption(videoId, language, 1, label, "ready", null);

    const row = this.#getCaptionRow(videoId, language);
    if (row === undefined)
      throw new NotFoundError(`Caption not found: ${videoId}/${language}`);
    return row;
  }

  async uploadCaption(
    videoId: string,
    language: string,
    input: ReadableStream,
  ): Promise<CaptionRow> {
    const video = this.#getVideoRow(videoId);
    if (video === undefined)
      throw new NotFoundError(`Video not found: ${videoId}`);

    const label =
      new Intl.DisplayNames(["en"], { type: "language" }).of(language) ??
      language;

    // Delete old blob if caption already exists
    const existing = this.#getCaptionRow(videoId, language);
    if (existing?.blob_id !== undefined && existing.blob_id !== null) {
      await this.#blob.delete(existing.blob_id);
    }

    const blobId = await this.#blob.put(input as ReadableStream<Uint8Array>);

    this.#upsertCaption(videoId, language, 0, label, "ready", blobId);

    const row = this.#getCaptionRow(videoId, language);
    if (row === undefined)
      throw new NotFoundError(`Caption not found: ${videoId}/${language}`);
    return row;
  }

  #upsertCaption(
    videoId: string,
    language: string,
    generated: number,
    label: string,
    status: string,
    blobId: string | null,
  ): void {
    this.#sql.exec(
      `INSERT INTO _mf_stream_captions (video_id, language, generated, label, status, blob_id)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (video_id, language) DO UPDATE SET
          generated = excluded.generated,
          label = excluded.label,
          status = excluded.status,
          blob_id = excluded.blob_id`,
      videoId,
      language,
      generated,
      label,
      status,
      blobId,
    );
  }

  async listCaptions(
    videoId: string,
    language?: string,
  ): Promise<Array<CaptionRow>> {
    const video = this.#getVideoRow(videoId);
    if (video === undefined)
      throw new NotFoundError(`Video not found: ${videoId}`);

    if (language !== undefined) {
      const row = this.#getCaptionRow(videoId, language);
      return row !== undefined ? [row] : [];
    }
    return this.#sql
      .exec<CaptionRow>(
        "SELECT * FROM _mf_stream_captions WHERE video_id = ?",
        videoId,
      )
      .toArray();
  }

  async deleteCaption(videoId: string, language: string): Promise<void> {
    const deleted = this.#sql
      .exec<Pick<CaptionRow, "blob_id"> & Record<string, SqlStorageValue>>(
        "DELETE FROM _mf_stream_captions WHERE video_id = ? AND language = ? RETURNING blob_id",
        videoId,
        language,
      )
      .toArray()[0];
    if (deleted === undefined) {
      throw new NotFoundError(`Caption not found: ${videoId}/${language}`);
    }
    if (deleted.blob_id !== null) {
      await this.#blob.delete(deleted.blob_id);
    }
  }

  async createWatermarkFromUrl(
    url: string,
    params: StreamWatermarkCreateParams,
  ): Promise<WatermarkRow> {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new InvalidURLError(
        `Failed to fetch watermark from URL: ${response.status} ${response.statusText}`,
      );
    }

    return this.createWatermarkFromBody(
      await response.arrayBuffer(),
      url,
      params,
    );
  }

  async createWatermarkFromBody(
    buffer: ArrayBuffer,
    downloadedFrom: string | null,
    params: StreamWatermarkCreateParams,
  ): Promise<WatermarkRow> {
    const size = buffer.byteLength;
    const blobId = await this.#blob.put(
      new Response(buffer).body as ReadableStream<Uint8Array>,
    );

    const id = crypto.randomUUID();
    const now = this.#now();

    this.#sql.exec(
      `INSERT INTO _mf_stream_watermarks
        (id, name, size, height, width, created, downloaded_from, opacity, padding, scale, position, blob_id)
        VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.name ?? "",
      size,
      now,
      downloadedFrom,
      params.opacity ?? 1.0,
      params.padding ?? 0.05,
      params.scale ?? 0.15,
      params.position ?? "upperRight",
      blobId,
    );

    const row = this.#getWatermarkRow(id);
    if (row === undefined)
      throw new NotFoundError(`Watermark not found: ${id}`);
    return row;
  }

  async getWatermark(id: string): Promise<WatermarkRow> {
    const row = this.#getWatermarkRow(id);
    if (row === undefined)
      throw new NotFoundError(`Watermark not found: ${id}`);
    return row;
  }

  async listWatermarks(): Promise<Array<WatermarkRow>> {
    return this.#sql
      .exec<WatermarkRow>(
        "SELECT * FROM _mf_stream_watermarks ORDER BY created DESC",
      )
      .toArray();
  }

  async deleteWatermark(id: string): Promise<void> {
    const deleted = this.#sql
      .exec<Pick<WatermarkRow, "blob_id"> & Record<string, SqlStorageValue>>(
        "DELETE FROM _mf_stream_watermarks WHERE id = ? RETURNING blob_id",
        id,
      )
      .toArray()[0];
    if (deleted === undefined)
      throw new NotFoundError(`Watermark not found: ${id}`);
    if (deleted.blob_id !== null) {
      await this.#blob.delete(deleted.blob_id);
    }
  }

  async generateDownload(
    videoId: string,
    downloadType: StreamDownloadType = "default",
  ): Promise<Array<DownloadRow>> {
    const video = this.#getVideoRow(videoId);
    if (video === undefined)
      throw new NotFoundError(`Video not found: ${videoId}`);

    this.#sql.exec(
      `INSERT INTO _mf_stream_downloads (video_id, download_type, status, percent_complete)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (video_id, download_type) DO UPDATE SET
          status = excluded.status,
          percent_complete = excluded.percent_complete`,
      videoId,
      downloadType,
      "ready",
      100.0,
    );

    return this.#listDownloadRows(videoId);
  }

  async listDownloads(videoId: string): Promise<Array<DownloadRow>> {
    const video = this.#getVideoRow(videoId);
    if (video === undefined)
      throw new NotFoundError(`Video not found: ${videoId}`);
    return this.#listDownloadRows(videoId);
  }

  async deleteDownload(
    videoId: string,
    downloadType: StreamDownloadType = "default",
  ): Promise<void> {
    const deleted = this.#sql
      .exec<Pick<DownloadRow, "video_id"> & Record<string, SqlStorageValue>>(
        "DELETE FROM _mf_stream_downloads WHERE video_id = ? AND download_type = ? RETURNING video_id",
        videoId,
        downloadType,
      )
      .toArray()[0];
    if (deleted === undefined) {
      throw new NotFoundError(`Download not found: ${videoId}/${downloadType}`);
    }
  }

  async getVideoBlob(
    videoId: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
    const row = this.#getVideoRow(videoId);
    if (row === undefined || row.blob_id === null) {
      return null;
    }
    const stream = await this.#blob.get(row.blob_id);
    if (stream === null) {
      return null;
    }
    return { stream, size: row.size };
  }

  /**
   * Control operations for tests (fake timers, storage inspection), sent via
   * a reserved header — the KV/R2 simulators' pattern, replacing upstream's
   * `req.cf.miniflare.controlOp` channel.
   */
  async fetch(req: Request): Promise<Response> {
    try {
      if (this.env[BINDING_STREAM_ENABLE_CONTROL_ENDPOINTS] === true) {
        const controlOpHeader = req.headers.get(HEADER_STREAM_CONTROL_OP);
        if (controlOpHeader !== null) {
          const controlOp = (await req.json()) as ControlOp;
          return await this.#handleControlOp(controlOp);
        }
      }
      return new Response(null, { status: 404 });
    } finally {
      // Make sure the request body is consumed. Otherwise, calls which make
      // requests to this object may hang and never resolve.
      // See https://github.com/cloudflare/workerd/issues/960.
      if (req.body !== null && !req.bodyUsed) {
        await req.body.pipeTo(new WritableStream());
      }
    }
  }

  async #handleControlOp({ name, args = [] }: ControlOp): Promise<Response> {
    if (name === "sqlQuery") {
      // Run an arbitrary SQL query (e.g. get the blob ID for a video)
      const [query, ...params] = args;
      assert(typeof query === "string");
      const results = this.#sql
        .exec(query, ...(params as Array<SqlStorageValue>))
        .toArray();
      return Response.json(results);
    } else if (name === "getBlob") {
      // Get an arbitrary blob
      const [id] = args;
      assert(typeof id === "string");
      const stream = await this.#blob.get(id);
      return new Response(stream, { status: stream === null ? 404 : 200 });
    } else {
      // Enable/disable fake timers, advance time, or wait for tasks
      const func: unknown = this.timers[name as keyof Timers];
      assert(typeof func === "function", `Unknown control op: ${name}`);
      const result = await (func as (...args: Array<unknown>) => unknown).apply(
        this.timers,
        args,
      );
      return Response.json(result ?? null);
    }
  }
}

// -----------------------------------------------------------------------------
// RPC entrypoint (`workers/stream/binding.worker.ts`)
// -----------------------------------------------------------------------------

// Fetches the public URL from the loopback server's stream route. This
// returns the runtime entry URL of the latest started worker with a stream
// binding. Using the loopback means the binding always sees the latest value,
// even across restarts (mirrors Miniflare's `getPublicUrl`).
async function getPublicUrl(loopback: Fetcher): Promise<URL> {
  const resp = await loopback.fetch(
    `http://localhost${PATH_STREAM_PUBLIC_URL}`,
  );
  const url = (await resp.json()) as string | null;
  if (!url) {
    throw new Error(
      "Runtime entry URL is not available. This may be because the worker is not yet ready to accept requests.",
    );
  }
  return new URL(url);
}

function getStub(env: Env): DurableObjectStub<StreamObject> {
  return env[BINDING_STREAM_OBJECT].getByName(STREAM_OBJECT_NAME);
}

function rowsToDownloadResponse(
  rows: Array<{ type: StreamDownloadType; download: StreamDownload }>,
): StreamDownloadGetResponse {
  const result: StreamDownloadGetResponse = {};
  for (const { type, download } of rows) {
    result[type] = download;
  }
  return result;
}

export class StreamBinding extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/cdn-cgi\/mf\/stream\/([^/]+)\/watch$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const videoId = match[1];
    const stub = getStub(this.env);

    // Get video blob from Durable Object
    const result = await stub.getVideoBlob(videoId);
    if (result === null) {
      return new Response("Video not found", { status: 404 });
    }

    return new Response(result.stream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": result.size.toString(),
      },
    });
  }

  async upload(
    urlOrBody: string | ReadableStream<Uint8Array>,
    params?: StreamUrlUploadParams,
  ): Promise<StreamVideo> {
    let body: ReadableStream<Uint8Array>;
    if (typeof urlOrBody === "string") {
      const response = await fetch(urlOrBody);
      if (!response.ok || response.body === null) {
        throw new InvalidURLError(
          `Failed to fetch video from URL: ${response.status} ${response.statusText}`,
        );
      }
      body = response.body;
    } else {
      body = urlOrBody;
    }
    const stub = getStub(this.env);
    const row = await stub.createVideo(body, params ?? {});
    const entryUrl = await getPublicUrl(this.env[BINDING_STREAM_LOOPBACK]);
    return rowToStreamVideo(row, entryUrl);
  }

  // Not supported in local mode yet
  async createDirectUpload(
    _params: StreamDirectUploadCreateParams,
  ): Promise<StreamDirectUpload> {
    throw new BadRequestError(
      "createDirectUpload is not supported in local mode",
    );
  }

  video(id: string): StreamVideoHandle {
    return new StreamVideoHandleImpl(this.env, id);
  }

  get videos(): StreamVideos {
    return new StreamVideosImpl(this.env);
  }

  get watermarks(): StreamWatermarks {
    return new StreamWatermarksImpl(this.env);
  }
}

class StreamScopedCaptionsImpl
  extends RpcTarget
  implements StreamScopedCaptions
{
  readonly #env: Env;
  readonly #videoId: string;

  constructor(env: Env, videoId: string) {
    super();
    this.#env = env;
    this.#videoId = videoId;
  }

  async upload(
    language: string,
    input: ReadableStream,
  ): Promise<StreamCaption> {
    const stub = getStub(this.#env);
    const row = await stub.uploadCaption(this.#videoId, language, input);
    return rowToStreamCaption(row);
  }

  async generate(language: string): Promise<StreamCaption> {
    const stub = getStub(this.#env);
    const row = await stub.generateCaption(this.#videoId, language);
    return rowToStreamCaption(row);
  }

  async list(language?: string): Promise<Array<StreamCaption>> {
    const stub = getStub(this.#env);
    const rows = await stub.listCaptions(this.#videoId, language);
    return rows.map(rowToStreamCaption);
  }

  async delete(language: string): Promise<void> {
    const stub = getStub(this.#env);
    await stub.deleteCaption(this.#videoId, language);
  }
}

class StreamScopedDownloadsImpl
  extends RpcTarget
  implements StreamScopedDownloads
{
  readonly #env: Env;
  readonly #videoId: string;

  constructor(env: Env, videoId: string) {
    super();
    this.#env = env;
    this.#videoId = videoId;
  }

  async generate(
    downloadType: StreamDownloadType = "default",
  ): Promise<StreamDownloadGetResponse> {
    const stub = getStub(this.#env);
    const rows = await stub.generateDownload(this.#videoId, downloadType);
    return rowsToDownloadResponse(rows.map(rowToStreamDownload));
  }

  async get(): Promise<StreamDownloadGetResponse> {
    const stub = getStub(this.#env);
    const rows = await stub.listDownloads(this.#videoId);
    return rowsToDownloadResponse(rows.map(rowToStreamDownload));
  }

  async delete(downloadType: StreamDownloadType = "default"): Promise<void> {
    const stub = getStub(this.#env);
    await stub.deleteDownload(this.#videoId, downloadType);
  }
}

class StreamVideoHandleImpl extends RpcTarget implements StreamVideoHandle {
  readonly id: string;
  readonly #env: Env;

  constructor(env: Env, id: string) {
    super();
    this.#env = env;
    this.id = id;
  }

  async details(): Promise<StreamVideo> {
    const stub = getStub(this.#env);
    const row = await stub.getVideo(this.id);
    const entryUrl = await getPublicUrl(this.#env[BINDING_STREAM_LOOPBACK]);
    return rowToStreamVideo(row, entryUrl);
  }

  async update(params: StreamUpdateVideoParams): Promise<StreamVideo> {
    const stub = getStub(this.#env);
    const row = await stub.updateVideo(this.id, params);
    const entryUrl = await getPublicUrl(this.#env[BINDING_STREAM_LOOPBACK]);
    return rowToStreamVideo(row, entryUrl);
  }

  async delete(): Promise<void> {
    const stub = getStub(this.#env);
    await stub.deleteVideo(this.id);
  }

  async generateToken(): Promise<string> {
    const stub = getStub(this.#env);
    return stub.generateToken(this.id);
  }

  get downloads(): StreamScopedDownloads {
    return new StreamScopedDownloadsImpl(this.#env, this.id);
  }

  get captions(): StreamScopedCaptions {
    return new StreamScopedCaptionsImpl(this.#env, this.id);
  }
}

class StreamVideosImpl extends RpcTarget implements StreamVideos {
  readonly #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async list(params?: StreamVideosListParams): Promise<Array<StreamVideo>> {
    const stub = getStub(this.#env);
    const rows = await stub.listVideos(params);
    const entryUrl = await getPublicUrl(this.#env[BINDING_STREAM_LOOPBACK]);
    return rows.map((row) => rowToStreamVideo(row, entryUrl));
  }
}

class StreamWatermarksImpl extends RpcTarget implements StreamWatermarks {
  readonly #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async generate(
    streamOrUrl: ReadableStream | string,
    params: StreamWatermarkCreateParams,
  ): Promise<StreamWatermark> {
    if (
      params.opacity !== undefined &&
      (params.opacity < 0 || params.opacity > 1)
    ) {
      throw new BadRequestError("opacity must be between 0.0 and 1.0");
    }
    if (
      params.padding !== undefined &&
      (params.padding < 0 || params.padding > 1)
    ) {
      throw new BadRequestError("padding must be between 0.0 and 1.0");
    }
    if (params.scale !== undefined && (params.scale < 0 || params.scale > 1)) {
      throw new BadRequestError("scale must be between 0.0 and 1.0");
    }
    const stub = getStub(this.#env);
    if (typeof streamOrUrl === "string") {
      const row = await stub.createWatermarkFromUrl(streamOrUrl, params);
      return rowToStreamWatermark(row);
    }
    // ReadableStream — pre-fetched data passed directly
    const buffer = await new Response(streamOrUrl).arrayBuffer();
    const row = await stub.createWatermarkFromBody(buffer, null, params);
    return rowToStreamWatermark(row);
  }

  async list(): Promise<Array<StreamWatermark>> {
    const stub = getStub(this.#env);
    const rows = await stub.listWatermarks();
    return rows.map(rowToStreamWatermark);
  }

  async get(watermarkId: string): Promise<StreamWatermark> {
    const stub = getStub(this.#env);
    const row = await stub.getWatermark(watermarkId);
    return rowToStreamWatermark(row);
  }

  async delete(watermarkId: string): Promise<void> {
    const stub = getStub(this.#env);
    await stub.deleteWatermark(watermarkId);
  }
}

/**
 * Default entrypoint: forwards requests to the `StreamObject` Durable Object.
 * Only used by tests to reach the control endpoints (fake timers, storage
 * inspection) through a raw service binding.
 */
export default {
  async fetch(request, env) {
    return getStub(env).fetch(
      request as unknown as Parameters<DurableObjectStub["fetch"]>[0],
    );
  },
} satisfies ExportedHandler<Env>;
