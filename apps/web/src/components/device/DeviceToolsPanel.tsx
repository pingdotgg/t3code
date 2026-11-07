import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { DevicePermission, DeviceSummary, DeviceTextSize } from "@t3tools/contracts";
import type { MessageKey, TranslateFn } from "@t3tools/client-runtime/i18n";
import { ChevronDown, X } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useT } from "~/hooks/useI18n";
import { cn } from "~/lib/utils";
import type { DeviceControls } from "./useDeviceControls";
import { deviceEventLogAtom } from "./deviceHubAtoms";

const TEXT_SIZES: ReadonlyArray<{ value: DeviceTextSize; labelKey: MessageKey }> = [
  { value: "small", labelKey: "misc.device.textSize.small" },
  { value: "default", labelKey: "misc.device.textSize.default" },
  { value: "large", labelKey: "misc.device.textSize.large" },
  { value: "extra-large", labelKey: "misc.device.textSize.extraLarge" },
];

const COLOR_FILTERS = [
  { value: "none", labelKey: "misc.device.colorFilter.none" },
  { value: "grayscale", labelKey: "misc.device.colorFilter.grayscale" },
  { value: "red-green", labelKey: "misc.device.colorFilter.redGreen" },
  { value: "green-red", labelKey: "misc.device.colorFilter.greenRed" },
  { value: "blue-yellow", labelKey: "misc.device.colorFilter.blueYellow" },
] as const;

const ORIENTATIONS = [
  { value: "portrait", labelKey: "misc.device.orientation.portrait" },
  { value: "landscape_left", labelKey: "misc.device.orientation.landscapeLeft" },
  { value: "portrait_upside_down", labelKey: "misc.device.orientation.portraitUpsideDown" },
  { value: "landscape_right", labelKey: "misc.device.orientation.landscapeRight" },
] as const;

const IOS_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; labelKey: MessageKey }> = [
  { value: "camera", labelKey: "misc.device.permission.camera" },
  { value: "microphone", labelKey: "misc.device.permission.microphone" },
  { value: "photos", labelKey: "misc.device.permission.photos" },
  { value: "contacts", labelKey: "misc.device.permission.contacts" },
  { value: "calendar", labelKey: "misc.device.permission.calendar" },
  { value: "reminders", labelKey: "misc.device.permission.reminders" },
  { value: "location", labelKey: "misc.device.permission.location" },
  { value: "notifications", labelKey: "misc.device.permission.notifications" },
  { value: "motion", labelKey: "misc.device.permission.motion" },
  { value: "media-library", labelKey: "misc.device.permission.mediaLibrary" },
  { value: "faceid", labelKey: "misc.device.permission.faceId" },
];

const ANDROID_PERMISSIONS: ReadonlyArray<{ value: DevicePermission; labelKey: MessageKey }> = [
  { value: "camera", labelKey: "misc.device.permission.camera" },
  { value: "microphone", labelKey: "misc.device.permission.microphone" },
  { value: "photos", labelKey: "misc.device.permission.photos" },
  { value: "contacts", labelKey: "misc.device.permission.contacts" },
  { value: "calendar", labelKey: "misc.device.permission.calendar" },
  { value: "location", labelKey: "misc.device.permission.location" },
  { value: "notifications", labelKey: "misc.device.permission.notifications" },
  { value: "motion", labelKey: "misc.device.permission.physicalActivity" },
];

