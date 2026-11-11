# gentle-shell-job-watchdog

A [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) (Pi) extension that keeps an idle orchestrator informed while one of its background jobs keeps running: a check-in 20 minutes into an untagged first attempt, then every 20 minutes while the job is alive, and exactly **one** instruction to stop the job with `job_stop` at 180 minutes of the attempt's own clock — then silence, forever.

Upstream motivation: [gentle-shell#3086](https://github.com/Gentleman-Programming/gentle-shell/issues/3086).

## Why

A background job launched with `bash_background` can be *finite but stuck*: it will eventually exit, yet for hours the agent that launched it is done with its turn and simply waits. Nothing wakes the orchestrator, the user stares at a session that looks finished, and the job can burn CPU (or run long Node test suites) while nobody looks at it.

This extension closes that gap from outside the job loop:

1. It observes `bash_background` job starts and job ends (via `job_stop` tool results and the native `gentle-jobs.notice` messages).
2. Its timers `sendMessage` self-contained **steer** messages with `triggerTurn: true`, which wake the orchestrator model so it can inspect the job (`job_list`, the output file) and decide: keep waiting, stop it, fix and relaunch, or anything else.
3. The extension never stops, kills or emits anything to the job itself — see [Limitations](#limitations-and-accepted-risks).

## What it does, exactly

| Event | What the watchdog does |
|---|---|
| A `bash_background` **command** job starts | Its 180-minute clock starts. Silent. |
| First attempt, **untagged** | **Check-in at 20 minutes** of the job's own clock. |
| While the job keeps running | A check-in **every 20 minutes** (40, 60, …, 160 min). |
| A relaunch whose **explicit label** contains `[wd:<chainId>#2]` | First check-in at **10 minutes** (that tighter follow-up is the whole point of tagging a relaunch), then every 20 minutes. It keeps its **own 180-minute clock**, independent of attempt 1's. |
| The job reaches **180 minutes** of its attempt's clock without finishing | **Exactly ONE** message instructing the orchestrator to stop it with `job_stop` **now**, without asking the user. No reminders. If the job keeps running after that, the watchdog sends **nothing ever again** (accepted risk). |
| A job labeled `[wd:<id>#3]` or higher starts | Refused as its own act: **one** immediate stop instruction to the model plus **one user notice**, and that job is never watched. There is no third attempt. |
| An attempt ≥ 2 that is linked by a tag is **stopped** | One user notice: the chain is closed, there is no third attempt. |
| The job ends (via `job_stop` or a `gentle-jobs.notice`) | All of its timers are cancelled; no stop instruction if it already exited. |
| `monitor` kind jobs | Ignored entirely — monitors have their own native mandatory timeout. |
| Child sessions (`GENTLE_PI_AGENTS_CHILD=1`) | The extension registers nothing at all: it is parent-session only. |
| Session start / shutdown | Every timer is cleared and all chain tracking state is reset; nothing persists to disk. |

Every check-in and stop message is **self-contained** (the model can act from it alone: job id, label, elapsed time, concrete options; check-ins also include the output file) and **self-invalidating** ("if `job_list` no longer shows it running, ignore this message").

### How an attempt 2 gets linked

The watchdog only trusts an attempt tag present in a **label the user (or model) explicitly passed** to `bash_background` and that differs from the command text — command text never claims an attempt identity. The relaunch flow looks like:

```text
1. Attempt 1 (untagged): checks at 20, 40, ..., 160 min; at 180 min the
   watchdog sends ONE "stop it with job_stop now" instruction.
2. The model stops it, fixes whatever was wrong, and relaunches with an
   explicit label such as:
       bash_background(command="npm run build", label="[wd:ci#2] retry build")
3. Attempt 2 is first checked after 10 minutes, then every 20 minutes, with
   its own fresh 180-minute limit.
```

`[wd:ci#1]`-style tags on a first attempt are honored as declared (with a user notice that the chain was not previously tracked here — e.g. after a session restart). A tag duplicated or stale (e.g. a second job also claiming `#2`) is reported to the user with a notice, and the job is watched as its own new job rather than double-counted in the named chain.

### Timeline

At most two attempts per chain:

| Moment | Attempt 1 — untagged, or explicitly `[wd:<id>#1]` | Attempt 2 — only when the relaunch labels itself `[wd:<id>#2]` |
|---|---|---|
| 0 min | job starts; watchdog is silent | relaunch starts its own 180-minute clock |
| First check-in | 20 min | 10 min (failures repeat quickly) |
| Cadence | check-in every 20 min while the job keeps running | check-in every 20 min while the job keeps running |
| 180 min | exactly ONE "stop it with `job_stop` now" instruction, then silence forever | exactly ONE "stop it with `job_stop` now" instruction, then silence forever |
| Chain closed | — | when attempt 2 ends the user is notified; no attempt 3 exists, a tag claiming it is refused immediately |

## Limitations and accepted risks

Read this before relying on the watchdog.

- **The 180-minute stop depends on the model obeying.** A standalone extension cannot call `job_stop` from a timer — the native job registry is private to the Gentle Shell runtime. The 180-minute message is an instruction; if the model does not carry it out, the job keeps running and the watchdog stays silent (by design, one instruction only). This is the accepted trade-off for not patching the host.
- **Parent session only.** Jobs started inside subagent/child sessions are never watched; the extension skips child sessions entirely, and agents only get `bash_background` when their agent definition declares it anyway.
- **Attempt linking is by label tag** (`[wd:<chainId>#2]`) until Gentle Shell exposes a native parameter to name an attempt. A relaunch with no tag (or with the tag only in the command text) is watched as a brand-new first attempt: 20-minute first check-in, its own 180-minute clock — safe, but without the 10-minute early check.
- **Monitors are ignored.** `monitor`-kind jobs keep their native mandatory timeout.
- **Version coupling.** The extension matches Gentle Shell's internal `gentleJobs` details shape (on `bash_background` / `job_stop` tool results) and the `gentle-jobs.notice` message type. Tested against **gentle-pi / Gentle Shell 4.7.0 and Pi 1.5.0**; a host update that changes those internals can break it silently (worst case: no notices at all).
- **Each check-in costs a model turn.** Every wake makes the orchestrator spend a turn inspecting the job. For many long jobs in one session this is intentional traffic, but it is not free.
- **What is over is over.** After the single 180-minute stop instruction there are no reminders, no escalations, and no persistent record: restart the session and all tracking state is gone.

## What was actually tested

Honesty about the evidence:

- **Live-tested (real environment):** the extension was installed in `~/.pi/agent/extensions/` on Gentle Shell 4.7.0 / Pi 1.5.0, and a real background job's **20-minute check-in did wake the orchestrator** with a steer message. The longer behaviors (180-minute stop, tagged attempt 2 with its 10-minute check) were **not** observed live — nobody ran a stuck job for 3 hours — they are covered by unit tests only.
- **Unit-tested (`npm test`, no install needed):** the full timeline of one and two attempts, the single stop instruction, timers cancelled on every ending path, monitors and child sessions ignored, tag validation (command text that merely contains a tag never links), stale/duplicate/unknown chains, and timer/state cleanup on session start and shutdown. All tests run through the extension's public interface against a fake Pi API and a fake clock; no real jobs, no network.

## Requirements

- Gentle Shell (Pi) with a version whose background jobs emit the `gentleJobs` details and `gentle-jobs.notice` messages described above (tested with 4.7.0 / Pi 1.5.0).
- Node.js is only needed to run the tests: Node **22.18+** (or 23.6+ / 24) with native TypeScript type stripping; no `npm install`, no dependencies.

## Install

Two ways to install.

### From git (once you have published the repository)

```bash
pi install git:github.com/zhalker/gentle-shell-job-watchdog@v0.1.0
```

(Git tags are pinned; `pi list` shows it, `pi update --extensions` reconciles the checkout. See the Pi packages documentation for npm publishing, `pi -e` trial runs, and settings scopes.)

### Manual copy

Copy the whole `gentle-shell-job-watchdog/` directory into your global extensions directory:

```text
~/.pi/agent/extensions/gentle-shell-job-watchdog/
├── package.json        ← this manifest points at the extension entry below
├── extension/index.ts
├── tests/…
└── README.md
```

The `pi` manifest in `package.json` (`"extensions": ["./extension/index.ts"]`) is what Pi loads in discovery mode; you do not need `npm install`.

### Activation

Restart the terminal / start a fresh Pi session: the extension loads at session start, registers its event handlers, and starts watching from the next `bash_background` job. Do not rely on `/reload` to reimport a changed extension — prefer restarting the session.

### Uninstall

- If installed with `pi install`: `pi remove git:github.com/zhalker/gentle-shell-job-watchdog`.
- If copied manually: delete the directory under `~/.pi/agent/extensions/`.

There is no persisted state anywhere (no session entries, no files), so there is nothing to clean up beyond the package itself.

## Run the tests

From the package directory (or from inside the extracted ZIP):

```bash
npm test
```

16 tests must pass, with no dependencies to install (Node type stripping, `node --test`).

## Release history

- **v0.1.0**: first public release. Source package for [gentle-shell#3086](https://github.com/Gentleman-Programming/gentle-shell/issues/3086), MIT licensed, published to npm as [`@zhalker/gentle-shell-job-watchdog`](https://www.npmjs.com/package/@zhalker/gentle-shell-job-watchdog) and tagged on GitHub so `pi install` pins it.

Install with `pi install git:github.com/zhalker/gentle-shell-job-watchdog@v0.1.0`, or `pi install npm:@zhalker/gentle-shell-job-watchdog` once published to npm, or the manual copy described above — and restart the session.

## License

MIT — see [LICENSE](LICENSE).
