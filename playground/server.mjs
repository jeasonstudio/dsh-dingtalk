#!/usr/bin/env node
/**
 * Local playground server: serves the DingTalk-shaped chat UI and the JSON API
 * that feeds it recorded frames from the real renderer.
 *
 * Zero dependencies on purpose — `pnpm run playground` must work offline.
 * The only prerequisite is a build (`lib/`), because the runner imports the
 * compiled renderer rather than reimplementing it.
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlaygroundInputError, activityLines, listScenarios, normalizeMarkdown, runScenario } from './runner.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const MAX_BODY_BYTES = 1_000_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new PlaygroundInputError('body_too_large', 'body', 'request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new PlaygroundInputError('invalid_body', 'body', 'body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof PlaygroundInputError) throw error
    throw new PlaygroundInputError('invalid_json', 'body', 'body must be valid JSON')
  }
}

/** Serve a file from `public/`, refusing anything that escapes the directory. */
async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
  const target = resolve(PUBLIC_DIR, normalize(relative))
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    json(res, 403, { error: 'forbidden' })
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    json(res, 404, { error: 'not_found', path: pathname })
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  // The runner executes arbitrary scenario scripts; a cross-site form post must
  // not be able to drive it, so only accept JSON bodies from the served origin.
  if (req.method === 'POST') {
    const type = String(req.headers['content-type'] ?? '')
    if (!type.includes('application/json')) {
      json(res, 415, { error: 'unsupported_media_type' })
      return
    }
  }

  if (pathname === '/api/scenarios' && (req.method === 'GET' || req.method === 'HEAD')) {
    json(res, 200, { scenarios: listScenarios() })
    return
  }

  if (pathname === '/api/activity-lines' && (req.method === 'GET' || req.method === 'HEAD')) {
    json(res, 200, activityLines())
    return
  }

  if (pathname === '/api/run' && req.method === 'POST') {
    const body = await readJson(req)
    const scenarioId = typeof body.scenarioId === 'string' ? body.scenarioId : ''
    if (!scenarioId) throw new PlaygroundInputError('invalid_option', 'scenarioId', 'scenarioId is required')
    const options = body.options && typeof body.options === 'object' ? body.options : {}
    // `runScenario` validates the id and every option value, including the
    // scenario's own defaults, so a bad request never produces a half-done turn.
    json(res, 200, await runScenario(scenarioId, options))
    return
  }

  if (pathname === '/api/normalize' && req.method === 'POST') {
    const body = await readJson(req)
    if (typeof body.text !== 'string') throw new PlaygroundInputError('invalid_option', 'text', 'text is required')
    json(res, 200, normalizeMarkdown(body.text, { normalize: body.normalize !== false }))
    return
  }

  if (pathname.startsWith('/api/')) {
    json(res, 404, { error: 'not_found', path: pathname })
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(res, 405, { error: 'method_not_allowed' })
    return
  }
  await serveStatic(req, res, pathname)
}

export function createPlaygroundServer() {
  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof PlaygroundInputError) {
        json(res, error.status, { error: error.code, field: error.field, message: error.message })
        return
      }
      console.error('[playground] request failed:', error)
      json(res, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) })
    })
  })
}

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT ?? 5188), open: true, host: '127.0.0.1' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++index])
    else if (arg === '--host') args.host = String(argv[++index])
    else if (arg === '--no-open') args.open = false
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65_535) {
    console.error(`[playground] invalid --port: ${args.port}`)
    process.exit(1)
  }
  return args
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, argv, { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Headless machines: the URL is printed anyway.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  try {
    await stat(join(HERE, '..', 'lib', 'renderer.js'))
  } catch {
    console.error(
      '[playground] lib/renderer.js is missing — run `pnpm run build` first (or use `pnpm run playground`).',
    )
    process.exit(1)
  }

  const server = createPlaygroundServer()
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[playground] port ${args.port} is busy — retry with --port ${args.port + 1}`)
      process.exit(1)
    }
    console.error('[playground]', error)
    process.exit(1)
  })
  server.listen(args.port, args.host, () => {
    const url = `http://${args.host}:${args.port}`
    console.log(`[playground] DingTalk chat simulator ready → ${url}`)
    console.log('[playground] frames come from lib/renderer.js; Ctrl+C to stop')
    if (args.open && process.env.CI === undefined) openBrowser(url)
  })

  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1_000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
