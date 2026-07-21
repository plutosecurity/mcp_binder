# Release Checklist

Use this before syncing private development work into the public repository.

## Required Checks

```sh
npm run validate
npm run release:check
git diff --check
```

## Manual Review

- No `dist/` files.
- No dashboard or ingest token files.
- No local deployment configs.
- No private domains, private IPs, usernames, or event-specific text.
- No `.DS_Store` files.
- Public docs point to neutral examples or the public repository.

## Public Sync Rule

Sync the public repository from a clean archive export of the private branch. Do not push private history into the public repository.
