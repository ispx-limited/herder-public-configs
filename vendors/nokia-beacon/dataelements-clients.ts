// Per-client Wi-Fi signal for the radar, from the Beacon DataElements
// STA table.
//
// The generic labels rule reads the gateway's own AssociatedDevice
// table, so a client on an extender never reached the radar. The
// DataElements STA table lists every client on every mesh node, so this
// emits wifi.client.rssi for all of them. Same root discovery and the
// same negative-dBm guard as the topology script: an idle station
// reports 0, which is not a signal.

(function () {
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
    const rssi = toInt(s.SignalStrength);
    if (rssi !== null && rssi < 0) emit("wifi.client.rssi", rssi, labels);
    const dl = toInt(s.LastDataDownlinkRate);
    if (dl !== null && dl > 0) emit("wifi.client.tx_rate", dl, labels);
  }
})();
