// The one input schema behind all three peer tools.
//
// A tool's schema is loaded into the host session on every turn, so every
// word here is paid for constantly. The descriptions are pointers: enough to
// pick the right field, front-loaded on the word that decides it. The skill
// and PROTOCOL.md carry the reasoning, and they load only when needed.
import { z } from 'zod';

export const KINDS = ['request', 'reply', 'clarify', 'clarify_answer', 'note', 'notify', 'spawn', 'remember', 'recall', 'forget', 'peers', 'transcript', 'outcome', 'close'];

export function peerToolDescription(peer) {
  return `Consult ${peer} as an independent peer: review, adversarial review, fact-check, or delegate. request hands work over; taskId continues its card; note talks during it. Live session first, else headless. Read-only unless a DELEGATE has allowWrites: true (web search allowed); never send repository content to the web. Check every answered turn; record one outcome per card.`;
}

// `deliveries` and `peerHint` are the two things that differ per peer.
export function peerInputSchema({ deliveries, peerHint, steerHint, queueKey = false, advisor = false }) {
  const s = {
    kind: z.enum(KINDS).optional().default('request').describe('request (default): ask a peer; reply: answer its task; clarify / clarify_answer: question / answer; note: converse; peers / transcript: inspect; outcome: reconcile; close: stop waiting; spawn: a session; remember / recall / forget: memory; notify: the human'),
    task: z.string().optional().describe('request: what the peer should evaluate or do'),
    mode: z.enum(['SECOND_OPINION', 'REVIEW', 'ADVERSARIAL_REVIEW', 'FACT_CHECK', 'DELEGATE']).optional().describe('request: default SECOND_OPINION; DELEGATE (edits only with allowWrites: true)'),
    context: z.string().optional().describe('Only what the peer needs; never secrets'),
    independence: z.boolean().optional().default(true).describe('Withhold your conclusions (default); false only in a later round that must engage prior claims'),
    evidenceRequirements: z.string().optional().describe('e.g. "cite file:line for every finding"'),
    outputHints: z.string().optional(),
    workingDirectory: z.string().optional().describe('Workspace for the evidence and the run (default: yours); also picks the default live peer'),
    diffRef: z.string().optional().describe('Pin the review to a git diff: HEAD~1..HEAD, --staged, or worktree'),
    peer: z.string().optional().describe(`${peerHint}, as kind:"peers" lists it. transcript: whose conversation to read (default: the one a request would reach)`),
    name: z.string().optional().describe('spawn: the new session\'s name (a-z, 0-9, _ -). Spawn only when the user asked; a request with no live peer goes headless by itself'),
    permissionMode: z.string().optional().describe("spawn: the new session's permission mode, passed as given; omit for its default"),
    model: z.string().optional().describe("spawn or headless request: the model in its harness's own words; omit for its default. A live session keeps its own"),
    app: z.boolean().optional().describe('spawn: open in the desktop app, not a terminal; the human sends the prefilled prompt; permissionMode/model ignored'),
    spawnId: z.string().optional().describe('spawn: claim a pending launch by the id it gave; launches nothing'),
    from: z.string().optional().describe('Leave unset'),
    delivery: z.enum(deliveries).optional().default('auto').describe(
      'auto: live session in this directory, else headless. live: no fallback. headless: fresh peer (persist or resumeThreadId resumes one)' + (steerHint ? `. steer: ${steerHint}` : ''),
    ),
    steerReply: z.boolean().optional().describe('request: get the reply mid-turn by steer, not at your next idle (Codex desktop or omp orchestrator)'),
    wait: z.boolean().optional().describe('true blocks for the reply; false returns once delivered and the reply comes as a PEER REPLY turn. Default: live reviews block, headless returns. Parallel requests: wait:false on each (calls run one at a time)'),
    timeoutMs: z.number().optional().describe('Headless run or live wait limit; default 40 min, cap 60'),
    allowWrites: z.boolean().optional().describe('READ-ONLY unless true; only DELEGATE honours it, live or headless: without it the worker changes nothing. A continuation keeps the card grant'),
    allowCommands: z.boolean().optional().describe("Headless DELEGATE with allowWrites: the worker may run shell commands (tests, builds). On by default where the server has a launch wrapper; false withholds them. A continuation keeps or narrows the grant"),
    files: z.array(z.string()).max(20).optional().describe('Another machine only, when its peer cannot read the path and the operator turned files on: copies of files in your working directory (PROTOCOL: Request fields)'),
    host: z.string().optional().describe('A machine from remotes.json: a headless worker there, or with peer a live session there; peers: its sessions (PROTOCOL: Request fields)'),
    resumeThreadId: z.string().optional().describe('Headless: resume this session on purpose'),
    persist: z.string().optional().describe('Name a long-lived headless peer of your own; resumes its context per working directory. Omit for an independent pass'),
    taskId: z.string().optional().describe('request: continue this card (engine assigns the turn). note: talk to its recorded worker. reply / clarify / clarify_answer / outcome / close: the card from task_id'),
    stop: z.boolean().optional().describe('close: also stop the card\'s headless worker now (kills its process; a live session is not stopped)'),
    questionId: z.string().optional().describe('clarify_answer (required): question_id from the PEER QUESTION frame; answerable once'),
    round: z.number().int().positive().optional().describe('reply: round from the request header. clarify_answer: defaults to the question round. Requests: leave unset'),
    maxRounds: z.number().optional().describe('Review loop guard: default by mode, cap 12'),
    counterpartyClaims: z.string().optional().describe('Later round: the other side\'s claims and evidence'),
    accepted: z.number().int().nonnegative().optional().describe('outcome: findings that held once checked'),
    rejected: z.number().int().nonnegative().optional().describe('outcome: findings the evidence disproved'),
    open: z.number().int().nonnegative().optional().describe('outcome: findings unchecked or unresolved, named in body'),
    body: z.string().optional().describe('reply, clarify, clarify_answer, note: the text. notify: a decision only the human can make, or a finding they must act on (never progress). remember: one self-contained claim, at most 600 chars. recall: the question. outcome: one-line notes. close: why you stopped waiting'),
    tags: z.array(z.string()).optional().describe('remember: a few words to find it by'),
    scope: z.enum(['project', 'global']).optional().describe('remember, recall, forget: this directory (default) or every project'),
    memoryId: z.string().optional().describe('forget: the id recall showed'),
    limit: z.number().int().positive().max(50).optional().describe('recall: how many, default 8. transcript: how many lines, default 20'),
    validUntil: z.string().optional().describe('remember: ISO date after which it no longer applies'),
  };
  if (queueKey) s.queueKey = z.string().min(1).max(128).optional().describe('Live Codex message topic: replaces your older unconsumed update');
  if (advisor) s.advisor = z.boolean().optional().describe("Headless request: omp's advisor, a second model, reviews each turn and may steer the worker. false overrides the server default");
  return s;
}
