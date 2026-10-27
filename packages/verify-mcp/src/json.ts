// Strict JSON parsing for attestation documents and the registry
// file (7.5 review M10/m5). JSON.parse is last-wins on duplicate
// object keys: two different documents — one of them possibly the
// signed one — collapse into a single value with no trace. This
// parser rejects a duplicate key at ANY depth, so the caller can
// treat the document as malformed instead of verifying whichever
// half survived. Errors carry fixed messages (a class name only);
// the document's content is never interpolated into them.

export class DuplicateJsonKeyError extends Error {
  constructor() {
    super('duplicate JSON key');
    this.name = 'DuplicateJsonKeyError';
  }
}

export class JsonSyntaxError extends Error {
  constructor() {
    super('invalid JSON');
    this.name = 'JsonSyntaxError';
  }
}

export function parseJsonStrict(text: string): unknown {
  let pos = 0;
  const len = text.length;

  function fail(): never {
    throw new JsonSyntaxError();
  }

  function skipWs(): void {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos += 1;
      else break;
    }
  }

  function parseString(): string {
    // text[pos] === '"'
    pos += 1;
    let out = '';
    while (pos < len) {
      const c = text[pos] as string;
      if (c === '"') {
        pos += 1;
        return out;
      }
      if (c === '\\') {
        const esc = text[pos + 1];
        switch (esc) {
          case '"': out += '"'; pos += 2; break;
          case '\\': out += '\\'; pos += 2; break;
          case '/': out += '/'; pos += 2; break;
          case 'b': out += '\b'; pos += 2; break;
          case 'f': out += '\f'; pos += 2; break;
          case 'n': out += '\n'; pos += 2; break;
          case 'r': out += '\r'; pos += 2; break;
          case 't': out += '\t'; pos += 2; break;
          case 'u': {
            const hex = text.slice(pos + 2, pos + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
            out += String.fromCharCode(parseInt(hex, 16));
            pos += 6;
            break;
          }
          default: fail();
        }
        continue;
      }
      if (c < ' ') fail(); // unescaped control character
      out += c;
      pos += 1;
    }
    return fail();
  }

  function parseNumber(): number {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!m) fail();
    pos += (m as RegExpExecArray)[0].length;
    return Number((m as RegExpExecArray)[0]);
  }

  function parseArray(): unknown[] {
    pos += 1; // '['
    const out: unknown[] = [];
    skipWs();
    if (text[pos] === ']') { pos += 1; return out; }
    for (;;) {
      out.push(parseValue());
      skipWs();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === ']') { pos += 1; return out; }
      fail();
    }
  }

  function parseObject(): Record<string, unknown> {
    pos += 1; // '{'
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    skipWs();
    if (text[pos] === '}') { pos += 1; return out; }
    for (;;) {
      skipWs();
      if (text[pos] !== '"') fail();
      const key = parseString();
      if (seen.has(key)) throw new DuplicateJsonKeyError();
      seen.add(key);
      skipWs();
      if (text[pos] !== ':') fail();
      pos += 1;
      const value = parseValue();
      // defineProperty, not assignment: a "__proto__" key must land
      // as data, not invoke the prototype setter (same discipline as
      // the core's canonical form).
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      skipWs();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === '}') { pos += 1; return out; }
      fail();
    }
  }

  function parseValue(): unknown {
    skipWs();
    const c = text[pos];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === 't') {
      if (text.startsWith('true', pos)) { pos += 4; return true; }
      return fail();
    }
    if (c === 'f') {
      if (text.startsWith('false', pos)) { pos += 5; return false; }
      return fail();
    }
    if (c === 'n') {
      if (text.startsWith('null', pos)) { pos += 4; return null; }
      return fail();
    }
    return parseNumber();
  }

  const value = parseValue();
  skipWs();
  if (pos !== len) fail();
  return value;
}
