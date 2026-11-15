/**
 * The private distribution's removal and egress policy, as data.
 *
 * This module is the only declaration of what this distribution removes and
 * where network egress is allowed. `PRIVATE.md` describes the policy and
 * points here; the audit reads it and reports anything it does not cover.
 */

/** A package this distribution removes, with the reason it is gone. */
export interface RemovedPackage {
  /** Package name as it appears in imports and manifests. */
  readonly name: string
  /** Why this distribution does not ship it. */
  readonly reason: string
}

/** A package allowed to start network egress, with the reason it may. */
export interface TransportSeam {
  /** Repository-relative package directory. */
  readonly path: string
  /** What kind of traffic the seam carries. */
  readonly kind: TransportSeamKind
  /** Why egress from this package is allowed. */
  readonly reason: string
}

/** Traffic kinds a transport seam can carry. */
export type TransportSeamKind =
  | 'model-provider'
  | 'search-provider'
  | 'plugin-transport'
  | 'local-host'
  | 'inbound'
  | 'remote-exec'
  | 'dev-tooling'
  | 'build-tooling'
  | 'platform'
  | 'test-support'

/** What a recorded literal host is, for review. */
export type RecordedHostKind =
  | 'protocol-namespace'
  | 'test-placeholder'
  | 'model-provider'
  | 'package-metadata'
  | 'removed-surface'

/** A literal host accepted inside a transport seam. */
export interface RecordedHost {
  /** Hostname without scheme. */
  readonly host: string
  /** What the hostname identifies. */
  readonly kind: RecordedHostKind
}

/** Everything the private-distribution audit enforces. */
export interface PrivateDistributionPolicy {
  /** Top-level roots the audit scans. */
  readonly corpusRoots: readonly string[]
  /** Packages this distribution removes. */
  readonly removedPackages: readonly RemovedPackage[]
  /** Names retired with the removed surfaces. */
  readonly retiredIdentifiers: readonly string[]
  /** Packages allowed to start network egress. */
  readonly transportSeams: readonly TransportSeam[]
  /** Literal hosts accepted inside a transport seam. */
  readonly recordedHosts: readonly RecordedHost[]
  /** Path prefixes that must keep naming retired producers so old Sessions load. */
  readonly compatibilityPaths: readonly string[]
  /** Path prefixes excluded from the audit because they declare the policy itself. */
  readonly excludedPaths: readonly string[]
}

const removed = (name: string, reason: string): RemovedPackage => ({ name, reason })

/** Packages removed by this distribution, each with the surface it carried. */
export const REMOVED_PACKAGES: readonly RemovedPackage[] = [
  removed('@deepseek-ai/dsh-host-product-telemetry-otel', 'Desktop product analytics exporter'),
  removed('@deepseek-ai/dsh-session-telemetry', 'Session telemetry'),
  removed('@deepseek-ai/dsh-session-telemetry-otel', 'Session telemetry exporter'),
  removed('@deepseek-ai/dsh-otel', 'Shared telemetry exporter'),
  removed('@deepseek-ai/dsh-session-log-deepseek', 'Session log upload'),
  removed('@deepseek-ai/dsh-plugin-package-inventory-deepseek', 'Plugin inventory upload'),
  removed('@deepseek-ai/dsh-anonymous-user-id', 'Anonymous usage identifier'),
  removed('@deepseek-ai/dsh-client-product-analytics', 'Client product analytics'),
  removed('@deepseek-ai/dsh-client-ui-account-notifications', 'Sign-in notification surface'),
  removed('@deepseek-ai/dsh-client-ui-settings-account', 'Account settings surface'),
  removed('@deepseek-ai/dsh-client-ui-settings-session-log', 'Session log settings surface'),
  removed('@deepseek-ai/dsh-deepseek-account', 'DeepSeek account Sign In'),
  removed('@deepseek-ai/dsh-llm-deepseek-account', 'Sign-in backed model provider'),
]

/** Names retired with those surfaces. */
export const RETIRED_IDENTIFIERS: readonly string[] = [
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'anonymous-user-id',
  'x-deepseek-harness',
  'dsh_session_log',
  'dsh_plugin_packages',
  'ori_question',
  'sendOriginalQuestion',
  'DSH_TELEMETRY',
  'DSH_PRODUCT_ANALYTICS_OTLP_URL',
  'productTelemetry',
  'productAnalytics',
  'sessionTelemetry',
  'createEventReporter',
  'deepseekAccount',
  'deepseek-account',
  'platform-session',
  'mandatory-update',
  'check_client_update',
]

