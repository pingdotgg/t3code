import type { ManagedPolicyDocument } from "@t3tools/contracts";
import {
  WINDOWS_POLICY_KEY,
  WINDOWS_POLICY_GROUPS,
  WINDOWS_POLICY_LISTS,
  WINDOWS_POLICY_VALUES,
} from "@t3tools/shared/managedPolicyFile";

import { knownDriverLabels } from "./managedProviders.ts";

type ValueName = keyof typeof WINDOWS_POLICY_VALUES;
type ListKey = keyof typeof WINDOWS_POLICY_LISTS;

type Element =
  | {
      readonly kind: "text";
      readonly name: ValueName;
      readonly label: string;
      readonly json?: true;
    }
  | {
      readonly kind: "enum";
      readonly name: ValueName;
      readonly label: string;
      readonly items: ReadonlyArray<{ readonly value: string; readonly label: string }>;
      readonly defaultItem: number;
    }
  | {
      readonly kind: "checkbox";
      readonly list?: ListKey;
      readonly name: string;
      readonly label: string;
      readonly defaultChecked: boolean;
    };

interface Policy {
  readonly id: string;
  readonly title: string;
  readonly help: string;
  /** A policy whose Enabled and Disabled states are themselves the value. */
  readonly toggle?: ValueName;
  readonly elements?: ReadonlyArray<Element>;
}

const RUNTIME_MODES = [
  { value: "approval-required", label: "Supervised" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "full-access", label: "Full access" },
];

const policies = (): ReadonlyArray<Policy> => [
  {
    id: "Organization",
    title: "Organization",
    help: 'Required whenever any other T3 Code policy is set: T3 Code will not start with policies that do not name an organization.\n\nUsers see the name as "Managed by <organization>" beside every control the policy locks. The support URL is optional.',
    elements: [
      { kind: "text", name: "Organization", label: "Organization name" },
      { kind: "text", name: "SupportUrl", label: "Support URL (optional)" },
    ],
  },
  {
    id: "MaxRuntimeMode",
    title: "Broadest permission mode",
    help: "The broadest permission mode any thread may use, including threads agents and scheduled tasks start.\n\nA thread already above it cannot run another turn until someone lowers its mode. Under this limit, each provider's launch settings (binary path, launch arguments, environment variables) come only from the policy.\n\nDisabled or Not Configured: no restriction.",
    elements: [
      {
        kind: "enum",
        name: "MaxRuntimeMode",
        label: "Broadest permission mode",
        items: RUNTIME_MODES,
        defaultItem: 1,
      },
    ],
  },
  {
    id: "Clients",
    title: "Allowed clients",
    help: "What may connect to T3 Code on this machine.\n\nWithout Remote, T3 Code only listens on this machine, does not create pairing links, signs out devices that paired earlier, and turns T3 Connect off. Check at least one client.\n\nDisabled or Not Configured: no restriction.",
    elements: [
      {
        kind: "checkbox",
        list: "Clients",
        name: "desktop",
        label: "Desktop app on this machine",
        defaultChecked: true,
      },
      {
        kind: "checkbox",
        list: "Clients",
        name: "local-browser",
        label: "A browser on this machine",
        defaultChecked: true,
      },
      {
        kind: "checkbox",
        list: "Clients",
        name: "remote",
        label: "Remote: phones, other computers, app.t3.codes",
        defaultChecked: false,
      },
    ],
  },
  {
    id: "Connect",
    title: "Allow T3 Connect",
    help: "Disabled turns T3 Connect off and unlinks this machine. Other remote access still follows Allowed clients.\n\nEnabled or Not Configured leaves T3 Connect available.",
    toggle: "Connect",
  },
  {
    id: "WebhookTasks",
    title: "Allow webhook tasks",
    help: "Disabled stops scheduled tasks from using webhook triggers. Existing webhook tasks are kept but do not run.",
    toggle: "WebhookTasks",
  },
  {
    id: "BrowserCookieImport",
    title: "Allow importing browser cookies",
    help: "Disabled stops users from importing cookies from another browser into T3 Code's browser.",
    toggle: "BrowserCookieImport",
  },
  {
    id: "Telemetry",
    title: "Allow usage data",
    help: "Disabled stops T3 Code from sending product usage data and relay connection traces. Enabled cannot turn them on for a user who turned them off.",
    toggle: "Telemetry",
  },
  {
    id: "AllowedDrivers",
    title: "Allowed providers",
    help: "Only the checked providers may run. Threads on other providers stay, marked unavailable.\n\nDisabled or Not Configured: no restriction.",
    elements: knownDriverLabels().map(({ driver, label }) => ({
      kind: "checkbox" as const,
      list: "AllowedDrivers" as const,
      name: driver,
      label,
      defaultChecked: driver === "codex" || driver === "claudeAgent",
    })),
  },
  {
    id: "Updates",
    title: "Updates",
    help: "Off stops T3 Code from checking for updates, for machines that receive T3 Code through device management.\n\nA feed URL makes the desktop app update from your own mirror of the release feed instead of GitHub; it must be https. Unchecking nightly makes the nightly channel unavailable.\n\nDisabled or Not Configured: no restriction.",
    elements: [
      {
        kind: "enum",
        name: "UpdatesMode",
        label: "Updates",
        items: [
          { value: "auto", label: "Automatic" },
          { value: "off", label: "Off" },
        ],
        defaultItem: 0,
      },
      { kind: "text", name: "UpdatesFeedUrl", label: "Feed URL (optional)" },
      {
        kind: "checkbox",
        name: "AllowNightly",
        label: "Allow the nightly channel",
        defaultChecked: true,
      },
    ],
  },
  {
    id: "Settings",
    title: "Managed settings (JSON)",
    help: 'Defaults and locks for server settings, as the "settings" object of a T3 Code policy. Each key is a setting path; each value is {"value": ..., "locked": true|false}.\n\nExample: {"enableAgentBrowserAccess": {"value": false, "locked": true}}\n\nRun "t3 policy check" on a policy file with the same object to validate it first.',
    elements: [{ kind: "text", name: "Settings", label: "Settings JSON", json: true }],
  },
  {
    id: "ProviderInstances",
    title: "Provider settings (JSON)",
    help: 'Fields set on every instance of a provider, as the "limits.providers.instances" object of a T3 Code policy: environment variables, binaryPath, launchArgs.\n\nExample: {"claudeAgent": {"locked": true, "environment": [{"name": "CLAUDE_CODE_USE_BEDROCK", "value": "1"}]}}\n\nEvery user on the machine can read this value, so do not put credentials in it.',
    elements: [
      { kind: "text", name: "ProviderInstances", label: "Provider settings JSON", json: true },
    ],
  },
];

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// ADMX keys are relative to the hive the policy class picks.
const ADMX_KEY = WINDOWS_POLICY_KEY.replace(/^HKLM\\/, "");
const elementId = (element: Element) =>
  element.kind === "checkbox" && element.list !== undefined
    ? `${element.list}_${element.name}`
    : element.name;

