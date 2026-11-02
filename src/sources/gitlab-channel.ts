/** GitLab outbound channel: posts notes on Issues and merge requests under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { GitlabNoteSchema, gitlabPage } from './gitlab-trigger.ts'

const NotesSchema = z.array(GitlabNoteSchema)
const gone = (error: unknown): boolean => error instanceof CliError && error.code === 404
/** Posts a note with an embedded HTML marker so retries do not create duplicate notes. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const { gitlab } = commands.deployment
  if (!gitlab) throw new Error('The GitLab Source has no resolved project')
  const iid = Number(message.channel.address.iid)
  const kind = message.channel.address.kind === 'mr' ? 'mr' : 'issue'
  if (!iid) throw new Error('Missing GitLab reply target')
  const path = `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}/notes`
  try {
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (note: z.infer<typeof GitlabNoteSchema>) => sameName(note.author.username, gitlab.login) && (note.body ?? '').includes(marker)
    const notes = await commands.gitlabApi(NotesSchema, path, '--method', 'GET', '--field', 'per_page=100', '--field', 'sort=desc')
    if (notes.some(mine)) return 'sent'
    await commands.gitlabApi(z.unknown(), path, '--method', 'POST', '--field', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function gitlabLink(address: Record<string, string>, _links: ChannelLinks): ChannelLink {
  const iid = Number(address.iid ?? '')
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  const baseUrl = address.baseUrl ?? ''
  const project = address.project ?? ''
  return { url: baseUrl && project && iid ? gitlabPage(baseUrl, project, iid, kind) : '',
    label: kind === 'mr' ? { zh: `GitLab !${iid}`, en: `GitLab !${iid}` } : { zh: `GitLab #${iid}`, en: `GitLab #${iid}` } }
}
