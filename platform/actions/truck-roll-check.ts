// Normalizer for the truck_roll_check capability, both data model
// families.
//
// The steps collect readings; this script turns them into a verdict
// with the evidence behind it. It is one file rather than one per
// family because the decision is the same whichever object the
// readings came from: a line is down, a level is out of range, a
// PPP session was refused, a device rebooted five times this week.
// Only the paths differ, and they are handled in the readers at the
// top.
//
// Evidence is gathered into checks, each check contributes reasons,
// and a decision table turns the reasons into a verdict. The order of
// the table is the argument: an authentication rejection proves the
// line reaches the BNG, so it decides before any physical reading; a
// blocking physical reason decides before anything the connection
// layer says; nothing conclusive is inconclusive, not no_fault.
//
// Every threshold is read from ctx.config and arrives as the string
// the operator wrote, so each read goes through cfgNum or cfgStr.

type Severity = "blocking" | "supporting" | "info";
type Verdict = "truck_roll" | "remote_fix" | "no_fault" | "inconclusive";
type CheckStatus = "pass" | "fail" | "skipped" | "unknown";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  values: Record<string, unknown>;
}

interface Reason {
  code: string;
  // Physical readings (P) decide a truck; connection state (C) decides
  // a remote fix; history (H) and unreachable (U) shade both.
  layer: "P" | "C" | "H" | "U";
  severity: Severity;
  finding: string;
  evidence: Record<string, unknown>;
}

interface Result {
  capability: string;
  method: string;
  verdict: Verdict;
  summary: string;
  reasons: Array<{ code: string; severity: Severity; finding: string; evidence: Record<string, unknown> }>;
  remedy: { action: string; description: string } | null;
  missing: string[];
  checks: Check[];
  access: string | null;
  truck_roll: number;
  remote_fix: number;
  no_fault: number;
  inconclusive: number;
  [reading: string]: unknown;
}

// ---------------------------------------------------------------------
// Helpers

const p = action.params;

function cfgStr(key: string, def: string): string {
  const v = ctx.config ? ctx.config[key] : undefined;
  if (v === undefined || v === null || v === "") return def;
  return String(v);
}

function cfgNum(key: string, def: number): number {
  const n = Number(cfgStr(key, String(def)));
  return Number.isFinite(n) ? n : def;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function truthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true";
}

function contains(list: string[], v: string | undefined): boolean {
  return v !== undefined && list.indexOf(v) >= 0;
}

type Row = Record<string, string>;
type Table = Record<string, Row>;

// Groups "<prefix><index>.<leaf path>" keys into rows by index. The
// leaf path keeps its dots ("Stats.ErrorsReceived",
// "IPv4Address.1.SubnetMask"), which is how a row is read below.
function table(prefix: string): Table {
  const out: Table = {};
  for (const key of Object.keys(p)) {
    if (key.indexOf(prefix) !== 0) continue;
    const rest = key.slice(prefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) continue;
    const idx = rest.slice(0, dot);
    if (!/^[0-9]+$/.test(idx)) continue;
    const leaf = rest.slice(dot + 1);
    if (!out[idx]) out[idx] = {};
    out[idx][leaf] = p[key];
  }
  return out;
}

function rowIndices(t: Table): string[] {
  return Object.keys(t).sort((a, b) => Number(a) - Number(b));
}

function firstRow(t: Table, pick?: (r: Row) => boolean): Row | null {
  for (const i of rowIndices(t)) {
    if (!pick || pick(t[i])) return t[i];
  }
  return null;
}

// A step's outcome as the engine recorded it.
function stepState(name: string): "ok" | "error" | "skipped" {
  if (p["skipped." + name] !== undefined) return "skipped";
  if (p["error." + name] !== undefined) return "error";
  return "ok";
}

// Whether a step that errored did so because the device answered
// "no such object" (a fault) rather than not answering at all.
function stepFault(name: string): boolean {
  return p["failure." + name] === "fault";
}

const checks: Check[] = [];
const reasons: Reason[] = [];

function check(name: string, status: CheckStatus, detail: string, values: Record<string, unknown>): void {
  checks.push({ name: name, status: status, detail: detail, values: values });
}

function reason(code: string, layer: Reason["layer"], severity: Severity, finding: string, evidence: Record<string, unknown>): void {
  reasons.push({ code: code, layer: layer, severity: severity, finding: finding, evidence: evidence });
}

function hasReason(code: string): boolean {
  for (const r of reasons) if (r.code === code) return true;
  return false;
}

// ---------------------------------------------------------------------
// Family and reachability of the device itself

const tr181 = p["Device.DeviceInfo.UpTime"] !== undefined;
const tr098 = p["InternetGatewayDevice.DeviceInfo.UpTime"] !== undefined;
const uptime = num(tr181 ? p["Device.DeviceInfo.UpTime"] : p["InternetGatewayDevice.DeviceInfo.UpTime"]);
const answered = tr181 || tr098;

const metadata = action.device.metadata;
const accessKey = cfgStr("access_type_metadata_key", "access_type");
const declaredAccess = typeof metadata[accessKey] === "string" ? (metadata[accessKey] as string).toLowerCase() : "";

// Readings the sink turns into fleet series. Set as they are found.
const readings: Record<string, number> = {};

