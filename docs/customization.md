# Customizing Peer Point OS

This distribution exposes controls at three depths. Use the Admin UI for runtime presentation and connector policy, use `deployment.jsonc` for infrastructure and trust boundaries, and change code only for reviewed capabilities. Custom skills are out of scope for this phase.

## Admin UI

Use `/admin` for policy that should not require a deployment:

- Site name, logo, accent color, announcements, and banners
- Agent instructions
- Connector visibility, resource availability, and auto-provisioning policy
- Signup behavior, featured blueprints, and output formats
- Supported skills when that admin surface is available later

Authentication, administrators, routes, model policy, OAuth credentials, and MCP Portal configuration remain deployment-controlled. The Admin UI must not redefine the trust boundary.

### Branding

Set the site name, logo, and accent color from `/admin`. Logo uploads accept PNG, JPEG, WebP, and SVG files up to 5 MB. The browser scales the longest edge to 256 pixels without cropping and converts the result to PNG. The server checks the PNG header and rejects anything over 256 KB or 512 pixels before storing it in the deployment's blueprint-content R2 bucket. Square images work best.

The logo appears in app chrome and the browser tab on each user's next connection. Use **Restore default** to remove it. Final Peer Point name, logo, colors, announcements, and instructions are a [required human input](runbooks.md#required-human-inputs).

## Deployment configuration

[`deployment.jsonc`](../deployment.jsonc) is the annotated, non-secret control surface:

| Path                   | Controls                                        | Peer Point posture                                                        |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `accountId`            | Resource ownership                              | `b157b3849ca30a481cae4bc5d9bc05ff`                                        |
| `publicBaseUrl`        | Public origin                                   | `null`, derived from the custom domain                                    |
| `workers.*.name`       | Stable Worker identities                        | Eight unique `peer-point-os*` names                                       |
| `workers.router.route` | Public address                                  | `os.cf.prompt2prod.dev`                                                   |
| `access`               | Access trust and administrators                 | Access only; issuer, AUD, and admins still required                       |
| `aiGateway`            | Model boundary                                  | Same-account `peer-point-os` gateway, Workers AI only, seven models       |
| `github`               | GitHub connected capability                     | OAuth App client ID; secret remains a Wrangler secret                     |
| `mcpPortal`            | Cloudflare connected capability                 | Real Portal endpoint and excluded upstream server IDs                     |
| `context`              | Sharing boundary and optional Artifacts storage | Public-origin scope by default                                            |
| `customGatekeeper`     | Example capability text                         | Organization display text only; not a custom skill system                 |
| `errorReporting`       | Private explicit-issue destination              | Console Reporter enabled                                                  |
| `resources`            | Blueprint/avatar KV and blueprint-content R2    | Automatic provisioning or existing IDs/names                              |
| `observability`        | Worker telemetry                                | Structured logs enabled; invocation logs and traces separately controlled |

Never put passwords, OAuth client secrets, Access JWTs, API tokens, or attendee tokens in this file. Install secrets interactively against the consuming Worker.

### Workers and routing

The deployment is eight Workers. Service bindings use these names, so rename and deploy them together.

| Key                | Configured name            | Role                                                                                                                     |
| ------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `router`           | `peer-point-os`            | Owns `os.cf.prompt2prod.dev`, serves the frontend, and proxies `/api`, `/blueprint-screenshot`, and `/gatekeeper/<name>` |
| `workshop`         | `peer-point-os-backend`    | Kernel, user Durable Objects, model policy, and RPC                                                                      |
| `context`          | `peer-point-os-context`    | Ambient Context Gatekeeper                                                                                               |
| `scheduler`        | `peer-point-os-scheduler`  | Ambient scheduled-work Gatekeeper                                                                                        |
| `github`           | `peer-point-os-github`     | Per-attendee GitHub OAuth capability                                                                                     |
| `mcpPortal`        | `peer-point-os-mcp-portal` | Per-attendee OAuth into a real Cloudflare MCP Server Portal                                                              |
| `customGatekeeper` | `peer-point-os-custom`     | Example organization capability                                                                                          |
| `errorReporter`    | `peer-point-os-errors`     | Private explicit-issue destination                                                                                       |

Only Router has a public route. The other seven are reachable only over service bindings. Generated configuration sets `preview_urls: false` on all eight and `workers_dev: false` on every private Worker. Router deploys last, after both OAuth Gatekeepers, Workshop, and the other dependencies.

The custom domain must belong to an active Cloudflare zone and must not conflict with an existing CNAME. Wrangler creates the DNS record and certificate. `publicBaseUrl` stays `null`, so the deploy derives `https://os.cf.prompt2prod.dev` for OAuth callbacks and the Context sharing boundary.

A `workers.dev` route remains useful for isolated evaluation, but it is not the configured Peer Point topology. If used, set `publicBaseUrl` exactly to `https://<router-name>.<subdomain>.workers.dev`; a mismatch breaks OAuth redirects and changes the Context isolation boundary.

### Access-only identity

Peer Point uses [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) as its only sign-in mechanism. Configure the self-hosted application for `os.cf.prompt2prod.dev` and select the [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), which authenticates attendees with their Cloudflare Dashboard account.

Configure:

- `issuer`: the Access team HTTPS origin, with no path.
- `audience`: the application's [AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
- `admins`: Access-verified email addresses allowed into `/admin`.

The deploy sets `CF_ACCESS_ISS`, `CF_ACCESS_AUD`, and the Access-mode frontend build flag. The backend verifies the signed JWT and requires a trimmed, non-empty email claim. It does not accept identity from browser headers, bodies, query parameters, OAuth state, or RPC arguments, and it does not forward or log the raw JWT.

Do not add GitHub or Cloudflare to `AUTH_GATEKEEPERS`. They are connected capabilities, not Peer Point identity providers. Built-in password identity is not supported by this distribution.

