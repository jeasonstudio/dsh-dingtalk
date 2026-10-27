import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_PROCESS_ITEMS,
  describeToolCall,
  formatDuration,
  renderActivityLine,
  renderProcessLine,
  renderProcessSettled,
  renderTodoLine,
  todoSnapshot,
} from '../lib/activity.js'

test('已知工具使用 DSH 的行文案，摘要优先取语义化参数', () => {
  const bash = describeToolCall(
    'bash',
    JSON.stringify({ command: 'npm test -- --runInBand', description: '在工作区运行测试' }),
    'c1',
  )
  assert.equal(bash.variant, 'bash')
  assert.equal(bash.summary, '在工作区运行测试')
  assert.equal(renderActivityLine(bash), '> ⚙️ 正在执行命令 · 在工作区运行测试')

  const read = describeToolCall('read', JSON.stringify({ file_path: 'src/renderer.ts' }))
  assert.equal(renderActivityLine(read), '> ⚙️ 正在读取文件 · src/renderer.ts')

  const write = describeToolCall('write', JSON.stringify({ file_path: 'src/a.ts', content: 'x' }))
  assert.equal(renderActivityLine(write), '> ⚙️ 正在写入文件 · src/a.ts')

  const search = describeToolCall('web_search', JSON.stringify({ queries: ['钉钉 AI 卡片', 'DeepSeek Harness'] }))
  assert.equal(renderActivityLine(search), '> ⚙️ 正在搜索 · 钉钉 AI 卡片, DeepSeek Harness')
})

test('完成、失败、停止沿用同一行文案', () => {
  const activity = describeToolCall('read', JSON.stringify({ file_path: 'src/a.ts' }))
  activity.state = 'done'
  assert.equal(renderActivityLine(activity), '> ✅ 已读取文件 · src/a.ts')
  activity.state = 'error'
  assert.equal(renderActivityLine(activity), '> ❌ 读取文件失败 · src/a.ts')
  activity.state = 'stopped'
  assert.equal(renderActivityLine(activity), '> ⏹️ 读取文件已停止 · src/a.ts')
})

test('未知工具只显示工具名，不透出任何参数', () => {
  const activity = describeToolCall('mcp__custom', JSON.stringify({ query: 'hello' }))
  assert.equal(activity.variant, 'other')
  assert.equal(renderActivityLine(activity), '> ⚙️ 正在调用工具 · mcp__custom')

  const noArgs = describeToolCall('mcp__custom', undefined)
  assert.equal(renderActivityLine(noArgs), '> ⚙️ 正在调用工具 · mcp__custom')
})

test('只取约定参数，绝不把任意字符串参数写进卡片', () => {
  const read = describeToolCall('read', JSON.stringify({ token: 'sk-secret-value' }))
  assert.equal(read.summary, undefined)
  assert.equal(renderActivityLine(read), '> ⚙️ 正在读取文件')

  const mcp = describeToolCall('mcp__custom', JSON.stringify({ secret: 'sk-secret-value' }))
  assert.doesNotMatch(renderActivityLine(mcp), /sk-secret/)
})

test('思考状态只有一行', () => {
  assert.equal(renderActivityLine({ kind: 'thinking' }), '> 💭 正在分析请求')
})