if (!answered) {
  const silentSince = action.context.presence && action.context.presence.state === "silent" ? action.context.presence.since : null;
  const hours = silentSince ? (Date.now() - Date.parse(silentSince)) / 3600000 : null;
  reason("device_unreachable", "U", "blocking", "The CPE did not answer the readings step.", {
    step_error: p["error.snapshot"] ?? null,
    last_inform: action.context.contact.lastInform,
    silent_since: silentSince,
  });
  if (hours !== null && hours >= cfgNum("silent_hours_for_truck_roll", 24)) {
    reason("prolonged_silence", "U", "supporting", "Silent for " + Math.round(hours) + " hours.", {
      silent_since: silentSince,
      hours: Math.round(hours),
    });
  }
  check("device", "unknown", "no answer", { last_inform: action.context.contact.lastInform });
}

// ---------------------------------------------------------------------
// Physical layer. Each access technology is a candidate; the ones that
// are up are the ones that count. An idle Ethernet WAN port on a DSL
// gateway, or an LTE backup, must not dispatch a truck.

interface Candidate {
  name: string; // ethernet | optical | dsl | cellular
  present: boolean;
  enabled: boolean;
  up: boolean;
  evaluate: () => void;
  skipDetail: string;
}

const candidates: Candidate[] = [];

const ethExpected = cfgNum("eth_wan_expected_bit_rate_mbps", 1000);
const ethErrorRatioMax = cfgNum("eth_error_ratio_max", 0.001);
const ethFlapSeconds = cfgNum("eth_flap_seconds", 3600);

