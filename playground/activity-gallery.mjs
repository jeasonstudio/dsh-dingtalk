/**
 * Representative tool calls behind `/api/activity-lines`.
 *
 * The playground shows what each DSH tool family looks like on the card, so the
 * samples must be shaped like the real arguments (the summary is derived from
 * documented keys only, never from arbitrary args).
 */
export const ACTIVITY_GALLERY = [
  {
    variant: 'bash',
    name: 'bash',
    args: { command: 'pnpm run ci', description: '运行完整门禁' },
    sample: '运行完整门禁',
  },
  { variant: 'read', name: 'read', args: { file_path: 'src/aicard.ts' }, sample: 'src/aicard.ts' },
  {
    variant: 'write',
    name: 'write',
    args: { file_path: 'playground/public/style.css' },
    sample: 'playground/public/style.css',
  },
  { variant: 'edit', name: 'edit', args: { file_path: 'src/renderer.ts' }, sample: 'src/renderer.ts' },
  { variant: 'search', name: 'grep', args: { pattern: 'rollover' }, sample: 'rollover' },
  {
    variant: 'search',
    name: 'web_search',
    args: { queries: ['钉钉 AI 卡片 markdown 表格', 'dingtalk card streaming'] },
    sample: '两个搜索词',
  },
  {
    variant: 'fetch',
    name: 'web_fetch',
    args: { url: 'https://api.dingtalk.com/v1.0/card/streaming' },
    sample: 'https://api.dingtalk.com/v1.0/card/streaming',
  },
  { variant: 'code', name: 'run_code', args: { description: '统计每帧字符数分布' }, sample: '统计每帧字符数分布' },
  { variant: 'todo', name: 'todo_write', args: {}, sample: '（无摘要）' },
  { variant: 'ask', name: 'ask_user_question', args: { header: '渲染方式' }, sample: '渲染方式' },
  { variant: 'skill', name: 'skill', args: { name: 'frontend-design' }, sample: 'frontend-design' },
  { variant: 'present', name: 'present', args: { path: 'README.zh-CN.md' }, sample: 'README.zh-CN.md' },
  { variant: 'other', name: 'mcp__internal__query', args: {}, sample: 'mcp__internal__query' },
]
