# v0.5.4

This release is mostly bug fixes: replay judgement colouring now matches the game result, and live mode no longer drops its colours or misplaces judgements on dense long-note charts.

## Fixes

- **Replay judgements did not match the game result**: on long-note-heavy charts many notes were coloured incorrectly. Rewrote the replay judgement matching (per-column ordered matching, merged head/tail judgement for V1, separate head/tail for ScoreV2, auto-fitted time offset). Judgements now match the game.
- **ScoreV2 colours fell back to unjudged**: releasing a long note early turns it into a miss and the score drops slightly, which the old build mistook for "the run restarted" and cleared every judgement — the whole overlay flashed back to grey. A run now only restarts when the judgement count drops.
- **Long-note tails were stolen**: a release could close a long note that had not started yet, which shifted judgements in dense LN sections. A release now only closes the long note actually held.
- **Judgement class was not refreshed**: a ScoreV2 tail that arrived first was permanently downgraded and never recalculated when the head was judged.
- **HT/DT replays looked too bright**: replay windows were not scaled by rate, so many 300s were judged as MAX under HT. Windows now scale by 0.75x / 1.5x, matching live mode.
- **Notes were not drawn**: increasing "review time" or slowing the scroll made notes past the judgement line stop drawing entirely.
- **Misses appeared late at low FPS**: miss judgement and stream-stall detection were throttled by the FPS cap. They now run before the throttle.
- **Stale replay cache**: caches produced by the old judgement model are no longer reused.

## Improvements

- Exact mode no longer stutters at chart start (faster time-offset search).
- The keyboard hook caches its compiled assembly, so it is ready much faster after the helper restarts.
- `unstableRate` no longer double-counts V1 long notes.
- Smaller fixes: out-of-range alpha/stroke values, leftover counters from the previous run, and settings changes not triggering a redraw.

## Security

- The helper only accepts requests from loopback pages; external pages and requests without a loopback Origin are rejected.
- Optional `--token` check with constant-time comparison.
- The keyboard hook still stops 10 seconds after the last client disconnects; SSE now has heartbeats and no longer leaves zombie connections.
- Parse failures no longer return local paths or stack traces to the page.

## Tooling and docs

- The OBS URL in `README` has been updated (the old folder name returned 404).
- `stop-helper` now reports honestly whether the helper was running.
- `mrm-live-monitor` sends the command prefix tosu expects; `mrm-live-check` exits with code 1 on failure.
- Unit tests grew from 92 to 115 assertions, including result-level coverage for the replay judgement model.

## Known limitations

- **5K and above**: tosu only exposes 3–4 columns, so column attribution relies on the helper's keyboard hook; without the helper you need the small `maniaKeys` patch for tosu (see `tools/tosu-mania-keys-patch.md`).
- **Miss colours are still slightly delayed**: the game only reports hit errors, so a miss only shows after the judgement window expires (about 165 ms at OD 8.5).
- **Refresh after updating**: browsers and OBS cache `main.js`, so refresh the plugin page or the OBS browser source after upgrading.
