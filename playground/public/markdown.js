/**
 * DingTalk-flavoured Markdown -> HTML. Playground only: zero dependencies, no
 * DOM APIs, importable from the browser and from Node (`node --test`).
 *
 * Why this file exists
 * --------------------
 * The playground replays the exact `content` strings the connector sends to
 * DingTalk (AI Card frames, `sessionWebhook` markdown messages) and paints them
 * as chat bubbles. DingTalk does not render CommonMark: it renders a subset
 * through its own pipeline and then serves HTML. This renderer mirrors that
 * pipeline so the local preview is a faithful stand-in — a `marked` render
 * would look *better* and therefore lie.
 *
 * DingTalk rules encoded here (keep this list in sync with the code)
 * -----------------------------------------------------------------
 * 1. A single newline inside a paragraph is a line break (`<br>`); CommonMark
 *    would fold it into a space, DingTalk keeps it. `lineBreakAsBr: false`
 *    restores CommonMark behaviour — the lab toggle needs both sides to compare.
 * 2. Blocks must be separated by blank lines. A run of adjacent `|` rows is ONE
 *    table; anything else is separate blocks.
 * 3. No task lists, no footnotes, no inline HTML, no math: those characters are
 *    rendered as plain text (all text is escaped, raw tags never pass through).
 * 4. A literal `|` inside a table cell is written `\|`.
 * 5. Fenced code blocks are verbatim: no markdown parsing, no autolinking, HTML
 *    escaped. The info string becomes `class="language-<lang>"`; no highlighter.
 * 6. Links always carry `target="_blank" rel="noopener noreferrer"`. Anything
 *    outside http/https/mailto degrades to plain text (never `javascript:`).
 * 7. Image `src` is scheme-checked the same way (http/https/relative only), and
 *    a rejected image degrades to its alt text.
 *
 * Streaming frames are truncated mid-token, so every parser below follows one
 * rule: "close what you can, keep the rest literal". An unclosed fence runs to
 * EOF, an unclosed `**` stays literal, half a table degrades to a paragraph,
 * half a link stays text. Any input (empty, whitespace, one huge line, pure
 * punctuation) returns a string and never throws.
 *
 * Shape: two layers. `parseBlocks` walks lines into block tokens; inline
 * rendering happens only on text that a block decided to render. `<br>`
 * insertion lives in the inline layer, so code blocks are untouched by it.
 *
 * Known gaps (deliberate, see the report for the DingTalk-side unknowns)
 * ---------------------------------------------------------------------
 * - No setext headings: `===`/`---` under a paragraph stay text (or an `<hr>`).
 * - No 4-space indented code blocks: they render as a paragraph.
 * - One list nesting level; deeper indentation is folded into the item text.
 * - Link labels cannot contain brackets; destinations cannot span lines; link
 *   titles are dropped.
 * - Nested emphasis like `**a *b***` degrades to `<strong>a *b</strong>*`: still
 *   valid HTML with no lost words, but not `<strong>a <em>b</em></strong>`.
 *
 * @param {string} src raw markdown
 * @param {{ lineBreakAsBr?: boolean }} [options] lineBreakAsBr defaults to true
 * @returns {string} HTML fragment
 */
export function renderMarkdown(src, options) {
  const lineBreakAsBr = options?.lineBreakAsBr !== false
  const env = { inline: (text) => renderInlineText(text, lineBreakAsBr) }
  const raw = typeof src === 'string' ? src : src === null || src === undefined ? '' : String(src)
  // Cards are normalized to \n upstream; tolerate anything that slipped through.
  const normalized = raw.replace(/\r\n?/g, '\n')
  try {
    return parseBlocks(expandLeadingTabs(normalized).split('\n'), env).join('\n')
  } catch {
    // A malformed frame must never take the player down: show it escaped instead.
    return `<p>${escapeHtml(normalized)}</p>`
  }
}

