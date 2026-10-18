# Vendors

Per-hardware overrides, each in `vendors/<name>/`, scoped by the vendor
tuple (`manufacturer`/`oui` plus `productClass`) at priority 50 so they
win over the baseline without capturing other devices. A vendor profile
restates the baseline tables it still needs, because binding is
single-profile.

A vendor feeds the baseline's names from its own leaves (ARRIS feeds
`wifi.client.rssi` from `X_0000C5_RSSI`), and names what only it has
with an `x.<name>.` segment inside the tree it extends, `<name>` being
its directory: `wifi.client.x.arris.deauth_count`,
`canonical.wifi.radio.1.x.arris.average_snr`. The check's lint holds
every directory to that: no `x.` name outside `vendors/`, and no
directory naming another. When a second source or a reader wants the
concept it gets a canonical name and the `x.` name retires.

Onboarded families:

- **arris** — NVG578LX: X_0000C5 extensions, HNC mesh topology.
- **grandstream** — GWN7062 (AP) and GWN7002 (router), standard TR-181;
  client signal banded from the radio rather than the AccessPoint index.
- **nokia-fastmile** — FastMile 5G Gateway, TR-181; the WAN is the
  cellular interface, mapped as such.
- **nokia-beacon** — WiFi Beacon 2 / 3.1 / 4 / G6, mesh APs on TR-098 and
  TR-181. The map is drawn from the Wi-Fi Data Elements tree where the
  build has one and from Nokia's satellite table
  (`X_ALU-COM_BeaconInfo`) where it does not; the unit's own `WorkRole`
  tells a controller from a satellite. The TR-098 units get a neighbour
  scan over the vendor diagnostic.
- **example-networks**, **cpe-sim**, **dev-sim** — reference and
  simulator profiles.

New hardware is added with the workbench
(https://github.com/ispx-limited/herder-workbench): survey the device,
scope the features, write the directory, validate every buffer against
a live API.