if (tr181) {
  // Ethernet upstream port: only a port that says Upstream. Extenders
  // and bridged units have none, and guessing index 1 would judge a
  // LAN port.
  const eth = table("Device.Ethernet.Interface.");
  const port = firstRow(eth, (r) => truthy(r["Upstream"]));
  candidates.push({
    name: "ethernet",
    present: port !== null,
    enabled: port !== null && (port["Enable"] === undefined || truthy(port["Enable"])),
    up: port !== null && port["Status"] === "Up",
    skipDetail: stepState("snapshot") === "ok" ? "no upstream Ethernet port" : "readings not collected",
    evaluate: () => {
      if (!port) return;
      const status = port["Status"];
      const rate = num(port["CurrentBitRate"]);
      const duplex = port["CurrentDuplexMode"] ?? port["DuplexMode"];
      const errs = num(port["Stats.ErrorsReceived"]);
      const pkts = num(port["Stats.PacketsReceived"]);
      const lastChange = num(port["LastChange"]);
      const values: Record<string, unknown> = { status: status ?? null, bit_rate_mbps: rate, duplex: duplex ?? null, errors_received: errs, packets_received: pkts };
      if (rate !== null && rate > 0) readings["eth_bit_rate_mbps"] = rate;
      let failed = false;
      if (contains(["Down", "LowerLayerDown", "Error", "NotPresent"], status)) {
        failed = true;
        reason("eth_link_down", "P", "blocking", "The upstream Ethernet port reports " + status + ".", values);
      }
      if (ethExpected > 0 && rate !== null && rate > 0 && rate < ethExpected) {
        failed = true;
        reason("eth_speed_degraded", "P", "blocking", "The upstream port negotiated " + rate + " Mbps on a link expected to run at " + ethExpected + ".", values);
      }
      if (duplex === "Half") {
        failed = true;
        reason("eth_half_duplex", "P", "blocking", "The upstream port is running half duplex.", values);
      }
      if (errs !== null && pkts !== null && pkts > 0 && errs / pkts > ethErrorRatioMax) {
        reason("eth_errors", "P", "supporting", "Receive errors on the upstream port: " + errs + " of " + pkts + " packets.", values);
      }
      // LastChange of 0 is "unsupported" on more firmware than it is
      // "just now"; only a positive value is a reading.
      if (lastChange !== null && lastChange > 0 && uptime !== null && lastChange < ethFlapSeconds && uptime > lastChange + 300) {
        reason("eth_link_flapped", "P", "supporting", "The upstream link changed state " + lastChange + " seconds ago on a CPE up for " + uptime + ".", values);
      }
      check("ethernet", failed ? "fail" : "pass", failed ? "upstream port fault" : "upstream port up", values);
    },
  });

  // Integrated optics.
  const opt = table("Device.Optical.Interface.");
  const optRow = firstRow(opt, (r) => truthy(r["Upstream"])) ?? firstRow(opt);
  const divisor = cfgNum("optical_level_divisor", 1000) || 1000;
  candidates.push({
    name: "optical",
    present: optRow !== null,
    enabled: optRow !== null && (optRow["Enable"] === undefined || truthy(optRow["Enable"])),
    up: optRow !== null && optRow["Status"] === "Up",
    skipDetail: stepState("optical") === "error" && stepFault("optical") ? "no optical interface" : "optical readings not collected",
    evaluate: () => {
      if (!optRow) return;
      const status = optRow["Status"];
      const rxRaw = num(optRow["OpticalSignalLevel"]);
      const txRaw = num(optRow["TransmitOpticalLevel"]);
      const rx = rxRaw === null ? null : rxRaw / divisor;
      const tx = txRaw === null ? null : txRaw / divisor;
      const rxMin = cfgNum("optical_rx_min_dbm", -27);
      const rxMax = cfgNum("optical_rx_max_dbm", -8);
      const values: Record<string, unknown> = { status: status ?? null, rx_dbm: rx, tx_dbm: tx, rx_raw: rxRaw, tx_raw: txRaw };
      if (rx !== null) readings["optical_rx_dbm"] = rx;
      if (tx !== null) readings["optical_tx_dbm"] = tx;
      let failed = false;
      // -65.536 dBm is the field's floor: no light at all.
      if (contains(["Down", "LowerLayerDown", "Error", "NotPresent"], status) || (rx !== null && rx <= -65)) {
        failed = true;
        reason("optical_down", "P", "blocking", "No optical signal: status " + (status ?? "unknown") + ", receive level " + (rx === null ? "unknown" : rx + " dBm") + ".", values);
      } else {
        if (rx !== null && rx < rxMin) {
          failed = true;
          reason("optical_rx_low", "P", "blocking", "Receive level " + rx + " dBm is below the " + rxMin + " dBm minimum.", values);
        } else if (rx !== null && rx > rxMax) {
          failed = true;
          reason("optical_rx_high", "P", "blocking", "Receive level " + rx + " dBm is above the " + rxMax + " dBm maximum.", values);
        } else if (rx !== null && rx < rxMin + cfgNum("optical_rx_marginal_db", 2)) {
          reason("optical_rx_marginal", "P", "supporting", "Receive level " + rx + " dBm is within " + cfgNum("optical_rx_marginal_db", 2) + " dB of the minimum.", values);
        }
        const txMin = cfgNum("optical_tx_min_dbm", 0.5);
        const txMax = cfgNum("optical_tx_max_dbm", 5);
        if (tx !== null && (tx < txMin || tx > txMax)) {
          failed = true;
          reason("optical_tx_out_of_range", "P", "blocking", "Transmit level " + tx + " dBm is outside " + txMin + " to " + txMax + " dBm.", values);
        }
      }
      check("optical", failed ? "fail" : "pass", failed ? "optical fault" : "optical levels in range", values);
    },
  });

  // DSL.
  const dsl = table("Device.DSL.Line.");
  const line = firstRow(dsl, (r) => truthy(r["Upstream"])) ?? firstRow(dsl);
  const chan = firstRow(table("Device.DSL.Channel."));
  candidates.push({
    name: "dsl",
    present: line !== null,
    enabled: line !== null && (line["Enable"] === undefined || truthy(line["Enable"])),
    up: line !== null && (line["LinkStatus"] === "Up" || (line["LinkStatus"] === undefined && line["Status"] === "Up")),
    skipDetail: stepState("dsl") === "error" && stepFault("dsl") ? "no DSL line" : "DSL readings not collected",
    evaluate: () => {
      if (!line) return;
      evaluateDsl({
        linkStatus: line["LinkStatus"] ?? line["Status"],
        dsMargin: num(line["DownstreamNoiseMargin"]),
        usMargin: num(line["UpstreamNoiseMargin"]),
        dsAtten: num(line["DownstreamAttenuation"]),
        standard: line["StandardUsed"] ?? "",
        showtimeStart: num(line["Stats.ShowtimeStart"]),
        totalStart: num(line["Stats.TotalStart"]),
        retrains: null,
        ses: num(line["Stats.CurrentDay.SeverelyErroredSecs"]),
        dsRate: chan ? num(chan["DownstreamCurrRate"]) : null,
        usRate: chan ? num(chan["UpstreamCurrRate"]) : null,
      });
    },
  });

  // Cellular / fixed wireless.
  const cell = table("Device.Cellular.Interface.");
  const modem = firstRow(cell, (r) => truthy(r["Enable"])) ?? firstRow(cell);
  candidates.push({
    name: "cellular",
    present: modem !== null,
    enabled: modem !== null && (modem["Enable"] === undefined || truthy(modem["Enable"])),
    up: modem !== null && modem["Status"] === "Up",
    skipDetail: stepState("cellular") === "error" && stepFault("cellular") ? "no cellular interface" : "cellular readings not collected",
    evaluate: () => {
      if (!modem) return;
      const status = modem["Status"];
      const unsupported = 2147483647;
      const rsrpRaw = num(modem["RSRP"]);
      const rsrqRaw = num(modem["RSRQ"]);
      const rsrp = rsrpRaw === null || rsrpRaw >= unsupported ? null : rsrpRaw;
      const rsrq = rsrqRaw === null || rsrqRaw >= unsupported ? null : rsrqRaw;
      const sinrLeaf = cfgStr("cellular_sinr_leaf", "");
      const sinr = sinrLeaf ? num(modem[sinrLeaf]) : null;
      const values: Record<string, unknown> = { status: status ?? null, technology: modem["CurrentAccessTechnology"] ?? null, rsrp_dbm: rsrp, rsrq_db: rsrq, sinr_db: sinr, rssi_dbm: num(modem["RSSI"]) };
      if (rsrp !== null) readings["lte_rsrp_dbm"] = rsrp;
      if (rsrq !== null) readings["lte_rsrq_db"] = rsrq;
      let failed = false;
      if (status !== "Up") {
        failed = true;
        reason("lte_detached", "P", "blocking", "The cellular interface is " + (status ?? "unknown") + ", not attached.", values);
      }
      if (rsrp !== null && rsrp < cfgNum("lte_rsrp_min_dbm", -110)) {
        failed = true;
        reason("lte_rsrp_low", "P", "blocking", "RSRP " + rsrp + " dBm is below the " + cfgNum("lte_rsrp_min_dbm", -110) + " dBm minimum.", values);
      }
      if (sinr !== null && sinr < cfgNum("lte_sinr_min_db", 0)) {
        failed = true;
        reason("lte_sinr_low", "P", "blocking", "SINR " + sinr + " dB is below the " + cfgNum("lte_sinr_min_db", 0) + " dB minimum.", values);
      }
      if (rsrq !== null && rsrq < cfgNum("lte_rsrq_min_db", -15)) {
        reason("lte_rsrq_low", "P", "supporting", "RSRQ " + rsrq + " dB is below the " + cfgNum("lte_rsrq_min_db", -15) + " dB minimum.", values);
      }
      check("cellular", failed ? "fail" : "pass", failed ? "cellular signal fault" : "attached with signal in range", values);
    },
  });
}

