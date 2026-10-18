// Per-client WiFi labels from the standard trees.
//
// One row per client per metric, keyed on the client MAC, which is the
// identity that survives the instance churn of every associated-device
// table. The metric set is the one every source feeds: a vendor script
// maps its own leaves onto these same names and adds none of its own.
//
//   wifi.client.rssi            uplink signal at the CPE, dBm
//   wifi.client.noise           uplink noise at the CPE, dBm
//   wifi.client.snr             dB
//   wifi.client.tx_rate         last PHY rate CPE to client
//   wifi.client.rx_rate         last PHY rate client to CPE
//   wifi.client.retrans         of the last 100 packets, how many retried
//   wifi.client.retrans_count   retried packets, monotonic
//   wifi.client.bytes_tx        bytes CPE to client, monotonic
//   wifi.client.bytes_rx        bytes client to CPE, monotonic
//   wifi.client.assoc_seconds   seconds since the client associated
//   wifi.client.btm_attempts, btm_successes,
//   wifi.client.blacklist_attempts, blacklist_successes
//                               steering, monotonic
//
// Labels: client_mac, hostname, band (2.4GHz, 5GHz, 6GHz), via (gateway
// or extender), and the index the row came from (ap_idx, wlan_idx) or
// the mesh node it was read on (node).
//
// Three sections, each reading one standard tree and silent when the
// tree is not in the batch:
//   1. TR-181 Device.WiFi.AccessPoint.*.AssociatedDevice.*
//   2. TR-098 InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*
//   3. Wi-Fi Data Elements ...Network.Device.*.Radio.*.BSS.*.STA.*, under
//      either root, which is every client on every node of a mesh
//
// A gauge is emitted only when it is a measurement: an associated
// client's signal and noise are negative dBm, a rate is positive, and 0
// is the placeholder a CPE reports for a client it has no reading on.
// A counter is emitted as read, 0 included, and read as deltas.

const SECTION_DE_RSSI_ENCODING = String(ctx.configGet("dataElementsSignal", "rcpi"));

// Last-resort index tables, used only when the band cannot be read from
// the radio an access point or BSS runs on. TR-181 and Data Elements
// both name the band on the radio, so these only carry a CPE that omits
// the leaf; a Nokia Beacon exposes eight access points, 1 to 4 on 2.4 GHz
// and 5 to 8 on 5 GHz, and does not follow the first table.
const AP_BAND_FALLBACK: Record<string, string> = {
  "1": "2.4GHz",
  "2": "2.4GHz",
  "3": "5GHz",
  "4": "5GHz",
};
const DE_RADIO_BAND_FALLBACK: Record<string, string> = {
  "1": "2.4GHz",
  "2": "5GHz",
  "3": "6GHz",
};

// TR-181 OperatingFrequencyBand is "2.4GHz" | "5GHz" | "6GHz"; firmware
// also writes "2.4 GHz" and "5.0GHz". Fold to the spelling the
// dashboards group on, or null when it is none of the three.
function normaliseBand(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, "").toLowerCase();
  if (s.startsWith("2.4")) return "2.4GHz";
  if (s.startsWith("5")) return "5GHz";
  if (s.startsWith("6")) return "6GHz";
  return null;
}

// A 2.4 GHz channel is 1 to 14; anything above is 5 GHz. 6 GHz reuses the
// low numbers, so a channel alone cannot name it, but no TR-098 CPE (the
// only caller) reports a 6 GHz radio.
function bandFromChannel(v: unknown): string | null {
  const ch = toInt(v);
  if (ch === null || ch <= 0) return null;
  return ch <= 14 ? "2.4GHz" : "5GHz";
}

// IEEE 802.11 global operating classes (Annex E, table E-4): 81 to 84
// are the 2.4 GHz band, 115 to 130 the 5 GHz band, 131 to 137 the 6 GHz
// band. The only standard leaf that bands a Data Elements radio.
function bandFromOpClass(v: unknown): string | null {
  const c = toInt(v);
  if (c === null) return null;
  if (c >= 81 && c <= 84) return "2.4GHz";
  if (c >= 115 && c <= 130) return "5GHz";
  if (c >= 131 && c <= 137) return "6GHz";
  return null;
}

