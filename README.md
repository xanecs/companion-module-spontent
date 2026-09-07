# companion-module-spontent

A [Bitfocus Companion](https://bitfocus.io/companion) module for controlling the Spontent NodeCG
volleyball graphics package.

It talks to NodeCG's replicant API to:

- toggle the full-screen graphics from the Stream tab
- fire player lowerthirds for either squad
- expose team names and both rosters as Companion variables
- provide feedbacks that follow the live on-air state of each graphic

See [`companion/HELP.md`](companion/HELP.md) for configuration and the full action/variable reference.

## Development

This repository uses yarn (Corepack). npm and `package-lock.json` are not supported — the Bitfocus
build checks reject them.

```sh
corepack enable
yarn install
yarn package   # builds pkg.tgz, which can be sideloaded into Companion
yarn format    # prettier
```

## Releasing

1. Bump `version` in `package.json`.
2. Commit, tag as `v<version>`, and push the tag.
3. The `Release` workflow packages the module and publishes a GitHub release with the `.tgz` attached.
4. Submit the tag on the [Bitfocus Developer Portal](https://developer.bitfocus.io/) under
   _My Connections → Submit Version_ for review and distribution.

## License

MIT — see [LICENSE](LICENSE).
