---
name: as-pipeline-watch
description: Watch a Bitbucket pipeline and report its outcome.
argument-hint: "[repo-slug] [build-number | branch]"
allowed-tools: mcp__plugin_atlassian-suite_acendas-atlassian__watch_pipeline, mcp__plugin_atlassian-suite_acendas-atlassian__get_pipeline, mcp__plugin_atlassian-suite_acendas-atlassian__list_pipeline_steps, mcp__plugin_atlassian-suite_acendas-atlassian__list_pipeline_step_test_cases, mcp__plugin_atlassian-suite_acendas-atlassian__get_pipeline_step_log, Monitor, ToolSearch, PushNotification, Bash(git remote get-url:*), Bash(git branch --show-current)
---

# Watch a Bitbucket Pipeline

Starts a background watch on one pipeline run, so the user can keep working. Each finished step arrives as a notification. The last line carries the outcome, and you report it.

## Inputs

`$1` = Repo slug. Default: parse `git remote get-url origin` when it is a bitbucket.org remote (`bitbucket.org[:/]<workspace>/<slug>(.git)`), and pass that workspace too.
`$2` = What to watch. Digits or a `{uuid}` → that run. Anything else → a branch; watch its latest run. Default: the current branch (`git branch --show-current`).

If a run was triggered earlier in this conversation, watch that build number. Ask only when no repo can be found.

## Steps

1. Call `watch_pipeline(repo_slug: …, pipeline: …)` or `watch_pipeline(repo_slug: …, branch: …)`.
   - An error comes back → report it and stop.
   - `terminal: true` → the run already finished. Skip to step 4 with its `summary`.
   - `credentials_note` is present → pass it on once.
2. Start the watch. If Monitor isn't loaded, load it with `ToolSearch` (`select:Monitor`). Call Monitor with `command` = `monitor_command` exactly as returned, `description` = `monitor_description`, and `timeout_ms: 1800000`.
   - Tell the user in one line what you're watching, where it stands now (`summary`) and its `url`, and that you'll report when it ends. Then hand control back.
   - If this session has no Monitor tool, run the same command with Bash `run_in_background: true` instead. You get one notification when it exits; read its last line.
3. While it runs:
   - Each step line (`step "Build" SUCCESSFUL (1m02s)`, `step "Test" FAILED (5m30s)`) → relay it as one line, as it arrives. Lead with a FAILED one; the run may keep going.
   - The Monitor expires before a final line arrives → re-arm it with the same command. Each Monitor lasts at most 30 minutes. The watcher prints the current state when it restarts, including any step that failed in between (`failed so far: …`); relay that too.
4. The watch ends on exactly one final line:

   | Final line | Meaning |
   |---|---|
   | `DONE SUCCESSFUL` / `FAILED` / `ERROR` / `STOPPED` / `EXPIRED` | The run finished |
   | `DONE PAUSED` | Waiting on a manual step. It can wait forever, so the watch stops |
   | `WATCH_ERROR` | The watcher couldn't read the run (credentials, not found, network). Outcome unknown |
   | `WATCH_TIMEOUT` | The watch's time limit ran out (`max_minutes` from the `watch_pipeline` call, 240 by default; re-arms share it). Outcome unknown |

   If the command exits without one of these, the outcome is also unknown.
5. Before you report a `DONE` outcome, confirm it with `get_pipeline`. That call is the authority; a Monitor line is only a notification.
6. Report, leading with the outcome:
   - SUCCESSFUL → `afm-app #5956 passed in 12m03s` and the url.
   - FAILED / ERROR → use `list_pipeline_steps` to find the failed steps, then `list_pipeline_step_test_cases(status: "FAILED")` for each one. Name up to 5 failing tests with the first line of each reason. If a step has no test report, quote the last ~30 lines of `get_pipeline_step_log` instead. Offer to dig in.
   - STOPPED → who stopped it. PAUSED → which manual step is waiting; the user triggers it in Bitbucket.
   - WATCH_ERROR / WATCH_TIMEOUT → say the outcome is unknown and why, and offer to watch again.
7. Notify. If the run took more than about 5 minutes, or the user asked to be told, also send `PushNotification` with one line that leads with the outcome, e.g. `afm-app #5956 FAILED: 2 tests in "Build + test"`. Load it with `ToolSearch` (`select:PushNotification`) if needed. If it isn't available, skip it without comment.

## Notes

- Read-only. This skill never stops, re-runs or triggers a pipeline.
- Watch from the main session, which is the one the user sees. A subagent should return the build number and point here.
- Covers Bitbucket Pipelines only. External CI (Jenkins etc.) that posts commit build statuses is not watched.
- The watcher reads credentials from `~/.acendas-atlassian/config.json` or the shell's env. None go on the command line.
- It polls every 30 s, and each poll is 2 API calls. So a step line can lag its step by up to 30 s, and steps that finish in the same poll arrive together. Pass `interval_seconds` to slow it down for very long runs.
- The Bash fallback reports only the final line: no per-step notifications.
