// topology.ts: a flat map for a GWN70x2 from its association table.
//
// One gateway node, every active associated station as a client on the
// radio it is on. The band comes from the AccessPoint -> SSID -> Radio
// chain the standard defines (SSIDReference, then LowerLayers), with
// the access point's own index as the fallback when the chain is not in
// the batch; where neither answers the edge is `other`, which is what
// "wireless, band unknown" honestly is. Signal is dBm on this model
// (negative), and a 0 is the idle-station placeholder, not a reading.
(function () {
  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function edgeTypeOf(raw: unknown): TopologyEdge["edge_type"] | "" {
    const b = (typeof raw === "string" ? raw : "").toLowerCase().replace(/ /g, "");
    if (b.indexOf("6g") >= 0) return "wifi_6g";
    if (b.indexOf("5g") >= 0) return "wifi_5g";
    if (b.indexOf("2.4") >= 0 || b.indexOf("2g") >= 0) return "wifi_2g";
    return "";
  }
  function bandLabel(edge: string): string | undefined {
    if (edge === "wifi_2g") return "2.4 GHz";
    if (edge === "wifi_5g") return "5 GHz";
    if (edge === "wifi_6g") return "6 GHz";
    return undefined;
  }

  // The gateway is the router itself: its first Ethernet MAC.
  const eth = batch.matches("Device.Ethernet.Interface.*.MACAddress");
  let gatewayMAC = "";
  for (let i = 0; i < eth.length && !gatewayMAC; i++) gatewayMAC = mac(eth[i].MACAddress);
  if (!gatewayMAC) {
    enrichment.warn("grandstream-gwn-topology: no gateway MAC in Device.Ethernet.Interface.*.MACAddress");
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

  // Which radio each access point is on, through the SSID it serves.
  const radioBand: Record<string, string> = {};
  const radios = batch.matches("Device.WiFi.Radio.*");
  for (let i = 0; i < radios.length; i++) {
    radioBand[radios[i].$indexes.Radio] = edgeTypeOf(radios[i].OperatingFrequencyBand);
  }
  const ssidRadio: Record<string, string> = {};
  const ssidName: Record<string, string> = {};
  const ssidBSSID: Record<string, string> = {};
  const ssids = batch.matches("Device.WiFi.SSID.*");
  for (let i = 0; i < ssids.length; i++) {
    const s = ssids[i];
    const idx = s.$indexes.SSID;
    const m = /Device\.WiFi\.Radio\.(\d+)/.exec(String(s.LowerLayers || ""));
    if (m) ssidRadio[idx] = m[1];
    if (typeof s.SSID === "string") ssidName[idx] = s.SSID;
    const b = mac(s.BSSID);
    if (b) ssidBSSID[idx] = b;
  }
  const apSSID: Record<string, string> = {};
  const aps = batch.matches("Device.WiFi.AccessPoint.*");
  for (let i = 0; i < aps.length; i++) {
    const m = /Device\.WiFi\.SSID\.(\d+)/.exec(String(aps[i].SSIDReference || ""));
    if (m) apSSID[aps[i].$indexes.AccessPoint] = m[1];
  }
  function bandForAP(apIdx: string): TopologyEdge["edge_type"] {
    const s = apSSID[apIdx];
    const r = s !== undefined && ssidRadio[s] !== undefined ? ssidRadio[s] : apIdx;
    const e = radioBand[r];
    return (e || "other") as TopologyEdge["edge_type"];
  }

  const stations = batch.matches("Device.WiFi.AccessPoint.*.AssociatedDevice.*");
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const cmac = mac(st.MACAddress);
    if (!cmac || cmac === gatewayMAC) continue;
    if (st.Active === "0" || st.Active === "false") continue;
    const apIdx = st.$indexes.AccessPoint;
    const edgeType = bandForAP(apIdx);
    const s = apSSID[apIdx];
    topology.addNode({
      id: cmac,
      type: "client",
      band: bandLabel(edgeType),
      ssid: s !== undefined ? ssidName[s] : undefined,
    });
    topology.addEdge({
      parent: gatewayMAC,
      child: cmac,
      edge_type: edgeType,
      bssid: s !== undefined ? ssidBSSID[s] : undefined,
    });
    const sig = parseFloat(String(st.SignalStrength ?? ""));
    if (!isNaN(sig) && sig < 0) {
      topology.addEdgeMetric("rssi_dbm", sig, { parent: gatewayMAC, child: cmac });
    }
  }
})();
