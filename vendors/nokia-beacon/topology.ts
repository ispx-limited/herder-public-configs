// Nokia Beacon mesh map, on both roots and every surveyed build.
//
// This rule owns a Beacon's map. It runs above the data model's
// fallbacks (tr098-hosts-only, easymesh-default), and the map is the
// newest snapshot of the highest-priority rule, so it emits the whole
// graph itself: controller, satellites, the controller's SSIDs, every
// client, wired hosts included.
//
// The mesh comes from one of two places. Builds that carry the Wi-Fi
// Data Elements tree (Beacon 2 JJLJ32, Beacon 3.1, G6) describe every
// mesh node, its radios and the stations on each; the tree is
// `Device.WiFi.DataElements` on TR-181 and
// `InternetGatewayDevice.DataElements` on TR-098. Builds without it
// (Beacon 2 HJKJ99, IJJJ30) describe the mesh only in Nokia's own
// table, X_ALU-COM_BeaconInfo.Beacon.{i}: one row per satellite with
// its MAC, serial, firmware, Status and BackhaulStatus. A satellite
// that has never informed this ACS is visible nowhere else.
//
// SSIDs are the controller's own, from the standard Wi-Fi table:
// WLANConfiguration.{i} on TR-098, WiFi.SSID.{i} on TR-181. A disabled
// or unnamed SSID is not drawn. A client associated to the controller
// hangs off the SSID it is on; a client of a satellite hangs off the
// satellite.
//
// Signal has two encodings. Data Elements SignalStrength is RCPI
// (0-220, dBm = raw/2 - 110, 0 meaning no measurement), converted per
// the rule's rssiEncoding. The TR-098 association table's
// SignalStrength is already dBm on these builds (-75, -89 read live on
// a Beacon 2 IJJJ30), per staSignalEncoding.

