/**
 * Tests for the DingTalk-flavoured markdown renderer used by the playground.
 * Run from the repo root with:  node --test test/markdown.test.mjs
 * (no build step: playground/public/markdown.js is plain browser ESM).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderMarkdown } from '../playground/public/markdown.js'

const NOOPENER = ' target="_blank" rel="noopener noreferrer"'

describe('headings', () => {
  it('renders every ATX level', () => {
    const html = renderMarkdown('# 一级\n\n###### 六级')
    assert.equal(html, '<h1>一级</h1>\n<h6>六级</h6>')
  })

  it('maps all six levels to h1..h6', () => {
    const source = ['# a', '## b', '### c', '#### d', '##### e', '###### f'].join('\n\n')
    const html = renderMarkdown(source)
    for (const [index, tag] of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].entries()) {
      assert.match(html, new RegExp(`<${tag}>${'abcdef'[index]}</${tag}>`))
    }
  })

  it('treats seven hashes as text, and strips a closing hash sequence', () => {
    assert.equal(renderMarkdown('####### seven'), '<p>####### seven</p>')
    assert.equal(renderMarkdown('## 标题 ##'), '<h2>标题</h2>')
  })

  it('renders inline markdown inside a heading', () => {
    assert.equal(renderMarkdown('# **粗** 与 `code`'), '<h1><strong>粗</strong> 与 <code>code</code></h1>')
  })
})

describe('inline emphasis, code and strike', () => {
  it('renders bold, italic, del and inline code in one paragraph', () => {
    const html = renderMarkdown('**粗** __粗2__ *斜* _斜2_ ~~删~~ `code`')
    assert.equal(
      html,
      '<p><strong>粗</strong> <strong>粗2</strong> <em>斜</em> <em>斜2</em> <del>删</del> <code>code</code></p>',
    )
  })

  it('does not treat intraword underscores as emphasis', () => {
    assert.equal(renderMarkdown('snake_case_name'), '<p>snake_case_name</p>')
  })

  it('keeps backslash-escaped markers literal', () => {
    assert.equal(renderMarkdown('\\*not em\\*'), '<p>*not em*</p>')
  })

  it('keeps markdown inside inline code literal', () => {
    assert.equal(renderMarkdown('`**not bold** | _not em_`'), '<p><code>**not bold** | _not em_</code></p>')
  })

  it('escapes html inside inline code', () => {
    assert.equal(renderMarkdown('`<img src=x onerror=1>`'), '<p><code>&lt;img src=x onerror=1&gt;</code></p>')
  })
})

describe('links', () => {
  it('always adds target and rel, and escapes the href', () => {
    assert.equal(
      renderMarkdown('[DingTalk](https://example.com/a?b=1&c=2)'),
      `<p><a href="https://example.com/a?b=1&amp;c=2"${NOOPENER}>DingTalk</a></p>`,
    )
  })

  it('keeps a destination that contains balanced parentheses', () => {
    assert.equal(
      renderMarkdown('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))'),
      `<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)"${NOOPENER}>wiki</a></p>`,
    )
  })

  it('supports mailto and relative targets', () => {
    assert.equal(renderMarkdown('[m](mailto:a@b.c)'), `<p><a href="mailto:a@b.c"${NOOPENER}>m</a></p>`)
    assert.equal(renderMarkdown('[r](/docs/x)'), `<p><a href="/docs/x"${NOOPENER}>r</a></p>`)
  })

  it('renders inline markdown inside the label', () => {
    assert.equal(
      renderMarkdown('[**粗** `c`](https://x.dev)'),
      `<p><a href="https://x.dev"${NOOPENER}><strong>粗</strong> <code>c</code></a></p>`,
    )
  })

  it('autolinks bare http/https urls and trims trailing punctuation', () => {
    assert.equal(
      renderMarkdown('看 https://example.com/x?a=1 。'),
      `<p>看 <a href="https://example.com/x?a=1"${NOOPENER}>https://example.com/x?a=1</a> 。</p>`,
    )
    assert.equal(
      renderMarkdown('see (http://a.b/c).'),
      `<p>see (<a href="http://a.b/c"${NOOPENER}>http://a.b/c</a>).</p>`,
    )
  })
})

describe('images', () => {
  it('renders src and alt', () => {
    assert.equal(
      renderMarkdown('![钉钉](https://example.com/i.png)'),
      '<p><img src="https://example.com/i.png" alt="钉钉"></p>',
    )
  })

  it('keeps relative image sources', () => {
    assert.equal(renderMarkdown('![a](/img/a.png)'), '<p><img src="/img/a.png" alt="a"></p>')
  })
})

describe('fenced code blocks', () => {
  it('keeps the language in a class without a highlighter', () => {
    assert.equal(renderMarkdown('```js\nconst a = 1\n```'), '<pre><code class="language-js">const a = 1</code></pre>')
  })

  it('does not parse markdown inside the fence', () => {
    const html = renderMarkdown('```md\n# 标题\n**粗**\n> 引用\n```')
    assert.equal(html, '<pre><code class="language-md"># 标题\n**粗**\n&gt; 引用</code></pre>')
    assert.ok(!html.includes('<h1>'))
    assert.ok(!html.includes('<strong>'))
  })

  it('escapes html inside the fence', () => {
    assert.equal(
      renderMarkdown('```html\n<div class="x">&</div>\n```'),
      '<pre><code class="language-html">&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;</code></pre>',
    )
  })

  it('omits the class when there is no info string, and drops an unsafe one', () => {
    assert.equal(renderMarkdown('```\nplain\n```'), '<pre><code>plain</code></pre>')
    assert.equal(renderMarkdown('```js<script>\nx\n```'), '<pre><code>x</code></pre>')
  })

  it('does not autolink inside the fence', () => {
    assert.equal(renderMarkdown('```\nhttps://example.com\n```'), '<pre><code>https://example.com</code></pre>')
  })
})

describe('blockquotes', () => {
  it('joins quoted lines with a line break and parses nested markdown', () => {
    assert.equal(
      renderMarkdown('> 第一行\n> **加粗**'),
      '<blockquote>\n<p>第一行<br><strong>加粗</strong></p>\n</blockquote>',
    )
  })

  it('keeps multiple paragraphs inside one quote', () => {
    assert.equal(renderMarkdown('> 第一段\n>\n> 第二段'), '<blockquote>\n<p>第一段</p>\n<p>第二段</p>\n</blockquote>')
  })

  it('nests lists and code inside a quote', () => {
    assert.equal(
      renderMarkdown('> - one\n> - two'),
      '<blockquote>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</blockquote>',
    )
    assert.equal(
      renderMarkdown('> ```js\n> x\n> ```'),
      '<blockquote>\n<pre><code class="language-js">x</code></pre>\n</blockquote>',
    )
  })

  it('renders the real activity line shape as a quote', () => {
    assert.equal(renderMarkdown('> 💭 正在思考…'), '<blockquote>\n<p>💭 正在思考…</p>\n</blockquote>')
  })

  it('appends a quoted activity line after the streamed text', () => {
    assert.equal(
      renderMarkdown('正文\n\n> ⚙️ 正在执行命令 · 运行测试'),
      '<p>正文</p>\n<blockquote>\n<p>⚙️ 正在执行命令 · 运行测试</p>\n</blockquote>',
    )
  })
})

describe('lists', () => {
  it('renders an unordered list with one nesting level', () => {
    assert.equal(
      renderMarkdown('- 一级\n  - 二级\n- 另一个'),
      '<ul>\n<li>一级\n<ul>\n<li>二级</li>\n</ul></li>\n<li>另一个</li>\n</ul>',
    )
  })

  it('renders ordered lists and keeps a non-1 start', () => {
    assert.equal(renderMarkdown('1. one\n2. two'), '<ol>\n<li>one</li>\n<li>two</li>\n</ol>')
    assert.equal(renderMarkdown('3. three\n4. four'), '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>')
  })

  it('nests an ordered list inside an unordered item', () => {
    assert.equal(renderMarkdown('- a\n  1. b\n  2. c'), '<ul>\n<li>a\n<ol>\n<li>b</li>\n<li>c</li>\n</ol></li>\n</ul>')
  })

  it('folds deeper indentation into text instead of inventing another level', () => {
    const html = renderMarkdown('- a\n  - b\n      - c')
    assert.equal(html, '<ul>\n<li>a\n<ul>\n<li>b</li>\n<li>    c</li>\n</ul></li>\n</ul>')
  })

  it('renders inline markdown and continuation lines inside an item', () => {
    assert.equal(
      renderMarkdown('- **粗** 与 `code`\n  继续'),
      '<ul>\n<li><strong>粗</strong> 与 <code>code</code><br>继续</li>\n</ul>',
    )
  })

  it('splits a list when the marker type changes', () => {
    assert.equal(renderMarkdown('- a\n1. b'), '<ul>\n<li>a</li>\n</ul>\n<ol>\n<li>b</li>\n</ol>')
  })
})

describe('thematic breaks', () => {
  it('renders ---, *** and ___ as hr', () => {
    assert.equal(renderMarkdown('---\n\n***\n\n___'), '<hr>\n<hr>\n<hr>')
  })

  it('does not mistake a bullet item for a break', () => {
    assert.equal(renderMarkdown('- - -'), '<hr>')
    assert.equal(renderMarkdown('- item'), '<ul>\n<li>item</li>\n</ul>')
  })
})

describe('GFM tables', () => {
  it('renders header cells with alignment from the delimiter row', () => {
    const html = renderMarkdown('| 名称 | 状态 | 备注 |\n| :--- | :---: | ---: |\n| a | b | c |')
    assert.equal(
      html,
      [
        '<table>',
        '<thead>',
        '<tr><th align="left">名称</th><th align="center">状态</th><th align="right">备注</th></tr>',
        '</thead>',
        '<tbody>',
        '<tr><td align="left">a</td><td align="center">b</td><td align="right">c</td></tr>',
        '</tbody>',
        '</table>',
      ].join('\n'),
    )
  })

  it('leaves alignment off when the delimiter has no colons', () => {
    assert.equal(
      renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'),
      [
        '<table>',
        '<thead>',
        '<tr><th>a</th><th>b</th></tr>',
        '</thead>',
        '<tbody>',
        '<tr><td>1</td><td>2</td></tr>',
        '</tbody>',
        '</table>',
      ].join('\n'),
    )
  })

  it('unescapes a pipe written as backslash-pipe', () => {
    const html = renderMarkdown('| 项 | 值 |\n|---|---|\n| a \\| b | `c` |')
    assert.ok(html.includes('<tr><td>a | b</td><td><code>c</code></td></tr>'), html)
  })

  it('renders inline markdown inside cells', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| **粗** | [链接](https://x.dev) |')
    assert.ok(html.includes('<td><strong>粗</strong></td>'), html)
    assert.ok(html.includes(`<td><a href="https://x.dev"${NOOPENER}>链接</a></td>`), html)
  })

  it('pads a short row and drops cells beyond the header width', () => {
    assert.ok(
      renderMarkdown('| a | b |\n|---|---|\n| 1 |').includes('<tr><td>1</td><td></td></tr>'),
      'short row is padded',
    )
    assert.ok(
      renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 | 3 |').includes('<tr><td>1</td><td>2</td></tr>'),
      'extra cells are dropped',
    )
  })

  it('treats adjacent rows of one table as a single table', () => {
    const html = renderMarkdown('| a |\n|---|\n| 1 |\n| 2 |\n| 3 |')
    assert.equal((html.match(/<table>/g) ?? []).length, 1)
    assert.equal((html.match(/<tr>/g) ?? []).length, 4)
  })

  it('renders a header-only table without a tbody', () => {
    assert.equal(
      renderMarkdown('| a | b |\n|---|---|'),
      '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n</table>',
    )
  })
})

describe('line breaks', () => {
  it('turns a single newline into <br> (DingTalk rule)', () => {
    assert.equal(renderMarkdown('line1\nline2'), '<p>line1<br>line2</p>')
  })

  it('falls back to CommonMark when lineBreakAsBr is false', () => {
    assert.equal(renderMarkdown('line1\nline2', { lineBreakAsBr: false }), '<p>line1\nline2</p>')
  })

  it('still honours a two-space hard break when lineBreakAsBr is false', () => {
    assert.equal(renderMarkdown('line1  \nline2', { lineBreakAsBr: false }), '<p>line1<br>line2</p>')
  })

  it('keeps the dingtalk default when options are omitted or empty', () => {
    assert.equal(renderMarkdown('a\nb', {}), '<p>a<br>b</p>')
    assert.equal(renderMarkdown('a\nb', undefined), '<p>a<br>b</p>')
  })

  it('separates blocks with blank lines only', () => {
    assert.equal(renderMarkdown('para1\n\npara2'), '<p>para1</p>\n<p>para2</p>')
  })
})

describe('unsafe protocols', () => {
  it('degrades a javascript: link to its label', () => {
    assert.equal(renderMarkdown('[点我](javascript:alert(1))'), '<p>点我</p>')
  })

  it('degrades javascript: regardless of case or embedded whitespace', () => {
    assert.equal(renderMarkdown('[x](JaVaScRiPt:alert(1))'), '<p>x</p>')
    assert.equal(renderMarkdown('[x](java\tscript:alert(1))'), '<p>x</p>')
  })

  it('degrades a data: image to its alt text', () => {
    assert.equal(renderMarkdown('![alt](data:image/png;base64,AAAA)'), '<p>alt</p>')
    assert.ok(!renderMarkdown('![alt](data:image/png;base64,AAAA)').includes('<img'))
  })

  it('degrades a vbscript: link and an unknown scheme', () => {
    assert.equal(renderMarkdown('[x](vbscript:msgbox)'), '<p>x</p>')
    assert.equal(renderMarkdown('[x](chrome://settings)'), '<p>x</p>')
  })

  it('never emits a javascript: anchor from a reachable path', () => {
    for (const source of [
      '[a](javascript:1)',
      '![a](javascript:1)',
      '[a](  javascript:1 )',
      '[a](&#106;avascript:1)',
    ]) {
      const html = renderMarkdown(source)
      assert.ok(!/href="\s*javascript:/i.test(html), source)
      assert.ok(!/src="\s*javascript:/i.test(html), source)
    }
  })
})

describe('raw html is escaped, never passed through', () => {
  it('escapes a script tag', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    assert.equal(html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    assert.ok(!html.includes('<script'))
  })

  it('escapes tags inside a paragraph with other markdown', () => {
    const html = renderMarkdown('**粗** <img src=x onerror="alert(1)">')
    assert.ok(!html.includes('<img'), html)
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), html)
  })

  it('escapes html that looks like a document structure', () => {
    const html = renderMarkdown('<div>\n**hi**\n</div>')
    assert.ok(!html.includes('<div>'), html)
    assert.ok(html.includes('&lt;div&gt;'), html)
    assert.ok(html.includes('<strong>hi</strong>'), html)
  })

  it('escapes the four characters everywhere it matters', () => {
    assert.equal(renderMarkdown('a & b < c > d "e"'), '<p>a &amp; b &lt; c &gt; d &quot;e&quot;</p>')
  })
})

describe('streaming half-written frames', () => {
  const partials = [
    ['unclosed fence', '```js\nconst a = 1\n**raw**'],
    ['lone fence', '```'],
    ['unclosed bold', '**bold'],
    ['unclosed strike', '~~gone'],
    ['unclosed inline code', 'a `b'],
    ['half link', 'see [a](ht'],
    ['half image', '![alt](ht'],
    ['half table divider', '| a | b | c |\n|---|---|'],
    ['table without divider', '| a | b |\n| c | d |'],
    ['unclosed quote', '> 正在思考'],
    ['dangling emphasis run', '***'],
    ['dangling table pipe', '| a |'],
  ]

  for (const [name, source] of partials) {
    it(`does not throw on ${name} and keeps the text`, () => {
      const html = renderMarkdown(source)
      assert.equal(typeof html, 'string')
      assert.ok(html.length > 0, 'nothing rendered')
    })
  }

  it('renders an unclosed fence as a code block up to the end', () => {
    assert.equal(
      renderMarkdown('```js\nconst a = 1\n**raw**'),
      '<pre><code class="language-js">const a = 1\n**raw**</code></pre>',
    )
  })

  it('keeps an unclosed emphasis run literal', () => {
    assert.equal(renderMarkdown('**bold'), '<p>**bold</p>')
    assert.equal(renderMarkdown('a **b *c'), '<p>a **b *c</p>')
  })

  it('keeps every row of a table that has no delimiter', () => {
    const html = renderMarkdown('| a | b |\n| c | d |')
    assert.equal(html, '<p>| a | b |<br>| c | d |</p>')
  })

  it('keeps a half delimiter row as text', () => {
    const html = renderMarkdown('| a | b | c |\n|---|---|')
    assert.ok(html.includes('| a | b | c |'), html)
    assert.ok(html.includes('|---|---|'), html)
    assert.ok(!html.includes('<table>'), html)
  })

  it('keeps a half-written link literal', () => {
    assert.equal(renderMarkdown('see [a](ht'), '<p>see [a](ht</p>')
    assert.equal(renderMarkdown('see [a]'), '<p>see [a]</p>')
  })

  it('does not drop the text of a frame truncated mid-token', () => {
    const full = [
      '## 标题',
      '',
      '**重点**',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'const a = 1',
      '```',
    ]
    const source = full.join('\n')
    // Every prefix of a real frame must render without throwing.
    for (let end = 0; end <= source.length; end += 1) {
      const html = renderMarkdown(source.slice(0, end))
      assert.equal(typeof html, 'string')
    }
    // A prefix cut inside the bold word still shows the characters written so far.
    for (const prefix of ['*', '**重', '**重点']) {
      assert.ok(renderMarkdown(prefix).includes(prefix.replace(/\*/g, '')), prefix)
    }
  })

  it('never swallows Chinese text, at any truncation point', () => {
    // Han characters are never markdown syntax, URLs or a fence info string, so
    // the rendered sequence must equal the source's for every prefix of a frame.
    const frames = [
      [
        '## 诊断结果',
        '',
        '| 检查项 | 结果 |',
        '| :--- | :---: |',
        '| **重要** | 完成 |',
        '| 权限 \\| 范围 | 警告 |',
        '',
        '> 输出继续',
        '',
        '- 第一步：构建',
        '  - 嵌套项',
        '',
        '```bash',
        'pnpm run ci',
        '```',
      ].join('\n'),
      ['> 💭 正在思考…', '', '> 继续说明 **重点**', '', '1. 第一项', '', '结束语'].join('\n'),
      ['[中文链接](https://example.com/a?b=1) 后面还有中文', '', '- **加粗中文** 与 `行内中文`'].join('\n'),
    ]
    const han = (text) => (text.match(/\p{Script=Han}+/gu) ?? []).join('')
    for (const source of frames) {
      for (let end = 0; end <= source.length; end += 1) {
        const prefix = source.slice(0, end)
        assert.equal(han(renderMarkdown(prefix)), han(prefix), `truncated at ${end}`)
      }
    }
  })
})

