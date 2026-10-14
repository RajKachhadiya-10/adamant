import { z } from 'zod'

const IdentifierSchema = z.string().min(1)
const TimestampSchema = z.string().datetime({ offset: true })
const JsonObjectSchema = z.record(z.string(), z.unknown())

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'report_only',
  'awaiting_hitl',
  'changes_requested',
  'publishing',
  'succeeded',
  'aborted',
  'failed',
])

export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunSummarySchema = z
  .object({
    id: IdentifierSchema,
    repositoryId: IdentifierSchema,
    sourceSha: IdentifierSchema,
    targetBranch: IdentifierSchema,
    status: RunStatusSchema,
    version: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()

export type RunSummary = z.infer<typeof RunSummarySchema>

export const AuditEventSchema = z
  .object({
    id: IdentifierSchema,
    runId: IdentifierSchema.nullable(),
    eventType: IdentifierSchema,
    payload: JsonObjectSchema,
    actorUserId: IdentifierSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .strict()

export type AuditEvent = z.infer<typeof AuditEventSchema>

export const RunDetailSchema = z
  .object({
    run: RunSummarySchema,
    auditEvents: z.array(AuditEventSchema),
  })
  .strict()

export type RunDetail = z.infer<typeof RunDetailSchema>

export const ActivityEventEnvelopeSchema = z
  .object({
    id: IdentifierSchema,
    type: IdentifierSchema,
    runId: IdentifierSchema.nullable(),
    occurredAt: TimestampSchema,
    payload: JsonObjectSchema,
  })
  .strict()

export type ActivityEventEnvelope = z.infer<typeof ActivityEventEnvelopeSchema>

/**
 * GitHub login: 1–39 letters, digits, or single hyphens. Dots and slashes are
 * paths, not owners, so they never reach a query.
 */
export const GithubOwnerSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/)

/**
 * GitHub repository name: 1–100 ASCII letters, digits, `.`, `-`, or `_`.
 * A leading dot is a path (`..`), and GitHub rejects a name that ends in `.git`.
 */
export const GithubRepoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/)
  .refine((name) => !name.toLowerCase().endsWith('.git'))

/** One GitHub App URL segment. Lowercase, so it cannot be `.`, `..`, or `a/b`. */
export const GithubAppSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100)

const githubInstallUrl =
  /^https:\/\/github\.com\/apps\/[a-z0-9]+(?:-[a-z0-9]+)*\/installations\/new$/

export const GithubInstallUrlSchema = z
  .object({
    url: z.url().refine((value) => githubInstallUrl.test(value)),
  })
  .strict()

export type GithubInstallUrl = z.infer<typeof GithubInstallUrlSchema>

export const GithubInstallationStatusSchema = z
  .object({
    owner: GithubOwnerSchema,
    name: GithubRepoNameSchema,
    defaultBranch: z.string().min(1).max(1024),
  })
  .strict()

export type GithubInstallationStatus = z.infer<typeof GithubInstallationStatusSchema>

/** The API and the CLI both say this. A 404 on the status route means "not installed yet". */
export const INSTALL_CONFIRMATION_NEEDS_DATABASE =
  'Install confirmation needs the hosted API with Postgres.'
