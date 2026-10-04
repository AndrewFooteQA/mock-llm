/**
 * Encoder for the AWS `application/vnd.amazon.eventstream` binary framing used
 * by Bedrock streaming APIs:
 *
 *   [total len u32][headers len u32][prelude crc32][headers][payload][message crc32]
 *
 * Only string-valued headers (type 7) are needed.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeMessage(headers: Record<string, string>, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const headerBufs = Object.entries(headers).map(([name, value]) => {
    const n = Buffer.from(name, 'utf8');
    const v = Buffer.from(value, 'utf8');
    const b = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    let o = b.writeUInt8(n.length, 0);
    o += n.copy(b, o);
    o = b.writeUInt8(7, o);
    o = b.writeUInt16BE(v.length, o);
    v.copy(b, o);
    return b;
  });
  const headerBytes = Buffer.concat(headerBufs);
  const total = 12 + headerBytes.length + body.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(crc32(out, 0, 8), 8);
  headerBytes.copy(out, 12);
  body.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(crc32(out, 0, total - 4), total - 4);
  return out;
}

export function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return encodeMessage(
    { ':event-type': eventType, ':content-type': 'application/json', ':message-type': 'event' },
    JSON.stringify(payload),
  );
}

export function exceptionFrame(exceptionType: string, message: string): Uint8Array {
  return encodeMessage(
    { ':exception-type': exceptionType, ':content-type': 'application/json', ':message-type': 'exception' },
    JSON.stringify({ message }),
  );
}

/** Decode one frame (for human-readable wire logs). Assumes string headers, as encoded above. */
export function decodeMessage(buf: Uint8Array): { headers: Record<string, string>; payload: string } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const headersLen = b.readUInt32BE(4);
  const headers: Record<string, string> = {};
  let o = 12;
  while (o < 12 + headersLen) {
    const nameLen = b.readUInt8(o);
    const name = b.toString('utf8', o + 1, o + 1 + nameLen);
    o += 1 + nameLen + 1; // skip type byte
    const valueLen = b.readUInt16BE(o);
    headers[name] = b.toString('utf8', o + 2, o + 2 + valueLen);
    o += 2 + valueLen;
  }
  return { headers, payload: b.toString('utf8', 12 + headersLen, b.length - 4) };
}