test('过程线是一段普通文字：一个图标 + 当前步骤 + 已完成面包屑 + 用时', () => {
  const step = (index, state = 'done') => {
    const activity = describeToolCall('read', JSON.stringify({ file_path: `src/${index}.ts` }), `c${index}`)
    activity.state = state
    return activity
  }

  const running = renderProcessLine({
    steps: [step(1), step(2), { ...step(3), state: 'running' }],
    thinkingMs: 0,
    thinking: false,
    elapsedMs: 23_000,
  })
  assert.equal(running, '⚙️ 正在读取文件 src/3.ts · 已完成 2 步：读取文件 src/1.ts · 读取文件 src/2.ts · 用时 23 秒')
  // One paragraph, one line, no blockquote: DingTalk would add a full paragraph
  // gap per block and merges quote soft breaks.
  assert.doesNotMatch(running, /\n/)
  assert.doesNotMatch(running, /^> /)
  assert.equal((running.match(/⚙️|✅|💭/g) ?? []).length, 1, 'at most one icon on the live line')

  const thinking = renderProcessLine({ steps: [], thinkingMs: 0, thinking: true, elapsedMs: 3_000 })
  assert.equal(thinking, '💭 正在分析请求 · 用时 3 秒')

  const between = renderProcessLine({ steps: [step(1)], thinkingMs: 12_000, thinking: false, elapsedMs: 30_000 })
  assert.equal(between, '⚙️ 已完成 1 步：读取文件 src/1.ts · 用时 30 秒')

  // 思考时长只在没有步骤可显示时独立成段，其余情况让位给步骤与用时。
  const thoughtOnly = renderProcessLine({ steps: [], thinkingMs: 12_000, thinking: false, elapsedMs: 12_000 })
  assert.equal(thoughtOnly, '💭 已思考 12 秒 · 用时 12 秒')

  assert.equal(renderProcessLine({ steps: [], thinkingMs: 0, thinking: false, elapsedMs: 0 }), '')
})

test('面包屑只留最近 2 步，更早的用「等」收口，失败与中断单独标出', () => {
  const step = (index) => {
    const activity = describeToolCall(
      'bash',
      JSON.stringify({ command: `cmd-${index}`, description: `第 ${index} 步` }),
      `c${index}`,
    )
    activity.state = 'done'
    return activity
  }
  const many = Array.from({ length: MAX_PROCESS_ITEMS + 2 }, (_, index) => step(index))
  const line = renderProcessLine({ steps: many, thinkingMs: 0, thinking: false, elapsedMs: 0 })
  assert.equal(line, '⚙️ 已完成 4 步：执行命令 第 2 步 · 执行命令 第 3 步 等')

  const failure = describeToolCall('read', JSON.stringify({ file_path: 'src/a.ts' }), 'c9')
  failure.state = 'error'
  const stopped = describeToolCall('bash', JSON.stringify({ command: 'sleep 10' }), 'c10')
  stopped.state = 'stopped'
  assert.equal(
    renderProcessLine({ steps: [failure, stopped], thinkingMs: 0, thinking: false, elapsedMs: 0 }),
    '⚙️ 已完成 2 步：读取文件失败 src/a.ts · 执行命令中断 sleep 10',
  )
})

