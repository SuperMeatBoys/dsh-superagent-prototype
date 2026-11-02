/** GitLab merge-request binding and lifecycle observation. */
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { SOURCE, gitlabPage, GitlabMrSchema } from './gitlab-trigger.ts'

export type GitlabMergeRequest = ReturnType<typeof GitlabMrSchema.parse> & { iid: number }
export const readMr = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<GitlabMergeRequest> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(GitlabMrSchema, `merge_requests/${iid}`), iid })
const mrNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:mr:`) ? Number(thread.slice(`${SOURCE}:mr:`.length)) : undefined
export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => mrNumber(item.thread) ?? [])
export const mrOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)
/** True when the merge request was opened by the agent account from the configured project. */
export const agentMr = (mr: { author: { username: string }; source_project_id?: number | null },
  deployment: Pick<Deployment, 'gitlab'>): boolean =>
  !!deployment.gitlab && sameName(mr.author.username, deployment.gitlab.login)
  && (mr.source_project_id == null || mr.source_project_id === deployment.gitlab.projectId)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name

/**
 * Validates and binds an open merge request to a ticket when the MR is the ticket's origin MR or one the agent opened
 * from the ticket branch. Returns an error message when binding is rejected.
 */
export function claimMr(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE && (source.meta.kind === 'mr' || source.meta.noteKind === 'mr') && Number(source.meta.iid) === mr.iid
  const opened = agentMr(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'the agent account'
    return `MR does not belong to this ticket: use the source MR or one by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:mr:${mr.iid}`)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}
/** Reconciles a polled MR's state with any bound or branch-matching ticket; returns whether the MR has ended. */
export async function observeMr(ctx: SourceContext, mr: GitlabMergeRequest): Promise<boolean> {
  const ended = mr.state === 'merged' || mr.state === 'closed'
  if (ended) closeMr(ctx, mr)
  else {
    const candidates = agentMr(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:mr:${mr.iid}` && item.closed)
    if (ticket && (reopened || mrsOf(ticket, true).every(number => number === mr.iid))) claimMr(ctx, ticket.id, mr)
  }
  return ended
}
function bind(ctx: SourceContext, ticketId: string, mr: GitlabMergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(`${SOURCE}:mr:${mr.iid}`, { iid: mr.iid, isPr: true, url: mr.web_url, author: mr.author.username })
  })
}
function closeMr(ctx: SourceContext, mr: GitlabMergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? new Date().toISOString()
  ctx.tickets.threadClosed({ source: SOURCE, id: `mr:${mr.iid}` }, mr.state === 'merged' ? 'merged' : 'closed', at)
}
/** Builds idempotent outbound notices for IM conversations when a ticket ends with its merge request. */
export function mrEndNotices(ticket: Ticket, request: string, deployment: Pick<Deployment, 'gitlab'>): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrNumber(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow || !deployment.gitlab) return []
  const iid = mrNumber(follow.thread)!
  const url = gitlabPage(deployment.gitlab.baseUrl, deployment.gitlab.project, iid, 'mr')
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
