// Nokia Beacon mesh topology from the Wi-Fi DataElements tree.
//
// The Beacons carry an EasyMesh DataElements model that neither the
// flat-AP easymesh-default.ts (it walks WiFi.MultiAP.APDevice) nor the
// TR-098 hosts-only script reads, so a Beacon's map showed only the
// gateway. This walks DataElements directly and emits the gateway, its
// mesh nodes, and the clients on each.
//
// One script, both generations: TR-181 Beacons root the tree at
// `Device.WiFi.DataElements`, TR-098 Beacons at
// `InternetGatewayDevice.DataElements`. The root is discovered from the
// batch, and everything below it is identical.
//
// The mesh shape: Network.Device.{i} is one agent. The controller
// (Network.ControllerID, or the first device when the CPE leaves it
// blank) is the gateway; the rest are extenders, each linked to the
// gateway by its MultiAPDevice.Backhaul, coloured by that backhaul's
// signal. Clients hang off the node whose radio's BSS they associate
// to. Signal is emitted only for a real negative dBm, so an idle
// station reporting 0 does not paint as the strongest link.

(function () {
  function isInactive(v: unknown): boolean {
    return v === "0" || v === "false" || v === false;
  }
  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function edgeRssi(sig: unknown, parent: string, child: string): void {
    if (typeof sig !== "string" || sig === "") return;
    const raw = parseFloat(sig);
    if (isNaN(raw) || raw === 0 || raw >= 0) return;
    topology.addEdgeMetric("rssi_dbm", raw, { parent: parent, child: child });
  }

  // Discover the root: whichever DataElements prefix this device reports.
  const roots = [
    "Device.WiFi.DataElements.Network.",
    "InternetGatewayDevice.DataElements.Network.",
  ];
  let root = "";
  for (let i = 0; i < roots.length; i++) {
    if (batch.matches(roots[i] + "Device.*").length > 0) { root = roots[i]; break; }
  }
  if (!root) return;

  const controllerId = mac(batch.params[root + "ControllerID"]);
  const nodes: MatchedEntry[] = batch.matches(root + "Device.*").slice();
  if (nodes.length === 0) return;

  // Order the nodes by their Device index so the fallback is
  // deterministic: batch order is not, and Device.1 is the controller
  // by Nokia's convention when nothing else names it.
  nodes.sort(function (a: MatchedEntry, b: MatchedEntry) {
    return parseInt(a.$indexes.Device, 10) - parseInt(b.$indexes.Device, 10);
  });

  // Which node is the gateway. In order of trust: the ID the network
  // names as controller, the node the CPE marks as running the
  // controller, then the lowest Device index.
  let gatewayMAC = "";
  if (controllerId) {
    for (let i = 0; i < nodes.length; i++) {
      if (mac(nodes[i].ID) === controllerId) { gatewayMAC = controllerId; break; }
    }
  }
  if (!gatewayMAC) {
    for (let i = 0; i < nodes.length; i++) {
      const mode = nodes[i]["MultiAPDevice.EasyMeshControllerOperationMode"] as string | undefined;
      if (mode && /enabled|^1$|true/i.test(mode)) { gatewayMAC = mac(nodes[i].ID); break; }
    }
  }
  if (!gatewayMAC) {
    for (let i = 0; i < nodes.length; i++) {
      const id = mac(nodes[i].ID);
      if (id) { gatewayMAC = id; break; }
    }
  }

  // Pass 1: emit each mesh node. The gateway carries this device's id;
  // the rest are extenders.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const id = mac(n.ID);
    if (!id) continue;
    const isGateway = id === gatewayMAC;
    topology.addNode({
      id: id,
      type: isGateway ? "gateway" : "extender",
      managed_device_id: isGateway ? device.id : undefined,
      manufacturer: (n.Manufacturer as string | undefined) || undefined,
      model: (n.ManufacturerModel as string | undefined) || undefined,
    });
  }

  // Pass 2: link every extender to the gateway by its backhaul, and
  // colour that edge by the backhaul signal. A single-hop star is the
  // shape a home mesh takes; a multi-hop tree from BackhaulDeviceID is
  // a later refinement.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const id = mac(n.ID);
    if (!id || id === gatewayMAC) continue;
    const linkType = (n["MultiAPDevice.Backhaul.LinkType"] as string | undefined) || "";
    topology.addEdge({
      parent: gatewayMAC,
      child: id,
      edge_type: /eth/i.test(linkType) ? "ethernet" : "wifi_backhaul",
    });
    edgeRssi(n["MultiAPDevice.Backhaul.Stats.SignalStrength"], gatewayMAC, id);
  }

  // Pass 3: clients. Each STA under a node's Radio.BSS associates to
  // that node; edge it there, drop the disassociated ones, and carry
  // its signal.
  const stations = batch.matches(root + "Device.*.Radio.*.BSS.*.STA.*");
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const cmac = mac(s.MACAddress);
    if (!cmac) continue;
    if (isInactive(s.Active)) continue;
    const nodeMAC = mac(batch.params[root + "Device." + s.$indexes.Device + ".ID"]);
    const parent = nodeMAC || gatewayMAC;
    topology.addNode({
      id: cmac,
      type: "client",
      hostname: (s.Hostname as string | undefined) || undefined,
    });
    topology.addEdge({ parent: parent, child: cmac, edge_type: "wifi_5g" });
    edgeRssi(s.SignalStrength, parent, cmac);
  }
})();
