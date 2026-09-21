# Peer Point operations runbooks

These runbooks are release controls, not optional setup notes. Stop when a required human input is unresolved, a security assertion cannot be demonstrated, or a procedure would require a shared organizer credential.

## Required human inputs

The repository fixes account `b157b3849ca30a481cae4bc5d9bc05ff`, hostname `os.cf.prompt2prod.dev`, Access issuer/AUD/admin, AI Gateway `peer-point-os`, eight Worker names, seven models, quick model, GitHub client ID, and MCP Portal endpoint. The following values or decisions remain unresolved:

| Input                             | Status                           | Owner must provide                                                                                            |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GitHub client secret              | **Required rotation and secret** | Revoke the exposed value, then install its replacement interactively as `CLIENT_SECRET`; never record it here |
| Cloudflare API upstream server ID | **Required**                     | Server ID assigned inside the Portal; use it in validation and exclusions where appropriate                   |
| Branding                          | **Required**                     | Site name, logo, colors, announcements, and attendee instructions                                             |
| Attendee deployment procedure     | **Required decision and proof**  | Tested attendee-owned GitHub Actions or Cloudflare repository integration; no organizer token                 |
| AI Gateway privacy decision       | **Required approval**            | Disclosure, retention, access, deletion/export, and attendee request handling for logged email                |

All required non-secret deployment values are now present in `deployment.jsonc`. Keep secret values in provider secret stores; never add them to tracked configuration.

## Access and DNS

1. Confirm `prompt2prod.dev` is active in account `b157b3849ca30a481cae4bc5d9bc05ff` and `os.cf.prompt2prod.dev` has no conflicting CNAME. The Router custom domain creates DNS and TLS during deployment.
2. Create a [self-hosted Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) whose public hostname is exactly `os.cf.prompt2prod.dev`.
3. Use the [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/) so attendees authenticate with their Cloudflare Dashboard account. Do not enable GitHub, the MCP Portal, password auth, or another Gatekeeper as Peer Point identity.
4. Create the narrow attendee Allow policy. Access applications deny by default; do not add a public bypass policy.
5. Copy the team's HTTPS issuer origin and the application's [AUD tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) into `access.issuer` and `access.audience`. Add only Access-verified administrator emails to `access.admins`.
6. Deploy, then test an allowed attendee, a denied identity, an expired/invalid Access session, and an allowed non-admin. Only the listed administrator may open `/admin`.
7. Confirm the backend requires a non-empty verified email, rejects a missing/invalid Access JWT before account or model access, and never logs the raw JWT.
8. Confirm `os.cf.prompt2prod.dev` is the only public origin. All eight Workers must have Preview URLs disabled; the seven private Workers must have neither a custom domain nor `workers.dev` exposure.

If the issuer, AUD, policy, or admin emails are unknown, stop. Do not substitute browser headers or an OAuth provider identity.

## OAuth and secrets

### GitHub

1. Register a GitHub [OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app), not a GitHub App.
2. Set homepage `https://os.cf.prompt2prod.dev` and callback `https://os.cf.prompt2prod.dev/gatekeeper/github/oauth`.
3. Confirm the connect flow requests exactly `repo read:user user:email`. GitHub is a connected capability and must not be added to `AUTH_GATEKEEPERS`.
4. Put the client ID in `github.clientId`.
5. From a trusted terminal authenticated to the configured account, install the secret through Wrangler's interactive prompt:

   ```sh
   CLOUDFLARE_ACCOUNT_ID=b157b3849ca30a481cae4bc5d9bc05ff pnpm exec wrangler secret put CLIENT_SECRET --name peer-point-os-github
   ```

   Do not pass the value as an argument, echo it, save it in shell history, or commit it. If Wrangler identifies a different account or Worker, cancel.

