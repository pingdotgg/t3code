import {
  scopeIdentity,
  usesInjectedCredentials,
} from "@/Neon/CredentialScope.ts";
import * as Neon from "@/Neon/index.ts";
import * as Output from "@/Output.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const branch = { projectId: "project", branchId: "branch" };
const host = {
  Type: "Neon.Function",
  Props: { branch },
  Mode: undefined,
};

test(
  "HTTP credentials use injection only for a known same-branch live Function",
  () => {
    expect(usesInjectedCredentials(host, { branch }, "live")).toBe(true);
    expect(
      usesInjectedCredentials(host, { branch: { ...branch } }, "live"),
    ).toBe(true);
    expect(
      usesInjectedCredentials(
        host,
        { branch: { ...branch, branchId: "other" } },
        "live",
      ),
    ).toBe(false);
    expect(
      usesInjectedCredentials(
        host,
        { branch: { ...branch, projectId: "other" } },
        "live",
      ),
    ).toBe(false);
    expect(usesInjectedCredentials(host, { branch }, "local")).toBe(false);
    expect(
      usesInjectedCredentials({ ...host, Mode: "live" }, { branch }, "local"),
    ).toBe(true);
    expect(
      usesInjectedCredentials({ ...host, Mode: "local" }, { branch }, "live"),
    ).toBe(false);
    for (const Type of ["Cloudflare.Worker", "AWS.Lambda.Function"]) {
      expect(
        usesInjectedCredentials({ ...host, Type }, { branch }, "live"),
      ).toBe(false);
    }
    expect(usesInjectedCredentials(undefined, { branch }, "live")).toBe(false);
  },
  { tags: ["unit", "provider:neon", "local"] },
);

test(
  "HTTP credentials preserve project scope and reject ambiguous unresolved identities",
  () => {
    const project = { projectId: "project" };
    expect(
      usesInjectedCredentials(
        { ...host, Props: { project } },
        { project: { ...project } },
        "live",
      ),
    ).toBe(true);
    expect(usesInjectedCredentials(host, { project }, "live")).toBe(false);
    const unresolved = {
      projectId: Output.literal("project"),
      branchId: Output.literal("branch"),
    };
    expect(scopeIdentity({ branch: unresolved })).toBeUndefined();
    expect(
      usesInjectedCredentials(
        { ...host, Props: { branch: unresolved } },
        { branch },
        "live",
      ),
    ).toBe(false);
    expect(
      usesInjectedCredentials(
        { ...host, Props: Effect.succeed({ branch }) },
        { branch },
        "live",
      ),
    ).toBe(false);
    expect(
      usesInjectedCredentials(
        { ...host, Props: undefined },
        { branch },
        "live",
      ),
    ).toBe(false);
    expect(
      usesInjectedCredentials(
        { ...host, Props: { branch: unresolved } },
        { branch: unresolved },
        "live",
      ),
    ).toBe(true);
  },
  { tags: ["unit", "provider:neon", "local"] },
);

test(
  "Neon exposes only HTTP implementation layers",
  () => {
    expect("ConnectDataApi" in Neon).toBe(false);
    expect("ConnectDataApiHttp" in Neon).toBe(false);
    expect("ConnectAIGateway" in Neon).toBe(false);
    expect("ConnectAIGatewayHttp" in Neon).toBe(false);
    for (const name of [
      "Connect",
      "ConnectAuth",
      "QueryDataApi",
      "QueryAIGateway",
      "ReadBucket",
      "WriteBucket",
      "ReadWriteBucket",
      "ReadObject",
      "WriteObject",
      "InvokeFunction",
      "CronEventSource",
      "BucketEventSource",
    ]) {
      expect(`${name}Binding` in Neon).toBe(false);
      expect(Layer.isLayer(Reflect.get(Neon, `${name}Http`))).toBe(true);
    }
  },
  { tags: ["unit", "provider:neon", "local"] },
);
