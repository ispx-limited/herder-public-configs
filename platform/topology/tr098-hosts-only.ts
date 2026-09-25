// tr098-hosts-only.ts: flat topology for TR-098-only devices.
//
// No extender hierarchy (TR-098 doesn't carry one without vendor
// extensions). Emits a single gateway node plus every Hosts.Host as a
// client connected directly to it. Operators wanting mesh fidelity bind
// a vendor script that walks the vendor's own mesh table.
//
// A client node carries what the host table says about it, not a
// hostname and one address. Everything read here is standard TR-098, so
// every vendor on this data model gets it: Active, AddressSource,
// InterfaceType, LeaseTimeRemaining, the MAC and the addresses.
//
// Addresses are a set, not a field. A host has one IPAddress and as
// many IPv6Address.{i} entries as it has acquired, and a client reached
// over v6 is not an exception to handle later. `ipv4` and `ipv6` carry
// the first routable of each; `ipv4_all` and `ipv6_all` carry the rest,
// comma separated, and are omitted when they would only repeat the
// single value above.
//
// Comma separated because a node property is a string. The emit side
// stringifies whatever it is handed with fmt.Sprint, so an array of
// objects reaches the UI as `[map[address:192.168.1.4 family:ipv4]]`,
// which is how this shipped for one evening. Anything structured has to
// be encoded deliberately or not sent.
//
// The family is parsed from the address, never inferred from the path
// it arrived on, because a vendor putting a v6 address in IPAddress is
// within spec and several do. Link-local is read and then dropped: it
// identifies nothing off its own segment, so it is noise in a panel and
// useless as a target for a diagnostic.
//
// The band is resolved, not assumed. This rule used to call every
// wireless client wifi_5g, which put 2.4 GHz clients on the wrong radio
// in every view built on the graph. Layer2Interface names the
// WLANConfiguration the host is associated through and that object
// carries the band; where neither band nor channel can be read the edge
// is `other`, which is what "wireless, band unknown" honestly is.

