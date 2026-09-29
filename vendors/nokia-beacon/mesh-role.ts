// Which Beacons are mesh agents, decided from what the unit reports.
//
// An agent has no WAN side: its connection request URL is the LAN
// address its gateway gave it (RFC 1918, never the ISP's own pool or
// CGNAT space) and its WAN connection reports no external address. A
// gateway's URL is its public or CGNAT address and its WAN address is
// set. Verified on a production fleet: an extender reported
// 192.168.1.5 and an empty ExternalIPAddress; gateways reported
// 103.x/100.64.x on both.
//
// Enrichment reads THIS BATCH, through `batch.params`. `device.get` is
// the provisioning surface and throws in an enrichment script (the SDK
// header says so); the first version of this rule called it and failed
// on every session of every Beacon with "Object has no member 'get'",
// so no unit was ever tagged and the profiles that exclude agents
// (speedtest) kept offering tests that agents fail.
//
// The rule triggers on the URL and the WAN address paths, and a Beacon's
// session batch carries both (the telemetry profile collects the WAN
// connection every Inform), so one batch is enough to decide. When it is
// not, nothing changes: a batch without the URL says nothing about the
// role, and a LAN URL with no WAN key present at all is left as it was
// rather than guessed.
(function () {
  const p = batch.params;
  const url = String(
    p["InternetGatewayDevice.ManagementServer.ConnectionRequestURL"] ??
      p["Device.ManagementServer.ConnectionRequestURL"] ??
      "",
  );
  if (url === "") return;
  const host = url.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
  const lan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  // Every WAN address the batch carries. An agent's is empty; a
  // gateway's is set, and a private one still means a WAN side (a
  // Beacon behind the customer's own router is a gateway to its mesh,
  // runs its speedtests fine, and must not be hidden as an agent).
  const wanPatterns = [
    "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANIPConnection.*.ExternalIPAddress",
    "InternetGatewayDevice.WANDevice.*.WANConnectionDevice.*.WANPPPConnection.*.ExternalIPAddress",
    "Device.PPP.Interface.*.IPCP.LocalIPAddress",
  ];
  let seen = 0;
  let wan = false;
  for (let i = 0; i < wanPatterns.length; i++) {
    const pattern = wanPatterns[i];
    const leaf = pattern.slice(pattern.lastIndexOf(".") + 1);
    const matches = batch.matches(pattern);
    for (let j = 0; j < matches.length; j++) {
      seen++;
      if (String(matches[j][leaf] ?? "") !== "") wan = true;
    }
  }

  if (lan && seen === 0) return; // undecidable from this batch
  const agent = lan && !wan;
  if (agent && !device.hasTag("mesh:agent")) {
    device.addTag("mesh:agent");
  } else if (!agent && device.hasTag("mesh:agent")) {
    device.removeTag("mesh:agent");
  }
})();
