import { GithubOwnerSchema, GithubRepoNameSchema } from '@adamant/contract'

export type CommandName =
  'help' | 'status' | 'install' | 'runs' | 'run' | 'watch' | 'trigger' | 'clear'

export type SlashCommand =
  | { name: 'help' | 'status' | 'runs' | 'watch' | 'clear' }
  | { name: 'install'; owner: string; repo: string }
  | { name: 'run'; runId: string }
  | { name: 'trigger'; repositoryId: string; sourceSha: string }

export type CommandDefinition = {
  name: CommandName
  description: string
  /** Enter on the bare name leaves the prompt ready for arguments. */
  expectsArguments?: boolean
}

export const commandDefinitions: readonly CommandDefinition[] = [
  { name: 'help', description: 'Show available commands' },
  { name: 'status', description: 'Check the API and your session' },
  {
    name: 'install',
    description: 'Open the GitHub App install page and wait for the repository',
    expectsArguments: true,
  },
  { name: 'runs', description: 'List visible healing runs' },
  { name: 'run', description: 'Show a run and its audit trail', expectsArguments: true },
  { name: 'watch', description: 'Follow live webhook and audit activity' },
  { name: 'trigger', description: 'Start a healing run', expectsArguments: true },
  { name: 'clear', description: 'Clear visible command output' },
] as const

function commandError(message: string): Error {
  return new Error(message)
}

export function parseCommand(input: string): SlashCommand {
  const [name, ...args] = input.trim().split(/\s+/)
  if (!name?.startsWith('/')) {
    throw commandError('Start commands with /. Type /help to see available commands.')
  }

  switch (name.slice(1)) {
    case 'help':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'help' }
    case 'status':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'status' }
    case 'runs':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'runs' }
    case 'watch':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'watch' }
    case 'clear':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'clear' }
    case 'install': {
      if (args.length !== 1) throw commandError('Usage: /install <owner>/<repo>')
      const spec = args[0]
      const repository = spec ? githubRepository(spec) : undefined
      if (!repository) {
        throw commandError(
          'Usage: /install <owner>/<repo>. Owner and repository must be GitHub names, with no extra path.',
        )
      }
      return { name: 'install', owner: repository.owner, repo: repository.repo }
    }
    case 'run': {
      const runId = args[0]
      if (!runId || args.length !== 1) throw commandError('/run needs one run id.')
      return { name: 'run', runId }
    }
    case 'trigger': {
      const [repositoryId, sourceSha] = args
      if (!repositoryId || !sourceSha || args.length !== 2) {
        throw commandError('/trigger needs a repository id and a full commit SHA.')
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceSha)) {
        throw commandError('/trigger requires a full 40- or 64-character commit SHA.')
      }
      return { name: 'trigger', repositoryId, sourceSha }
    }
    default:
      throw commandError(`Unknown command: ${name}. Type /help to see available commands.`)
  }
}

export function suggestionsFor(input: string): readonly CommandDefinition[] {
  if (!input.startsWith('/')) return []
  const query = input.slice(1).toLowerCase()
  return commandDefinitions.filter((command) => command.name.startsWith(query))
}

/**
 * What Enter does with the prompt. A partly typed name runs the highlighted
 * suggestion (`/st` runs `/status`) instead of failing as an unknown command;
 * a command that needs arguments is completed so they can be typed next.
 */
export function resolveSubmission(
  input: string,
  highlighted: CommandDefinition | undefined,
): { submit: string } | { complete: string } {
  const typed = input.trim()
  const [word = '', ...args] = typed.split(/\s+/)
  const exact = commandDefinitions.find((command) => `/${command.name}` === word)
  const target = exact ?? (args.length === 0 && word.startsWith('/') ? highlighted : undefined)
  if (!target) return { submit: typed }
  if (args.length === 0 && target.expectsArguments) return { complete: `/${target.name} ` }
  return { submit: exact ? typed : `/${target.name}` }
}

export function argvToCommand(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined
  return `/${argv.join(' ')}`
}

/** One `owner/repo` segment. A second slash, `..`, or a non-GitHub name is rejected. */
function githubRepository(spec: string): { owner: string; repo: string } | undefined {
  const slash = spec.indexOf('/')
  if (slash <= 0 || spec.includes('/', slash + 1)) return undefined
  const owner = spec.slice(0, slash)
  const repo = spec.slice(slash + 1)
  if (!GithubOwnerSchema.safeParse(owner).success) return undefined
  if (!GithubRepoNameSchema.safeParse(repo).success) return undefined
  return { owner, repo }
}
