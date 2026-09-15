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
// and use AP/WLAN index → band lookup tables (no vendor field for
// per-radio band on a synthetic CPE).

// AP/WLAN index → band fallback. Tweak per CPE if the natural index→band
// mapping differs (this profile assumes 1=2.4GHz main, 2=2.4GHz guest,
// 3=5GHz main, 4=5GHz guest, matching the cpe-labs example profiles).
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

// A TR-069/TR-369 boolean is "0"/"1" or "false"/"true" on the wire.
// Only an explicit not-active reading skips the client; an absent
// field (a profile that does not collect Active) is not treated as
// inactive, so the negative-dBm guard below still carries it.
function isInactive(v: unknown): boolean {
  return v === "0" || v === "false" || v === false;
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
    band: resolveBand(apIdx),
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
const tr098Clients = batch.matches(
  "InternetGatewayDevice.LANDevice.*.WLANConfiguration.*.AssociatedDevice.*",
);
for (let ti = 0; ti < tr098Clients.length; ti++) {
  const t = tr098Clients[ti];
  const tmac = normaliseMac(t.AssociatedDeviceMACAddress);
  if (!tmac) continue;
  if (isInactive(t.Active)) continue;
  const wlanIdx = t.$indexes.WLANConfiguration;
  const thost = hostByMac[tmac];
  const tlabels = {
    client_mac: tmac,
    hostname: thost ? thost.hostname : null,
    via: "gateway",
    band: resolveBand(wlanIdx),
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
