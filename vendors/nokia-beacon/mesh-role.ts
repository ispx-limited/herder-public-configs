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
// A PROVISIONING script reading CANONICALS, both on purpose. The two
// values arrive in different sessions, so an enrichment batch (what
// this session collected; on an extender, two parameters) almost never
// holds both; provisioning reads the device's stored state. And
// device.get resolves stored state through the canonical layer: a raw
// wildcard returns nil by contract, and a raw path is served from this
// session's known parameters, not the whole tree. The canonicals below
// are bound by the Beacon profiles for both data models, so one script
// serves the TR-098 and the TR-181 units. Tags staged here are written
// when the rule completes, so hasTag sees them on the next evaluation.
(function () {
  const url = String(device.get("canonical.mgmt.connection_request_url") ?? "");
  if (url === "") return;
  const host = url.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
  const lan =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  // An agent's WAN address is stored empty (or refused with 9005 and
  // never stored, which reads the same); a gateway's is set.
  const wan = String(device.get("canonical.interface.wan.ip_address") ?? "") !== "";

  const agent = lan && !wan;
  if (agent && !device.hasTag("mesh:agent")) {
    device.addTag("mesh:agent");
  } else if (!agent && device.hasTag("mesh:agent")) {
    device.removeTag("mesh:agent");
  }
})();
