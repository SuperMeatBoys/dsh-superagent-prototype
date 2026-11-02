/** GitLab source kind definition, project polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { GitlabIssueSchema, GitlabMrSchema, GitlabNoteSchema, SOURCE, gitlabThread, issueTrigger, mentions, mrTrigger, noteTrigger,
  type GitlabIssue, type GitlabNote, type GitlabRef } from './gitlab-trigger.ts'
import { agentMr, mrsOf, observeMr, readMr, type GitlabMergeRequest } from './gitlab-mr.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

const GitlabConfigSchema = GitlabAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeIssues: z.boolean().default(false), observeMergeRequests: z.boolean().default(false),
  observeComments: z.boolean().default(false) }).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>
const OBSERVED = { issues: 'observeIssues', merges: 'observeMergeRequests', comments: 'observeComments' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'merges'
  return meta.kind === 'note' ? 'comments' : undefined
}
const notesPath = (kind: 'issue' | 'mr', iid: number): [string, string[]] =>
  [`${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`,
    ['--method', 'GET', '--field', 'sort=asc', '--field', 'order_by=created_at', '--field', 'per_page=100']]
const threadRef = (thread: string): GitlabRef | undefined => {
  const match = /^gitlab:(issue|mr):(\d+)$/.exec(thread)
  return match ? { iid: Number(match[2]), kind: match[1] as 'issue' | 'mr' } : undefined
}

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  defaultEnabled: false,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；接收项目里发给它的 Issue、MR 和评论，并可推送分支、创建 MR。', en: 'The agent\'s GitLab account; receives Issues, merge requests and notes addressed to it, and can push branches and open merge requests.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', pattern: 'https?://[^\\s/]+', label: { zh: 'GitLab 地址', en: 'GitLab URL' },
      hint: { zh: '例如 https://gitlab.i.spirit-ai.com；gitlab.com 可留空。', en: 'For example https://gitlab.example.com; leave empty for gitlab.com.' } },
    { key: 'project', type: 'text', pattern: '([A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+', label: { zh: '监听的项目', en: 'Project' },
      hint: { zh: '写作 group/project。保存时检查智能体账号能否推送，然后重启 dsh-superagent。', en: 'Written group/project. Saving checks that the agent account may push, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GLAB_CONFIG_DIR 登录智能体账号的 glab 包装脚本。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account through GLAB_CONFIG_DIR.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收项目里的新 Issue', en: 'Receive new Issues in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。', en: 'New Issues that do not mention the agent are received too; the Policy admission table decides whether they become candidates.' } },
    { key: 'observeMergeRequests', type: 'switch', label: { zh: '接收项目里的新 MR', en: 'Receive new merge requests in the project' },
      hint: { zh: '打开后，没有 @ 智能体的新 MR 也会收到。', en: 'New merge requests that do not mention the agent are received too.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收 Issue/MR 评论', en: 'Receive Issue and MR notes' },
      hint: { zh: '打开后，没有 @ 智能体的评论也会收到。', en: 'Notes that do not mention the agent are received too.' } },
  ],
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const text = query.trim()
    const issue = /^#?(\d+)$/.exec(text)?.[1]
    const mr = /^!(\d+)$/.exec(text)?.[1]
    const url = /\/-\/(issues|merge_requests)\/(\d+)/.exec(text)
    const id = issue ?? mr ?? url?.[2]
    const kind = mr || url?.[1] === 'merge_requests' ? 'mr' : 'issue'
    return { threads: id ? [`${SOURCE}:${kind}:${id}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose notes may become candidates' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、MR 或评论里 @ 智能体。', en: 'An account on the list mentions the agent in an Issue, merge request or note.' },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('merges', { zh: '新 MR', en: 'New merge requests' }),
        row('comments', { zh: '评论', en: 'Notes' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_BASE_URL', description: { zh: 'GitLab 实例地址，例如 https://gitlab.example.com', en: 'The GitLab instance URL, such as https://gitlab.example.com' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的项目，group/project。智能体开的 MR，分支最后一段是 DSH_SUPERAGENT_NAME 时会关联到工单', en: 'The project this Source watches, group/project. An MR from a branch whose last segment is DSH_SUPERAGENT_NAME binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；glab 以它登录，所有 GitLab 操作都用 glab', en: 'The agent\'s GitLab account. glab is signed in to it; use glab for every GitLab operation' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the agent\'s account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '接下工单的 Issue 或 MR IID；工单不是从 GitLab 来的时为空', en: 'IID of the Issue or merge request that started the ticket; empty when the ticket did not start on GitLab' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR 的 head 引用 refs/merge-requests/<iid>/head；不是 MR 时为空', en: 'Head ref refs/merge-requests/<iid>/head of the MR that started the ticket; empty when it was not an MR' } },
    ],
    values: ({ deployment, trigger }) => {
      const gitlab = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      const isMr = trigger?.meta.isMr === true || trigger?.meta.kind === 'mr' || trigger?.meta.noteKind === 'mr'
      return { DSH_SUPERAGENT_GITLAB_BASE_URL: gitlab?.baseUrl ?? '', DSH_SUPERAGENT_GITLAB_PROJECT: gitlab?.project ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '', DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.email ?? '',
        DSH_SUPERAGENT_GITLAB_IID: iid ? String(iid) : '', DSH_SUPERAGENT_GITLAB_MR_HEAD: iid && isMr ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
  } : {},
}
export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured() || !ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}
interface Round { started: string; signal?: AbortSignal; mrs: Map<number, Promise<GitlabMergeRequest>>; read: Set<string>; failures: string[]; tally: Tally }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, mrs: new Map(), read: new Set(), failures: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 404
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown): void {
  round.failures.push(`${thread}: ${String(error)}`)
  ctx.threads.patch(thread, { pollError: String(error) })
}
async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  await pollProject(ctx, round)
  await pollTicketMrs(ctx, round)
  await pollThreads(ctx, round)
  if (signal?.aborted) return 60
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  ctx.report('gitlab', { state: 'ready', detail: `next poll ≥ ${ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60}s`, at: round.started })
  return 60
}
async function pollProject(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config || !ctx.deployment.gitlab) return
  const since = ctx.state.get(KV.gitlab.since) ?? round.started
  if (ctx.state.get(KV.gitlab.since) === undefined) ctx.state.set(KV.gitlab.since, since)
  const issueSince = await readIssues(ctx, round, config, since)
    .catch(error => { if (!stopped(ctx, round)) round.failures.push(`issues: ${String(error)}`); return since })
  const mrSince = await readMergeRequests(ctx, round, config, since)
    .catch(error => { if (!stopped(ctx, round)) round.failures.push(`merge requests: ${String(error)}`); return since })
  if (!stopped(ctx, round)) ctx.state.set(KV.gitlab.since, Date.parse(mrSince) > Date.parse(issueSince) ? mrSince : issueSince)
}
async function readIssues(ctx: SourceContext, round: Round, config: GitlabConfig, since: string): Promise<string> {
  const commands = ctx.commands.withSignal(round.signal)
  const issues = validItems(GitlabIssueSchema, await commands.gitlabApi(z.array(z.unknown()), 'issues', '--method', 'GET',
    '--field', 'state=opened', '--field', 'order_by=updated_at', '--field', 'sort=asc', '--field', `updated_after=${since}`, '--field', 'per_page=100'), round.tally)
  const { login } = ctx.deployment.gitlab!
  for (const issue of issues as GitlabIssue[]) {
    if (stopped(ctx, round)) return since
    if (sameName(issue.author.username, login)) continue
    const fresh = Date.parse(issue.updated_at) >= Date.parse(since)
    const mentioned = mentions(`${issue.title}\n\n${issue.description ?? ''}`, login)
    if (fresh && (mentioned || config.observeIssues)) await ctx.receive(issueTrigger(issue, login, ctx.deployment.gitlab!.baseUrl, ctx.deployment.gitlab!.project))
    await pollNotes(ctx, round, { iid: issue.iid, kind: 'issue', url: issue.web_url, author: issue.author.username }, since, config)
      .catch(error => { if (!stopped(ctx, round)) round.failures.push(`issue !${issue.iid} notes: ${String(error)}`) })
    nameThread(ctx, issue.iid, 'issue', issue.title)
  }
  return nextSince(issues.map(issue => issue.updated_at), since)
}
async function readMergeRequests(ctx: SourceContext, round: Round, config: GitlabConfig, since: string): Promise<string> {
  const commands = ctx.commands.withSignal(round.signal)
  const mrs = validItems(GitlabMrSchema, await commands.gitlabApi(z.array(z.unknown()), 'merge_requests', '--method', 'GET',
    '--field', 'state=all', '--field', 'order_by=updated_at', '--field', 'sort=asc', '--field', `updated_after=${since}`, '--field', 'per_page=100'), round.tally)
  const { login } = ctx.deployment.gitlab!
  for (const mr of mrs) {
    if (stopped(ctx, round)) return since
    const fresh = Date.parse(mr.updated_at) >= Date.parse(since)
    const mentioned = mentions(`${mr.title}\n\n${mr.description ?? ''}`, login)
    if (fresh && !sameName(mr.author.username, login) && (mentioned || config.observeMergeRequests)) {
      await ctx.receive(mrTrigger(mr, login, ctx.deployment.gitlab!.baseUrl, ctx.deployment.gitlab!.project))
    }
    const full = { ...mr, iid: mr.iid }
    await observeMr(ctx, full).catch(error => { if (!stopped(ctx, round)) round.failures.push(`MR !${mr.iid}: ${String(error)}`) })
    await pollNotes(ctx, round, { iid: mr.iid, kind: 'mr', url: mr.web_url, author: mr.author.username }, since, config)
      .catch(error => { if (!stopped(ctx, round)) round.failures.push(`MR !${mr.iid} notes: ${String(error)}`) })
    nameThread(ctx, mr.iid, 'mr', mr.title)
  }
  return nextSince(mrs.map(mr => mr.updated_at), since)
}
async function pollNotes(ctx: SourceContext, round: Round, ref: GitlabRef, since: string, config: GitlabConfig): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const [path, flags] = notesPath(ref.kind, ref.iid)
  const notes = validItems(GitlabNoteSchema, await commands.gitlabApi(z.array(z.unknown()), path, ...flags), round.tally)
  const { login } = ctx.deployment.gitlab!
  for (const note of notes as GitlabNote[]) {
    if (stopped(ctx, round)) return
    if (note.system || sameName(note.author.username, login)) continue
    if (Date.parse(note.updated_at ?? note.created_at) < Date.parse(since)) continue
    if (mentions(note.body ?? '', login) || config.observeComments) await ctx.receive(noteTrigger(note, ref, login, ctx.deployment.gitlab!.baseUrl, ctx.deployment.gitlab!.project))
  }
}
function nextSince(times: string[], since: string): string {
  const newest = Math.max(...times.map(Date.parse).filter(Number.isFinite))
  if (!Number.isFinite(newest)) return since
  const next = cursorAt(new Date(newest).toISOString())
  return Date.parse(next) > Date.parse(since) ? next : since
}
async function pollTicketMrs(ctx: SourceContext, round: Round): Promise<void> {
  for (const iid of [...new Set(ctx.tickets.open().flatMap(ticket => mrsOf(ticket, true)))]) {
    if (stopped(ctx, round)) return
    try { await observeMr(ctx, await mr(ctx, round, iid)) }
    catch (error) { if (!stopped(ctx, round)) failed(ctx, round, `${SOURCE}:mr:${iid}`, error) }
  }
}
function mr(ctx: SourceContext, round: Round, iid: number): Promise<GitlabMergeRequest> {
  let read = round.mrs.get(iid)
  if (!read) { read = readMr(ctx, iid, round.signal); round.mrs.set(iid, read) }
  return read
}
async function pollThreads(ctx: SourceContext, round: Round): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) return
      round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(thread.key) || !threadRef(thread.ref.id))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const ref = threadRef(thread.ref.id)
  if (!ref) return
  round.read.add(thread.key)
  const checkpoint = KV.gitlab.cursor(thread.key)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (ref.kind === 'mr') await observeMr(ctx, await mr(ctx, round, ref.iid))
  await pollNotes(ctx, round, ref, since, ctx.config<GitlabConfig>(SOURCE)!)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
function nameThread(ctx: SourceContext, iid: number, kind: 'issue' | 'mr', title: string): void {
  const thread = gitlabThread(iid, kind)
  ctx.threads.patch(thread, { title })
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, facts: { iid: { value: `${kind === 'mr' ? '!' : '#'}${iid}` } } })
}
