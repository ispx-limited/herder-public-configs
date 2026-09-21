// Connection request credentials, issued by Herder and stored per
// device.
//
// Called by every CWMP seed rule with provision.run, so one place writes
// what the sender reads. Herder issues the password on the first call
// and hands back the same pair after, so provisioning converges instead
// of rewriting the pair every session. A credential imported from the
// ACS a fleet is migrating off comes back as it stands, so this rule
// never takes the device away from that ACS.
//
// Returning null means Herder is holding the credential back: the
// device informed before its existing credentials were imported.
// Writing a derived pair there would be the write the hold exists to
// prevent, so the rule sets nothing.
//
// The guard is for a bundle newer than the Herder reading it. This tree
// is synced independently of the image, so a deployment can run a
// release that predates the call. There the pair is derived from the
// identity, which is what that release's task worker sends, and the
// credential moves to a stored one when the deployment upgrades.

(function () {
  const issue = (device as { connectionRequestCredential?: () => { username: string; password: string } | null })
    .connectionRequestCredential;

  if (typeof issue === "function") {
    const cr = issue.call(device);
    if (!cr) return null;
    device.set("canonical.mgmt.connection_request_username", cr.username);
    device.set("canonical.mgmt.connection_request_password", cr.password);
    return cr.username;
  }

  const derived = device.oui + "-" + (device.serialNumber || "");
  device.set("canonical.mgmt.connection_request_username", derived);
  device.set("canonical.mgmt.connection_request_password", derived);
  return derived;
})();
