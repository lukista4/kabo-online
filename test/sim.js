// Fuzz test: plays many full games with random legal moves and checks invariants.
'use strict';
const assert = require('assert');
const { Game, GameError } = require('../game');

const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];

function allCards(g) {
  const cards = [...g.deck, ...g.discard, ...Object.values(g.hands).flat()];
  if (g.drawn) cards.push(g.drawn.card);
  return cards;
}

function checkInvariants(g) {
  const cards = allCards(g);
  assert.strictEqual(cards.length, 52, 'card count');
  assert.strictEqual(new Set(cards.map(c => c.id)).size, 52, 'duplicate card');
  assert.strictEqual(cards.reduce((a, c) => a + c.v, 0), 2 * 13 + 4 * 78, 'value sum');
  // views: nobody sees a face-down card of another player unless allowed
  for (const viewer of g.order) {
    const v = g.viewFor(viewer);
    if (g.phase === 'roundEnd' || g.phase === 'gameEnd') continue;
    for (const owner of g.order) {
      v.hands[owner].forEach((c, i) => {
        const real = g.hands[owner][i];
        if (c.v === undefined) return;
        assert.strictEqual(c.v, real.v);
        if (real.up) return;
        const allowed =
          (g.settings.memoryAid && g.known[viewer].has(real.id)) ||
          (g.phase === 'peek' && owner === viewer && g.peekChosen[viewer].includes(real.id)) ||
          (g.reveal && g.reveal.cardId === real.id && g.turnPid === viewer);
        assert.ok(allowed, `leak: ${viewer} sees ${owner}'s face-down card`);
      });
    }
    if (g.drawn && g.drawn.from === 'deck' && viewer !== g.turnPid) assert.strictEqual(v.drawn.v, undefined, 'drawn card leak');
  }
}

function randomMove(g) {
  if (g.phase === 'peek') {
    const pid = pick(g.order.filter(p => !g.peekReady[p]));
    if (g.peekChosen[pid].length < 2) {
      const choices = g.hands[pid].filter(c => !g.peekChosen[pid].includes(c.id));
      g.peekChoose(pid, pick(choices).id);
    } else g.peekDone(pid);
    return;
  }
  const pid = g.turnPid;
  const hand = g.hands[pid];
  if (g.step === 'choose') {
    const r = Math.random();
    if (r < 0.03 && !g.kaboBy) return g.callKabo(pid);
    if (r < 0.35 && g.discard.length) return g.drawDiscard(pid);
    return g.drawDeck(pid);
  }
  if (g.step === 'drawn') {
    if (g.drawn.from === 'discard' && Math.random() < 0.05) return g.undoDiscardTake(pid);
    if (g.drawn.from === 'deck' && Math.random() < 0.45) return g.discardDrawn(pid);
    // pick 1..3 cards; sometimes a matching group
    const k = Math.random() < 0.7 ? 1 : 2 + rnd(2);
    const ids = [...hand].sort(() => Math.random() - 0.5).slice(0, Math.min(k, hand.length)).map(c => c.id);
    return g.swap(pid, ids);
  }
  if (g.step === 'effect') {
    if (Math.random() < 0.1) return g.skipEffect(pid);
    if (g.effect === 'peek') return g.useEffect(pid, { cardId: pick(hand.filter(c => !c.up)).id });
    if (g.effect === 'spy') {
      const opts = g.order.filter(o => o !== pid).flatMap(o => g.hands[o].filter(c => !c.up));
      return g.useEffect(pid, { cardId: pick(opts).id });
    }
    if (g.effect === 'swap') {
      const other = pick(g.order.filter(o => o !== pid && g.hands[o].length));
      return g.useEffect(pid, { myCardId: pick(hand).id, otherCardId: pick(g.hands[other]).id });
    }
  }
  if (g.step === 'effectResult') return g.ackReveal(pid);
  throw new Error('stuck: ' + g.step);
}