if (tr098) {
  const common = "InternetGatewayDevice.WANDevice.1.WANCommonInterfaceConfig.";
  const accessType = p[common + "WANAccessType"];
  const physical = p[common + "PhysicalLinkStatus"];

  // The Ethernet WAN object is optional in TR-098 and absent on some
  // firmware; the common object's PhysicalLinkStatus is then the only
  // physical reading, and it is enough to say whether the link is up.
  const ethPrefix = "InternetGatewayDevice.WANDevice.1.WANEthernetInterfaceConfig.";
  const ethObject = p[ethPrefix + "Status"] !== undefined || p[ethPrefix + "Enable"] !== undefined;
  const ethStatus = p[ethPrefix + "Status"];
  const ethPresent = ethObject || (accessType === "Ethernet" && physical !== undefined);
  candidates.push({
    name: "ethernet",
    present: ethPresent && accessType !== "DSL",
    enabled: ethPresent && (p[ethPrefix + "Enable"] === undefined || truthy(p[ethPrefix + "Enable"])) && ethStatus !== "Disabled",
    up: ethPresent && (ethStatus === "Up" || (ethStatus === undefined && physical === "Up")),
    skipDetail: accessType === "DSL" ? "WANAccessType is DSL" : stepState("ethernet") === "error" && stepFault("ethernet") ? "no Ethernet WAN object" : "Ethernet readings not collected",
    evaluate: () => {
      const values: Record<string, unknown> = { status: ethStatus ?? null, physical_link: physical ?? null, max_bit_rate: p[ethPrefix + "MaxBitRate"] ?? null, duplex: p[ethPrefix + "DuplexMode"] ?? null };
      let failed = false;
      if (contains(["NoLink", "Error"], ethStatus) || (accessType === "Ethernet" && physical === "Down")) {
        failed = true;
        reason("eth_link_down", "P", "blocking", "The Ethernet WAN reports " + (ethStatus ?? physical) + ".", values);
      }
      check("ethernet", failed ? "fail" : "pass", failed ? "Ethernet WAN link down" : ethObject ? "Ethernet WAN link up" : "physical link up", values);
    },
  });

  const dslPrefix = "InternetGatewayDevice.WANDevice.1.WANDSLInterfaceConfig.";
  const dslPresent = p[dslPrefix + "Status"] !== undefined;
  const dslStatus = p[dslPrefix + "Status"];
  candidates.push({
    name: "dsl",
    present: dslPresent && accessType !== "Ethernet",
    enabled: dslPresent && (p[dslPrefix + "Enable"] === undefined || truthy(p[dslPrefix + "Enable"])) && dslStatus !== "Disabled",
    up: dslPresent && dslStatus === "Up",
    skipDetail: accessType === "Ethernet" ? "WANAccessType is Ethernet" : stepState("dsl") === "error" && stepFault("dsl") ? "no DSL object" : "DSL readings not collected",
    evaluate: () => {
      evaluateDsl({
        linkStatus: dslStatus,
        dsMargin: num(p[dslPrefix + "DownstreamNoiseMargin"]),
        usMargin: num(p[dslPrefix + "UpstreamNoiseMargin"]),
        dsAtten: num(p[dslPrefix + "DownstreamAttenuation"]),
        standard: p[dslPrefix + "StandardUsed"] ?? p[dslPrefix + "ModulationType"] ?? "",
        showtimeStart: num(p[dslPrefix + "ShowtimeStart"]),
        totalStart: num(p[dslPrefix + "TotalStart"]),
        retrains: num(p[dslPrefix + "Stats.Total.LinkRetrain"]),
        ses: num(p[dslPrefix + "Stats.CurrentDay.SeverelyErroredSecs"]),
        dsRate: num(p[dslPrefix + "DownstreamCurrRate"]),
        usRate: num(p[dslPrefix + "UpstreamCurrRate"]),
      });
    },
  });

  candidates.push({ name: "optical", present: false, enabled: false, up: false, skipDetail: "TR-098 has no optical object", evaluate: () => undefined });
  candidates.push({ name: "cellular", present: false, enabled: false, up: false, skipDetail: "TR-098 has no cellular object", evaluate: () => undefined });
}

interface DslReadings {
  linkStatus: string | undefined;
  dsMargin: number | null;
  usMargin: number | null;
  dsAtten: number | null;
  standard: string;
  showtimeStart: number | null;
  totalStart: number | null;
  retrains: number | null;
  ses: number | null;
  dsRate: number | null;
  usRate: number | null;
}

