import type { Context } from '@deepseek-ai/cordis'
/** Stable plugin name. */
export declare const name = 'host-authentication-desktop'
/** Connection creates Peers; ConnectionAuthentication owns credential verifiers. */
export declare const inject: string[]
/** In-memory startup input supplied by the Desktop process owner. */
export interface Config {
  /** Read the credential already validated on the private parent IPC channel. */
  readSecret: () => string
}
/**
 * Own one Desktop Peer and the verifier accepting its private credential.
 * The credential flows only between the Electron main process and its owned Host, never into the browser cookie jar.
 * @param ctx - plugin scope owning the Peer and registration.
 * @param config - in-memory credential reader from the Desktop startup owner.
 */
export declare function apply(ctx: Context, config: Config): void
//# sourceMappingURL=index.d.ts.map