const seam = (path: string, kind: TransportSeamKind, reason: string): TransportSeam => ({ path, kind, reason })

/** Packages that may start network egress. Adding a provider costs one entry here. */
export const TRANSPORT_SEAMS: readonly TransportSeam[] = [
  seam('packages/llm/llm-deepseek', 'model-provider', 'Model requests to the endpoint the user configures'),
  seam('packages/llm/llm-pi-ai', 'model-provider', 'Model requests through the configured provider catalog'),
  seam('packages/web/web', 'search-provider', 'Search and fetch seams the user configures'),
  seam('packages/web/web-deepseek-api', 'search-provider', 'Search and fetch provider'),
  seam('packages/web/web-fetch-http', 'search-provider', 'HTTP fetch provider'),
  seam('packages/web/web-search-deepseek', 'search-provider', 'Search provider'),
  seam('packages/experimental/speech-to-text-sensevoice', 'model-provider', 'Speech model endpoint the user configures'),
  seam('packages/experimental/translator', 'model-provider', 'Translation endpoint the user configures'),
  seam('packages/mcp', 'plugin-transport', 'External tools the user configures'),
  seam('packages/experimental/claude-code-mods', 'plugin-transport', 'Plugin hooks the user supplies'),
  seam('packages/experimental/webhook-github', 'plugin-transport', 'Webhook receiver the user configures'),
  seam('packages/experimental/forge', 'plugin-transport', 'Git provider tooling the user invokes'),
  seam('packages/experimental/forge-github', 'plugin-transport', 'GitHub provider tooling the user invokes'),
  seam('packages/boot/plugin-market', 'plugin-transport', 'Plugin market metadata the user opens'),
  seam('packages/util/plugin-detail', 'plugin-transport', 'Plugin detail fetched from the registry the user browses'),
  seam('packages/client/connection', 'local-host', 'Client connection to the local Host'),
  seam('packages/client/file-upload', 'local-host', 'Uploads through the local Host connection'),
  seam('packages/client/ui-deliverables', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/client/ui-file-actions', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/client/ui-file-drag', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/client/ui-open-in-app', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/client/ui-plugin-manager', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/client/ui-sidebar-documentpreview', 'local-host', 'Local Host calls from a client surface'),
  seam('packages/extensions/tool-cordis', 'local-host', 'Tool calls through the local Host connection'),
  seam('packages/experimental/cua-macos', 'local-host', 'Computer-use helper process on this machine'),
  seam('packages/experimental/webworker-runtime', 'local-host', 'Worker runtime served by the local Host'),
  seam('packages/client/hmr', 'dev-tooling', 'Development hot-reload client served locally'),
  seam('packages/experimental/inspector', 'dev-tooling', 'Local debugging surface'),
  seam('packages/host/webserver', 'inbound', 'Local HTTP server; answers the browser, never dials out'),
  seam('packages/host/open-in-app', 'platform', 'Opens a URL in the user browser'),
  seam('packages/acp/acp', 'plugin-transport', 'ACP automation transport the client opens'),
  seam('packages/api/gateway', 'plugin-transport', 'Remote gateway service the operator runs'),
  seam('packages/ssh/ssh', 'remote-exec', 'SSH transport to the host the user configures'),
  seam('packages/ssh/subprocess-ssh', 'remote-exec', 'SSH transport to the host the user configures'),
  seam('packages/subprocess/subprocess', 'local-host', 'Supervises local child processes over a loopback socket'),
  seam('packages/util/http-proxy', 'plugin-transport', 'Proxy the user configures'),
  seam('packages/session-query/session-log-export', 'local-host', 'Export through the local Host API'),
  seam('packages/experimental/liveshare', 'plugin-transport', 'Paired-session transport the user opens'),
  seam('packages/experimental/liveshare-protocol', 'plugin-transport', 'Paired-session protocol'),
  seam('packages/test-support/llm-mock-server', 'test-support', 'Loopback mock server for tests'),
  seam('apps/desktop/src', 'local-host', 'Desktop main process connecting to its owned local Host'),
  seam('apps/desktop/scripts', 'build-tooling', 'Desktop build and publish scripts; maintainer machine only'),
  seam('apps/desktop-publisher', 'build-tooling', 'Desktop artifact publication and retention tooling; maintainer machine only'),
  seam('packages/experimental/cua-windows', 'local-host', 'Computer-use helper transport on this machine'),
  seam('apps/plugin-market-generator/src', 'build-tooling', 'Offline plugin market generator querying the public registry'),
  seam('scripts/benchmark-npm-resolution.ts', 'build-tooling', 'Benchmark harness serving a loopback registry'),
  seam('scripts/local-bundle-registry.ts', 'build-tooling', 'Local bundle registry served on loopback'),
  seam('scripts/primary-runtime', 'build-tooling', 'Downloads the pinned Node and Python runtime assets'),
  seam('scripts/test-non-loopback-address.ts', 'test-support', 'Loopback server a test binds'),
]

const hosts = (kind: RecordedHostKind, hostnames: readonly string[]): readonly RecordedHost[] =>
  hostnames.map(host => ({ host, kind }))

/** Literal hosts recorded inside transport seams, grouped by what they identify. */
export const RECORDED_HOSTS: readonly RecordedHost[] = [
  ...hosts('protocol-namespace', ['www.w3.org', 'json-schema.org', 'schemas.openxmlformats.org']),
  ...hosts('test-placeholder', [
    'dsh.internal',
    'dsh.invalid',
    'inspector.invalid',
    'liveshare.internal',
    'liveshare.invalid',
    'mock.invalid',
    'preview.invalid',
    'viewer.invalid',
    'gateway.acme.example',
    'gateway.example',
    'npm.example.com',
    'index.invalid',
    'unused.invalid',
  ]),
  ...hosts('model-provider', [
    'ai-gateway.vercel.sh',
    'api.ant-ling.com',
    'api.anthropic.com',
    'api.cerebras.ai',
    'api.deepseek.com',
    'api.fireworks.ai',
    'api.groq.com',
    'api.individual.githubcopilot.com',
    'api.kimi.com',
    'api.meta.ai',
    'api.minimax.io',
    'api.minimaxi.com',
    'api.mistral.ai',
    'api.moonshot.ai',
    'api.moonshot.cn',
    'api.openai.com',
    'api.together.ai',
    'api.x.ai',
    'api.xiaomimimo.com',
    'api.z.ai',
    'chatgpt.com',
    'claude.dev',
    'generativelanguage.googleapis.com',
    'hf-mirror.com',
    'huggingface.co',
    'inference.baseten.co',
    'integrate.api.nvidia.com',
    'open.bigmodel.cn',
    'openrouter.ai',
    'radius.pi.dev',
    'router.huggingface.co',
    'token-plan-ams.xiaomimimo.com',
    'token-plan-cn.xiaomimimo.com',
    'token-plan-sgp.xiaomimimo.com',
    'token-plan.ap-southeast-1.maas.aliyuncs.com',
    'token-plan.cn-beijing.maas.aliyuncs.com',
    'translate.googleapis.com',
  ]),
  ...hosts('package-metadata', [
    'api.github.com',
    'api.npmjs.org',
    'cdn.jsdelivr.net',
    'chrome-devtools-frontend.appspot.com',
    'edge.microsoft.com',
    'github.com',
    'learn.microsoft.com',
    'raw.githubusercontent.com',
    'nodejs.org',
    'registry.npmjs.org',
    'registry.npmmirror.com',
    'timestamp.digicert.com',
    'unpkg.com',
  ]),
  ...hosts('removed-surface', ['download.deepseek.com', 'download-test.deepseek.com']),
]

/** Paths that must keep naming retired producers so persisted Sessions load. */
export const COMPATIBILITY_PATHS: readonly string[] = [
  'packages/session/session-format-',
  'packages/session/session-persistence-',
  'packages/core/session/src/known-event-types.ts',
  'packages/core/session/src/types.ts',
  'packages/test-support/session-snapshot/',
  'packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts',
]

/** The audit's own declaration, excluded because it names the policy rather than using it. */
export const AUDIT_PATHS: readonly string[] = ['scripts/private-distribution/']

/** The policy the audit enforces. */
export const POLICY: PrivateDistributionPolicy = {
  corpusRoots: ['packages', 'apps', 'native', 'scripts'],
  removedPackages: REMOVED_PACKAGES,
  retiredIdentifiers: RETIRED_IDENTIFIERS,
  transportSeams: TRANSPORT_SEAMS,
  recordedHosts: RECORDED_HOSTS,
  compatibilityPaths: COMPATIBILITY_PATHS,
  excludedPaths: AUDIT_PATHS,
}