6. Connect a test attendee, verify the callback returns through Router, and select only that attendee's repository.
7. Exercise a read, then stage a push or issue mutation. The read may execute as an observation; the mutation must remain pending until the attendee explicitly approves it. Do not enable mutation auto-approval for the event.
8. Revoke the OAuth grant and confirm reconnect is required. Rotate the client secret by installing the replacement interactively, validating a new connection, then revoking the old value at GitHub.

No organizer GitHub token is permitted. Attendees authorize their own accounts.

## MCP Server Portal

1. Provision a real [Cloudflare MCP Server Portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) in the intended account and hostname. Do not put the direct Cloudflare API MCP URL in `mcpPortal.portalUrl`; validation rejects that substitution.
2. Add `https://mcp.cloudflare.com/mcp` as an approved upstream **inside** the Portal. Record the Portal-assigned Cloudflare API server ID as a required operational input.
3. Set the Portal's Code Mode policy to **Off** or **Opt-in**. If policy is **On by default**, use the real Portal endpoint with `?codemode=off`. **Enforced** is incompatible. Do not add `optimize_context` or opt into Code Mode.
4. Configure Portal/Access authorization so every attendee completes OAuth for their own Cloudflare account. Do not use an organizer service token or shared bearer token.
5. Put the real Portal endpoint in `mcpPortal.portalUrl`. Add only reviewed, exact upstream IDs to `hiddenServerIds`; an ID there is hidden from the configurator and rejected at the grant boundary.
6. Deploy and confirm generated posture remains fixed:

   ```text
   MCP_PORTAL_NAME=Cloudflare API
   MCP_PORTAL_AUTH=oauth
   MCP_PORTAL_TRUST_ANNOTATIONS=false
   MCP_ALLOW_INSECURE=false
   ```

7. Confirm the configurator identifies the Cloudflare API upstream by the recorded server ID and exposes upstream tools directly. A plain MCP endpoint, an empty Portal, or a Portal that hides tools behind enforced Code Mode is not acceptable.
8. Confirm all `portal_*` administration tools are absent from grants. They are excluded in code because server-toggle tools could widen a Gadget's authority.
9. Exercise a read and a mutation with two attendee accounts. Each attendee must see their own OAuth flow and credentials. With trust annotations false, every write or unannotated tool call must queue for attendee approval; no server annotation may auto-apply it.

If a real Portal endpoint and upstream server ID are unavailable, stop for a product decision. Do not silently switch to the generic MCP Gatekeeper.

## Privacy and retention disclosure

AI Gateway logs contain the Access-verified attendee email under `user_email`. Cloudflare supports up to five flat scalar [custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/) entries, and Peer Point uses only `user_email`, `application`, `source`, `gadget_id`, and `chat_id`.

The event owner must replace this release-blocking placeholder with an approved record outside the repository if appropriate:

```text
STATUS: UNRESOLVED — HUMAN PRIVACY DECISION REQUIRED
Purpose for storing verified attendee email:
Notice shown before use:
AI Gateway payload logging setting:
Retention period and deletion schedule:
Roles allowed to query or export logs:
Export destination, region, and subprocessors:
Attendee access/deletion request process:
Incident and legal hold exceptions:
Decision owner and approval date:
```

Minimum validation after approval:

- Generate an inference as each pilot attendee and confirm `user_email` is the email from the verified Access JWT.
- Confirm metadata has no more than the five allowed keys and contains no JWT, cookie, token, prompt, response, or arbitrary document.
- Confirm a browser-supplied email cannot change the logged value.
- Apply the approved gateway log and payload settings, retention behavior, access roles, export controls, and deletion test.
- Publish the attendee disclosure before collecting event traffic.

Do not accept staging or production until this decision is complete.

## Deployment validation

The local Wrangler path validates the distribution itself. It is not the still-unresolved attendee project deployment procedure.

1. Start from a clean reviewed checkout. `git submodule status` must show one exact `cloudflare-os` SHA with no leading `+`, `-`, or `U`.
2. Use Node `>=24.19.0`, pnpm `11.17.0`, and the lockfile. Authenticate Wrangler to account `b157b3849ca30a481cae4bc5d9bc05ff`.
3. Resolve every required human input and install `CLIENT_SECRET` interactively.
4. Run:

   ```sh
   pnpm install
   pnpm --dir cloudflare-os install
   pnpm lint
   pnpm test
   pnpm check
   ```