test('任务行只展示进行中的那一项，分数是已完成/总数', () => {
  const todos = [
    { content: '读一遍渲染器', status: 'completed' },
    { content: '把过程线压成一行', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
    { content: '更新文档', status: 'pending' },
    { content: '重新加载插件', status: 'pending' },
  ]

  assert.deepEqual(todoSnapshot(todos), { active: '把过程线压成一行', done: 1, total: 5, alsoActive: 0 })
  assert.equal(renderTodoLine(todoSnapshot(todos)), '📋 任务进行中：把过程线压成一行（1/5）')

  // 单段、一个图标：和过程线一样不能为任务清单多花一个块。
  const line = renderTodoLine(todoSnapshot(todos))
  assert.doesNotMatch(line, /\n/)
  assert.doesNotMatch(line, /^> /)

  // 没有进行中的项（刚开始 / 全部做完）就不占位。
  assert.equal(todoSnapshot([{ content: 'a', status: 'pending' }]), undefined)
  assert.equal(todoSnapshot(todos.map((item) => ({ ...item, status: 'completed' }))), undefined)
  assert.equal(renderTodoLine(undefined), '')
  assert.equal(todoSnapshot(null), undefined)
  assert.equal(todoSnapshot([]), undefined)

  // 并行任务：多出来的进行中项不另起一行。
  const parallel = [
    { content: '读一遍渲染器', status: 'in_progress' },
    { content: '补测试', status: 'in_progress' },
    { content: '更新文档', status: 'pending' },
  ]
  assert.equal(renderTodoLine(todoSnapshot(parallel)), '📋 任务进行中：读一遍渲染器 等 2 项（0/3）')

  // 超长任务名截断，卡片不会被撑成两行。
  const long = {
    content: '把过程线压成一行并且兼容钉钉的换行规则，再补上任务行的截断和测试覆盖',
    status: 'in_progress',
  }
  const longLine = renderTodoLine(todoSnapshot([long]))
  assert.match(longLine, /^📋 任务进行中：.*…（0\/1）$/)
  assert.ok(longLine.length < 24 + 28 + 8, 'the todo line stays short even with a long task name')
})

test('定稿摘要按 dsH 措辞收起，没有可折叠内容时留空', () => {
  const step = () => {
    const activity = describeToolCall('bash', JSON.stringify({ command: 'ls', description: '列目录' }), 'c1')
    activity.state = 'done'
    return activity
  }

  assert.equal(
    renderProcessSettled({ steps: [step(), step()], thinkingMs: 0, thinking: false, elapsedMs: 42_000 }, 'completed'),
    '✅ 已完成 · 2 次工具调用 · 用时 42 秒',
  )
  assert.equal(
    renderProcessSettled({ steps: [], thinkingMs: 0, thinking: false, elapsedMs: 5_000 }, 'completed'),
    '✅ 已完成 · 用时 5 秒',
  )
  assert.equal(
    renderProcessSettled({ steps: [], thinkingMs: 12_000, thinking: false, elapsedMs: 30_000 }, 'completed'),
    '✅ 已完成 · 已思考 12 秒 · 用时 30 秒',
  )
  assert.equal(
    renderProcessSettled({ steps: [], thinkingMs: 0, thinking: false, elapsedMs: 400 }, 'completed'),
    '',
    '快回合没有可折叠的信息，不该出现一行空摘要',
  )
  assert.equal(
    renderProcessSettled({ steps: [step()], thinkingMs: 0, thinking: false, elapsedMs: 0 }, 'failed'),
    '❌ 处理失败 · 1 次工具调用',
  )
  assert.equal(
    renderProcessSettled({ steps: [step()], thinkingMs: 0, thinking: false, elapsedMs: 0 }, 'stopped'),
    '⏹️ 任务已打断 · 1 次工具调用',
  )
  assert.equal(renderProcessSettled({ steps: [], thinkingMs: 0, thinking: false, elapsedMs: 0 }, 'failed'), '')
})

test('时长文案：秒、分秒，不足一秒不显示', () => {
  assert.equal(formatDuration(0), '')
  assert.equal(formatDuration(999), '')
  assert.equal(formatDuration(1_000), '1 秒')
  assert.equal(formatDuration(59_400), '59 秒')
  assert.equal(formatDuration(60_000), '1 分 00 秒')
  assert.equal(formatDuration(125_000), '2 分 05 秒')
})

test('摘要折叠为单行并截断超长文本', () => {
  const activity = describeToolCall(
    'bash',
    JSON.stringify({ command: `echo ${'x'.repeat(200)}`, description: '第一行\n第二行\n第三行' }),
  )
  assert.equal(activity.summary, '第一行 第二行 第三行')

  const long = describeToolCall('bash', JSON.stringify({ command: 'x'.repeat(200) }))
  assert.equal([...(long.summary ?? '')].length, 80)
  assert.match(long.summary, /…$/)
})

test('参数不是合法 JSON 时不回显原始文本', () => {
  const activity = describeToolCall('bash', 'not-json sk-secret')
  assert.equal(activity.summary, undefined)
  assert.doesNotMatch(renderActivityLine(activity), /not-json|sk-secret/)
})
