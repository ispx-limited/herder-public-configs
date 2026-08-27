// Generic per-client WiFi label enrichment.
//
// Same shape as arris-client-rssi-labels.ts but walks only standard
// TR-098 / TR-181 paths — no vendor X_OUI_* extensions — so it works
// against any conforming CPE (lab simulators, and any baseline
// firmware that hasn't had a vendor profile written yet).
//
// Sections:
//   1. TR-181 gateway-attached clients via Device.WiFi.AccessPoint.*.AssociatedDevice.*
//   2. TR-098 gateway-attached clients via InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*
//
// Both sections correlate against Hosts.Host for hostname/IP enrichment.
//
// On TR-181 the band is read from the device, by walking the chain the
// data model standardises: an access point names its SSID in
// SSIDReference, an SSID names its radio in LowerLayers, and the radio
// reports OperatingFrequencyBand. The baseline WiFi telemetry profile
// already collects all three.
//
// An index table cannot answer this. Which radio sits behind which
// access point is a per-model layout, and a gateway with a 6 GHz radio
// has a band no fixed table lists: a five-port WiFi 7 gateway whose
// access points run 2.4, 5 and 6 GHz in order was labelled 2.4, 2.4,
// 5 by the table this replaced, and its guest and backhaul access
// points were labelled unknown.

// Used only for a device that does not publish the chain above. The
// first two indexes are the one layout common enough to be worth a
// guess (a main and a guest network on 2.4 GHz, then 5 GHz); anything
// else is left unknown rather than guessed wrong.
const AP_BAND_FALLBACK: Record<string, string> = {
  "1": "2.4GHz",
  "2": "2.4GHz",
  "3": "5GHz",
  "4": "5GHz",
};

function normaliseMac(s: unknown): string | null {
  if (typeof s !== "string") return null;
  return s.toLowerCase().replace(/-/g, ":");
}

function toInt(s: unknown): number | null {
  if (typeof s !== "string" && typeof s !== "number") return null;
  const n = parseInt(String(s), 10);
  return isNaN(n) ? null : n;
}

// The trailing instance number of a path reference. TR-181 writes these
// as full paths ("Device.WiFi.SSID.2"), with or without a trailing dot.
function refIndex(s: unknown): string {
  if (typeof s !== "string") return "";
  const m = s.replace(/\.$/, "").match(/(\d+)$/);
  return m ? m[1] : "";
}

// Spelling only: a device writing "2.4 GHz" must group with one
// writing "2.4GHz". The value itself is the device's.
function normaliseBand(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/\s+/g, "");
}

function resolveBand(idx: string): string {
  return AP_BAND_FALLBACK[idx] || "unknown";
}

// --- Lookup tables built once per invocation ----------------------------

interface HostMeta { hostname: string | null; ip: string | null; }

// MAC → {hostname, ip} from TR-181 Hosts.Host or TR-098
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

// AP index → band, walked through the objects TR-181 standardises.
// Each map is keyed by instance index; a device that omits any link in
// the chain falls back to the table above.
const bandByRadio: Record<string, string> = {};
const radios = batch.matches("Device.WiFi.Radio.*.OperatingFrequencyBand");
for (let ri = 0; ri < radios.length; ri++) {
  const r = radios[ri];
  bandByRadio[r.$indexes.Radio] = normaliseBand(r.OperatingFrequencyBand);
}
const radioBySsid: Record<string, string> = {};
const ssids = batch.matches("Device.WiFi.SSID.*.LowerLayers");
for (let si = 0; si < ssids.length; si++) {
  const s = ssids[si];
  radioBySsid[s.$indexes.SSID] = refIndex(s.LowerLayers);
}
const ssidByAp: Record<string, string> = {};
const aps = batch.matches("Device.WiFi.AccessPoint.*.SSIDReference");
for (let ai = 0; ai < aps.length; ai++) {
  const a = aps[ai];
  ssidByAp[a.$indexes.AccessPoint] = refIndex(a.SSIDReference);
}

function bandForAp(apIdx: string): string {
  const ssidIdx = ssidByAp[apIdx];
  const radioIdx = ssidIdx ? radioBySsid[ssidIdx] : "";
  const band = radioIdx ? bandByRadio[radioIdx] : "";
  return band || resolveBand(apIdx);
}

// --- 1. TR-181 gateway-attached clients ---------------------------------
const tr181Clients = batch.matches("Device.WiFi.AccessPoint.*.AssociatedDevice.*");
for (let ci = 0; ci < tr181Clients.length; ci++) {
  const c = tr181Clients[ci];
  const mac = normaliseMac(c.MACAddress);
  if (!mac) continue;
  const apIdx = c.$indexes.AccessPoint;
  const host = hostByMac[mac];
  const labels = {
    client_mac: mac,
    hostname: host ? host.hostname : null,
    via: "gateway",
    band: bandForAp(apIdx),
    ap_idx: apIdx,
  };
  const sigStr = c.SignalStrength as string | undefined;
  if (sigStr !== undefined && sigStr !== "") {
    emit("wifi.client.rssi", toInt(sigStr), labels);
  }
  const tx = c.LastDataDownlinkRate as string | undefined;
  if (tx !== undefined && tx !== "") {
    emit("wifi.client.tx_rate", toInt(tx), labels);
  }
  const rx = c.LastDataUplinkRate as string | undefined;
  if (rx !== undefined && rx !== "") {
    emit("wifi.client.rx_rate", toInt(rx), labels);
  }
}

// --- 2. TR-098 gateway-attached clients ---------------------------------
const tr098Clients = batch.matches(
  "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*",
);
for (let ti = 0; ti < tr098Clients.length; ti++) {
  const t = tr098Clients[ti];
  const tmac = normaliseMac(t.AssociatedDeviceMACAddress);
  if (!tmac) continue;
  const wlanIdx = t.$indexes.WLANConfiguration;
  const thost = hostByMac[tmac];
  const tlabels = {
    client_mac: tmac,
    hostname: thost ? thost.hostname : null,
    via: "gateway",
    band: resolveBand(wlanIdx),
    wlan_idx: wlanIdx,
  };
  const tsig = t.SignalStrength as string | undefined;
  if (tsig !== undefined && tsig !== "") {
    emit("wifi.client.rssi", toInt(tsig), tlabels);
  }
  const ttx = t.LastDataTransmitRate as string | undefined;
  if (ttx !== undefined && ttx !== "") {
    emit("wifi.client.tx_rate", toInt(ttx), tlabels);
  }
}
