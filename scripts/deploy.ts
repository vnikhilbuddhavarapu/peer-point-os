import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { pnpmCommand } from "../cloudflare-os/scripts/pnpm-command.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { AI_GATEWAY_PROVIDERS } from "./deployment-config.ts";
import type {
  BaseConfigs,
  BuildCommand,
  DeploymentConfig,
  GeneratedConfigs,
  ProdWranglerConfig,
  RouterRoute,
} from "./deployment-config.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// One deployment per checkout; use separate worktrees for concurrent deploys.
const generatedName = "wrangler.prod.jsonc";
const packageDirs = {
  router: "cloudflare-os/packages/router",
  workshop: "cloudflare-os/packages/workshop-backend",
  context: "cloudflare-os/packages/gatekeeper-context",
  scheduler: "cloudflare-os/packages/gatekeeper-scheduler",
  github: "cloudflare-os/packages/gatekeeper-github",
  mcpPortal: "cloudflare-os/packages/gatekeeper-mcp-portal",
  customGatekeeper: "packages/custom-gatekeeper",
  errorReporter: "packages/error-reporter",
} as const;
const generatedPaths = Object.fromEntries(
  Object.entries(packageDirs).map(([name, dir]) => [
    name,
    join(root, dir, generatedName),
  ]),
) as Record<keyof typeof packageDirs, string>;
const defaultContextArtifactsNamespace = "gatekeeper-context-collections";
const accountIdPattern = /^[a-f\d]{32}$/i;

export function deploymentConfigPath(args: string[]): string {
  const indexes = args.flatMap((arg, index) =>
    arg === "--config" ? [index] : [],
  );
  if (indexes.length > 1) throw new Error("Pass --config at most once.");
  if (indexes.length === 0) return join(root, "deployment.jsonc");
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--config requires a path to a deployment JSONC file.");
  }
  return resolve(root, value);
}

const requiredPaths = [
  "accountId",
  "workers.router.name",
  "workers.workshop.name",
  "workers.context.name",
  "workers.scheduler.name",
  "workers.github.name",
  "workers.mcpPortal.name",
  "workers.customGatekeeper.name",
  "access.issuer",
  "access.audience",
  "access.admins",
  "aiGateway.enabled",
  "github.clientId",
  "mcpPortal.portalUrl",
  "errorReporting.enabled",
  "customGatekeeper.name",
  "customGatekeeper.message",
  "observability.enabled",
  "observability.headSamplingRate",
  "observability.logs.invocationLogs",
  "observability.traces.enabled",
  "observability.traces.headSamplingRate",
];

// `aiGateway.accountId` is deliberately absent: null is its normal value, meaning "the gateway
// lives in the deployment's own account".
const aiGatewayPaths = [
  "aiGateway.name",
  "aiGateway.providers",
  "aiGateway.models",
  "aiGateway.quickModel",
];

const errorReportingPaths = [
  "workers.errorReporter.name",
  "errorReporting.environment",
];

const resourcePaths = [
  "context.kvNamespaceId",
  "resources.blueprintsKvNamespaceId",
  "resources.avatarsKvNamespaceId",
  "resources.blueprintContentBucket",
];

function valueAt(object: DeploymentConfig, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown> | undefined)?.[key],
      object,
    );
}

/**
 * The deployment's public origin: the address the router answers on.
 *
 * Two things read it, and both are load-bearing in different ways. `PUBLIC_BASE_URL` is what
 * upstream builds absolute links and OAuth redirect URIs from. The Context Gatekeeper's
 * `sharingDomain` prop is a data-isolation boundary, so a value that changes silently hides
 * collections rather than breaking a link.
 *
 * `validateConfig` guarantees that one of the two sources below is present, and that they agree when
 * both are.
 */
export function publicOrigin(config: DeploymentConfig): string {
  const explicit = config.publicBaseUrl;
  if (explicit) return explicit.replace(/\/$/, "");
  return `https://${config.workers.router.route.customDomain!}`;
}

