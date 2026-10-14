# Mid-eval calendar

**When:** 21 Sep – 17 Oct 2026 (present 17 Oct; freeze 15 Oct; rehearse 16 Oct)

**What:** [tasks.md](tasks.md) — hosted backend always on,
CLI attached to it, one heal **and merge**. No Electron Heal.

| Week | Dates        | Goal                                                        |
| ---- | ------------ | ----------------------------------------------------------- |
| 1    | 21–27 Sep    | Database + hosted API/worker (1.x, 4.1)                     |
| 2    | 28 Sep–4 Oct | App install + graph stubs + `adamant watch` (2.x, 3.x, 5.x) |
| 3    | 5–11 Oct     | Healing and merge (4.x)                                     |
| 4    | 12–17 Oct    | Rehearse; freeze 15 Oct                                     |

Friday: 26 Sep host is reachable; 3–4 Oct App + remote CLI see a webhook; 10–11 Oct one heal.

| Seat | Owns                                                    |
| ---- | ------------------------------------------------------- |
| R1   | Hosted API + worker                                     |
| R2   | Drizzle schema                                          |
| R3   | HTTP for CLI (`GET /runs`, `/activity`), `@adamant/cli` |
| R4   | GitHub App, failed CI + merged PR webhooks              |
| R5   | git allowlist, push agent branch                        |
| R6   | Tokens, open + merge our PR                             |
| R7   | LangGraph + OpenAI                                      |
| R8   | Sandbox                                                 |
| R9   | Eval repo + log parser                                  |
| R10  | zod + PR body                                           |

Demo: App → hosted backend → `adamant watch` on a laptop pointed at that
URL → red CI → PR merged. Then merge some other PR and show it in
`watch`. Backup: fixture logs.
