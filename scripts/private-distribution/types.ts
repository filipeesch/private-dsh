/** Shared types for the private-distribution audit. */

/** A stable identifier for each audit rule. */
export type RuleId = 'removed-package' | 'retired-identifier' | 'egress'

/** One rejected occurrence, with what to change. */
export interface Finding {
  /** Rule that rejected the occurrence. */
  readonly rule: RuleId
  /** Repository-relative path with forward slashes. */
  readonly path: string
  /** One-based source line. */
  readonly line: number
  /** Text the fingerprint is computed from; stable under pure movement. */
  readonly evidence: string
  /** What was found. */
  readonly message: string
  /** What a maintainer should do about it. */
  readonly hint: string
}
