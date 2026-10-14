export type CommandName =
  'help' | 'status' | 'runs' | 'run' | 'watch' | 'trigger' | 'clear' | 'quit'

export type SlashCommand =
  | { name: 'help' | 'status' | 'runs' | 'watch' | 'clear' | 'quit' }
  | { name: 'run'; runId: string }
  | { name: 'trigger'; repositoryId: string; sourceSha: string }

export type CommandDefinition = {
  name: CommandName
  usage: string
  description: string
}

export const commandDefinitions: readonly CommandDefinition[] = [
  { name: 'help', usage: '/help', description: 'Show available commands' },
  { name: 'status', usage: '/status', description: 'Check the API and your session' },
  { name: 'runs', usage: '/runs', description: 'List visible healing runs' },
  { name: 'run', usage: '/run <id>', description: 'Show a run and its audit trail' },
  { name: 'watch', usage: '/watch', description: 'Follow live webhook and audit activity' },
  {
    name: 'trigger',
    usage: '/trigger <repositoryId> <fullSha>',
    description: 'Start a healing run',
  },
  { name: 'clear', usage: '/clear', description: 'Clear visible command output' },
  { name: 'quit', usage: '/quit', description: 'Close Adamant' },
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
    case 'quit':
      if (args.length > 0) throw commandError(`${name} does not accept arguments.`)
      return { name: 'quit' }
    case 'run': {
      const runId = args[0]
      if (!runId || args.length !== 1) throw commandError('Usage: /run <id>')
      return { name: 'run', runId }
    }
    case 'trigger': {
      const [repositoryId, sourceSha] = args
      if (!repositoryId || !sourceSha || args.length !== 2) {
        throw commandError('Usage: /trigger <repositoryId> <fullSha>')
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
  if (args.length === 0 && target.usage.includes(' ')) return { complete: `/${target.name} ` }
  return { submit: exact ? typed : `/${target.name}` }
}

export function argvToCommand(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined
  return `/${argv.join(' ')}`
}