// Strip the optional trailing dot a CPE may put on a path reference so
// "Device.WiFi.SSID.5." and "Device.WiFi.SSID.5" key the same map entry.
function refPath(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  return v.replace(/\.$/, "");
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

// A TR-069/TR-369 boolean is "0"/"1" or "false"/"true" on the wire.
// Only an explicit not-active reading skips the client; an absent
// field (a profile that does not collect Active) is not treated as
// inactive, so the negative-dBm guard below still carries it.
function isInactive(v: unknown): boolean {
  return v === "0" || v === "false" || v === false;
}

// Seconds since an xsd:dateTime, against the clock of this run. Null
// for a missing or unparseable value and for the Unknown Time
// (0001-01-01), which a CPE reports before it has set its clock.
function secondsSince(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  if (isNaN(t) || t < 946684800000) return null;
  const s = Math.round((Date.now() - t) / 1000);
  return s > 0 ? s : null;
}

// Gauges: a measurement or nothing.
function emitSignal(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n < 0) emit(metric, n, labels);
}
function emitPositive(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n > 0) emit(metric, n, labels);
}
// Counters and bounded gauges: as read, 0 included. An association age
// is the exception: firmware that has the leaf and never fills it
// reports 0, so 0 is no measurement there and goes through emitPositive.
function emitCount(metric: string, v: unknown, labels: EmitLabels): void {
  const n = toInt(v);
  if (n !== null && n >= 0) emit(metric, n, labels);
}

// --- Lookup tables built once per invocation ----------------------------

interface HostMeta { hostname: string | null; ip: string | null; }

// MAC -> {hostname, ip} from TR-181 Hosts.Host or TR-098
// LANDevice.1.Hosts.Host (whichever the CPE populates).
const hostByMac: Record<string, HostMeta> = {};
const hostsTR181 = batch.matches("Device.Hosts.Host.*");
for (let hi = 0; hi < hostsTR181.length; hi++) {
  const h = hostsTR181[hi];
  const hmac = normaliseMac(h.PhysAddress);
  if (!hmac) continue;
  hostByMac[hmac] = {
    hostname: (h.HostName as string | undefined) || null,
    ip: (h.IPAddress as string | undefined) || null,
  };
}
const hostsTR098 = batch.matches("InternetGatewayDevice.LANDevice.*.Hosts.Host.*");
for (let hi2 = 0; hi2 < hostsTR098.length; hi2++) {
  const h2 = hostsTR098[hi2];
  const hmac2 = normaliseMac(h2.MACAddress);
  if (!hmac2) continue;
  if (!hostByMac[hmac2]) {
    hostByMac[hmac2] = {
      hostname: (h2.HostName as string | undefined) || null,
      ip: (h2.IPAddress as string | undefined) || null,
    };
  }
}
function hostnameOf(mac: string): string | null {
  const h = hostByMac[mac];
  return h ? h.hostname : null;
}

// --- 1. TR-181 gateway-attached clients ---------------------------------
//
// The band is the radio's OperatingFrequencyBand, reached from the access
// point by AccessPoint.SSIDReference -> SSID.LowerLayers -> Radio. The
// TR-181 telemetry profile collects all three on every contact, so this
// resolves for any conforming CPE whatever its SSID count or order. The
// index table is the last resort for a CPE that omits a leaf.

const radioBand: Record<string, string> = {};
const radios = batch.matches("Device.WiFi.Radio.*");
for (let ri = 0; ri < radios.length; ri++) {
  const r = radios[ri];
  const band = normaliseBand(r.OperatingFrequencyBand);
  if (band) radioBand["Device.WiFi.Radio." + r.$indexes.Radio] = band;
}

const ssidToRadio: Record<string, string> = {};
const ssids = batch.matches("Device.WiFi.SSID.*");
for (let si = 0; si < ssids.length; si++) {
  const s = ssids[si];
  const lower = refPath((s.LowerLayers as string | undefined || "").split(",")[0]);
  if (lower) ssidToRadio["Device.WiFi.SSID." + s.$indexes.SSID] = lower;
}

const apBand: Record<string, string> = {};
const accessPoints = batch.matches("Device.WiFi.AccessPoint.*");
for (let ai = 0; ai < accessPoints.length; ai++) {
  const ap = accessPoints[ai];
  const apIdx = ap.$indexes.AccessPoint;
  const ssidPath = refPath(ap.SSIDReference);
  const radioPath = ssidPath ? ssidToRadio[ssidPath] : null;
  const band = radioPath ? radioBand[radioPath] : null;
  // Only a band that resolved. An unresolved entry is left absent, not
  // "unknown", so the emit loop skips the client rather than guessing.
  const resolved = band || AP_BAND_FALLBACK[apIdx];
  if (resolved) apBand[apIdx] = resolved;
}

