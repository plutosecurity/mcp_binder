## What Changed

Describe the change in concrete terms.

## Validation

Run these before review:

```sh
npm run validate
npm run release:check
git diff --check
```

## Safety Checks

- [ ] No generated token files.
- [ ] No local deployment config.
- [ ] No private domains, IPs, usernames, or event-specific references.
- [ ] Docs updated when CLI behavior changed.
