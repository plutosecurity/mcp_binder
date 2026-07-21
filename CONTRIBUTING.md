# Contributing

This project is a security tool. Keep changes small, reviewable, and safe to publish.

## Development Checks

Run before committing:

```sh
npm run validate
git diff --check
```

Validation checks JavaScript syntax, manifest JSON, framework contracts, dashboard service behavior, evidence handling, and shell script syntax.

## Local Files That Must Not Be Committed

Do not commit:

- `deployment.framework-config.json`
- `dist/`
- private keys
- dashboard token files
- VM IPs, private domains, or provider-specific lab values

Use `framework-config.template.json` and the files under `examples/framework/` for publishable examples.

## Documentation

Keep the README short. Put command details in:

- `docs/deployment.md`
- `docs/configuration.md`
- `docs/infrastructure.md`
- `docs/operation.md`
- `docs/target-profiles.md`
- `docs/cli.md`
- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/troubleshooting.md`

## CLI Changes

Human output should be concise and operator-facing. Do not print raw shell commands, low-level script paths, or token values in default output.

Machine-readable details belong in `--json` output.

## Scripts

The supported entry point is:

```sh
node scripts/framework-cli.js
```

The lower-level shell scripts are implementation details:

- `deploy-operator-ssh.sh` and `clean-operator-ssh.sh` run locally and handle SSH/SCP transport.
- `setup-operator-vm.sh` and `clean-operator-vm.sh` run on the VM with `sudo`.

Keep that split intact so future transport providers can reuse the same VM-local installer and cleaner.