const tr181Clients = batch.matches("Device.WiFi.AccessPoint.*.AssociatedDevice.*");
for (let ci = 0; ci < tr181Clients.length; ci++) {
  const c = tr181Clients[ci];
  const mac = normaliseMac(c.MACAddress);
  if (!mac) continue;
  // A client the CPE marks not-active has disassociated or gone to
  // sleep; its leaves read 0, the no-measurement placeholder.
  if (isInactive(c.Active)) continue;
  const apIdx = c.$indexes.AccessPoint;
  // The batch is one telemetry event, not the device snapshot. A
  // value-change inform can carry the AssociatedDevice row without the
  // Radio, SSID and AccessPoint leaves the band is read from. Emitting
  // band "unknown" there puts a phantom spoke on the client radar that
  // flickers against the real band the next full inform resolves. Skip
  // the client on this event; a chain-bearing event re-emits it.
  const band = apBand[apIdx];
  if (!band) continue;
  const labels: EmitLabels = {
    client_mac: mac,
    hostname: hostnameOf(mac),
    via: "gateway",
    band,
    ap_idx: apIdx,
  };
  emitSignal("wifi.client.rssi", c.SignalStrength, labels);
  emitSignal("wifi.client.noise", c.Noise, labels);
  emitPositive("wifi.client.snr", c.SNR, labels);
  emitPositive("wifi.client.tx_rate", c.LastDataDownlinkRate, labels);
  emitPositive("wifi.client.rx_rate", c.LastDataUplinkRate, labels);
  emitCount("wifi.client.retrans", c.Retransmissions, labels);
  emitCount("wifi.client.retrans_count", c["Stats.RetransCount"], labels);
  emitCount("wifi.client.bytes_tx", c["Stats.BytesSent"], labels);
  emitCount("wifi.client.bytes_rx", c["Stats.BytesReceived"], labels);
  const assoc = secondsSince(c.AssociationTime);
  if (assoc !== null) emit("wifi.client.assoc_seconds", assoc, labels);
}

// --- 2. TR-098 gateway-attached clients ---------------------------------
//
// TR-098 has no per-radio band leaf; the channel is authoritative for
// the 2.4 versus 5 GHz split and the telemetry profile collects it. The
// standard table carries only the last transmit rate and, on some
// firmware, a SignalStrength; every other per-client measurement on a
// TR-098 gateway is a vendor leaf and belongs to that vendor's script,
// emitted under these same names and labels.

const wlanBand: Record<string, string> = {};
const wlans = batch.matches("InternetGatewayDevice.LANDevice.*.WLANConfiguration.*");
for (let wi = 0; wi < wlans.length; wi++) {
  const w = wlans[wi];
  const key = w.$indexes.LANDevice + "." + w.$indexes.WLANConfiguration;
  const band = bandFromChannel(w.Channel);
  if (band) wlanBand[key] = band;
}

const tr098Clients = batch.matches(
  "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*",
);
for (let ti = 0; ti < tr098Clients.length; ti++) {
  const t = tr098Clients[ti];
  const tmac = normaliseMac(t.AssociatedDeviceMACAddress);
  if (!tmac) continue;
  if (isInactive(t.Active)) continue;
  const wlanIdx = t.$indexes.WLANConfiguration;
  const wlanKey = t.$indexes.LANDevice + "." + wlanIdx;
  const tband = wlanBand[wlanKey] || AP_BAND_FALLBACK[wlanIdx];
  if (!tband) continue;
  const tlabels: EmitLabels = {
    client_mac: tmac,
    hostname: hostnameOf(tmac),
    via: "gateway",
    band: tband,
    wlan_idx: wlanIdx,
  };
  emitSignal("wifi.client.rssi", t.SignalStrength, tlabels);
  emitPositive("wifi.client.tx_rate", t.LastDataTransmitRate, tlabels);
}

