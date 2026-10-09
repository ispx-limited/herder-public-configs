// STUN on the CPE, the way Herder's CWMP guide does it.
//
// Triggered on: first_contact, boot, periodic
//
// Every value is asserted on every pass. Writes are desired state and
// the converge layer sends only what differs, so a device already
// configured costs nothing, and a config change (a new server address,
// a shorter keepalive) reaches every provisioned device on its next
// inform rather than only the ones provisioned after it.
//
// The server address and the keepalive bounds are written in the same
// pass as the enable. Firmware that starts binding discovery the
// moment STUNEnable turns true reads the server it was given in that
// pass; one that reads it later reads the same values.

(function () {
  const server = ctx.configGet("stunServer", "");
  if (server === "" || server === "CHANGE-ME") {
    provision.skip("stunServer must be set in the rule config");
    return;
  }
  const port = Number(ctx.configGet("port", 3478));
  const minKeepAlive = Number(ctx.configGet("minKeepAlive", 30));
  const maxKeepAlive = Number(ctx.configGet("maxKeepAlive", 120));
  if (!(minKeepAlive > 0) || !(maxKeepAlive >= minKeepAlive)) {
    provision.skip("minKeepAlive must be positive and maxKeepAlive at least minKeepAlive");
    return;
  }

  // TR-098 and TR-181 alike: the ManagementServer STUN leaves are the
  // same under either root. The root is read off the device.
  const root =
    device.get("InternetGatewayDevice.DeviceInfo.SoftwareVersion") !== null
      ? "InternetGatewayDevice."
      : "Device.";
  const MS = root + "ManagementServer.";

  device.set(MS + "STUNServerAddress", server);
  device.set(MS + "STUNServerPort", port);
  device.set(MS + "STUNMinimumKeepAlivePeriod", minKeepAlive);
  device.set(MS + "STUNMaximumKeepAlivePeriod", maxKeepAlive);
  device.set(MS + "STUNEnable", true);
})();