function validatePublicBaseUrl(
  config: DeploymentConfig,
  route: RouterRoute,
): void {
  const value = config.publicBaseUrl;
  if (value === undefined) {
    throw new Error(
      "publicBaseUrl must be present. Use null to derive it from " +
        "workers.router.route.customDomain.",
    );
  }
  if (value === null) {
    if (!route.customDomain) {
      throw new Error(
        "publicBaseUrl is required on a workersDev route. The account's workers.dev subdomain is " +
          "not in deployment.jsonc and wrangler exposes no command to look it up, so there is " +
          "nothing to derive the public origin from -- and PUBLIC_BASE_URL and the Context sharing " +
          "boundary both need one. Set it to https://<router-name>.<subdomain>.workers.dev.",
      );
    }
    return;
  }
  if (typeof value !== "string") {
    throw new Error("publicBaseUrl must be null or a string.");
  }
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(
      "publicBaseUrl must be an HTTPS origin such as https://os.example.com.",
    );
  }
  if (!value.startsWith("https://") || origin !== value) {
    throw new Error(
      "publicBaseUrl must be an HTTPS origin only, with no path and no trailing slash.",
    );
  }
  if (route.customDomain && value !== `https://${route.customDomain}`) {
    throw new Error(
      `publicBaseUrl (${value}) does not match workers.router.route.customDomain ` +
        `(${route.customDomain}). Context data would then be scoped to a hostname this deployment ` +
        "does not answer on. Leave publicBaseUrl null to derive it from the custom domain.",
    );
  }
  // On a workersDev route there is nothing to cross-check the value against the way a custom domain
  // checks itself, so check its shape instead. The account's workers.dev subdomain is unknowable
  // here, but the rest of the hostname is not: wrangler serves the Worker at
  // <worker-name>.<subdomain>.workers.dev, so anything else is a typo or an unrelated host -- and it
  // would silently become both PUBLIC_BASE_URL and the Context isolation boundary, hiding existing
  // Context data and breaking every absolute link and OAuth redirect the backend builds.
  if (route.workersDev) {
    const labels = new URL(value).host.split(".");
    const [worker, subdomain, ...suffix] = labels;
    const routerName = config.workers.router.name;
    if (
      labels.length !== 4 ||
      suffix.join(".") !== "workers.dev" ||
      !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(subdomain ?? "")
    ) {
      throw new Error(
        `publicBaseUrl (${value}) is not a workers.dev origin. On a workersDev route it must be ` +
          `https://${routerName}.<subdomain>.workers.dev, where <subdomain> is the account's ` +
          "workers.dev subdomain. It becomes PUBLIC_BASE_URL and the Context sharing boundary, so a " +
          "hostname this deployment does not answer on hides Context data and breaks redirects.",
      );
    }
    if (worker !== routerName) {
      throw new Error(
        `publicBaseUrl (${value}) names Worker "${worker}", but the router is ` +
          `"${routerName}". The router is what answers on the public origin, so this origin belongs ` +
          `to a different Worker. Use https://${routerName}.${subdomain}.workers.dev, or change ` +
          "workers.router.name if the other name is the one you meant.",
      );
    }
  }
}