(function () {
  const rssiEncoding = String(ctx.configGet("rssiEncoding", "rcpi"));
  const staSignalEncoding = String(ctx.configGet("staSignalEncoding", "dbm"));
  const includeInactive: boolean = ctx.configGet<boolean>("includeInactiveHosts", false);

  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function str(v: unknown): string {
    return v === undefined || v === null ? "" : String(v);
  }
  function off(v: unknown): boolean {
    return v === "0" || v === "false" || v === false;
  }
  function dbm(raw: string, encoding: string): number | null {
    if (raw === "") return null;
    const n = parseFloat(raw);
    if (isNaN(n) || n === 0) return null;
    const v = encoding === "rcpi" ? n / 2 - 110 : n;
    return v < 0 ? v : null;
  }
  function signal(raw: string, encoding: string, parent: string, child: string): number | null {
    const v = dbm(raw, encoding);
    if (v !== null) topology.addEdgeMetric("rssi_dbm", v, { parent: parent, child: child });
    return v;
  }
  // The band from what the firmware declares, else the channel, which
  // is unambiguous: 14 and below is 2.4 GHz.
  function band(declared: string, channel: string): "wifi_2g" | "wifi_5g" | "wifi_6g" | "other" {
    if (declared.indexOf("2.4") >= 0) return "wifi_2g";
    if (declared.indexOf("6") === 0) return "wifi_6g";
    if (declared.indexOf("5") === 0) return "wifi_5g";
    const ch = parseInt(channel, 10);
    if (!isNaN(ch) && ch > 0 && ch <= 14) return "wifi_2g";
    if (!isNaN(ch) && ch >= 32) return "wifi_5g";
    return "other";
  }
  function bandLabel(edge: string): string | undefined {
    if (edge === "wifi_2g") return "2.4 GHz";
    if (edge === "wifi_5g") return "5 GHz";
    if (edge === "wifi_6g") return "6 GHz";
    return undefined;
  }

  // A Beacon reports under one root; the batch says which.
  let tr098 = false;
  for (const k in batch.params) {
    if (k.indexOf("InternetGatewayDevice.") === 0) { tr098 = true; break; }
  }
  const R = tr098 ? "InternetGatewayDevice." : "Device.";
  const DE = tr098 ? "InternetGatewayDevice.DataElements.Network." : "Device.WiFi.DataElements.Network.";
  const LAN = "InternetGatewayDevice.LANDevice.1.";
  const HOSTS = tr098 ? LAN + "Hosts.Host." : "Device.Hosts.Host.";

  // ---- The mesh nodes ----------------------------------------------
  const deNodes: MatchedEntry[] = batch.matches(DE + "Device.*").slice();
  deNodes.sort(function (a: MatchedEntry, b: MatchedEntry) {
    return parseInt(a.$indexes.Device, 10) - parseInt(b.$indexes.Device, 10);
  });

  // The controller. Data Elements names it (ControllerID, else the node
  // running the controller, else the lowest index); without the tree it
  // is this unit, identified by its LAN MAC.
  let gatewayMAC = "";
  if (deNodes.length > 0) {
    const controllerId = mac(batch.params[DE + "ControllerID"]);
    for (let i = 0; i < deNodes.length && !gatewayMAC; i++) {
      if (controllerId && mac(deNodes[i].ID) === controllerId) gatewayMAC = controllerId;
    }
    // The enum is NotSupported, SupportedNotEnabled, Running; only
    // Running is a controller, so the word is matched whole.
    for (let i = 0; i < deNodes.length && !gatewayMAC; i++) {
      const mode = str(deNodes[i]["MultiAPDevice.EasyMeshControllerOperationMode"]).trim();
      if (/^(running|enabled|1|true)$/i.test(mode)) gatewayMAC = mac(deNodes[i].ID);
    }
    for (let i = 0; i < deNodes.length && !gatewayMAC; i++) gatewayMAC = mac(deNodes[i].ID);
  }
  if (!gatewayMAC && tr098) {
    gatewayMAC = mac(batch.params[LAN + "LANEthernetInterfaceConfig.1.MACAddress"]);
  }
  if (!gatewayMAC) {
    enrichment.warn("nokia-beacon-topology: no controller MAC in this batch (Data Elements or LANEthernetInterfaceConfig.1)");
    return;
  }

  topology.addNode({
    id: gatewayMAC,
    type: "gateway",
    managed_device_id: device.id,
    manufacturer: device.manufacturer,
    model: device.model,
    firmware: device.firmware,
    serial: device.serialNumber,
  });

  const nodeByDeIndex: Record<string, string> = {};
  const satellites: Record<string, boolean> = {};
  for (let i = 0; i < deNodes.length; i++) {
    const n = deNodes[i];
    const id = mac(n.ID);
    if (!id) continue;
    nodeByDeIndex[n.$indexes.Device] = id;
    if (id === gatewayMAC) continue;
    satellites[id] = true;
    topology.addNode({
      id: id,
      type: "extender",
      manufacturer: str(n.Manufacturer) || undefined,
      model: str(n.ManufacturerModel) || undefined,
    });
    // The backhaul as the unit reports it. "None" or nothing is not a
    // wireless link we know of, so it is drawn as unknown, not as Wi-Fi.
    const linkType = str(n["MultiAPDevice.Backhaul.LinkType"]);
    topology.addEdge({
      parent: gatewayMAC,
      child: id,
      edge_type: /eth/i.test(linkType) ? "ethernet" : /wi-?fi|wlan|802\.11/i.test(linkType) ? "wifi_backhaul" : "other",
    });
    signal(str(n["MultiAPDevice.Backhaul.Stats.SignalStrength"]), rssiEncoding, gatewayMAC, id);
  }

  // Nokia's satellite table, for builds without Data Elements, and for
  // any satellite Data Elements did not list.
  const beacons = batch.matches(R + "X_ALU-COM_BeaconInfo.Beacon.*");
  for (let i = 0; i < beacons.length; i++) {
    const b = beacons[i];
    const id = mac(b.MACAddress);
    if (!id || id === gatewayMAC || satellites[id]) continue;
    satellites[id] = true;
    topology.addNode({
      id: id,
      type: "extender",
      manufacturer: device.manufacturer,
      serial: str(b.SerialNumber) || undefined,
      firmware: str(b.SoftwareVersion) || undefined,
      status: str(b.Status) || undefined,
      backhaul_status: str(b.BackhaulStatus) || undefined,
    });
    // Nokia's table says nothing about the link type.
    topology.addEdge({ parent: gatewayMAC, child: id, edge_type: "other" });
  }

  // ---- The controller's SSIDs --------------------------------------
  interface Ssid { bssid: string; name: string; edge: string; channel: string }
  const ssidByBSSID: Record<string, Ssid> = {};
  const ssidByWLAN: Record<string, Ssid> = {};
  function addSsid(bssid: string, name: string, edge: string, channel: string, up: boolean, key: string): void {
    if (!bssid) return;
    const s: Ssid = { bssid: bssid, name: name, edge: edge, channel: channel };
    ssidByWLAN[key] = s;
    if (!up || name === "") return;
    ssidByBSSID[bssid] = s;
    topology.addNode({
      id: bssid,
      type: "ssid",
      hostname: name,
      ssid: name,
      band: bandLabel(edge),
      channel: channel || undefined,
    });
    topology.addEdge({
      parent: gatewayMAC,
      child: bssid,
      edge_type: edge as TopologyEdge["edge_type"],
      bssid: bssid,
    });
  }
  if (tr098) {
    const wlans = batch.matches(LAN + "WLANConfiguration.*");
    for (let i = 0; i < wlans.length; i++) {
      const w = wlans[i];
      const up = !off(w.Enable) && (str(w.Status) === "" || str(w.Status) === "Up");
      addSsid(mac(w.BSSID), str(w.SSID), band(str(w.OperatingFrequencyBand), str(w.Channel)),
        str(w.Channel), up, w.$indexes.WLANConfiguration);
    }
  } else {
    const ssids = batch.matches("Device.WiFi.SSID.*");
    for (let i = 0; i < ssids.length; i++) {
      const s = ssids[i];
      const radio = (/Device\.WiFi\.Radio\.(\d+)/.exec(str(s.LowerLayers)) || [])[1] || "";
      const rb = radio ? "Device.WiFi.Radio." + radio + "." : "";
      const channel = rb ? str(batch.params[rb + "Channel"]) : "";
      const up = !off(s.Enable) && (str(s.Status) === "" || str(s.Status) === "Up");
      addSsid(mac(s.BSSID), str(s.SSID), band(rb ? str(batch.params[rb + "OperatingFrequencyBand"]) : "", channel),
        channel, up, s.$indexes.SSID);
    }
  }

  // ---- Each satellite's own SSIDs (Data Elements) ------------------
  // A satellite's radios carry BSSs of their own, named and addressed in
  // Data Elements, and the radio's operating class gives its band
  // (IEEE 802.11 Annex E: 81 to 84 are 2.4 GHz, 115 to 130 are 5 GHz,
  // 131 and above 6 GHz). Its clients hang off those SSIDs, as the
  // controller's hang off its own.
  function bandOfClass(cls: string): "wifi_2g" | "wifi_5g" | "wifi_6g" | "other" {
    const c = parseInt(cls, 10);
    if (isNaN(c)) return "other";
    if (c >= 81 && c <= 84) return "wifi_2g";
    if (c >= 115 && c <= 130) return "wifi_5g";
    if (c >= 131) return "wifi_6g";
    return "other";
  }
  const radioBand: Record<string, string> = {};
  const classes = batch.matches(DE + "Device.*.Radio.*.CurrentOperatingClassProfile.*");
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    const key = c.$indexes.Device + "." + c.$indexes.Radio;
    if (!radioBand[key] || radioBand[key] === "other") radioBand[key] = bandOfClass(str(c.Class));
  }
  const deSsidByBSSID: Record<string, Ssid> = {};
  const bsses = batch.matches(DE + "Device.*.Radio.*.BSS.*");
  for (let i = 0; i < bsses.length; i++) {
    const b = bsses[i];
    const bssid = mac(b.BSSID);
    const node = nodeByDeIndex[b.$indexes.Device];
    const name = str(b.SSID);
    if (!bssid || !node || node === gatewayMAC || name === "" || ssidByBSSID[bssid]) continue;
    const edge = radioBand[b.$indexes.Device + "." + b.$indexes.Radio] || "other";
    const s: Ssid = { bssid: bssid, name: name, edge: edge, channel: "" };
    deSsidByBSSID[bssid] = s;
    topology.addNode({ id: bssid, type: "ssid", hostname: name, ssid: name, band: bandLabel(edge) });
    topology.addEdge({ parent: node, child: bssid, edge_type: edge as TopologyEdge["edge_type"], bssid: bssid });
  }

  // ---- What the host table knows about each client ------------------
  interface Host { name: string; ipv4: string; ifType: string; layer: string; active: string }
  const hostByMAC: Record<string, Host> = {};
  const hosts = batch.matches(HOSTS + "*");
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const id = mac(h.MACAddress || h.PhysAddress);
    if (!id) continue;
    hostByMAC[id] = {
      name: str(h.HostName),
      ipv4: str(h.IPAddress),
      ifType: str(h.InterfaceType),
      layer: str(h.Layer1Interface) || str(h.Layer2Interface),
      active: str(h.Active),
    };
  }

  const drawn: Record<string, boolean> = {};
  function client(id: string, parent: string, edge: string, bssid: string, props: Record<string, unknown>): void {
    const h = hostByMAC[id];
    const node: Record<string, unknown> = {
      id: id,
      type: "client",
      hostname: h ? h.name || undefined : undefined,
      ipv4: h ? h.ipv4 || undefined : undefined,
      interface_type: h ? h.ifType || undefined : undefined,
    };
    for (const k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k) && props[k] !== undefined && props[k] !== "") node[k] = props[k];
    }
    topology.addNode(node as TopologyNode);
    topology.addEdge({
      parent: parent,
      child: id,
      edge_type: edge as TopologyEdge["edge_type"],
      bssid: bssid || undefined,
    });
    drawn[id] = true;
  }

  // Which WLAN each of the controller's own stations is on, from the
  // TR-098 association table: the fallback for a Data Elements station
  // whose BSS BSSID is not in the batch.
  const wlanBySTA: Record<string, string> = {};
  if (tr098) {
    const rows = batch.matches(LAN + "WLANConfiguration.*.AssociatedDevice.*");
    for (let i = 0; i < rows.length; i++) {
      const id = mac(rows[i].AssociatedDeviceMACAddress);
      if (id) wlanBySTA[id] = rows[i].$indexes.WLANConfiguration;
    }
  }

  // ---- Stations Data Elements lists, on every mesh node --------------
  const stations = batch.matches(DE + "Device.*.Radio.*.BSS.*.STA.*");
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const id = mac(s.MACAddress);
    if (!id || drawn[id] || off(s.Active)) continue;
    const node = nodeByDeIndex[s.$indexes.Device] || gatewayMAC;
    const bssid = mac(batch.params[DE + "Device." + s.$indexes.Device + ".Radio." + s.$indexes.Radio +
      ".BSS." + s.$indexes.BSS + ".BSSID"]);
    let ssid = node === gatewayMAC ? ssidByBSSID[bssid] : deSsidByBSSID[bssid];
    if (!ssid && node === gatewayMAC && wlanBySTA[id]) {
      const w = ssidByWLAN[wlanBySTA[id]];
      if (w && ssidByBSSID[w.bssid]) ssid = w;
    }
    const parent = ssid ? ssid.bssid : node;
    // A station Data Elements lists is wireless whatever else is
    // missing; its band is its radio's where the SSID did not give it.
    const band = ssid ? ssid.edge : radioBand[s.$indexes.Device + "." + s.$indexes.Radio] || "other";
    client(id, parent, band, ssid ? ssid.bssid : bssid, {
      ssid: ssid ? ssid.name : undefined,
      band: bandLabel(band),
      channel: ssid ? ssid.channel || undefined : undefined,
      signal_dbm: dbm(str(s.SignalStrength), rssiEncoding),
      rate_down_kbps: str(s.LastDataDownlinkRate) || undefined,
    });
    signal(str(s.SignalStrength), rssiEncoding, parent, id);
  }

  // ---- The controller's own association table (TR-098) -------------
  if (tr098) {
    const assoc = batch.matches(LAN + "WLANConfiguration.*.AssociatedDevice.*");
    for (let i = 0; i < assoc.length; i++) {
      const a = assoc[i];
      const id = mac(a.AssociatedDeviceMACAddress);
      if (!id || drawn[id]) continue;
      const ssid = ssidByWLAN[a.$indexes.WLANConfiguration];
      const parent = ssid && ssidByBSSID[ssid.bssid] ? ssid.bssid : gatewayMAC;
      client(id, parent, ssid ? ssid.edge : "other", ssid ? ssid.bssid : "", {
        ssid: ssid ? ssid.name || undefined : undefined,
        band: ssid ? bandLabel(ssid.edge) : undefined,
        channel: ssid ? ssid.channel || undefined : undefined,
        signal_dbm: dbm(str(a.SignalStrength), staSignalEncoding),
        rate_down_kbps: str(a.LastDataDownlinkRate) || undefined,
      });
      signal(str(a.SignalStrength), staSignalEncoding, parent, id);
    }
  }

  // ---- Every other host: wired, or wireless with no association row --
  for (const id in hostByMAC) {
    if (!Object.prototype.hasOwnProperty.call(hostByMAC, id)) continue;
    if (drawn[id] || id === gatewayMAC || satellites[id]) continue;
    const h = hostByMAC[id];
    if (!includeInactive && off(h.active)) continue;
    const wired = /ethernet/i.test(h.ifType) || /Ethernet/.test(h.layer);
    client(id, gatewayMAC, wired ? "ethernet" : "other", "", {});
  }
})();
