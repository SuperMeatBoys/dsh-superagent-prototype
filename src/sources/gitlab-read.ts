/** Read-only GitLab issue, merge-request and note inspection for assessments and workers. */
import { z } from 'zod'
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/index.ts'
import { validItems } from '../infra/commands.ts'
import { GitlabIssueSchema, GitlabMrSchema, GitlabNoteSchema, isHumanUser, type GitlabIssue, type GitlabNote } from './gitlab-trigger.ts'
import type { ContextMessage, ContextPartName, ContextPart, ThreadContext } from './kind.ts'

function gitlabMessage(item: { author: { username: string; bot?: boolean }; created_at: string; web_url?: string | null; updated_at?: string | null },
  text: string, id: string): ContextMessage {
  return { id, from: item.author.username, at: item.updated_at ?? item.created_at, text,
    ...!isHumanUser(item.author) ? { bot: true } : {}, ...item.web_url ? { url: item.web_url } : {} }
}
function notesPath(kind: 'issue' | 'mr', iid: number, page: number): [string, string[]] {
  const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
  return [path, ['--method', 'GET', '--field', 'sort=asc', '--field', 'order_by=created_at', '--field', 'per_page=100', '--field', `page=${page}`]]
}
function readKind(trigger: Trigger): 'issue' | 'mr' {
  const kind = trigger.meta.noteKind ?? trigger.meta.kind
  return kind === 'mr' ? 'mr' : 'issue'
}
/** Reads one page of an Issue or merge request: its title and description first on page 1, then its notes. */
async function conversationPage(commands: Commands, trigger: Trigger, page: number) {
  const iid = Number(trigger.meta.iid)
  if (!iid) throw new Error('The GitLab Trigger has no issue or merge-request IID')
  const kind = readKind(trigger)
  const messages: ContextMessage[] = []
  if (page === 1) {
    const description = kind === 'mr'
      ? await commands.gitlabApi(GitlabMrSchema, `merge_requests/${iid}`)
      : await commands.gitlabApi(GitlabIssueSchema, `issues/${iid}`)
    messages.push(gitlabMessage(description, `${description.title}\n\n${description.description ?? ''}`, description.web_url))
  }
  const [path, flags] = notesPath(kind, iid, page)
  const listed = await commands.gitlabApi(z.array(z.unknown()), path, ...flags)
  const tally = { skipped: 0 }
  const notes = validItems(GitlabNoteSchema, listed, tally).filter((note: GitlabNote) => !note.system)
  messages.push(...notes.map(note => gitlabMessage(note, note.body ?? '', String(note.id))))
  return { messages, next: listed.length === 100 ? String(page + 1) : null, ...tally.skipped ? { skipped: tally.skipped } : {} }
}
/** Reads a non-hidden file or directory listing from the project's default branch. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
  const project = await commands.gitlabApi(z.looseObject({ default_branch: z.string() }), '')
  if (kind === 'file') {
    return commands.gitlabApi(`repository/files/${encodeURIComponent(parts.join('/'))}/raw`, '--method', 'GET', '--field', `ref=${project.default_branch}`)
  }
  const entries = await commands.gitlabApi(z.array(z.looseObject({ name: z.string(), type: z.string().optional() })), 'repository/tree',
    '--method', 'GET', '--field', `path=${parts.join('/')}`, '--field', `ref=${project.default_branch}`, '--field', 'per_page=100')
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Context reader for a GitLab Trigger: the Issue/MR conversation, or its root, with notes as messages. */
export const gitlabThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? '',
  read: async (commands, trigger, part: ContextPartName, cursor): Promise<ContextPart> => {
    const body = await conversationPage(commands, trigger, Number(cursor ?? '1'))
    const messages = part === 'thread' ? body.messages : body.messages.slice(0, 1)
    return { messages, next: part === 'thread' ? body.next ?? undefined : undefined, body }
  },
}
