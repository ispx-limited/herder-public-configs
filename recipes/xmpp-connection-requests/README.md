# XMPP connection requests

A CPE behind carrier NAT cannot be reached on its connection request
URL, so nothing gets to it until its next periodic inform, typically
three hours. TR-069 Annex K has the CPE hold an XMPP session open to
the ACS instead, and this rule gives each device the account to do it.

Proven on live hardware: a Grandstream HT801 and Sagemcom Fast281 and
Fast381 extenders, answering wakes in 16 to 41 ms against a three hour
alternative.

## What this writes

Every parameter it may set on a subscriber's device:

| Path | Value |
| --- | --- |
| `Device.XMPP.Connection.{i}.Username` | from `device.xmppCredential()` |
| `Device.XMPP.Connection.{i}.Password` | from `device.xmppCredential()` |
| `Device.XMPP.Connection.{i}.Domain` | the `domain` config value |
| `Device.XMPP.Connection.{i}.Resource` | the `resource` config value |
| `Device.XMPP.Connection.{i}.Enable` | true, and false while redialling |
| `Device.ManagementServer.ConnReqXMPPConnection` | the instance it chose |
| `Device.ManagementServer.ConnReqAllowedJabberIDs` | the `acsJid` config value |

It also disables any other connection instance carrying the same
username, which is how a duplicate left by an earlier pass is cleaned up.

It does not touch the incumbent ACS's account unless that is the only
instance the firmware has, which is the Sagemcom case below.

## What you must supply

- `domain`: a name with an A record the CPE can resolve, and a
  `_xmpp-client._tcp` SRV record beside it. **Not an address.** A CPE
  puts this into `XMPP.Connection.{i}.Domain` and resolves it; an IP
  literal leaves the connection `Enabled` at `Status: Disabled` for
  ever and every wake answers `service-unavailable`.
- `acsJid`: your ACS's own JID, `acs@<domain>`.
- A selector. The shipped one matches a `tag:xmpp` that nothing has, so
  an unedited adoption is inert.
- An XMPP server. `herder_xmpp: true` in the collection, port open from
  the CPE ranges, and STARTTLS configured if you want it (Herder
  v0.40.11 or later; earlier releases could not complete a bind for a
  client that declined STARTTLS).

## Firmware behaviour this encodes

Five things, each of which cost a debugging session:

- **Claim a spare instance where one exists.** A Grandstream HT801
  answers `AddObject` on this table with 9005 "Non writable array" and
  ships three fixed instances, the incumbent ACS on the first.
- **Take over the incumbent where there is no spare.** Sagemcom
  extenders ship exactly one connection and their firmware services
  only that one. An added instance accepts every write, reports it all
  back correctly, and sits at `Status: Disabled` for ever with no
  fault anywhere.
- **The domain must resolve.** See above.
- **The allowed JID moves with the domain.** The ACS's JID changes when
  the domain does, and a CPE still allowing the old one refuses every
  wake, silently.
- **Assert on every pass, not just on creation.** Writing a value only
  when the instance is claimed means a later config change can never
  reach a device that is already provisioned.

## Adopting it

Follow `../README.md`. The short version: copy both files into your
config repo, rename the rule, set `domain` and `acsJid`, point the
selector at one device, prove a wake against it, then widen.

Expect the first dial to take a while. A Fast381 took just over two
hours to come up after being reconfigured, which is its retry backoff
and is indistinguishable from broken if you stop watching after twenty
minutes.
