import cliSpinners from 'cli-spinners'
import { useKeyboard } from '@opentui/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type CommandDefinition, suggestionsFor } from './commands.ts'
import { type CommandController, type OutputLine } from './controller.ts'
import { type ActivityConnectionState, type ActivityEvent } from './sse.ts'

const accent = '#55a8ff'
const muted = '#8b949e'
const error = '#f97583'
const success = '#56d364'

type CliAppProps = {
  controller: CommandController
  initialCommand?: string
  onExit(): void
}

function toneColor(tone: OutputLine['tone']): string {
  switch (tone) {
    case 'accent':
      return accent
    case 'error':
      return error
    case 'success':
      return success
    case 'muted':
      return muted
    case 'normal':
      return '#e6edf3'
  }
}

function connectionLabel(state: ActivityConnectionState | undefined): string | undefined {
  if (!state || state.kind === 'connected') return undefined
  if (state.kind === 'connecting') return 'Connecting to activity…'
  return `Reconnecting in ${Math.ceil(state.delayMs / 1_000)}s (attempt ${state.attempt})…`
}

function suggestionLabel(command: CommandDefinition, selected: boolean): string {
  return `${selected ? '›' : ' '} ${command.usage}  ${command.description}`
}

export function CliApp({ controller, initialCommand, onExit }: CliAppProps) {
  const [input, setInput] = useState('')
  const [lines, setLines] = useState<readonly OutputLine[]>([])
  const [activity, setActivity] = useState<readonly ActivityEvent[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [selectedRun, setSelectedRun] = useState(0)
  const [busy, setBusy] = useState(false)
  const [connection, setConnection] = useState<ActivityConnectionState>()
  const watchAbortRef = useRef<AbortController | undefined>(undefined)
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  const suggestions = useMemo(() => suggestionsFor(input), [input])
  const spinner = cliSpinners.dots

  useEffect(() => {
    if (!busy || process.env.NO_COLOR || process.env.ADAMANT_REDUCED_MOTION) return
    const interval = setInterval(() => {
      setSpinnerFrame((current) => (current + 1) % spinner.frames.length)
    }, spinner.interval)
    return () => clearInterval(interval)
  }, [busy, spinner.frames.length, spinner.interval])

  useEffect(() => {
    if (initialCommand) void submit(initialCommand)
    return () => {
      watchAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    setSuggestionIndex((current) => Math.min(current, Math.max(0, suggestions.length - 1)))
  }, [suggestions.length])

  const stopWatching = () => {
    watchAbortRef.current?.abort()
    watchAbortRef.current = undefined
    setConnection(undefined)
  }

  const appendError = (message: string) => {
    setLines((current) => [...current, { id: crypto.randomUUID(), tone: 'error', text: message }])
  }

  const startWatching = () => {
    stopWatching()
    const abort = new AbortController()
    watchAbortRef.current = abort
    setActivity([])
    void controller.followActivity({
      signal: abort.signal,
      onEvent: (event) => {
        setActivity((current) => [...current.slice(-99), event])
      },
      onConnection: setConnection,
      onError: (connectionError) => appendError(connectionError.message),
    })
  }

  const submit = async (submittedInput = input) => {
    if (!submittedInput.trim()) return
    stopWatching()
    setBusy(true)
    setInput('')
    try {
      const result = await controller.execute(submittedInput)
      if (result.kind === 'clear') {
        setLines([])
        setActivity([])
      } else if (result.kind === 'quit') {
        onExit()
      } else if (result.kind === 'watch') {
        startWatching()
      } else {
        setLines((current) => [...current, ...result.lines])
        setSelectedRun(0)
      }
    } catch (commandError) {
      appendError(commandError instanceof Error ? commandError.message : 'Command failed.')
    } finally {
      setBusy(false)
    }
  }

  const completeSuggestion = () => {
    const suggested = suggestions[suggestionIndex]
    if (!suggested) return
    setInput(`${suggested.usage.split(' ')[0]} `)
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') {
      key.preventDefault()
      onExit()
      return
    }
    if (key.ctrl && key.name === 'l') {
      key.preventDefault()
      setLines([])
      setActivity([])
      return
    }
    if (key.name === 'escape') {
      key.preventDefault()
      setInput('')
      return
    }
    if (key.name === 'tab' && suggestions.length > 0) {
      key.preventDefault()
      completeSuggestion()
      return
    }
    if ((key.name === 'up' || key.name === 'k') && suggestions.length > 0) {
      key.preventDefault()
      setSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
      return
    }
    if ((key.name === 'down' || key.name === 'j') && suggestions.length > 0) {
      key.preventDefault()
      setSuggestionIndex((current) => (current + 1) % suggestions.length)
      return
    }
    if (key.name === 'up' || key.name === 'k') {
      setSelectedRun((current) => Math.max(0, current - 1))
    }
    if (key.name === 'down' || key.name === 'j') {
      setSelectedRun((current) => current + 1)
    }
  })

  const status = connectionLabel(connection)
  const activityRows = activity.map((event) => {
    const runId = typeof event.payload.runId === 'string' ? ` · ${event.payload.runId}` : ''
    return `${event.type}${runId}`
  })

  return (
    <box flexDirection="column" style={{ height: '100%', paddingLeft: 1, paddingRight: 1 }}>
      <box flexDirection="column">
        <text fg={accent} attributes={1}>
          Adamant
        </text>
        <text
          fg={muted}
        >{`v${process.env.npm_package_version ?? '0.1.0'} · ${process.cwd()}`}</text>
      </box>

      <box flexDirection="column" style={{ flexGrow: 1, paddingTop: 1 }}>
        {lines.map((entry, index) => (
          <text key={entry.id} fg={index === selectedRun ? accent : toneColor(entry.tone)}>
            {entry.text}
          </text>
        ))}
        {activityRows.map((entry, index) => (
          <text
            key={`${index}-${entry}`}
            fg={index === activityRows.length - 1 ? '#e6edf3' : muted}
          >
            {entry}
          </text>
        ))}
        {busy ? <text fg={accent}>{`${spinner.frames[spinnerFrame] ?? '·'} Working…`}</text> : null}
        {status ? <text fg={muted}>{status}</text> : null}
      </box>

      {suggestions.length > 0 ? (
        <box flexDirection="column">
          {suggestions.slice(0, 5).map((suggestion, index) => (
            <text key={suggestion.name} fg={index === suggestionIndex ? accent : muted}>
              {suggestionLabel(suggestion, index === suggestionIndex)}
            </text>
          ))}
        </box>
      ) : null}

      <box flexDirection="row">
        <text fg={accent}>› </text>
        <input
          focused
          placeholder="Type /help for commands"
          value={input}
          onInput={setInput}
          onSubmit={() => void submit()}
          style={{ flexGrow: 1 }}
        />
      </box>
      <text fg={muted}>↑↓ navigate · Tab complete · Ctrl+L clear · Ctrl+C quit</text>
    </box>
  )
}
