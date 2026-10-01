export interface DesktopConnectDiscovery {
  readonly accountId: string;
  readonly identity: string;
  readonly environments: readonly {
    readonly environmentId: string;
    readonly label: string;
  }[];
}

/** Native-only boundary. Neither the driver nor its authorized targets cross IPC. */
export interface DesktopConnectTarget {
  readonly httpBaseUrl: string;
  readonly nextSocketUrl: () => Promise<string>;
  readonly request: (path: string, request: Request) => Promise<Response>;
}

export interface ConnectAccountDriver {
  readonly login: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly discover: () => Promise<DesktopConnectDiscovery | null>;
  readonly connect: (accountId: string, environmentId: string) => Promise<DesktopConnectTarget>;
}
