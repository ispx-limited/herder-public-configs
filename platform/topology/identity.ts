// identity.ts — the MACs this device reports as its own interfaces.
//
// One `topology.identity` row per address, label `mac` in canonical
// form (lowercase, colon separated). The read side keeps every row a
// device has ever emitted, keyed by the address, so a batch that
// carries only some of the interfaces adds to the set rather than
// replacing it; there is no snapshot to keep whole here.
//
// Standard trees only. InternetGatewayDevice: the LAN Ethernet
// interfaces and the WAN connection. Device: the Ethernet interfaces
// and links. Nothing from Hosts, AssociatedDevice or a neighbour scan,
// which name other units.

(function () {
  const own: RegExp[] = [
    /^InternetGatewayDevice\.LANDevice\.\d+\.LANEthernetInterfaceConfig\.\d+\.MACAddress$/,
    /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WAN(IP|PPP)Connection\.\d+\.MACAddress$/,
    /^Device\.Ethernet\.(Interface|Link)\.\d+\.MACAddress$/,
  ];

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
    let isOwn = false;
    for (let i = 0; i < own.length; i++) {
      if (own[i].test(path)) {
        isOwn = true;
        break;
      }
    }
    if (!isOwn) continue;
    const mac = canonical(params[path]);
    if (!mac || emitted[mac]) continue;
    emitted[mac] = true;
    emit("topology.identity", 1, { mac: mac });
  }
})();
