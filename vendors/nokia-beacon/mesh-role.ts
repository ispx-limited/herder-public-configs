// An agent has no WAN side: its connection request URL is the LAN
// address its gateway gave it (RFC 1918, never the ISP's own pool) and
// it reports no external address on any WAN connection. Read from
// what the device has reported, not this batch alone, so an Inform
// that carries the URL but not the WAN address still decides right.
(function () {
  const url = String(
    device.get("InternetGatewayDevice.ManagementServer.ConnectionRequestURL") ??
      device.get("Device.ManagementServer.ConnectionRequestURL") ??
      "",
  );
  const host = url.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
  const lan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

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
