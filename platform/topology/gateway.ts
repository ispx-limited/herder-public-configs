// gateway.ts — the gateway this device says it is behind.
//
// One `topology.gateway` row, labels `oui` and `serial`, and
// `product_class` when the device reports one. OUI and serial together
// are the identity the gateway informs with, so a report missing either
// names nobody and emits nothing. The serial is passed through as
// reported: a vendor's own casing is part of it.

(function () {
  const params = batch.params;
  const oui = (params["Device.GatewayInfo.ManufacturerOUI"] || "").trim().toUpperCase();
  const serial = (params["Device.GatewayInfo.SerialNumber"] || "").trim();
  if (!oui || !serial) return;

  const labels: Record<string, string> = { oui: oui, serial: serial };
  const productClass = (params["Device.GatewayInfo.ProductClass"] || "").trim();
  if (productClass) labels.product_class = productClass;

  emit("topology.gateway", 1, labels);
})();