export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  const activePaths = [
    ...requiredPaths,
    ...(config.aiGateway?.enabled ? aiGatewayPaths : []),
    ...(config.errorReporting?.enabled ? errorReportingPaths : []),
  ];
  for (const path of activePaths) {
    const value = valueAt(config, path);
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    ) {
      throw new Error(`Missing required deployment value: ${path}`);
    }
  }

  for (const path of resourcePaths) {
    const value = valueAt(config, path);
    if (
      value === undefined ||
      (value !== null && (typeof value !== "string" || !value))
    ) {
      throw new Error(
        `Deployment resource must be null or a non-empty string: ${path}`,
      );
    }
  }

  let activeConfig: DeploymentConfig = config;
  if (!config.errorReporting.enabled) {
    activeConfig = {
      ...activeConfig,
      workers: { ...activeConfig.workers, errorReporter: undefined },
      errorReporting: { enabled: false },
    };
  }
  const placeholder = JSON.stringify(activeConfig).match(/<[^>]+>/)?.[0];
  if (placeholder)
    throw new Error(`Replace deployment placeholder ${placeholder}.`);

  const stringPaths = activePaths.filter(
    (path) =>
      ![
        "access.admins",
        "aiGateway.enabled",
        "aiGateway.providers",
        "aiGateway.models",
        "errorReporting.enabled",
        "observability.enabled",
        "observability.headSamplingRate",
        "observability.logs.invocationLogs",
        "observability.traces.enabled",
        "observability.traces.headSamplingRate",
      ].includes(path),
  );
  for (const path of stringPaths) {
    if (typeof valueAt(config, path) !== "string") {
      throw new Error(`Deployment value must be a string: ${path}`);
    }
  }

  if (!accountIdPattern.test(config.accountId)) {
    throw new Error(
      "Cloudflare account IDs must be 32 hexadecimal characters.",
    );
  }
  const workerNames = Object.entries(config.workers)
    .filter(([key]) => key !== "errorReporter" || config.errorReporting.enabled)
    .map(([, worker]) => worker.name);
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error("Worker names must be unique.");
  }
  if (
    !workerNames.every((name) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name),
    )
  ) {
    throw new Error(
      "Worker names must use lowercase letters, numbers, and hyphens.",
    );
  }

  const route = config.workers.router.route;
  if (!route || Boolean(route.workersDev) === Boolean(route.customDomain)) {
    throw new Error(
      "Set exactly one router route: workersDev or customDomain.",
    );
  }
  if (route.workersDev !== undefined && route.workersDev !== true) {
    throw new Error("Router workersDev must be boolean true when selected.");
  }
  if (
    route.customDomain !== undefined &&
    typeof route.customDomain !== "string"
  ) {
    throw new Error("Router customDomain must be a string.");
  }
  const hostnamePattern =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (route.customDomain && !hostnamePattern.test(route.customDomain)) {
    throw new Error("Router customDomain must be a lowercase hostname.");
  }

  validatePublicBaseUrl(config, route);

  const sharingDomain = config.context.sharingDomain;
  if (
    sharingDomain !== null &&
    (typeof sharingDomain !== "string" || !sharingDomain.trim())
  ) {
    throw new Error(
      "context.sharingDomain must be null or a non-empty string. null scopes Context data to the " +
        "deployment's public origin, which is what the hosted deploy does.",
    );
  }

  const issuer = new URL(config.access.issuer);
  if (
    issuer.protocol !== "https:" ||
    issuer.origin !== config.access.issuer.replace(/\/$/, "")
  ) {
    throw new Error("Cloudflare Access issuer must be an HTTPS origin only.");
  }
  if (
    !config.access.audience.trim() ||
    config.access.audience !== config.access.audience.trim()
  ) {
    throw new Error(
      "Cloudflare Access audience must not be blank or padded with whitespace.",
    );
  }
  if (
    !Array.isArray(config.access.admins) ||
    !config.access.admins.every(
      (email) => typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email),
    )
  ) {
    throw new Error("Every Access administrator must be an email address.");
  }

  validateAiGateway(config);

  if (
    !config.github.clientId.trim() ||
    config.github.clientId !== config.github.clientId.trim()
  ) {
    throw new Error("github.clientId must be a trimmed non-empty string.");
  }

  let portalUrl: URL;
  try {
    portalUrl = new URL(config.mcpPortal.portalUrl);
  } catch {
    throw new Error("mcpPortal.portalUrl must be a valid HTTPS URL.");
  }
  if (
    portalUrl.protocol !== "https:" ||
    portalUrl.username ||
    portalUrl.password
  ) {
    throw new Error(
      "mcpPortal.portalUrl must use HTTPS and must not contain credentials.",
    );
  }
  if (config.mcpPortal.portalUrl !== config.mcpPortal.portalUrl.trim()) {
    throw new Error("mcpPortal.portalUrl must not be padded with whitespace.");
  }
  portalUrl.hash = "";
  if (portalUrl.href === "https://mcp.cloudflare.com/mcp") {
    throw new Error(
      "mcpPortal.portalUrl must name a configured MCP Server Portal, not " +
        "https://mcp.cloudflare.com/mcp.",
    );
  }
  const hiddenServerIds = config.mcpPortal.hiddenServerIds;
  if (
    hiddenServerIds !== undefined &&
    (!Array.isArray(hiddenServerIds) ||
      !hiddenServerIds.every(
        (id) => typeof id === "string" && id.length > 0 && id === id.trim(),
      ))
  ) {
    throw new Error(
      "mcpPortal.hiddenServerIds must contain trimmed non-empty strings.",
    );
  }

  if (typeof config.errorReporting.enabled !== "boolean") {
    throw new Error("Error reporting enabled must be a boolean.");
  }
  const release = config.errorReporting.release;
  if (
    release !== null &&
    release !== undefined &&
    (typeof release !== "string" ||
      !release.trim() ||
      release !== release.trim())
  ) {
    throw new Error(
      "Error reporting release must be null or a non-padded string.",
    );
  }

  const artifactsConfig = config.context.artifacts;
  if (
    artifactsConfig !== undefined &&
    (artifactsConfig === null ||
      typeof artifactsConfig !== "object" ||
      Array.isArray(artifactsConfig))
  ) {
    throw new Error(
      "Context Artifacts configuration must be an object when present.",
    );
  }
  const artifactsEnabled = artifactsConfig?.enabled;
  if (artifactsEnabled !== undefined && typeof artifactsEnabled !== "boolean") {
    throw new Error("Context Artifacts enabled must be a boolean.");
  }
  const artifactsNamespace = artifactsConfig?.namespace;
  if (
    artifactsNamespace !== undefined &&
    (typeof artifactsNamespace !== "string" ||
      !/^[a-z\d][a-z\d._-]*$/i.test(artifactsNamespace))
  ) {
    throw new Error(
      "Context Artifacts namespace must be omitted or start with a letter or number and use only letters, numbers, dots, underscores, and hyphens.",
    );
  }

  const sampling = config.observability.headSamplingRate;
  if (typeof config.observability.enabled !== "boolean") {
    throw new Error("Observability enabled must be a boolean.");
  }
  if (typeof sampling !== "number" || sampling < 0 || sampling > 1) {
    throw new Error("Observability headSamplingRate must be between 0 and 1.");
  }
  if (
    typeof config.observability.logs.invocationLogs !== "boolean" ||
    typeof config.observability.traces.enabled !== "boolean"
  ) {
    throw new Error("Observability log and trace controls must be booleans.");
  }
  const traceSampling = config.observability.traces.headSamplingRate;
  if (
    typeof traceSampling !== "number" ||
    traceSampling < 0 ||
    traceSampling > 1
  ) {
    throw new Error("Observability trace sampling must be between 0 and 1.");
  }
  return config;
}

