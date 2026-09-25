# Recipes

Configuration that is useful, generic, and **writes to the CPE**, so it
is not shipped active. A recipe is adopted deliberately: copied into
your own config repository, given your values, reviewed, and enabled by
you.

Nothing in this directory should be a config source. Point a source at
`baseline`, `platform` and the vendors you own; leave this alone. It is
a library to read and copy from, not content to sync.

## Why this exists separately

Herder decision 0025: shipped configuration observes, and anything that
writes to a subscriber's device is the operator's to enable. Mapping,
telemetry, device profiles and topology enrichment read what the CPE
already reports, so they ship and are active. A ProvisioningRule that
calls `device.set` changes somebody's home, and arriving uninvited is
not acceptable however generic it is.

The recipes here are exactly the content that fails that test and is
still worth having. `xmpp-connection-requests` sets eleven parameters
on every device it matches. It should never appear on a fleet because
somebody pointed a source at the wrong path.

## What a recipe contains

```
recipes/<name>/
├── README.md     what it does, what it WRITES, what it needs from you
├── <name>.yaml   the rule, always enabled: false
└── <name>.ts     the script
```

The README's "What this writes" section is the point of the format.
Before adopting anything here you should be able to read, in one place,
every parameter it will set on a subscriber's device.

## Adopting one

The rule and its script must end up in the **same config source**,
because a rule can only reference an asset from its own source. So
adoption is a copy into your repository, not a source pointed here:

1. Copy `<name>.yaml` and `<name>.ts` into your config repo.
2. Rename the rule so it is yours (`acme-xmpp`, not `xmpp`), which also
   keeps it from colliding with anything upstream later.
3. Fill in the `config` block. The shipped values are placeholders and
   the rule will refuse to run on them.
4. Validate: `POST /api/v1/config/<domain>/validate`.
5. Commit with the selector narrowed to one device, or a `lab` tag, and
   prove it on that device before widening.
6. Only then set `enabled: true`.

The `herder-workbench` skill `adopt-recipe` walks those steps and fills
the config from what it can read off your fleet.

## Contributing one

A recipe earns its place by being generic, by being proven on real
hardware, and by carrying the firmware quirks that cost somebody a
night. Write the "What this writes" section first: if you cannot list
what it sets, it is not ready to hand to another operator.