const LOCATION_PRESETS = [
  { labelKey: "misc.device.preset.sanFrancisco", latitude: 37.7749, longitude: -122.4194 },
  { labelKey: "misc.device.preset.newYork", latitude: 40.7128, longitude: -74.006 },
  { labelKey: "misc.device.preset.london", latitude: 51.5074, longitude: -0.1278 },
  { labelKey: "misc.device.preset.stockholm", latitude: 59.3293, longitude: 18.0686 },
  { labelKey: "misc.device.preset.tokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

function translateOptions<V extends string>(
  options: ReadonlyArray<{ readonly value: V; readonly labelKey: MessageKey }>,
  t: TranslateFn,
): ReadonlyArray<{ readonly value: V; readonly label: string }> {
  return options.map((option) => ({ value: option.value, label: t(option.labelKey) }));
}

export function DeviceToolsPanel(props: {
  readonly controls: DeviceControls;
  readonly hostDiagnostics: string | undefined;
  readonly device: DeviceSummary;
  readonly access: DeviceHubAccess | null;
  readonly axOverlay: boolean;
  readonly onAxOverlayChange: (enabled: boolean) => void;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const { device, controls } = props;
  const t = useT();
  const { detail, pending, error, foregroundApp, disabled, act } = controls;
  const settings = detail?.settings;
  const isIos = device.platform === "ios";

  return (
    <div
      className={cn("flex min-h-0 flex-col border-border bg-background text-sm", props.className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-medium">{t("misc.device.title")}</span>
        {pending ? <Spinner size="sm" /> : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={t("misc.device.close")}
          className="ml-auto"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
        {detail === null && !error ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Spinner size="sm" /> {t("misc.device.readingSettings")}
          </div>
        ) : null}

        {props.hostDiagnostics ? (
          <Section title={t("misc.device.hostDiagnostics")}>
            <p className="whitespace-pre-line text-xs text-muted-foreground">
              {props.hostDiagnostics}
            </p>
          </Section>
        ) : null}

        <Section title={t("misc.device.app")}>
          <Row label={t("misc.device.foreground")}>
            <span className="truncate font-mono text-xs">{foregroundApp?.id ?? "-"}</span>
          </Row>
          {foregroundApp ? (
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "terminateApp", appId: foregroundApp.id })}
              >
                {t("misc.device.terminate")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => void act({ type: "launchApp", appId: foregroundApp.id })}
              >
                {t("misc.device.relaunch")}
              </Button>
            </div>
          ) : null}
          <SubmitRow
            placeholder={t("misc.device.openUrlPlaceholder")}
            action={t("misc.device.open")}
            disabled={disabled}
            onSubmit={(url) => act({ type: "openUrl", url })}
          />
          <SubmitRow
            placeholder={t(isIos ? "misc.device.bundleId" : "misc.device.packageName")}
            action={t("misc.device.launch")}
            disabled={disabled}
            onSubmit={(appId) => act({ type: "launchApp", appId })}
          />
        </Section>

        <Section title={t(isIos ? "misc.device.simulator" : "misc.device.emulator")}>
          <Row label={t("misc.device.appearance")}>
            <ToggleGroup
              aria-label={t("misc.device.appearance")}
              value={settings?.appearance ? [settings.appearance] : []}
              disabled={disabled}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "light" || next === "dark")
                  void act({ type: "setAppearance", value: next });
              }}
            >
              <Toggle value="light">{t("misc.device.light")}</Toggle>
              <Toggle value="dark">{t("misc.device.dark")}</Toggle>
            </ToggleGroup>
          </Row>
          <Row label={t("misc.device.textSize")}>
            <ChoiceSelect
              ariaLabel={t("misc.device.textSize")}
              value={settings?.textSize ?? null}
              options={translateOptions(TEXT_SIZES, t)}
              disabled={disabled}
              onChange={(value) => act({ type: "setTextSize", value })}
            />
          </Row>
          {isIos ? (
            <>
              <Row label={t("misc.device.liquidGlass")}>
                <ToggleGroup
                  aria-label={t("misc.device.liquidGlass")}
                  value={settings?.liquidGlass ? [settings.liquidGlass] : []}
                  disabled={disabled || settings?.liquidGlass === undefined}
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "clear" || next === "tinted") {
                      void act({ type: "setLiquidGlass", value: next });
                    }
                  }}
                >
                  <Toggle value="clear">{t("misc.device.liquidGlass.clear")}</Toggle>
                  <Toggle value="tinted">{t("misc.device.liquidGlass.tinted")}</Toggle>
                </ToggleGroup>
              </Row>
              <Row label={t("misc.device.colorFilter")}>
                <ChoiceSelect
                  ariaLabel={t("misc.device.colorFilter")}
                  value={settings?.colorFilter ?? null}
                  options={translateOptions(COLOR_FILTERS, t)}
                  disabled={disabled}
                  onChange={(value) => act({ type: "setColorFilter", value })}
                />
              </Row>
            </>
          ) : (
            <Row label={t("misc.device.orientation")}>
              <ChoiceSelect
                ariaLabel={t("misc.device.orientation")}
                value={null}
                placeholder={t("misc.device.rotateTo")}
                options={translateOptions(ORIENTATIONS, t)}
                disabled={disabled}
                onChange={(value) => act({ type: "setOrientation", value })}
              />
            </Row>
          )}
          <SwitchRow
            label={t("misc.device.reduceMotion")}
            checked={settings?.reduceMotion}
            disabled={disabled}
            onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })}
          />
          {isIos ? (
            <>
              <SwitchRow
                label={t("misc.device.increaseContrast")}
                checked={settings?.increaseContrast}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })}
              />
              <SwitchRow
                label={t("misc.device.reduceTransparency")}
                checked={settings?.reduceTransparency}
                disabled={disabled}
                onChange={(value) =>
                  act({ type: "setToggle", setting: "reduceTransparency", value })
                }
              />
              <SwitchRow
                label={t("misc.device.showBorders")}
                checked={settings?.showBorders}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })}
              />
              <SwitchRow
                label={t("misc.device.voiceOver")}
                checked={settings?.voiceOver}
                disabled={disabled}
                onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })}
              />
            </>
          ) : (
            <SwitchRow
              label={t("misc.device.network")}
              checked={settings?.networkEnabled}
              disabled={disabled}
              onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })}
            />
          )}
        </Section>

        <Section title={t("misc.device.accessibility")}>
          <SwitchRow
            label={t("misc.device.overlayFrames")}
            checked={props.axOverlay}
            disabled={props.access === null}
            onChange={(value) => {
              props.onAxOverlayChange(value);
              return Promise.resolve();
            }}
          />
        </Section>

        <LocationSection
          disabled={disabled}
          canClear={isIos}
          onSet={(latitude, longitude) => act({ type: "setLocation", latitude, longitude })}
          onClear={() => act({ type: "clearLocation" })}
        />

        <PermissionsSection
          permissions={isIos ? IOS_PERMISSIONS : ANDROID_PERMISSIONS}
          canReset={isIos}
          defaultAppId={foregroundApp?.id ?? ""}
          disabled={disabled}
          onDecide={(appId, permission, decision) =>
            act({ type: "setPermission", appId, permission, decision })
          }
        />

        {isIos ? (
          <Section title={t("misc.device.pushNotification")}>
            <SubmitRow
              placeholder={t("misc.device.alertText")}
              action={t("misc.device.send")}
              disabled={disabled || !foregroundApp}
              onSubmit={(payload) =>
                foregroundApp
                  ? act({ type: "sendPush", appId: foregroundApp.id, payload })
                  : Promise.resolve(false)
              }
            />
            {!foregroundApp ? (
              <p className="text-xs text-muted-foreground">{t("misc.device.openAppFirst")}</p>
            ) : null}
          </Section>
        ) : null}

        {isIos && props.access ? <EventLogSection access={props.access} device={device} /> : null}
      </div>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 items-center justify-end">{props.children}</div>
    </div>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly checked: boolean | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => Promise<unknown>;
}) {
  return (
    <Row label={props.label}>
      <Switch
        size="sm"
        aria-label={props.label}
        checked={props.checked ?? false}
        disabled={props.disabled || props.checked === undefined}
        onCheckedChange={(checked) => void props.onChange(checked)}
      />
    </Row>
  );
}

