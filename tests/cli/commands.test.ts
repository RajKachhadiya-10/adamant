import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  argvToCommand,
  commandDefinitions,
  parseCommand,
  resolveSubmission,
  suggestionsFor,
} from '../../cli/src/commands.ts'
import {
  composerContext,
  composerHints,
  decideEnter,
  isEnter,
  moveIndex,
  PROMPT_PLACEHOLDER,
} from '../../cli/src/menu.ts'
import { reducedMotion } from '../../cli/src/motion.ts'

const definition = (name: string) => {
  const found = commandDefinitions.find((command) => command.name === name)
  assert.ok(found, name)
  return found
}

describe('Adamant CLI commands', () => {
  it('parses supported slash commands', () => {
    assert.deepEqual(parseCommand('/status'), { name: 'status' })
    assert.deepEqual(parseCommand('/run run_123'), { name: 'run', runId: 'run_123' })
    assert.deepEqual(parseCommand('/trigger repo_1 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), {
      name: 'trigger',
      repositoryId: 'repo_1',
      sourceSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })
    assert.deepEqual(parseCommand('/install acme/eval'), {
      name: 'install',
      owner: 'acme',
      repo: 'eval',
    })
    assert.deepEqual(parseCommand(argvToCommand(['install', 'acme/my.repo']) ?? ''), {
      name: 'install',
      owner: 'acme',
      repo: 'my.repo',
    })
  })

  it('rejects malformed and unsupported commands without a request', () => {
    assert.throws(() => parseCommand('status'), /Start commands with/)
    assert.throws(() => parseCommand('/run'), /\/run needs one run id/)
    assert.throws(() => parseCommand('/quit'), /Unknown command/)
    assert.throws(() => parseCommand('/trigger repo short'), /full 40- or 64-character/)
    assert.throws(() => parseCommand('/unknown'), /Unknown command/)
    assert.throws(() => parseCommand('/install'), /Usage: \/install/)
    assert.throws(() => parseCommand('/install acme/eval extra'), /Usage: \/install/)
    assert.throws(() => parseCommand('/install ../etc'), /no extra path/)
    assert.throws(() => parseCommand('/install acme/../../etc'), /no extra path/)
    assert.throws(() => parseCommand('/install acme/foo.git'), /no extra path/)
    assert.throws(() => parseCommand(`/install ${'a'.repeat(40)}/eval`), /no extra path/)
  })

  it('lists slash names without argument placeholders or a quit command', () => {
    assert.deepEqual(
      suggestionsFor('/').map((command) => `/${command.name}`),
      ['/help', '/status', '/install', '/runs', '/run', '/watch', '/trigger', '/clear'],
    )
    for (const command of commandDefinitions) {
      assert.equal(command.description.includes('<'), false)
    }
  })

  it('offers prefix suggestions and routes argv through the same command form', () => {
    assert.deepEqual(
      suggestionsFor('/ru').map((command) => command.name),
      ['runs', 'run'],
    )
    assert.equal(argvToCommand(['run', 'run_123']), '/run run_123')
    assert.equal(argvToCommand([]), undefined)
  })

  it('runs the highlighted suggestion on Enter instead of failing on a partial name', () => {
    assert.deepEqual(resolveSubmission('/st', definition('status')), { submit: '/status' })
    assert.deepEqual(resolveSubmission('/ru', definition('runs')), { submit: '/runs' })
  })

  it('completes a command that needs arguments rather than running it without them', () => {
    assert.deepEqual(resolveSubmission('/ru', definition('run')), { complete: '/run ' })
    assert.deepEqual(resolveSubmission('/install', definition('install')), {
      complete: '/install ',
    })
    // `/run` is typed in full, even though `/runs` is highlighted first.
    assert.deepEqual(resolveSubmission('/run', definition('runs')), { complete: '/run ' })
  })

  it('submits what was typed once it has arguments or matches nothing', () => {
    assert.deepEqual(resolveSubmission('/run abc', definition('runs')), { submit: '/run abc' })
    assert.deepEqual(resolveSubmission(' /status ', definition('status')), { submit: '/status' })
    assert.deepEqual(resolveSubmission('/zz', undefined), { submit: '/zz' })
    assert.deepEqual(resolveSubmission('status', undefined), { submit: 'status' })
  })

  it('parses login, repos, and a single owner/repo install', () => {
    assert.deepEqual(parseCommand('/login'), { name: 'login' })
    assert.deepEqual(parseCommand('/repos'), { name: 'repos' })
    assert.deepEqual(parseCommand('/install acme/eval'), {
      name: 'install',
      owner: 'acme',
      repo: 'eval',
    })
    assert.throws(() => parseCommand('/install'), /Usage: \/install/)
    assert.throws(() => parseCommand('/install acme/eval/extra'), /no extra path/)
    assert.throws(() => parseCommand('/install ../eval'), /GitHub names/)
    assert.throws(() => parseCommand('/login now'), /does not accept arguments/)
  })

  it('completes /install and runs /login from the highlighted row', () => {
    assert.deepEqual(resolveSubmission('/in', definition('install')), { complete: '/install ' })
    assert.deepEqual(resolveSubmission('/l', definition('login')), { submit: '/login' })
    assert.deepEqual(resolveSubmission('/install acme/eval', definition('runs')), {
      submit: '/install acme/eval',
    })
  })
})

