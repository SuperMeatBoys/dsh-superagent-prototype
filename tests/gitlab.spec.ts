import { describe, expect, it } from 'vitest'
import { gitlabChannel, gitlabPage, gitlabThread, issueTrigger, mentions, mrTrigger, noteTrigger, GitlabIssueSchema, GitlabNoteSchema } from '../src/sources/gitlab-trigger.ts'

const baseUrl = 'https://gitlab.example.com'
const project = 'acme/widgets'
const issue = {
  id: 11, iid: 7, title: 'Fix the widget', description: 'Please @agent-bot fix this', state: 'opened',
  created_at: '2026-11-02T08:00:00Z', updated_at: '2026-11-02T08:00:00Z',
  web_url: `${baseUrl}/${project}/-/issues/7`,
  author: { id: 1, username: 'alice' },
}
const mr = {
  ...issue, id: 12, iid: 7, title: 'Widget MR', description: 'Ship it', web_url: `${baseUrl}/${project}/-/merge_requests/7`,
  source_branch: 'agent/ticket-7', target_branch: 'main', state: 'opened', source_project_id: 3,
}
const note = {
  id: 21, body: 'Thanks @agent-bot, please take a look', created_at: '2026-11-02T08:01:00Z', updated_at: '2026-11-02T08:01:00Z',
  author: { id: 1, username: 'alice' }, noteable_iid: 7, noteable_type: 'Issue',
}

describe('GitLab triggers', () => {
  it('keeps Issue and MR IIDs in separate threads', () => {
    expect(gitlabThread(7, 'issue')).toBe('gitlab:issue:7')
    expect(gitlabThread(7, 'mr')).toBe('gitlab:mr:7')
    expect(gitlabChannel(7, 'issue', baseUrl, project)).toEqual({ source: 'gitlab', thread: 'gitlab:issue:7',
      address: { iid: '7', kind: 'issue', baseUrl, project } })
    expect(gitlabPage(baseUrl, project, 7, 'mr')).toBe(`${baseUrl}/${project}/-/merge_requests/7`)
  })

  it('normalizes an Issue body mention into a trigger', () => {
    const trigger = issueTrigger(GitlabIssueSchema.parse(issue), 'agent-bot', baseUrl, project)
    expect(trigger).toMatchObject({ source: 'gitlab', addressed: 'mention', human: true,
      actor: { source: 'gitlab', id: 'alice' }, threads: [{ source: 'gitlab', id: 'issue:7' }],
      meta: { iid: 7, isMr: false, kind: 'issue' } })
    expect(trigger.text).toContain('Fix the widget')
  })

  it('normalizes a merge request and a note', () => {
    const trigger = mrTrigger(mr, 'agent-bot', baseUrl, project)
    expect(trigger.id).toBeTruthy()
    expect(trigger.addressed).toBeUndefined()
    expect(trigger).toMatchObject({ threads: [{ source: 'gitlab', id: 'mr:7' }], meta: { iid: 7, isMr: true, kind: 'mr' } })
    const comment = noteTrigger(GitlabNoteSchema.parse(note), { iid: 7, kind: 'issue', url: issue.web_url }, 'agent-bot', baseUrl, project)
    expect(comment.id).toBeTruthy()
    expect(comment).toMatchObject({ addressed: 'mention', threads: [{ source: 'gitlab', id: 'issue:7' }],
      meta: { iid: 7, isMr: false, kind: 'note', noteKind: 'issue', commentId: 21 } })
  })

  it('recognizes only the configured account mention', () => {
    expect(mentions('hello @agent-bot', 'agent-bot')).toBe(true)
    expect(mentions('hello @agent-botty', 'agent-bot')).toBe(false)
    expect(mentions('email@agent-bot.example', 'agent-bot')).toBe(false)
  })
})