// Shared by both families: margins and attenuation arrive in tenths of
// a dB on both, and the link states are spelled the same.
function evaluateDsl(d: DslReadings): void {
  const marginMin = cfgNum("dsl_snr_margin_min_db", 6);
  const attenMax = cfgNum("dsl_attenuation_max_db", 55);
  const dsMarginDb = d.dsMargin === null ? null : d.dsMargin / 10;
  const usMarginDb = d.usMargin === null ? null : d.usMargin / 10;
  const dsAttenDb = d.dsAtten === null ? null : d.dsAtten / 10;
  const vdsl2 = d.standard.indexOf("993") >= 0;
  const values: Record<string, unknown> = {
    link_status: d.linkStatus ?? null,
    standard: d.standard || null,
    snr_margin_down_db: dsMarginDb,
    snr_margin_up_db: usMarginDb,
    attenuation_down_db: dsAttenDb,
    showtime_seconds: d.showtimeStart,
    retrains: d.retrains,
    severely_errored_secs_today: d.ses,
    rate_down_kbps: d.dsRate,
    rate_up_kbps: d.usRate,
  };
  if (dsMarginDb !== null) readings["dsl_snr_margin_down_db"] = dsMarginDb;
  if (dsAttenDb !== null) readings["dsl_attenuation_down_db"] = dsAttenDb;
  let failed = false;
  if (contains(["NoSignal", "EstablishingLink", "Initializing", "Error"], d.linkStatus)) {
    failed = true;
    reason("dsl_link_down", "P", "blocking", "The DSL line is " + d.linkStatus + ".", values);
  }
  const worstMargin = dsMarginDb === null ? usMarginDb : usMarginDb === null ? dsMarginDb : Math.min(dsMarginDb, usMarginDb);
  if (worstMargin !== null && worstMargin < marginMin) {
    failed = true;
    reason("dsl_snr_low", "P", "blocking", "SNR margin " + worstMargin + " dB is below the " + marginMin + " dB minimum.", values);
  }
  if (!vdsl2 && dsAttenDb !== null && dsAttenDb > 0 && dsAttenDb > attenMax) {
    failed = true;
    reason("dsl_attenuation_high", "P", "blocking", "Downstream attenuation " + dsAttenDb + " dB is above the " + attenMax + " dB maximum.", values);
  }
  const showtimeMin = cfgNum("dsl_showtime_min_seconds", 3600);
  if (d.showtimeStart !== null && d.showtimeStart > 0 && uptime !== null && d.showtimeStart < showtimeMin && uptime - d.showtimeStart > 300) {
    reason("dsl_unstable", "P", "supporting", "The line retrained " + d.showtimeStart + " seconds ago on a CPE up for " + uptime + ".", values);
  } else if (d.retrains !== null && d.totalStart !== null && d.totalStart > 3600) {
    const perDay = d.retrains / (d.totalStart / 86400);
    if (perDay > cfgNum("dsl_retrains_per_day_max", 5)) {
      reason("dsl_unstable", "P", "supporting", "The line retrains about " + Math.round(perDay) + " times a day.", values);
    }
  }
  check("dsl", failed ? "fail" : "pass", failed ? "DSL line fault" : "DSL line in range", values);
}

// Which candidates count. A declared access type narrows the field;
// otherwise the candidates that are up are the active ones, and only
// when nothing is up does every present candidate get judged.
const accessAliases: Record<string, string> = { gpon: "optical", pon: "optical", fibre: "ethernet", fiber: "ethernet", ufb: "ethernet", ethernet: "ethernet", dsl: "dsl", adsl: "dsl", vdsl: "dsl", fwa: "cellular", lte: "cellular", "5g": "cellular", cellular: "cellular" };
const declaredCandidate = accessAliases[declaredAccess] ?? "";
let active: Candidate[] = [];
if (answered) {
  const present = candidates.filter((c) => c.present);
  if (declaredCandidate) {
    active = present.filter((c) => c.name === declaredCandidate);
  }
  if (active.length === 0) {
    const up = present.filter((c) => c.up && c.enabled);
    active = up.length > 0 ? up : present.filter((c) => c.enabled);
  }
  if (active.length === 0 && present.length > 0) {
    // Everything present is disabled: the access itself is switched
    // off, which is configuration, not a line fault.
    for (const c of present) {
      reason("access_disabled", "C", "blocking", "The " + c.name + " access interface is disabled.", { interface: c.name });
      check(c.name, "fail", "disabled", {});
    }
  }
  for (const c of candidates) {
    if (active.indexOf(c) >= 0) {
      c.evaluate();
    } else if (c.present && c.enabled) {
      check(c.name, "skipped", "standby", {});
    } else if (c.present) {
      check(c.name, "skipped", "disabled", {});
    } else if (stepState(c.name === "ethernet" && tr181 ? "snapshot" : c.name) === "skipped") {
      check(c.name, "unknown", "not collected: device unreachable", {});
    } else {
      check(c.name, "skipped", c.skipDetail, {});
    }
  }
}

const access = active.length === 1 ? active[0].name : active.length > 1 ? active.map((c) => c.name).join("+") : null;

// ---------------------------------------------------------------------
// Connection layer

let wanUp = false;
let wanKnown = false;
let wanValues: Record<string, unknown> = {};