// --- unit checks of scoring rules ---
function scoringTests() {
  const mk = vals => vals.map((v, i) => ({ id: 'x' + v + '_' + i + Math.random(), v, up: false }));
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  // Kabo succeeds (tie counts as success)
  g.hands = { a: mk([1, 1, 1, 1]), b: mk([2, 2, 0, 0]), c: mk([9, 9, 9, 9]) };
  g.kaboBy = 'a'; g.endRound();
  assert.deepStrictEqual(g.roundResult.scores, { a: 0, b: 4, c: 36 });
  // Kabo fails → sum + 10
  g.phase = 'roundEnd'; g.nextRound();
  g.hands = { a: mk([1, 1, 1, 2]), b: mk([0, 0, 1, 1]), c: mk([9, 9, 9, 9]) };
  g.kaboBy = 'a'; g.endRound();
  assert.deepStrictEqual(g.roundResult.scores, { a: 15, b: 2, c: 36 });
  // Kamikaze
  g.nextRound();
  g.hands = { a: mk([12, 13, 12, 13]), b: mk([0, 0, 1, 1]), c: mk([1, 2, 3, 4]) };
  g.kaboBy = 'b'; g.endRound();
  assert.deepStrictEqual(g.roundResult.scores, { a: 0, b: 50, c: 50 });
  // exactly 100 → 50, only once
  const g2 = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  g2.totals.a = 90;
  g2.hands = { a: mk([1, 2, 3, 4]), b: mk([0, 0, 0, 0]) }; g2.kaboBy = null; g2.endRound();
  assert.strictEqual(g2.totals.a, 50); assert.strictEqual(g2.phase, 'roundEnd');
  g2.nextRound(); g2.totals.a = 90;
  g2.hands = { a: mk([1, 2, 3, 4]), b: mk([0, 0, 0, 0]) }; g2.endRound();
  assert.strictEqual(g2.totals.a, 100); assert.strictEqual(g2.phase, 'roundEnd');
  g2.nextRound();
  g2.hands = { a: mk([0, 0, 0, 1]), b: mk([0, 0, 0, 0]) }; g2.endRound();
  assert.strictEqual(g2.phase, 'gameEnd'); assert.strictEqual(g2.winnerId, 'b');
  // failed multi-swap of 3 → cards flipped, new card + penalty card added
  const g3 = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  for (const p of g3.order) { g3.peekChoose(p, g3.hands[p][0].id); g3.peekChoose(p, g3.hands[p][1].id); g3.peekDone(p); }
  const p = g3.turnPid;
  g3.hands[p] = mk([1, 2, 3, 4]);
  g3.drawDeck(p);
  g3.swap(p, g3.hands[p].slice(0, 3).map(c => c.id));
  assert.strictEqual(g3.hands[p].length, 6);
  assert.deepStrictEqual(g3.hands[p].slice(0, 3).map(c => c.up), [true, true, true]);
  // successful double swap → row shrinks by one
  const g4 = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  for (const q of g4.order) { g4.peekChoose(q, g4.hands[q][0].id); g4.peekChoose(q, g4.hands[q][1].id); g4.peekDone(q); }
  const q = g4.turnPid;
  g4.hands[q] = mk([5, 7, 5, 9]);
  g4.drawDiscard(q);
  const top = g4.drawn.card;
  g4.swap(q, [g4.hands[q][0].id, g4.hands[q][2].id]);
  assert.strictEqual(g4.hands[q].length, 3);
  assert.strictEqual(g4.hands[q][0], top);
  assert.strictEqual(top.up, true);
  console.log('scoring/unit checks OK');
}

scoringTests();

let games = 0, rounds = 0, moves = 0, errors = 0;
const t0 = Date.now();
for (let i = 0; i < 3000; i++) {
  const n = 2 + (i % 5);
  const players = Array.from({ length: n }, (_, k) => ({ id: 'p' + k, name: 'P' + k }));
  const g = new Game(players, { memoryAid: i % 2 === 0 });
  let guard = 0;
  while (g.phase !== 'gameEnd') {
    if (g.phase === 'roundEnd') { g.nextRound(); rounds++; continue; }
    try { randomMove(g); moves++; }
    catch (e) { if (e instanceof GameError) { errors++; } else throw e; }
    if (g.phase === 'peek' || g.phase === 'play') checkInvariants(g);
    if (++guard > 200000) throw new Error('game did not finish');
  }
  assert.ok(g.order.some(p => g.totals[p] > 100));
  games++;
}
console.log(`fuzz OK: ${games} games, ${rounds} rounds, ${moves} moves, ${errors} rejected moves, ${Date.now() - t0} ms`);
