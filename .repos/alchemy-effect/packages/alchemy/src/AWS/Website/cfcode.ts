// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * CloudFront Function injection code ported from SST's Router component.
 * These are JavaScript code strings that get injected into CloudFront Function handlers.
 */

/**
 * Host-based 301 handling injected at the very top of a generated
 * viewer-request handler (before route matching). Redirects requests whose
 * `Host` is one of the configured redirect hostnames — and, when
 * `cloudfrontUrl: false`, requests arriving via the distribution's default
 * `*.cloudfront.net` domain (the default domain is not knowable inside its
 * own function config before the distribution exists, but only requests
 * served via the default domain ever carry a `.cloudfront.net` Host;
 * alternate domain names never do) — to the canonical hostname with path
 * and query preserved.
 *
 * Relies on `buildHostRedirectResponse` declared by
 * {@link CF_ROUTER_INJECTION} (function declarations hoist within the
 * handler). Returns an empty string when there is nothing to redirect.
 */
export const buildHostRedirectInjection = ({
  to,
  hosts,
  cloudfrontDefault,
}: {
  /** Canonical hostname redirected to. */
  to: string | undefined;
  /** Exact redirect hostnames. */
  hosts: string[];
  /** Also redirect the distribution's default `*.cloudfront.net` domain. */
  cloudfrontDefault: boolean;
}): string => {
  if (!to || (hosts.length === 0 && !cloudfrontDefault)) return "";
  const conditions = [
    ...(hosts.length > 0
      ? [`${JSON.stringify(hosts)}.indexOf(redirectHost) !== -1`]
      : []),
    ...(cloudfrontDefault ? [`redirectHost.endsWith(".cloudfront.net")`] : []),
  ];
  return `
  var redirectHost = event.request.headers.host.value;
  if (${conditions.join(" || ")}) {
    return buildHostRedirectResponse(${JSON.stringify(to)});
  }`;
};

const CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT = 10240 - 512;

