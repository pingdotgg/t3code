import * as elbv2 from "@distilled.cloud/aws/elastic-load-balancing-v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { LoadBalancer, LoadBalancerArn } from "./LoadBalancer.ts";
import type { TargetGroup, TargetGroupArn } from "./TargetGroup.ts";

export type ListenerArn =
  `arn:aws:elasticloadbalancing:${RegionID}:${AccountID}:listener/${string}`;

export interface ListenerProps {
  loadBalancerArn: Input<LoadBalancerArn> | LoadBalancer;
  targetGroupArn: Input<TargetGroupArn> | TargetGroup;
  port: number;
  protocol?: "HTTP" | "HTTPS" | "TCP";
  certificateArn?: string;
  sslPolicy?: string;
}

export interface Listener extends Resource<
  "AWS.ELBv2.Listener",
  ListenerProps,
  {
    listenerArn: ListenerArn;
    loadBalancerArn: LoadBalancerArn;
    targetGroupArn: TargetGroupArn;
    port: number;
    protocol: string;
  },
  never,
  Providers
> {}

export const Listener = Resource<Listener>("AWS.ELBv2.Listener");

export const ListenerProvider = () =>
  Provider.succeed(Listener, {
    stables: ["listenerArn", "loadBalancerArn"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return;
      if (olds.loadBalancerArn !== news.loadBalancerArn) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ output }) {
      if (!output) {
        return undefined;
      }
      const described = yield* elbv2
        .describeListeners({
          ListenerArns: [output.listenerArn],
        })
        .pipe(
          Effect.catchTag("ListenerNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      const listener = described?.Listeners?.[0];
      if (!listener?.ListenerArn) {
        return undefined;
      }
      const defaultForward = (listener.DefaultActions ?? []).find(
        (action) => action.Type === "forward",
      );
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: (defaultForward?.TargetGroupArn ??
          output.targetGroupArn) as TargetGroupArn,
        port: listener.Port!,
        protocol: listener.Protocol!,
      };
    }),
    reconcile: Effect.fn(function* ({ news, output, session }) {
      const loadBalancerArn = news.loadBalancerArn as LoadBalancerArn;
      const desiredTargetGroupArn = news.targetGroupArn as TargetGroupArn;
      const desiredProtocol = news.protocol ?? "HTTP";

      // Observe — describe the listener if we have a prior ARN; otherwise
      // list listeners on the load balancer and find one matching port.
      let listener: elbv2.Listener | undefined;
      if (output?.listenerArn) {
        const described = yield* elbv2
          .describeListeners({
            ListenerArns: [output.listenerArn],
          })
          .pipe(
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        listener = described?.Listeners?.[0];
      }
      if (!listener?.ListenerArn) {
        const listed = yield* elbv2
          .describeListeners({
            LoadBalancerArn: loadBalancerArn,
          })
          .pipe(
            Effect.catchTag("LoadBalancerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
            Effect.catchTag("ListenerNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        listener = listed?.Listeners?.find((l) => l.Port === news.port);
      }

      // Ensure — create if missing.
      if (!listener?.ListenerArn) {
        const created = yield* elbv2.createListener({
          LoadBalancerArn: loadBalancerArn,
          Port: news.port,
          Protocol: desiredProtocol,
          Certificates: news.certificateArn
            ? [{ CertificateArn: news.certificateArn }]
            : undefined,
          SslPolicy: news.sslPolicy,
          DefaultActions: [
            {
              Type: "forward",
              TargetGroupArn: desiredTargetGroupArn,
            },
          ],
        });
        listener = created.Listeners?.[0];
        if (!listener?.ListenerArn) {
          return yield* Effect.die(
            new Error("createListener returned no listener"),
          );
        }
        yield* session.note(listener.ListenerArn);
        return {
          listenerArn: listener.ListenerArn as ListenerArn,
          loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
          targetGroupArn: desiredTargetGroupArn,
          port: listener.Port!,
          protocol: listener.Protocol!,
        };
      }

      // Sync — apply mutable fields (port, protocol, certificates,
      // sslPolicy, defaultActions). modifyListener fully replaces these.
      const modified = yield* elbv2.modifyListener({
        ListenerArn: listener.ListenerArn,
        Port: news.port,
        Protocol: desiredProtocol,
        Certificates: news.certificateArn
          ? [{ CertificateArn: news.certificateArn }]
          : undefined,
        SslPolicy: news.sslPolicy,
        DefaultActions: [
          {
            Type: "forward",
            TargetGroupArn: desiredTargetGroupArn,
          },
        ],
      });
      const final = modified.Listeners?.[0] ?? listener;
      yield* session.note(listener.ListenerArn);
      return {
        listenerArn: listener.ListenerArn as ListenerArn,
        loadBalancerArn: listener.LoadBalancerArn as LoadBalancerArn,
        targetGroupArn: desiredTargetGroupArn,
        port: final.Port ?? news.port,
        protocol: final.Protocol ?? desiredProtocol,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* elbv2
        .deleteListener({
          ListenerArn: output.listenerArn,
        })
        .pipe(Effect.catchTag("ListenerNotFoundException", () => Effect.void));
    }),
  });