(function () {
  const includeInactive: boolean = ctx.configGet<boolean>("includeInactiveHosts", false);

  const HOSTS = "InternetGatewayDevice.LANDevice.1.Hosts.Host.";
  const WLAN = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.";

  const gatewayMAC = (
    batch.params["InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress"]
    || ""
  ).toLowerCase();

  if (!gatewayMAC) {
    enrichment.warn("tr098-hosts-only: no gateway MAC found in LANEthernetInterfaceConfig.1");
    return;
  }

  topology.addNode({
    id: gatewayMAC,
    type: "gateway",
    managed_device_id: device.id,
    manufacturer: device.manufacturer,
    model: device.model,
    firmware: device.firmware,
    serial: device.serialNumber,
  });

  // A colon is legal only in v6; four dot-separated octets is v4.
  // Anything else is not an address worth publishing.
  function family(addr: string): string | null {
    if (addr.indexOf(":") >= 0) return "ipv6";
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return "ipv4";
    return null;
  }

  // A link-local address identifies nothing off its own segment, so it
  // is carried in the set but never offered as the host's address.
  function routable(addr: string, fam: string): boolean {
    if (fam === "ipv6") return addr.toLowerCase().indexOf("fe80") !== 0;
    return addr.indexOf("169.254.") !== 0;
  }

  const addrsByHost: Record<string, { address: string; family: string }[]> = {};
  function collect(pattern: string) {
    const rows = batch.matches(pattern);
    for (let i = 0; i < rows.length; i++) {
      const idx = rows[i].$indexes.Host;
      const raw = rows[i].IPAddress;
      if (typeof raw !== "string" || raw === "") continue;
      const fam = family(raw);
      if (!fam) continue;
      if (!addrsByHost[idx]) addrsByHost[idx] = [];
      addrsByHost[idx].push({ address: raw, family: fam });
    }
  }
  collect(HOSTS + "*.IPv4Address.*.IPAddress");
  collect(HOSTS + "*.IPv6Address.*.IPAddress");

  // The band each WLANConfiguration instance runs on. The declared band
  // where the firmware has one, otherwise the channel, which is
  // unambiguous at 14 and below.
  const bandByWLAN: Record<string, string> = {};
  const wlans = batch.matches(WLAN + "*.Channel");
  for (let i = 0; i < wlans.length; i++) {
    const idx = wlans[i].$indexes.WLANConfiguration;
    const declared = String(
      batch.params[WLAN + idx + ".OperatingFrequencyBand"]
      || batch.params[WLAN + idx + ".X_0000C5_OperatingFrequencyBand"]
      || "",
    );
    if (declared.indexOf("2.4") >= 0) { bandByWLAN[idx] = "wifi_2g"; continue; }
    if (declared.indexOf("6") === 0) { bandByWLAN[idx] = "wifi_6g"; continue; }
    if (declared.indexOf("5") === 0) { bandByWLAN[idx] = "wifi_5g"; continue; }
    const ch = parseInt(String(wlans[i].Channel), 10);
    if (!isNaN(ch) && ch > 0 && ch <= 14) bandByWLAN[idx] = "wifi_2g";
    else if (!isNaN(ch) && ch >= 32) bandByWLAN[idx] = "wifi_5g";
  }

  const hosts = batch.matches(HOSTS + "*");
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const mac = ((h.MACAddress as string | undefined) || "").toLowerCase();
    if (!mac) continue;
    const active = (h.Active as string | undefined) || "";
    if (!includeInactive && (active === "false" || active === "0")) continue;

    const addrs = addrsByHost[h.$indexes.Host] || [];

    // TR-098's IPAddress is the host's primary and declares no family,
    // so it is parsed like the rest and added if the tables missed it.
    const primary = (h.IPAddress as string | undefined) || "";
    const primaryFam = primary ? family(primary) : null;
    if (primaryFam) {
      let known = false;
      for (let k = 0; k < addrs.length; k++) {
        if (addrs[k].address === primary) { known = true; break; }
      }
      if (!known) addrs.unshift({ address: primary, family: primaryFam });
    }

    const v4: string[] = [];
    const v6: string[] = [];
    for (let k = 0; k < addrs.length; k++) {
      const a = addrs[k];
      if (!routable(a.address, a.family)) continue;
      if (a.family === "ipv4" && v4.indexOf(a.address) < 0) v4.push(a.address);
      if (a.family === "ipv6" && v6.indexOf(a.address) < 0) v6.push(a.address);
    }

    const lease = parseInt(String(h.LeaseTimeRemaining || ""), 10);
    const ifType = (h.InterfaceType as string | undefined) || "";

    topology.addNode({
      id: mac,
      type: "client",
      hostname: (h.HostName as string | undefined) || undefined,
      ipv4: v4.length > 0 ? v4[0] : undefined,
      ipv6: v6.length > 0 ? v6[0] : undefined,
      ipv4_all: v4.length > 1 ? v4.join(", ") : undefined,
      ipv6_all: v6.length > 1 ? v6.join(", ") : undefined,
      active: active === "true" || active === "1" ? true
        : active === "false" || active === "0" ? false
          : undefined,
      address_source: (h.AddressSource as string | undefined) || undefined,
      interface_type: ifType || undefined,
      lease_remaining_s: !isNaN(lease) ? lease : undefined,
    });

    // Wired where the host says so, otherwise the band of the WLAN it
    // associated through, otherwise wireless with the band unknown.
    let edgeType = "other";
    const layer2 = (h.Layer2Interface as string | undefined)
      || (h.Layer1Interface as string | undefined) || "";
    if (ifType.indexOf("Ethernet") >= 0 || layer2.indexOf("LANEthernetInterfaceConfig") >= 0) {
      edgeType = "ethernet";
    } else {
      const m = /WLANConfiguration\.(\d+)/.exec(layer2);
      if (m && bandByWLAN[m[1]]) edgeType = bandByWLAN[m[1]];
    }

    topology.addEdge({
      parent: gatewayMAC,
      child: mac,
      edge_type: edgeType as TopologyEdge["edge_type"],
    });
  }
})();
