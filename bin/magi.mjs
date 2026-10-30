#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const mod = (...p) => pathToFileURL(join(root, ...p)).href;

const [cmd, ...rest] = process.argv.slice(2);

function usage() {
  console.log(`magi - peer collaboration between Claude Code, Codex CLI and Oh My Pi

  magi serve codex     MCP server for Claude Code (lets Claude consult Codex)
  magi serve claude    MCP server for Codex CLI  (lets Codex consult Claude)
  magi serve omp       MCP server for either     (lets it consult Oh My Pi)
      --as <name>         serve another harness under its own name (e.g. omp)
  magi peers [--json]  list live Claude sessions and Codex threads (--json for scripts)
  magi status [--json] [--cwd <dir>] [--as <claude|codex|omp>]
                          the three units and providers, open cards with their worker
                          and coordinator, debt, the last five outcomes, a seven-day
                          ledger and the last eight messages; message text is redacted
                          and cut to one line (--json is what the Claude Code mod draws
                          from; under 40 KB)
  magi provider list [--json]
  magi provider disable <claude|codex|omp> | enable <claude|codex|omp>
                          hide a provider or restore it; restart to refresh tools
  magi spawn <claude|codex|omp> --name <n> [--cwd <dir>] [--permission-mode <m>] [--model <m>] [--app] [--resume <spawnId>]
                          start a named live session (a tab in the "magi"
                          Windows Terminal window, or with --app the harness's
                          desktop app) that peers can address; --resume claims
                          a launch that came back pending
  magi doctor          check CLIs, auth, registrations and skills
  magi diff-hash [ref] print the sha256 of a diff, to pin a review to it
  magi reply --task <id> [--round <n>] --from <agent> --file <path>
                          file a peer reply without the MCP tool
  magi send --to <name|session id|pid> (--text <t> | --file <path>) [--agent claude|omp] [--name <label>] [--json]
                          deliver text into a live session from a script; exit 0
                          confirmed, 3 written but unconfirmed (do not resend),
                          1 not delivered, 2 usage
  magi mail [--task <id>] [--round <n>] [--drain]
                          inspect retained replies; consume only with --drain
  magi memory recall <query> | remember <text> [--tags a,b] | forget <id> | stats | export [--out <dir>]
                          shared SQLite memory [--cwd <dir>] [--global]; export writes markdown
  magi notices [--all] [--read <id>]
                          what agents flagged for you; --read marks one read
  magi log [--task <id>] [--limit <n>]
                          every task on record: mode, who asked whom, how the
                          round ended, and the reconciliation outcome
  magi close --task <id> [--reason <text>] [--stop]
                          close a round whose reply never came, as its orchestrator;
                          --stop also kills its headless worker
  magi exchange <task_id> [--json]
                          the words of one task: request, reply, outcome, close
                          (--json: redacted and bounded, for the deck)
  magi channels [--pair <name>]
                          conversations by coordinator/worker, current card,
                          whose turn, latency, debt and the channel thread
  magi migrate --home <dir>
                          explicitly import and verify legacy state, then remove it
  magi worker | workspace | relay
                          the remote end of a worker on another machine (host: on a
                          request, <MAGI_HOME>/remotes.json); run over ssh, not by hand
  magi files [on|off]  sending files to, and taking them from, peers on other machines
                          (off by default; each machine sets its own; no tool call can switch it)
  magi advisor-sync [off|1|3|5|strict|default]
                          operator's omp advisor backlog setting here (unset by default)
  magi sweep           maintain ancillary state; summarize/trim old closed-card exchanges
  magi queue-clean --thread <id|exact-name> [--apply]
                          preview/remove only verified superseded queue notes
  magi install         register MCP servers and install both skills
      --omp               also (or only) set up Oh My Pi: servers, inbox extension, skills
      --usage             chain 'magi statusline' into Claude's statusLine so
                          'magi usage' shows Claude's windows and 'magi peers' its cache warmth
                          (alone it does only this; with --claude/--codex/--omp, both)
  magi usage           subscription windows for Claude and Codex, per account
  magi uninstall       remove them again
`);
}