// --- 3. Wi-Fi Data Elements stations ------------------------------------
//
// Every client on every node of an EasyMesh network, which is how a
// client on an extender reaches the per-client history at all. The tree
// is Device.WiFi.DataElements on a TR-181 CPE; some TR-098 gateways
// expose the same tree under InternetGatewayDevice.DataElements.
//
// STA.SignalStrength is RCPI, not dBm: an unsigned 0 to 220 where
// dBm = raw/2 - 110. Hardware in service reports it that way (68 to 162
// read, which is -76 to -29 dBm), and a rule that kept only negative
// values emitted nothing for any station on any such device. The
// encoding is the rule's dataElementsSignal config key, rcpi by default,
// dbm for a firmware that reports dBm. A raw 0 is the no-measurement
// placeholder in both encodings.
//
// The node a station was read on is the Device.{i}.ID MAC. It is the
// gateway when it is the network's ControllerID; without a ControllerID
// in the batch, Device.1 is taken as the gateway, which is the order
// every implementation observed so far reports.

function deSignalDbm(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const raw = parseFloat(String(v));
  if (isNaN(raw) || raw === 0) return null;
  const dbm = SECTION_DE_RSSI_ENCODING === "rcpi" ? raw / 2 - 110 : raw;
  return dbm < 0 ? dbm : null;
}

const deRoots = ["Device.WiFi.DataElements.Network.", "InternetGatewayDevice.DataElements.Network."];
for (let di = 0; di < deRoots.length; di++) {
  const root = deRoots[di];
  const nodes = batch.matches(root + "Device.*");
  if (nodes.length === 0) continue;

  const nodeMac: Record<string, string> = {};
  for (let ni = 0; ni < nodes.length; ni++) {
    const m = normaliseMac(nodes[ni].ID);
    if (m) nodeMac[nodes[ni].$indexes.Device] = m;
  }
  const controller = normaliseMac(batch.params[root + "ControllerID"]) || nodeMac["1"] || null;

  // Device index + "." + radio index -> band, from the operating class,
  // else the index table.
  const deRadioBand: Record<string, string> = {};
  const classes = batch.matches(root + "Device.*.Radio.*.CurrentOperatingClasses.*");
  for (let ki = 0; ki < classes.length; ki++) {
    const k = classes[ki];
    const key = k.$indexes.Device + "." + k.$indexes.Radio;
    if (deRadioBand[key]) continue;
    const b = bandFromOpClass(k.Class);
    if (b) deRadioBand[key] = b;
  }

  const stations = batch.matches(root + "Device.*.Radio.*.BSS.*.STA.*");
  for (let si2 = 0; si2 < stations.length; si2++) {
    const s = stations[si2];
    const smac = normaliseMac(s.MACAddress);
    if (!smac) continue;
    if (isInactive(s.Active)) continue;
    const idx = s.$indexes;
    const band = deRadioBand[idx.Device + "." + idx.Radio] || DE_RADIO_BAND_FALLBACK[idx.Radio];
    if (!band) continue;
    const node = nodeMac[idx.Device] || null;
    const labels: EmitLabels = {
      client_mac: smac,
      hostname: (s.Hostname as string | undefined) || hostnameOf(smac),
      via: node && controller && node !== controller ? "extender" : "gateway",
      band,
      node,
    };
    const rssi = deSignalDbm(s.SignalStrength);
    if (rssi !== null) emit("wifi.client.rssi", rssi, labels);
    emitPositive("wifi.client.tx_rate", s.LastDataDownlinkRate, labels);
    emitPositive("wifi.client.rx_rate", s.LastDataUplinkRate, labels);
    emitCount("wifi.client.retrans_count", s.RetransCount, labels);
    emitCount("wifi.client.bytes_tx", s.BytesSent, labels);
    emitCount("wifi.client.bytes_rx", s.BytesReceived, labels);
    emitPositive("wifi.client.assoc_seconds", s.LastConnectTime, labels);
    emitCount("wifi.client.btm_attempts", s["MultiAPSTA.SteeringSummaryStats.BTMAttempts"], labels);
    emitCount("wifi.client.btm_successes", s["MultiAPSTA.SteeringSummaryStats.BTMSuccesses"], labels);
    emitCount("wifi.client.blacklist_attempts", s["MultiAPSTA.SteeringSummaryStats.BlacklistAttempts"], labels);
    emitCount("wifi.client.blacklist_successes", s["MultiAPSTA.SteeringSummaryStats.BlacklistSuccesses"], labels);
  }
}
