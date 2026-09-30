// Per-client Wi-Fi signal for the Nokia FastMile, from the host table.
//
// The generic labels rule reads AccessPoint.{i}.AssociatedDevice, which
// this firmware does not have, so no FastMile client ever reached the
// radar. The host table carries the same facts as vendor leaves:
// X_ALU-COM_WifiRSSI is the signal in dBm and X_ALU-COM_WifiBand the
// band, spelled "2G" or "5G". A wired host, and a wireless one the unit
// has no reading for, report 0 and an empty band, and are skipped: only
// a negative reading is a measurement.
//
// The band falls back to the radio Layer1Interface names, so a host
// with a reading and an empty band leaf is still labelled by what the
// radio reports rather than dropped.

(function () {
  function isInactive(v: unknown): boolean {
    return v === "0" || v === "false" || v === false;
  }
  function mac(s: unknown): string {
    return typeof s === "string" ? s.trim().toLowerCase().replace(/-/g, ":") : "";
  }
  function bandOf(raw: unknown): string {
    const b = (typeof raw === "string" ? raw : "").toUpperCase().replace(/ /g, "");
    if (b.indexOf("6G") === 0) return "6GHz";
    if (b.indexOf("5G") === 0) return "5GHz";
    if (b.indexOf("2G") === 0 || b.indexOf("2.4") === 0) return "2.4GHz";
    return "";
  }

  const seen: Record<string, boolean> = {};
  const hosts = batch.matches("Device.Hosts.Host.*");
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const cmac = mac(h.PhysAddress);
    if (!cmac || seen[cmac]) continue;
    if (isInactive(h.Active)) continue;

    const rssi = parseInt(String(h["X_ALU-COM_WifiRSSI"] || ""), 10);
    if (isNaN(rssi) || rssi >= 0) continue;

    const layer1 = String(h.Layer1Interface || "");
    const radio = layer1.match(/^Device\.WiFi\.Radio\.(\d+)/);
    const band = bandOf(h["X_ALU-COM_WifiBand"])
      || (radio ? bandOf(batch.params["Device.WiFi.Radio." + radio[1] + ".OperatingFrequencyBand"]) : "")
      || "unknown";
    const ap = String(h.AssociatedDevice || "").match(/^Device\.WiFi\.AccessPoint\.(\d+)\./);

    seen[cmac] = true;
    emit("wifi.client.rssi", rssi, {
      client_mac: cmac,
      hostname: (h.HostName as string | undefined) || null,
      via: "gateway",
      band: band,
      ap_idx: ap ? ap[1] : null,
    });
  }
})();
