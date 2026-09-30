// Which Beacons are mesh agents, decided from what the unit has reported.
//
// An agent has no WAN side: its connection request URL is the LAN
// address its gateway gave it (RFC 1918, never the ISP's own pool or
// CGNAT space) and its WAN connection reports no external address. A
// gateway's URL is its public or CGNAT address and its WAN address is
// set, private or not (a Beacon behind the customer's own router is a
// gateway to its mesh and runs its speedtests fine). Verified on a
// production fleet: an extender reported 192.168.1.5 and an empty
// ExternalIPAddress; gateways reported 103.x and 100.64.x on both.
//
// A PROVISIONING script, on purpose. device.get reads the device's
// stored state (raw cache first, then the canonical resolver), so the
// URL from one Inform and the WAN address from another are both here.
// The first version of this rule was an EnrichmentRule calling the same
// device.get, which does not exist on that surface and threw on every
// session; the second read the enrichment batch, which on an extender
// holds two parameters and almost never the URL. Neither ever tagged a
// unit. Tags staged here are written when the rule completes, so
// hasTag sees them on the next evaluation.
(function () {
  const url = String(
    device.get("InternetGatewayDevice.ManagementServer.ConnectionRequestURL") ??
      device.get("Device.ManagementServer.ConnectionRequestURL") ??
      "",
  );
  if (url === "") return;
  const host = url.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
  const lan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  // A wildcard get returns an object keyed by full path, empty when
  // nothing matched; an agent's WAN paths are either absent (refused
  // with 9005 and never stored) or stored empty.
  const wanPaths = [
    "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress",
    "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress",
    "Device.PPP.Interface.*.IPCP.LocalIPAddress",
  ];
  let wan = false;
  for (let i = 0; i < wanPaths.length && !wan; i++) {
    const got = device.get(wanPaths[i]) as unknown as Record<string, unknown> | null | undefined;
    if (!got || typeof got !== "object") continue;
    for (const k in got) {
      if (Object.prototype.hasOwnProperty.call(got, k) && String(got[k] ?? "") !== "") {
        wan = true;
        break;
      }
    }
  }

  const agent = lan && !wan;
  if (agent && !device.hasTag("mesh:agent")) {
    device.addTag("mesh:agent");
  } else if (!agent && device.hasTag("mesh:agent")) {
    device.removeTag("mesh:agent");
  }
})();
