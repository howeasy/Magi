// Stand-in for the codex / claude executables.
// Named by FAKE_CLI_NAME from the shim that invokes it.
const path = require('node:path');
const fs = require('node:fs');

const name = process.env.FAKE_CLI_NAME || null;

if (name) {
  const args = process.argv.slice(2);
  const scenario = process.env.FAKE_CLI_SCENARIO || 'ok';
  // The daemon proxy is a WebSocket endpoint, not a headless JSONL worker.
  if (name === 'codex' && args[0] === 'app-server' && args[1] === 'proxy') {
    if (!process.env.FAKE_CODEX_DAEMON) process.exit(1);
    const fixture = JSON.parse(process.env.FAKE_CODEX_DAEMON);
    const threads = fixture.threads ?? [];
    const loadedIds = fixture.loadedIds ?? threads.filter((t) => t.status?.type !== 'notLoaded').map((t) => t.id);
    const log = (entry) => {
      if (!process.env.FAKE_CLI_LOG) return;
      // Best effort, as below: a Windows append racing the test's read must not kill the fake daemon.
      try { fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ name, args, pid: process.pid, daemon: true, ...entry }) + '\n'); } catch { /* best effort */ }
    };
    const frame = (payload, opcode = 1) => {
      const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
      const header = Buffer.alloc(body.length < 126 ? 2 : body.length <= 65535 ? 4 : 10);
      header[0] = 0x80 | opcode;
      if (body.length < 126) header[1] = body.length;
      else if (body.length <= 65535) { header[1] = 126; header.writeUInt16BE(body.length, 2); }
      else { header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
      return Buffer.concat([header, body]);
    };
    const server = require('node:http').createServer();
    server.on('upgrade', (req, socket, head) => {
      const accept = require('node:crypto').createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      const upgrade = () => {
        if (socket.destroyed) return;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        let buffer = Buffer.alloc(0);
        let fragments = [];
        const send = (m) => socket.write(frame(m));
        const command = (m) => {
          if (!m.method) { log({ daemonResponse: m }); return; }
          log({ rpc: m.method, params: m.params });
          const p = m.params ?? {};
          const respond = (result) => send({ id: m.id, result });
          const fail = (message, code = -32600) => send({ id: m.id, error: { code, message } });
          const thread = threads.find((t) => t.id === p.threadId);
          switch (m.method) {
            case 'initialize':
              if (!fixture.hangInitialize) setTimeout(() => respond({ userAgent: 'fake-codex', codexHome: '/fake/.codex', platformFamily: 'unix', platformOs: 'linux' }), fixture.initializeDelayMs ?? 0);
              return;
            case 'initialized':
              if (fixture.reverseApproval) send({ id: 'daemon-approval', method: 'item/commandExecution/requestApproval', params: { threadId: threads[0]?.id, turnId: 'turn-1', itemId: 'approval-1', command: 'do not answer' } });
              if (fixture.exitAfterInitializedMs !== undefined) setTimeout(() => process.exit(0), fixture.exitAfterInitializedMs);
              if (fixture.disconnectAfterInitializedMs !== undefined) setTimeout(() => {
                // stdout.end() alone does not close a Windows stdio pipe; a peer Close is observable.
                socket.end(frame(Buffer.from([0x03, 0xe8]), 8));
              }, fixture.disconnectAfterInitializedMs);
              return;
            case 'thread/list': {
              const data = threads.filter((t) => !p.searchTerm || t.name?.includes(p.searchTerm) || t.id === p.searchTerm).map(({ turns, ...t }) => t);
              return respond({ data, nextCursor: null });
            }
            case 'thread/loaded/list': return respond({ data: loadedIds, nextCursor: null });
            case 'thread/read': {
              if (!thread) return fail(`thread not found: ${p.threadId}`);
              const { turns, ...summary } = thread;
              return respond({ thread: { ...summary, ...(p.includeTurns ? { turns: turns ?? [] } : {}) } });
            }
            case 'turn/steer': {
              if (fixture.dropSteerResponse) return;
              const finishSteer = () => {
                const steerError = thread?.steerError ?? fixture.steerError;
                if (steerError) return fail(steerError.message, steerError.code);
                if (!thread || !loadedIds.includes(p.threadId)) return fail(`thread not loaded: ${p.threadId}`);
                const active = thread.turns?.find((t) => t.status === 'inProgress');
                if (!active) return fail('no active turn to steer');
                if (active.id !== p.expectedTurnId) return fail(`expected active turn id \`${p.expectedTurnId}\` but found \`${active.id}\``);
                return respond({ turnId: active.id });
              };
              if (fixture.steerReleaseFile && !fs.existsSync(fixture.steerReleaseFile)) {
                const held = setInterval(() => {
                  if (!fs.existsSync(fixture.steerReleaseFile)) return;
                  clearInterval(held);
                  finishSteer();
                }, 10);
                return;
              }
              return finishSteer();
            }
            case 'thread/queue/add':
              return respond({ queuedSubmission: { id: 'queue-1', clientUserMessageId: p.clientUserMessageId, input: p.input } });
            default: return fail(`unsupported method: ${m.method}`, -32601);
          }
        };
        const receive = (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= 2) {
            const first = buffer[0], second = buffer[1];
            const opcode = first & 15;
            let length = second & 127, offset = 2;
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2); offset = 4;
            } else if (length === 127) {
              if (buffer.length < 10) return;
              const size = buffer.readBigUInt64BE(2);
              if (size > BigInt(Number.MAX_SAFE_INTEGER)) return socket.destroy();
              length = Number(size); offset = 10;
            }
            if (!(second & 128)) return socket.destroy();
            if (buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            offset += 4;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            buffer = buffer.subarray(offset + length);
            if (opcode === 8) { socket.end(frame(payload, 8)); return; }
            if (opcode === 9) { socket.write(frame(payload, 10)); continue; }
            if (opcode === 10) continue;
            if (opcode !== 1 && opcode !== 0) return socket.destroy();
            fragments.push(payload);
            if (!(first & 128)) continue;
            const text = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            try { command(JSON.parse(text)); } catch { socket.destroy(); return; }
          }
        };
        socket.on('data', receive);
        if (head.length) receive(head);
      };
      socket.on('error', () => {});
      if (fixture.upgradeDelayMs) setTimeout(upgrade, fixture.upgradeDelayMs);
      else upgrade();
    });
    // app-server proxy speaks the WebSocket HTTP upgrade over its stdio pipes.
    const { Duplex } = require('node:stream');
    const socket = new Duplex({
      read() { process.stdin.resume(); },
      write(chunk, encoding, callback) { process.stdout.write(chunk, encoding, callback); },
      final(callback) { process.stdout.end(callback); },
    });
    socket.setTimeout = socket.setNoDelay = socket.setKeepAlive = () => socket;
    process.stdin.on('data', (chunk) => { if (!socket.push(chunk)) process.stdin.pause(); });
    process.stdin.on('end', () => socket.push(null));
    process.stdin.on('error', (error) => socket.destroy(error));
    server.emit('connection', socket);
    return;
  }
  // A headless omp (--mode rpc), Claude (--input-format stream-json) or Codex
  // worker is a channel: it reads commands a line at a time for as long as
  // stdin is open. A Codex worker is its own `codex app-server`, told apart
  // from the shared client's by PEER_DEPTH=1, which only runHeadless sets.
  const codexWorker = name === 'codex' && args[0] === 'app-server' && process.env.PEER_DEPTH === '1';
  const channel = (name === 'omp' && args[0] === '--mode' && args[1] === 'rpc') || (name === 'claude' && args.includes('--input-format')) || codexWorker;

  // An app-server is a long-lived JSON-RPC peer whose stdin never reaches EOF;
  // slurping it here would block forever before a single request is answered.
  let stdin = '';
  if (args[0] !== 'app-server' && !channel) {
    try {
      stdin = fs.readFileSync(0, 'utf-8');
    } catch {
      stdin = '';
    }
  }

  // `omp config get modelRoles`, which Magi asks to choose an advisor model:
  // the record as one line of JSON, from FAKE_OMP_ROLES. Any other config
  // query keeps the answer it always had (the reply below, which is not config).
  if (name === 'omp' && args[0] === 'config' && args[1] === 'get' && args[2] === 'modelRoles') {
    process.stdout.write((process.env.FAKE_OMP_ROLES ?? '{}') + '\n');
    process.exit(0);
  }
  if (name === 'omp' && args[0] === 'config' && args[1] === 'get' && args[2] === 'disabledExtensions') {
    if (process.env.FAKE_OMP_CONFIG_ERROR) {
      process.stderr.write(process.env.FAKE_OMP_CONFIG_ERROR + '\n');
      process.exit(1);
    }
    process.stdout.write((process.env.FAKE_OMP_DISABLED_EXTENSIONS ?? '[]') + '\n');
    process.exit(0);
  }

  const record = {
    name,
    args,
    cwd: process.cwd(),
    stdin,
    pid: process.pid,
    env: {
      PEER_DEPTH: process.env.PEER_DEPTH ?? null,
      PEER_ROLE: process.env.PEER_ROLE ?? null,
    },
    at: Date.now(),
  };
  // A --config overlay is a temp file the run deletes, so its text is read now.
  const configAt = args.indexOf('--config');
  if (configAt >= 0) {
    try { record.configFile = args[configAt + 1]; record.configText = fs.readFileSync(args[configAt + 1], 'utf-8'); } catch { /* unreadable: the test says so */ }
  }
  const log = (entry) => {
    if (!process.env.FAKE_CLI_LOG) return;
    try {
      fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify(entry) + '\n');
    } catch {
      /* logging is best effort */
    }
  };
  // A channel logs its call when the request arrives, so `stdin` is the prompt.
  if (!channel) log(record);

  const emit = (s) => process.stdout.write(s);
  const codexMsg = (text) =>
    JSON.stringify({ type: 'thread.started', thread_id: 'th-fake' }) +
    '\n' +
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) +
    '\n';
  const claudeMsg = (text) => JSON.stringify({ result: text, session_id: 'sess-fake' });
  // omp --mode json: a session header line, then one event per line.
  const ompMsg = (text) =>
    [
      JSON.stringify({ type: 'session', version: 3, id: 'omp-sess-fake', timestamp: new Date().toISOString(), cwd: process.cwd() }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } }),
      '',
    ].join(String.fromCharCode(10));
  const msg = (text) => (name === 'codex' ? codexMsg(text) : name === 'omp' ? ompMsg(text) : claudeMsg(text));

  const REPLY = [
    'SUMMARY',
    'Fake peer reply.',
    '',
    'FINDINGS',
    '- possible off-by-one at src/x.mjs:12, medium, evidence: loop bound, confidence: medium',
    '',
    'DISAGREEMENTS',
    '- none',
    '',
    'UNKNOWN / UNVERIFIED',
    '- runtime behaviour not executed',
    '',
    'RECOMMENDATION',
    'Add a bounds test.',
    '',
    'TESTS / VERIFICATION',
    '- add test for the empty case',
  ].join('\n');

  // The channel conversation. FAKE_CLI_HOLD_FOR_NOTES keeps the request's turn
  // open until that many notes have arrived (each logged as {note}), and
  // FAKE_CLI_EXIT_DELAY_MS delays exit after stdin closes, which is the
  // window in which a run is finishing.
  const channelPeer = () => {
    // A delegated worker's edit, made in the directory it was started in.
    if (process.env.FAKE_CLI_WRITE_FILE) fs.writeFileSync(require('node:path').join(process.cwd(), process.env.FAKE_CLI_WRITE_FILE), 'written by the fake worker\n');
    const hold = Number(process.env.FAKE_CLI_HOLD_FOR_NOTES ?? 0);
    const exitDelay = Number(process.env.FAKE_CLI_EXIT_DELAY_MS ?? 0);
    const hangs = scenario === 'hang' || scenario === 'tree-hang';
    const reply = scenario === 'huge' ? 'x'.repeat(200000) : REPLY;
    const out = (frame) => emit(JSON.stringify(frame) + '\n');
    const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join('\n'));
    if (scenario === 'tree-hang') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
    }
    if (hangs) setInterval(() => {}, 1000);
    let requested = false;
    let turn = null; // { ids } while a turn runs
    let heard = 0;

    const omp = {
      begin(ids, text) {
        turn = { ids };
        out({ type: 'agent_start' });
        out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
      },
      complete(text) {
        // omp's advisor, once, as the real one sends it: a custom message in
        // the worker's own stream, with the note XML-escaped in an <advisory>.
        if (process.env.FAKE_CLI_ADVISOR_NOTE && !omp.advised) {
          omp.advised = true;
          const escaped = process.env.FAKE_CLI_ADVISOR_NOTE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          out({ type: 'message_end', message: { role: 'custom', customType: 'advisor', display: true, content: `<advisory severity="${process.env.FAKE_CLI_ADVISOR_SEVERITY || 'concern'}" guidance="weigh, don't blindly obey">\n${escaped}\n</advisory>` } });
        }
        out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
        out({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
        for (const id of turn.ids) out({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
        out({ type: 'session_settled' });
        turn = null;
      },
      command(cmd) {
        const ok = (data) => out({ id: cmd.id, type: 'response', command: cmd.type, success: true, ...(data ? { data } : {}) });
        if (cmd.type === 'negotiate_protocol') ok({ protocolVersion: 2 });
        else if (cmd.type === 'set_event_filter') ok({ events: cmd.events, messageUpdates: 'full' });
        else if (cmd.type === 'get_state') {
          // The model omp says the worker runs, as `provider/id`, when a test sets one.
          const [provider, ...id] = (process.env.FAKE_OMP_WORKER_MODEL ?? '').split('/');
          ok({ sessionId: 'omp-sess-fake', isStreaming: Boolean(turn), ...(id.length ? { model: { provider, id: id.join('/') } } : {}) });
        }
        else if (cmd.type === 'prompt' && !requested) {
          requested = true;
          log({ ...record, stdin: cmd.message, at: Date.now() });
          ok();
          omp.begin([cmd.id], cmd.message);
          settle();
        } else if (cmd.type === 'prompt') {
          log({ name, pid: process.pid, note: cmd.message, streamingBehavior: cmd.streamingBehavior ?? null, at: Date.now() });
          ok();
          if (turn) {
            turn.ids.push(cmd.id);
            out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: cmd.message }] } });
            heard++;
            settle();
          } else {
            omp.begin([cmd.id], cmd.message);
            omp.complete('Noted.');
          }
        } else out({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: `Unknown command: ${cmd.type}` });
      },
    };

    const claude = {
      complete(text) {
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 'sess-fake' });
        out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-fake', user_message_uuids: turn.ids });
        turn = null;
      },
      command(msg) {
        if (msg.type !== 'user') return;
        const text = textOf(msg.message?.content);
        if (!requested) {
          requested = true;
          log({ ...record, stdin: text, at: Date.now() });
          out({ type: 'system', subtype: 'init', session_id: 'sess-fake', tools: ['Read'] });
          out({ type: 'user', message: msg.message, uuid: msg.uuid, session_id: 'sess-fake', isReplay: true });
          turn = { ids: [msg.uuid] };
          settle();
          return;
        }
        log({ name, pid: process.pid, note: text, priority: msg.priority ?? null, at: Date.now() });
        out({ type: 'user', message: msg.message, uuid: msg.uuid, session_id: 'sess-fake', isReplay: true });
        if (turn) {
          turn.ids.push(msg.uuid);
          heard++;
          settle();
        } else {
          turn = { ids: [msg.uuid] };
          claude.complete('Noted.');
        }
      },
    };

    const peer = name === 'omp' ? omp : claude;
    function settle() {
      if (hangs || !turn || heard < hold) return;
      peer.complete(reply);
    }
    if (name === 'omp') out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      peer.command(msg);
    });
    lines.on('close', () => {
      if (hangs) return;
      setTimeout(() => { process.exitCode = scenario === 'failed-with-output' ? 1 : 0; }, exitDelay);
    });
  };

  // The Codex worker's app-server conversation, as docs/transport-recon.md
  // section 4 writes it down. Each turn first asks the client to approve a
  // command and goes on only once that is declined (granting it fails the
  // turn), so every run proves the decline. A steer is answered and echoed by
  // nothing else, which is all the 2026-10-08 live probe on codex-cli 0.160.1
  // showed the bridge (no userMessage item it could match), so the note's
  // receipt rests on its turn completing. FAKE_CLI_HOLD_FOR_NOTES holds the
  // turn until that many steers have arrived (each logged as {note}), and
  // FAKE_CLI_EXIT_DELAY_MS delays the thread/unsubscribe answer, which is the
  // window in which a run is finishing.
  const codexWorkerPeer = () => {
    const hold = Number(process.env.FAKE_CLI_HOLD_FOR_NOTES ?? 0);
    const exitDelay = Number(process.env.FAKE_CLI_EXIT_DELAY_MS ?? 0);
    const hangs = scenario === 'hang' || scenario === 'tree-hang';
    const reply = scenario === 'huge' ? 'x'.repeat(200000) : REPLY;
    const out = (frame) => emit(JSON.stringify(frame) + '\n');
    const textOf = (input) => (input ?? []).map((c) => c.text ?? '').join('\n');
    if (scenario === 'tree-hang') {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
    }
    if (hangs) setInterval(() => {}, 1000);
    let threadId = 'th-fake'; // a resume reports on the thread it resumed
    let opened = null; // { method, params } of thread/start or thread/resume
    let turn = null; // { id, declined } while a turn runs
    let heard = 0;
    let items = 0;
    const event = (method, params) => out({ method, params: { threadId, ...params } });
    const item = (turnId, body) => {
      const it = { id: `item-${++items}`, ...body };
      event('item/started', { turnId, item: it });
      event('item/completed', { turnId, item: it });
    };
    const usage = (total, last) => event('thread/tokenUsage/updated', { turnId: turn.id, tokenUsage: { total, last, modelContextWindow: 272000 } });
    const end = (status, error) => {
      event('turn/completed', { turn: { id: turn.id, status, items: [], error: error ? { message: error } : null } });
      turn = null;
    };
    const settle = () => {
      if (hangs || !turn || turn.declined === null || heard < hold) return;
      if (!turn.declined) return end('failed', 'the client approved a command nobody was there to judge');
      if (scenario === 'turn-failed') return end('failed', 'deliberate turn failure');
      if (scenario === 'failed-with-output') {
        item(turn.id, { type: 'agentMessage', text: 'Partial output before failure.', phase: 'commentary' });
        return end('failed', 'deliberate failure after partial output');
      }
      item(turn.id, { type: 'agentMessage', text: 'Looking at the change.', phase: 'commentary' });
      usage({ inputTokens: 1000, cachedInputTokens: 600, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 1010 }, { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 1010 });
      item(turn.id, { type: 'agentMessage', text: reply, phase: 'final_answer' });
      usage({ inputTokens: 2500, cachedInputTokens: 1600, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 2530 }, { inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 1520 });
      end('completed');
    };
    const command = (m) => {
      const respond = (result) => out({ id: m.id, result });
      if (m.method === undefined) {
        // The client's answer to the approval request.
        if (turn && m.id === `approval-${turn.id}`) {
          turn.declined = Boolean(m.error) && !m.result;
          settle();
        }
        return;
      }
      switch (m.method) {
        case 'initialize': return respond({ userAgent: 'fake-codex/0.160.1' });
        case 'initialized': return undefined;
        case 'thread/start':
          opened = { method: m.method, params: m.params };
          return respond({ thread: { id: threadId, cwd: m.params?.cwd ?? process.cwd() } });
        case 'thread/resume':
          opened = { method: m.method, params: m.params };
          threadId = m.params?.threadId ?? threadId;
          return respond({ thread: { id: threadId, cwd: m.params?.cwd ?? process.cwd() } });
        case 'turn/start': {
          const { input, ...rest } = m.params ?? {};
          log({ ...record, stdin: textOf(input), opened, turn: rest, at: Date.now() });
          turn = { id: 'turn-1', declined: null };
          respond({ turn: { id: turn.id, status: 'inProgress', items: [] } });
          event('turn/started', { turn: { id: turn.id, status: 'inProgress', items: [] } });
          item(turn.id, { type: 'userMessage', content: input, clientId: rest.clientUserMessageId });
          out({ id: `approval-${turn.id}`, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn.id, itemId: 'cmd-1', command: 'git push --force', cwd: process.cwd() } });
          return undefined;
        }
        case 'turn/steer': {
          const p = m.params ?? {};
          log({ name, pid: process.pid, note: textOf(p.input), expectedTurnId: p.expectedTurnId ?? null, clientUserMessageId: p.clientUserMessageId ?? null, at: Date.now() });
          if (!turn || p.expectedTurnId !== turn.id) return out({ id: m.id, error: { code: -32600, message: 'no active turn to steer' } });
          respond({ turnId: turn.id });
          heard++;
          return settle();
        }
        case 'thread/unsubscribe':
          return setTimeout(() => respond({ status: 'unsubscribed' }), exitDelay);
        default:
          return m.id === undefined ? undefined : respond({});
      }
    };
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let m;
      try { m = JSON.parse(line); } catch { return; }
      command(m);
    });
    lines.on('close', () => {
      if (hangs) return;
      process.exitCode = 0;
    });
  };

  if (codexWorker && ['ok', 'hang', 'tree-hang', 'failed-with-output', 'turn-failed', 'huge'].includes(scenario)) codexWorkerPeer();
  else if (channel && !codexWorker && ['ok', 'hang', 'tree-hang', 'failed-with-output', 'huge'].includes(scenario)) channelPeer();
  else switch (scenario) {
    case 'auth':
      process.stderr.write('Error: Not logged in. Run login first.\n');
      process.exit(1);
      break;
    case 'hang':
      setTimeout(() => process.exit(0), 120000);
      break;
    case 'tree-hang': {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
      setInterval(() => {}, 1000);
      break;
    }
    case 'utf8-chunks': {
      const parts = [Buffer.from([0xe2]), Buffer.from([0x82]), Buffer.from([0xac])];
      let at = 0;
      const timer = setInterval(() => {
        process.stdout.write(parts[at]);
        process.stderr.write(parts[at]);
        if (++at === parts.length) clearInterval(timer);
      }, 25);
      break;
    }
    case 'garbage':
      emit('this is not json at all\n{"type":"item.completed"\n');
      process.exit(0);
      break;
    case 'empty':
      process.exit(0);
      break;
    case 'failed-with-output':
      emit(msg('Partial output before failure.'));
      process.stderr.write('deliberate failure after partial output');
      process.exitCode = 1;
      break;
    case 'turn-failed':
      emit(JSON.stringify({ type: 'turn.failed', error: { message: 'deliberate turn failure' } }) + '\n');
      break;
    case 'queue-ok':
      emit('Queued message msg-audit for thread task-audit.\n');
      break;
    case 'queue-root-fallback': {
      const thread = args[args.indexOf('--thread') + 1];
      if (thread === 'child') {
        process.stderr.write('Error: No active session found matching child.\n');
        process.exitCode = 1;
      } else {
        emit(`Queued message root-receipt for thread ${thread}.\n`);
      }
      break;
    }
    case 'queue-partial-failure':
      emit('partial queue output\n');
      process.stderr.write('queue failed after writing stdout');
      process.exitCode = 1;
      break;
    case 'huge': {
      const big = 'x'.repeat(200000);
      emit(msg(big));
      process.exit(0);
      break;
    }
    case 'flood': {
      // Exceeds the stdout cap; must be stopped rather than buffered forever.
      const chunk = 'y'.repeat(1024 * 1024);
      for (let i = 0; i < 64; i++) emit(chunk);
      // Exit once it is all written: on Linux a pipe write is asynchronous, and
      // exiting at once cut the flood short of the cap, so the bridge saw a
      // short junk line (PROTOCOL_ERROR) instead (seen on devbox, Node 22).
      process.stdout.write('', () => process.exit(0));
      break;
    }
    case 'queue-missing':
      process.stderr.write("Error: No active session found matching 'whatever'.\n");
      process.exit(1);
      break;
    case 'appserver':
      if (name === 'codex' && args[0] === 'queue') {
        emit(`Queued message msg-request for thread ${args[args.indexOf('--thread') + 1]}.\n`);
        break;
      }
      // Optional saved-thread metadata keeps selector tests distinct from daemon liveness.
      const savedThreads = process.env.FAKE_CODEX_THREADS ? JSON.parse(process.env.FAKE_CODEX_THREADS) : null;
      // Minimal app-server: answer initialize and thread/list.
      process.stdin.on('data', (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          // One log line per request, so a test can count round trips and not
          // only process spawns.
          if (process.env.FAKE_CLI_LOG && m.method) {
            try {
              fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ name, rpc: m.method, at: Date.now() }) + '\n');
            } catch {
              /* best effort */
            }
          }
          if (m.method === 'initialize') emit(JSON.stringify({ id: m.id, result: { ok: true } }) + '\n');
          else if (m.method === 'thread/read') {
            const thread = savedThreads ? savedThreads.find((t) => t.id === m.params?.threadId) : { id: 'th-1', name: 'peer-thread', cwd: process.cwd(), path: 'fake-rollout.jsonl' };
            emit(JSON.stringify(thread ? { id: m.id, result: { thread: { ...thread, path: thread.path ?? 'fake-rollout.jsonl' } } } : { id: m.id, error: { code: -32600, message: 'thread not found' } }) + '\n');
          } else if (m.method === 'thread/list') {
            emit(
              JSON.stringify({
                id: m.id,
                result: { data: savedThreads ?? [{ id: 'th-1', name: 'peer-thread', cwd: process.cwd(), status: { type: 'idle' }, canAcceptDirectInput: true }] },
              }) + '\n',
            );
          } else if (m.method === 'thread/queue/add') {
            emit(JSON.stringify({ id: m.id, result: { queuedSubmission: { id: 'queue-explicit-note', clientUserMessageId: m.params.clientUserMessageId, input: m.params.input } } }) + '\n');
          } else if (m.id !== undefined) emit(JSON.stringify({ id: m.id, result: {} }) + '\n');
        }
      });
      break;
    case 'ok':
    default:
      emit(msg(REPLY));
      process.exit(0);
  }
}
