# Mania Replay Master v0.5.4 — Update Notes (unreleased)

This release rewrites the judgement model of the **Replay** path (the exact pipeline that reads `.osr`). Previously the replay colours drifted far from the osu! score screen, especially on long notes (whole LN recoloured, head/tail swapped, dense LN sections tinted one row after another).

- **Judgement model aligned with the client**: ported from the reference implementation Mania-Replay-Master (per-lane FIFO scan, `TOO_EARLY` / `TOO_LATE` rules, the "next note in the same lane overrides lateness" check, and the "hold too long" reverse scan). V1 long notes now get a **merged head+tail** judgement (`totalDiff <= window*rate*2`); ScoreV2 keeps head/tail separate and adds the "tail demoted to MEH when the head was missed / already judged" rule.
- **Windows are truncated integers**: V1 `[16,34,67,97,121,158] + 3*(10-OD)` with HR/EZ multipliers; ScoreV2 uses lazer's `DifficultyRange(22.4,19.4,13.9)` ranges. The game truncates, while the plugin previously added `+0.5`, which pushed boundary notes into the neighbouring class.
- **Offset is calibrated automatically**: `fitExactOffset()` gives a rough value, then the `.osr` result counts are minimised over ±80ms in 1ms steps, removing the ~2.6s bias between the `.osr` clock and the beatmap clock (settles at -2629ms in practice).
- **Replay file selection**: helper `/replay` accepts an optional `file=` parameter; when a map has several `.osr` files, the plugin now picks the run that matches the recording end time instead of the newest file.

Measured on the same 4K LN map (OD8) against the osu! result counts: V1 L1 distance 890 → 10, ScoreV2 618 → 18.

**Live-pipeline fixes in the same release** — fixing the large-scale mis-colouring seen while playing in V1:

- **Long-note tails no longer claim ahead of time**: live matching is now per-lane FIFO with full window checks, and a release only judges a long note whose head was actually pressed (previously 871 releases were credited 1–164ms early to tails of notes that had not started). V1 head/tail also take the game's `hitErrors` correction instead of trusting the hook clock alone.
- **Joint error pairing**: `hitErrors` are no longer paired by "closest error value" (dense LN sections repeat errors and shift the pairing), but by implied press time plus error value, so whole rows no longer flip class.
- **V1 merge rule matches the client**: `|head error| + |tail error| <= window*rate*2` (rate 1.2/1.1), and a release way too early is a miss.
- **30ms miss grace**: late `hitErrors` / key events can still claim a note at the window edge.

- **ScoreV2 mass revert fixed**: ScoreV2 recalculates the score on every judgement, so releasing a hold early (re-judged as a miss) makes `play.score` dip slightly. The old restart detector treated that as a retry and called `resetJudgements()`, reverting every rendered note (including unrelated nearby LNs) to the unjudged colour. Restart detection now only looks at the hit counters (31 false resets per 164s run -> 0).
- **ScoreV2 hold release fixed**: the client divides the release offset by 1.5 before comparing it with the windows, and caps the tail at MEH when the head was missed; we compared the raw offset, so dense LN tails came out one class too harsh. Live counts vs the result now differ by L1 106 (was 620), notes with a different tail class 656 -> 182.

- **Stale replay verdicts can no longer short-circuit invalidation**: an applied exact result no longer blocks restart / rewind detection (a quick retry now drops the previous .osr verdict), and switching the judgement source mid-play clears whatever the previous mode set up.
- **Visible-window cursor invalidates with reviewTime / scroll speed**: notes that already crossed the hit line used to stop drawing in bulk (520 missing frame-draws in 60 frames); the cursor now resets when the scroll mapping is rebuilt.
- **Old caches are not reused**: RUN_VERSION is now 5 after the exact judgement rewrite, so replaying an old map no longer shows matches cached by the previous algorithm; stored runs are pruned by timestamp (newest 30).
- **Offset calibration is ~5x faster**: exactOffsetFor 438ms -> 83ms (two-phase search plus a sampled fitExactOffset), so long maps no longer freeze for half a second at the start.
- **Helper hardening**: 8MB cap on LZMA output, 24-entry osrCache bound, SSE heartbeat and dead-client cleanup, /live keys clamped to 1..18, explicit spawn / EADDRINUSE errors, and no-Origin requests are rejected.
- **Result-level tests for the exact judge model**: window boundaries, V1 merged long notes, V2 head/tail split, late release losing only the tail, `exactOffsetFor` calibration and end-to-end `applyExactTimeline` counts are now asserted (unit tests 92 → 112).
- **The end-to-end replay test no longer passes silently**: a missing `MRM_MAP_INDEX` prints SKIP and exits with code 2, and the helper process is killed instead of being left behind.
- **Analyzer clock fixed**: the analyzer no longer calls `setTime()` a second time after `onV2()` already applied the song time (`dt == 0` used to pin `timeSpeed` to 1, so the DT branch was never exercised).

