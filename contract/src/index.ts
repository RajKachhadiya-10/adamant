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

export const GithubRepositorySchema = z
  .object({
    id: IdentifierSchema,
    owner: GithubOwnerSchema,
    name: GithubRepoNameSchema,
    defaultBranch: z.string().min(1).max(1024),
  })
  .strict()

export type GithubRepository = z.infer<typeof GithubRepositorySchema>

export const GithubRepositoryListSchema = z
  .object({
    repositories: z.array(GithubRepositorySchema),
  })
  .strict()

export type GithubRepositoryList = z.infer<typeof GithubRepositoryListSchema>

/** The API and the CLI both say this. A 404 on the status route means "not installed yet". */
export const INSTALL_CONFIRMATION_NEEDS_DATABASE =
  'Install confirmation needs the hosted API with Postgres.'

const cliLoginId = z.string().min(1).max(200)

/**
 * RFC 8628's alphabet for codes a person compares by eye: no vowels, so no words,
 * and no digits, so nothing reads as another character.
 */
export const CLI_LOGIN_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

/**
 * The code the terminal prints and the browser shows before it lets a sign-in reach
 * the terminal. Someone who sends a victim their own sign-in link gets a page whose
 * code matches no terminal the victim has open.
 */
export const CliLoginCodeSchema = z
  .string()
  .regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)

/** Browser path only. The poll secret stays in the POST body, never this URL. */
export const CliLoginStartSchema = z
  .object({
    loginId: cliLoginId,
    pollSecret: z.string().min(1).max(200),
    beginPath: z.string().regex(/^\/auth\/github\/cli\/begin\?login=[A-Za-z0-9_-]+$/),
    userCode: CliLoginCodeSchema,
  })
  .strict()

export type CliLoginStart = z.infer<typeof CliLoginStartSchema>

export const CliLoginPollSchema = z
  .object({
    loginId: cliLoginId,
    pollSecret: z.string().min(1).max(200),
  })
  .strict()

export const CliLoginPendingSchema = z
  .object({
    status: z.literal('pending'),
  })
  .strict()

export const CliLoginTokenSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .refine((token) => !/[\s\p{Cc}]/u.test(token)),
  })
  .strict()

/**
 * The terminal's approval mode, kept on the user. `autoMerge: false` (manual) leaves a
 * heal's PR open for review on the repositories that user's GitHub account owns.
 */
export const UserSettingsSchema = z
  .object({
    autoMerge: z.boolean(),
  })
  .strict()

export type UserSettings = z.infer<typeof UserSettingsSchema>
