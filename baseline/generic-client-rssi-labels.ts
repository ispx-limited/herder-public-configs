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
// Both sections correlate against Hosts.Host for hostname/IP enrichment
// and label each client with the band of the radio its AP runs on
// (TR-181 OperatingFrequencyBand, TR-098 channel), not an index guess.

// Last-resort AP/WLAN index → band table, used only when the band
// cannot be read from the radio the AP runs on (below). A CPE with more
// than two SSIDs per radio, or a non-standard SSID ordering, does not
// follow this pattern (a Nokia Beacon exposes eight APs, 1-4 on 2.4GHz
// and 5-8 on 5GHz), so the radio lookup is always tried first and this
// only carries a synthetic CPE that omits the OperatingFrequencyBand /
// Channel leaves entirely.
const AP_BAND_FALLBACK: Record<string, string> = {
  "1": "2.4GHz",
  "2": "2.4GHz",
  "3": "5GHz",
  "4": "5GHz",
};

// TR-181 OperatingFrequencyBand is "2.4GHz" | "5GHz" | "6GHz"; some
// firmware inserts a space ("2.4 GHz"). Fold to the canonical spelling
// the dashboards group on, or null when it is not one of the three.
function normaliseBand(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, "").toLowerCase();
  if (s.startsWith("2.4")) return "2.4GHz";
  if (s.startsWith("5")) return "5GHz";
  if (s.startsWith("6")) return "6GHz";
  return null;
}

// A 2.4GHz channel is 1-14; anything above is 5GHz. 6GHz reuses the low
// channel numbers, so channel alone cannot name it, but no TR-098 CPE
// (the only caller of this) reports a 6GHz radio, so the two-way split
// is safe there. Returns null for a missing or unparseable channel.
function bandFromChannel(v: unknown): string | null {
  const ch = toInt(v);
  if (ch === null || ch <= 0) return null;
  return ch <= 14 ? "2.4GHz" : "5GHz";
}

// Strip the optional trailing dot a CPE may put on a path reference so
// "Device.WiFi.SSID.5." and "Device.WiFi.SSID.5" key the same map entry.
function refPath(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  return v.replace(/\.$/, "");
}

function normaliseMac(s: unknown): string | null {
  if (typeof s !== "string") return null;
  return s.toLowerCase().replace(/-/g, ":");
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

// --- Band lookup: derive the AP's band from the radio it runs on --------
//
// The authoritative source is the radio's OperatingFrequencyBand, reached
// from the AP by AccessPoint.SSIDReference -> SSID.LowerLayers -> Radio.
// The bundled TR-181 telemetry profile collects all three leaves, so this
// resolves for any conforming CPE regardless of how many SSIDs it exposes
// or in what order. Only when the chain is broken (a leaf the CPE does not
// report) does it fall back to the index table.

// Radio instance path ("Device.WiFi.Radio.2") -> canonical band.
const radioBand: Record<string, string> = {};
const radios = batch.matches("Device.WiFi.Radio.*");
for (let ri = 0; ri < radios.length; ri++) {
  const r = radios[ri];
  const band = normaliseBand(r.OperatingFrequencyBand);
  if (band) radioBand["Device.WiFi.Radio." + r.$indexes.Radio] = band;
}

// SSID instance path ("Device.WiFi.SSID.5") -> radio instance path, from
// the SSID's LowerLayers (a WiFi SSID has exactly one lower radio).
const ssidToRadio: Record<string, string> = {};
const ssids = batch.matches("Device.WiFi.SSID.*");
for (let si = 0; si < ssids.length; si++) {
  const s = ssids[si];
  const lower = refPath((s.LowerLayers as string | undefined || "").split(",")[0]);
  if (lower) ssidToRadio["Device.WiFi.SSID." + s.$indexes.SSID] = lower;
}

// AccessPoint index -> canonical band, resolved via that AP's referenced
// SSID and its radio. Built from the AccessPoint instances (the associated
// client rows the emit loop walks do not carry SSIDReference themselves).
// Falls back to the index table only when the chain is broken.
const apBand: Record<string, string> = {};
const accessPoints = batch.matches("Device.WiFi.AccessPoint.*");
for (let ai = 0; ai < accessPoints.length; ai++) {
  const ap = accessPoints[ai];
  const apIdx = ap.$indexes.AccessPoint;
  const ssidPath = refPath(ap.SSIDReference);
  const radioPath = ssidPath ? ssidToRadio[ssidPath] : null;
  const band = radioPath ? radioBand[radioPath] : null;
  apBand[apIdx] = band || AP_BAND_FALLBACK[apIdx] || "unknown";
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

// --- 1. TR-181 gateway-attached clients ---------------------------------
const tr181Clients = batch.matches("Device.WiFi.AccessPoint.*.AssociatedDevice.*");
for (let ci = 0; ci < tr181Clients.length; ci++) {
  const c = tr181Clients[ci];
  const mac = normaliseMac(c.MACAddress);
  if (!mac) continue;
  // A client the CPE marks not-active has disassociated or gone to
  // sleep; its SignalStrength/rate leaves read 0, the vendor's "no
  // measurement" placeholder, not a real value. Skip it so it does
  // not land on the radar as a 0 dBm spoke.
  if (isInactive(c.Active)) continue;
  const apIdx = c.$indexes.AccessPoint;
  const host = hostByMac[mac];
  const labels = {
    client_mac: mac,
    hostname: host ? host.hostname : null,
    via: "gateway",
    band: apBand[apIdx] || "unknown",
    ap_idx: apIdx,
  };
  // TR-181 SignalStrength is dBm, always negative for an associated
  // client. 0 (or positive) is the same no-measurement placeholder, so
  // only a negative reading is emitted.
  const rssi = toInt(c.SignalStrength);
  if (rssi !== null && rssi < 0) {
    emit("wifi.client.rssi", rssi, labels);
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

// "<lanDev>.<wlan>" -> band from the WLANConfiguration's channel. TR-098
// has no per-radio band leaf; the channel is authoritative for the 2.4 vs
// 5GHz split and the telemetry profile collects it. Index table is the
// last resort for a CPE that omits Channel.
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
  const thost = hostByMac[tmac];
  const tlabels = {
    client_mac: tmac,
    hostname: thost ? thost.hostname : null,
    via: "gateway",
    band: wlanBand[wlanKey] || AP_BAND_FALLBACK[wlanIdx] || "unknown",
    wlan_idx: wlanIdx,
  };
  const trssi = toInt(t.SignalStrength);
  if (trssi !== null && trssi < 0) {
    emit("wifi.client.rssi", trssi, tlabels);
  }
  const ttx = t.LastDataTransmitRate as string | undefined;
  if (ttx !== undefined && ttx !== "") {
    emit("wifi.client.tx_rate", toInt(ttx), tlabels);
  }
}