/** The account owning Peer Point's in-account AI Gateway. */
export interface AiGatewayPlan {
  gatewayAccountId: string;
}

/** Resolve the required in-account AI Gateway. */
export function aiGatewayPlan(config: DeploymentConfig): AiGatewayPlan {
  return { gatewayAccountId: config.accountId.toLowerCase() };
}

function validateAiGateway(config: DeploymentConfig): void {
  if (config.aiGateway.workersAi !== undefined) {
    throw new Error(
      "aiGateway.workersAi does nothing: Workers AI rides the same gateway route as every other " +
        "provider. Delete it; Peer Point uses aiGateway.models.",
    );
  }
  if (config.aiGateway.enabled !== true) {
    throw new Error("Peer Point requires aiGateway.enabled to be true.");
  }
  if (
    !Array.isArray(config.aiGateway.providers) ||
    config.aiGateway.providers.length !== 1 ||
    config.aiGateway.providers[0] !== AI_GATEWAY_PROVIDERS[0]
  ) {
    throw new Error(
      'Peer Point requires aiGateway.providers to be exactly ["cloudflare"].',
    );
  }

  const gatewayAccountId = config.aiGateway.accountId;
  if (
    gatewayAccountId !== null &&
    (typeof gatewayAccountId !== "string" ||
      !accountIdPattern.test(gatewayAccountId) ||
      gatewayAccountId.toLowerCase() !== config.accountId.toLowerCase())
  ) {
    throw new Error(
      "aiGateway.accountId must be null or the deployment account ID. Peer Point does not use " +
        "cross-account AI Gateway or an API token.",
    );
  }

  const models = config.aiGateway.models;
  if (!Array.isArray(models) || models.length !== 7) {
    throw new Error("aiGateway.models must contain exactly seven model IDs.");
  }
  if (
    !models.every(
      (model) =>
        typeof model === "string" && model.length > 0 && model === model.trim(),
    )
  ) {
    throw new Error(
      "Every aiGateway.models entry must be a trimmed non-empty string.",
    );
  }
  if (new Set(models).size !== models.length) {
    throw new Error("aiGateway.models entries must be unique.");
  }

  const quickModel = config.aiGateway.quickModel;
  if (
    typeof quickModel !== "string" ||
    !quickModel ||
    quickModel !== quickModel.trim()
  ) {
    throw new Error("aiGateway.quickModel must be a trimmed non-empty string.");
  }
  if (!models.includes(quickModel)) {
    throw new Error(
      "aiGateway.quickModel must be included in aiGateway.models.",
    );
  }
}

