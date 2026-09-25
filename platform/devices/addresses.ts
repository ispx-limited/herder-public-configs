// addresses.ts: the addresses this device reports as its own.
//
// One device.addAddress per matching parameter, keyed by the path, so
// a WAN that renumbers replaces its row and a connection that reports
// an empty address clears it. Normalisation (MAC spelling, IPv6
// compression, dropping link-local and the zero MAC) is Herder's, not
// the script's: stage the value as reported.
//
// Standard trees only. InternetGatewayDevice: both WAN connection
// kinds' external address and MAC, the WAN Ethernet interface, the LAN
// Ethernet interfaces. Device: every IP interface's IPv4 and IPv6
// addresses, a PPP session's IPCP address, the Ethernet interfaces and
// links. Nothing from Hosts, AssociatedDevice or a neighbour scan,
// which name other units.

(function () {
  const own: RegExp[] = [
    /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WAN(IP|PPP)Connection\.\d+\.(ExternalIPAddress|MACAddress)$/,
    /^InternetGatewayDevice\.WANDevice\.\d+\.WANEthernetInterfaceConfig\.MACAddress$/,
    /^InternetGatewayDevice\.LANDevice\.\d+\.LANEthernetInterfaceConfig\.\d+\.MACAddress$/,
    /^Device\.IP\.Interface\.\d+\.IPv[46]Address\.\d+\.IPAddress$/,
    /^Device\.PPP\.Interface\.\d+\.IPCP\.LocalIPAddress$/,
    /^Device\.Ethernet\.(Interface|Link)\.\d+\.MACAddress$/,
  ];

  const params = batch.params;
  for (const path in params) {
    if (!Object.prototype.hasOwnProperty.call(params, path)) continue;
    for (let i = 0; i < own.length; i++) {
      if (own[i].test(path)) {
        device.addAddress(path, params[path]);
        break;
      }
    }
  }
})();