/** Schemes a clickable link may use; everything else is plain text. */
const LINK_SCHEMES = new Set(['http', 'https', 'mailto'])
/** Schemes an image may load from. */
const IMAGE_SCHEMES = new Set(['http', 'https'])

// Placeholder markers for already-rendered fragments. NUL cannot survive the
// escape pass and is stripped from input, so a marker is never user-controlled.
const RE_MARKER = /\u0000(\d+)\u0000/g
const RE_BLANK = /^\s*$/
const RE_SCHEME = /^([a-z][a-z0-9+.-]*):/
const RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const RE_THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const RE_QUOTE = /^ {0,3}>[ \t]?(.*)$/
const RE_LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/
const RE_DELIM_CELL = /^:?-+:?$/
const RE_LANG = /^[A-Za-z0-9_#+.-]+$/
// Emphasis content may not contain `<`/`>`: everything user-authored is already
// escaped, so the only angle brackets left belong to tags we just emitted and a
// match must never span one of them (that is what keeps nesting well-formed).
// The last character class forbids ending on whitespace, which is what stops an
// unclosed run from eating the delimiter that a later pass would need.
const RE_STRONG_EM = /\*\*\*(?=\S)([^<>]*?[^\s<>])\*\*\*/g
const RE_STRONG_STAR = /\*\*(?=\S)([^<>]*?[^\s<>])\*\*/g
const RE_STRONG_UNDER = /__(?=\S)([^<>]*?[^\s<>])__/g
const RE_STRIKE = /~~(?=\S)([^<>]*?[^\s<>])~~/g
const RE_EM_STAR = /\*(?=\S)([^*<>]*?[^\s*<>])\*/g
const RE_EM_UNDER = /(?<![\w])_(?=\S)([^_<>]*?[^\s_<>])_(?![\w])/g
/** Characters that end an autolinked URL (markers included). */
const RE_URL_STOP = /[\s<>\u0000]/
/** Characters allowed directly before an autolinked URL. */
const RE_URL_LEAD = /[\s([{<|]/
/** Trailing punctuation that autolink refuses to swallow. */
const URL_TAIL = '.,;:!?\'"'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Escape the four characters DingTalk escapes; `'` is left alone. */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function isBlank(line) {
  return line === undefined || RE_BLANK.test(line)
}

function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].length
}

/** Leading tabs are 4 columns wide; only indentation width matters to us. */
function expandLeadingTabs(src) {
  return src.replace(/^[ \t]+/gm, (prefix) => prefix.replace(/\t/g, '    '))
}

/**
 * Scheme check for link/image destinations.
 * Control characters are stripped before the probe so `java\tscript:` cannot
 * slip through, while the emitted URL is the author's original text.
 * @returns {string|null} the URL to emit, or null when it must degrade to text
 */
function safeUrl(raw, allowed) {
  const url = raw.trim()
  // A placeholder inside a destination would be unwrapped into the attribute
  // later; refuse instead of emitting broken (or worse, injectable) markup.
  if (url.includes('\u0000')) return null
  const probe = url.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()
  const scheme = RE_SCHEME.exec(probe)
  // No scheme at all: relative path or #anchor, nothing can execute.
  if (scheme === null) return url
  return allowed.has(scheme[1]) ? url : null
}

/** Register a rendered fragment and return its placeholder. */
function mark(ctx, html) {
  ctx.tokens.push(html)
  return `\u0000${ctx.tokens.length - 1}\u0000`
}

/**
 * Unwrap placeholders until none are left: a link token contains the markers of
 * its own label (inline code, emphasis), so one pass is not enough. Any marker
 * that survives (pathological nesting) is dropped rather than leaked as NUL.
 */
function resolveMarkers(html, ctx) {
  let out = html
  for (let pass = 0; pass < 8 && out.indexOf('\u0000') !== -1; pass += 1) {
    out = out.replace(RE_MARKER, (_match, id) => ctx.tokens[Number(id)] ?? '')
  }
  return out.replace(/\u0000/g, '')
}

function anchorHtml(url, labelHtml) {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`
}

// ---------------------------------------------------------------------------
// Inline layer
// ---------------------------------------------------------------------------

function renderInlineText(src, lineBreakAsBr) {
  const ctx = { tokens: [], lineBreakAsBr }
  // NUL is stripped here only: nested label rendering must keep the markers it
  // receives from the code-span pass.
  const text = String(src).replace(/\u0000/g, '')
  return resolveMarkers(inlineToMarked(text, ctx), ctx)
}

/**
 * Render inline markdown to a string that still contains placeholders.
 * Order matters: code spans are literal (so they are extracted before anything
 * else can eat their contents), then backslash escapes, then links/images (their
 * labels recurse through this same function), then escaping, then emphasis, then
 * line breaks — emphasis before breaks so a `**` may span a newline, breaks last
 * so nothing we emit can be broken apart.
 */
function inlineToMarked(text, ctx, allowLinks = true) {
  let out = markCodeSpans(text, ctx)
  out = markBackslashEscapes(out, ctx)
  if (allowLinks) {
    // One scanner for both: an image must be recognized before the `[` of a link.
    out = markLinksAndImages(out, ctx)
    out = markAutolinks(out, ctx)
  }
  out = escapeHtml(out)
  out = applyEmphasis(out)
  return applyLineBreaks(out, ctx.lineBreakAsBr)
}

/** Index just past the closing run of exactly `length` backticks, or -1. */
function findCodeClose(text, from, length) {
  let i = from
  while (i < text.length) {
    if (text[i] !== '`') {
      i += 1
      continue
    }
    let j = i
    while (text[j] === '`') j += 1
    if (j - i === length) return i
    i = j
  }
  return -1
}

/** Inline code is verbatim; an unclosed run stays literal (streaming frames). */
function markCodeSpans(text, ctx) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i]
      i += 1
      continue
    }
    let j = i
    while (text[j] === '`') j += 1
    const run = text.slice(i, j)
    const close = findCodeClose(text, j, run.length)
    if (close === -1) {
      out += run
      i = j
      continue
    }
    // Newlines inside a code span become spaces, as in CommonMark.
    let code = text.slice(j, close).replace(/\n/g, ' ')
    if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1)
    out += mark(ctx, `<code>${escapeHtml(code)}</code>`)
    i = close + run.length
  }
  return out
}

