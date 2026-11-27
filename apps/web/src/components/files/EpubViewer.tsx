import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { T, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState } from "react";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { observeResize } from "~/lib/observeResize";
import { externalUrl } from "./office/links";
import { useTheme } from "~/hooks/useTheme";
import { FileSurfaceAction, FileSurfaceLoading } from "./fileSurfaceChrome";
import type { EpubLocation, EpubPage, OfficeWorkerResult } from "./officePreviewProtocol";
import { epubSource, prepareEpubDocument } from "./epubSource";
import { previewFailureText } from "./previewFailureMessages";

type Book = Extract<OfficeWorkerResult, { type: "epub" }>;
type PageResponse = Extract<OfficeWorkerResult, { type: "epub-page" }>;

function goToAnchor(doc: Document, anchor: string | undefined) {
  if (anchor) (doc.getElementById(anchor) ?? doc.getElementsByName(anchor)[0])?.scrollIntoView();
  else doc.defaultView?.scrollTo(0, 0);
}

function ReadingFrame(props: {
  readonly page: EpubPage;
  readonly name: string;
  readonly location: EpubLocation;
  readonly zoom: number;
  readonly navigate: (location: EpubLocation) => void;
}) {
  const { resolvedTheme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const fixed = props.page.fixed;
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fit the authored viewport to its container as the preview resizes.
  useEffect(() => {
    const element = container.current;
    if (!element || !fixed) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    return observeResize(element, measure);
  }, [fixed]);
  const scale = fixed
    ? Math.min(size.width / fixed.width, size.height / fixed.height) * props.zoom
    : 1;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Change the sandboxed document's reading size without reloading or losing position.
  useEffect(() => {
    if (!fixed)
      frame.current?.contentDocument?.documentElement?.style.setProperty(
        "zoom",
        String(props.zoom),
        "important",
      );
  }, [fixed, props.zoom]);
  const anchor = props.location.anchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A table-of-contents entry can change the anchor within the current document.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (doc?.body) goToAnchor(doc, anchor);
  }, [anchor]);
  const darkPage = resolvedTheme === "dark" && !props.page.styles?.length && !fixed;
  const srcDoc = epubSource(props.page, darkPage);
  return (
    <div ref={container} className="min-h-0 flex-1 overflow-auto scrollbar-gutter-both">
      <div
        className={fixed ? "mx-auto" : "size-full"}
        style={
          fixed
            ? { width: fixed.width * scale, height: fixed.height * scale, overflow: "hidden" }
            : undefined
        }
      >
        <iframe
          ref={frame}
          title={props.name}
          srcDoc={srcDoc}
          sandbox="allow-same-origin"
          className={`block border-0 ${fixed ? "origin-top-left" : "size-full"} ${darkPage ? "" : "bg-white"}`}
          style={
            fixed
              ? { width: fixed.width, height: fixed.height, transform: `scale(${scale})` }
              : undefined
          }
          onLoad={(event) => {
            const doc = event.currentTarget.contentDocument;
            if (!doc?.body) return;
            prepareEpubDocument(doc);
            if (!fixed)
              doc.documentElement.style.setProperty("zoom", String(props.zoom), "important");
            goToAnchor(doc, props.location.anchor);
            doc.onclick = (click) => {
              const target = click.target;
              if (!(target instanceof doc.defaultView!.Element)) return;
              const link = target.closest("a[href]");
              if (!link) return;
              click.preventDefault();
              const href = link.getAttribute("data-epub-external");
              if (href !== null) {
                const url = externalUrl(href);
                if (url && click.isTrusted) window.open(url, "_blank", "noopener,noreferrer");
                return;
              }
              const linkIndex = link.getAttribute("data-epub-index");
              if (linkIndex === null) return;
              const index = Number(linkIndex);
              const anchor = link.getAttribute("data-epub-anchor") ?? undefined;
              if (index === props.location.index) goToAnchor(doc, anchor);
              props.navigate({ index, ...(anchor ? { anchor } : {}) });
            };
          }}
        />
      </div>
    </div>
  );
}

