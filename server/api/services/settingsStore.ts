import { eq } from 'drizzle-orm'
import { type UserSettings } from '@adamant/contract'
import { users, type Db } from '../../db/client.ts'

/** The signed-in user's settings. Null when the session's user no longer exists. */
export interface SettingsStore {
  read(userId: string): Promise<UserSettings | null>
  write(userId: string, settings: UserSettings): Promise<UserSettings | null>
}

export function createPostgresSettingsStore(db: Db): SettingsStore {
  return {
    async read(userId) {
      const rows = await db
        .select({ autoMerge: users.autoMerge })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return rows[0] ?? null
    },
    async write(userId, settings) {
      const rows = await db
        .update(users)
        .set({ autoMerge: settings.autoMerge, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning({ autoMerge: users.autoMerge })
      return rows[0] ?? null
    },
  }
}

export function createMemorySettingsStore(): SettingsStore & {
  readonly saved: Map<string, UserSettings>
} {
  const saved = new Map<string, UserSettings>()
  return {
    saved,
    async read(userId) {
      return saved.get(userId) ?? { autoMerge: true }
    },
    async write(userId, settings) {
      saved.set(userId, settings)
      return settings
    },
  }
}
