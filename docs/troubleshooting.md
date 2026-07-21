# Troubleshooting

Use this page when `bootstrap --deploy` fails. Test one layer at a time, then rerun the build after the failed layer is fixed.

## 1. Config

```sh
node scripts/framework-cli.js validate-config deployment.framework-config.json
node scripts/framework-cli.js preflight deployment.framework-config.json --offline
```

Expected:

- The config prints the VM, DNS records, runtime ports, and extension permissions.
- The SSH key path points to a file that exists on your machine.
- The dashboard hostname is outside the delegated rebinding domain.

## 2. DNS Records

```sh
node scripts/framework-cli.js dns verify \
  --config deployment.framework-config.json \
  --stage records

dig <dashboard-domain> +short
dig ns1.<rebind-domain> +short
dig NS <rebind-domain> +short
```

Expected:

```text
dashboard.example.com      -> <vm-public-ip>
ns1.rebind.example.com     -> <vm-public-ip>
rebind.example.com NS      -> ns1.rebind.example.com.
```

DNS can take a short time to converge. If `dig` works once and then returns nothing, wait and test again before changing records.

## 3. SSH And Sudo

```sh
ssh -i <ssh_key_path> <ssh_user>@<ssh_host>
sudo -n true
```

Expected:

- SSH logs into the VM with the same key and user from the config.
- `sudo -n true` exits without asking for an interactive password.

## 4. VM Runtime

```sh
node scripts/framework-cli.js vm verify \
  --config deployment.framework-config.json

curl -i http://<public-ip>:8080/payloads/victim-launcher.html
curl -i http://<dashboard-domain>:8090/healthz
```

Expected:

- The launcher returns an HTML response.
- The dashboard health endpoint returns `200 OK`.
- If the VM responds locally but not from your browser, fix inbound network rules or the host firewall.
- If the dashboard service exits immediately, verify that `/etc/mcp_binder/env` contains `MCP_BINDER_INGEST_TOKEN`. The normal deploy flow creates it automatically.

## 5. Dashboard Token

Local token:

```sh
cat dist/mcp-binder-dashboard-token
```

VM token:

```sh
ssh -i <ssh_key_path> <ssh_user>@<ssh_host> 'sudo cat /etc/mcp_binder/dashboard-token'
```

Expected:

- The local token exists after deployment.
- The VM token exists after deployment.
- Use the token when opening the dashboard or operator console.

## 6. Extension Pack

```sh
test -f dist/mcp-binder-lab/extension/manifest.json
test -f dist/mcp-binder-lab/extension/generated/runtime-config.json
```

Expected:

- `manifest.json` exists.
- `generated/runtime-config.json` contains the dashboard URL, rebinding domain, VM IP, and launcher port for this deployment.
- Load `dist/mcp-binder-lab/extension` from `chrome://extensions`.

Browser console errors for unreachable generated rebinding hostnames are expected before DNS records and VM services are ready. Treat them as deployment noise unless the DNS and VM checks above already pass.

## 7. Route53 Files

Route53 is optional. If you use it, generate reviewable records:

```sh
scripts/dns-route53-records.sh plan \
  --config deployment.framework-config.json \
  --out-dir dist/route53
```

Expected:

```text
dist/route53/route53.zone
dist/route53/route53-change-batch.json
```

Create the records in the Route53 UI or apply the change batch with the AWS CLI.