5. Review the check output before `pnpm deploy`. It must build both Gatekeeper configurators, require the GitHub secret, generate exactly eight Workers, leave only Router routed, disable all Preview URLs, bind GitHub and MCP Portal to Router and Workshop, and order Router last.
6. Deploy with `pnpm deploy`. Record the root commit, exact submodule SHA, deployment time, operator, and resulting Worker version IDs without recording tokens.
7. Verify Access sign-in and `/admin`; all seven model IDs and GLM 5.3 Flash quick tasks; `user_email` in AI Gateway logs; Context and Scheduler; GitHub OAuth/read/approved mutation; Portal OAuth/read/approved mutation; Custom observation; and the Error Reporter query surface.
8. Probe every non-Router Worker name for public `workers.dev`, Preview URL, and custom-domain exposure. None may be reachable publicly.
9. Review logs for all eight Workers. Confirm no Access JWT, OAuth token, client secret, prompt body, or user document was emitted.

A successful deploy with a missing integration, wrong account, empty model picker, or unverified privacy behavior is a failed deployment.

## Rollback

1. Stop new attendee sessions and record the incident time, current root commit, submodule SHA, Worker version IDs, and affected resources.
2. Prefer [`wrangler rollback`](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) or deployment history only when the previous version's service bindings, Durable Object migrations, and storage schema remain compatible.
3. For a coordinated compatible rollback, restore private dependencies first, then Workshop, then Router last. Keep all Worker names and storage bindings unchanged.
4. For an incompatible release, check out the exact prior root commit and exact prior submodule gitlink, restore the reviewed non-secret deployment configuration, reinstall the prior lockfile, run `pnpm check`, and redeploy in normal dependency order. Do not improvise mixed source versions.
5. Do not delete or recreate Durable Objects, KV namespaces, R2 buckets, Portal grants, or OAuth Apps as a rollback shortcut. Schema migrations may require a forward fix.
6. Repeat deployment validation, including Access, both OAuth capabilities, approvals, seven-model enforcement, metadata attribution, and public exposure.
7. Reopen traffic only after the incident owner accepts the validation record.

## Exact pinned upgrades

The source gitlink and deployment toolchain are release inputs. Never upgrade from a branch name, tag alone, range resolution, or `latest`.

1. Record exact current values:

   ```sh
   git rev-parse HEAD
   git -C cloudflare-os rev-parse HEAD
   git submodule status
   pnpm --version
   pnpm exec wrangler --version
   ```

2. Select one reviewed 40-character source commit. Fetch that commit, check it out detached in `cloudflare-os`, and update only the gitlink. `git submodule status` must no longer show a leading `+` before release.
3. Review every source commit between old and new pins, especially Access verification, AI metadata/model enforcement, Workshop/Router configs, GitHub, MCP Portal, approval queues, Durable Object migrations, and generated manifest contracts.
4. Keep shared catalog entries byte-identical with `cloudflare-os/pnpm-workspace.yaml`. The current exact deployment pins include pnpm `11.17.0`, Wrangler `4.128.0`, TypeScript `7.0.2`, and Vite `7.3.6`; change an exact pin only as an explicit reviewed upgrade and update the lockfile.
5. Run both installs, `pnpm lint`, `pnpm test`, and `pnpm check` from a fresh checkout. Review the lockfile and gitlink diff; do not accept unrelated transitive churn.
6. Deploy to staging and complete the security validation and two-attendee pilot. Promote only the exact tested root commit plus exact tested gitlink.
7. Keep the prior exact pair and Worker version IDs as the rollback target.

## Staging and security validation

Use production-equivalent Access, bindings, Portal posture, model allowlist, and secrets with isolated staging data.

