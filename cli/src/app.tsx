import cliSpinners from 'cli-spinners'
import { type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { homedir } from 'node:os'
import { useEffect, useMemo, useRef, useState } from 'react'
import { X_LOGO } from './branding.ts'
import { type CommandDefinition, resolveSubmission, suggestionsFor } from './commands.ts'
import { type CommandController, formatActivity, type OutputLine } from './controller.ts'
import { type ActivityConnectionState, type ActivityEvent } from './sse.ts'

const accent = '#55a8ff'
const brandGold = '#d6a62b'
const muted = '#8b949e'
const error = '#f97583'
const success = '#56d364'

// Scrollback kept in memory. Older lines are dropped rather than hidden, so a
// long session does not re-render an ever-growing list.
const MAX_LINES = 1_000
const MAX_ACTIVITY = 200

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
  if (!state) return undefined
  if (state.kind === 'connected') return 'Watching live activity.'
  if (state.kind === 'connecting') return 'Connecting to activity…'
  return `Reconnecting in ${Math.ceil(state.delayMs / 1_000)}s (attempt ${state.attempt})…`
}

function suggestionLabel(command: CommandDefinition, selected: boolean): string {
  return `${selected ? '›' : ' '} ${command.usage}  ${command.description}`
}

function displayPath(path: string): string {
  const home = homedir()
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

const keep = <T,>(items: readonly T[], limit: number): readonly T[] =>
  items.length > limit ? items.slice(-limit) : items

export function CliApp({ controller, initialCommand, onExit }: CliAppProps) {
  const [input, setInput] = useState('')
  const [lines, setLines] = useState<readonly OutputLine[]>([])
  const [activity, setActivity] = useState<readonly ActivityEvent[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  // Rows of the latest `/runs`; arrows pick one and Enter on an empty prompt opens it.
  const [runChoices, setRunChoices] = useState<readonly OutputLine[]>([])
  const [selectedRun, setSelectedRun] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [connection, setConnection] = useState<ActivityConnectionState>()
  const watchAbortRef = useRef<AbortController | undefined>(undefined)
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
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

  const appendLines = (added: readonly OutputLine[]) => {
    setLines((current) => keep([...current, ...added], MAX_LINES))
  }

  const appendError = (message: string) => {
    appendLines([{ id: crypto.randomUUID(), tone: 'error', text: message }])
  }

  /** A reconnect loop repeats the same failure; one line per watch says it. */
  const appendWatchError = (message: string, shown: Set<string>) => {
    setLines((current) => {
      const last = current[current.length - 1]
      if (last && shown.has(last.id) && last.text === message) return current
      const added: OutputLine = { id: crypto.randomUUID(), tone: 'error', text: message }
      shown.add(added.id)
      return keep([...current, added], MAX_LINES)
    })
  }

  const clearScreen = () => {
    setLines([])
    setActivity([])
    setRunChoices([])
  }

  const startWatching = () => {
    stopWatching()
    const abort = new AbortController()
    watchAbortRef.current = abort
    const watchErrors = new Set<string>()
    setActivity([])
    void controller
      .followActivity({
        signal: abort.signal,
        onEvent: (event) => {
          setActivity((current) => keep([...current, event], MAX_ACTIVITY))
        },
        onConnection: setConnection,
        onError: (connectionError) => appendWatchError(connectionError.message, watchErrors),
      })
      .finally(() => {
        // It returns on its own only after a refusal it reported; stop showing a connection.
        if (watchAbortRef.current === abort) {
          watchAbortRef.current = undefined
          setConnection(undefined)
        }
      })
  }

  const execute = async (command: string) => {
    stopWatching()
    // After scrolling back, a new command's output would land out of view;
    // returning to the bottom also re-engages sticky scrolling.
    const scroll = scrollRef.current
    scroll?.scrollTo(scroll.scrollHeight)
    busyRef.current = true
    setBusy(true)
    setInput('')
    try {
      const result = await controller.execute(command)
      if (result.kind === 'clear') {
        clearScreen()
      } else if (result.kind === 'quit') {
        onExit()
      } else if (result.kind === 'watch') {
        startWatching()
      } else {
        appendLines(result.lines)
        if (result.runs) {
          setRunChoices(result.lines.filter((entry) => entry.runId))
          setSelectedRun(0)
        }
      }
    } catch (commandError) {
      appendError(commandError instanceof Error ? commandError.message : 'Command failed.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const submit = async (submittedInput = input) => {
    // One command at a time; the prompt keeps what was typed meanwhile.
    if (busyRef.current) return
    if (!submittedInput.trim()) {
      const runId = runChoices[selectedRun]?.runId
      if (runId) await execute(`/run ${runId}`)
      return
    }
    const resolved = resolveSubmission(submittedInput, suggestions[suggestionIndex])
    if ('complete' in resolved) {
      setInput(resolved.complete)
      return
    }
    await execute(resolved.submit)
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
      clearScreen()
      return
    }
    if (key.name === 'escape') {
      key.preventDefault()
      setInput('')
      return
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      key.preventDefault()
      scrollRef.current?.scrollBy(key.name === 'pageup' ? -0.8 : 0.8, 'viewport')
      return
    }
    if (key.name === 'tab' && suggestions.length > 0) {
      key.preventDefault()
      completeSuggestion()
      return
    }
    // j and k are letters while anything is typed; they only navigate an empty prompt.
    const plain = !key.ctrl && !key.meta && !key.shift && input === ''
    const up = key.name === 'up' || (plain && key.name === 'k')
    const down = key.name === 'down' || (plain && key.name === 'j')
    if (!up && !down) return
    if (suggestions.length > 0) {
      key.preventDefault()
      setSuggestionIndex(
        (current) => (current + (up ? -1 : 1) + suggestions.length) % suggestions.length,
      )
    } else if (runChoices.length > 0) {
      key.preventDefault()
      setSelectedRun((current) =>
        Math.min(runChoices.length - 1, Math.max(0, current + (up ? -1 : 1))),
      )
    }
  })

  const status = connectionLabel(connection)
  const selectedLineId = runChoices[selectedRun]?.id
  const showBrand = lines.length === 0 && activity.length === 0
  const version = `v${process.env.npm_package_version ?? '0.1.0'}`
  const footer =
    runChoices.length > 0 && input === ''
      ? '↑↓ select run · Enter open · PgUp/PgDn scroll · Ctrl+L clear · Ctrl+C quit'
      : '↑↓ navigate · Tab complete · PgUp/PgDn scroll · Ctrl+L clear · Ctrl+C quit'

  return (
    <box flexDirection="column" style={{ height: '100%', paddingLeft: 1, paddingRight: 1 }}>
      {showBrand ? (
        <box flexDirection="row" style={{ flexShrink: 0 }}>
          <box flexDirection="column">
            {X_LOGO.map((row, index) => (
              <text key={`${index}-${row}`} fg={brandGold} attributes={1}>
                {row}
              </text>
            ))}
          </box>
          <box flexDirection="column" style={{ paddingLeft: 2, paddingTop: 2 }}>
            <text fg={brandGold} attributes={1}>
              ADAMANT
            </text>
            <text fg="#e6edf3">Hosted repair CLI</text>
            <text fg={muted}>{version}</text>
          </box>
        </box>
      ) : (
        <box flexDirection="column" style={{ flexShrink: 0 }}>
          <text fg={brandGold} attributes={1}>
            ADAMANT
          </text>
          <text fg={muted}>{`${version} · ${displayPath(process.cwd())}`}</text>
        </box>
      )}

      {/* Scrolls instead of overflowing: past a screenful, new output used to
          draw over the prompt and the newest lines were never visible. */}
      <scrollbox
        ref={scrollRef}
        stickyScroll
        stickyStart="bottom"
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, marginTop: 1 }}
      >
        {lines.map((entry) => (
          <text
            key={entry.id}
            fg={entry.id === selectedLineId ? accent : toneColor(entry.tone)}
            {...(entry.id === selectedLineId ? { attributes: 1 } : {})}
          >
            {entry.text}
          </text>
        ))}
        {activity.map((event, index) => (
          <text key={event.id} fg={index === activity.length - 1 ? '#e6edf3' : muted}>
            {formatActivity(event)}
          </text>
        ))}
      </scrollbox>

      {/* Everything below the scrollback keeps its rows; only the scrollback gives way. */}
      {busy ? (
        <text fg={accent} style={{ flexShrink: 0 }}>
          {`${spinner.frames[spinnerFrame] ?? '·'} Working…`}
        </text>
      ) : null}
      {status ? (
        <text fg={muted} style={{ flexShrink: 0 }}>
          {status}
        </text>
      ) : null}

      {suggestions.length > 0 ? (
        <box flexDirection="column" style={{ flexShrink: 0 }}>
          {suggestions.map((suggestion, index) => (
            <text key={suggestion.name} fg={index === suggestionIndex ? accent : muted}>
              {suggestionLabel(suggestion, index === suggestionIndex)}
            </text>
          ))}
        </box>
      ) : null}

      <box flexDirection="row" style={{ flexShrink: 0 }}>
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
      <text fg={muted} style={{ flexShrink: 0 }}>
        {footer}
      </text>
    </box>
  )
}
