# Releasing mock-llm

Releases are cut **only by CI** (`.github/workflows/release.yml`), never from a laptop. Every version on npm carries a
[provenance statement](https://docs.npmjs.com/generating-provenance-statements) linking it to the commit and workflow
run that built it.

## How a release happens

1. Each PR that changes the package includes a changeset (`npx changeset`), which says what changed and the bump type.
2. When PRs merge to `main`, the release workflow opens or updates a **"Version Packages"** PR. That PR bumps
   `package.json` and writes the pending changesets into `CHANGELOG.md`.
3. A maintainer reviews that PR (version and changelog wording) and merges it.
4. The release workflow runs again on `main`:
   - `npm run check`, the full suite;
   - `npm run pack:check`, which checks the package contents and smoke-installs the packed tarball;
   - `changeset publish`, which publishes to npm with provenance and pushes the `mock-llm@x.y.z` git tag;
   - `npm run verify:published`, which installs the version just published from npm into a copy of every example and
     runs its tests.
5. If verification fails, fix forward with a patch release. If the release is actually broken, also run
   `npm deprecate mock-llm@x.y.z "<reason>"`. Don't unpublish.

## Versioning policy

mock-llm is **0.x**:

| Bump | When |
|---|---|
| `minor` (0.**x**.0) | New features, **or** any breaking change to the public API: exports, option names, scenario-file schema, journal shape, matcher names, error messages tests may rely on |
| `patch` (0.x.**y**) | Bug fixes, support for new provider/SDK fields with no API change, docs |

Every breaking change is called out in the changeset with a migration note. `1.0.0` comes when the API is stable, and
standard semver applies after that.

Supported Node versions are the active and maintenance LTS lines plus Current (CI tests each one). Dropping a Node line is a
`minor` bump.

### Pre-releases (`next` tag)

```sh
npx changeset pre enter next     # on a branch; commit the generated pre.json
# merge changesets as usual. The Version Packages PR produces 0.x.y-next.N, published under the `next` tag
npx changeset pre exit           # when ready for the stable release
```

`latest` only ever points at a stable version.

## Repository settings

- **Settings → Actions → General → Workflow permissions:** enable **Allow GitHub Actions to create and approve pull
  requests**. Otherwise the Version Packages PR fails with "GitHub Actions is not permitted to create or approve pull
  requests". PRs opened with the workflow token don't trigger CI on their own, but the release workflow runs the full check
  again before publishing.

## npm authentication

The workflow uses **npm trusted publishing** (OIDC): npm trusts this repository's `release.yml`, so CI holds no
long-lived token. Requirements are npm CLI ≥ 11.5.1 (the workflow upgrades npm), `id-token: write`, and
`repository.url` in `package.json` matching the GitHub repo exactly.

### One-time bootstrap (done 2026-10-04, kept for reference)

npm can only attach a trusted publisher to a package that already exists, so `0.1.0` was published with a short-lived
token. The workflow no longer reads any token. To bootstrap a new package, temporarily add
`env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }` to the changesets step:

1. On npmjs.com, create a **granular access token**. Scope: read and write, all packages (the package doesn't exist yet).
   Enable **Bypass two-factor authentication**, otherwise publishing fails with E403 on a 2FA account. Expiry: 7 days.
2. In your own terminal, run `gh secret set NPM_TOKEN --repo AndrewFooteQA/mock-llm` and paste the token at the prompt.
   Never pass it as an argument: it would end up in your shell history.
3. Push to `main`. The release workflow publishes `0.1.0` (package.json already has that version).
4. On npmjs.com, go to **mock-llm → Settings → Trusted publishing → GitHub Actions** and enter: owner `AndrewFooteQA`
   (same capitalisation), repo `mock-llm`, workflow `release.yml` (file name only), environment **empty**. Under
   **Allowed actions**, enable **Allow npm publish**. New trusted publishers allow only `npm stage publish`, and a direct
   publish then fails with `E403 OIDC permission denied for this action`.
   If the publisher doesn't match, the exchange fails with `E404 … OIDC token exchange error - package not found`. When
   publishing fails, the workflow's "show npm's OIDC / auth log lines" step prints the reason.
5. In the same settings, set **Publishing access** to "Require two-factor authentication and disallow tokens".
6. Revoke the token on npmjs.com and run `gh secret delete NPM_TOKEN`.

All later releases authenticate via OIDC.

## Checklist after a release

- [ ] npm package page shows the new version with a **Provenance** badge
- [ ] `verify:published` job is green
- [ ] Git tag `mock-llm@x.y.z` exists; the CHANGELOG entry reads well
