# Vendors

Per-hardware overrides, each in `vendors/<name>/`, scoped by the vendor
tuple (`manufacturer`/`oui` plus `productClass`) at priority 50 so they
win over the baseline without capturing other devices. A vendor profile
restates the baseline tables it still needs, because binding is
single-profile.

Onboarded families:

- **arris** — NVG578LX: X_0000C5 extensions, HNC mesh topology.
- **grandstream** — GWN7062 (AP) and GWN7002 (router), standard TR-181;
  client signal banded from the radio rather than the AccessPoint index.
- **nokia-fastmile** — FastMile 5G Gateway, TR-181; the WAN is the
  cellular interface, mapped as such.
- **nokia-beacon** — WiFi Beacon 2 / 3.1 / G6, mesh APs on TR-098 and
  TR-181; the map and radar are drawn from the Wi-Fi DataElements tree,
  and the TR-098 units get a neighbour scan over the vendor diagnostic.
- **example-networks**, **cpe-sim**, **dev-sim** — reference and
  simulator profiles.

New hardware is added with the workbench
(https://github.com/ispx-limited/herder-workbench): survey the device,
scope the features, write the directory, validate every buffer against
a live API.