describe('Enter and the home menu', () => {
  it('runs the highlighted command from the submitted text, not an empty prompt', () => {
    assert.deepEqual(
      decideEnter({
        input: '/st',
        highlighted: definition('status'),
        homeVisible: true,
        homeIndex: 0,
      }),
      { kind: 'submit', command: '/status' },
    )
    assert.deepEqual(
      decideEnter({
        input: '',
        highlighted: definition('status'),
        homeVisible: true,
        homeIndex: 1,
      }),
      { kind: 'home', id: 'repos' },
    )
  })

  it('fills the prompt when the highlighted command needs arguments', () => {
    assert.deepEqual(
      decideEnter({
        input: '/ru',
        highlighted: definition('run'),
        homeVisible: true,
        homeIndex: 0,
      }),
      { kind: 'complete', text: '/run ' },
    )
  })

  it('installs a picked repository and otherwise asks for owner/repo', () => {
    const choices = [
      { kind: 'repository' as const, owner: 'acme', name: 'eval' },
      { kind: 'type' as const },
    ]
    assert.deepEqual(
      decideEnter({
        input: '',
        highlighted: undefined,
        homeVisible: false,
        homeIndex: 0,
        connectChoices: choices,
        connectIndex: 0,
      }),
      { kind: 'install', owner: 'acme', name: 'eval' },
    )
    assert.deepEqual(
      decideEnter({
        input: '',
        highlighted: undefined,
        homeVisible: false,
        homeIndex: 0,
        connectChoices: choices,
        connectIndex: 1,
      }),
      { kind: 'type-install' },
    )
  })

  it('opens a selected run only when the menus are not up', () => {
    assert.deepEqual(
      decideEnter({
        input: '',
        highlighted: undefined,
        homeVisible: false,
        homeIndex: 0,
        runId: 'run_1',
      }),
      { kind: 'submit', command: '/run run_1' },
    )
  })

  it('wraps menu movement and treats return as Enter', () => {
    assert.equal(moveIndex(0, 3, -1), 2)
    assert.equal(moveIndex(2, 3, 1), 0)
    assert.equal(isEnter({ name: 'return', ctrl: false, meta: false, shift: false }), true)
    assert.equal(isEnter({ name: 'return', ctrl: true, meta: false, shift: false }), false)
  })
})

describe('composer copy', () => {
  it('names slash commands in the placeholder and keeps hints in two groups', () => {
    assert.match(PROMPT_PLACEHOLDER, /\//)
    assert.equal(composerHints('suggest'), '↑↓ select · enter run')
    assert.equal(composerHints('home'), '↑↓ select · enter choose')
    assert.equal(composerContext('ready', '0.1.0'), 'ready · v0.1.0')
    assert.doesNotMatch(composerContext('ready', '0.1.0'), /gpt|codex|claude/i)
  })

  it('stops motion for NO_COLOR and ADAMANT_REDUCED_MOTION', () => {
    assert.equal(reducedMotion({}), false)
    assert.equal(reducedMotion({ NO_COLOR: '1' }), true)
    assert.equal(reducedMotion({ ADAMANT_REDUCED_MOTION: '1' }), true)
  })
})
