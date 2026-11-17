// Kabo game engine (server-side, authoritative). Rules: Mindok "Kabo" rule sheet.
'use strict';

const EFFECTS = { 7: 'peek', 8: 'peek', 9: 'spy', 10: 'spy', 11: 'swap', 12: 'swap' };
const EFFECT_NAMES = { peek: 'KUK', spy: 'ŠPION', swap: 'KŠEFT' };

function buildDeck() {
  const values = [0, 0, 13, 13];
  for (let v = 1; v <= 12; v++) values.push(v, v, v, v);
  const deck = values.map((v, i) => ({ id: 'c' + i, v, up: false }));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

class GameError extends Error {}
function fail(msg) { throw new GameError(msg); }

class Game {
  constructor(players, settings = {}) {
    // players: [{id, name}] in seat order
    this.order = players.map(p => p.id);
    this.names = Object.fromEntries(players.map(p => [p.id, p.name]));
    this.settings = { memoryAid: !!settings.memoryAid };
    this.totals = Object.fromEntries(this.order.map(id => [id, 0]));
    this.usedReset = Object.fromEntries(this.order.map(id => [id, false]));
    this.history = []; // per round: {round, scores:{pid:n}}
    this.round = 0;
    this.starterIdx = Math.floor(Math.random() * this.order.length);
    this.log = [];
    this.seq = 0; // bumps on every change (clients use for highlights)
    this.highlight = null;
    this.winnerId = null;
    this.startRound();
  }

  addLog(text) {
    this.log.push({ n: ++this.seq, text });
    if (this.log.length > 40) this.log.shift();
  }

  setHighlight(cardIds, kind) {
    this.hlSeq = (this.hlSeq || 0) + 1;
    this.highlight = { n: this.hlSeq, cardIds, kind };
  }

  name(pid) { return this.names[pid] || '?'; }

  startRound() {
    this.round += 1;
    this.deck = buildDeck();
    this.hands = {};
    for (const pid of this.order) this.hands[pid] = this.deck.splice(0, 4);
    const first = this.deck.shift();
    first.up = true;
    this.discard = [first];
    this.known = Object.fromEntries(this.order.map(id => [id, new Set()]));
    this.peekChosen = Object.fromEntries(this.order.map(id => [id, []]));
    this.peekReady = Object.fromEntries(this.order.map(id => [id, false]));
    this.phase = 'peek';
    this.turnIdx = this.starterIdx;
    this.kaboBy = null;
    this.turnsLeft = 0;
    this.resetTurn();
    this.roundResult = null;
    this.highlight = null;
    this.addLog(`— Kolo ${this.round} — začíná ${this.name(this.order[this.starterIdx])}. Podívejte se na 2 své karty.`);
  }

  resetTurn() {
    this.step = 'choose';
    this.drawn = null;     // {card, from}
    this.effect = null;    // 'peek' | 'spy' | 'swap'
    this.reveal = null;    // {cardId, ownerId}
  }

  get turnPid() { return this.order[this.turnIdx]; }

  findCard(cardId) {
    for (const pid of this.order) {
      const idx = this.hands[pid].findIndex(c => c.id === cardId);
      if (idx >= 0) return { pid, idx, card: this.hands[pid][idx] };
    }
    return null;
  }

  // ---------- initial peek ----------
  peekChoose(pid, cardId) {
    if (this.phase !== 'peek') fail('Teď se nedá nahlížet.');
    if (this.peekReady[pid]) fail('Už jsi potvrdil(a).');
    const chosen = this.peekChosen[pid];
    if (chosen.includes(cardId)) return;
    if (chosen.length >= 2) fail('Můžeš se podívat jen na 2 karty.');
    if (!this.hands[pid].some(c => c.id === cardId)) fail('To není tvoje karta.');
    chosen.push(cardId);
    this.known[pid].add(cardId);
  }

  peekDone(pid) {
    if (this.phase !== 'peek') fail('Teď se nedá nahlížet.');
    if (this.peekChosen[pid].length < 2) fail('Nejdřív se podívej na 2 karty.');
    this.peekReady[pid] = true;
    if (this.order.every(id => this.peekReady[id])) {
      this.phase = 'play';
      this.addLog(`Hraje se! Na tahu je ${this.name(this.turnPid)}.`);
    }
  }

  // ---------- turn actions ----------
  assertTurn(pid, step) {
    if (this.phase !== 'play') fail('Teď se nehraje.');
    if (pid !== this.turnPid) fail('Nejsi na tahu.');
    if (step && this.step !== step) fail('Tohle teď nejde.');
  }

  drawDeck(pid) {
    this.assertTurn(pid, 'choose');
    if (!this.deck.length) fail('Balíček je prázdný.');
    const card = this.deck.shift();
    this.drawn = { card, from: 'deck' };
    this.known[pid].add(card.id);
    this.step = 'drawn';
    this.addLog(`${this.name(pid)} si lízl(a) kartu z balíčku.`);
  }

  drawDiscard(pid) {
    this.assertTurn(pid, 'choose');
    if (!this.discard.length) fail('Odhazovací hromádka je prázdná.');
    const card = this.discard.pop();
    this.drawn = { card, from: 'discard' };
    this.known[pid].add(card.id);
    this.step = 'drawn';
    this.addLog(`${this.name(pid)} si vzal(a) ${card.v} z odhazovací hromádky.`);
  }

  undoDiscardTake(pid) {
    this.assertTurn(pid, 'drawn');
    if (this.drawn.from !== 'discard') fail('Kartu z balíčku nejde vrátit.');
    this.discard.push(this.drawn.card);
    this.addLog(`${this.name(pid)} vrátil(a) ${this.drawn.card.v} zpět na hromádku.`);
    this.resetTurn();
  }

  callKabo(pid) {
    this.assertTurn(pid, 'choose');
    if (this.kaboBy) fail('Kabo už někdo zvolal.');
    this.kaboBy = pid;
    this.turnsLeft = this.order.length - 1;
    this.addLog(`📣 ${this.name(pid)} volá KABO! Každý soupeř má ještě jeden tah.`);
    this.setHighlight([], 'kabo');
    this.advance();
  }

  discardDrawn(pid) {
    this.assertTurn(pid, 'drawn');
    if (this.drawn.from !== 'deck') fail('Kartu z odhazovací hromádky musíš vyměnit.');
    const card = this.drawn.card;
    card.up = true;
    this.discard.push(card);
    this.drawn = null;
    const eff = EFFECTS[card.v];
    if (eff && this.effectPossible(pid, eff)) {
      this.effect = eff;
      this.step = 'effect';
      this.addLog(`${this.name(pid)} odhodil(a) ${card.v} — efekt ${EFFECT_NAMES[eff]}.`);
    } else {
      this.addLog(`${this.name(pid)} odhodil(a) ${card.v}.`);
      this.endTurn(pid);
    }
  }

  effectPossible(pid, eff) {
    if (eff === 'peek') return this.hands[pid].some(c => !c.up);
    if (eff === 'spy') return this.order.some(o => o !== pid && this.hands[o].some(c => !c.up));
    if (eff === 'swap') return this.hands[pid].length > 0 && this.order.some(o => o !== pid && this.hands[o].length > 0);
    return false;
  }

  swap(pid, cardIds) {
    this.assertTurn(pid, 'drawn');
    if (!Array.isArray(cardIds) || cardIds.length < 1) fail('Vyber aspoň jednu svou kartu.');
    const hand = this.hands[pid];
    const uniq = [...new Set(cardIds)];
    const idxs = uniq.map(id => hand.findIndex(c => c.id === id));
    if (idxs.some(i => i < 0)) fail('Můžeš vyměnit jen své karty.');
    idxs.sort((a, b) => a - b);
    const selected = idxs.map(i => hand[i]);
    const { card: newCard, from } = this.drawn;
    newCard.up = from === 'discard';
    const allSame = selected.every(c => c.v === selected[0].v);
    const who = this.name(pid);
    const srcText = from === 'deck' ? 'kartu z balíčku' : `${newCard.v} z hromádky`;

    if (allSame) {
      // remove selected (from the back so indexes stay valid), new card goes to the first slot
      for (let k = idxs.length - 1; k >= 0; k--) hand.splice(idxs[k], 1);
      hand.splice(idxs[0], 0, newCard);
      for (const c of selected) { c.up = true; this.discard.push(c); }
      this.known[pid].add(newCard.id);
      if (selected.length === 1) {
        this.addLog(`${who} vyměnil(a) ${srcText} za svou ${selected[0].v}.`);
      } else {
        this.addLog(`${who} vyměnil(a) ${srcText} za ${selected.length}× ${selected[0].v}. ✔`);
      }
      this.setHighlight([newCard.id], 'placed');
    } else {
      // failed multi-swap: selected stay, flipped face up; new card added to the row
      for (const c of selected) c.up = true;
      hand.push(newCard);
      this.known[pid].add(newCard.id);
      const vals = selected.map(c => c.v).join(', ');
      this.addLog(`${who} zkusil(a) vyměnit karty ${vals} — nejsou stejné! Zůstávají lícem nahoru, nová karta se přidává do řady.`);
      const hl = [newCard.id, ...selected.map(c => c.id)];
      if (selected.length >= 3 && this.deck.length) {
        const pen = this.deck.shift();
        pen.up = false;
        hand.push(pen);
        hl.push(pen.id);
        this.addLog(`${who} si bere trestnou kartu.`);
      }
      this.setHighlight(hl, 'failed');
    }
    this.drawn = null;
    this.endTurn(pid);
  }

  useEffect(pid, target) {
    this.assertTurn(pid, 'effect');
    const who = this.name(pid);
    if (this.effect === 'peek') {
      const f = this.findCard(target && target.cardId);
      if (!f || f.pid !== pid) fail('Vyber jednu svou kartu.');
      if (f.card.up) fail('Vyber kartu, která leží lícem dolů.');
      this.known[pid].add(f.card.id);
      this.reveal = { cardId: f.card.id, ownerId: pid };
      this.step = 'effectResult';
      this.addLog(`${who} kouká na svou ${f.idx + 1}. kartu.`);
      this.setHighlight([f.card.id], 'peek');
    } else if (this.effect === 'spy') {
      const f = this.findCard(target && target.cardId);
      if (!f || f.pid === pid) fail('Vyber kartu soupeře.');
      if (f.card.up) fail('Vyber kartu, která leží lícem dolů.');
      this.known[pid].add(f.card.id);
      this.reveal = { cardId: f.card.id, ownerId: f.pid };
      this.step = 'effectResult';
      this.addLog(`${who} špehuje ${f.idx + 1}. kartu hráče ${this.name(f.pid)}.`);
      this.setHighlight([f.card.id], 'spy');
    } else if (this.effect === 'swap') {
      const a = this.findCard(target && target.myCardId);
      const b = this.findCard(target && target.otherCardId);
      if (!a || a.pid !== pid) fail('Vyber jednu svou kartu.');
      if (!b || b.pid === pid) fail('Vyber kartu soupeře.');
      this.hands[pid][a.idx] = b.card;
      this.hands[b.pid][b.idx] = a.card;
      this.addLog(`${who} dělá kšeft: svou ${a.idx + 1}. kartu za ${b.idx + 1}. kartu hráče ${this.name(b.pid)}.`);
      this.setHighlight([a.card.id, b.card.id], 'swap');
      this.endTurn(pid);
    }
  }

  skipEffect(pid) {
    this.assertTurn(pid, 'effect');
    this.addLog(`${this.name(pid)} efekt nevyužil(a).`);
    this.endTurn(pid);
  }

  ackReveal(pid) {
    this.assertTurn(pid, 'effectResult');
    this.endTurn(pid);
  }

  endTurn(pid) {
    if (this.kaboBy && pid !== this.kaboBy) this.turnsLeft -= 1;
    if (!this.deck.length) {
      this.addLog('Balíček došel — kolo končí.');
      return this.endRound();
    }
    if (this.kaboBy && this.turnsLeft <= 0) return this.endRound();
    this.advance();
  }

  advance() {
    this.resetTurn();
    this.turnIdx = (this.turnIdx + 1) % this.order.length;
    if (this.kaboBy && this.turnPid === this.kaboBy) {
      // safety: should not happen, round should have ended
      return this.endRound();
    }
  }

  // ---------- scoring ----------
  static isKamikaze(hand) {
    if (hand.length !== 4) return false;
    const s = hand.map(c => c.v).sort((a, b) => a - b).join(',');
    return s === '12,12,13,13';
  }

  endRound() {
    this.resetTurn();
    const sums = {};
    for (const pid of this.order) sums[pid] = this.hands[pid].reduce((a, c) => a + c.v, 0);
    const kamikaze = this.order.find(pid => Game.isKamikaze(this.hands[pid])) || null;
    const scores = {};
    const notes = {};
    if (kamikaze) {
      for (const pid of this.order) {
        scores[pid] = pid === kamikaze ? 0 : 50;
        notes[pid] = pid === kamikaze ? 'KAMIKAZE!' : 'kamikaze +50';
      }
    } else {
      const min = Math.min(...Object.values(sums));
      for (const pid of this.order) {
        scores[pid] = sums[pid];
        if (pid === this.kaboBy) {
          if (sums[pid] <= min) { scores[pid] = 0; notes[pid] = 'Kabo vyšlo → 0'; }
          else { scores[pid] = sums[pid] + 10; notes[pid] = 'Kabo nevyšlo → +10'; }
        }
      }
    }
    const resets = [];
    for (const pid of this.order) {
      this.totals[pid] += scores[pid];
      if (this.totals[pid] === 100 && !this.usedReset[pid]) {
        this.totals[pid] = 50;
        this.usedReset[pid] = true;
        resets.push(pid);
        notes[pid] = (notes[pid] ? notes[pid] + ', ' : '') + 'přesně 100 → 50';
      }
    }
    this.history.push({ round: this.round, scores: { ...scores } });
    this.roundResult = { sums, scores, notes, kamikaze, kaboBy: this.kaboBy };
    for (const pid of this.order) for (const c of this.hands[pid]) c.up = true;
    this.addLog(`Konec kola ${this.round}: ` + this.order.map(p => `${this.name(p)} ${scores[p]}`).join(', ') + '.');
    for (const pid of resets) this.addLog(`${this.name(pid)} má přesně 100 → odpis na 50!`);

    // next starter: lowest round score; tie → closest clockwise from previous starter
    const minScore = Math.min(...Object.values(scores));
    for (let k = 0; k < this.order.length; k++) {
      const i = (this.starterIdx + k) % this.order.length;
      if (scores[this.order[i]] === minScore) { this.starterIdx = i; break; }
    }

    if (this.order.some(pid => this.totals[pid] > 100)) {
      const best = [...this.order].sort((a, b) =>
        (this.totals[a] - this.totals[b]) || (scores[a] - scores[b]));
      this.winnerId = best[0];
      this.phase = 'gameEnd';
      this.addLog(`🏆 Konec hry! Vítězí ${this.name(this.winnerId)}.`);
    } else {
      this.phase = 'roundEnd';
    }
  }

  nextRound() {
    if (this.phase !== 'roundEnd') fail('Kolo ještě neskončilo.');
    this.startRound();
  }

  renamePlayer(pid, name) { this.names[pid] = name; }

  // ---------- per-player view ----------
  viewFor(pid) {
    const ended = this.phase === 'roundEnd' || this.phase === 'gameEnd';
    const myTurn = this.phase === 'play' && this.turnPid === pid;
    const hands = {};
    for (const owner of this.order) {
      hands[owner] = this.hands[owner].map(c => {
        let visible = c.up || ended;
        let peeked = false;
        if (!visible && this.phase === 'peek' && owner === pid && !this.peekReady[pid] && this.peekChosen[pid].includes(c.id)) {
          visible = true; peeked = true;
        }
        if (!visible && myTurn && this.reveal && this.reveal.cardId === c.id) { visible = true; peeked = true; }
        let remembered = false;
        if (!visible && this.settings.memoryAid && this.known[pid] && this.known[pid].has(c.id)) {
          visible = true; remembered = true;
        }
        const out = { id: c.id, up: c.up };
        if (visible) out.v = c.v;
        if (peeked) out.peeked = true;
        if (remembered) out.remembered = true;
        return out;
      });
    }
    let drawn = null;
    if (this.drawn) {
      drawn = { from: this.drawn.from, id: this.drawn.card.id };
      if (this.turnPid === pid || this.drawn.from === 'discard') drawn.v = this.drawn.card.v;
    }
    const top = this.discard[this.discard.length - 1];
    return {
      phase: this.phase,
      round: this.round,
      order: this.order,
      names: this.names,
      totals: this.totals,
      usedReset: this.usedReset,
      history: this.history,
      turnPid: this.phase === 'play' ? this.turnPid : null,
      starterPid: this.order[this.starterIdx],
      step: this.step,
      effect: this.effect,
      kaboBy: this.kaboBy,
      turnsLeft: this.turnsLeft,
      deckCount: this.deck.length,
      discardTop: top ? { id: top.id, v: top.v } : null,
      discardCount: this.discard.length,
      hands,
      drawn,
      peekChosen: this.peekChosen[pid] ? this.peekChosen[pid].length : 0,
      peekReady: this.peekReady,
      settings: this.settings,
      log: this.log,
      highlight: this.highlight,
      roundResult: this.roundResult,
      winnerId: this.winnerId,
    };
  }
}

module.exports = { Game, GameError, EFFECTS, EFFECT_NAMES, buildDeck };