export const CF_ROUTER_INJECTION = `
async function routeSite(kvNamespace, metadata) {
  if (metadata.redirect && metadata.redirect.hosts.indexOf(event.request.headers.host.value) !== -1) {
    return buildHostRedirectResponse(metadata.redirect.to);
  }

  var baselessUri = metadata.base
    ? event.request.uri.replace(metadata.base, "")
    : event.request.uri;

  try {
    var u = decodeURIComponent(baselessUri);
    var postfixes = u.endsWith("/")
      ? ["index.html"]
      : ["", ".html", "/index.html"];
    var v = await Promise.any(postfixes.map(function(p) { return cf.kvs().get(kvNamespace + ":" + u + p).then(function() { return p; }); }));
    event.request.uri = metadata.s3.dir + event.request.uri + v;
    setS3Origin(metadata.s3.domain);
    return;
  } catch (e) {}

  if (metadata.s3 && metadata.s3.routes) {
    for (var i=0, l=metadata.s3.routes.length; i<l; i++) {
      var route = metadata.s3.routes[i];
      if (baselessUri.startsWith(route)) {
        event.request.uri = metadata.s3.dir + event.request.uri;
        if (event.request.uri.endsWith("/")) {
          event.request.uri += "index.html";
        } else if (!event.request.uri.split("/").pop().includes(".")) {
          event.request.uri += "/index.html";
        }
        setS3Origin(metadata.s3.domain);
        return;
      }
    }
  }

  if (metadata.custom404 && !metadata.errorResponseCode) {
    event.request.uri = metadata.s3.dir + (metadata.base ? metadata.base : "") + metadata.custom404;
    setS3Origin(metadata.s3.domain);
    return;
  }

  if (metadata.s3 && !metadata.servers) {
    event.request.uri = metadata.s3.dir + event.request.uri;
    setS3Origin(metadata.s3.domain);
    return;
  }

  if (metadata.image && baselessUri.startsWith(metadata.image.route)) {
    setForwardedHost();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(metadata.image.host, metadata.image.originAccessControlConfig ? { originAccessControlConfig: metadata.image.originAccessControlConfig } : undefined);
    return;
  }

  if (metadata.servers) {
    setForwardedHost();
    for (var key in event.request.querystring) {
      if (key.includes("/")) {
        event.request.querystring[encodeURIComponent(key)] = event.request.querystring[key];
        delete event.request.querystring[key];
      }
    }
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(findNearestServer(metadata.servers), metadata.origin);
  }

  function findNearestServer(servers) {
    if (servers.length === 1) return servers[0][0];
    var h = event.request.headers;
    var lat = h["cloudfront-viewer-latitude"] && h["cloudfront-viewer-latitude"].value;
    var lon = h["cloudfront-viewer-longitude"] && h["cloudfront-viewer-longitude"].value;
    if (!lat || !lon) return servers[0][0];
    return servers.map(function(s) { return { distance: haversineDistance(lat, lon, s[1], s[2]), host: s[0] }; }).sort(function(a,b) { return a.distance - b.distance; })[0].host;
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    var toRad = function(a) { return a * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function isRequestHeaderTooLarge() {
    return getRequestHeaderSize() > ${CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT};
  }

  function buildOversizedHeadersResponse() {
    return {
      statusCode: 431,
      statusDescription: "Request Header Fields Too Large",
      headers: { "cache-control": { value: "no-store" }, "content-type": { value: "text/plain; charset=utf-8" } },
      body: { encoding: "text", data: "Request headers are too large. Reduce cookie size and try again." },
    };
  }

  function getRequestHeaderSize() {
    var size = 0;
    for (var key in event.request.headers) {
      var header = event.request.headers[key];
      if (header.multiValue) {
        for (var i=0; i<header.multiValue.length; i++) size += key.length + header.multiValue[i].value.length + 4;
      } else if (header.value) {
        size += key.length + header.value.length + 4;
      }
    }
    var cookies = [];
    for (var key in event.request.cookies) {
      var cookie = event.request.cookies[key];
      if (cookie.multiValue) {
        for (var i=0; i<cookie.multiValue.length; i++) cookies.push(key + "=" + cookie.multiValue[i].value);
      } else {
        cookies.push(key + "=" + cookie.value);
      }
    }
    if (cookies.length) size += 10 + cookies.join("; ").length;
    return size;
  }
}

function setForwardedHost() {
  event.request.headers["x-forwarded-host"] = event.request.headers.host;
}

function serializeQuerystring() {
  var parts = [];
  for (var key in event.request.querystring) {
    var q = event.request.querystring[key];
    if (q.multiValue) {
      for (var i = 0; i < q.multiValue.length; i++) parts.push(key + "=" + q.multiValue[i].value);
    } else {
      parts.push(q.value === "" ? key : key + "=" + q.value);
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

function buildHostRedirectResponse(toHost) {
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: {
      location: { value: "https://" + toHost + event.request.uri + serializeQuerystring() },
      "cache-control": { value: "no-store" },
    },
  };
}

function setUrlOrigin(urlHost, override) {
  setForwardedHost();
  var origin = {
    domainName: urlHost,
    customOriginConfig: {
      port: 443,
      protocol: "https",
      sslProtocols: ["TLSv1.2"],
    },
    originAccessControlConfig: {
      enabled: false,
    }
  };
  override = override || {};
  if (override.protocol === "http") delete origin.customOriginConfig;
  if (override.connectionAttempts) origin.connectionAttempts = override.connectionAttempts;
  if (override.timeouts) origin.timeouts = override.timeouts;
  if (override.originAccessControlConfig) origin.originAccessControlConfig = override.originAccessControlConfig;
  cf.updateRequestOrigin(origin);
}

function setS3Origin(s3Domain, override) {
  delete event.request.headers["Cookies"];
  delete event.request.headers["cookies"];
  delete event.request.cookies;
  var origin = {
    domainName: s3Domain,
    originAccessControlConfig: {
      enabled: true,
      signingBehavior: "always",
      signingProtocol: "sigv4",
      originType: "s3",
    }
  };
  override = override || {};
  if (override.connectionAttempts) origin.connectionAttempts = override.connectionAttempts;
  if (override.timeouts) origin.timeouts = override.timeouts;
  cf.updateRequestOrigin(origin);
}`;
