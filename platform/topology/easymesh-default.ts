// easymesh-default.ts — TR-181 wifi topology emit (flat AP + optional MultiAP).
//
// Walks Device.WiFi.AccessPoint.{i}.AssociatedDevice.{j} for clients
// associated to the gateway's own radios (the flat-AP case that
// covers the modal TR-181 fleet). When the device also reports
// Device.WiFi.MultiAP.APDevice.{i}.* extender entries, those are
// emitted as extender nodes with their own AssociatedDevice tables
// hanging off them; clients show up under whichever AP saw them.
//
// Hostname / IPv4 / IPv6 cross-ref Device.Hosts.Host.* by MAC.
//
// Everything here is read from one telemetry batch. The stored
// parameter model is not reachable from an enrichment rule, so a path
// collected on an interval is present in one batch out of however many
// the interval spans and absent from the rest, and the rule cannot tell
// "the device does not report this" from "this batch does not carry
// it". Three paths decide a client's radio (AccessPoint.SSIDReference,
// SSID.LowerLayers, Radio.OperatingFrequencyBand) and every one of them
// must be collected at interval 0 for the join below to hold. Where a
// batch is missing them the rule now says so and falls back rather than
// guessing: an unresolved band is `other`, not 5 GHz.

(function () {
  const rssiEncoding: string = ctx.configGet<string>("rssiEncoding", "dbm");
  const includeInactive: boolean = ctx.configGet<boolean>("includeInactiveHosts", false);

  // A station the CPE marks not-active has disassociated or gone to
  // sleep; its SignalStrength reads 0, the vendor's "no measurement"
  // placeholder, not a real value.
  function isInactive(v: unknown): boolean {
    return v === "0" || v === "false" || v === false;
  }

  // Attach an RSSI overlay to one edge, but only for a real reading. A
  // raw 0 is the no-measurement placeholder in both encodings (rcpi 0
  // would otherwise convert to a plausible-looking -110), and a
  // non-negative dBm is the same placeholder read straight, so neither
  // is emitted: an unmeasured link carries no metric rather than a
  // 0 dBm one that paints as the strongest link on the map.
  function edgeRssi(sigStr: unknown, parent: string, child: string): void {
    if (typeof sigStr !== "string" || sigStr === "") return;
    const raw = parseFloat(sigStr);
    if (isNaN(raw) || raw === 0) return;
    const rssi = rssiEncoding === "rcpi" ? (raw / 2) - 110 : raw;
    if (rssi >= 0) return;
    topology.addEdgeMetric("rssi_dbm", rssi, { parent: parent, child: child });
  }

  // ---- Step 1: host metadata by MAC ----
  // Captures hostname / IPv4 / IPv6 for cross-ref in steps 3 + 5,
  // and the host's Layer1Interface so step 3.5 can identify wired
  // (Device.Ethernet.*) clients vs wireless (Device.WiFi.*).
  interface HostMeta {
    hostname: string;
    ipv4: string;
    ipv6: string;
    layer1: string;
    lease: string;
    addressSource: string;
  }
  const hostByMAC: Record<string, HostMeta> = {};
  const hosts = batch.matches("Device.Hosts.Host.*");
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const physAddr = (h.PhysAddress as string | undefined) || "";
    const mac = physAddr.toLowerCase();
    if (!mac) continue;
    if (!includeInactive && (h.Active as string | undefined) === "false") continue;

    const v6List = batch.matches(
      "Device.Hosts.Host." + h.$indexes.Host + ".IPv6Address.*.IPAddress",
    );
    const v6 = v6List.map(function (e) { return (e.IPAddress as string | undefined) || ""; }).join(",");

    hostByMAC[mac] = {
      hostname: (h.HostName as string | undefined) || "",
      ipv4: (h.IPAddress as string | undefined) || "",
      ipv6: v6,
      layer1: (h.Layer1Interface as string | undefined) || "",
      lease: (h.LeaseTimeRemaining as string | undefined) || "",
      addressSource: (h.AddressSource as string | undefined) || "",
    };
  }

  // Track which client MACs have been emitted as topology nodes so
  // the wired-host pass (step 3.5) doesn't double-emit clients
  // already attached via WiFi.
  const emittedClients: Record<string, boolean> = {};

  // ---- Step 2: gateway = the managed CPE itself ----
  //
  // Walk the TR-181 paths that carry a real 6-byte MAC for "this
  // gateway's identity", in priority order, stopping at the first
  // valid MAC we find. NEVER synthesise — a synthetic MAC corrupts
  // every downstream query (deep-link, history, replay), so when no
  // proper TR-181 path resolves we emit no gateway and let the panel
  // render an empty graph (the script still emits clients/extenders
  // if they have valid MACs of their own).
  //
  // The graph is drawn on the device page, so the device being
  // viewed IS the gateway — the script just needs a stable 6-byte
  // MAC to identify it as a graph node. Any MAC-bearing path defined
  // by TR-181 for this device qualifies; we walk them in priority
  // order:
  //
  // Priority chain, with TR-181 2.20.1 references:
  //   1. Device.WiFi.DataElements.Network.ControllerID — canonical
  //      EasyMesh controller identity, IEEE 1905 ALID (line 21779,
  //      since TR-181 issue 2 amendment 13). The standards-track
  //      replacement for the deleted Device.WiFi.MultiAP.* subtree.
  //   2. Device.WiFi.DataElements.Network.Device.1.ID — colocated
  //      agent's IEEE 1905 AL MAC (line 22129).
  //   3. Device.Ethernet.Link.1.MACAddress — the higher-protocol
  //      MAC used for outgoing packets (line 14516+). The Link.MAC
  //      is what other devices on the LAN see as "this gateway",
  //      whereas Interface.MAC is only the burned-in NIC.
  //   4. Device.Ethernet.Interface.1.MACAddress — burned-in NIC MAC
  //      (line 14141+); production devices may locally administer
  //      a different higher-layer MAC.
  //   5. Device.WiFi.SSID.1.BSSID — TR-181 line 21858: "the MAC
  //      address of the access point, which can either be local
  //      (when this instance models an access point SSID)". For a
  //      gateway, SSID.1 models a local access point, so BSSID is
  //      the gateway's WiFi-side MAC. Always populated on TR-181
  //      wifi gateways even when Ethernet/DataElements aren't.
  //   6. Device.WiFi.SSID.1.MACAddress — equivalent to BSSID per
  //      the same TR-181 object (line 21873): "If this instance
  //      models an access point SSID, MACAddress is the same as
  //      BSSID". Sibling fallback when only one of the pair is
  //      reported by a given firmware.
  //
  // The MAC validity test mirrors the assembler's CanonicalizeMAC:
  // exactly 12 hex digits after stripping colons / dashes. Failing
  // candidates are silently skipped so the chain can continue.
  function isValidMAC(s: string): boolean {
    const stripped = s.replace(/[:\-]/g, "");
    return /^[0-9a-f]{12}$/i.test(stripped);
  }

  const gatewayMACCandidates = [
    batch.params["Device.WiFi.DataElements.Network.ControllerID"],
    batch.params["Device.WiFi.DataElements.Network.Device.1.ID"],
    batch.params["Device.Ethernet.Link.1.MACAddress"],
    batch.params["Device.Ethernet.Interface.1.MACAddress"],
    batch.params["Device.WiFi.SSID.1.BSSID"],
    batch.params["Device.WiFi.SSID.1.MACAddress"],
  ];

  let gatewayMAC = "";
  for (let i = 0; i < gatewayMACCandidates.length; i++) {
    const candidate = (gatewayMACCandidates[i] || "").trim();
    if (candidate && isValidMAC(candidate)) {
      gatewayMAC = candidate.toLowerCase();
      break;
    }
  }

  // Only emit a gateway node when the priority walk above resolved a
  // real MAC. Without one, an empty graph is the correct output —
  // never a synthetic id.
  if (gatewayMAC) {
    topology.addNode({
      id: gatewayMAC,
      type: "gateway",
      managed_device_id: device.id,
      manufacturer: device.manufacturer,
      model: device.model,
      firmware: device.firmware,
      serial: device.serialNumber,
    });
  } else {
    log(
      "warn",
      "topology: no canonical TR-181 MAC found for gateway " +
        "(checked DataElements.Network.ControllerID, " +
        "DataElements.Network.Device.1.ID, " +
        "Ethernet.Link.1.MACAddress, Ethernet.Interface.1.MACAddress, " +
        "WiFi.SSID.1.BSSID, WiFi.SSID.1.MACAddress); " +
        "skipping gateway node — empty topology will be returned",
    );
    // Without a gateway MAC every downstream emission would be an
    // orphan or carry an empty parent string. Bail out so the
    // assembler returns an empty graph (the panel renders an empty
    // state, which is the correct UX for "device hasn't reported a
    // resolvable identity yet").
    return;
  }

  // Helper: look up the band for a Device.WiFi.AccessPoint.{i}. The
  // SSIDReference points at Device.WiFi.SSID.{j}, which has
  // LowerLayers pointing at Device.WiFi.Radio.{k}, which has
  // OperatingFrequencyBand. Falls back to "wifi_5g" when the chain
  // can't be resolved.
  type WifiEdgeType = "wifi_2g" | "wifi_5g" | "wifi_6g";
  function edgeTypeForAP(apIdx: string): WifiEdgeType {
    const ssidRef = batch.params["Device.WiFi.AccessPoint." + apIdx + ".SSIDReference"] || "";
    if (ssidRef === "") return "wifi_5g";
    const m = ssidRef.match(/Device\.WiFi\.SSID\.(\d+)/);
    if (!m) return "wifi_5g";
    const ssidIdx = m[1];
    const lowerLayers = batch.params["Device.WiFi.SSID." + ssidIdx + ".LowerLayers"] || "";
    const radioMatch = lowerLayers.match(/Device\.WiFi\.Radio\.(\d+)/);
    if (!radioMatch) return "wifi_5g";
    const radioIdx = radioMatch[1];
    const band = batch.params["Device.WiFi.Radio." + radioIdx + ".OperatingFrequencyBand"] || "";
    if (band === "2.4GHz") return "wifi_2g";
    if (band === "6GHz") return "wifi_6g";
    return "wifi_5g";
  }

  // A node property is a string, and an absent value must be absent
  // rather than the text "undefined".
  function str(v: unknown): string | undefined {
    return typeof v === "string" && v !== "" ? v : undefined;
  }

  // The band as an operator reads it, not as the data model spells it.
  function bandLabel(band: string): string | undefined {
    if (band === "2.4GHz") return "2.4 GHz";
    if (band === "5GHz") return "5 GHz";
    if (band === "6GHz") return "6 GHz";
    return undefined;
  }

  // The band a radio runs on, or "" when this batch cannot say.
  //
  // Matched on a substring because firmware spells the enum every way
  // the field allows ("2.4GHz", "2.4 GHz", "5GHz", "5GHz-6GHz"), and
  // falling back to the channel because OperatingFrequencyBand is the
  // path most often read on an interval while Channel is not. There is
  // deliberately no default: a radio whose band this batch cannot
  // resolve is unknown, and it used to be called 5 GHz, which put every
  // 2.4 GHz client of every device on the wrong radio on the map.
  function bandOf(radioIdx: string): string {
    if (!radioIdx) return "";
    const base = "Device.WiFi.Radio." + radioIdx + ".";
    const declared = String(batch.params[base + "OperatingFrequencyBand"] || "");
    if (declared.indexOf("2.4") >= 0) return "2.4GHz";
    if (declared.indexOf("6") === 0) return "6GHz";
    if (declared.indexOf("5") === 0) return "5GHz";
    const ch = parseInt(String(batch.params[base + "Channel"] || ""), 10);
    if (!isNaN(ch) && ch > 0 && ch <= 14) return "2.4GHz";
    if (!isNaN(ch) && ch >= 32 && ch < 200) return "5GHz";
    return "";
  }

  function channelOf(radioIdx: string): string {
    if (!radioIdx) return "";
    return String(batch.params["Device.WiFi.Radio." + radioIdx + ".Channel"] || "");
  }

  function bssidForAP(apIdx: string): string {
    const ssidRef = batch.params["Device.WiFi.AccessPoint." + apIdx + ".SSIDReference"] || "";
    const m = ssidRef.match(/Device\.WiFi\.SSID\.(\d+)/);
    if (!m) return "";
    return (batch.params["Device.WiFi.SSID." + m[1] + ".BSSID"] || "").toLowerCase();
  }

  // ---- Step 3a: SSID nodes (Device.WiFi.SSID.*) ----
  // Each VAP becomes an `ssid` intermediate node (id = BSSID, MAC-
  // typed). WiFi clients attach to their SSID parent rather than
  // straight to the gateway, giving the panel a Unifi-style tree
  // grouping by SSID + band.
  //
  // A VAP that is administratively down is not somewhere a subscriber
  // can be, so it is not drawn. A gateway carries a radio's worth of
  // disabled guest and backhaul VAPs and each one was rendering as a
  // node of its own, several of them named "." because that is what the
  // firmware puts in an unconfigured SSID. Set includeDisabledSsids to
  // see them.
  const includeDisabledSsids: boolean = ctx.configGet<boolean>("includeDisabledSsids", false);

  interface SsidMeta { bssid: string; name: string; band: string; radioIdx: string; }
  const ssidByIdx: Record<string, SsidMeta> = {};
  // A client is only parented to an SSID node that was drawn. Parenting
  // it to one that was skipped would hang it off an id no node carries,
  // and the graph walk drops an edge whose endpoint is missing, so the
  // client would disappear from the map rather than move up a level.
  const emittedSsids: Record<string, boolean> = {};
  const ssidEntries = batch.matches("Device.WiFi.SSID.*");
  let ssidsSeen = 0;
  let ssidsWithBand = 0;
  for (let i = 0; i < ssidEntries.length; i++) {
    const s = ssidEntries[i];
    const ssidIdx = s.$indexes.SSID;
    const bssid = ((s.BSSID as string | undefined) || "").toLowerCase();
    if (!bssid) continue;
    const ssidName = (s.SSID as string | undefined) || "";
    const lowerLayers = (s.LowerLayers as string | undefined) || "";
    const radioMatch = lowerLayers.match(/Device\.WiFi\.Radio\.(\d+)/);
    const radioIdx = radioMatch ? radioMatch[1] : "";
    const band = bandOf(radioIdx);
    const channel = channelOf(radioIdx);

    // Recorded whatever its state, so a client associated to a VAP the
    // firmware reports as down still resolves its band and channel.
    ssidByIdx[ssidIdx] = { bssid, name: ssidName, band, radioIdx };
    ssidsSeen++;
    if (band !== "") ssidsWithBand++;

    const enable = String(s.Enable === undefined ? "" : s.Enable);
    const status = String(s.Status === undefined ? "" : s.Status);
    const down = enable === "false" || enable === "0"
      || (status !== "" && status !== "Up");
    if (!includeDisabledSsids && (down || ssidName === "")) continue;

    emittedSsids[bssid] = true;
    topology.addNode({
      id: bssid,
      type: "ssid",
      hostname: ssidName,
      ssid: ssidName,
      band: bandLabel(band),
      channel: channel || undefined,
      radio: radioIdx || undefined,
    });
    topology.addEdge({
      parent: gatewayMAC,
      child: bssid,
      edge_type: bandToEdgeType(band),
      bssid: bssid,
    });
  }

  // An unresolved band is `other`, not the busiest guess. An edge typed
  // wifi_5g is read as a fact by everything downstream of the graph.
  function bandToEdgeType(band: string): "wifi_2g" | "wifi_5g" | "wifi_6g" | "other" {
    if (band === "2.4GHz") return "wifi_2g";
    if (band === "6GHz") return "wifi_6g";
    if (band === "5GHz") return "wifi_5g";
    return "other";
  }

  // A map drawn without these is not wrong in a way anyone can see: the
  // clients are all there, on one radio, with no channel. Saying it
  // makes the cause reachable from the device page instead of from a
  // reading of the telemetry profile.
  if (ssidsSeen > 0 && ssidsWithBand === 0) {
    enrichment.warn(
      "easymesh-default: no radio band resolved for any of " + ssidsSeen +
      " SSIDs. Device.WiFi.SSID.{i}.LowerLayers and " +
      "Device.WiFi.Radio.{i}.OperatingFrequencyBand must be collected at " +
      "interval 0 for a client to carry its band and channel.",
    );
  }

  function ssidForAP(apIdx: string): SsidMeta | null {
    const ssidRef = batch.params["Device.WiFi.AccessPoint." + apIdx + ".SSIDReference"] || "";
    const m = ssidRef.match(/Device\.WiFi\.SSID\.(\d+)/);
    if (!m) return null;
    return ssidByIdx[m[1]] || null;
  }

  // ---- Step 3b: Ethernet interface nodes (Device.Ethernet.Interface.*) ----
  // Each ethernet port becomes an `interface` node (id = port MAC).
  // Wired clients attach to the port their Layer1Interface points at.
  interface IfaceMeta { mac: string; name: string; path: string; }
  const ifaceByPath: Record<string, IfaceMeta> = {};
  const ethIfaces = batch.matches("Device.Ethernet.Interface.*");
  for (let i = 0; i < ethIfaces.length; i++) {
    const ifaceEntry = ethIfaces[i];
    const ifaceIdx = ifaceEntry.$indexes.Interface;
    const ifaceMac = ((ifaceEntry.MACAddress as string | undefined) || "").toLowerCase();
    if (!ifaceMac) continue;
    const ifaceName = (ifaceEntry.Name as string | undefined) || ("eth" + ifaceIdx);
    const ifacePath = "Device.Ethernet.Interface." + ifaceIdx;
    ifaceByPath[ifacePath] = { mac: ifaceMac, name: ifaceName, path: ifacePath };
    topology.addNode({
      id: ifaceMac,
      type: "interface",
      hostname: ifaceName,
      name: ifaceName,
      path: ifacePath,
    });
    topology.addEdge({
      parent: gatewayMAC,
      child: ifaceMac,
      edge_type: "ethernet",
    });
  }

  // ---- Step 4 (renamed from old Step 3): WiFi-associated clients
  // Each AP's AssociatedDevice list — clients edge to their SSID
  // parent (not to the gateway directly).
  const flatStations = batch.matches(
    "Device.WiFi.AccessPoint.*.AssociatedDevice.*",
  );
  for (let i = 0; i < flatStations.length; i++) {
    const s = flatStations[i];
    const clientMAC = ((s.MACAddress as string | undefined) || "").toLowerCase();
    if (!clientMAC) continue;
    // A disassociated station is not on the network now, so it is left
    // off the map entirely, the same call includeInactiveHosts makes
    // for wired hosts above.
    if (!includeInactive && isInactive(s.Active)) continue;

    const apIdx = s.$indexes.AccessPoint;
    const hostMeta = hostByMAC[clientMAC];

    // Which radio this station is on, by the two routes the data model
    // offers. The access point's SSIDReference is the direct one. When
    // that path is not in this batch the host table's Layer1Interface
    // names either the SSID or the radio itself, which is enough for
    // the band and the channel even though it cannot name the VAP.
    // Without the fallback a batch missing one path produced a map of
    // clients hung off the gateway with no SSID, no band and no
    // channel, on a device reporting all three.
    let ssidMeta = ssidForAP(apIdx);
    let radioIdx = ssidMeta ? ssidMeta.radioIdx : "";
    if (!ssidMeta && hostMeta) {
      const viaSsid = hostMeta.layer1.match(/Device\.WiFi\.SSID\.(\d+)/);
      if (viaSsid && ssidByIdx[viaSsid[1]]) {
        ssidMeta = ssidByIdx[viaSsid[1]];
        radioIdx = ssidMeta.radioIdx;
      } else {
        const viaRadio = hostMeta.layer1.match(/Device\.WiFi\.Radio\.(\d+)/);
        if (viaRadio) radioIdx = viaRadio[1];
      }
    }

    const band = ssidMeta ? ssidMeta.band : bandOf(radioIdx);
    const chan = channelOf(radioIdx);
    const parentNodeId = ssidMeta && emittedSsids[ssidMeta.bssid]
      ? ssidMeta.bssid
      : gatewayMAC;
    const edgeType = bandToEdgeType(band);

    const staBase = "Device.WiFi.AccessPoint." + apIdx + ".AssociatedDevice." +
      s.$indexes.AssociatedDevice + ".";

    topology.addNode({
      id: clientMAC,
      type: "client",
      hostname: hostMeta ? hostMeta.hostname || undefined : undefined,
      ipv4: hostMeta ? hostMeta.ipv4 || undefined : undefined,
      ipv6: hostMeta ? hostMeta.ipv6 || undefined : undefined,
      address_source: hostMeta ? hostMeta.addressSource || undefined : undefined,
      lease_remaining_s: hostMeta ? hostMeta.lease || undefined : undefined,
      interface_type: "Wi-Fi",
      // What the radio reports about this station. All standard TR-181
      // under AssociatedDevice, and all of it was already collected and
      // thrown away at the map: an X5042 in service reports signal,
      // both rates, retransmissions and byte counters for every client.
      //
      // As of the last topology rebuild, not live. These change on
      // every Inform and the rule's changeHash is structural on
      // purpose, so hashing them would run this script against every
      // session on every device. The live signal series is the
      // per-edge rssi_dbm metric emitted below.
      ssid: ssidMeta ? ssidMeta.name || undefined : undefined,
      band: bandLabel(band),
      channel: chan || undefined,
      signal_dbm: str(s.SignalStrength),
      rate_down_kbps: str(s.LastDataDownlinkRate),
      rate_up_kbps: str(s.LastDataUplinkRate),
      retransmissions: str(s.Retransmissions),
      bytes_down: batch.params[staBase + "Stats.BytesReceived"] || undefined,
      bytes_up: batch.params[staBase + "Stats.BytesSent"] || undefined,
    });
    emittedClients[clientMAC] = true;

    topology.addEdge({
      parent: parentNodeId,
      child: clientMAC,
      edge_type: edgeType,
      bssid: ssidMeta ? ssidMeta.bssid : undefined,
    });

    edgeRssi(s.SignalStrength, parentNodeId, clientMAC);
  }

  // ---- Step 5: wired clients (Hosts.Host with Layer1Interface = Device.Ethernet.*)
  // Each wired client attaches to the actual interface node, falling
  // back to the gateway when the interface isn't in the parameter
  // tree (e.g. firmware that omits Device.Ethernet entirely).
  for (const macKey in hostByMAC) {
    if (emittedClients[macKey]) continue;
    const hostMeta = hostByMAC[macKey];
    if (!hostMeta.layer1.startsWith("Device.Ethernet")) continue;

    const ifaceMeta = ifaceByPath[hostMeta.layer1];
    const parentNodeId = ifaceMeta ? ifaceMeta.mac : gatewayMAC;

    topology.addNode({
      id: macKey,
      type: "client",
      hostname: hostMeta.hostname || undefined,
      ipv4: hostMeta.ipv4 || undefined,
      ipv6: hostMeta.ipv6 || undefined,
      address_source: hostMeta.addressSource || undefined,
      lease_remaining_s: hostMeta.lease || undefined,
      interface_type: "Ethernet",
    });
    emittedClients[macKey] = true;

    topology.addEdge({
      parent: parentNodeId,
      child: macKey,
      edge_type: "ethernet",
    });
  }

  // ---- Step 6: MultiAP extenders + their per-AP SSIDs + clients ----
  // Tree shape per extender:
  //   gateway → extender (wifi_backhaul edge)
  //   extender → ssid (one per Radio.{j}.AP.{k}, edge typed by the
  //                    radio's band)
  //   ssid → mesh-client (typed by the same band, RSSI overlay
  //                       attached to this edge)
  const extenderByIndex: Record<string, string> = {};
  const apDevices = batch.matches("Device.WiFi.MultiAP.APDevice.*");
  for (let i = 0; i < apDevices.length; i++) {
    const ap = apDevices[i];
    const apMAC = ((ap.MACAddress as string | undefined) || "").toLowerCase();
    if (!apMAC) continue;
    extenderByIndex[ap.$indexes.APDevice] = apMAC;

    topology.addNode({
      id: apMAC,
      type: "extender",
      manufacturer: (ap.Manufacturer as string | undefined) || undefined,
      model: (ap.ModelName as string | undefined) || undefined,
      firmware: (ap.SoftwareVersion as string | undefined) || undefined,
      serial: (ap.SerialNumber as string | undefined) || undefined,
      synced: true,
    });

    topology.addEdge({
      parent: gatewayMAC,
      child: apMAC,
      edge_type: "wifi_backhaul",
    });

    // Backhaul RSSI — when the CPE reports it, colour the gateway→
    // extender edge by signal strength so a degraded backhaul shows
    // amber/red on the panel instead of inheriting the type colour.
    // Without this attachment the edge has no metric and the overlay
    // falls back to the static "wifi_backhaul" type tone, hiding the
    // most operationally interesting signal in the mesh path.
    edgeRssi(ap.SignalStrength, gatewayMAC, apMAC);
  }

  // Walk APDevice.{i}.Radio.{j}.AP.{k} and emit an `ssid` node per
  // entry, parented to the extender. Track BSSID → ssid-node-id so
  // mesh-stations below can attach to the right parent.
  interface MeshSsidMeta { bssid: string; band: string; ssid: string; }
  const meshSsidByLoc: Record<string, MeshSsidMeta> = {};
  const meshAPs = batch.matches(
    "Device.WiFi.MultiAP.APDevice.*.Radio.*.AP.*",
  );
  for (let i = 0; i < meshAPs.length; i++) {
    const apEntry = meshAPs[i];
    const apIdx = apEntry.$indexes.APDevice;
    const radioIdx = apEntry.$indexes.Radio;
    const apEntryIdx = apEntry.$indexes.AP;
    const parentExtender = extenderByIndex[apIdx];
    if (!parentExtender) continue;

    const bssid = ((apEntry.BSSID as string | undefined) || "").toLowerCase();
    if (!bssid) continue;
    const ssidName = (apEntry.SSID as string | undefined) || "";

    const meshBase = "Device.WiFi.MultiAP.APDevice." + apIdx +
      ".Radio." + radioIdx + ".";
    const declared = String(batch.params[meshBase + "OperatingFrequencyBand"] || "");
    const meshChannel = String(batch.params[meshBase + "Channel"] || "");
    let band = "";
    if (declared.indexOf("2.4") >= 0) band = "2.4GHz";
    else if (declared.indexOf("6") === 0) band = "6GHz";
    else if (declared.indexOf("5") === 0) band = "5GHz";
    else {
      const ch = parseInt(meshChannel, 10);
      if (!isNaN(ch) && ch > 0 && ch <= 14) band = "2.4GHz";
      else if (!isNaN(ch) && ch >= 32 && ch < 200) band = "5GHz";
    }

    meshSsidByLoc[apIdx + "/" + radioIdx + "/" + apEntryIdx] = { bssid, band, ssid: ssidName };
    topology.addNode({
      id: bssid,
      type: "ssid",
      hostname: ssidName,
      ssid: ssidName,
      band: bandLabel(band),
      channel: meshChannel || undefined,
      location: "extender:" + apIdx,
    });
    topology.addEdge({
      parent: parentExtender,
      child: bssid,
      edge_type: bandToEdgeType(band),
      bssid: bssid,
    });
  }

  const meshStations = batch.matches(
    "Device.WiFi.MultiAP.APDevice.*.Radio.*.AP.*.AssociatedDevice.*",
  );
  for (let i = 0; i < meshStations.length; i++) {
    const s = meshStations[i];
    const clientMAC = ((s.MACAddress as string | undefined) || "").toLowerCase();
    if (!clientMAC) continue;

    const apIdx = s.$indexes.APDevice;
    const radioIdx = s.$indexes.Radio;
    const apEntryIdx = s.$indexes.AP;
    const meshSsid = meshSsidByLoc[apIdx + "/" + radioIdx + "/" + apEntryIdx];
    const parentExtender = extenderByIndex[apIdx];
    if (!parentExtender && !meshSsid) continue;
    const parentNodeId = meshSsid ? meshSsid.bssid : (parentExtender as string);
    const meshEdgeType = meshSsid ? bandToEdgeType(meshSsid.band) : "other";

    const hostMeta = hostByMAC[clientMAC];
    const meshStaBase = "Device.WiFi.MultiAP.APDevice." + apIdx + ".Radio." +
      radioIdx + ".AP." + apEntryIdx + ".AssociatedDevice." +
      s.$indexes.AssociatedDevice + ".";
    topology.addNode({
      id: clientMAC,
      type: "client",
      hostname: hostMeta ? hostMeta.hostname || undefined : undefined,
      ipv4: hostMeta ? hostMeta.ipv4 || undefined : undefined,
      ipv6: hostMeta ? hostMeta.ipv6 || undefined : undefined,
      address_source: hostMeta ? hostMeta.addressSource || undefined : undefined,
      lease_remaining_s: hostMeta ? hostMeta.lease || undefined : undefined,
      interface_type: "Wi-Fi",
      ssid: meshSsid ? meshSsid.ssid || undefined : undefined,
      band: meshSsid ? bandLabel(meshSsid.band) : undefined,
      signal_dbm: str(s.SignalStrength),
      rate_down_kbps: str(s.LastDataDownlinkRate),
      rate_up_kbps: str(s.LastDataUplinkRate),
      retransmissions: str(s.Retransmissions),
      bytes_down: batch.params[meshStaBase + "Stats.BytesReceived"] || undefined,
      bytes_up: batch.params[meshStaBase + "Stats.BytesSent"] || undefined,
    });

    topology.addEdge({
      parent: parentNodeId,
      child: clientMAC,
      edge_type: meshEdgeType,
      bssid: meshSsid ? meshSsid.bssid : undefined,
    });

    edgeRssi(s.SignalStrength, parentNodeId, clientMAC);
  }
})();