function routeConfig(route: RouterRoute) {
  return route.workersDev
    ? { workers_dev: true, routes: undefined }
    : {
        workers_dev: false,
        routes: [{ pattern: route.customDomain!, custom_domain: true }],
      };
}

function setCommon(
  config: ProdWranglerConfig,
  deployment: DeploymentConfig,
  name: string,
  route: RouterRoute = { workersDev: false },
): void {
  config.account_id = deployment.accountId;
  config.name = name;
  config.workers_dev = route.workersDev;
  delete config.routes;
  if (route.customDomain) Object.assign(config, routeConfig(route));
  // The router is the Access-protected origin, and a preview URL is an unauthenticated path around
  // it. Off on every Worker: those behind the router have no business being publicly reachable.
  config.preview_urls = false;
  config.observability = {
    ...config.observability,
    enabled: deployment.observability.enabled,
    head_sampling_rate: deployment.observability.headSamplingRate,
    logs: {
      ...config.observability?.logs,
      invocation_logs: deployment.observability.logs.invocationLogs,
    },
    traces: {
      ...config.observability?.traces,
      enabled: deployment.observability.traces.enabled,
      head_sampling_rate: deployment.observability.traces.headSamplingRate,
    },
  };
}

export function generateConfigs(
  config: DeploymentConfig,
  bases: BaseConfigs,
): GeneratedConfigs {
  validateConfig(config);
  const router = structuredClone(bases.router);
  const workshop = structuredClone(bases.workshop);
  const context = structuredClone(bases.context);
  const scheduler = structuredClone(bases.scheduler);
  const github = structuredClone(bases.github);
  const mcpPortal = structuredClone(bases.mcpPortal);
  const customGatekeeper = structuredClone(bases.customGatekeeper);
  const errorReporter = config.errorReporting.enabled
    ? structuredClone(bases.errorReporter)
    : undefined;
  const origin = publicOrigin(config);

  setCommon(
    router,
    config,
    config.workers.router.name,
    config.workers.router.route,
  );
  router.services = [
    { binding: "WORKSHOP_BACKEND", service: config.workers.workshop.name },
    // No entrypoint and no props: the router forwards whole HTTP requests, unlike the backend's
    // vendor-RPC bindings. The binding name is what picks the /gatekeeper/<name> path.
    { binding: "GATEKEEPER_CONTEXT", service: config.workers.context.name },
    { binding: "GATEKEEPER_SCHEDULER", service: config.workers.scheduler.name },
    { binding: "GATEKEEPER_GITHUB", service: config.workers.github.name },
    {
      binding: "GATEKEEPER_MCP_PORTAL",
      service: config.workers.mcpPortal.name,
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
    },
  ];

  setCommon(workshop, config, config.workers.workshop.name);
  workshop.vars = {
    ADMINS: config.access.admins,
    CF_ACCESS_ISS: config.access.issuer.replace(/\/$/, ""),
    CF_ACCESS_AUD: config.access.audience,
    // Upstream builds OAuth redirect URIs and other absolute links from this. The backend has no
    // public route of its own, so the router's origin is the only correct value.
    PUBLIC_BASE_URL: origin,
  };
  const gateway = aiGatewayPlan(config);
  Object.assign(workshop.vars, {
    CF_AI_GATEWAY: config.aiGateway.name,
    CF_AI_GATEWAY_ACCOUNT_ID: gateway.gatewayAccountId,
    CF_AI_GATEWAY_PROVIDERS: config.aiGateway.providers!.join(","),
    CF_AI_GATEWAY_MODELS: config.aiGateway.models!.join(","),
    CF_AI_GATEWAY_QUICK_MODEL: config.aiGateway.quickModel,
  });
  // Unconditional: as well as being the AI Gateway transport, this binding is what webFetch's
  // toMarkdown() runs on.
  workshop.ai = { binding: "WORKERS_AI" };
  workshop.services = [
    ...(config.errorReporting.enabled
      ? [
          {
            binding: "ERROR_REPORTER",
            service: config.workers.errorReporter!.name,
            entrypoint: "ErrorReporter",
            props: {
              service: config.workers.workshop.name,
              environment: config.errorReporting.environment,
              ...(config.errorReporting.release
                ? { release: config.errorReporting.release }
                : {}),
            },
          },
        ]
      : []),
    {
      binding: "GATEKEEPER_CONTEXT",
      service: config.workers.context.name,
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: config.context.sharingDomain ?? origin },
    },
    // No props: unlike Context, the Scheduler scopes nothing to a domain -- its schedules live in
    // its own `ScheduleDriver`/`SchedulerGatekeeper` Durable Objects, which belong to that Worker's
    // script identity and are reached through `ctx.exports` rather than a binding.
    {
      binding: "GATEKEEPER_SCHEDULER",
      service: config.workers.scheduler.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_GITHUB",
      service: config.workers.github.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_MCP_PORTAL",
      service: config.workers.mcpPortal.name,
      entrypoint: "GatekeeperVendor",
    },
    {
      binding: "GATEKEEPER_CUSTOM",
      service: config.workers.customGatekeeper.name,
      entrypoint: "GatekeeperVendor",
    },
  ];
  workshop.kv_namespaces = [
    {
      binding: "BLUEPRINTS",
      ...(config.resources.blueprintsKvNamespaceId
        ? { id: config.resources.blueprintsKvNamespaceId }
        : {}),
    },
    {
      binding: "AVATARS",
      ...(config.resources.avatarsKvNamespaceId
        ? { id: config.resources.avatarsKvNamespaceId }
        : {}),
    },
  ];
  workshop.r2_buckets = [
    {
      binding: "BLUEPRINT_CONTENT",
      ...(config.resources.blueprintContentBucket
        ? { bucket_name: config.resources.blueprintContentBucket }
        : {}),
    },
  ];
  // The router serves the frontend, and it is the only Worker with a public route.
  delete workshop.assets;

  setCommon(context, config, config.workers.context.name);
  context.kv_namespaces = [
    {
      binding: "CONTEXT_COLLECTIONS",
      ...(config.context.kvNamespaceId
        ? { id: config.context.kvNamespaceId }
        : {}),
    },
  ];
  if (config.context.artifacts?.enabled ?? false) {
    context.artifacts = [
      {
        binding: "ARTIFACTS",
        namespace:
          config.context.artifacts?.namespace ??
          defaultContextArtifactsNamespace,
      },
    ];
  } else {
    delete context.artifacts;
  }

  // Nothing but the common block: the Scheduler takes no vars, no secrets and no storage bindings of
  // its own -- which is what makes it installable with no user interaction upstream, and deployable
  // here without adding a configuration surface for it.
  setCommon(scheduler, config, config.workers.scheduler.name);

  setCommon(github, config, config.workers.github.name);
  github.vars = {
    BASE_URL: `${origin}/gatekeeper/github`,
    CLIENT_ID: config.github.clientId,
  };
  github.secrets = { required: ["CLIENT_SECRET"] };

  setCommon(mcpPortal, config, config.workers.mcpPortal.name);
  mcpPortal.vars = {
    BASE_URL: `${origin}/gatekeeper/mcp-portal`,
    MCP_PORTAL_URL: config.mcpPortal.portalUrl,
    MCP_PORTAL_NAME: "Cloudflare API",
    MCP_PORTAL_AUTH: "oauth",
    MCP_PORTAL_TRUST_ANNOTATIONS: "false",
    MCP_PORTAL_HIDDEN_SERVER_IDS: (config.mcpPortal.hiddenServerIds ?? []).join(
      ",",
    ),
    MCP_ALLOW_INSECURE: "false",
  };
  delete mcpPortal.secrets;

  setCommon(customGatekeeper, config, config.workers.customGatekeeper.name);
  customGatekeeper.vars = {
    CUSTOM_NAME: config.customGatekeeper.name,
    CUSTOM_MESSAGE: config.customGatekeeper.message,
  };

  if (errorReporter) {
    setCommon(errorReporter, config, config.workers.errorReporter!.name);
  }

  return {
    router,
    workshop,
    context,
    scheduler,
    github,
    mcpPortal,
    customGatekeeper,
    ...(errorReporter && { errorReporter }),
  };
}

