import cliSpinners from 'cli-spinners'
import { type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import { homedir } from 'node:os'
import { useEffect, useMemo, useRef, useState } from 'react'
import { X_LOGO } from './branding.ts'
import { type CommandDefinition, resolveSubmission, suggestionsFor } from './commands.ts'
import { type CommandController, formatActivity, type OutputLine } from './controller.ts'
import { type ActivityConnectionState, type ActivityEvent } from './sse.ts'

const ink = '#e6edf3'
const accent = '#58a6ff'
const brandGold = '#d6a62b'
const muted = '#8b949e'
const dim = '#6e7681'
const error = '#f97583'
const success = '#3fb950'
const selectedBg = '#1f6feb'
const selectedDescription = '#d6e8ff'
const promptBg = '#21262d'

// Scrollback kept in memory. Older lines are dropped rather than hidden, so a
// long session does not re-render an ever-growing list.
const MAX_LINES = 1_000
const MAX_ACTIVITY = 200
const NAME_COLUMN = 16

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
      return ink
  }
}

function displayPath(path: string): string {
  const home = homedir()
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function presence(
  busy: boolean,
  state: ActivityConnectionState | undefined,
): {
  label: string
  color: string
} {
  if (busy) return { label: 'working', color: accent }
  if (state?.kind === 'connected') return { label: 'watching', color: success }
  if (state?.kind === 'connecting') return { label: 'connecting', color: brandGold }
  if (state?.kind === 'reconnecting') {
    return { label: `reconnecting ${Math.ceil(state.delayMs / 1_000)}s`, color: brandGold }
  }
  return { label: 'ready', color: brandGold }
}

const keep = <T,>(items: readonly T[], limit: number): readonly T[] =>
  items.length > limit ? items.slice(-limit) : items

function CommandPalette({
  commands,
  selectedIndex,
}: {
  commands: readonly CommandDefinition[]
  selectedIndex: number
}) {
  return (
    <box flexDirection="column" style={{ flexShrink: 0, width: '100%' }}>
      {commands.map((command, index) => {
        const selected = index === selectedIndex
        return (
          <box
            key={command.name}
            flexDirection="row"
            alignItems="flex-start"
            style={{
              width: '100%',
              paddingLeft: 1,
              paddingRight: 1,
              ...(selected ? { backgroundColor: selectedBg } : {}),
            }}
          >
            <text
              fg={selected ? '#ffffff' : ink}
              {...(selected ? { bg: selectedBg, attributes: 1 } : {})}
              style={{ width: NAME_COLUMN, flexShrink: 0 }}
            >
              {`/${command.name}`}
            </text>
            <text
              fg={selected ? selectedDescription : muted}
              {...(selected ? { bg: selectedBg } : {})}
              style={{ flexGrow: 1, flexShrink: 1 }}
            >
              {command.description}
            </text>
          </box>
        )
      })}
    </box>
  )
}

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
  const commandAbortRef = useRef<AbortController | undefined>(undefined)
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
      commandAbortRef.current?.abort()
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
    commandAbortRef.current?.abort()
    const abort = new AbortController()
    commandAbortRef.current = abort
    // After scrolling back, a new command's output would land out of view;
    // returning to the bottom also re-engages sticky scrolling.
    const scroll = scrollRef.current
    scroll?.scrollTo(scroll.scrollHeight)
    busyRef.current = true
    setBusy(true)
    setInput('')
    try {
      const result = await controller.execute(command, abort.signal, appendLines)
      if (result.kind === 'clear') {
        clearScreen()
      } else if (result.kind === 'watch') {
        startWatching()
      } else {
        // `/install` prints the URL while it polls; appending again would repeat it.
        if (!result.streamed) appendLines(result.lines)
        if (result.runs) {
          setRunChoices(result.lines.filter((entry) => entry.runId))
          setSelectedRun(0)
        }
      }
    } catch (commandError) {
      appendError(commandError instanceof Error ? commandError.message : 'Command failed.')
    } finally {
      if (commandAbortRef.current === abort) commandAbortRef.current = undefined
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
    setInput(`/${suggested.name} `)
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
      // Esc leaves `/install` instead of waiting until the webhook arrives.
      if (busyRef.current) commandAbortRef.current?.abort()
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

  const state = presence(busy, connection)
  const selectedLineId = runChoices[selectedRun]?.id
  const showBrand = lines.length === 0 && activity.length === 0
  const version = `v${process.env.npm_package_version ?? '0.1.0'}`
  const cwd = displayPath(process.cwd())
  const hint = busy
    ? 'esc stop · ctrl+c exit'
    : suggestions.length > 0
      ? '↑↓ select · tab complete · enter run'
      : runChoices.length > 0 && input === ''
        ? '↑↓ select · enter open'
        : '/ commands · ctrl+l clear · ctrl+c exit'
  const spinnerGlyph = spinner.frames[spinnerFrame] ?? '·'

  return (
    <box flexDirection="column" style={{ height: '100%', width: '100%' }}>
      {showBrand ? (
        <box
          flexDirection="row"
          alignItems="center"
          style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}
        >
          <box flexDirection="column">
            {X_LOGO.map((row, index) => (
              <text key={`${index}-${row}`} fg={brandGold}>
                {row}
              </text>
            ))}
          </box>
          <box flexDirection="column" style={{ paddingLeft: 2 }}>
            <box flexDirection="row">
              <text fg={ink} attributes={1}>
                Adamant
              </text>
              <text fg={muted}>{`  ${version}`}</text>
            </box>
            <text fg={muted}>Self Healing Code Agent</text>
            <text fg={dim}>{cwd}</text>
          </box>
        </box>
      ) : (
        <box flexDirection="row" style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text fg={ink} attributes={1}>
            Adamant
          </text>
          <text fg={muted}>{`  ${version}`}</text>
        </box>
      )}

      {/* Scrolls instead of overflowing: past a screenful, new output used to
          draw over the prompt and the newest lines were never visible. */}
      <scrollbox
        ref={scrollRef}
        stickyScroll
        stickyStart="bottom"
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          marginTop: 1,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        {lines.map((entry) => {
          const selected = entry.id === selectedLineId
          return (
            <text
              key={entry.id}
              fg={selected ? '#ffffff' : toneColor(entry.tone)}
              {...(selected ? { bg: selectedBg, attributes: 1 } : {})}
            >
              {entry.text}
            </text>
          )
        })}
        {activity.map((event, index) => (
          <text key={event.id} fg={index === activity.length - 1 ? ink : muted}>
            {formatActivity(event)}
          </text>
        ))}
      </scrollbox>

      {suggestions.length > 0 ? (
        <CommandPalette commands={suggestions} selectedIndex={suggestionIndex} />
      ) : null}

      <box
        flexDirection="row"
        alignItems="center"
        style={{
          flexShrink: 0,
          width: '100%',
          backgroundColor: promptBg,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text fg={ink} bg={promptBg}>
          {'> '}
        </text>
        <input
          focused
          placeholder="Type / for commands"
          placeholderColor={muted}
          textColor={ink}
          backgroundColor={promptBg}
          focusedBackgroundColor={promptBg}
          focusedTextColor={ink}
          value={input}
          onInput={setInput}
          onSubmit={() => void submit()}
          style={{ flexGrow: 1 }}
        />
      </box>
      <text style={{ flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
        {busy ? <span fg={accent}>{`${spinnerGlyph} `}</span> : null}
        <span fg={state.color}>{state.label}</span>
        <span fg={muted}>{` · ${cwd} · ${hint}`}</span>
      </text>
    </box>
  )
}
