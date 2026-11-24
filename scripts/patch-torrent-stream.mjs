import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '../node_modules/torrent-stream/index.js');
let source = fs.readFileSync(target, 'utf8');

if (!source.includes('engine._markPieceComplete')) {
  const marker = '  var onpiececomplete = function (index, buffer) {';
  if (!source.includes(marker)) {
    throw new Error('torrent-stream marker not found');
  }
  const injected = [
    '  engine._markPieceComplete = function (index) {',
    '    if (!pieces[index]) return false',
    '    pieces[index] = null',
    '    reservations[index] = null',
    '    engine.bitfield.set(index, true)',
    '    for (var i = 0; i < wires.length; i++) wires[i].have(index)',
    '    engine.emit("verify", index)',
    '    gc()',
    '    return true',
    '  }',
    '',
    marker
  ].join('\n');
  source = source.replace(marker, injected);
  fs.writeFileSync(target, source);
  console.log('patched torrent-stream');
} else {
  console.log('torrent-stream already patched');
}
