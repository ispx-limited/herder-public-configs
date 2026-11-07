// WiFi client joins, leaves and failed joins, from the Data Elements
// client events. One row per event; see wifi-client-events.yaml for the
// metric set and labels.
//
// The code texts are IEEE 802.11 (reason codes, Table 9-49; status
// codes, Table 9-50), worded as Wireshark's dissector words them and
// shortened where the full text is a paragraph. Only the codes a home's
// WiFi plausibly produces are named; any other code keeps its number.
//
// cause groups the codes an operator acts on the same way:
//   password     the client's key did not match (4-way handshake or MIC)
//   auth         802.1X or another authentication step failed
//   security     the client and the network disagree on ciphers or RSN
//   capacity     the access point had no room for another client
//   signal       frames were lost to a poor channel
//   steering     the network moved the client on purpose
//   inactivity   the client went quiet and was dropped
//   left         one side said it was leaving (either may send it)

const REASONS: Record<string, [string, string]> = {
  "1": ["Unspecified reason", ""],
  "2": ["Previous authentication no longer valid", "auth"],
  "3": ["Deauthenticated because the sending station is leaving", "left"],
  "4": ["Disassociated due to inactivity", "inactivity"],
  "5": ["Access point unable to handle all associated stations", "capacity"],
  "6": ["Class 2 frame received from nonauthenticated station", "auth"],
  "7": ["Class 3 frame received from nonassociated station", "auth"],
  "8": ["Disassociated because the sending station is leaving", "left"],
  "9": ["Station requesting association is not authenticated", "auth"],
  "12": ["Disassociated due to BSS transition management", "steering"],
  "14": ["Message integrity code (MIC) failure", "password"],
  "15": ["4-way handshake timeout", "password"],
  "16": ["Group key handshake timeout", "security"],
  "17": ["4-way handshake element mismatch", "security"],
  "18": ["Invalid group cipher", "security"],
  "19": ["Invalid pairwise cipher", "security"],
  "20": ["Invalid AKMP", "security"],
  "21": ["Unsupported RSNE version", "security"],
  "22": ["Invalid RSNE capabilities", "security"],
  "23": ["IEEE 802.1X authentication failed", "auth"],
  "24": ["Cipher suite rejected by security policy", "security"],
  "34": ["Excessive unacknowledged frames, poor channel conditions", "signal"],
};

const STATUSES: Record<string, [string, string]> = {
  "0": ["Successful", ""],
  "1": ["Unspecified failure", ""],
  "10": ["Cannot support all requested capabilities", ""],
  "12": ["Association denied, reason outside the standard", ""],
  "13": ["Authentication algorithm not supported", "auth"],
  "14": ["Authentication frame out of sequence", "auth"],
  "15": ["Authentication rejected, challenge failure", "auth"],
  "16": ["Authentication rejected, timeout", "auth"],
  "17": ["Access point unable to handle additional stations", "capacity"],
  "18": ["Station does not support the basic rate set", ""],
  "30": ["Association rejected temporarily, try again later", ""],
  "31": ["Robust management frame policy violation", "security"],
  "34": ["Excessive frame loss, poor channel conditions", "signal"],
  "37": ["The request has been declined", ""],
  "40": ["Invalid element", "security"],
  "53": ["Invalid PMKID", "security"],
  "72": ["Invalid RSNE contents", "security"],
  "82": ["Rejected with suggested BSS transition", "steering"],
  "93": ["Association refused, access point memory limits", "capacity"],
};

const METRIC_BY_EVENT: Record<string, string> = {
  "Associated!": "wifi.client.joined",
  "Disassociated!": "wifi.client.left",
  "FailedConnection!": "wifi.client.join_failed",
};

function mac(v: string | undefined): string {
  return (v || "").trim().toLowerCase();
}

function addCode(
  labels: Record<string, string>,
  table: Record<string, [string, string]>,
  key: string,
  textKey: string,
  raw: string | undefined,
): string {
  const code = (raw || "").trim();
  if (code === "") return "";
  labels[key] = code;
  const known = table[code];
  if (!known) return "";
  labels[textKey] = known[0];
  return known[1];
}

for (const ev of batch.events) {
  const name = ev.path.slice(ev.path.lastIndexOf(".") + 1);
  const metric = METRIC_BY_EVENT[name];
  if (!metric) continue;
  const client = mac(ev.args.MACAddress);
  if (client === "") continue;

  const labels: Record<string, string> = { client_mac: client };
  const bssid = mac(ev.args.BSSID);
  if (bssid !== "") labels.bssid = bssid;

  // A join's status 0 is success and says nothing; a failed join's
  // status is the reason it failed. A reason code of 0 is reserved and
  // means none was given.
  const statusCause =
    name === "FailedConnection!" ? addCode(labels, STATUSES, "status_code", "status", ev.args.StatusCode) : "";
  const reasonCause =
    ev.args.ReasonCode && ev.args.ReasonCode.trim() !== "0"
      ? addCode(labels, REASONS, "reason_code", "reason", ev.args.ReasonCode)
      : "";
  const cause = reasonCause || statusCause;
  if (cause !== "") labels.cause = cause;

  emit(metric, 1, labels);
}