const admxElement = (element: Element) => {
  const id = elementId(element);
  switch (element.kind) {
    case "text":
      return `<text id="${id}" valueName="${element.name}"${
        element.name === "Organization" ? ' required="true"' : ""
      }${element.json ? ' maxLength="32767"' : ""} />`;
    case "enum":
      return [
        `<enum id="${id}" valueName="${element.name}" required="true">`,
        ...element.items.map(
          (item) =>
            `  <item displayName="$(string.${id}_${item.value})"><value><string>${item.value}</string></value></item>`,
        ),
        "</enum>",
      ].join("\n          ");
    case "checkbox":
      return `<boolean id="${id}"${
        element.list === undefined ? "" : ` key="${ADMX_KEY}\\${element.list}"`
      } valueName="${escapeXml(element.name)}"><trueValue><decimal value="1" /></trueValue><falseValue><decimal value="0" /></falseValue></boolean>`;
  }
};

/** The language-neutral Group Policy template. */
export function windowsAdmx(): string {
  const body = policies().map((policy) => {
    const head = `<policy name="${policy.id}" class="Machine" displayName="$(string.${policy.id})" explainText="$(string.${policy.id}_Help)" key="${ADMX_KEY}"`;
    const common = `<parentCategory ref="T3Code" />\n      <supportedOn ref="SUPPORTED_T3Code" />`;
    if (policy.toggle !== undefined) {
      return `    ${head} valueName="${policy.toggle}">
      ${common}
      <enabledValue><decimal value="1" /></enabledValue>
      <disabledValue><decimal value="0" /></disabledValue>
    </policy>`;
    }
    const grouped = Object.hasOwn(WINDOWS_POLICY_GROUPS, policy.id);
    return `    ${head}${grouped ? ` valueName="${policy.id}"` : ""} presentation="$(presentation.${policy.id})">
      ${common}${grouped ? '\n      <enabledValue><decimal value="1" /></enabledValue>\n      <disabledValue><decimal value="0" /></disabledValue>' : ""}
      <elements>
        ${(policy.elements ?? []).map(admxElement).join("\n        ")}
      </elements>
    </policy>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="t3code" namespace="T3Tools.Policies.T3Code" />
  </policyNamespaces>
  <resources minRequiredRevision="1.0" />
  <supportedOn>
    <definitions>
      <definition name="SUPPORTED_T3Code" displayName="$(string.SUPPORTED_T3Code)" />
    </definitions>
  </supportedOn>
  <categories>
    <category name="T3Code" displayName="$(string.T3Code)" />
  </categories>
  <policies>
${body.join("\n")}
  </policies>
</policyDefinitions>
`;
}

const presentationElement = (element: Element) => {
  const id = elementId(element);
  switch (element.kind) {
    case "text":
      return `<textBox refId="${id}"><label>${escapeXml(element.label)}</label></textBox>`;
    case "enum":
      return `<dropdownList refId="${id}" noSort="true" defaultItem="${element.defaultItem}">${escapeXml(element.label)}</dropdownList>`;
    case "checkbox":
      return `<checkBox refId="${id}" defaultChecked="${element.defaultChecked}">${escapeXml(element.label)}</checkBox>`;
  }
};

/** The en-US strings and dialog layouts for `windowsAdmx`. */
export function windowsAdml(): string {
  const strings: Array<readonly [string, string]> = [
    ["T3Code", "T3 Code"],
    ["SUPPORTED_T3Code", "T3 Code with managed policy support"],
  ];
  const presentations: Array<string> = [];
  for (const policy of policies()) {
    strings.push([policy.id, policy.title], [`${policy.id}_Help`, policy.help]);
    for (const element of policy.elements ?? []) {
      if (element.kind === "enum") {
        for (const item of element.items) {
          strings.push([`${elementId(element)}_${item.value}`, item.label]);
        }
      }
    }
    if (policy.elements !== undefined) {
      presentations.push(
        `      <presentation id="${policy.id}">\n        ${policy.elements.map(presentationElement).join("\n        ")}\n      </presentation>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="1.0" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>T3 Code</displayName>
  <description>Policies for T3 Code</description>
  <resources>
    <stringTable>
${strings.map(([id, text]) => `      <string id="${id}">${escapeXml(text)}</string>`).join("\n")}
    </stringTable>
    <presentationTable>
${presentations.join("\n")}
    </presentationTable>
  </resources>
</policyDefinitionResources>
`;
}

const plistValue = (value: unknown, indent: string): string => {
  const inner = `${indent}  `;
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value} />`;
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (Array.isArray(value)) {
    return `${indent}<array>\n${value.map((item) => plistValue(item, inner)).join("\n")}\n${indent}</array>`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `${indent}<dict>\n${entries
    .map(([key, item]) => `${inner}<key>${escapeXml(key)}</key>\n${plistValue(item, inner)}`)
    .join("\n")}\n${indent}</dict>`;
};

/** Where `value` holds a `null`, as path segments, or undefined when it holds none. */
const nullPath = (
  value: unknown,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  if (value === null) return path;
  if (typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const found = nullPath(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** A device configuration profile that installs `document` for `com.t3tools.t3code`. */
export function macosProfile(
  document: ManagedPolicyDocument,
  uuids: { readonly profile: string; readonly payload: string },
):
  | { readonly _tag: "Valid"; readonly profile: string }
  | { readonly _tag: "Invalid"; readonly reason: string } {
  // A plist has no null, and a setting may be locked empty.
  const empty = nullPath(document, []);
  if (empty !== undefined) {
    const setting =
      empty[0] === "settings" && empty.at(-1) === "value" ? empty.slice(0, -1) : empty;
    return {
      _tag: "Invalid",
      reason: `${setting.join(".")} is null, which a configuration profile cannot hold; deploy this policy as a file.`,
    };
  }
  const profile = {
    PayloadContent: [
      {
        PayloadDisplayName: "T3 Code policy",
        PayloadIdentifier: `com.t3tools.t3code.policy.${uuids.payload}`,
        PayloadType: "com.t3tools.t3code",
        PayloadUUID: uuids.payload,
        PayloadVersion: 1,
        ...document,
      },
    ],
    PayloadDescription: "Configures T3 Code for every user on this Mac.",
    PayloadDisplayName: `T3 Code policy for ${document.organization}`,
    PayloadIdentifier: `com.t3tools.t3code.policy`,
    PayloadOrganization: document.organization,
    PayloadScope: "System",
    PayloadType: "Configuration",
    PayloadUUID: uuids.profile,
    PayloadVersion: 1,
  };
  return {
    _tag: "Valid",
    profile: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(profile, "")}
</plist>
`,
  };
}
