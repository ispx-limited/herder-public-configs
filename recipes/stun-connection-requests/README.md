# STUN connection requests

A CPE behind a NAT cannot be reached on its connection request URL, so
nothing gets to it until its next periodic inform. TR-069 Annex G has
the CPE keep a UDP binding open to a STUN server and the ACS send its
connection request through that binding. This rule turns STUN on and
points the device at Herder's own STUN server.

It is the alternative to `xmpp-connection-requests` for firmware that
has the STUN leaves and no XMPP, and for a fleet that already reaches
its NATed units this way on another ACS.

## What this writes

Every parameter it may set on a subscriber's device, under
`Device.ManagementServer.` or `InternetGatewayDevice.ManagementServer.`
as the device's root is:

| Path | Value |
| --- | --- |
| `STUNServerAddress` | the `stunServer` config value |
| `STUNServerPort` | the `port` config value, 3478 |
| `STUNMinimumKeepAlivePeriod` | the `minKeepAlive` config value, 30 |
| `STUNMaximumKeepAlivePeriod` | the `maxKeepAlive` config value, 120 |
| `STUNEnable` | true |

It never writes `STUNUsername` or `STUNPassword`. The device then
reports `UDPConnectionRequestAddress` (the public address and port its
NAT gave the binding) and `NATDetected`, which the baseline telemetry
profiles collect, and Herder's next connection request to it goes over
UDP as well as to the URL.

## What you must supply

- `stunServer`: the address the CPE sends STUN to. Herder's `stun` role
  listens on the ACS address, UDP 3478 by default; give the address or
  a name the CPE resolves to it. The STUN server has to be the same
  host the UDP connection requests leave from, which Herder's role is.
- A selector. The shipped one matches a `tag:stun` that nothing has, so
  an unedited adoption is inert.
- The `stun` role in the deployment's `--roles` and UDP 3478 open from
  the CPE ranges. The `herder_stun` variable in the collection, or the
  port in the community compose.
- `maxKeepAlive` shorter than the NAT's UDP timeout. The device keeps
  the binding alive by sending a Binding Request at least this often;
  a binding that lapses between keepalives drops the next connection
  request and the device falls back to its periodic inform.

## Adopting it

Follow `../README.md`. The short version: copy both files into your
config repo, rename the rule, set `stunServer`, point the selector at
one device, prove a wake against it, then widen.

Proof is the device's `UDPConnectionRequestAddress` turning non-empty on
its next inform, and a wake from the console ending in an inform with
`6 CONNECTION REQUEST` inside 30 seconds with the result's transport
`udp`. The device's `NATDetected` says whether a NAT is in the path at
all; false means HTTP reaches it anyway and the UDP request is only a
second copy.
