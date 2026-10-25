// arris-hnc.ts — topology emit for Arris NVG578LX-class devices.
//
// Walks the X_0000C5_Wireless.HNC.HNE vendor-extension tree:
//   HNE.1 = gateway (Type=="Gateway")
//   HNE.2+ = paired extenders
// Identifies backhaul SSIDs by matching ctx.config.backhaulSsidMatch
// (default "^bh") against the SSID name. Cross-refs Hosts.Host by MAC
// for client metadata.
//
// Demonstrates how proprietary path semantics encode into the standard
// emit shape — every emit goes through topology.add* helpers so the
// labels stay schema-correct.

(function () {
  const backhaulPattern: string = ctx.configGet<string>("backhaulSsidMatch", "^bh");
  const rssiEncoding: string = ctx.configGet<string>("rssiEncoding", "dbm");
  const includeInactive: boolean = ctx.configGet<boolean>("includeInactiveHosts", false);

  const backhaulRe = new RegExp(backhaulPattern);

  // Step 1: host metadata by MAC for client emit cross-ref.
  interface HostMeta { hostname: string; ipv4: string; layer2: string; }
  const hostByMAC: Record<string, HostMeta> = {};
  const hosts = batch.matches("InternetGatewayDevice.LANDevice.1.Hosts.Host.*");
  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i];
    const mac = ((h.MACAddress as string | undefined) || "").toLowerCase();
    if (!mac) continue;
    const active = (h.Active as string | undefined) || "";
    if (!includeInactive && (active === "false" || active === "0")) continue;
    hostByMAC[mac] = {
      hostname: (h.HostName as string | undefined) || "",
      ipv4: (h.IPAddress as string | undefined) || "",
      layer2: (h.Layer2Interface as string | undefined) || "",
    };
  }

  // Step 2: walk HNE entries → mesh nodes.
  const hnes = batch.matches("InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE.*");
  if (hnes.length === 0) {
    enrichment.warn("arris-hnc: no X_0000C5_Wireless.HNC.HNE entries found");
    return;
  }

  // gatewayMAC = the HNE entry with Type=="Gateway".
  let gatewayMAC: string | null = null;
  const nodeByHNEIndex: Record<string, string> = {};
  for (let i = 0; i < hnes.length; i++) {
    const n = hnes[i];
    const nodeMAC = ((n.MACAddress as string | undefined) || "").toLowerCase();
    if (!nodeMAC) continue;
    nodeByHNEIndex[n.$indexes.HNE] = nodeMAC;
    if ((n.Type as string | undefined) === "Gateway") {
      gatewayMAC = nodeMAC;
    }
  }

  if (!gatewayMAC) {
    enrichment.warn("arris-hnc: no HNE entry with Type=='Gateway'");
    return;
  }

  for (let i = 0; i < hnes.length; i++) {
    const n = hnes[i];
    const nodeMAC = ((n.MACAddress as string | undefined) || "").toLowerCase();
    if (!nodeMAC) continue;
    const nodeType: "gateway" | "extender" = nodeMAC === gatewayMAC ? "gateway" : "extender";

    topology.addNode({
      id: nodeMAC,
      type: nodeType,
      managed_device_id: nodeType === "gateway" ? device.id : undefined,
      manufacturer: device.manufacturer,
      model: (n.Model as string | undefined) || undefined,
      firmware: (n.SoftwareVersion as string | undefined) || undefined,
      synced: nodeType === "extender" ? true : undefined,
    });

    // Backhaul edge to gateway: in the Arris tree, extenders link
    // back to the gateway via the SSID matching backhaulPattern. For
    // simplicity v1 always parents extenders to the gateway (no
    // multi-hop mesh modeling) — operators with chained meshes
    // override this script.
    if (nodeType === "extender") {
      topology.addEdge({
        parent: gatewayMAC,
        child: nodeMAC,
        edge_type: "wifi_backhaul",
      });
    }
  }

  // The gateway's own reading of each client's signal, from the
  // AssociatedDevice entry on the radio the host table puts it on. The
  // HNC table holds 0 for a station it has no reading for, and on this
  // firmware that is most sessions.
  const wlanPrefix = "InternetGatewayDevice.LANDevice.1.WLANConfiguration.";
  const assoc = batch.matches(wlanPrefix + "*.AssociatedDevice.*");
  const assocRSSI: Record<string, number> = {};
  for (let i = 0; i < assoc.length; i++) {
    const a = assoc[i];
    const mac = ((a.AssociatedDeviceMACAddress as string | undefined) || "").toLowerCase();
    if (!mac) continue;
    const hostMeta = hostByMAC[mac];
    const layer2 = hostMeta ? hostMeta.layer2.replace(/\.$/, "") : "";
    if (layer2 && layer2 !== wlanPrefix + a.$indexes.WLANConfiguration) continue;
    const rssi = parseFloat((a.X_0000C5_RSSI as string | undefined) || "");
    if (!isNaN(rssi) && rssi < 0) assocRSSI[mac] = rssi;
  }

  // Step 3: clients per HNE.{i}.Radio.{j}.SSID.{k}.STA.{l}. Skip
  // backhaul-SSID stations — they're inter-node links, not clients.
  const stations = batch.matches(
    "InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE.*.Radio.*.SSID.*.STA.*",
  );
  const placed: Record<string, boolean> = {};
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i];
    const clientMAC = ((s.MACAddress as string | undefined) || "").toLowerCase();
    if (!clientMAC) continue;

    // Look up the SSID name for the parent SSID — skip backhaul.
    const ssidNamePath = "InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE." +
      s.$indexes.HNE + ".Radio." + s.$indexes.Radio + ".SSID." + s.$indexes.SSID + ".SSID";
    const ssidName = batch.params[ssidNamePath] || "";
    if (backhaulRe.test(ssidName)) {
      continue;
    }

    const parentMAC = nodeByHNEIndex[s.$indexes.HNE];
    if (!parentMAC) continue;

    const hostMeta = hostByMAC[clientMAC];
    placed[clientMAC] = true;
    topology.addNode({
      id: clientMAC,
      type: "client",
      hostname: hostMeta ? hostMeta.hostname : undefined,
      ipv4: hostMeta ? hostMeta.ipv4 : undefined,
    });

    // Determine edge_type from radio band.
    const bandPath = "InternetGatewayDevice.LANDevice.1.X_0000C5_Wireless.HNC.HNE." +
      s.$indexes.HNE + ".Radio." + s.$indexes.Radio + ".OperatingFrequencyBand";
    const band = batch.params[bandPath] || "";
    let edgeType: "wifi_2g" | "wifi_5g" | "wifi_6g" = "wifi_5g";
    if (band === "2.4GHz") edgeType = "wifi_2g";
    else if (band === "6GHz") edgeType = "wifi_6g";

    topology.addEdge({
      parent: parentMAC,
      child: clientMAC,
      edge_type: edgeType,
    });

    // Per-edge RSSI metric. 0 is no reading, not a signal: a dBm
    // signal is negative, so anything else falls back to the gateway's
    // own reading for a client of the gateway.
    let rssi = parseFloat((s.RSSI as string | undefined) || "");
    if (!isNaN(rssi) && rssi !== 0 && rssiEncoding === "rcpi") {
      rssi = (rssi / 2) - 110;
    }
    if ((isNaN(rssi) || rssi >= 0) && parentMAC === gatewayMAC && clientMAC in assocRSSI) {
      rssi = assocRSSI[clientMAC];
    }
    if (!isNaN(rssi) && rssi < 0) {
      topology.addEdgeMetric("rssi_dbm", rssi, {
        parent: parentMAC,
        child: clientMAC,
      });
    }
  }
  // Step 4: clients on the gateway's own radios, from the standard
  // WLANConfiguration.{i}.AssociatedDevice table. The HNC station table
  // above is filled only now and then on this firmware, while the
  // AssociatedDevice table is reported on every session: drawn from the
  // HNC table alone, a gateway with a phone on it showed no clients
  // while the client signals panel listed the phone on both bands.
  // A station the HNC table already placed is left where it is.
  for (let i = 0; i < assoc.length; i++) {
    const a = assoc[i];
    const clientMAC = ((a.AssociatedDeviceMACAddress as string | undefined) || "").toLowerCase();
    if (!clientMAC || placed[clientMAC]) continue;
    const wlan = a.$indexes.WLANConfiguration;

    // The mesh backhaul's stations are the extenders, not clients.
    const ssid = batch.params[wlanPrefix + wlan + ".SSID"] || "";
    if (backhaulRe.test(ssid)) continue;

    // A station still listed on a radio it has left: the host table
    // names the interface it is on now.
    const hostMeta = hostByMAC[clientMAC];
    const layer2 = hostMeta ? hostMeta.layer2.replace(/\.$/, "") : "";
    if (layer2 && layer2 !== wlanPrefix + wlan) continue;

    placed[clientMAC] = true;
    topology.addNode({
      id: clientMAC,
      type: "client",
      hostname: hostMeta ? hostMeta.hostname || undefined : undefined,
      ipv4: hostMeta ? hostMeta.ipv4 || undefined : undefined,
    });

    const band = batch.params[wlanPrefix + wlan + ".X_0000C5_OperatingFrequencyBand"] || "";
    let edgeType: "wifi_2g" | "wifi_5g" | "wifi_6g" = "wifi_5g";
    if (band.indexOf("2.4") === 0) edgeType = "wifi_2g";
    else if (band.indexOf("6") === 0) edgeType = "wifi_6g";
    topology.addEdge({ parent: gatewayMAC, child: clientMAC, edge_type: edgeType });

    if (clientMAC in assocRSSI) {
      topology.addEdgeMetric("rssi_dbm", assocRSSI[clientMAC], { parent: gatewayMAC, child: clientMAC });
    }
  }
})();
