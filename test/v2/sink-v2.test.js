import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DryRunSink } from '../../src/sink.js';

test('DryRunSink.writeV2Decision returns a synthetic id and persists the row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2sink-'));
  const sink = new DryRunSink({ dir, logger: { info(){}, warn(){}, error(){} } });
  const decRow = {
    window_id: 'W1', sealed_at: new Date(1_700_000_000_000).toISOString(),
    engine_id: 'btc-alpha-v2-scalp', spec_version: 'v2.0.0',
    recommendation: 'TAKE_NO', status: 'ok', reason: 'x', strike: 65135,
    replica_index: 65088, up_ask: 0.34, down_ask: 0.68, is_replay: false,
    families: {}, evidence: {},
  };
  const r1 = await sink.writeV2Decision(decRow);
  assert.equal(r1.written, 1);
  assert.equal(r1.id, 1, 'first decision gets id 1');
  const r2 = await sink.writeV2Decision({ ...decRow, window_id: 'W2' });
  assert.equal(r2.id, 2, 'ids increment');

  const g = await sink.writeV2Grade({
    decision_id: r1.id, window_id: 'W1', engine_id: 'btc-alpha-v2-scalp',
    recommendation: 'TAKE_NO', settled_outcome: 'no', call_correct: true,
    entry_price: 0.68, fee: 0.02, net_pnl: 0.30, graded_at: new Date(1_700_000_720_000).toISOString(),
  });
  assert.equal(g.written, 1);

  // files exist and carry the rows
  const decFile = fs.readdirSync(dir).find((f) => f.startsWith('fa_v2_decisions'));
  const grFile = fs.readdirSync(dir).find((f) => f.startsWith('fa_v2_grades'));
  assert.ok(decFile && grFile, 'both v2 jsonl files were created');
  const decLines = fs.readFileSync(path.join(dir, decFile), 'utf8').trim().split('\n');
  assert.equal(decLines.length, 2);
  assert.equal(JSON.parse(decLines[0]).id, 1, 'persisted row carries the id for FK linkage');
  fs.rmSync(dir, { recursive: true, force: true });
});