// `--no-cache` goes before the task name. Everything after it is `[ADDITIONAL_ARGS]`, forwarded to
// the task's own command -- `vp run -F x build --no-cache` reaches `tsc` as an unknown option.

/** `vp run --no-cache <task>` for a package in the submodule's workspace. */
function submoduleBuild(pkg: string, task = "build"): string[] {
  return [
    "--dir",
    "cloudflare-os",
    "exec",
    "vp",
    "run",
    "-F",
    pkg,
    "--no-cache",
    task,
  ];
}

/** `vp run --no-cache <task>` for a package in this repository's own workspace. */
function ownBuild(pkg: string, task = "build"): string[] {
  return ["exec", "vp", "run", "-F", pkg, "--no-cache", task];
}

/**
 * The build steps `pnpm check` and `pnpm deploy` run, in order, from the repository root.
 *
 * Every one goes through `vp run` rather than `pnpm --filter <pkg> build`. Two of the three
 * submodule targets have no `build` *script* at all any more -- they have a Vite+ *task*, which
 * `pnpm --filter` cannot see -- and `vp run` runs scripts and tasks alike, so one form covers both.
 *
 * `--no-cache` on every one. A cache hit is only as good as its fingerprint, which is cheap to get
 * wrong on a build you can re-run and expensive on a deploy you cannot; it is upstream's rule for
 * the same reason (cloudflare-os/scripts/deploy-scripts.test.ts). It also restores the full ambient
 * environment, which is the belt to `workshop-frontend`'s `env: ['VITE_*']` braces: under a *cached*
 * `vp` run only declared patterns survive, and an undeclared variable is dropped from the command
 * and from the fingerprint both.
 *
 * The ordering matters at the end: the frontend has to build before the router deploy picks up
 * `../workshop-frontend/dist` as its assets.
 */