describe('degenerate input', () => {
  it('returns an empty string for empty, whitespace-only and missing input', () => {
    assert.equal(renderMarkdown(''), '')
    assert.equal(renderMarkdown('   \n\t\n  '), '')
    assert.equal(renderMarkdown(undefined), '')
    assert.equal(renderMarkdown(null), '')
  })

  it('renders one very long line without throwing', () => {
    const long = 'a'.repeat(20000)
    assert.equal(renderMarkdown(long), `<p>${long}</p>`)
  })

  it('renders punctuation-only input as text', () => {
    assert.equal(renderMarkdown('***///'), '<p>***///</p>')
    assert.equal(renderMarkdown('~~__**'), '<p>~~__**</p>')
  })

  it('normalizes CRLF input', () => {
    assert.equal(renderMarkdown('line1\r\nline2'), '<p>line1<br>line2</p>')
  })

  it('handles a huge frame of unclosed link openers in linear time', () => {
    const source = '[a]('.repeat(20000)
    const started = Date.now()
    const html = renderMarkdown(source)
    assert.equal(typeof html, 'string')
    assert.ok(Date.now() - started < 2000, 'renderer must stay roughly linear')
  })
})

describe('full card frame', () => {
  it('renders a realistic settled card', () => {
    const source = [
      '## 诊断结果',
      '',
      '整理成一张表：',
      '',
      '| 检查项 | 结果 |',
      '| :--- | :---: |',
      '| **Node** | ✅ |',
      '| 权限 \\| scope | ⚠️ |',
      '',
      '> ⤵️ 输出继续，见下方新卡片',
      '',
      '- 第一步：`pnpm run build`',
      '- 第二步：检查 **tarball**',
      '',
      '```bash',
      'pnpm run ci',
      '```',
    ].join('\n')
    const html = renderMarkdown(source)
    assert.ok(html.startsWith('<h2>诊断结果</h2>\n<p>整理成一张表：</p>\n<table>'), html)
    assert.ok(html.includes('<th align="left">检查项</th>'), html)
    assert.ok(html.includes('<td align="left">权限 | scope</td>'), html)
    assert.ok(html.includes('<blockquote>\n<p>⤵️ 输出继续，见下方新卡片</p>\n</blockquote>'), html)
    assert.ok(html.includes('<li>第一步：<code>pnpm run build</code></li>'), html)
    assert.ok(html.includes('<pre><code class="language-bash">pnpm run ci</code></pre>'), html)
    assert.ok(!html.includes('<script'), html)
  })
})