if (tr181) {
  const ip = table("Device.IP.Interface.");
  const lower = (r: Row): string => r["LowerLayers"] ?? "";
  // The order the baseline mapping uses, never falling back to index 1.
  const wan =
    firstRow(ip, (r) => lower(r).indexOf("Device.PPP.Interface.") >= 0) ??
    firstRow(ip, (r) => lower(r).indexOf("Device.Cellular.") >= 0) ??
    firstRow(ip, (r) => r["IPv4Address.1.SubnetMask"] === "255.255.255.255") ??
    firstRow(ip, (r) => r["IPv4Address.1.AddressingType"] === "DHCP");
  if (wan) {
    wanKnown = true;
    const addr = wan["IPv4Address.1.IPAddress"] ?? "";
    wanValues = { status: wan["Status"] ?? null, address: addr || null, addressing: wan["IPv4Address.1.AddressingType"] ?? null, lower_layers: lower(wan) || null };
    wanUp = wan["Status"] === "Up" && addr !== "" && addr !== "0.0.0.0";
  }

  // PPP: the instance the WAN sits on, else the first enabled one.
  const ppp = table("Device.PPP.Interface.");
  let pppRow: Row | null = null;
  if (wan) {
    const m = /Device\.PPP\.Interface\.(\d+)/.exec(lower(wan));
    if (m && ppp[m[1]]) pppRow = ppp[m[1]];
  }
  if (!pppRow) pppRow = firstRow(ppp, (r) => truthy(r["Enable"]));
  if (pppRow) {
    evaluatePpp(pppRow["ConnectionStatus"], pppRow["LastConnectionError"]);
  } else if (stepState("ppp") === "error" && stepFault("ppp")) {
    check("ppp", "skipped", "no PPP interface", {});
  } else if (stepState("ppp") !== "ok") {
    check("ppp", "unknown", "PPP readings not collected", {});
  } else {
    check("ppp", "skipped", "no PPP interface", {});
  }

  // APN, when the operator pins one.
  const expectedApn = cfgStr("cellular_expected_apn", "");
  if (expectedApn) {
    const ap = firstRow(table("Device.Cellular.AccessPoint."), (r) => truthy(r["Enable"]));
    if (ap && (ap["APN"] ?? "") !== expectedApn) {
      reason("apn_mismatch", "C", "blocking", "The attached APN is " + (ap["APN"] || "empty") + ", not " + expectedApn + ".", { apn: ap["APN"] ?? null, expected: expectedApn });
    }
  }
}

if (tr098) {
  const wcd = "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.";
  // Rows across every WANConnectionDevice: key "<j>.WANIPConnection.<k>".
  const ipRows: Row[] = [];
  const pppRows: Row[] = [];
  for (const key of Object.keys(p)) {
    if (key.indexOf(wcd) !== 0) continue;
    const m = /^(\d+)\.(WANIPConnection|WANPPPConnection)\.(\d+)\.(.+)$/.exec(key.slice(wcd.length));
    if (!m) continue;
    const rows = m[2] === "WANIPConnection" ? ipRows : pppRows;
    const id = m[1] + "." + m[3];
    let row: Row | undefined;
    for (const r of rows) if (r["__id"] === id) row = r;
    if (!row) {
      row = { __id: id };
      rows.push(row);
    }
    row[m[4]] = p[key];
  }
  const routed = ipRows.filter((r) => r["ConnectionType"] === "IP_Routed")[0] ?? ipRows[0];
  const pppRouted = pppRows.filter((r) => r["ConnectionType"] === "IP_Routed" || truthy(r["Enable"]))[0] ?? pppRows[0];
  const conn = routed ?? pppRouted;
  if (conn) {
    wanKnown = true;
    const addr = conn["ExternalIPAddress"] ?? "";
    wanValues = { status: conn["ConnectionStatus"] ?? null, address: addr || null, type: conn["ConnectionType"] ?? null };
    wanUp = conn["ConnectionStatus"] === "Connected" && addr !== "" && addr !== "0.0.0.0";
  }
  if (pppRouted) {
    evaluatePpp(pppRouted["ConnectionStatus"], pppRouted["LastConnectionError"]);
  } else {
    check("ppp", "skipped", "no PPP connection", {});
  }
}

function evaluatePpp(status: string | undefined, lastError: string | undefined): void {
  const values: Record<string, unknown> = { connection_status: status ?? null, last_error: lastError ?? null };
  const err = lastError ?? "";
  if (status === "Connected") {
    if (err && err !== "ERROR_NONE") {
      reason("ppp_last_error", "C", "info", "PPP is connected; the last failure was " + err + ".", values);
    }
    check("ppp", "pass", "connected", values);
    return;
  }
  if (contains(["ERROR_AUTHENTICATION_FAILURE", "ERROR_PASSWORD_EXPIRED"], err)) {
    reason("ppp_auth_failed", "C", "blocking", "PPP authentication was refused (" + err + ").", values);
  } else if (contains(["ERROR_ACCOUNT_DISABLED", "ERROR_ACCOUNT_EXPIRED", "ERROR_RESTRICTED_LOGON_HOURS"], err)) {
    reason("ppp_account_blocked", "C", "blocking", "The PPP account is blocked (" + err + ").", values);
  } else if (contains(["ERROR_ISP_TIME_OUT", "ERROR_NO_CARRIER", "ERROR_ISP_DISCONNECT", "ERROR_NO_ANSWER"], err)) {
    reason("ppp_no_answer", "C", "blocking", "PPP gets no answer upstream (" + err + ").", values);
  } else {
    reason("wan_down", "C", "blocking", "PPP is " + (status ?? "unknown") + (err ? " (" + err + ")" : "") + ".", values);
  }
  check("ppp", "fail", status ?? "not connected", values);
}

if (answered) {
  if (!wanKnown) {
    check("wan", "unknown", "no WAN interface identified", {});
  } else if (wanUp) {
    check("wan", "pass", "up with an address", wanValues);
  } else {
    if (!hasReason("ppp_auth_failed") && !hasReason("ppp_account_blocked") && !hasReason("ppp_no_answer")) {
      reason("wan_down", "C", "blocking", "The WAN connection is " + (wanValues["status"] ?? "unknown") + " with " + (wanValues["address"] ? "address " + wanValues["address"] : "no address") + ".", wanValues);
    }
    check("wan", "fail", "down or without an address", wanValues);
  }
}

