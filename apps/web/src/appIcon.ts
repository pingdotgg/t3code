import {
  DEFAULT_APP_ICON_ID,
  type AppIconId,
  type ClientSettings,
} from "@forma/contracts/settings";
import { APP_DEFAULT_ICON_ID, APP_STAGE_LABEL } from "./branding";

export interface AppIconOption {
  readonly id: AppIconId;
  readonly label: string;
  readonly previewSrc: string;
  readonly faviconHref: string;
  readonly appleTouchIconHref: string;
}

const customAppIconIds = [
  "forma-arc",
  "forma-fluted",
  "forma-foil",
  "forma-blueprint",
] as const satisfies ReadonlyArray<AppIconId>;

const DEFAULT_APP_ICON_OPTION: AppIconOption = {
  id: "default",
  label: `Default (${APP_STAGE_LABEL})`,
  previewSrc: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
  faviconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
  appleTouchIconHref: `/app-icons/${APP_DEFAULT_ICON_ID}.png`,
};

export const APP_ICON_OPTIONS: ReadonlyArray<AppIconOption> = [
  DEFAULT_APP_ICON_OPTION,
  ...customAppIconIds.map((id) => ({
    id,
    label: id.replace("forma-", "").replace(/^\w/, (value) => value.toUpperCase()),
    previewSrc: `/app-icons/${id}.png`,
    faviconHref: `/app-icons/${id}.png`,
    appleTouchIconHref: `/app-icons/${id}.png`,
  })),
];

const APP_ICON_OPTIONS_BY_ID = new Map(APP_ICON_OPTIONS.map((option) => [option.id, option]));

export function resolveAppIconOption(appIcon?: AppIconId | null): AppIconOption {
  return APP_ICON_OPTIONS_BY_ID.get(appIcon ?? DEFAULT_APP_ICON_ID) ?? DEFAULT_APP_ICON_OPTION;
}

function setOrCreateLink(
  targetDocument: Document,
  selector: string,
  attributes: Record<string, string>,
): void {
  const existing = targetDocument.head.querySelector<HTMLLinkElement>(selector);
  const link = existing ?? targetDocument.createElement("link");

  for (const [key, value] of Object.entries(attributes)) {
    link.setAttribute(key, value);
  }

  if (!existing) {
    targetDocument.head.appendChild(link);
  }
}

export function applyAppIconPreferenceToDocument(
  settings: Pick<ClientSettings, "appIcon">,
  targetDocument?: Document | null,
): void {
  const safeDocument = targetDocument ?? (typeof document !== "undefined" ? document : null);
  if (!safeDocument) {
    return;
  }

  const option = resolveAppIconOption(settings.appIcon);
  setOrCreateLink(safeDocument, 'link[rel="icon"]', {
    rel: "icon",
    href: option.faviconHref,
  });
  setOrCreateLink(safeDocument, 'link[rel="apple-touch-icon"]', {
    rel: "apple-touch-icon",
    href: option.appleTouchIconHref,
  });
  safeDocument.documentElement.dataset.appIcon = option.id;
}