/** Any escaped ASCII punctuation becomes a literal character. */
function markBackslashEscapes(text, ctx) {
  return text.replace(/\\([!-/:-@[-`{-~])/g, (_match, ch) => mark(ctx, escapeHtml(ch)))
}

/**
 * Links and images are scanned by hand (not by one regex) because a destination
 * may contain balanced parentheses — `[a](https://x/(b))` must stay a link, and
 * `[a](javascript:alert(1))` must be *recognized* first so it can degrade to its
 * label instead of leaking a clickable scheme.
 */
function markLinksAndImages(text, ctx) {
  let out = ''
  let i = 0
  // A destination scan that ran to EOF without a `)` proves every later scan
  // would fail too. Remember it, otherwise a frame full of `[a](` stays O(n^2).
  let unclosedFrom = Number.POSITIVE_INFINITY
  while (i < text.length) {
    const image = text[i] === '!' && text[i + 1] === '['
    // Strictly later than the failed scan: anything at or past it fails too.
    if ((image || text[i] === '[') && i < unclosedFrom) {
      const parsed = readInlineLink(text, image ? i + 1 : i)
      if (parsed !== null && parsed.url !== null) {
        const labelHtml = inlineToMarked(parsed.label, ctx, false)
        if (image) {
          const safe = safeUrl(parsed.url, IMAGE_SCHEMES)
          // A rejected image keeps its alt text: a card must never lose words.
          if (safe === null) out += mark(ctx, labelHtml)
          else out += mark(ctx, `<img src="${escapeHtml(safe)}" alt="${escapeHtml(flatAlt(parsed.label))}">`)
        } else {
          const safe = safeUrl(parsed.url, LINK_SCHEMES)
          out += mark(ctx, safe === null ? labelHtml : anchorHtml(safe, labelHtml))
        }
        i = parsed.next
        continue
      }
      if (parsed !== null) unclosedFrom = parsed.unclosedFrom ?? unclosedFrom
    }
    out += text[i]
    i += 1
  }
  return out
}

/** Alt text is an attribute: placeholders are flattened, never unwrapped. */
function flatAlt(label) {
  return label.replace(RE_MARKER, '').trim()
}

/**
 * Parse `[label](dest "title")` starting at the `[`.
 * @returns {{ label: string, url: string, next: number }|null} null = not a link
 *   (including every truncated form: `[a`, `[a]`, `[a](ht`).
 */
function readInlineLink(text, open) {
  let i = open + 1
  while (i < text.length && text[i] !== ']') {
    // Labels cannot nest brackets and cannot span lines; that keeps the scan
    // linear on a huge single-line frame.
    if (text[i] === '[' || text[i] === '\n') return null
    i += 1
  }
  if (i >= text.length) return null
  const label = text.slice(open + 1, i)
  let j = i + 1
  if (text[j] !== '(') return null
  j += 1
  const destStart = j
  let depth = 1
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\n') break
    if (ch === '\\' && j + 1 < text.length) {
      j += 2
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) break
    }
    j += 1
  }
  if (depth !== 0) return { label, url: null, next: open, unclosedFrom: destStart }
  // Titles are not a DingTalk feature; strip one if present, keep the URL.
  const dest = text
    .slice(destStart, j)
    .replace(/[ \t]+(?:"[^"]*"|'[^']*')$/, '')
    .trim()
  return { label, url: dest, next: j + 1 }
}

/** Bare http/https URLs match DingTalk's autolinker; trailing punctuation stays. */
function markAutolinks(text, ctx) {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (isUrlAt(text, i)) {
      let j = i
      while (j < text.length && !RE_URL_STOP.test(text[j])) j += 1
      const url = trimUrlTail(text.slice(i, j))
      if (url.length > 8) {
        out += mark(ctx, anchorHtml(url, escapeHtml(url)))
        i += url.length
        continue
      }
    }
    out += text[i]
    i += 1
  }
  return out
}

function isUrlAt(text, i) {
  if (i > 0 && !RE_URL_LEAD.test(text[i - 1])) return false
  const head = text.slice(i, i + 8).toLowerCase()
  return head.startsWith('http://') || head.startsWith('https://')
}

function trimUrlTail(url) {
  let out = url
  for (;;) {
    const last = out[out.length - 1]
    if (last === undefined) break
    if (URL_TAIL.includes(last)) {
      out = out.slice(0, -1)
      continue
    }
    // A closing paren that the URL itself opened is part of the URL.
    if (last === ')' && countChar(out, '(') < countChar(out, ')')) {
      out = out.slice(0, -1)
      continue
    }
    break
  }
  return out
}

function countChar(text, ch) {
  let count = 0
  for (let i = 0; i < text.length; i += 1) if (text[i] === ch) count += 1
  return count
}

/** Emphasis passes run on already-escaped text, so only our own tags remain. */
function applyEmphasis(text) {
  return text
    .replace(RE_STRONG_EM, (_match, inner) => `<em><strong>${inner}</strong></em>`)
    .replace(RE_STRONG_STAR, (_match, inner) => `<strong>${inner}</strong>`)
    .replace(RE_STRONG_UNDER, (_match, inner) => `<strong>${inner}</strong>`)
    .replace(RE_STRIKE, (_match, inner) => `<del>${inner}</del>`)
    .replace(RE_EM_STAR, (_match, inner) => `<em>${inner}</em>`)
    .replace(RE_EM_UNDER, (_match, inner) => `<em>${inner}</em>`)
}

/**
 * The DingTalk line-break rule. Two trailing spaces (or a trailing backslash) are
 * always a hard break; every other newline is one too unless the caller asked for
 * CommonMark behaviour.
 */
function applyLineBreaks(text, lineBreakAsBr) {
  let out = text.replace(/\\\n/g, '<br>').replace(/ {2,}\n/g, '<br>')
  if (lineBreakAsBr) out = out.replace(/\n/g, '<br>')
  return out
}

// ---------------------------------------------------------------------------
// Block layer
// ---------------------------------------------------------------------------

function parseBlocks(lines, env) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i += 1
      continue
    }
    const fence = matchFence(line)
    if (fence !== null) {
      const [html, next] = parseFence(lines, i, fence)
      blocks.push(html)
      i = next
      continue
    }
    const heading = matchHeading(line)
    if (heading !== null) {
      blocks.push(`<h${heading.level}>${env.inline(heading.text)}</h${heading.level}>`)
      i += 1
      continue
    }
    // Thematic break before list: `- - -` would otherwise parse as an item.
    if (RE_THEMATIC.test(line)) {
      blocks.push('<hr>')
      i += 1
      continue
    }
    if (RE_QUOTE.test(line)) {
      const [html, next] = parseQuote(lines, i, env)
      blocks.push(html)
      i = next
      continue
    }
    if (matchListItem(line) !== null) {
      const [html, next] = parseList(lines, i, env)
      blocks.push(html)
      i = next
      continue
    }
    if (isTableStart(lines, i)) {
      const [html, next] = parseTable(lines, i, env)
      blocks.push(html)
      i = next
      continue
    }
    const [html, next] = parseParagraph(lines, i, env)
    blocks.push(html)
    i = next
  }
  return blocks
}

/** Does this line open a block that must interrupt a running paragraph? */
function isBlockStart(lines, i) {
  const line = lines[i]
  if (isBlank(line)) return true
  if (matchFence(line) !== null) return true
  if (matchHeading(line) !== null) return true
  if (RE_THEMATIC.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  if (matchListItem(line) !== null) return true
  return isTableStart(lines, i)
}

/** Block openers that may end a table body / a lazy list continuation. */
function startsNonListBlock(lines, i) {
  const line = lines[i]
  if (matchFence(line) !== null) return true
  if (matchHeading(line) !== null) return true
  if (RE_THEMATIC.test(line)) return true
  if (RE_QUOTE.test(line)) return true
  return isTableStart(lines, i)
}

function matchFence(line) {
  const match = RE_FENCE.exec(line)
  if (match === null) return null
  const info = match[2].trim()
  // A backtick fence's info string may not contain a backtick (CommonMark).
  if (match[1][0] === '`' && info.includes('`')) return null
  return { char: match[1][0], length: match[1].length, info }
}

function parseFence(lines, start, fence) {
  const content = []
  let i = start + 1
  while (i < lines.length && !isFenceClose(lines[i], fence)) {
    content.push(lines[i])
    i += 1
  }
  // An unclosed fence (truncated frame) renders to the end: nothing is lost.
  const next = i < lines.length ? i + 1 : i
  const lang = fence.info.split(/\s+/)[0] ?? ''
  const langClass = RE_LANG.test(lang) ? ` class="language-${escapeHtml(lang)}"` : ''
  return [`<pre><code${langClass}>${escapeHtml(content.join('\n'))}</code></pre>`, next]
}

function isFenceClose(line, fence) {
  const match = RE_FENCE_CLOSE.exec(line)
  if (match === null) return false
  return match[1][0] === fence.char && match[1].length >= fence.length
}

function matchHeading(line) {
  const match = RE_HEADING.exec(line)
  if (match === null) return null
  // Drop an optional closing sequence (`## title ##`) that follows whitespace.
  const text = (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
  return { level: match[1].length, text }
}

function parseParagraph(lines, start, env) {
  const parts = [lines[start]]
  let i = start + 1
  while (i < lines.length && !isBlockStart(lines, i)) {
    parts.push(lines[i])
    i += 1
  }
  return [`<p>${env.inline(parts.join('\n').trim())}</p>`, i]
}

function parseQuote(lines, start, env) {
  const inner = []
  let i = start
  while (i < lines.length) {
    const match = RE_QUOTE.exec(lines[i])
    if (match !== null) {
      inner.push(match[1])
      i += 1
      continue
    }
    if (isBlank(lines[i])) {
      // Blank lines stay inside the quote only while quoted lines follow.
      let j = i
      while (j < lines.length && isBlank(lines[j])) j += 1
      if (j < lines.length && RE_QUOTE.test(lines[j])) {
        while (i < j) {
          inner.push('')
          i += 1
        }
        continue
      }
    }
    // No lazy continuation: every quoted line carries its own `>` (predictable
    // for streaming frames, which are quote-line by quote-line).
    break
  }
  return [`<blockquote>\n${parseBlocks(inner, env).join('\n')}\n</blockquote>`, i]
}

function matchListItem(line) {
  // A thematic break wins over `* * *` / `- - -` being read as an item.
  if (RE_THEMATIC.test(line)) return null
  const match = RE_LIST_ITEM.exec(line)
  if (match === null) return null
  const marker = match[2]
  const ordered = /\d/.test(marker[0])
  return {
    indent: match[1].length,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    markerWidth: marker.length,
    text: (match[3] ?? '').trim(),
  }
}

/** Split a table row on unescaped `|`, skipping pipes inside code spans. */
function splitRow(line) {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)
  const cells = []
  let buffer = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\' && i + 1 < text.length) {
      buffer += ch + text[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      let j = i
      while (text[j] === '`') j += 1
      const run = text.slice(i, j)
      const close = text.indexOf(run, j)
      const end = close === -1 ? j : close + run.length
      buffer += text.slice(i, end)
      i = end
      continue
    }
    if (ch === '|') {
      cells.push(buffer.trim())
      buffer = ''
      i += 1
      continue
    }
    buffer += ch
    i += 1
  }
  cells.push(buffer.trim())
  return cells
}

function hasUnescapedPipe(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1
      continue
    }
    if (line[i] === '|') return true
  }
  return false
}

