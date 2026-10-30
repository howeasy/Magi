// A WebSocket client (RFC 6455) over any duplex byte stream: here the stdio
// of `codex app-server proxy`, whose control socket speaks app-server
// JSON-RPC over WebSocket (docs/evidence/codex-app-server-r2-2026-10-17.md).
// Node's own WebSocket cannot take a stream, and a forwarded TCP port would
// open a listener, so this frames by hand: masked client frames, unmasked
// server frames refused if masked, text messages only, Ping answered,
// fragments reassembled, sizes bounded, the handshake timed out. No
// dependency. Written by an omp peer and checked here.
import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HEADER_BYTES = 16 * 1024;
const DEFAULT_MESSAGE_BYTES = 64 * 1024 * 1024;

class WebSocketError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'WebSocketError';
    this.code = code;
  }
}

const error = (code, message) => new WebSocketError(code, message);
const protocolError = (message) => error('WS_PROTOCOL_ERROR', `${message} Check the peer's RFC 6455 implementation before reconnecting.`);
const validCloseCode = (code) => Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));

function frame(opcode, payload) {
  const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
  const header = 2 + extended + 4;
  const bytes = Buffer.allocUnsafe(header + payload.length);
  bytes[0] = 0x80 | opcode;
  bytes[1] = 0x80 | (extended === 8 ? 127 : extended === 2 ? 126 : payload.length);
  if (extended === 2) bytes.writeUInt16BE(payload.length, 2);
  if (extended === 8) bytes.writeBigUInt64BE(BigInt(payload.length), 2);
  const mask = randomBytes(4);
  mask.copy(bytes, 2 + extended);
  for (let index = 0; index < payload.length; index++) bytes[header + index] = payload[index] ^ mask[index % 4];
  return bytes;
}