// Reachability, from the ping capability the profile ran.
const ping = action.results["reachability"] as Record<string, unknown> | undefined;
let pingPassed = false;
if (ping && typeof ping === "object") {
  const ok = typeof ping["success_count"] === "number" ? (ping["success_count"] as number) : null;
  const fail = typeof ping["failure_count"] === "number" ? (ping["failure_count"] as number) : null;
  const state = typeof ping["state"] === "string" ? (ping["state"] as string) : "";
  const sent = ok !== null && fail !== null ? ok + fail : null;
  const loss = sent ? Math.round(((fail ?? 0) / sent) * 100) : null;
  const rtt = typeof ping["rtt_avg_ms"] === "number" ? (ping["rtt_avg_ms"] as number) : null;
  const values: Record<string, unknown> = { host: ping["host"] ?? null, state: state || null, sent: sent, loss_pct: loss, rtt_avg_ms: rtt, method: ping["method"] ?? null };
  if (loss !== null) readings["ping_loss_pct"] = loss;
  if (rtt !== null) readings["ping_rtt_avg_ms"] = rtt;
  const errored = state.indexOf("Error") === 0;
  if (loss === null && !errored) {
    check("reachability", "unknown", "ping reported no counts", values);
  } else if (errored || (loss !== null && loss > cfgNum("ping_loss_max_pct", 25))) {
    if (wanUp) {
      reason("reachability_failed", "C", "blocking", "WAN is up but " + (errored ? "the ping reported " + state : loss + "% of echoes to " + ping["host"] + " were lost") + ".", values);
    }
    check("reachability", "fail", errored ? state : loss + "% loss", values);
  } else {
    pingPassed = true;
    check("reachability", "pass", loss + "% loss", values);
  }
} else if (stepState("reachability") === "skipped") {
  check("reachability", answered ? "skipped" : "unknown", p["skipped.reachability"] === "no_profile" ? "no ping capability for this device" : "not run: device unreachable", {});
} else if (stepState("reachability") === "error") {
  check("reachability", "unknown", "ping failed: " + p["error.reachability"], { failure: p["failure.reachability"] ?? null });
} else if (answered) {
  check("reachability", "unknown", "no ping result", {});
}

// Service layer: the experience score's view of the home.
const score = action.context.score;
if (score) {
  const wifi = score.dimensions["wifi"];
  const values: Record<string, unknown> = { overall: score.score, worst_dimension: score.worstDimension, worst_score: score.worstScore, wifi: wifi ?? null };
  if (score.worstDimension === "wifi" && typeof wifi === "number" && wifi < cfgNum("experience_poor_below", 60)) {
    reason("wifi_poor", "C", "blocking", "The Wi-Fi experience dimension scores " + wifi + ".", values);
    check("experience", "fail", "wifi " + wifi, values);
  } else {
    check("experience", "pass", score.score === null ? "scored, no overall" : "overall " + Math.round(score.score * 10) / 10, values);
  }
} else {
  check("experience", "skipped", "no experience score", {});
}

// ---------------------------------------------------------------------
// History

const events = action.context.events;
let spontaneousReboots = 0;
let oldestSpontaneous: string | null = null;
let firmwareChangedAt: string | null = null;
let firmwareTo: string | null = null;
let silences = 0;
for (const ev of events) {
  if (ev.kind === "reboot" && ev.detail["cause"] === "spontaneous") {
    spontaneousReboots++;
    oldestSpontaneous = ev.at; // newest first, so the last one seen is the oldest
  }
  if (ev.kind === "firmware_changed") {
    firmwareChangedAt = ev.at; // the oldest change in the window
    firmwareTo = typeof ev.detail["to"] === "string" ? (ev.detail["to"] as string) : null;
  }
  if (ev.kind === "silent") silences++;
}
const stormCount = cfgNum("reboot_storm_count", 3);
const historyValues: Record<string, unknown> = { spontaneous_reboots: spontaneousReboots, silences: silences, window_hours: Math.round(action.context.windowSeconds / 3600), firmware_changed: firmwareChangedAt };
if (spontaneousReboots >= stormCount) {
  if (firmwareChangedAt !== null && oldestSpontaneous !== null && firmwareChangedAt <= oldestSpontaneous) {
    reason("reboot_storm_after_firmware", "C", "blocking", spontaneousReboots + " spontaneous reboots since the firmware changed" + (firmwareTo ? " to " + firmwareTo : "") + ".", historyValues);
  } else {
    reason("reboot_storm", "H", "blocking", spontaneousReboots + " spontaneous reboots in " + historyValues["window_hours"] + " hours.", historyValues);
  }
  check("reboots", "fail", spontaneousReboots + " spontaneous", historyValues);
} else {
  check("reboots", "pass", spontaneousReboots + " spontaneous", historyValues);
}
if (silences >= cfgNum("outage_count_supporting", 3)) {
  reason("intermittent_outages", "H", "supporting", silences + " silences in " + historyValues["window_hours"] + " hours.", historyValues);
  check("outages", "fail", silences + " silences", historyValues);
} else {
  check("outages", "pass", silences + " silences", historyValues);
}

// ---------------------------------------------------------------------
// Decision

function findCheck(name: string): Check | null {
  for (const c of checks) if (c.name === name) return c;
  return null;
}

const physicalNames = ["ethernet", "optical", "dsl", "cellular"];
const physicalChecks = physicalNames.map(findCheck).filter((c): c is Check => c !== null);
const physicalPass = physicalChecks.filter((c) => c.status === "pass").length;
const physicalFailOrUnknown = physicalChecks.filter((c) => c.status === "fail" || c.status === "unknown").length;
const physicalHealthy = physicalPass > 0 && physicalFailOrUnknown === 0;
const blockingPhysical = reasons.filter((r) => r.layer === "P" && r.severity === "blocking");
const supportingOnly = reasons.length > 0 && reasons.filter((r) => r.severity === "blocking").length === 0;