### GitHub capability

GitHub runs in the private `peer-point-os-github` Worker and is bound to Router and Workshop as `GATEKEEPER_GITHUB`. Each attendee connects their own GitHub account and selects their own repository.

Use a GitHub **OAuth App**, not a GitHub App:

- Requested scopes: `repo read:user user:email`.
- Homepage: `https://os.cf.prompt2prod.dev`.
- Authorization callback: `https://os.cf.prompt2prod.dev/gatekeeper/github/oauth`.
- `deployment.jsonc`: set `github.clientId` to the non-secret client ID.
- Wrangler secret: install `CLIENT_SECRET` interactively on `peer-point-os-github`.

The generated Gatekeeper configuration sets `BASE_URL=https://os.cf.prompt2prod.dev/gatekeeper/github` and declares `CLIENT_SECRET` as required. Repository pushes, issue changes, pull requests, and other mutations queue for human approval. See [OAuth and secrets](runbooks.md#oauth-and-secrets).

### MCP Server Portal capability

The MCP Gatekeeper must point to a real [Cloudflare MCP Server Portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/). Add `https://mcp.cloudflare.com/mcp` as the approved **upstream inside the Portal**. The direct endpoint is not a Portal and is rejected as `mcpPortal.portalUrl`.

Generated configuration fixes the production posture:

```text
BASE_URL=https://os.cf.prompt2prod.dev/gatekeeper/mcp-portal
MCP_PORTAL_NAME=Cloudflare API
MCP_PORTAL_AUTH=oauth
MCP_PORTAL_TRUST_ANNOTATIONS=false
MCP_ALLOW_INSECURE=false
```

Set `mcpPortal.portalUrl` to the real Portal's HTTPS MCP endpoint. Record the Cloudflare API upstream server ID and put only server IDs that must not be grantable in `hiddenServerIds`. Portal-native `portal_*` administration tools are excluded from every grant regardless of configuration.

The Portal must expose upstream tools directly. Use a Code Mode policy of **Off** or **Opt-in**. If the Portal is **On by default**, append `?codemode=off` to its endpoint. **Enforced** Code Mode is incompatible. Do not opt in to Code Mode or add context-optimization query parameters.

Every attendee completes Portal OAuth for their own Cloudflare account. With trust annotations fixed to false, mutations remain approval-gated; no upstream annotation can auto-approve a write. See [MCP Portal provisioning](runbooks.md#mcp-server-portal).

### AI models

Every model is served through the same-account `peer-point-os` [AI Gateway](https://developers.cloudflare.com/ai-gateway/) over the Workshop's pre-authenticated `WORKERS_AI` binding. There is no `CF_AI_GATEWAY_API_TOKEN`, cross-account gateway, user-added model, or non-Cloudflare provider in the Peer Point configuration.

```jsonc
"aiGateway": {
  "enabled": true,
  "name": "peer-point-os",
  "accountId": null,
  "providers": ["cloudflare"],
  "models": [
    "@cf/zai-org/glm-5.3",
    "@cf/zai-org/glm-5.3-flash",
    "@cf/zai-org/glm-5.2",
    "@cf/moonshotai/kimi-k2.6",
    "@cf/moonshotai/kimi-k2.7-code",
    "@cf/deepseek-ai/deepseek-v4-flash-0731",
    "@cf/deepseek-ai/deepseek-v4-pro-0813"
  ],
  "quickModel": "@cf/zai-org/glm-5.3-flash"
}
```

Validation requires exactly seven unique IDs, the exact `cloudflare` provider list, a quick model from those seven, and an account equal to the deployment account. The source enforces the same allowlist across discovery, resolution, quick tasks, chat, compaction, titles, model bindings, spawned agents, automation, stored legacy values, and user-added values.

AI requests include the Access-verified email in the five-key metadata policy described in [AI Gateway attribution](observability.md#ai-gateway-attribution).

### Storage

Leave storage values as `null` for Wrangler automatic provisioning:

```jsonc
"context": {
  "sharingDomain": null,
  "kvNamespaceId": null
},
"resources": {
  "blueprintsKvNamespaceId": null,
  "avatarsKvNamespaceId": null,
  "blueprintContentBucket": null
}
```

`context.sharingDomain: null` scopes collections to `https://os.cf.prompt2prod.dev`. Changing it or the public origin hides existing collections even when the right KV namespace remains bound. Set explicit KV namespace IDs or an R2 bucket name to adopt existing data.

### Context Artifacts

[Artifacts](https://developers.cloudflare.com/artifacts/) can provide Git-compatible Context collection storage. It is optional and requires account access:

```jsonc
"artifacts": { "enabled": true, "namespace": "peer-point-context-collections" }
```

Keep the namespace stable. Disabling the binding stops repository refresh and token management but does not delete repositories; the last synchronized content remains readable. Protect and revoke write tokens as credentials.

### Observability

Structured Worker logs and the private console-backed Error Reporter are enabled. Invocation logs, traces, exports, and browser reporting are separate controls. AI Gateway logs additionally contain the verified attendee email, so the [privacy and retention decision](runbooks.md#privacy-and-retention-disclosure) is a release blocker. See [Observability and error reporting](observability.md).

## Code extensions

Keep deployment-owned Gatekeepers outside the `cloudflare-os` submodule and prefer service bindings over source patches. The example Custom Gatekeeper demonstrates a capability boundary; it is not a custom skill framework. Do not implement custom skills in this phase.

Modify the pinned source only when a Worker boundary cannot express the behavior, and keep every change on the attendee-owned/source repository rather than an official Cloudflare repository. Follow the [exact pinned upgrade runbook](runbooks.md#exact-pinned-upgrades) before advancing the submodule.
