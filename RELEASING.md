# Releasing AlphaResin

AlphaResin ships two ways:
- **The npm package `alpharesin`**: the library, the runtime and the `alpharesin` command.
- **The playground on GitHub Pages**: updated on every push to `main` by the
  Playground workflow.

## Every release

1. Set the new `version` in `packages/resin/package.json` (semantic versioning:
   a fix is a patch, a new built-in or target a minor version).
2. Check that everything passes:

   ```sh
   npm run typecheck && npm test && npm run build && npm run check:playground
   ```

3. Merge to `main`, then tag that commit with the version and push the tag:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

The Release workflow checks that the tag matches the package version, then
publishes `packages/resin/dist/npm` to npm with provenance. No token is
stored in the repository: npm trusts this repository's workflow (below).

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
