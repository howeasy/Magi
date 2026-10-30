import { describe, expect, test } from 'claude-code/testing'

import { cleanPeerText, onHost, peerHead } from '../hooks/clean-peer-text.ts'

describe('clean-peer-text', () => {
  test('a request shows a plain header line and its task alone', () => {
    const text = 'PEER REQUEST magi/1 task_id=magi-2 orchestrator=codex peer=omp mode=FACT_CHECK round=1/2\n\nROLE\nYou are the PEER.\n\n' +
      'TASK\nIndependently verify the factual claims below.\n\nIs X true?\n\nMODE\nFACT_CHECK. Check claims.'
    expect(cleanPeerText(text)).toBe('Request from codex · FACT_CHECK · magi-2 · round 1/2\n\nIs X true?')
  })

  test('a request from another machine says where its orchestrator is; onHost adds a worker host the header lacks', () => {
    const text = 'PEER REQUEST magi/1 task_id=magi-2 orchestrator=claude peer=omp mode=DELEGATE round=1/2 orchestrator_host=workstation\n\nROLE\nYou are the PEER.\n\n' +
      'TASK\nDo it.\n\nDo it.\n\nMODE\nDELEGATE.'
    expect(peerHead(text)?.title).toBe('Request from claude on workstation')
    expect(cleanPeerText(text).split('\n')[0]).toBe('Request from claude on workstation · DELEGATE · magi-2 · round 1/2')
    const reply = peerHead('PEER REPLY magi/1 task_id=magi-1 round=1 from=omp\n\nSUMMARY\nok')
    expect(reply && onHost(reply, 'mac').title).toBe('Reply from omp on mac')
    expect(reply && onHost(reply, null).title, 'on this machine: unchanged').toBe('Reply from omp')
    const answer = peerHead('PEER CLARIFICATION magi/1 task_id=magi-5 question_id=q-1\n\nUse main.')
    expect(answer && onHost(answer, 'mac').title, 'no sender to place').toBe('Answer to your question')
  })

  test('a header that names no sender says "a peer"', () => {
    expect(peerHead('PEER NOTE magi/1 task_id=magi-3\n\nhi')?.title).toBe('Note from a peer')
    expect(peerHead('PEER CLARIFICATION magi/1 task_id=magi-5 question_id=q-1\n\nUse main.')?.title).toBe('Answer to your question')
  })

  test('a body ending in words like the footer keeps them unless Magi wrote the footer', () => {
    const text = 'PEER NOTE magi/1 task_id=magi-3 from=omp\n\nPlease check each material finding against the source.'
    expect(cleanPeerText(text)).toBe('Note from omp · magi-3\n\nPlease check each material finding against the source.')
  })

  test("a message that is not Magi's comes back as sent", () => {
    expect(cleanPeerText('hello\n<!-- magi-delivery:abc -->')).toBe('hello\n<!-- magi-delivery:abc -->')
  })
})