- **Connection and stream stalls**: websockets use `wss` when the page is https, reconnect with exponential backoff, and tosu `error` payloads are no longer swallowed; `getSettings` is re-sent after a tosu restart; a 2.5s gap in v2 no longer clears the screen (5s stale-stream freeze + status hint) and judgements resume intact.
- **Window tables and replay lookup**: the lazer `hitWindow` payload is only accepted when all five windows are present, otherwise the OD table is used; the helper now finds osu!lazer replays by reading the beatmap md5 from the `.osr` header.
- **Tests**: the "hook clock resyncs ..." assertion is strict now (after a 2s stall the mapping only advances by the 1ms hook delta) instead of being vacuously true.

- **HT/DT replay windows**: replay judgement windows are now scaled by `rate` (HT ×0.75, DT ×1.5), removing the extra perfects on HT replays; note-level L1 776 → 44 on the same HT + V1 recording.
- Tests: `node test/mrm-test.mjs` 115/115.

- P3 cleanup: removed dead code (`lockPoint`, `state.tailIndex`, `state.exactOffset`), added null guards and input clamps, `unstableRate` no longer double-counts V1 long-note tails and is cached for 250ms, the `rev` signature now covers every visual setting, `sweepMisses` is no longer throttled by `fpsLimit`, beatmap fetches use a protocol-relative URL, and a new play clears the previous run's counters.
- Tooling/docs: helper `.cfg` cache expires after 30s, `/replay` 500 responses are sanitised, `key-hook.ps1` caches its compiled assembly in `%TEMP%\mrm-keyhook` (hook ready in < 50ms after the first spawn), `stop-helper` reports honestly, the README OBS URL matches the folder name, `mrm-live-monitor` sends the `applyFilters:` prefix, and `mrm-live-check` exits non-zero on failure.
- Tests: `node test/mrm-test.mjs` 115/115; the two 1x recordings show identical judgement numbers before/after.

Measured by replaying the same V1 recording against the game result: live note-level L1 448 → 68, notes with a different head class 1195 → 264 (tails 884 → 194), `|dE| <= 5ms` 5.7% → 80.3%, colour latency p95 171.4 → 111.2ms.

Tests: 112/112 unit assertions pass; `node test/ln-analyze.mjs --session ln-logs/session-v1-1` and `--session ln-logs/session-ln3` reproduce the numbers above.

---

# Mania Replay Master v0.5.3 — Update Notes

This patch fixes notes that stayed in the unjudged colour (`#8fa3c8`) after crossing the judgement line:

- **Judgement credited to a later note after a stall**: `renderTime()` no longer extrapolates from a time sample older than 250ms. A precise-stream gap (>120ms) or a song-time jump (>250ms) switches the next 500ms of hitErrors to note-order matching, so a delayed error can no longer steal a later note's judgement.
- **Lane-4 elimination without real key hints**: the "unexposed column" elimination now only runs after a real per-column hint has been observed (`keyHintSeen`). stable mania reports all-zero key slots, which previously forced ambiguous hits onto the assumed hidden column.
- **Stale-clock fallback**: if the implied hit time is more than 260ms ahead of the earliest unjudged note and no miss is pending, the hit is matched in note order.

Tests: 92/92 unit assertions pass.

---

# Mania Replay Master v0.5.2 — Update Notes

This is a patch release on top of v0.5.1, addressing three issues:

- **Notes missing after small rewinds in replays**: the render cursor was only reset on jumps larger than 1.5 seconds, so notes inside a short rewind were skipped; it now resets on any backward jump.
- **Live timing bias**: the hook clock used to be anchored once on the first key event, permanently recording that event's delay; it now advances event-to-event and resyncs to the game clock on stalls or large deviations.
- **Live judgements now follow the game's `hitErrors`**: the keyboard hook only picks the lane, and the game's exact error overrides the tentative value, so colours, action markers and UR match the game (removing the offset caused by the plugin's time base).

Tests: 92 unit assertions and 6 replay end-to-end assertions pass. The helper and usage are unchanged from v0.5.1.

---

# Mania Replay Master v0.5.1 — Update Notes

This update focuses on one long-standing issue: **judgement colours on chords (multiple notes falling in the same row) frequently did not match the keys you actually pressed**. It also fully separates "analyze while playing" from "analyze while watching a replay", and turns the exact-mode helper into a double-click tool that cleans up after itself.

> **The exact-mode helper is now a double-click tool:**
> Start it with `tools\start-helper.bat`, stop it with `tools\stop-helper.bat`. It detects your osu! install folder automatically and exits on its own when osu! / tosu closes. **On 5K–10K, enabling it is strongly recommended** — see "Using the exact-mode helper (important)" below.

## Highlights

- **Chords no longer get scrambled**
  Fixed reversed press/release handling: a key press never matched a note, so the judgement actually happened on release and the hold time was added to the error. This caused chaotic chord colours and could turn the lane you pressed into a MISS. Presses now judge note heads and releases judge hold tails, matching the osu! client.

- **Keys only hit the earliest unjudged note in their lane**
  This matches the client's note lock behaviour, so a press no longer lands on a neighbouring or later note. Streams and stacked chords are more reliable.

- **More accurate key timing**
  Uses a more accurate press time (keyboard event time, calibrated against the in-game clock), so MAX / 300 colours no longer flip around due to latency.

- **DT / HT hit windows corrected**
  Hit windows now scale with the actual rate; stable and lazer both match the game.

- **Live play no longer applies the previous run's replay**
  Previously the overlay could apply the last run's replay data while you were playing, which ignored your inputs and scrambled the judgements. Now:
  - Play analysis uses only real-time keys and never reads replay files;
  - Replay analysis reads only the current replay file, pre-renders the whole run at map start, and never listens to the keyboard.

- **Stats reset on replay restart / rewind**
  The stats panel and UR now follow the replay position instead of showing the previous run's final numbers.

- **Cleanup after the game closes**
  Closing osu! no longer leaves the overlay stuck in the "playing" state.

## New Analysis Mode

`Analysis Mode` has been added to the tosu settings:

| Mode | Use case |
| --- | --- |
| Auto (default) | Switches automatically: real-time keys use play analysis, otherwise replay analysis |
| Live | Always real-time judgement; best for practice and normal play |
| Replay | Always pre-render from the replay file; best for review sessions |

Keep Auto if unsure; if it occasionally misjudges, pin it to the mode you are actually using.

## Using the exact-mode helper (important)

**For precise per-lane judgements — especially on 5K–10K — turn the helper on.** It takes two steps:

1. Double-click `tools\start-helper.bat`. It runs hidden and **detects your osu! install folder automatically** — no path needed;
2. Double-click `tools\stop-helper.bat` to stop it, or simply leave it alone: it watches `osu!` and `tosu` and shuts down automatically once either one is closed (plus a 10-minute idle timeout).

No autostart setup and no resident background process.

osu! does not expose per-lane key data to third-party tools, so precise per-lane attribution requires the helper to read local keyboard input. **On 5K–10K, enabling the helper is strongly recommended. On 4K it is optional — without it, chords may occasionally be attributed to the wrong lane.**

## Notes

- The first viewing of a replay builds judgements as it plays; after one full watch, re-watching, looping or seeking shows everything instantly.
- osu!mania only; the overlay hides automatically in song select, menus and results.
- The helper listens on `127.0.0.1` only, supports an access token, and does not send data anywhere.

## Feedback

If a judgement still looks wrong, please include: client (stable / lazer), key count, mods, whether the helper was running, Analysis Mode, and a screenshot or clip if possible.
