#!/usr/bin/env node
/**
 * Regenerate `public/fixtures/demo-run.json`, the offline fallback the page uses
 * when the playground server is not reachable. Re-run it after changing the
 * renderer or the `tool-run` scenario so the fallback stays truthful.
 */
import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runScenario } from './runner.mjs'

const scenarioId = process.argv[2] ?? 'tool-run'
const target = fileURLToPath(new URL('./public/fixtures/demo-run.json', import.meta.url))

const result = await runScenario(scenarioId, { pace: 1 })
await writeFile(target, `${JSON.stringify(result, null, 2)}\n`)
// The repo lints every file with prettier, so keep the fixture formatted rather
// than making `pnpm run ci` fail on generated output.
if (spawnSync('pnpm', ['exec', 'prettier', '--write', target], { stdio: 'ignore' }).status !== 0) {
  console.warn('[playground] prettier is unavailable; run `pnpm exec prettier --write` on the fixture.')
}
console.log(
  `[playground] fixture written for ${scenarioId}: ${result.timeline.length} entries, ${result.stats.cards} card(s), ${result.durationMs}ms`,
)
