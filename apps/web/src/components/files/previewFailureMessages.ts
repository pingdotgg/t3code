import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { isModelPreviewError } from "@t3tools/client-runtime/model-preview/error";
import { isZipError } from "@t3tools/client-runtime/zip/error";
import { ZIP_ERROR_MESSAGES } from "@t3tools/client-runtime/zip/error-messages";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { isPreviewError, type PreviewFailure } from "./previewFailure";

const PREVIEW_FAILURE_MESSAGES = {
  ...ZIP_ERROR_MESSAGES,
  "file-load-failed": msg("The file could not be loaded. Close it and try again."),
  "file-unavailable": msg("The file is unavailable."),
  "document-unavailable": msg("This file is unavailable."),
  "document-unavailable-or-too-large": msg("This file is unavailable or too large to preview."),
  "document-too-large": msg("This file is too large to preview."),
  "preview-failed": msg("Could not preview this file."),
  "read-failed": msg("Could not read this file."),
  "parse-failed": msg("Could not parse this file."),
  "tar-numeric-format": msg("This TAR uses an unsupported numeric format."),
  "tar-header-damaged": msg("The TAR header is damaged."),
  "archive-entry-damaged": msg("An archive entry is too large or damaged."),
  "archive-metadata-too-large": msg("Archive metadata is too large."),
  "tar-metadata-damaged": msg("The TAR metadata is damaged."),
  "archive-empty": msg("This archive has no readable entries."),
  "archive-entry-unavailable": msg("This archive entry is unavailable."),
  "archive-entry-too-large": msg("Entry previews are limited to 10 MB."),
  "table-unavailable": msg("This table is unavailable."),
  "database-too-many-tables": msg("Database previews are limited to 100 tables."),
  "text-too-large": msg("Text previews support files up to 256 MB."),
  "text-binary": msg("This file contains binary data."),
  "text-line-too-long": msg("A line or record exceeds the 1 MB preview limit."),
  "text-too-many-rows": msg("Text previews support up to 5 million rows."),
  "text-download-incomplete": msg("The file download was incomplete. Close it and try again."),
  "text-copy-before-loaded": msg("Wait for the file to finish loading before copying."),
  "sheet-unavailable": msg("This sheet is unavailable."),
  "xml-invalid": msg("This document contains invalid or unsupported XML."),
  "xml-too-deep": msg("This document is nested too deeply to preview."),
  "xml-too-much-content": msg("This document has too much content to preview."),
  "rendered-too-large": msg("The rendered document is too large to preview."),
  "repeated-content-invalid": msg("This document contains invalid repeated content."),
  "odf-no-content": msg("This OpenDocument file has no readable content."),
  "ods-sheet-count": msg("This workbook has no sheets or too many sheets to preview."),
  "ods-cell-too-large": msg("A spreadsheet cell is too large to preview."),
  "ods-too-much-text": msg("This spreadsheet has too much text to preview."),
  "odf-page-count": msg("This document has no pages or too many pages to preview."),
  "epub-no-package": msg("This EPUB has no readable package."),
  "epub-chapter-count": msg("This EPUB has no chapters or too many chapters to preview."),
  "epub-no-chapters": msg("This EPUB has no readable XHTML chapters."),
  "notebook-cell-too-large": msg("A notebook cell is too large to preview."),
  "notebook-too-large": msg("Notebook preview limited to files under 8 MB."),
  "notebook-unsupported": msg("Preview supports version 4 notebooks with up to 500 cells."),
  "notebook-too-many-outputs": msg("A notebook cell has too many outputs to preview."),
  "rtf-too-large": msg("Rich text preview limited to files under 8 MB."),
  "rtf-invalid": msg("This is not a valid rich text document."),
  "rtf-too-many-pages": msg("Rich text preview limited to 500 pages."),
  "rtf-too-much-content": msg("This rich text document has too much content to preview."),
  "rtf-too-deep": msg("This rich text document is nested too deeply."),
  "rtf-damaged": msg("This rich text document is damaged."),
  "rtf-byte-escape": msg("Invalid rich text byte escape."),
  "rtf-binary-data": msg("Invalid rich text binary data."),
  "rtf-code-page": msg("This rich text code page is not supported."),
  "office-xml-declarations": msg("This document contains unsupported XML declarations."),
  "word-xml-nesting": msg("This Word document has excessive XML nesting."),
  "word-section-markup": msg("This Word document has too much section markup."),
  "word-limited-section-markup": msg(
    "Preview limited: this Word document has too much section markup.",
  ),
  "word-no-body": msg("This Word document has no readable body."),
  "word-limited-aliased-part": msg(
    "Preview limited: this Word document has an aliased document part.",
  ),
  "word-limited-relationship": msg(
    "Preview limited: this Word document has an unsupported document relationship.",
  ),
  "word-limited-xml-nesting": msg("Preview limited: this Word document has excessive XML nesting."),
  "word-limited-archive-paths": msg(
    "Preview limited: this Word document has unsupported archive paths.",
  ),
  "word-limited-auxiliary-markup": msg(
    "Preview limited: this Word document has too much auxiliary markup.",
  ),
  "word-limited-expanded-markup": msg(
    "Preview limited: this Word document has too much expanded markup.",
  ),
  "word-fonts-unprepared": msg("The document's fonts could not be prepared"),
  "word-no-pages": msg("The document produced no pages"),
  "workbook-cell-coordinates": msg("This workbook contains invalid cell coordinates."),
  "workbook-dimensions": msg("This workbook contains invalid worksheet dimensions."),
  "workbook-xml-nesting": msg("This workbook contains excessive XML nesting."),
  "workbook-structure": msg("This workbook contains invalid worksheet structure."),
  "workbook-row-coordinates": msg("This workbook contains invalid row coordinates."),
  "workbook-too-many-rows": msg("This workbook exceeds the preview limit: 250,000 rows."),
  "workbook-inconsistent-rows": msg("This workbook contains inconsistent cell rows."),
  "workbook-too-many-cells": msg(
    "This workbook exceeds the preview limit: 2 million cells or 8 million grid positions.",
  ),
  "workbook-cell-metadata": msg("This workbook contains invalid cell metadata."),
  "workbook-no-data": msg("This workbook has no worksheet data."),
  "workbook-duplicate-styles": msg("This workbook contains duplicate stylesheet blocks."),
  "workbook-number-formats": msg("This workbook has too many custom number formats."),
  "workbook-sheet-count": msg("This workbook has invalid or too many sheets."),
  "workbook-missing-sheet": msg("This workbook has a missing worksheet."),
  "office-too-large-expanded": msg("The expanded document is too large to preview safely."),
  "office-invalid": msg("This file is damaged, encrypted, or not a valid Office document."),
  "office-too-many-entries": msg("This file contains too many archive entries to preview."),
  "office-not-open-xml": msg(
    "This is not a valid Office Open XML file. Encrypted files are not supported.",
  ),
  "office-timeout": msg("This document took too long to preview. Open it in another app."),
  "office-engine-stopped": msg("The Office engine stopped"),
  "office-engine-unreadable": msg("The Office engine sent an unreadable reply"),
  "presentation-no-worker-fonts": msg("This browser has no fonts in workers"),
  "tiff-metadata-invalid": msg("Invalid TIFF metadata."),
  "tiff-metadata-truncated": msg("This TIFF has too much or truncated metadata."),
  "tiff-metadata-type": msg("Unsupported TIFF metadata type."),
  "tiff-metadata-pointer": msg("Invalid TIFF metadata pointer."),
  "image-too-large": msg("Image previews are limited to 32 megapixels and 16,384 pixels per side."),
  "image-metadata-too-large": msg("This image has too much metadata."),
  "heif-metadata-invalid": msg("Invalid HEIF metadata."),
  "heif-dimensions-invalid": msg("Invalid HEIF dimensions."),
  "heif-no-dimensions": msg("This HEIF image has no readable dimensions."),
  "tiff-strip-invalid-or-oversized": msg("Invalid or oversized TIFF strip."),
  "tiff-lzw-invalid": msg("Invalid TIFF LZW dictionary."),
  "tiff-strip-truncated": msg("Truncated TIFF strip."),
  "tiff-strip-layout": msg("Unsupported TIFF strip layout."),
  "tiff-strip-invalid": msg("Invalid TIFF strip."),
  "tiff-strip-oversized": msg("Oversized TIFF strip."),
  "tiff-compression": msg("This TIFF compression is not supported."),
  "tiff-data-too-large": msg("This TIFF has too much image data."),
  "tiff-no-image": msg("This TIFF has no readable image."),
  "tiff-orientation": msg("This TIFF orientation is not supported."),
  "tiff-color-format": msg("This TIFF color format is not supported."),
  "image-decoding-unavailable": msg("Image decoding is unavailable."),
  "image-decode-failed": msg("Could not decode this image."),
  "model-invalid": msg("This 3D model could not be read."),
  "model-webgl-unavailable": msg("3D previews need WebGL, which is unavailable in this window."),
} as const;

export type PreviewFailureCode = keyof typeof PREVIEW_FAILURE_MESSAGES;

export function previewFailureText(failure: PreviewFailure, resolve: MessageResolver = m): string {
  return failure.code ? resolve(PREVIEW_FAILURE_MESSAGES[failure.code]) : failure.message;
}

export function previewErrorText(cause: unknown, fallback: string): string {
  if (isPreviewError(cause) || isZipError(cause) || isModelPreviewError(cause)) {
    return m(PREVIEW_FAILURE_MESSAGES[cause.code]);
  }
  return errorDisplayMessage(cause, m) ?? fallback;
}
