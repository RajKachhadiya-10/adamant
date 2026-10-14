#!/usr/bin/env -S node --experimental-ffi --disable-warning=ExperimentalWarning
// Registers tsx from here instead of `--import tsx` because Node resolves --import and tsx finds
// tsconfig.json from the caller's cwd, which breaks `adamant` outside this package.
import { join } from 'node:path'
import { register } from 'tsx/esm/api'

register({ tsconfig: join(import.meta.dirname, '../tsconfig.json') })
await import('../src/index.tsx')
