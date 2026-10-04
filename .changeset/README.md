# Changesets

Every change that affects users adds a changeset: `npm run changeset`, pick the bump (see RELEASING.md for what counts
as major / minor / patch while we're on 0.x), and write one line for the changelog. Merging to `main` opens a
"Version Packages" PR; merging that PR publishes to npm from CI.