function parseAlign(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return ''
}

/**
 * GFM table = header row + delimiter row with the SAME cell count. A truncated
 * frame that has only one of them is not a table: it stays a paragraph, so no
 * row is silently dropped.
 */
function isTableStart(lines, i) {
  const header = lines[i]
  const delimiter = lines[i + 1]
  if (delimiter === undefined || isBlank(header) || !hasUnescapedPipe(header)) return false
  if (!hasUnescapedPipe(delimiter)) return false
  const headerCells = splitRow(header)
  const delimiterCells = splitRow(delimiter)
  if (headerCells.length !== delimiterCells.length) return false
  return delimiterCells.every((cell) => RE_DELIM_CELL.test(cell))
}

function parseTable(lines, start, env) {
  const headerCells = splitRow(lines[start])
  const aligns = splitRow(lines[start + 1]).map(parseAlign)
  const rows = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line) || !hasUnescapedPipe(line)) break
    if (startsNonListBlock(lines, i)) break
    rows.push(splitRow(line))
    i += 1
  }
  const cell = (tag, align, text) => `<${tag}${align ? ` align="${align}"` : ''}>${env.inline(text)}</${tag}>`
  const normalize = (cells) => headerCells.map((_, index) => cells[index] ?? '')
  const head = headerCells.map((text, index) => cell('th', aligns[index], text))
  const html = ['<table>', '<thead>', `<tr>${head.join('')}</tr>`, '</thead>']
  if (rows.length > 0) {
    html.push('<tbody>')
    for (const row of rows) {
      html.push(
        `<tr>${normalize(row)
          .map((text, index) => cell('td', aligns[index], text))
          .join('')}</tr>`,
      )
    }
    html.push('</tbody>')
  }
  html.push('</table>')
  return [html.join('\n'), i]
}

