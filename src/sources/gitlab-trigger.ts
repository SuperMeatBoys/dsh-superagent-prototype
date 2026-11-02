/** Normalizes GitLab issues, merge requests and notes into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
/** GitLab issue and merge-request IIDs are separate sequences, so the thread key carries the kind. */
export const gitlabThread = (iid: number, kind: 'issue' | 'mr'): string => `gitlab:${kind}:${iid}`
export const gitlabChannel = (iid: number, kind: 'issue' | 'mr', baseUrl: string, project: string): ChannelRef =>
  ({ source: SOURCE, thread: gitlabThread(iid, kind), address: { iid: String(iid), kind, baseUrl, project } })
export const gitlabPage = (baseUrl: string, project: string, iid: number, kind: 'issue' | 'mr'): string =>
  `${baseUrl.replace(/\/+$/, '')}/${project}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`

/** A GitLab user; `bot` marks automation that can never authorize work on its own. */
export const GitlabUserSchema = z.looseObject({
  id: z.number(), username: z.string(), name: z.string().nullish(), email: z.string().nullish(), bot: z.boolean().optional(),
})
export type GitlabUser = z.infer<typeof GitlabUserSchema>
export const GitlabIssueSchema = z.looseObject({
  id: z.number(), iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  created_at: z.string(), updated_at: z.string(), web_url: z.string(), author: GitlabUserSchema,
})
export type GitlabIssue = z.infer<typeof GitlabIssueSchema>
export const GitlabMrSchema = GitlabIssueSchema.extend({
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullish(),
  source_project_id: z.number().nullish(), target_project_id: z.number().nullish(),
  merged_at: z.string().nullish(), closed_at: z.string().nullish(), merge_status: z.string().nullish(),
})
export type GitlabMr = z.infer<typeof GitlabMrSchema>
export const GitlabNoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: GitlabUserSchema,
  created_at: z.string(), updated_at: z.string().nullish(), system: z.boolean().optional(),
  noteable_iid: z.number().optional(), noteable_type: z.string().optional(), web_url: z.string().nullish(),
})
export type GitlabNote = z.infer<typeof GitlabNoteSchema>
export interface GitlabRef { iid: number; kind: 'issue' | 'mr'; url?: string; author?: string }
type Opened = Pick<GitlabIssue, 'iid' | 'title' | 'description' | 'author' | 'created_at' | 'web_url'>

/** True when a GitLab account is a regular person rather than a bot account. */
export const isHumanUser = (user: { username: string; bot?: boolean }): boolean => !user.bot && !/\[bot\]$/i.test(user.username)
export const mentions = (text: string, username: string): boolean =>
  new RegExp(`(?:^|[^a-zA-Z0-9_@.])@${escapeRegExp(username)}(?![a-zA-Z0-9_.-])`, 'i').test(text)
const author = (user: GitlabUser, agent: string) =>
  ({ actor: { source: SOURCE, id: user.username }, human: isHumanUser(user) && !sameName(user.username, agent) })
const address = (iid: number, kind: 'issue' | 'mr', baseUrl: string, project: string) => ({
  channel: gitlabChannel(iid, kind, baseUrl, project),
  threads: [{ source: SOURCE, id: `${kind}:${iid}` }],
})
/** Builds the trigger for a newly opened Issue's title and description. */
export function issueTrigger(issue: Opened, agent: string, baseUrl: string, project: string): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', project, String(issue.iid)), source: SOURCE, ...address(issue.iid, 'issue', baseUrl, project),
    ...author(issue.author, agent), at: issue.created_at, text: `${issue.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(issue.iid, 'issue', baseUrl, project), url: issue.web_url,
    meta: { iid: issue.iid, isMr: false, kind: 'issue', project, baseUrl } }
}
/** Builds the trigger for a newly opened merge request's title and description. */
export function mrTrigger(mr: Opened, agent: string, baseUrl: string, project: string): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', project, String(mr.iid)), source: SOURCE, ...address(mr.iid, 'mr', baseUrl, project),
    ...author(mr.author, agent), at: mr.created_at, text: `${mr.title}\n\n${body}`,
    ...(mentions(body, agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(mr.iid, 'mr', baseUrl, project), url: mr.web_url,
    meta: { iid: mr.iid, isMr: true, kind: 'mr', project, baseUrl } }
}
/** Builds the trigger for an Issue or merge-request note. */
export function noteTrigger(note: GitlabNote, ref: GitlabRef, agent: string, baseUrl: string, project: string): Trigger {
  const at = note.updated_at ?? note.created_at
  return { id: key('gitlab-note', project, ref.kind, String(ref.iid), String(note.id), at), source: SOURCE,
    ...address(ref.iid, ref.kind, baseUrl, project), ...author(note.author, agent), at, text: note.body ?? '',
    ...(mentions(note.body ?? '', agent) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel(ref.iid, ref.kind, baseUrl, project), ...(note.web_url ?? ref.url ? { url: note.web_url ?? ref.url } : {}),
    meta: { iid: ref.iid, isMr: ref.kind === 'mr', kind: 'note', noteKind: ref.kind, commentId: note.id, project, baseUrl } }
}
