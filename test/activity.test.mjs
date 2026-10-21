import assert from 'node:assert/strict'
import test from 'node:test'

import { describeToolCall, renderActivityLine } from '../lib/activity.js'

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
  assert.equal(renderActivityLine({ kind: 'thinking' }), '> 💭 正在思考…')
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