/**
 * Lists: one nesting level is modeled, deeper indentation is folded back into the
 * item text (the extra spaces are kept so nothing is invented or lost).
 */
function parseList(lines, start, env) {
  const block = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (matchListItem(line) !== null) {
      block.push(line)
      i += 1
      continue
    }
    if (isBlank(line)) {
      let j = i
      while (j < lines.length && isBlank(lines[j])) j += 1
      if (j >= lines.length) break
      const next = lines[j]
      // A blank line only continues the list when more list content follows.
      if (matchListItem(next) !== null || indentOf(next) > 0) {
        while (i < j) {
          block.push('')
          i += 1
        }
        continue
      }
      break
    }
    if (indentOf(line) > 0) {
      block.push(line)
      i += 1
      continue
    }
    if (startsNonListBlock(lines, i)) break
    // Lazy continuation: an unindented line right under an item belongs to it.
    block.push(line)
    i += 1
  }
  return [renderList(collectListItems(block), env), i]
}

function collectListItems(block) {
  const first = block.find((line) => matchListItem(line) !== null)
  const baseIndent = first === undefined ? 0 : matchListItem(first).indent
  const entries = []
  let current = null
  // Surplus indentation is measured against the parent's content column, so a
  // quote-relative list (`> 1. a` / `>    - b`) does not gain a stray space.
  let parentContentIndent = null
  for (const line of block) {
    const item = matchListItem(line)
    if (item !== null) {
      const relative = item.indent - baseIndent
      const level = relative >= 2 ? 1 : 0
      const reference = level === 1 ? (parentContentIndent ?? item.indent) : item.indent
      current = {
        level,
        ordered: item.ordered,
        start: item.start,
        // Anything deeper than the one supported level keeps its surplus indent.
        extra: Math.max(0, item.indent - reference),
        contentIndent: item.indent + item.markerWidth + 1,
        parts: [item.text],
      }
      if (level === 0) parentContentIndent = current.contentIndent
      entries.push(current)
      continue
    }
    if (current === null) continue
    if (isBlank(line)) {
      current.parts.push('')
      continue
    }
    const strip = Math.min(indentOf(line), current.contentIndent)
    current.parts.push(line.slice(strip).replace(/\s+$/, ''))
  }
  return entries
}