function askQuestion(): string {
  const key = declaredCandidate === "optical" ? "ask_gpon" : declaredCandidate === "ethernet" ? "ask_fibre" : declaredCandidate === "dsl" ? "ask_dsl" : declaredCandidate === "cellular" ? "ask_fwa" : "ask_default";
  return cfgStr(key, cfgStr("ask_default", "Is the gateway powered, and which lights are on?"));
}

let verdict: Verdict;
let summary: string;
let remedy: Result["remedy"] = null;
const missing: string[] = [];

if (hasReason("device_unreachable")) {
  verdict = hasReason("prolonged_silence") && cfgStr("silent_long_verdict", "inconclusive") === "truck_roll" ? "truck_roll" : "inconclusive";
  const since = action.context.presence && action.context.presence.state === "silent" ? action.context.presence.since : action.context.contact.lastInform;
  summary = "The CPE is not answering" + (since ? " (last heard " + since + ")" : "") + ". Ask: " + askQuestion();
  missing.push("device readings");
} else if (hasReason("ppp_auth_failed") || hasReason("ppp_account_blocked")) {
  verdict = "remote_fix";
  const auth = hasReason("ppp_auth_failed");
  remedy = auth
    ? { action: "update_credentials", description: "Re-issue the PPP credentials and re-provision the CPE; the BNG answered, so the line reaches it." }
    : { action: "check_account", description: "The account is blocked at the BNG; clear it in billing or RADIUS, then re-run." };
  summary = "Fix remotely: PPP rejected the session (" + (auth ? "authentication" : "account") + ")." + (blockingPhysical.length > 0 ? " Physical readings also flagged; re-run after the fix." : "");
} else if (blockingPhysical.length > 0 || hasReason("reboot_storm")) {
  verdict = "truck_roll";
  const first = blockingPhysical.length > 0 ? blockingPhysical[0] : reasons.filter((r) => r.code === "reboot_storm")[0];
  summary = "Dispatch: " + first.finding;
} else if (hasReason("reboot_storm_after_firmware")) {
  verdict = "remote_fix";
  remedy = { action: "firmware_rollback", description: "Roll the firmware back to the previous version; the reboots started with the change." };
  summary = "Fix remotely: " + reasons.filter((r) => r.code === "reboot_storm_after_firmware")[0].finding;
} else if (hasReason("ppp_no_answer") && physicalHealthy) {
  verdict = "inconclusive";
  summary = "PPP gets no answer upstream of a healthy line. Ask: " + askQuestion() + " Raise it with the access provider if the line lights are normal.";
  missing.push("BNG response");
} else if (!physicalHealthy) {
  verdict = "inconclusive";
  for (const c of physicalChecks) {
    if (c.status === "unknown" || c.status === "skipped") missing.push(c.name + " readings");
  }
  if (findCheck("wan") && findCheck("wan")!.status === "unknown") missing.push("WAN interface");
  summary = physicalChecks.filter((c) => c.status !== "skipped").length === 0
    ? "No access interface was identified on this CPE; the line cannot be judged from here."
    : "The line could not be judged: " + missing.join(", ") + ".";
} else if (hasReason("access_disabled") || hasReason("apn_mismatch") || hasReason("wan_down")) {
  verdict = "remote_fix";
  remedy = { action: "reprovision", description: "Re-run provisioning for this CPE; the line is healthy and the connection configuration is not." };
  summary = "Fix remotely: re-provision. " + reasons.filter((r) => r.code === "access_disabled" || r.code === "apn_mismatch" || r.code === "wan_down")[0].finding;
} else if (hasReason("reachability_failed")) {
  verdict = "remote_fix";
  remedy = { action: "reboot", description: "Reboot the CPE; the line and the WAN connection are up but traffic is not getting through." };
  summary = "Fix remotely: reboot. " + reasons.filter((r) => r.code === "reachability_failed")[0].finding;
} else if (hasReason("wifi_poor") && wanUp && pingPassed) {
  verdict = "remote_fix";
  remedy = { action: "wifi_optimise", description: "Change the Wi-Fi channel or steer the client; the line and the connection are healthy." };
  summary = "Fix remotely: " + reasons.filter((r) => r.code === "wifi_poor")[0].finding + " The line is healthy.";
} else if (supportingOnly) {
  verdict = "inconclusive";
  summary = "Readings are healthy now. " + reasons.map((r) => r.finding).join(" ") + " Re-run when it recurs.";
} else if (findCheck("reachability") && findCheck("reachability")!.status === "unknown" && !wanUp) {
  verdict = "inconclusive";
  summary = "The line is healthy and the connection could not be confirmed.";
  missing.push("reachability");
} else {
  verdict = "no_fault";
  summary = "No fault found on the line, the connection or the Wi-Fi score.";
}

const out: Result = {
  capability: action.capability,
  method: action.profile,
  verdict: verdict,
  summary: summary,
  reasons: reasons
    .slice()
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((r) => ({ code: r.code, severity: r.severity, finding: r.finding, evidence: r.evidence })),
  remedy: remedy,
  missing: missing,
  checks: checks,
  access: access,
  truck_roll: verdict === "truck_roll" ? 1 : 0,
  remote_fix: verdict === "remote_fix" ? 1 : 0,
  no_fault: verdict === "no_fault" ? 1 : 0,
  inconclusive: verdict === "inconclusive" ? 1 : 0,
};
for (const k of Object.keys(readings)) out[k] = readings[k];

function severityRank(s: Severity): number {
  return s === "blocking" ? 0 : s === "supporting" ? 1 : 2;
}

result(out);
