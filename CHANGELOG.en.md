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