function itemText(entry) {
  const body = entry.parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
  return entry.extra > 0 ? `${' '.repeat(entry.extra)}${body}` : body
}

function renderList(entries, env) {
  const roots = []
  let root = null
  let parent = null
  for (const entry of entries) {
    if (entry.level === 0 || parent === null) {
      // A switch between `-` and `1.` starts a new list at the same depth.
      if (root === null || root.ordered !== entry.ordered) {
        root = { ordered: entry.ordered, start: entry.start, items: [] }
        roots.push(root)
        parent = null
      }
      parent = { text: itemText(entry), children: [] }
      root.items.push(parent)
      continue
    }
    const siblings = parent.children
    const last = siblings[siblings.length - 1]
    if (last !== undefined && last.ordered === entry.ordered) last.items.push({ text: itemText(entry), children: [] })
    else {
      siblings.push({
        ordered: entry.ordered,
        start: entry.start,
        items: [{ text: itemText(entry), children: [] }],
      })
    }
  }
  return roots.map((node) => renderListNode(node, env)).join('\n')
}

function renderListNode(node, env) {
  const tag = node.ordered ? 'ol' : 'ul'
  const startAttr = node.ordered && node.start !== 1 ? ` start="${node.start}"` : ''
  const items = node.items.map((item) => {
    const nested = item.children.map((child) => renderListNode(child, env))
    const tail = nested.length > 0 ? `\n${nested.join('\n')}` : ''
    return `<li>${env.inline(item.text)}${tail}</li>`
  })
  return `<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>`
}
