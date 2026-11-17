# Kabo online

Online version of the Kabo card game (rules per the Mindok rule sheet) for 2–6 players.

- `npm install` then `npm start` → http://localhost:3000
- `npm test` → plays 3000 random games against the rules engine and checks invariants.

Deploy: any Node host (e.g. Render free web service): build `npm install`, start `node server.js`.

Rules implemented: 4 face-down cards, peek at 2; draw from deck or discard pile, or call Kabo;
multi-card swaps of equal values (failed attempt: cards stay face up, new card added; 3+ cards → penalty card);
effects 7–8 KUK, 9–10 ŠPION, 11–12 KŠEFT; Kabo → 0 if lowest (ties count), else sum + 10;
Kamikaze (two 12s + two 13s) → 0, others 50; exactly 100 → 50 once per game; game ends above 100.