export default function EpubViewer(props: {
  readonly name: string;
  readonly book: Book;
  readonly response: PageResponse | null;
  readonly sizeBytes: number | undefined;
  readonly loadPage: (index: number) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [location, setLocation] = useState<EpubLocation>({ index: props.book.first });
  const [zoom, setZoom] = useState(1);
  const { index, anchor } = location;
  const loadPage = props.loadPage;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Request the selected section from the EPUB worker.
  useEffect(() => loadPage(index), [index, loadPage]);
  const result = props.response?.index === index ? props.response.result : undefined;
  const page = result && "html" in result ? result : undefined;
  const chapterLabel = (i: number) =>
    props.book.chapters[i]?.title ??
    (i === index ? page?.title : undefined) ??
    gt("Chapter {number}", { number: String(i + 1) });
  const named = new Set(props.book.contents.map((item) => item.index));
  const options: (EpubLocation & { title: string })[] = [
    ...props.book.contents,
    ...props.book.chapters.flatMap((_, i) =>
      named.has(i) ? [] : [{ index: i, title: chapterLabel(i) }],
    ),
  ].sort((a, b) => a.index - b.index);
  const selected = options.findIndex(
    (option) => option.index === index && option.anchor === anchor,
  );
  const previous = props.book.chapters.findLastIndex((chapter, i) => i < index && chapter.linear);
  const next = props.book.chapters.findIndex((chapter, i) => i > index && chapter.linear);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.book.chapters.length > 1 || props.book.contents.length > 1 ? (
        <div
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs"
          dir={props.book.rtl ? "rtl" : "ltr"}
        >
          <FileSurfaceAction
            label={gt("Previous chapter")}
            disabled={previous < 0}
            onPress={() => setLocation({ index: previous })}
          >
            {props.book.rtl ? (
              <ChevronRightIcon className="size-3.5" />
            ) : (
              <ChevronLeftIcon className="size-3.5" />
            )}
          </FileSurfaceAction>
          <div className="min-w-0 flex-1">
            <Select
              value={selected < 0 ? null : selected}
              onValueChange={(value) => {
                if (value !== null && options[value]) setLocation(options[value]);
              }}
            >
              <SelectTrigger
                aria-label={gt("Chapter", { $context: "noun, book chapter picker" })}
                size="xs"
              >
                <SelectValue>{options[selected]?.title ?? chapterLabel(index)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {options.map((option, i) => (
                  <SelectItem key={`${option.index}:${option.anchor ?? ""}`} value={i}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <FileSurfaceAction
            label={gt("Next chapter")}
            disabled={next < 0}
            onPress={() => setLocation({ index: next })}
          >
            {props.book.rtl ? (
              <ChevronLeftIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </FileSurfaceAction>
        </div>
      ) : null}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 tabular-nums" role="status">
          {gt("Chapter {page} of {count}", {
            page: String(index + 1),
            count: String(props.book.chapters.length),
          })}
          {props.sizeBytes ? ` · ${formatAttachmentSize(props.sizeBytes, messages)}` : ""}
        </span>
        <FileSurfaceAction
          label={gt("Decrease reading size")}
          disabled={zoom <= 0.5}
          onPress={() => setZoom(zoom - 0.25)}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <FileSurfaceAction
          label={gt("Increase reading size")}
          disabled={zoom >= 2}
          onPress={() => setZoom(zoom + 0.25)}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label={gt("Reset reading size")}
          disabled={zoom === 1}
          onPress={() => setZoom(1)}
        >
          <RotateCcwIcon className="size-3.5" />
        </FileSurfaceAction>
      </div>
      {page ? (
        <ReadingFrame
          key={index}
          page={page}
          name={`${props.name}: ${chapterLabel(index)}`}
          location={location}
          zoom={zoom}
          navigate={setLocation}
        />
      ) : result && "message" in result ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
        >
          <p className="text-sm font-medium">
            <T>No preview for this file</T>
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {previewFailureText(result, messages)}
          </p>
        </div>
      ) : (
        <FileSurfaceLoading />
      )}
    </div>
  );
}
