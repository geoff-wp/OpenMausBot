# Operational outcomes and result handoffs

An operational outcome is a registered set of postconditions attached to
existing bot conversations. It is not a new board or scheduler. Provider
settlement, result publication, message delivery, consumption, first work and
verified completion remain separate facts.

`GET /api/health` advertises `capabilities.taskOutcomes: 1`. Clients must not
fall back to ordinary messages or infer verified success on older servers.

## Register and verify

An authenticated administrator registers `POST /api/outcomes` before starting
the producing turn. The definition names its immutable id, kind (`task` or
`handoff`), label, producer and optional recipient bot/task ids, target
`revision`, `environment` and optional `configuration`, required `checks`,
first-work constraint and optional progress-warning interval. Every participant
must already exist and be unarchived. A task needs at least one check. A
handoff needs an exact recipient and declared first-work tool; wildcard tools
also require a resource/input match.

Registered checks are deliberately narrow:

- `artifact`: a relative file in the actual producing task's host workspace
  must have the expected SHA256. Symlinks, traversal and oversized files do
  not become passes. A guest resource is never replaced by the host folder.
- `git_head`: the actual registered host workspace HEAD must match the target
  revision and have no staged, modified or untracked files. Matching the commit
  alone does not verify changed working files as the registered candidate.
  Index entries that hide files through assume-unchanged or skip-worktree fail.
- `github_pr`: the live PR head and every configured required check must
  match/succeed. Missing or running checks are pending, never success.
- `http_json`: read the exact configured URL and parameters, without redirects,
  and compare its JSON pointer with the configured value (default: target
  revision). This can check the actual deployed manifest or another read-only
  postcondition; a standalone check on a different URL proves nothing.
- `attestation`: an independently authenticated trusted verifier supplies the
  actual check receipt. Native bot capabilities cannot register requirements
  or mint these receipts. A model PASS is not an attestation adapter.

Native producers get `get_outcome`, `publish_result`, `consume_result` and
`verify_outcome` in their common agents MCP catalog. One-hop delegates receive
only these outcome tools, without gaining peer communication or thread creation.
The bearer binds each operation to its actual bot, task and generation; caller
ids do not grant authority.

`publish_result` includes the current outcome/attempt/result ids, exact target,
verdict, summary and evidence. The evidence may be text, an array or an object;
supported JSON is normalized losslessly. Invalid inputs return specific fields
before delivery. Publication is sealed and idempotent. The host starts its
durable outbox while the producer is still working; producer idleness is not a
delivery prerequisite.

Delivery uses the existing guarded admission and stable send identity. A busy
recipient retains an owned wait. Unknown writes are reconciled before retry;
delivery cannot silently steer another task, change permissions or restore an
archived conversation. `consume_result` records acceptance in the exact
receiving execution. Ownership changes only after the declared successful
first-work action is observed in that request. Such an action can itself prove
consumption; no acknowledgment phrase or separate ceremonial turn is needed.

Host probes run through `verify_outcome` or the host's recovery controller.
Trusted integrations may record attestation checks with
`POST /api/outcomes/:id/verification`: current attempt, exact target, check id,
stable receipt id, actual `checkedAt`, status and evidence. The server assigns
the verifier identity from authentication. Retries cannot refresh the timestamp,
older observations cannot replace newer ones, and unknown results cannot erase
a known failure. Checks and prior snapshots live in `messages.db` and therefore
use the existing consistent backup/restore path.

An administrator advances an attempt with
`POST /api/outcomes/:id/advance` (`expectedVersion`, `target`), cancels it with
`.../cancel`, or retries a failed delivery with `.../retry`. A new attempt clears
old proof and publication while retaining earlier receipt history. Cancelled
attempts reject late callbacks. `GET .../history?before=VERSION` pages earlier
snapshots, fifty at a time.

## Honest completion and waiting

Native bot closure is refused for registered operational tasks whose required
current proof has not passed. Registered routine runs remain waiting after a
successful provider turn and settle when actual proof arrives. The original
proof wait survives restart; explicitly cancelling all registered outcomes
settles the run as cancelled, never completed. Waiting carries
the owner, reason, next action, resume trigger and last meaningful progress;
tokens and repeated unchanged checks do not reset that clock. Warnings never
impose a QA duration cutoff or automatically retry a person's denial.
An administrator may explicitly supply `producerRoutineRunId` and/or
`recipientRoutineRunId` at registration; the host validates each against the
actual active run on that task. Omitting them means ordinary work, even when a
routine waits in the same chat. Advance can explicitly change an association,
or clear it with `null`; omitted associations retain their previous binding.
Associations apply only to that actual run, including when later runs reuse its chat. A new
provider turn or open request cannot be mistaken for a settled proof wait.

The host appends trusted outcome-status projections to the transcript. These
remain visible with Tool calls disabled. An outcome-like string from an ordinary
tool is not trusted status. A model may end its turn with an honest incomplete
or blocked report; it need not hold a process open to keep the work owned.

Legacy delegation `done` still means the peer's turn ended and a reply arrived.
Its result/wake text explicitly requires checking the requested postconditions.
It is never promoted into a verified operational outcome by that status alone.
Existing permissions, project release authority and external service protections
remain authoritative. The app's outcome gate does not sandbox arbitrary shell
access or replace repository-side release checks.

## Permanent isolated checks

```sh
pnpm exec vitest run server/outcomes.test.ts server/outcome-probes.test.ts server/outcome-persistence.test.ts server/outcomes.e2e.test.ts server/routines.test.ts server/drivers/agents-outcomes.test.ts src/components/StatusActivityRow.outcomes.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The end-to-end suite launches the prescribed disposable `control-omb` server
and fake CLI only. It proves delivery before producer settlement, exact receiving
request pickup, no magic phrase, deduplicated publication, a failed actual
artifact despite claimed PASS, refused premature closure, native refusal to
mint verifier receipts, and retained failure history. Its exact requests and outcome snapshots are retained
beside the fixture log as `.log.outcomes.json`. It does not contact real models,
PowerPM or the user's running app.

Validate a newly installed release through the supported app update path and
pilot the same contract on the existing implementation/QA conversations before
enrolling further operational workflows. Do not copy a host's pairing credential
into a guest, change accounts to recover quota, or create duplicate writers.
