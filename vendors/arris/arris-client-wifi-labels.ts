// ARRIS TR-098 per-client WiFi labels from the X_0000C5_ trees.
//
// Emits the same wifi.client.* names and labels as the baseline
// client-wifi-labels.ts, from the leaves only this firmware has. The
// baseline rule runs on the same device and emits what the standard
// AssociatedDevice table carries (the transmit rate); this one adds the
// signal, the byte counters, the association age and the steering
// counters, all vendor leaves on TR-098. Nothing is emitted under a name
// the baseline does not define.
//
// Three independent sections, each silent when its tree is not in the
// batch, so one script covers the firmware variants (some expose the
// HNC.HNE mesh tree, some only HNC.Steer.SummaryStats, some both):
//   1. HNC.Steer.SummaryStats.STA.*: steering counters per client
//   2. WLANConfiguration.*.AssociatedDevice.* plus the WLANStats tree:
//      gateway-attached clients
//   3. HNC.HNE.*.Radio.*.SSID.*.STA.*: extender-attached clients

// ARRIS index semantics, this firmware's. The WLAN table fallback is
// used only when X_0000C5_OperatingFrequencyBand is not in the batch.
const WLAN_BAND_FALLBACK: Record<string, string> = {
  "1": "2.4GHz",
  "5": "5GHz",
};
const HNE_VIA: Record<string, string> = {
  "1": "gateway",
};
const HNE_RADIO_BAND: Record<string, string> = {
  "1": "5GHz",
  "2": "2.4GHz",
  "3": "6GHz",
};

// The firmware writes "2.4GHz" and "5.0GHz". Fold to the spelling the
// dashboards group on.
function normaliseBand(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, "").toLowerCase();
  if (s.startsWith("2.4")) return "2.4GHz";
  if (s.startsWith("5")) return "5GHz";
  if (s.startsWith("6")) return "6GHz";
  return null;
}

function normaliseMac(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().toLowerCase().replace(/-/g, ":");
  return m === "" ? null : m;
}

function toInt(s: unknown): number | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const n = parseInt(String(s), 10);
  return isNaN(n) ? null : n;
}

function emitSignal(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n < 0) emit(metric, n, labels);
}
function emitPositive(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n > 0) emit(metric, n, labels);
}
function emitCount(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n >= 0) emit(metric, n, labels);
}

// --- Lookup tables built once per invocation -------------------------------

const hostByMac: Record<string, string | null> = {};
const hosts = batch.matches("InternetGatewayDevice.LANDevice.1.Hosts.Host.*");
for (let hi = 0; hi < hosts.length; hi++) {
  const h = hosts[hi];
  const hmac = normaliseMac(h.MACAddress);
  if (!hmac) continue;
  hostByMac[hmac] = (h.HostName as string | undefined) || null;
}
function hostnameOf(mac: string): string | null {
  return hostByMac[mac] === undefined ? null : hostByMac[mac];
}

// WLAN index -> band from X_0000C5_OperatingFrequencyBand, else the table.
const bandByWlan: Record<string, string> = {};
const wlans = batch.matches("InternetGatewayDevice.LANDevice.1.WLANConfiguration.*");
for (let wi = 0; wi < wlans.length; wi++) {
  const w = wlans[wi];
  const b = normaliseBand(w.X_0000C5_OperatingFrequencyBand);
  if (b) bandByWlan[w.$indexes.WLANConfiguration] = b;
}
function resolveBand(wlanIdx: string): string | null {
  return bandByWlan[wlanIdx] || WLAN_BAND_FALLBACK[wlanIdx] || null;
}

// --- 1. Per-client steering counters (HNC.Steer.SummaryStats) ------------
// Kept even for a gateway with no client currently associated: the table
// is the steering record. No band: the table is per client, not per radio.
const steerStats = batch.matches(
  "InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.Steer.SummaryStats.STA.*",
);
for (let si = 0; si < steerStats.length; si++) {
  const s = steerStats[si];
  const smac = normaliseMac(s.MACAddress);
  if (!smac) continue;
  const slabels: EmitLabels = {
    client_mac: smac,
    hostname: hostnameOf(smac),
    via: "gateway",
  };
  emitCount("wifi.client.btm_attempts", s.BTMAttempts, slabels);
  emitCount("wifi.client.btm_successes", s.BTMSuccesses, slabels);
  emitCount("wifi.client.blacklist_attempts", s.BlacklistAttempts, slabels);
  emitCount("wifi.client.blacklist_successes", s.BlacklistSuccesses, slabels);
}