function ChoiceSelect<V extends string>(props: {
  readonly ariaLabel: string;
  readonly value: V | null;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: V) => Promise<unknown>;
}) {
  const current = props.options.find((option) => option.value === props.value);
  const t = useT();
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value !== null && value !== props.value) void props.onChange(value as V);
      }}
    >
      <SelectTrigger size="xs" className="w-40" aria-label={props.ariaLabel}>
        <SelectValue>
          {current ? (
            current.label
          ) : (
            <span className="text-muted-foreground">
              {props.placeholder ?? t("misc.device.unknown")}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SubmitRow(props: {
  readonly placeholder: string;
  readonly action: string;
  readonly disabled: boolean;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void props.onSubmit(trimmed).then((sent) => {
      if (sent) setValue("");
    });
  };
  return (
    <form
      className="flex gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        size="compact"
        font="mono"
        className="min-w-0 flex-1"
        placeholder={props.placeholder}
        value={value}
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
      />
      <Button
        type="submit"
        size="xs"
        variant="outline"
        disabled={props.disabled || value.trim().length === 0}
      >
        {props.action}
      </Button>
    </form>
  );
}

function LocationSection(props: {
  readonly disabled: boolean;
  readonly canClear: boolean;
  readonly onSet: (latitude: number, longitude: number) => Promise<unknown>;
  readonly onClear: () => Promise<unknown>;
}) {
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const t = useT();
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  const valid =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Math.abs(parsed.latitude) <= 90 &&
    Math.abs(parsed.longitude) <= 180;
  return (
    <Section title={t("misc.device.location")}>
      <div className="flex gap-1.5">
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t("misc.device.latitude")}
          inputMode="decimal"
          value={latitude}
          disabled={props.disabled}
          onChange={(event) => setLatitude(event.target.value)}
        />
        <Input
          size="compact"
          font="mono"
          className="min-w-0 flex-1"
          placeholder={t("misc.device.longitude")}
          inputMode="decimal"
          value={longitude}
          disabled={props.disabled}
          onChange={(event) => setLongitude(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select<string | null>
          value={null}
          disabled={props.disabled}
          onValueChange={(value) => {
            const preset = LOCATION_PRESETS.find((candidate) => candidate.labelKey === value);
            if (!preset) return;
            setLatitude(String(preset.latitude));
            setLongitude(String(preset.longitude));
            void props.onSet(preset.latitude, preset.longitude);
          }}
        >
          <SelectTrigger size="xs" className="w-32" aria-label={t("misc.device.locationPreset")}>
            <SelectValue>
              <span className="text-muted-foreground">{t("misc.device.preset")}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {LOCATION_PRESETS.map((preset) => (
              <SelectItem key={preset.labelKey} value={preset.labelKey}>
                {t(preset.labelKey)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !valid}
          onClick={() => void props.onSet(parsed.latitude, parsed.longitude)}
        >
          {t("misc.device.set")}
        </Button>
        {props.canClear ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled}
            onClick={() => {
              setLatitude("");
              setLongitude("");
              void props.onClear();
            }}
          >
            {t("misc.device.clear")}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function PermissionsSection(props: {
  readonly permissions: ReadonlyArray<{ value: DevicePermission; labelKey: MessageKey }>;
  readonly canReset: boolean;
  readonly defaultAppId: string;
  readonly disabled: boolean;
  readonly onDecide: (
    appId: string,
    permission: DevicePermission,
    decision: "grant" | "revoke" | "reset",
  ) => Promise<unknown>;
}) {
  const [appId, setAppId] = useState("");
  const [permission, setPermission] = useState<DevicePermission>("camera");
  const t = useT();
  const resolvedAppId = appId.trim() || props.defaultAppId;
  const decide = (decision: "grant" | "revoke" | "reset") =>
    void props.onDecide(resolvedAppId, permission, decision);
  return (
    <Section title={t("misc.device.permissions")}>
      <Input
        size="compact"
        font="mono"
        placeholder={props.defaultAppId || t("misc.device.appId")}
        value={appId}
        disabled={props.disabled}
        onChange={(event) => setAppId(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <ChoiceSelect
          ariaLabel={t("misc.device.permission")}
          value={permission}
          options={translateOptions(props.permissions, t)}
          disabled={props.disabled}
          onChange={(value) => {
            setPermission(value);
            return Promise.resolve();
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("grant")}
        >
          {t("misc.device.grant")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled || !resolvedAppId}
          onClick={() => decide("revoke")}
        >
          {t("misc.device.revoke")}
        </Button>
        {props.canReset ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.disabled || !resolvedAppId}
            onClick={() => decide("reset")}
          >
            {t("misc.device.reset")}
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function EventLogSection(props: {
  readonly access: DeviceHubAccess;
  readonly device: DeviceSummary;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 border-b px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">
        {t("misc.device.eventLog")}
        <ChevronDown
          className={cn("ml-auto size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <EventLogEntries access={props.access} device={props.device} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

// The panel unmounts while closed, so the log streams only while it is open.
function EventLogEntries(props: {
  readonly access: DeviceHubAccess;
  readonly device: DeviceSummary;
}) {
  const entries = useAtomValue(
    deviceEventLogAtom({
      access: props.access,
      platform: props.device.platform,
      deviceId: props.device.id,
    }),
  );
  const t = useT();
  return (
    <ol className="max-h-64 overflow-y-auto px-3 py-2 font-mono text-2xs leading-relaxed">
      {entries.length === 0 ? (
        <li className="text-muted-foreground">{t("misc.device.noEvents")}</li>
      ) : (
        entries.map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground">{entry.timestamp.slice(11, 19)}</span>
            <span className="truncate">{entry.summary}</span>
          </li>
        ))
      )}
    </ol>
  );
}