export function buildCommands(config: DeploymentConfig): BuildCommand[] {
  return [
    // `build:app` first, and separately. `gatekeeper-context`'s `build` is a package.json script
    // that spawns `vp run --cache build:app` itself, and the outer `--no-cache` does not reach a
    // nested invocation carrying its own flag -- measured: the configurator app replayed from
    // cache. Rebuilding it here from source is what upstream's own `deploy` script does; the
    // `build` step below then type-checks and replays the bytes this step just wrote.
    { args: submoduleBuild("@gadgets/gatekeeper-context", "build:app") },
    { args: submoduleBuild("@gadgets/gatekeeper-context") },
    // The Scheduler's `build` nests the same cached `vp run build:app`, so it needs the same pair.
    { args: submoduleBuild("@gadgets/gatekeeper-scheduler", "build:app") },
    { args: submoduleBuild("@gadgets/gatekeeper-scheduler") },
    {
      args: submoduleBuild("@gadgets/github-gatekeeper", "build:configurator"),
    },
    { args: submoduleBuild("@gadgets/github-gatekeeper") },
    {
      args: submoduleBuild(
        "@gadgets/mcp-portal-gatekeeper",
        "build:configurator",
      ),
    },
    { args: submoduleBuild("@gadgets/mcp-portal-gatekeeper") },
    { args: ownBuild("custom-gatekeeper") },
    ...(config.errorReporting.enabled
      ? [{ args: ownBuild("error-reporter") }]
      : []),
    // Access mode is a build-time constant in the frontend bundle (`src/useAuth.ts`), so it is set
    // here rather than inherited: a bundle built under a different value is wrong, not just stale.
    {
      args: submoduleBuild("@gadgets/workshop-frontend"),
      env: { VITE_CF_ACCESS_MODE: "true" },
    },
    { args: submoduleBuild("@gadgets/router") },
    { args: submoduleBuild("@gadgets/workshop-backend") },
  ];
}

// `allowTrailingComma` because wrangler accepts them and upstream uses them: the Scheduler's base
// config closes `build`, `migrations` and `observability` with one. Without the option every such
// comma is a parse *error*, so the deploy refuses a file wrangler itself reads happily.
const jsoncOptions = { allowTrailingComma: true };

async function readJsonc<T>(path: string): Promise<T> {
  const errors: ParseError[] = [];
  const result = parse(await readFile(path, "utf8"), errors, jsoncOptions) as T;
  if (errors.length) {
    const where = relative(root, path) || path;
    throw new Error(
      `${where}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`,
    );
  }
  return result;
}