// Streams belong to this connection after opening; termination closes them.
// send() resolves on the writable callback, not on peer receipt. Subscribe before sending.
export function openWebSocket({ readable, writable, path = '/rpc', host = 'localhost', timeoutMs = 30_000, maxMessageBytes = DEFAULT_MESSAGE_BYTES } = {}) {
  if (!readable?.on || !readable?.destroy || !writable?.write || !writable?.end || !writable?.destroy) {
    return Promise.reject(error('WS_BAD_OPTIONS', 'Provide Node readable and writable streams.'));
  }
  if (typeof path !== 'string' || !path.startsWith('/') || /[^\x21-\x7e]|#/.test(path) || typeof host !== 'string' || !host || /[^\x21-\x7e]/.test(host)) {
    return Promise.reject(error('WS_BAD_OPTIONS', 'Provide an origin-form path and a Host without whitespace or control characters.'));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
    return Promise.reject(error('WS_BAD_OPTIONS', 'Provide a positive handshake timeout and a positive safe-integer maxMessageBytes.'));
  }
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    const http = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const header = Buffer.allocUnsafe(10);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const messageListeners = new Set();
    const closeListeners = new Set();
    const pendingMessages = [];
    let pendingBytes = 0;
    let httpUsed = 0;
    let upgraded = false;
    let ended = null;
    let headerUsed = 0;
    let headerNeeded = 2;
    let payload = null;
    let payloadLength = 0;
    let payloadUsed = 0;
    let opcode = 0;
    let final = false;
    let messageOpcode = null;
    let messageBytes = 0;
    let parts = [];
    let writes = Promise.resolve();
    let rejectWrite = null;
    let draining = false;
    let chunks = [];
    let chunkIndex = 0;
    const timer = setTimeout(() => finish(error('WS_HANDSHAKE_TIMEOUT', `No valid upgrade arrived within ${timeoutMs} ms. Check ssh and the proxy, then reconnect.`)), timeoutMs);

    function finish(reason, closePayload) {
      if (ended) return;
      ended = reason;
      clearTimeout(timer);
      rejectWrite?.(reason);
      rejectWrite = null;
      if (!upgraded) reject(reason);
      readable.off('data', onData);
      readable.off('end', onEnd);
      readable.off('close', onReadClose);
      writable.off('finish', onWriteEnd);
      writable.off('close', onWriteClose);
      chunks = [];
      parts = [];
      payload = null;
      for (const listener of closeListeners) queueMicrotask(() => listener(reason));
      closeListeners.clear();
      messageListeners.clear();
      // A pending write can emit error after its callback; retain the guard until close.
      for (const stream of new Set([readable, writable])) {
        if (stream.closed) stream.off('error', onError);
        else stream.once('close', () => stream.off('error', onError));
      }
      if (closePayload !== undefined && !writable.destroyed && !writable.writableEnded) {
        const deadline = setTimeout(() => writable.destroy(), 1000);
        deadline.unref();
        writable.once('close', () => clearTimeout(deadline));
        try { writable.end(frame(8, closePayload), () => writable.destroy()); }
        catch { writable.destroy(); }
        if (readable !== writable) readable.destroy();
      } else {
        readable.destroy();
        if (readable !== writable) writable.destroy();
      }
    }

    function decode(bytes) {
      try { return decoder.decode(bytes); }
      catch { throw protocolError('A text or close payload is not valid UTF-8.'); }
    }

    function emitMessage(text, bytes) {
      if (!messageListeners.size) {
        // The upgrade response can carry messages before await openWebSocket() resumes.
        if (pendingBytes + bytes > maxMessageBytes || pendingMessages.length >= 1024) {
          throw error('WS_BACKLOG_LIMIT', 'Messages arrived without a reader. Register onMessage immediately when opening.');
        }
        pendingMessages.push(text);
        pendingBytes += bytes;
      } else {
        for (const listener of messageListeners) listener(text);
      }
    }

    function completeFrame() {
      const bytes = payload;
      headerUsed = 0;
      headerNeeded = 2;
      payload = null;
      if (opcode === 8) {
        if (bytes.length === 1) throw protocolError('A Close payload contains only half a status code.');
        const closeCode = bytes.length ? bytes.readUInt16BE(0) : 1005;
        if (bytes.length && !validCloseCode(closeCode)) throw protocolError('The server sent an invalid Close status code.');
        const closeReason = decode(bytes.subarray(2));
        const reason = error('WS_CLOSED', `The peer closed the WebSocket (${closeCode}${closeReason ? `: ${closeReason}` : ''}). Reconnect if more traffic is needed.`);
        Object.assign(reason, { closeCode, closeReason });
        finish(reason, bytes);
      } else if (opcode === 9) {
        writeFrame(10, bytes).catch(() => {});
      } else if (opcode < 8) {
        if (messageOpcode === 1 && bytes.length) parts.push(bytes);
        if (final) {
          const textParts = parts;
          const size = messageBytes;
          const isText = messageOpcode === 1;
          parts = [];
          messageBytes = 0;
          messageOpcode = null;
          if (isText) emitMessage(decode(textParts.length === 1 ? textParts[0] : Buffer.concat(textParts, size)), size);
        }
      }
    }

    function startPayload() {
      const marker = header[1] & 127;
      let length = marker;
      if (marker === 126) {
        length = header.readUInt16BE(2);
        if (length < 126) throw protocolError('A frame uses a non-minimal 16-bit length.');
      } else if (marker === 127) {
        const wide = header.readBigUInt64BE(2);
        if (wide >> 63n || wide < 65536n) throw protocolError('A frame has an invalid 64-bit length.');
        if (wide > BigInt(maxMessageBytes)) throw error('WS_MESSAGE_TOO_LARGE', `A frame exceeds ${maxMessageBytes} bytes. Request less data or raise maxMessageBytes before reconnecting.`);
        length = Number(wide);
      }
      if (opcode < 8) {
        if (opcode === 0) {
          if (messageOpcode === null) throw protocolError('A continuation arrived without an unfinished message.');
        } else {
          if (messageOpcode !== null) throw protocolError('A new data message interrupted a fragmented message.');
          messageOpcode = opcode;
        }
        if (length > maxMessageBytes - messageBytes) throw error('WS_MESSAGE_TOO_LARGE', `A message exceeds ${maxMessageBytes} bytes. Request less data or raise maxMessageBytes before reconnecting.`);
        messageBytes += length;
      }
      payloadLength = length;
      payloadUsed = 0;
      // Binary messages are counted for limits but never buffered or delivered.
      payload = opcode < 8 && messageOpcode === 2 ? null : Buffer.allocUnsafe(length);
    }

    function frames(chunk) {
      let offset = 0;
      while (!ended && offset < chunk.length) {
        if (headerUsed < headerNeeded) {
          const take = Math.min(headerNeeded - headerUsed, chunk.length - offset);
          chunk.copy(header, headerUsed, offset, offset + take);
          headerUsed += take;
          offset += take;
          if (headerUsed < headerNeeded) continue;
          if (headerNeeded === 2) {
            final = Boolean(header[0] & 128);
            opcode = header[0] & 15;
            const marker = header[1] & 127;
            if (header[0] & 112 || header[1] & 128 || ![0, 1, 2, 8, 9, 10].includes(opcode)) throw protocolError('A server frame has reserved bits, a mask, or an unsupported opcode.');
            if (opcode >= 8 && (!final || marker > 125)) throw protocolError('A control frame is fragmented or exceeds 125 bytes.');
            headerNeeded = 2 + (marker === 126 ? 2 : marker === 127 ? 8 : 0);
            if (headerUsed < headerNeeded) continue;
          }
          startPayload();
          if (!payloadLength) { completeFrame(); continue; }
        }
        const take = Math.min(payloadLength - payloadUsed, chunk.length - offset);
        if (payload) chunk.copy(payload, payloadUsed, offset, offset + take);
        offset += take;
        payloadUsed += take;
        if (payloadUsed === payloadLength) completeFrame();
      }
    }

    function handshake(chunk) {
      const take = Math.min(chunk.length, MAX_HEADER_BYTES - httpUsed);
      const searchFrom = Math.max(0, httpUsed - 3);
      chunk.copy(http, httpUsed, 0, take);
      httpUsed += take;
      const end = http.indexOf('\r\n\r\n', searchFrom);
      if (end < 0 || end + 4 > httpUsed) {
        if (httpUsed === MAX_HEADER_BYTES) throw error('WS_BAD_HANDSHAKE', 'The upgrade headers exceed 16 KiB. Check that the stream is a WebSocket proxy.');
        return;
      }
      const lines = http.subarray(0, end).toString('latin1').split('\r\n');
      if (!/^HTTP\/1\.1 101(?: |$)/.test(lines.shift())) throw error('WS_BAD_HANDSHAKE', 'The peer did not return HTTP 101. Check the proxy endpoint before reconnecting.');
      const fields = new Map();
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~0-9a-z-]+):[\t ]*([^\r\n]*)$/i.exec(line);
        if (!match) throw error('WS_BAD_HANDSHAKE', 'The response contains a malformed HTTP header. Check the proxy endpoint.');
        const name = match[1].toLowerCase();
        if (name === 'sec-websocket-accept' && fields.has(name)) throw error('WS_BAD_HANDSHAKE', 'The upgrade repeats its accept key. Check the peer before reconnecting.');
        fields.set(name, fields.has(name) ? `${fields.get(name)}, ${match[2].trim()}` : match[2].trim());
      }
      if (fields.get('upgrade')?.toLowerCase() !== 'websocket' || !fields.get('connection')?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || fields.get('sec-websocket-accept') !== accept || fields.has('sec-websocket-extensions') || fields.has('sec-websocket-protocol')) {
        throw error('WS_BAD_HANDSHAKE', 'The upgrade headers or accept key are invalid, or an unrequested extension was selected. Check the proxy before reconnecting.');
      }
      upgraded = true;
      clearTimeout(timer);
      resolve(client);
      frames(http.subarray(end + 4, httpUsed));
      if (!ended && take < chunk.length) frames(chunk.subarray(take));
    }

    function onData(chunk) {
      if (ended) return;
      if (!(chunk instanceof Uint8Array)) { finish(protocolError('The readable is not a byte stream.')); return; }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if (draining) return;
      draining = true;
      try {
        while (!ended && chunkIndex < chunks.length) {
          const next = chunks[chunkIndex++];
          if (upgraded) frames(next); else handshake(next);
        }
      } catch (cause) {
        if (!(cause instanceof WebSocketError)) throw cause;
        finish(cause);
      } finally {
        chunks = [];
        chunkIndex = 0;
        draining = false;
      }
    }

    function writeFrame(type, bytes) {
      const operation = writes.then(() => {
        if (ended) throw ended;
        return new Promise((done, failed) => {
          rejectWrite = failed;
          try {
            writable.write(frame(type, bytes), (cause) => {
              rejectWrite = null;
              if (cause) { const reason = error('WS_IO', `Writing the WebSocket failed: ${cause.message}. Check the stream and reconnect; do not blindly resend.`); finish(reason); failed(reason); }
              else done();
            });
          } catch (cause) {
            rejectWrite = null;
            const reason = error('WS_IO', `Writing the WebSocket failed: ${cause.message}. Check the stream and reconnect; do not blindly resend.`);
            finish(reason);
            failed(reason);
          }
        });
      });
      writes = operation.catch(() => {});
      return operation;
    }

    const onError = (cause) => finish(error('WS_IO', `The byte stream failed: ${cause.message}. Check ssh and reconnect; do not blindly resend.`));
    const onEnd = () => finish(error('WS_EOF', 'The peer ended the byte stream. Reconnect; treat outstanding sends as unconfirmed.'));
    const onReadClose = () => finish(error('WS_EOF', 'The readable stream closed. Reconnect; treat outstanding sends as unconfirmed.'));
    const onWriteEnd = () => finish(error('WS_EOF', 'The writable stream ended. Reconnect before sending more messages.'));
    const onWriteClose = () => finish(error('WS_EOF', 'The writable stream closed. Reconnect before sending more messages.'));
    const client = {
      send(text) {
        if (ended) return Promise.reject(ended);
        if (typeof text !== 'string') return Promise.reject(error('WS_BAD_MESSAGE', 'send(text) requires a string. Serialize the message before sending.'));
        return writeFrame(1, Buffer.from(text, 'utf8'));
      },
      close(code = 1000, reason = '') {
        if (ended) return;
        if (!validCloseCode(code) || typeof reason !== 'string' || Buffer.byteLength(reason) > 123) throw error('WS_BAD_CLOSE', 'Provide an RFC 6455 close code and a UTF-8 reason of at most 123 bytes.');
        const bytes = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
        bytes.writeUInt16BE(code);
        bytes.write(reason, 2, 'utf8');
        const closed = error('WS_CLOSED', 'The client closed the WebSocket. Open a new connection before sending.');
        Object.assign(closed, { closeCode: code, closeReason: reason });
        finish(closed, bytes);
      },
      onMessage(listener) {
        if (typeof listener !== 'function') throw error('WS_BAD_LISTENER', 'Provide an onMessage function.');
        if (!ended) messageListeners.add(listener);
        // Complete messages received before Close still belong to the reader.
        const waiting = pendingMessages.splice(0);
        pendingBytes = 0;
        for (const text of waiting) listener(text);
        return () => messageListeners.delete(listener);
      },
      onClose(listener) {
        if (typeof listener !== 'function') throw error('WS_BAD_LISTENER', 'Provide an onClose function.');
        if (ended) queueMicrotask(() => listener(ended));
        else closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
    };
    readable.on('error', onError);
    if (readable !== writable) writable.on('error', onError);
    readable.on('end', onEnd);
    readable.on('close', onReadClose);
    writable.on('finish', onWriteEnd);
    writable.on('close', onWriteClose);
    readable.on('data', onData);
    if (readable.destroyed || readable.readableEnded || writable.destroyed || writable.writableEnded) { onEnd(); return; }
    try {
      writable.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`, (cause) => { if (cause) onError(cause); });
    } catch (cause) { onError(cause); }
  });
}
