import type { IamAction } from "@/AWS/IAM/actions.generated.ts";
import {
  normalizePolicyDocument,
  stringifyPolicyDocument,
  type PolicyDocument,
  type ServiceControlPolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import { describe, expect, it } from "alchemy-test";

const document: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "ReadObjects",
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:ListBucket"],
      Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
      Condition: {
        StringEquals: { "aws:PrincipalOrgID": "o-example" },
      },
    },
  ],
};

describe("stringifyPolicyDocument", () => {
  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(stringifyPolicyDocument(document))).toEqual(document);
  });
});

describe("normalizePolicyDocument", () => {
  it("makes two equivalent documents with different key order equal", () => {
    const reordered = {
      Statement: [
        {
          Condition: {
            StringEquals: { "aws:PrincipalOrgID": "o-example" },
          },
          Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
          Action: ["s3:GetObject", "s3:ListBucket"],
          Effect: "Allow",
          Sid: "ReadObjects",
        },
      ],
      Version: "2012-10-17",
    };
    expect(normalizePolicyDocument(reordered)).toBe(
      normalizePolicyDocument(document),
    );
  });

  it("treats a JSON string and the equivalent object identically", () => {
    const json = JSON.stringify(document, null, 2);
    expect(normalizePolicyDocument(json)).toBe(
      normalizePolicyDocument(document),
    );
  });

  it("handles the URL-encoded documents IAM returns", () => {
    const encoded = encodeURIComponent(JSON.stringify(document));
    expect(normalizePolicyDocument(encoded)).toBe(
      normalizePolicyDocument(document),
    );
  });

  it("is deterministic for the same document", () => {
    expect(normalizePolicyDocument(document)).toBe(
      normalizePolicyDocument(JSON.parse(stringifyPolicyDocument(document))),
    );
  });

  it("returns unparseable strings unchanged so drift diffs still fire", () => {
    expect(normalizePolicyDocument("not-json{")).toBe("not-json{");
  });

  it("treats singleton arrays and scalars as equivalent (AWS collapses them)", () => {
    // The IAM grammar accepts `"x"` wherever `["x"]` is legal, and several
    // services (e.g. Secrets Manager `GetResourcePolicy`) return the scalar
    // form for a stored singleton array — the two must canonicalize equal or
    // every re-deploy spuriously re-puts the policy.
    const arrays: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: ["arn:aws:iam::123456789012:root"] },
          Action: ["secretsmanager:GetSecretValue"],
          Resource: "*",
        },
      ],
    };
    const scalars = {
      Version: "2012-10-17",
      Statement: {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::123456789012:root" },
        Action: "secretsmanager:GetSecretValue",
        Resource: "*",
      },
    };
    expect(normalizePolicyDocument(arrays)).toBe(
      normalizePolicyDocument(scalars),
    );
    // Multi-element arrays are untouched (order still significant).
    expect(normalizePolicyDocument(document)).toContain(
      '"Action":["s3:GetObject","s3:ListBucket"]',
    );
  });
});

describe("IamAction", () => {
  it("accepts generated literals, wildcards, and arbitrary strings", () => {
    // Compile-time assertions: generated ops autocomplete, `service:*`
    // wildcards exist, and the `(string & {})` escape hatch never hard-breaks.
    const actions: IamAction[] = [
      "s3:GetObject",
      "iam:CreateRole",
      "states:StartExecution",
      "cloudwatch:PutMetricData",
      "dynamodb:*",
      "some-future-service:SomeUnknownAction",
    ];
    expect(actions).toHaveLength(6);

    // PolicyStatement.Action accepts both typed and plain-string arrays.
    const typed: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: "*" },
      ],
    };
    const plain: string[] = ["s3:GetObject"];
    const fromStrings: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: plain, Resource: "*" }],
    };
    expect(typed.Statement).toHaveLength(1);
    expect(fromStrings.Statement).toHaveLength(1);
  });
});

describe("ServiceControlPolicyDocument", () => {
  it("types the SCP-legal subset (no Principal) and normalizes like any doc", () => {
    const scp: ServiceControlPolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        { Sid: "AllowAll", Effect: "Allow", Action: ["*"], Resource: "*" },
        {
          Sid: "DenyLeaveOrg",
          Effect: "Deny",
          Action: ["organizations:LeaveOrganization"],
          Resource: "*",
          Condition: {
            StringNotEquals: { "aws:PrincipalOrgID": "o-example" },
          },
        },
      ],
    };
    const illegal: ServiceControlPolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Action: ["s3:*"],
          Resource: "*",
          // @ts-expect-error — SCP statements never carry a Principal
          Principal: { AWS: "*" },
        },
      ],
    };
    expect(illegal).toBeDefined();
    expect(normalizePolicyDocument(scp)).toBe(
      normalizePolicyDocument(JSON.parse(JSON.stringify(scp))),
    );
  });
});