- Reject missing, expired, wrong-issuer, and wrong-AUD Access JWTs before user or model access; require a non-empty verified email.
- Attempt to spoof email through headers, bodies, query parameters, OAuth state, RPC arguments, and `cf-aig-metadata`; the verified Access email must win.
- Inspect interactive chat, quick tasks, title generation, compaction, model bindings, spawned agents, automated Gadget calls, retries, and fallback requests for exact five-key metadata policy.
- Confirm exactly seven models are discoverable. Reject a non-Cloudflare provider, an eighth model, a quick model outside the seven, a stored legacy model, and a user-added model server-side.
- Confirm only Router is public and all eight Preview URLs are disabled.
- Verify GitHub and MCP credentials remain isolated between two users. A user must not read another user's repository, Portal server, token, or tool result.
- Confirm GitHub and MCP mutations remain pending until the owning attendee approves them. Portal annotations remain untrusted and Portal admin tools remain excluded.
- Confirm the real Portal fronts `https://mcp.cloudflare.com/mcp`, OAuth is per attendee, and Code Mode is compatible/off.
- Search Worker and AI Gateway logs for secrets, raw JWTs, payloads, and cross-attendee identifiers.
- Test secret rotation, OAuth revocation/reconnect, compatible rollback, and a failed deployment cleanup path.

Record evidence and the exact commits tested. Verbal confirmation is not a release artifact.

## Fresh-account two-attendee pilot

This pilot is mandatory before any browser-only deployment claim.

1. Create two independent test attendees, each with a new GitHub identity and new Cloudflare account. Neither environment may have a local IDE, Node.js, pnpm, Wrangler, or an organizer deployment token.
2. Give each attendee only the published event instructions and Access eligibility.
3. For each attendee, verify Cloudflare Dashboard identity through Access, the correct `user_email` in AI Gateway logs, exactly seven models, and rejection of an eighth.
4. Have each attendee connect their own GitHub account and repository, approve a mutation, and confirm the other attendee cannot see or change it.
5. Have each attendee authorize their own Cloudflare account through the real MCP Portal, approve a mutation, and confirm credential/tool-result isolation.
6. Execute the proposed attendee-owned deployment procedure end to end. It must use an explicitly tested attendee-owned GitHub Actions workflow or Cloudflare repository integration and deploy only to that attendee's Cloudflare account.
7. Confirm no organizer token, local shell, implicit `npm install`, arbitrary remote build privilege, or unsupported MCP shell/deploy capability was assumed.
8. Repeat from a fresh account after fixing any instruction gap. Capture timings, failures, screenshots without secrets, deployment ownership, and attendee acceptance.

Until both attendees pass, describe browser-only arbitrary-repository deployment as **blocked**, not available or planned-complete.

## Release gate

Release only when every statement is true:

- All required human inputs are resolved without secrets entering Git.
- The exact root commit and exact `cloudflare-os` gitlink are reviewed, clean, and match staging/pilot.
- Access is the only identity method and uses the Cloudflare identity provider; GitHub and Cloudflare remain connected capabilities.
- Router is the only public Worker and all eight Preview URLs are disabled.
- The exact seven-model Workers AI allowlist and GLM 5.3 Flash quick model pass server-side bypass tests.
- AI Gateway uses the same-account binding with no API token and logs the verified email under the approved five-key/privacy policy.
- GitHub OAuth scopes/callback, interactive secret, per-attendee repository access, and mutation approval are verified.
- A real MCP Portal fronts the Cloudflare API upstream, uses per-attendee OAuth, compatible/off Code Mode, false trust annotations, excluded admin tools, and mutation approval.
- Branding and attendee instructions are accepted in `/admin`; no custom skill work is included.
- The attendee-owned deployment procedure passes for both fresh attendees without an organizer token.
- Deployment, security, rollback, privacy, and pilot evidence is retained by the event owner.

Tag or announce a release only after the gate owner signs this record. Do not weaken a failed item into a documentation caveat.
