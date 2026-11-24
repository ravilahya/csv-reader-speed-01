// A fast drop-in replacement for csv-reader 1.0.0: run(input) returns csv-reader's exact reading
// {columns, rows, errors} of the case's input {text, header}, produced by one left-to-right pass that
// slices fields out of the text instead of building them character by character.
//
// The reading policy, matched behaviour for behaviour:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled: "" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF; what follows the closing quote, up to
//     the next comma or line break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it
//     (every record when header is false), each padded with "" (short_row, with fields: its count) or
//     cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside quotes counted), row its record's index in rows, null for
//     the header; a record's short_row or long_row comes when the record ends.

// How the field being read ended.
const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field read last: its value, how it ended, how many characters an unquoted read kept, and
  // whether it opened with a quote.
  let fValue = '';
  let fEnded = ENDED_END;
  let fAdded = 0;
  let fQuoted = false;

  function fail(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `initial` up to the next comma or line break. A CR not followed
  // by LF is dropped (stray_cr). Clean runs are sliced whole; only a field that drops a CR is
  // assembled from parts.
  function readUnquoted(initial) {
    let start = pos;
    let kept = 0;
    let parts = null;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        fAdded = kept + (pos - start);
        fValue =
          parts === null
            ? initial + text.slice(start, pos)
            : initial + parts.join('') + text.slice(start, pos);
        pos += 1;
        fEnded = ENDED_COMMA;
        return;
      }
      if (c === 10) {
        // LF
        fAdded = kept + (pos - start);
        fValue =
          parts === null
            ? initial + text.slice(start, pos)
            : initial + parts.join('') + text.slice(start, pos);
        pos += 1;
        line += 1;
        fEnded = ENDED_BREAK;
        return;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(pos + 1) === 10) {
          fAdded = kept + (pos - start);
          fValue =
            parts === null
              ? initial + text.slice(start, pos)
              : initial + parts.join('') + text.slice(start, pos);
          pos += 2;
          line += 1;
          fEnded = ENDED_BREAK;
          return;
        }
        fail('stray_cr');
        if (parts === null) parts = [];
        parts.push(text.slice(start, pos));
        kept += pos - start;
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    fAdded = kept + (pos - start);
    fValue =
      parts === null
        ? initial + text.slice(start, pos)
        : initial + parts.join('') + text.slice(start, pos);
    fEnded = ENDED_END;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let start = pos;
    let parts = null;
    let closed = false;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        // '"'
        if (text.charCodeAt(pos + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(start, pos), '"');
          pos += 2;
          start = pos;
          continue;
        }
        fValue = parts === null ? text.slice(start, pos) : parts.join('') + text.slice(start, pos);
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(start, pos), '\n');
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        start = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as
      // unquoted.
      pos = open + 1;
      line = openLine;
      fail('unterminated_quote');
      readUnquoted('"');
      return;
    }
    if (pos >= n) {
      fEnded = ENDED_END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = ENDED_COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = ENDED_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = ENDED_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(fValue);
    if (fAdded > 0) fail('quote_junk');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    do {
      fQuoted = text.charCodeAt(pos) === 34;
      if (fQuoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === ENDED_COMMA);

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && fields[0] === '' && !fQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
