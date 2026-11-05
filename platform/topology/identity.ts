// identity.ts — the MACs this device reports as its own interfaces.
//
// One `topology.identity` row per address, label `mac` in canonical
// form (lowercase, colon separated). The read side keeps every row a
// device has ever emitted, keyed by the address, so a batch that
// carries only some of the interfaces adds to the set rather than
// replacing it; there is no snapshot to keep whole here.
//
// Standard trees only. InternetGatewayDevice: the LAN Ethernet
// interfaces, the WAN connection and the BSSIDs. Device: the Ethernet
// interfaces and links, and the SSIDs' BSSID and MAC. Nothing from
// Hosts, AssociatedDevice or a neighbour scan, which name other units.
//
// The BSSIDs are here because a wireless extender associates to its
// gateway from a radio address, not an Ethernet one: an X5042 behind a
// FAST5598 is in the gateway's host table under its first BSSID and
// under nothing Device.Ethernet reports.
//
// Except on the interface that is the backhaul. TR-181 models an
// extender's station side as an SSID too, and on that one BSSID is the
// access point it is associated to, the gateway's, while MACAddress is
// the extender's own radio. An SSID whose two addresses differ is such
// a station, so only its MACAddress is its own; one that reports a
// single address, or the same one twice, is an access point and the
// address is its own either way. Emitting the station's BSSID claimed
// the gateway's radio for the extender, and an address two devices
// claim links neither.

(function () {
  const own: RegExp[] = [
    /^InternetGatewayDevice\.LANDevice\.\d+\.LANEthernetInterfaceConfig\.\d+\.MACAddress$/,
    /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WAN(IP|PPP)Connection\.\d+\.MACAddress$/,
    /^InternetGatewayDevice\.LANDevice\.\d+\.WLANConfiguration\.\d+\.BSSID$/,
    /^Device\.Ethernet\.(Interface|Link)\.\d+\.MACAddress$/,
    /^Device\.WiFi\.SSID\.\d+\.MACAddress$/,
  ];
  // An SSID's BSSID is its own only when the batch does not say
  // otherwise with a different MACAddress beside it.
  const ssidBssid = /^Device\.WiFi\.SSID\.(\d+)\.BSSID$/;
  function bssidIsOwn(path: string): boolean {
    const m = path.match(ssidBssid);
    if (!m) return false;
    const mac = batch.params["Device.WiFi.SSID." + m[1] + ".MACAddress"];
    if (typeof mac !== "string" || mac === "") return true;
    return canonical(mac) === canonical(batch.params[path]);
  }

  function canonical(raw: string): string | null {
    const mac = raw.trim().toLowerCase().replace(/-/g, ":");
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return null;
    // A zeroed address is what an interface reports before it has one;
    // it belongs to nobody.
    if (mac === "00:00:00:00:00:00") return null;
    return mac;
  }

  const emitted: Record<string, boolean> = {};
  const params = batch.params;
  for (const path in params) {
    if (!Object.prototype.hasOwnProperty.call(params, path)) continue;
    let isOwn = bssidIsOwn(path);
    for (let i = 0; i < own.length && !isOwn; i++) {
      if (own[i].test(path)) isOwn = true;
    }
    if (!isOwn) continue;
    const mac = canonical(params[path]);
    if (!mac || emitted[mac]) continue;
    emitted[mac] = true;
    emit("topology.identity", 1, { mac: mac });
  }
})();
