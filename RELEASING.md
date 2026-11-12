# Releasing AlphaResin

AlphaResin ships two ways:
- **The npm package `alpharesin`**: the library, the runtime and the `alpharesin` command.
- **The playground on GitHub Pages**: updated on every push to `main` by the
  Playground workflow.

## Every release

1. Set the new `version` in `packages/resin/package.json` (semantic versioning:
   a fix is a patch, a new built-in or target a minor version), and the same
   version in the README's status line.
2. Add the version's section to `CHANGELOG.md`: what changed, for someone who
   uses the package. On the day it is published, put the date in its heading
   (`## 0.2.0 (2026-01-31)`), as every earlier entry has.
3. Check that everything passes, from a clean install:

   ```sh
   npm ci
   npm run typecheck && npm test && npm run build && npm run check:playground
   npm pack ./packages/resin/dist/npm --dry-run
   ```

4. Merge to `main`, then tag that commit with the version and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

5. On GitHub, make a Release from the tag, with the version's CHANGELOG
   section, word for word, as its notes.

The Release workflow checks that the tag matches the package version, then
publishes `packages/resin/dist/npm` to npm with provenance. No token is
stored in the repository: npm trusts this repository's workflow (below).

`package-lock.json` pins the development tools. When they change, refresh it
with `npm install --package-lock-only` and commit it with the change.

## The first release, once

The package has to exist on npm before trusted publishing can be set up for it.

1. Log in to npm with an account that has two-factor authentication:

   ```sh
   npm login
   ```

2. Build the package and look at what will go up:

   ```sh
   npm run build -- npm
   npm pack ./packages/resin/dist/npm --dry-run
   ```

3. Publish it:

   ```sh
   npm publish ./packages/resin/dist/npm --access public
   ```

4. On npmjs.com, open alpharesin → Settings → Trusted publishing, and add this
   repository's GitHub Actions workflow `release.yml`. Then, under Publishing
   access, require two-factor authentication and disallow tokens.

## The playground

Repository settings → Pages → Source: **GitHub Actions**. The Playground
workflow builds `packages/resin/dist/playground` and publishes it at
https://fadhilmhd.github.io/alpharesin/.

To try it locally:

```sh
npm run build -- playground && npm run playground
```

Then open http://localhost:4330.
