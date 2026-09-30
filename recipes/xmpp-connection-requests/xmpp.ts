// The device's own XMPP account, written the way Herder's CWMP guide
// does it.
//
// Triggered on: first_contact, boot, periodic
//
// The instance is created bare and written into on the following pass,
// because some firmware refuses parameter writes bundled with the
// AddObject. ServerConnectAlgorithm is never written: the firmware this
// fleet runs refuses the write even to its current value, and its
// default, DNS-SRV, falls through to the address when the domain is an
// IP literal. Password, connection reference and allowed JID are
// written only while the connection is disabled, so a device already
// connected is not rewritten on every inform.
//
// Domain and the allowed JID are asserted on every pass, not only
// when the instance is claimed. Both were written once at creation and
// then guarded by a condition that creation itself satisfied, so when
// the domain changed from an IP literal to a name the rule config
// changed and no provisioned device ever saw it: they informed for
// eleven minutes after the sync still carrying the address.
//
// Only the instance carrying our own username is ever written, and
// which instance that is depends on what the device shipped with: a
// spare when there is one, the incumbent's when there is not. See the
// claim below for why adding an instance is not an option on every
// model.

(function () {
  const cred = device.xmppCredential();
  if (cred === null) {
    provision.warn("no XMPP credential store on this role; leaving XMPP alone");
    return;
  }
  const domain = ctx.configGet("domain", "");
  const acsJid = ctx.configGet("acsJid", "");
  if (domain === "" || acsJid === "") {
    provision.skip("domain and acsJid must be set in the rule config");
    return;
  }
  // TR-098 and TR-181 alike: the XMPP object is the same shape under
  // either root, and a mesh of one vendor is commonly both (a Nokia
  // Beacon 2 manages over InternetGatewayDevice, a Beacon 3.1 over
  // Device). A rule that knew one root left the other fleet with no
  // account and, worse, with the incumbent's.
  const root =
    device.get("InternetGatewayDevice.DeviceInfo.SoftwareVersion") !== null
      ? "InternetGatewayDevice."
      : "Device.";
  const T = root + "XMPP.Connection.";
  const MS = root + "ManagementServer.";


  // Read the table live. These paths are in no evaluation's snapshot:
  // the engine loads what the rules desire, and which instance is ours
  // is the question being asked. device.get answers nil for a raw path
  // it was not asked to load, so the search below found nothing on
  // every pass, the script returned "on the next pass" every time, and
  // the account was created and never enabled. Both fetches issue in
  // the same pass, so they cost one round trip, and the script re-runs
  // from the top once they answer.
  // A wildcard fetch answers with a map keyed by full path. The SDK
  // declares fetch as a single value, so the shape is asserted here.
  const usernames = device.fetch(T + "*.Username") as unknown as
    Record<string, string | number> | null | undefined;
  const enables = device.fetch(T + "*.Enable") as unknown as
    Record<string, string | number> | null | undefined;
  const domains = device.fetch(T + "*.Domain") as unknown as
    Record<string, string | number> | null | undefined;
  const connRef = device.fetch(MS + "ConnReqXMPPConnection");
  const allowed = device.fetch(MS + "ConnReqAllowedJabberIDs");
  if (!usernames || !enables || !domains) return;

  // Which instance is ours. The table holds a handful of entries and
  // the incumbent ACS owns one of them, so the username decides rather
  // than the position.
  let index = 0;
  for (let i = 1; i <= 8; i++) {
    if (usernames[T + i + ".Username"] === cred.username) {
      index = i;
      break;
    }
  }
  if (index === 0) {
    // Nothing of ours yet. A spare first: a Grandstream HT801 answers
    // AddObject on this table with 9005 "Non writable array" and ships
    // three fixed instances, the incumbent ACS on the first and two
    // disabled, and claiming one of those is what got it onto this ACS.
    let free = 0;
    let lowest = 0;
    for (let i = 1; i <= 8; i++) {
      const u = usernames[T + i + ".Username"];
      if (u === undefined) break;
      if (lowest === 0) lowest = i;
      const e = enables[T + i + ".Enable"];
      if (e !== "1" && e !== "true") { free = i; break; }
    }

    // No spare, so take over the lowest instance rather than adding
    // one. The Sagemcom extenders ship with exactly one and their
    // firmware only ever services that one: an added instance accepts
    // every write, reports them all back and sits at Status Disabled
    // for ever, with no fault and nothing in a log to say why. Two of
    // them were stuck that way for an evening. Taking over the
    // incumbent's instance instead brought a Fast381 onto this server
    // and it now answers wakes in 16 ms.
    //
    // Safe because of when this runs: the device is already pointed at
    // this ACS, so the incumbent's XMPP connection cannot serve anyone.
    // An earlier attempt to write instance 1 did fail, but on the
    // domain being an IP literal the CPE could not resolve, which is
    // fixed; it was never the instance that was wrong.
    const slot0 = free !== 0 ? free : lowest;
    if (slot0 === 0) {
      device.ensureObject(T + '[Username=="' + cred.username + '"]', {
        Domain: domain,
        Resource: ctx.configGet("resource", "cpe"),
      });
      provision.log("no XMPP connection table to claim from; created one, writing it on the next pass");
      return;
    }
    const slot = T + slot0 + ".";
    device.set(slot + "Username", cred.username);
    device.set(slot + "Domain", domain);
    device.set(slot + "Resource", ctx.configGet("resource", "cpe"));
    provision.log(
      (free !== 0 ? "claimed spare XMPP connection " : "took over XMPP connection ") +
        slot0 + "; writing it on the next pass",
    );
    return;
  }

  // Any other instance carrying our username is one this rule created
  // before it learned to take over the incumbent. Left enabled it is a
  // second login for the same account, so it goes down.
  for (let i = 1; i <= 8; i++) {
    if (i === index) continue;
    const dup = T + i + ".";
    if (usernames[dup + "Username"] !== cred.username) continue;
    const e = enables[dup + "Enable"];
    if (e === "1" || e === "true") {
      device.set(dup + "Enable", false);
      provision.log("disabled duplicate XMPP connection " + i);
    }
  }

  const conn = T + index + ".";
  const enabled = enables[conn + "Enable"];

  // A connection that is dialling the wrong server has to be taken
  // down to redial: the JabberID the CPE derives from Domain is fixed
  // at connect, and the firmware here does not re-resolve underneath a
  // live session. Enable goes false with the write, and the branch
  // below brings it back up on the next pass with the password, which
  // is the same two-pass path a newly claimed instance takes.
  if (domains[conn + "Domain"] !== domain) {
    device.set(conn + "Domain", domain);
    device.set(conn + "Enable", false);
    provision.log("XMPP domain changed; redialling on the next pass");
    return;
  }

  if (enabled !== "1" && enabled !== "true") {
    device.set(conn + "Password", cred.password);
    device.set(conn + "Enable", true);
  }

  // The port, where the firmware keeps one. The standard object has
  // none (the CPE is meant to find it by SRV), and firmware that does
  // not look carries it in a vendor field with its own default: a
  // Nokia Beacon dials X_ALU_COM_XMPP_Port, 443 unless told otherwise,
  // which is the console, and sits at Status Disabled for ever. Named
  // in config because the field is the vendor's; written on every
  // root, because a rule that set it on one left the other's fleet
  // silent. Decided against the device's own value, like the rest.
  const portParam = ctx.configGet("portParam", "");
  const port = ctx.configGet("port", "");
  if (portParam !== "" && port !== "") {
    const have = device.fetch(conn + portParam);
    if (have !== null && String(have) !== String(port)) {
      device.set(conn + portParam, Number(port));
      device.set(conn + "Enable", false);
      provision.log("XMPP port changed to " + port + "; redialling on the next pass");
      return;
    }
  }

  // The connection reference is written on its own terms, not behind
  // the enable. A Fast381 took Enable out of the pass that carried both
  // and left ConnReqXMPPConnection on the incumbent's instance, and the
  // old guard keyed on Enable alone never came back to it: the device
  // sat enabled, advertising a connection it was not pointed at. Its
  // own value decides, so a pass that lands one and not the other
  // finishes the job on the next inform.
  const want = T + index;
  if (connRef !== want) {
    device.set(MS + "ConnReqXMPPConnection", want);
  }

  // Separately again, and for the same reason the reference is: this
  // was written only inside the reference's guard, so a device already
  // pointed at our instance kept allowing whatever JID the ACS had
  // when it was provisioned. The ACS's own JID moved with the domain,
  // and a CPE still allowing the old one refuses every wake it sends.
  if (allowed !== acsJid) {
    device.set(MS + "ConnReqAllowedJabberIDs", acsJid);
  }
})();