// --- 2. Gateway-attached clients ------------------------------------------
// Labels match the baseline's TR-098 section (client_mac, hostname, via,
// band, wlan_idx) so the two scripts' rows collapse to one per client.
const gwMacByTuple: Record<string, string> = {};
const gwAssoc = batch.matches(
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.*.AssociatedDevice.*",
);
for (let gi = 0; gi < gwAssoc.length; gi++) {
  const ad = gwAssoc[gi];
  const mac = normaliseMac(ad.AssociatedDeviceMACAddress);
  if (!mac) continue;
  const wlanIdx = ad.$indexes.WLANConfiguration;
  gwMacByTuple[wlanIdx + "|" + ad.$indexes.AssociatedDevice] = mac;
  const band = resolveBand(wlanIdx);
  if (!band) continue;
  const gwLabels: EmitLabels = {
    client_mac: mac,
    hostname: hostnameOf(mac),
    via: "gateway",
    band,
    wlan_idx: wlanIdx,
  };
  emitSignal("wifi.client.rssi", ad.X_0000C5_RSSI, gwLabels);
  emitCount("wifi.client.bytes_tx", ad.X_0000C5_BytesSent, gwLabels);
  emitCount("wifi.client.bytes_rx", ad.X_0000C5_BytesReceived, gwLabels);
  // 0 on firmware that has the leaf and never fills it (an NVG578LX in
  // service reports 0 for a client associated for hours): no measurement.
  emitPositive("wifi.client.assoc_seconds", ad.X_0000C5_TimeAssociated, gwLabels);
}

// The WLANStats tree keys its rows on the same (WLAN, AssociatedDevice)
// tuple; ClientRSSI there is the signal on firmware whose
// AssociatedDevice row lacks X_0000C5_RSSI.
const wlanStats = batch.matches(
  "InternetGatewayDevice.LANDevice.1.X_0000C5_WLANStats.*.AssociatedDevice.*.Stats.*",
);
for (let ti = 0; ti < wlanStats.length; ti++) {
  const st = wlanStats[ti];
  const wlanIdx = st.$indexes.X_0000C5_WLANStats;
  const stMac = gwMacByTuple[wlanIdx + "|" + st.$indexes.AssociatedDevice];
  if (!stMac) continue;
  const band = resolveBand(wlanIdx);
  if (!band) continue;
  emitSignal("wifi.client.rssi", st.ClientRSSI, {
    client_mac: stMac,
    hostname: hostnameOf(stMac),
    via: "gateway",
    band,
    wlan_idx: wlanIdx,
  });
}

// --- 3. Extender-attached clients (HNC.HNE mesh tree) -----------------------
// HNE.1 is the gateway; every other node is an extender, named by its MAC.
const hneMac: Record<string, string> = {};
const hnes = batch.matches("InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE.*");
for (let ni = 0; ni < hnes.length; ni++) {
  const m = normaliseMac(hnes[ni].MACAddress);
  if (m) hneMac[hnes[ni].$indexes.HNE] = m;
}
const extClients = batch.matches(
  "InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE.*.Radio.*.SSID.*.STA.*",
);
for (let k = 0; k < extClients.length; k++) {
  const sta = extClients[k];
  const stamac = normaliseMac(sta.MACAddress);
  if (!stamac) continue;
  const idx = sta.$indexes;
  const radioBand = normaliseBand(
    batch.params["InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE." + idx.HNE + ".Radio." + idx.Radio + ".OperatingFrequencyBand"],
  );
  const band = radioBand || HNE_RADIO_BAND[idx.Radio];
  if (!band) continue;
  const extLabels: EmitLabels = {
    client_mac: stamac,
    hostname: hostnameOf(stamac),
    via: HNE_VIA[idx.HNE] || "extender",
    band,
    node: hneMac[idx.HNE] || null,
  };
  emitSignal("wifi.client.rssi", sta.RSSI, extLabels);
  emitPositive("wifi.client.tx_rate", sta.TxPHYRate, extLabels);
}