async function main() {
  switch (cmd) {
    case 'serve': {
      const { values, positionals } = parseArgs({ args: rest, options: { as: { type: 'string' } }, allowPositionals: true });
      const which = positionals[0];
      // A peer's own copy of the bridge could only refuse, and headless peers
      // answer inline, so it exits instead of costing a process per peer (omp
      // loads its MCP servers into a headless run and has no switch against it).
      if (Number(process.env.PEER_DEPTH ?? '0') >= 1) {
        console.error('magi serve: RECURSION_BLOCKED - PEER_DEPTH>=1, this process is a peer; answer the orchestrator inline. Not serving.');
        process.exit(0);
      }
      // The servers read this at import time; a flag beats an inherited env.
      if (values.as?.trim()) process.env.MAGI_AS = values.as.trim();
      const known = ['codex', 'claude', 'omp'];
      if (!positionals.length || !positionals.every((p) => known.includes(p))) {
        console.error('magi serve needs "codex", "claude" or "omp" (or several, with --as), optionally with --as <your agent name>.');
        process.exit(2);
      }
      if (positionals.length > 1) {
        // One process for every peer this session consults. Which harness is
        // asking cannot be guessed per peer, so the caller must say.
        if (!values.as?.trim()) {
          console.error(`magi serve ${positionals.join(' ')}: a combined server needs --as <the harness that loads it> (claude, codex or omp).`);
          process.exit(2);
        }
        const { serve } = await import(mod('src', 'serve.mjs'));
        const adapters = await Promise.all(positionals.map(async (p) => (await import(mod('src', `${p}-adapter.mjs`))).adapter));
        await serve(...adapters);
      } else await import(mod('src', `${which}-server.mjs`));
      return;
    }
    case 'provider': {
      const { getProviders, setProvider } = await import(mod('src', 'providers.mjs'));
      const { BridgeError } = await import(mod('src', 'exec.mjs'));
      const { values, positionals } = parseArgs({ args: rest, options: { json: { type: 'boolean' } }, allowPositionals: true });
      const [action, name] = positionals;
      if (action === 'list' && positionals.length === 1) {
        const providers = getProviders();
        if (values.json) console.log(JSON.stringify(providers));
        else for (const [provider, row] of Object.entries(providers)) console.log(`${provider}: ${row.status}${row.reason ? ` (${row.reason})` : ''}`);
        return;
      }
      if (!['enable', 'disable'].includes(action) || positionals.length !== 2 || values.json) {
        throw new BridgeError('BAD_REQUEST', 'Use \"magi provider list [--json]\", \"magi provider disable <claude|codex|omp>\" or \"magi provider enable <claude|codex|omp>\".');
      }
      setProvider(name, action === 'enable');
      console.log(`${name}: ${action === 'enable' ? 'enabled' : 'disabled'}. Restart the harness to refresh its tool list.`);
      return;
    }
    case 'peers': {
      const { listFleet, claudeDeliveryHints } = await import(mod('src', 'fleet.mjs'));
      const { listTasks } = await import(mod('src', 'state.mjs'));
      const { values } = parseArgs({ args: rest, options: { cwd: { type: 'string' }, json: { type: 'boolean' } }, allowPositionals: true });
      const cwd = values.cwd ?? process.cwd();
      const { peers, codexError, personas, providers } = await listFleet({ cwd });
      const deliveryHints = await claudeDeliveryHints(listTasks().filter((t) => t.cwd === cwd));
      // For hooks and scripts: what is live, in what state, without parsing the table.
      if (values.json) {
        console.log(JSON.stringify({ cwd, providers, peers: peers.map((p) => ({ harness: p.harness, name: p.name, id: p.id ?? null, cwd: p.cwd ?? null, state: p.state, idleMs: p.idleMs ?? null, remote: Boolean(p.remote) })), codexError: codexError ?? null, deliveryHints }));
        return;
      }
      for (const h of Object.keys(providers)) {
        const rows = peers.filter((p) => p.harness === h);
        if (providers[h].status === 'down') console.log(`${h}: down (${providers[h].reason})`);
        if (!rows.length && h !== 'claude') continue;
        console.log(`${h} sessions (${rows.length})${h === 'codex' ? ` for ${cwd}` : ''}:`);
        for (const p of rows) {
          console.log(`  ${p.name}  [${p.stateText || 'unknown'}]  ${p.id ?? ''}${p.pid ? `  pid=${p.pid}` : ''}${p.branch ? `  branch=${p.branch}` : ''}${p.lastActive ? `  ${p.lastActive}` : ''}  ${p.cwd ?? ''}`);
          if (p.purpose) console.log(`      ${p.purpose.length > 120 ? p.purpose.slice(0, 120) + '…' : p.purpose}`);
        }
      }
      if (codexError) console.log(`codex threads: unavailable (${codexError})`);
      for (const hint of deliveryHints) console.log(`  ${hint.taskId}: ${hint.statusText}`);
      if (personas.length) {
        console.log(`persistent peers (${personas.length}):`);
        for (const x of personas) console.log(`  ${x.name}  [${x.agent}${x.peer ? ` -> ${x.peer}` : ' -> ?, saved before the harness was recorded; not resumed'}]  ${x.runs} run(s), last used ${new Date(x.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}`);
      }
      return;
    }
    case 'status': {
      const { values } = parseArgs({ args: rest, options: { cwd: { type: 'string' }, as: { type: 'string' }, json: { type: 'boolean' } } });
      const { magiStatus } = await import(mod('src', 'status.mjs'));
      const s = await magiStatus({ cwd: values.cwd ?? process.cwd(), as: values.as ?? 'claude' });
      if (values.json) {
        console.log(JSON.stringify(s));
        return;
      }
      for (const u of s.units) console.log(`${u.unit.padEnd(12)} ${u.harness.padEnd(7)} ${u.state.padEnd(9)} ${u.sessions} live, ${u.working} working, ${u.workers} headless, ${u.openCards} open card(s)`);
      for (const c of s.cards) {
        console.log(`  ${c.taskId}  ${c.mode.padEnd(18)} ${c.from}->${c.to}  round ${c.round}${c.maxRounds ? `/${c.maxRounds}` : ''}  ${c.turn === 'peer' ? 'peer working' : `${c.from}'s turn`}`);
        for (const d of c.delivery) if (d.statusText) console.log(`    to ${d.to}: ${d.status}; ${d.statusText}`);
      }
      if (s.cardsTotal > s.cards.length) console.log(`  ... ${s.cardsTotal - s.cards.length} more open card(s); "magi channels" lists them all`);
      console.log(`${s.unreconciled} unreconciled for ${s.as} here${s.liveError ? `; live sessions partly unknown (${s.liveError})` : ''}`);
      for (const o of s.outcomes) console.log(`  ${o.taskId}  ${o.from}->${o.to}  accepted ${o.accepted}, rejected ${o.rejected}, open ${o.open}`);
      return;
    }
    case 'log': {
      const { values } = parseArgs({ args: rest, options: { task: { type: 'string' }, limit: { type: 'string' } } });
      const { listTasksWithArchive: listTasks, taskSummary } = await import(mod('src', 'state.mjs'));
      const { sessionLabel } = await import(mod('src', 'fleet.mjs'));
      // The limit trims the listing, not the tally: a headline computed from the
      // newest 50 of 900 tasks read as the whole record.
      const all = listTasks().filter((t) => !values.task || t.taskId === values.task);
      const rows = all.slice(0, Number(values.limit ?? 50));
      const tally = { scored: 0, accepted: 0, rejected: 0, open: 0, spend: 0, runs: 0, tokens: 0, tokenRuns: 0 };
      const tokFmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
      for (const t of all) {
        const s = taskSummary(t);
        const when = s.openedAt ? new Date(s.openedAt).toISOString().slice(0, 16).replace('T', ' ') : '                ';
        if (rows.includes(t)) console.log(
          `${when}  ${s.taskId}  ${String(s.mode).padEnd(18)} ${sessionLabel(t.orchestratorTarget, s.orchestrator)}->${sessionLabel(t.peerTarget, s.peer)}  round ${s.round}  ${s.status}` +
            (s.peerStatus ? `  peer=${s.peerStatus}${s.peerStatus === 'resolved' || !s.peerStatusReason ? '' : ` (${s.peerStatusReason.slice(0, 60)})`}` : '') +
            (s.diff ? `  diff=${s.diff}` : '') +
            (s.commands ? `  commands=${s.commands} round${s.commands === 1 ? '' : 's'}` : '') +
            (s.costUsd != null ? `  $${s.costUsd.toFixed(2)}` : s.tokens ? `  ${tokFmt(s.tokens)} tok` : '') +
            (s.outcome ? `  outcome=${s.outcome}` : ''),
        );
        for (const r of t.rounds ?? []) {
          const tok = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
          if (tok) { tally.tokens += tok; tally.tokenRuns++; }
          if (r.usage?.costUsd == null) continue;
          tally.spend += r.usage.costUsd;
          tally.runs++;
        }
        if (t.outcome) {
          tally.scored++;
          for (const k of ['accepted', 'rejected', 'open']) tally[k] += t.outcome[k];
          if (t.outcome.notes && rows.includes(t)) console.log(`      ${t.outcome.notes.split(/\r?\n/)[0].slice(0, 160)}${t.outcome.by ? `  (by ${t.outcome.by})` : ''}`);
        }
      }
      const settled = tally.accepted + tally.rejected;
      console.log(
        `\n${rows.length < all.length ? `listing the newest ${rows.length} of ${all.length}; totals cover all ${all.length}: ` : `${all.length} task(s); `}${tally.scored} with a recorded outcome (accepted/rejected/open): ` +
          `${tally.accepted} accepted, ${tally.rejected} rejected, ${tally.open} open` +
          (settled ? `; peer findings held ${Math.round((100 * tally.accepted) / settled)}% of the time they were settled` : '') +
          (tally.open ? `; ${tally.open} finding(s) (${Math.round((100 * tally.open) / (settled + tally.open))}%) still open, which that rate leaves out` : '') +
          (tally.runs ? `; peer spend $${tally.spend.toFixed(2)} over ${tally.runs} priced headless run(s)` : '') +
          (tally.tokenRuns ? `; ${tokFmt(tally.tokens)} tokens over ${tally.tokenRuns} headless run(s), the figure that exists where no price does` : ''),
      );
      return;
    }
    case 'close': {
      // The orchestrating session is usually gone by the time a human wants
      // this, so the CLI acts as whoever the ledger says orchestrated it.
      const { values } = parseArgs({ args: rest, options: { task: { type: 'string' }, reason: { type: 'string' }, stop: { type: 'boolean' } } });
      if (!values.task) throw new Error('close requires --task.');
      const { readTask } = await import(mod('src', 'state.mjs'));
      const rec = readTask(values.task);
      if (!rec) throw new Error(`No task ${values.task}.`);
      const { makeEngine } = await import(mod('src', 'peer.mjs'));
      // --stop kills the card's headless worker, which belongs to whichever server launched it.
      const { stopHeadlessWorker } = await import(mod('src', 'worker-channel.mjs'));
      const result = await makeEngine({ orchestrator: rec.orchestrator, stopHeadless: stopHeadlessWorker }).handleClose({ taskId: values.task, body: values.reason, stop: values.stop });
      console.log(result.content.map((c) => c.text ?? '').join('\n'));
      if (result.isError) process.exitCode = 1;
      return;
    }
    case 'spawn': {
      const { values, positionals } = parseArgs({ args: rest, options: { name: { type: 'string' }, cwd: { type: 'string' }, 'permission-mode': { type: 'string' }, model: { type: 'string' }, app: { type: 'boolean' }, resume: { type: 'string' } }, allowPositionals: true });
      const harness = positionals[0];
      if (!['claude', 'codex', 'omp'].includes(harness) || !values.name) throw new Error('spawn needs <claude|codex|omp> and --name.');
      const { spawnPeer } = await import(mod('src', 'spawn.mjs'));
      const { listClaudeSessions, listAgentSessions } = await import(mod('src', 'transport.mjs'));
      const sessions = harness === 'claude' ? async () => listClaudeSessions() : harness === 'omp' ? async () => listAgentSessions('omp') : async () => [];
      const row = await spawnPeer({ harness, name: values.name, cwd: values.cwd ?? process.cwd(), permissionMode: values['permission-mode'], model: values.model, app: values.app, spawnId: values.resume, sessions });
      // Pending is not a failure: the launch was handed over and what is
      // still owed is said; exit 0 either way.
      if (row.pending) console.log(`${harness} "${row.requestedName}" is not claimed yet${row.where ? ` (opened in ${row.where})` : ''}. ${row.next}`);
      else console.log(`${row.recovered ? 'Claimed' : 'Started'} ${harness}${row.name ? ` "${row.name}"` : ''}${row.id ? ` [${row.id}]` : ''} in ${row.cwd}${row.created ? ' (new directory, git initialised)' : ''}${row.where ? `: ${row.where}` : ''}${row.appLink ? ` (${row.appLink})` : ''}.${row.name ? '' : ` Address it by id; it has no name yet.`}`);
      return;
    }
    case 'statusline': {
      // Claude's statusline hook: JSON on stdin, one line on stdout.
      const { runStatusline } = await import(mod('src', 'usage.mjs'));
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      process.stdout.write(await runStatusline(Buffer.concat(chunks).toString('utf-8')));
      return;
    }
    case 'usage': {
      const { usageSummary } = await import(mod('src', 'usage.mjs'));
      const u = await usageSummary();
      const fmt = (w) => `${w.label} ${w.usedPercent != null ? `${Math.round(w.usedPercent)}%` : '?'}${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toISOString().slice(0, 16).replace('T', ' ')})` : ''}`;
      console.log(u.claude ? `claude: ${u.claude.windows.map(fmt).join(', ')}  (from session ${u.claude.from.slice(0, 8)}, ${Math.round((Date.now() - u.claude.at) / 60000)}m ago)` : 'claude: no recent statusline data (run "magi install --usage" and let a session render)');
      if (u.codex?.error) console.log(`codex: unavailable (${u.codex.error})`);
      else if (u.codex) console.log(`codex (${u.codex.plan ?? '?'}): ${u.codex.windows.map(fmt).join(', ')}${u.codex.byModel.length ? '\n  ' + u.codex.byModel.map((m) => `${m.name}: ${m.usedPercent ?? '?'}%`).join('\n  ') : ''}`);
      return;
    }
    case 'memory': {
      const { values, positionals } = parseArgs({ args: rest, options: { cwd: { type: 'string' }, tags: { type: 'string' }, global: { type: 'boolean' }, out: { type: 'string' } }, allowPositionals: true });
      const mem = await import(mod('src', 'memory.mjs'));
      const cwd = values.cwd ?? process.cwd();
      const scope = values.global ? 'global' : 'project';
      const [verb, ...restWords] = positionals;
      const text = restWords.join(' ');
      try {
        if (verb === 'recall') {
          const rows = await mem.recall({ query: text, cwd, scope, limit: 12 });
          if (!rows.length) console.log('Nothing in memory matches.');
          for (const m of rows) console.log(`${m.id ?? '?'}  ${m.content}${m.tags?.length ? `  [${m.tags.join(', ')}]` : ''}`);
          if (rows.embeddingNotice) console.log(rows.embeddingNotice);
        } else if (verb === 'remember') {
          const r = await mem.remember({ body: text, tags: values.tags ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : [], cwd, scope, source: 'human' });
          console.log(`Remembered${r.id ? ` (${r.id})` : ''}.`);
        } else if (verb === 'forget') {
          console.log(`Forgot ${(await mem.forget({ memoryId: text, cwd, scope })).forgotten}.`);
        } else if (verb === 'stats') {
          console.log(JSON.stringify(await mem.stats({ cwd, scope }), null, 1));
        } else if (verb === 'export') {
          const result = await mem.exportMemory({ cwd, scope, directory: values.out });
          console.log(`Exported ${result.units} memory units to ${result.directory}.`);
        } else throw new Error('memory needs recall <query>, remember <text>, forget <id>, stats or export [--out <dir>].');
      } finally {
        await mem.close();
      }
      return;
    }
    case 'notices': {
      const { values } = parseArgs({ args: rest, options: { all: { type: 'boolean' }, read: { type: 'string' } } });
      const { listNotices, markNoticeRead } = await import(mod('src', 'state.mjs'));
      if (values.read) {
        const rec = markNoticeRead(values.read);
        console.log(`${rec.id} marked read.`);
        return;
      }
      const rows = listNotices({ unreadOnly: !values.all });
      if (!rows.length) {
        console.log(values.all ? 'No notices on record.' : 'No unread notices. --all shows read ones too.');
        return;
      }
      for (const n of rows) {
        const when = new Date(n.at).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`${n.readAt ? '  ' : '* '}${when}  ${n.id}  from ${n.from}${n.sender ? ` (${n.sender})` : ''}${n.cwd ? `  in ${n.cwd}` : ''}${n.taskId ? `  task ${n.taskId}` : ''}`);
        for (const line of n.body.split(/\r?\n/)) console.log(`      ${line}`);
      }
      return;
    }
    case 'channels': {
      const { values } = parseArgs({ args: rest, options: { pair: { type: 'string' } } });
      const { listTasks } = await import(mod('src', 'state.mjs'));
      const { channelsOf, refreshChannelDeliveries } = await import(mod('src', 'fleet.mjs'));
      const rows = channelsOf(listTasks()).filter((c) => !values.pair || c.fromName === values.pair || c.toName === values.pair || `${c.fromName} -> ${c.toName}` === values.pair);
      await refreshChannelDeliveries(rows);
      const duration = (ms) => ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
      if (!rows.length) console.log('No channels' + (values.pair ? ` matching "${values.pair}"` : '') + '.');
      for (const c of rows) {
        console.log(`\n${c.fromName} ${c.openQuestion ? '<-' : '->'} ${c.toName} [${c.fromId ?? c.from}/${c.toId ?? c.to}]`);
        console.log(`  ${c.statusText}`);
        console.log(`  current card: ${c.currentCard.taskId} (${c.currentCard.mode}); ${c.turnCount} turns; median reply -> next request: ${c.medianLatencyMs == null ? 'n/a' : duration(c.medianLatencyMs)}; ${c.unreconciledCount} unreconciled`);
        if (c.openQuestion) console.log(`  open question: ${c.openQuestion.text}`);
        for (const t of c.turns) {
          console.log(`  --- ${t.taskId} (${t.mode}) round ${t.round}/${t.maxRounds}: ${t.status}`);
          if (!t.events.length) console.log(`      ${t.brief ?? '(task text unavailable)'}`);
          for (const e of t.events) {
            console.log(`      ${e.kind} round ${e.round ?? ''} from ${e.fromName}${e.at ? ` at ${new Date(e.at).toISOString()}` : ''}${e.repeatedAnswer ? ` [repeated identical answer from ${e.repeatedFrom.taskId} round ${e.repeatedFrom.round}]` : ''}`);
            const text = e.kind === 'request' ? e.task ?? t.brief ?? '(task text unavailable)' : e.text;
            if (text) for (const line of text.split(/\r?\n/)) console.log(`        ${line}`);
          }
        }
      }
      return;
    }
    case 'exchange': {
      const id = rest.find((arg) => !arg.startsWith('--'));
      if (!id) throw new Error('exchange needs a task_id.');
      if (rest.includes('--json')) {
        // The deck's full-messages view: redacted words, bounded (cardThread).
        const { cardThread } = await import(mod('src', 'status.mjs'));
        console.log(JSON.stringify(cardThread(id)));
        return;
      }
      const { readExchange, readTask, outcomeCovers } = await import(mod('src', 'state.mjs'));
      const { sessionLabel } = await import(mod('src', 'fleet.mjs'));
      const rec = readTask(id);
      if (!rec) throw new Error(`No task ${id}.`);
      const ev = readExchange(id);
      const from = sessionLabel(rec.orchestratorTarget, rec.orchestrator), to = sessionLabel(rec.peerTarget, rec.peer);
      console.log(`${id} ${rec.mode} ${from} -> ${to} round ${rec.rounds.at(-1)?.round}/${rec.maxRounds}${rec.outcome ? ` outcome ${rec.outcome.accepted}/${rec.outcome.rejected}/${rec.outcome.open}${outcomeCovers(rec) ? '' : ' (does not cover every reply; an answered round is unchecked)'}` : ' (no outcome recorded)'}`);
      if (!ev.length) console.log('(opened before the exchange was kept; the ledger has the facts, not the words)');
      for (const e of ev) {
        const asker = e.kind === 'request' || e.kind === 'clarification' || e.kind === 'outcome' || e.kind === 'closed';
        console.log(`\n--- ${e.kind} round ${e.round ?? ''} from ${asker ? from : to}${e.to ? ` to ${asker ? to : from}` : ''}${e.via ? ` via ${e.via}` : ''}${e.allowCommands ? ' with shell commands allowed' : ''} at ${new Date(e.at).toISOString()}${e.kind === 'outcome' ? ` ${e.accepted}/${e.rejected}/${e.open}` : ''}${e.reason ? ` ${e.reason}` : ''}`);
        if (e.text) console.log(e.text);
      }
      return;
    }
    case 'migrate': {
      const { values } = parseArgs({ args: rest, options: { home: { type: 'string' } } });
      if (!values.home) throw new Error('MIGRATION_HOME_REQUIRED: Pass --home <state directory>; stop old Magi servers and back up their state before migrating.');
      const { migrateLegacy } = await import(mod('src', 'store.mjs'));
      const { retryState } = await import(mod('src', 'state.mjs'));
      console.log(JSON.stringify(await retryState(() => migrateLegacy(values.home)), null, 2));
      return;
    }
    // The remote end of a headless worker on another machine; run by the
    // orchestrator's server over ssh, never by hand (src/remote-worker.mjs).
    case 'worker': {
      const { worker } = await import(mod('src', 'remote-worker.mjs'));
      await worker(rest[0], rest[1]);
      return;
    }
    case 'relay': {
      const { relay } = await import(mod('src', 'remote-worker.mjs'));
      await relay(rest[0]);
      return;
    }
    case 'workspace': {
      const { workspace } = await import(mod('src', 'remote-worker.mjs'));
      let out;
      try { out = workspace(rest[0]); }
      catch (e) { out = { ok: false, code: e.code ?? 'REMOTE_FAILED', message: String(e.stderr ?? e.message).trim().slice(0, 600) }; process.exitCode = 1; }
      console.log(JSON.stringify(out));
      return;
    }
    case 'files': {
      const { filesEnabled, setFilesEnabled } = await import(mod('src', 'artifacts.mjs'));
      const [choice] = rest;
      if (choice !== undefined && choice !== 'on' && choice !== 'off') throw new Error('magi files takes on, off, or nothing to show the setting.');
      // The operator's switch: a worker Magi started does not get to flip it.
      if (choice && Number(process.env.PEER_DEPTH ?? 0) > 0) throw new Error('FILES_SETTING_REFUSED: magi files on/off is run by the operator, not from inside a peer worker. Ask the person running Magi.');
      if (choice) setFilesEnabled(choice === 'on');
      console.log(filesEnabled()
        ? 'Files between machines: on here. A peer on another machine can be sent files, and this machine takes the files sent to it; the other machine must have it on too. `magi files off` turns it off.'
        : 'Files between machines: off here (the default). A `files` field is refused (FILES_OFF), and files sent here are not taken. `magi files on` turns it on; the other machine needs it on too.');
      return;
    }
    case 'advisor-sync': {
      const { advisorSyncBacklog, setAdvisorSyncBacklog } = await import(mod('src', 'omp-advisor.mjs'));
      if (rest.length > 1) throw new Error('BAD_REQUEST: magi advisor-sync takes one value, or nothing to show the setting.');
      const [choice] = rest;
      if (choice !== undefined) {
        if (Number(process.env.PEER_DEPTH ?? 0) > 0) throw new Error('ADVISOR_SETTING_REFUSED: magi advisor-sync is run by the operator, not from inside a peer worker. Ask the person running Magi.');
        setAdvisorSyncBacklog(choice === 'default' ? null : choice);
      }
      const value = advisorSyncBacklog();
      console.log(value === null
        ? 'omp advisor.syncBacklog: unset here. The worker overlay leaves it unwritten; omp defaults to \"off\" unless its own configuration sets it. `magi advisor-sync <off|1|3|5|strict>` sets it.'
        : `omp advisor.syncBacklog: ${JSON.stringify(value)} here. Applied to workers started on this machine; \`magi advisor-sync default\` leaves it unwritten again.`);
      return;
    }
    case 'sweep': {
      const { sweep } = await import(mod('src', 'state.mjs'));
      await sweep();
      console.log('Maintained stale usage, read notices, queue receipts, dead workers/waiters/frames and seven-day spills. Attempted summary-before-trim retention for closed-card exchanges older than 30 days; metadata and verdicts retained. RETENTION_FAILED warnings identify deferred work.');
      return;
    }
    case 'queue-clean': {
      const { values } = parseArgs({ args: rest, options: { thread: { type: 'string' }, apply: { type: 'boolean' } } });
      if (!values.thread) throw new Error('queue-clean requires an explicit --thread.');
      const { resolveSteerTarget } = await import(mod('src', 'codex-target.mjs'));
      const { cleanupOwnedQueue } = await import(mod('src', 'queue-hygiene.mjs'));
      const threadId = await resolveSteerTarget(values.thread);
      console.log(JSON.stringify(await cleanupOwnedQueue(threadId, { dryRun: !values.apply }), null, 2));
      return;
    }
    case 'mail': {
      const { values } = parseArgs({ args: rest, options: { task: { type: 'string' }, round: { type: 'string' }, drain: { type: 'boolean' } } });
      const round = values.round === undefined ? undefined : Number(values.round);
      if (round !== undefined && (!Number.isInteger(round) || round < 1)) throw new Error('--round must be a positive integer.');
      if (values.drain && !values.task) throw new Error('--drain requires an explicit --task.');
      const { listMail, takeReply, retryState } = await import(mod('src', 'state.mjs'));
      const rows = values.drain
        ? [await retryState(() => takeReply(values.task, round))].filter(Boolean)
        : listMail(values.task).filter((row) => round === undefined || row.round === round);
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    case 'reply': {
      // Fallback for a live peer whose bridge tool is unavailable or denied.
      const { values } = parseArgs({
        args: rest,
        options: {
          task: { type: 'string' },
          from: { type: 'string' },
          file: { type: 'string' },
          text: { type: 'string' },
          round: { type: 'string' },
        },
        allowPositionals: true,
      });
      // Any agent name the ledger might hold; the ledger's role check decides.
      if (!values.task || !/^[a-z][a-z0-9_-]{0,31}$/.test(values.from ?? '') || !(values.file || values.text)) {
        console.error('usage: magi reply --task <task_id> [--round <n>, required after round 1] --from <claude|codex|omp|...> (--file <path> | --text <text>)');
        process.exit(2);
      }
      const { readFileSync } = await import('node:fs');
      const body = values.text ?? readFileSync(values.file, 'utf-8');
      const { makeEngine } = await import(mod('src', 'peer.mjs'));
      const { deliverReplyToOrigin, resolveOrigin } = await import(mod('src', 'transport.mjs'));
      const { deliverWorkerMessage } = await import(mod('src', 'relay.mjs'));
      // Run from inside the worker's session, the caller is found the way its
      // MCP server finds it (its ancestry): a card worked across machines
      // takes a reply only from its verified worker. An orchestrator on
      // another machine gets it through the relay outbox.
      const engine = makeEngine({
        orchestrator: values.from,
        resolveOrigin: async (args) => { try { return await resolveOrigin(values.from, args); } catch { return null; } },
        deliverReply: (o) => deliverWorkerMessage(o, deliverReplyToOrigin),
      });
      const result = await engine.handleReply({ taskId: values.task, body, round: values.round === undefined ? undefined : Number(values.round) });
      console.log(result.content.map((item) => item.text ?? '').join('\n'));
      if (result.isError) process.exitCode = 1;
      return;
    }
    case 'send': {
      // A script's way into a live session (a scripted orchestrator has no
      // MCP tools). Exit: 0 confirmed, 3 written but unconfirmed (it may yet
      // land, or be held for the receiver's user: do not resend), 1 not
      // delivered, 2 usage.
      const { values } = parseArgs({
        args: rest,
        options: {
          to: { type: 'string' },
          text: { type: 'string' },
          file: { type: 'string' },
          agent: { type: 'string', default: 'claude' },
          name: { type: 'string' },
          json: { type: 'boolean', default: false },
        },
      });
      if (!values.to || !(values.text || values.file) || (values.text && values.file) || !['claude', 'omp'].includes(values.agent)) {
        console.error('usage: magi send --to <session name | session id | pid> (--text <text> | --file <path>) [--agent claude|omp] [--name <label>] [--json]');
        process.exit(2);
      }
      const { readFileSync } = await import('node:fs');
      const { sendLive } = await import(mod('src', 'serve.mjs'));
      const { adapter } = await import(mod('src', `${values.agent}-adapter.mjs`));
      const out = (result, code) => {
        if (values.json) console.log(JSON.stringify(result));
        else if (result.ok) console.log(`${result.deliveryStatus}: ${result.via} (message ${result.messageId})${result.warning ? `\n${result.warning}` : ''}`);
        else console.error(`${result.code}: ${result.error}`);
        process.exitCode = code;
      };
      try {
        const text = values.text ?? readFileSync(values.file, 'utf-8');
        const r = await sendLive(adapter, { to: values.to, text, name: values.name });
        const confirmed = ['received', 'received_mid_turn', 'queued_unread'].includes(r.deliveryStatus);
        if (r.deliveryStatus === 'failed') out({ ok: false, ...r, code: 'DELIVERY_FAILED', error: r.statusText ?? 'The receiver rejected the message.' }, 1);
        else out({ ok: true, ...r }, confirmed ? 0 : 3);
      } catch (e) {
        // A write that was attempted may have landed: say so, and never invite a blind resend.
        const uncertain = e.dispatchUncertain === true;
        out({ ok: false, deliveryStatus: uncertain ? 'unconfirmed' : 'not_delivered', code: e.code ?? 'DELIVERY_FAILED', error: e.message + (uncertain ? ' The write may have landed; check the session before resending.' : '') }, uncertain ? 3 : 1);
      }
      return;
    }
    case 'diff-hash': {
      const { repoSnapshot } = await import(mod('src', 'protocol.mjs'));
      const snap = repoSnapshot(process.cwd(), rest[0] ?? 'worktree');
      if (!snap.diffSha256) {
        console.error('No diff (not a git repository, or the range is empty).');
        process.exit(1);
      }
      console.log(snap.diffSha256);
      return;
    }
    case 'doctor': {
      const { doctor } = await import(mod('src', 'install.mjs'));
      process.exit((await doctor()) ? 0 : 1);
      return;
    }
    case 'install': {
      const { install } = await import(mod('src', 'install.mjs'));
      const { values } = parseArgs({
        args: rest,
        options: { claude: { type: 'boolean' }, codex: { type: 'boolean' }, omp: { type: 'boolean' }, usage: { type: 'boolean' }, 'skills-only': { type: 'boolean' } },
        allowPositionals: true,
      });
      await install({ claude: values.claude, codex: values.codex, omp: values.omp, usage: values.usage, skillsOnly: values['skills-only'], root });
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import(mod('src', 'install.mjs'));
      await uninstall();
      return;
    }
    default:
      usage();
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => {
  console.error(`magi: ${e.code ? e.code + ': ' : ''}${e.message}`);
  process.exit(1);
});
