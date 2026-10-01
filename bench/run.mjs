#!/usr/bin/env node
// deltic benchmark: compiles a synthetic project of N files through the real
// compiler pipeline and micro-benchmarks the SQLite state store.
//
// Usage: pnpm bench [--files 20000]
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { Compiler } from '../dist/index.js'
import { SqliteState } from '../dist/store/sqlite-state.js'

const args = process.argv.slice(2)
const filesArg = args.indexOf('--files')
const N = filesArg >= 0 ? Number(args[filesArg + 1]) : 20000

const ms = (duration) =>
  duration >= 1000 ? `${(duration / 1000).toFixed(2)}s` : `${Math.round(duration)}ms`

const results = []

function record(scenario, duration, note = '') {
  results.push({ scenario, duration: ms(duration), note })
  console.log(`  ${scenario.padEnd(40)} ${ms(duration).padStart(10)}  ${note}`)
}

function silence() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

// ---------------------------------------------------------------- project gen

console.log(`generating ${N} synthetic files...`)
const root = await mkdtemp(path.join(tmpdir(), 'deltic-bench-'))
const srcDir = path.join(root, 'src', 'js')

await mkdir(srcDir, { recursive: true })

const fileName = (i) => `mod-${i}.js`

const writes = []
const BATCH = 512

for (let i = 0; i < N; i++) {
  // forward-only imports keep upstream traces small and the DAG acyclic
  const imports = []
    .concat(i + 1 < N ? [`./${fileName(i + 1)}`] : [])
    .concat(i + 2 < N ? [`./${fileName(i + 2)}`] : [])

  const content = `${imports
    .map((request, index) => `import { v${index} } from '${request}'`)
    .join('\n')}\nexport const self = ${i}\n`

  writes.push(writeFile(path.join(srcDir, fileName(i)), content))

  if (writes.length >= BATCH) {
    await Promise.all(writes)
    writes.length = 0
  }
}

await Promise.all(writes)

// ------------------------------------------------------- end-to-end scenarios

const config = {
  baseDir: root,
  logger: silence(),
  progress: false,
  tasks: {
    js: { test: '**/*.js', use: ['js'], compileAncestor: true },
  },
}

console.log(`\nend-to-end (${N} files):`)

const coldCompiler = new Compiler(config)
const coldStart = performance.now()
const coldSession = await coldCompiler.run()
record('cold full build', performance.now() - coldStart, `${coldSession.total} files`)
await coldCompiler.stop()

const warmCompiler = new Compiler(config)
const warmStart = performance.now()
const warmSession = await warmCompiler.run()
record(
  'warm build (all cache hits)',
  performance.now() - warmStart,
  `${warmSession.totalHit}/${warmSession.total} skipped`,
)
await warmCompiler.stop()

const incCompiler = new Compiler(config)
await incCompiler.ready

// mod-0 has no importers: upstream trace is empty, exactly one file rebuilds
const headFile = path.join(srcDir, fileName(0))
await writeFile(headFile, `export const self = 'head-changed'\n`)

const incStart = performance.now()
await incCompiler.incrementCompile([headFile])
record('incremental change (no upstream)', performance.now() - incStart, '1 file')

// mod-N/2 has ~N/2 transitive importers via compileAncestor tracing
const midIndex = Math.floor(N / 2)
const midFile = path.join(srcDir, fileName(midIndex))
await writeFile(midFile, `export const self = 'mid-changed'\n`)

const midStart = performance.now()
await incCompiler.incrementCompile([midFile])
record(
  'incremental change (mid chain)',
  performance.now() - midStart,
  `~${midIndex} upstream files`,
)
await incCompiler.stop()

// ---------------------------------------------------------- store micro-bench

console.log(`\nstate store micro-bench (${N} entries):`)

const storeFile = path.join(root, '.deltic', 'bench.db')
const store = new SqliteState({ file: storeFile })

const compiledEntries = []
const checksumEntries = []
const graphNodes = []
const fileList = []

for (let i = 0; i < N; i++) {
  const id = `\\js\\mod-${i}.js`

  compiledEntries.push([id, 1e12 + i])
  checksumEntries.push([id, 'a'.repeat(40)])
  fileList.push(`${root}/src/js/${fileName(i)}`)
  graphNodes.push({
    path: id,
    dependencies: [id.replace(/mod-(\d+)/, (_m, d) => `mod-${Number(d) + 1}`)],
    requiredBy: [],
  })
}

let queueStart = performance.now()
store.compiled.upsert(compiledEntries)
store.checksums.upsert('npmDeps', checksumEntries)
store.files.add(fileList)
store.graph.upsert(graphNodes)
record('queue writes (in-memory)', performance.now() - queueStart, `${N * 4} mutations`)

const flushStart = performance.now()
store.flush()
record('store flush (single transaction)', performance.now() - flushStart, `${N * 4} rows`)

const reopenStart = performance.now()
const reopened = new SqliteState({ file: storeFile })
const loadCompiled = reopened.compiled.all()
const loadGraph = reopened.graph.all()
record(
  'startup load (compiled + graph)',
  performance.now() - reopenStart,
  `${Object.keys(loadCompiled).length + Object.keys(loadGraph).length} rows`,
)
reopened.close()
store.close()

// legacy single-JSON blob comparison
const legacyBlob = {
  compiled: Object.fromEntries(compiledEntries),
  checksums: { npmDeps: Object.fromEntries(checksumEntries) },
  files: fileList,
  depGraph: Object.fromEntries(graphNodes.map((node) => [node.path, node])),
}

const stringifyStart = performance.now()
const serialized = JSON.stringify(legacyBlob)
record(
  'legacy JSON.stringify (full blob)',
  performance.now() - stringifyStart,
  `${(serialized.length / 1024 / 1024).toFixed(1)} MB`,
)

const legacyFile = path.join(root, '.deltic', 'legacy.json')
const legacyWriteStart = performance.now()
writeFileSync(legacyFile, serialized)
record('legacy writeFileSync (full blob)', performance.now() - legacyWriteStart)

const legacyReadStart = performance.now()
JSON.parse(readFileSync(legacyFile, 'utf8'))
record('legacy readFileSync + JSON.parse', performance.now() - legacyReadStart)

// -------------------------------------------------------------------- summary

console.log('\nsummary:')
for (const row of results) {
  console.log(`  ${row.scenario.padEnd(40)} ${row.duration.padStart(10)}  ${row.note}`)
}

await rm(root, { recursive: true, force: true, retryDelay: 200, maxRetries: 5 })
console.log('\ntemp project removed')
