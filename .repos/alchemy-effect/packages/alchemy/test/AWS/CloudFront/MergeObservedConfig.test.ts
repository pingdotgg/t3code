import { mergeWithObservedConfig } from "@/AWS/CloudFront/Distribution";
import type * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect, test } from "alchemy-test";

/**
 * A live distribution config as returned by `GetDistributionConfig` for a
 * distribution CloudFront has normalized — every member present, including
 * the ones `DistributionProps` cannot express (per-origin `CustomHeaders`,
 * per-behavior `TrustedSigners`, `GrpcConfig`, …). `UpdateDistribution`
 * rejects requests missing any of these with `IllegalUpdate`.
 */
const observed: cloudfront.DistributionConfig = {
  CallerReference: "caller-ref",
  Aliases: { Quantity: 0 },
  DefaultRootObject: "",
  Origins: {
    Quantity: 1,
    Items: [
      {
        Id: "s3",
        DomainName: "bucket.s3.us-east-1.amazonaws.com",
        OriginPath: "",
        CustomHeaders: { Quantity: 0 },
        S3OriginConfig: { OriginAccessIdentity: "", OriginReadTimeout: 30 },
        ConnectionAttempts: 3,
        ConnectionTimeout: 10,
        OriginShield: { Enabled: false },
        OriginAccessControlId: "OAC_OBSERVED",
      },
    ],
  },
  OriginGroups: { Quantity: 0 },
  DefaultCacheBehavior: {
    TargetOriginId: "s3",
    TrustedSigners: { Enabled: false, Quantity: 0 },
    TrustedKeyGroups: { Enabled: false, Quantity: 0 },
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: {
      Quantity: 2,
      Items: ["HEAD", "GET"],
      CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
    },
    SmoothStreaming: false,
    Compress: true,
    LambdaFunctionAssociations: { Quantity: 0 },
    FunctionAssociations: { Quantity: 0 },
    FieldLevelEncryptionId: "",
    CachePolicyId: "cache-policy-id",
    GrpcConfig: { Enabled: false },
  },
  CacheBehaviors: {
    Quantity: 1,
    Items: [
      {
        PathPattern: "*.webp",
        TargetOriginId: "s3",
        TrustedSigners: { Enabled: false, Quantity: 0 },
        TrustedKeyGroups: { Enabled: false, Quantity: 0 },
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {
          Quantity: 2,
          Items: ["HEAD", "GET"],
          CachedMethods: { Quantity: 2, Items: ["HEAD", "GET"] },
        },
        SmoothStreaming: false,
        Compress: true,
        LambdaFunctionAssociations: { Quantity: 0 },
        FunctionAssociations: { Quantity: 0 },
        FieldLevelEncryptionId: "",
        CachePolicyId: "cache-policy-id",
        GrpcConfig: { Enabled: false },
      },
    ],
  },
  CustomErrorResponses: { Quantity: 0 },
  Comment: "",
  Logging: { Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" },
  PriceClass: "PriceClass_100",
  Enabled: true,
  ViewerCertificate: {
    CloudFrontDefaultCertificate: true,
    SSLSupportMethod: "vip",
    MinimumProtocolVersion: "TLSv1",
  },
  Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
  WebACLId: "",
  HttpVersion: "http2",
  IsIPV6Enabled: false,
  ContinuousDeploymentPolicyId: "",
  Staging: false,
};

/**
 * The sparse config `toConfig` builds from props — only what the props
 * express, everything else `undefined` (i.e. omitted from the request).
 */
const desired: cloudfront.DistributionConfig = {
  CallerReference: "caller-ref",
  Aliases: { Quantity: 0, Items: [] },
  Origins: {
    Quantity: 1,
    Items: [
      {
        Id: "s3",
        DomainName: "bucket.s3.us-east-1.amazonaws.com",
        OriginAccessControlId: "OAC_DESIRED",
        S3OriginConfig: { OriginAccessIdentity: "" },
      },
    ],
  },
  DefaultCacheBehavior: {
    TargetOriginId: "s3",
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: {
      Quantity: 2,
      Items: ["GET", "HEAD"],
      CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
    },
    Compress: true,
    CachePolicyId: "cache-policy-id",
    FunctionAssociations: {
      Quantity: 1,
      Items: [
        {
          FunctionARN: "arn:aws:cloudfront::123:function/deny-all",
          EventType: "viewer-request",
        },
      ],
    },
  },
  CacheBehaviors: {
    Quantity: 1,
    Items: [
      {
        PathPattern: "*.webp",
        TargetOriginId: "s3",
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        Compress: true,
        CachePolicyId: "cache-policy-id",
      },
    ],
  },
  Comment: "",
  Enabled: false,
  Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
  IsIPV6Enabled: true,
} as cloudfront.DistributionConfig;

describe("mergeWithObservedConfig", () => {
  const merged = mergeWithObservedConfig(desired, observed);

  test("desired values win over observed ones", () => {
    expect(merged.Enabled).toBe(false);
    expect(merged.IsIPV6Enabled).toBe(true);
    expect(merged.Origins?.Items?.[0]?.OriginAccessControlId).toBe(
      "OAC_DESIRED",
    );
    expect(merged.DefaultCacheBehavior?.FunctionAssociations?.Quantity).toBe(1);
  });

  test("top-level members the desired config omits are filled from observed", () => {
    expect(merged.DefaultRootObject).toBe("");
    expect(merged.WebACLId).toBe("");
    expect(merged.ContinuousDeploymentPolicyId).toBe("");
    expect(merged.Staging).toBe(false);
    expect(merged.PriceClass).toBe("PriceClass_100");
    expect(merged.Logging).toEqual(observed.Logging);
    expect(merged.OriginGroups).toEqual({ Quantity: 0 });
    expect(merged.CustomErrorResponses).toEqual({ Quantity: 0 });
  });

  test("nested members inside origin items are filled by Id", () => {
    const origin = merged.Origins?.Items?.[0];
    expect(origin?.CustomHeaders).toEqual({ Quantity: 0 });
    expect(origin?.OriginPath).toBe("");
    expect(origin?.ConnectionAttempts).toBe(3);
    expect(origin?.ConnectionTimeout).toBe(10);
    expect(origin?.OriginShield).toEqual({ Enabled: false });
    expect(origin?.S3OriginConfig?.OriginReadTimeout).toBe(30);
  });

  test("nested members inside behaviors are filled (default + by PathPattern)", () => {
    for (const behavior of [
      merged.DefaultCacheBehavior,
      merged.CacheBehaviors?.Items?.[0],
    ]) {
      expect(behavior?.TrustedSigners).toEqual({ Enabled: false, Quantity: 0 });
      expect(behavior?.TrustedKeyGroups).toEqual({
        Enabled: false,
        Quantity: 0,
      });
      expect(behavior?.SmoothStreaming).toBe(false);
      expect(behavior?.FieldLevelEncryptionId).toBe("");
      expect(behavior?.GrpcConfig).toEqual({ Enabled: false });
      expect(behavior?.LambdaFunctionAssociations).toEqual({ Quantity: 0 });
    }
  });

  test("partial nested objects are completed member-wise, not replaced", () => {
    // Desired sets CloudFrontDefaultCertificate only; the observed
    // SSLSupportMethod / MinimumProtocolVersion carry over.
    const mergedWithCert = mergeWithObservedConfig(
      { ...desired, ViewerCertificate: { CloudFrontDefaultCertificate: true } },
      observed,
    );
    expect(mergedWithCert.ViewerCertificate).toEqual({
      CloudFrontDefaultCertificate: true,
      SSLSupportMethod: "vip",
      MinimumProtocolVersion: "TLSv1",
    });
  });

  test("desired arrays are never extended by observed items", () => {
    // Observed has one origin; a desired config that removes it must win.
    const withoutOrigins = mergeWithObservedConfig(
      {
        ...desired,
        Origins: { Quantity: 0, Items: [] },
      },
      observed,
    );
    expect(withoutOrigins.Origins).toEqual({ Quantity: 0, Items: [] });
  });

  test("a Quantity-only desired list never resurrects observed Items", () => {
    // Dropping a geo whitelist produces `{ RestrictionType: "none",
    // Quantity: 0 }` with no `Items`; filling `Items` from the observed
    // whitelist would desynchronize Quantity/Items and CloudFront rejects
    // the update with `InconsistentQuantities`.
    const withWhitelist = {
      ...observed,
      Restrictions: {
        GeoRestriction: {
          RestrictionType: "whitelist",
          Quantity: 2,
          Items: ["US", "GB"],
        },
      },
    } as cloudfront.DistributionConfig;
    const dropped = mergeWithObservedConfig(
      {
        ...desired,
        Restrictions: {
          GeoRestriction: { RestrictionType: "none", Quantity: 0 },
        },
      } as cloudfront.DistributionConfig,
      withWhitelist,
    );
    expect(dropped.Restrictions).toEqual({
      GeoRestriction: { RestrictionType: "none", Quantity: 0 },
    });
  });

  test("an origin absent from observed is passed through unchanged", () => {
    const withNewOrigin = mergeWithObservedConfig(
      {
        ...desired,
        Origins: {
          Quantity: 1,
          Items: [
            {
              Id: "brand-new",
              DomainName: "new.example.com",
            } as cloudfront.Origin,
          ],
        },
      },
      observed,
    );
    expect(withNewOrigin.Origins?.Items?.[0]).toEqual({
      Id: "brand-new",
      DomainName: "new.example.com",
    });
  });
});
