import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { CliApp } from './app.tsx'
import { AdamantApi } from './api.ts'
import { argvToCommand } from './commands.ts'
import { loadCliConfig } from './config.ts'
import { CommandController } from './controller.ts'

function writeStartupError(message: string): void {
  process.stderr.write(`adamant: ${message}\n`)
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Adamant needs an interactive TTY. Run it in a supported terminal.')
  }

  const config = loadCliConfig()
  const controller = new CommandController(new AdamantApi(config))
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = createRoot(renderer)
  let shuttingDown = false

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    root.unmount()
    renderer.destroy()
  }

  process.once('SIGTERM', shutdown)
  const initialCommand = argvToCommand(process.argv.slice(2))
  root.render(
    <CliApp
      controller={controller}
      {...(initialCommand ? { initialCommand } : {})}
      onExit={shutdown}
    />,
  )

  try {
    await renderer.closed
  } finally {
    process.removeListener('SIGTERM', shutdown)
    shutdown()
  }
}

main().catch((error: unknown) => {
  writeStartupError(error instanceof Error ? error.message : 'Unable to start Adamant.')
  process.exitCode = 1
})