// Every validateConfig message names a config path, so say which file those paths live in.
async function readDeployment(path: string): Promise<DeploymentConfig> {
  const config = await readJsonc<DeploymentConfig>(path);
  try {
    return validateConfig(config);
  } catch (error) {
    throw new Error(`${relative(root, path)}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function runCommand(
  command: string,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): void {
  const result = spawnSync(command, argv, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const where = relative(root, cwd) || ".";
    throw new Error(`${where}: ${label} failed. Its output is above.`);
  }
}

// Spawned through pnpmCommand rather than as a bare "pnpm": on Windows the pnpm on PATH is a `.cmd`
// shim Node refuses to spawn without a shell, and `shell: true` would re-split argv and break any
// checkout path containing a space.
function run(
  args: string[],
  cwd = root,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const [command, argv] = pnpmCommand(args, env);
  runCommand(command, argv, cwd, env, `pnpm ${args.join(" ")}`);
}

/**
 * `wrangler deploy` for one package, spawned as `node <entry>` when the entry point behind the
 * `.bin` shim can be found. That saves the ~0.33s `pnpm exec` costs per call and sidesteps the
 * Windows `.cmd` shim entirely; when it cannot be resolved, the pnpm path is still there.
 */
function deployWorker(dir: string, extraArgs: string[]): void {
  const cwd = join(root, dir);
  const args = ["deploy", "--config", generatedName, ...extraArgs];
  const entry = resolveBinEntry(cwd, "wrangler");
  if (entry) {
    runCommand(
      process.execPath,
      [entry, ...args],
      cwd,
      process.env,
      `wrangler ${args.join(" ")}`,
    );
  } else {
    run(["exec", "wrangler", ...args], cwd);
  }
}

function requireSubmodule(): void {
  if (!existsSync(join(root, "cloudflare-os/package.json"))) {
    throw new Error(
      "CloudflareOS submodule is not initialized. Run git submodule update --init.",
    );
  }
}

function build(config: DeploymentConfig): void {
  for (const { args, env } of buildCommands(config)) {
    run(args, root, env ? { ...process.env, ...env } : process.env);
  }
}

export function deploymentOrder(
  config: DeploymentConfig,
): (keyof typeof packageDirs)[] {
  return [
    ...(config.errorReporting.enabled ? ["errorReporter" as const] : []),
    "context",
    "scheduler",
    "customGatekeeper",
    "github",
    "mcpPortal",
    "workshop",
    "router",
  ];
}

async function main(): Promise<void> {
  requireSubmodule();
  const config = await readDeployment(
    deploymentConfigPath(process.argv.slice(2)),
  );
  const generated = generateConfigs(config, {
    router: await readJsonc(join(root, packageDirs.router, "wrangler.jsonc")),
    workshop: await readJsonc(
      join(root, packageDirs.workshop, "wrangler.jsonc"),
    ),
    context: await readJsonc(join(root, packageDirs.context, "wrangler.jsonc")),
    scheduler: await readJsonc(
      join(root, packageDirs.scheduler, "wrangler.jsonc"),
    ),
    github: await readJsonc(join(root, packageDirs.github, "wrangler.jsonc")),
    mcpPortal: await readJsonc(
      join(root, packageDirs.mcpPortal, "wrangler.jsonc"),
    ),
    customGatekeeper: await readJsonc(
      join(root, packageDirs.customGatekeeper, "wrangler.jsonc"),
    ),
    errorReporter: await readJsonc(
      join(root, packageDirs.errorReporter, "wrangler.jsonc"),
    ),
  });

  try {
    for (const [name, generatedConfig] of Object.entries(generated)) {
      await writeFile(
        generatedPaths[name as keyof typeof generatedPaths],
        JSON.stringify(generatedConfig, null, 2) + "\n",
      );
    }
    const check = process.argv.includes("--check");
    if (check) run(["test"]);
    build(config);
    const deployArgs = check ? ["--dry-run"] : [];
    for (const name of deploymentOrder(config)) {
      deployWorker(packageDirs[name], deployArgs);
    }
  } finally {
    await Promise.all(
      Object.values(generatedPaths).map((path) => rm(path, { force: true })),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    // One line, no stack: every failure here is a config or subprocess problem, not a script bug.
    console.error(`\nDeploy failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
