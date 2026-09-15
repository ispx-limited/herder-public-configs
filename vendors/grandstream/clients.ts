// Per-client Wi-Fi signal for Grandstream APs, banded by the radio.
//
// The signal itself is the standard AssociatedDevice.SignalStrength, so
// the generic labels rule already reads it, but the generic band
// fallback keys on the AccessPoint index (1,2 = 2.4 GHz, 3,4 = 5 GHz).
// A GWN7062 runs one AccessPoint per radio, so its 5 GHz clients sit
// under AccessPoint.2 and the generic rule mislabels them 2.4 GHz. Here
// the band is read from the radio the AccessPoint runs on
// (AccessPoint.{i} -> Radio.{i} by order), so it is the value the CPE
// reports rather than a guess.

(function () {
  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function toInt(s: unknown): number | null {
    if (typeof s !== "string" && typeof s !== "number") return null;
    const n = parseInt(String(s), 10);
    return isNaN(n) ? null : n;
  }
  function bandOf(raw: unknown): string {
    const b = (typeof raw === "string" ? raw : "").toLowerCase().replace(/ /g, "");
    if (b.indexOf("6g") >= 0) return "6GHz";
    if (b.indexOf("5g") >= 0) return "5GHz";
    if (b.indexOf("2.4") >= 0 || b.indexOf("2g") >= 0) return "2.4GHz";
    return "unknown";
  }

  const clients = batch.matches("Device.WiFi.AccessPoint.*.AssociatedDevice.*");
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const cmac = mac(c.MACAddress);
    if (!cmac) continue;
    if (c.Active === "0" || c.Active === "false") continue;
    const apIdx = c.$indexes.AccessPoint;
    const band = bandOf(batch.params["Device.WiFi.Radio." + apIdx + ".OperatingFrequencyBand"]);
    const labels = { client_mac: cmac, via: "gateway", band: band, ap_idx: apIdx };
    const rssi = toInt(c.SignalStrength);
    if (rssi !== null && rssi < 0) emit("wifi.client.rssi", rssi, labels);
    const dl = toInt(c.LastDataDownlinkRate);
    if (dl !== null && dl > 0) emit("wifi.client.tx_rate", dl, labels);
  }
})();
