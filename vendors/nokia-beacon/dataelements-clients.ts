// Per-client Wi-Fi signal for the radar, from the Beacon DataElements
// STA table.
//
// The generic labels rule reads the gateway's own AssociatedDevice
// table, so a client on an extender never reached the radar. The
// DataElements STA table lists every client on every mesh node, so this
// emits wifi.client.rssi for all of them. Same root discovery and the
// same signal handling as the topology script.
//
// THE SIGNAL IS RCPI, NOT dBm. Data Elements defines STA.SignalStrength
// as an RCPI-style unsigned value (0-220, dBm = raw/2 - 110), and the
// Beacons report exactly that: a production fleet read 68 to 162, which
// is -76 to -29 dBm. The first version of this rule kept only negative
// values, so it emitted nothing for any station on any Beacon and the
// per-client signal stayed empty fleet-wide. The encoding is a rule
// config key with the vendor's default, as platform/topology/
// easymesh-default does, so a firmware that switches to dBm is one
// line of YAML. A raw 0 is the no-measurement placeholder in both
// encodings and is never emitted.

(function () {
  const rssiEncoding = String(ctx.configGet("rssiEncoding", "rcpi"));
  function toDbm(v: unknown): number | null {
    if (typeof v !== "string" && typeof v !== "number") return null;
    const raw = parseFloat(String(v));
    if (isNaN(raw) || raw === 0) return null;
    const dbm = rssiEncoding === "rcpi" ? raw / 2 - 110 : raw;
    return dbm < 0 ? dbm : null;
  }
  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function toInt(s: unknown): number | null {
    if (typeof s !== "string" && typeof s !== "number") return null;
    const n = parseInt(String(s), 10);
    return isNaN(n) ? null : n;
  }
  // Nokia radios: 1 is 2.4 GHz, 2 is 5 GHz, 3 (when present) is 6 GHz.
  const BAND: Record<string, string> = { "1": "2.4GHz", "2": "5GHz", "3": "6GHz" };

  const roots = [
    "Device.WiFi.DataElements.Network.",
    "InternetGatewayDevice.DataElements.Network.",
  ];
  let root = "";
  for (let i = 0; i < roots.length; i++) {
    if (batch.matches(roots[i] + "Device.*").length > 0) { root = roots[i]; break; }
  }
  if (!root) return;

  const stations = batch.matches(root + "Device.*.Radio.*.BSS.*.STA.*");
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const cmac = mac(s.MACAddress);
    if (!cmac) continue;
    if (s.Active === "0" || s.Active === "false") continue;
    const labels = {
      client_mac: cmac,
      hostname: (s.Hostname as string | undefined) || null,
      via: "mesh",
      band: BAND[s.$indexes.Radio] || "unknown",
      node: mac(batch.params[root + "Device." + s.$indexes.Device + ".ID"]) || null,
    };
    const rssi = toDbm(s.SignalStrength);
    if (rssi !== null) emit("wifi.client.rssi", rssi, labels);
    const dl = toInt(s.LastDataDownlinkRate);
    if (dl !== null && dl > 0) emit("wifi.client.tx_rate", dl, labels);
  }
})();
