// Tests for the standalone background-job watchdog extension (issue #3086).
// Everything runs through the extension's public interface — the default
// factory plus the Pi events it registers — against a fake ExtensionAPI and
// a fake clock; no real job, no network, no installed package. All times are
// in minutes of an attempt's own clock, which starts at the tool_result that
// observed the job.

import assert from "node:assert/strict";
import { test } from "node:test";

import createExtension from "../extension/index.ts";
// The extension is self-contained, so the constants come from extension/policy.ts itself.
import { ATTEMPT_LINK_PATTERN, CHECK_INTERVAL_MS, FIRST_CHECK_MS, HARD_LIMIT_MS, MAX_ATTEMPT, RELAUNCH_FIRST_CHECK_MS, parseAttemptLink } from "../extension/policy.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { type FakeSentMessage, setupFakePi } from "./helpers/fake-pi.ts";

const MIN = 60_000;

interface SetupEnv {
	emit(event: string, payload?: unknown): void;
	sent: FakeSentMessage[];
	userNotices: Array<{ text: string; level: string }>;
	clock: FakeClock;
	handlerCount(): number;
}

function setup(env: Record<string, string> = {}): SetupEnv {
	const { pi, emit, sent, userNotices } = setupFakePi();
	const clock = new FakeClock();
	createExtension(pi as never, { env, now: clock.now, schedule: clock.schedule });
	return { emit, sent, userNotices, clock, handlerCount: () => pi.handlerCount() };
}

interface StartOptions {
	jobId?: string;
	label?: string;
	command?: string;
	kind?: string;
	outputPath?: string;
}

interface SentMeta {
	kind?: string;
	jobId?: string;
	outputPath?: string;
	chainId?: string;
	attempt?: number;
}

function meta(sent: FakeSentMessage): SentMeta {
	return ((sent.message.details as { watchdog?: SentMeta } | undefined) ?? {}).watchdog ?? {};
}

function ofKind(sent: FakeSentMessage[], kind: string): FakeSentMessage[] {
	return sent.filter((s) => meta(s).kind === kind);
}

function startEvent(options: StartOptions = {}): Record<string, unknown> {
	const jobId = options.jobId ?? "job-1";
	const command = options.command ?? `node test-${jobId}.js`;
	const label = options.label ?? command;
	return {
		toolName: "bash_background",
		toolCallId: `call-${jobId}`,
		input: { command, ...(options.label === undefined ? {} : { label: options.label }) },
		details: { gentleJobs: { jobId, kind: options.kind ?? "command", label, status: "running", exitCode: null, outputPath: options.outputPath ?? `${jobId}.log` } },
	};
}

function stopToolEvent(jobId: string, options: { outputPath?: string; status?: string } = {}): Record<string, unknown> {
	return {
		toolName: "job_stop",
		toolCallId: `stop-${jobId}`,
		input: { job_id: jobId },
		details: { gentleJobs: { jobId, kind: "command", label: jobId, status: options.status ?? "stopped", exitCode: null, outputPath: options.outputPath ?? `${jobId}.log` } },
	};
}

function noticeEvent(jobId: string, status: string, options: { outputPath?: string; kind?: string } = {}): Record<string, unknown> {
	return {
		message: {
			role: "user",
			customType: "gentle-jobs.notice",
			content: `Background job ${jobId} ${status}.`,
			display: true,
			details: { gentleJobs: { jobId, kind: options.kind ?? "command", label: jobId, status, exitCode: 0, outputPath: options.outputPath ?? `${jobId}.log` } },
		},
	};
}

function startJob(env: SetupEnv, options: StartOptions = {}): void {
	env.emit("tool_result", startEvent(options));
}

function stopJob(env: SetupEnv, jobId: string, options: { outputPath?: string; status?: string } = {}): void {
	env.emit("tool_result", stopToolEvent(jobId, options));
}

function jobsNotice(env: SetupEnv, jobId: string, status: string, options: { outputPath?: string; kind?: string } = {}): void {
	env.emit("message_end", noticeEvent(jobId, status, options));
}

test("constants and tag parsing match the documented policy", () => {
	assert.equal(FIRST_CHECK_MS, 20 * MIN);
	assert.equal(RELAUNCH_FIRST_CHECK_MS, 10 * MIN);
	assert.equal(CHECK_INTERVAL_MS, 20 * MIN);
	assert.equal(HARD_LIMIT_MS, 180 * MIN);
	assert.equal(MAX_ATTEMPT, 2);
	assert.deepEqual(parseAttemptLink("[wd:ci-1#2] retry"), { chainId: "ci-1", attempt: 2 });
	assert.equal(parseAttemptLink("no tag"), undefined);
	assert.match("[wd:a-b_1#12]", ATTEMPT_LINK_PATTERN);
	assert.doesNotMatch("[wd:a b#2]", ATTEMPT_LINK_PATTERN);
});

test("child session: the extension registers nothing and sends nothing", () => {
	const env = setup({ GENTLE_PI_AGENTS_CHILD: "1" });
	assert.equal(env.handlerCount(), 0);
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 0);
});

test("attempt 1: no wake before 20m, one check at 20m, then every 20m, exactly one stop instruction at 180m, nothing afterwards", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node build.js" });

	env.clock.advance(20 * MIN - 1);
	assert.equal(env.sent.length, 0);
	env.clock.advance(1);
	assert.equal(env.sent.length, 1);
	assert.equal(meta(env.sent[0]!).kind, "check");
	assert.equal(meta(env.sent[0]!).jobId, "job-1");
	assert.equal(env.sent[0]!.options.deliverAs, "steer");
	assert.equal(env.sent[0]!.options.triggerTurn, true);
	// Self-contained: the model must be able to act from this message alone.
	const check = env.sent[0]!.message.content;
	assert.match(check, /job-1/);
	assert.match(check, /20 minutes/);
	assert.match(check, /job_stop/);
	assert.match(check, /\.log|outputPath|Output/);
	// Self-invalidating: a stale message must be ignorable.
	assert.match(check, /no longer shows.*running|ignore this message/);

	const checksAt = (minutes: number): number => {
		env.clock.advance(minutes * MIN);
		return env.sent.length;
	};
	assert.equal(checksAt(20), 2); // 40m
	assert.equal(checksAt(20), 3); // 60m
	assert.equal(checksAt(20), 4); // 80m
	assert.equal(checksAt(20), 5); // 100m
	assert.equal(checksAt(20), 6); // 120m
	assert.equal(checksAt(20), 7); // 140m
	assert.equal(checksAt(20), 8); // 160m
	assert.ok(meta(env.sent[7]!).kind === "check");

	// Nothing at 179m59s; exactly one stop instruction at 180m.
	env.clock.advance(19 * MIN + 59_000);
	assert.equal(env.sent.length, 8);
	env.clock.advance(1_000);
	assert.equal(env.sent.length, 9);
	const stop = env.sent[8]!;
	assert.equal(meta(stop).kind, "stop");
	assert.equal(meta(stop).jobId, "job-1");
	assert.equal(stop.options.deliverAs, "steer");
	assert.equal(stop.options.triggerTurn, true);
	assert.match(stop.message.content, /job-1/);
	assert.match(stop.message.content, /180 minutes/);
	assert.match(stop.message.content, /job_stop/);
	// One instruction only, explicitly no follow-up.
	assert.match(stop.message.content, /nothing more/);

	// The job keeps running: nothing more is ever sent (accepted risk).
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 9);
	assert.equal(env.userNotices.length, 0);
});

test("a job stopped through job_stop before 180m is never asked to stop again", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node build.js" });
	env.clock.advance(20 * MIN);
	assert.equal(env.sent.length, 1);
	stopJob(env, "job-1", { status: "stopped" });
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 1);
	assert.equal(ofKind(env.sent, "stop").length, 0);
	assert.equal(env.clock.pendingCount(), 0);
});

test("a gentle-jobs.notice (exit) ends the attempt: no 180m stop instruction follows", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node build.js" });
	env.clock.advance(20 * MIN);
	assert.equal(env.sent.length, 1);
	jobsNotice(env, "job-1", "exited", { outputPath: "job-1.log" });
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 1);
	assert.equal(env.clock.pendingCount(), 0);
});

test("the watchdog's own steer messages are not mistaken for job notices", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node build.js" });
	env.clock.advance(20 * MIN);
	const echo: Record<string, unknown> = {
		message: { role: "user", customType: "background-job-watchdog.check", content: "watchdog check", display: true },
	};
	env.emit("message_end", echo);
	env.clock.advance(600 * MIN);
	// If the echo had ended the job there would be no stop instruction at 180m.
	assert.equal(ofKind(env.sent, "stop").length, 1);
});

test("monitors are never watched", () => {
	const env = setup();
	startJob(env, { jobId: "mon-1", kind: "monitor", command: "tail -f app.log" });
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 0);
	assert.equal(env.clock.pendingCount(), 0);
	jobsNotice(env, "mon-1", "stopped", { kind: "monitor" });
	assert.equal(env.userNotices.length, 0);
});

test("attempt 2 via explicit label tag: first check at 10 minutes and its own 180-minute clock", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", label: "[wd:ci#1] build", command: "npm run build" });
	env.clock.advance(10 * MIN);
	// Attempt 1 still checks at 20 minutes even when tagged.
	assert.equal(env.sent.length, 0);
	env.clock.advance(10 * MIN);
	assert.equal(env.sent.length, 1);
	assert.equal(meta(env.sent[0]!).jobId, "job-1");
	assert.match(env.sent[0]!.message.content, /attempt 1 of watchdog chain ci/);

	startJob(env, { jobId: "job-2", label: "[wd:ci#2] retry", command: "npm run build" });
	env.clock.advance(10 * MIN); // t = 30m; job-2 elapsed 10m
	assert.equal(env.sent.length, 2);
	assert.equal(meta(env.sent[1]!).jobId, "job-2");
	assert.match(env.sent[1]!.message.content, /attempt 2 of watchdog chain ci/);
	assert.match(env.sent[1]!.message.content, /10 minutes/);

	// job-2's own clock: checks at 30+20k minutes, stop at 200m.
	env.clock.advance(20 * MIN); // 50m: job-2 (30m, 50m) and job-1 (20m, 40m)
	assert.equal(env.sent.length, 4);
	env.clock.advance(129 * MIN + 59_000); // 179m59s
	// job-2 checks at 70..170 (6), job-1 checks at 60..160 (6)
	assert.equal(env.sent.length, 4 + 12);
	env.clock.advance(1_000); // 180m: only job-1's limit
	assert.equal(ofKind(env.sent, "stop").length, 1);
	assert.equal(meta(env.sent.findLast((s) => meta(s).kind === "stop")!).jobId, "job-1");
	env.clock.advance(20 * MIN); // 200m: job-2's own limit
	assert.equal(ofKind(env.sent, "stop").length, 2);
	assert.equal(meta(env.sent.findLast((s) => meta(s).kind === "stop")!).jobId, "job-2");
	env.clock.advance(600 * MIN);
	assert.equal(ofKind(env.sent, "stop").length, 2);
	// the only user notice is the unknown-chain notice for the first [wd:ci#1]
	assert.equal(env.userNotices.length, 1);
});

test("a tagged attempt 2 that is stopped closes the chain: the user is told and a later #3 tag is refused immediately", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", label: "[wd:ci#1] build", command: "npm run build" });
	startJob(env, { jobId: "job-2", label: "[wd:ci#2] retry", command: "npm run build" });
	env.clock.advance(30 * MIN);
	assert.equal(env.sent.length, 3); // job-2 at 20m(+10 elapsed), job-1 at 20m, job-2 at 30m

	stopJob(env, "job-2", { outputPath: "job-2.log", status: "stopped" });
	// [0] is the unknown-chain notice for the first [wd:ci#1]; [1] closes the chain.
	assert.equal(env.userNotices.length, 2);
	assert.match(env.userNotices[1]!.text, /ci/);
	assert.match(env.userNotices[1]!.text, /no third attempt|closed/);

	// A tagged #3 job is refused immediately: one stop instruction, one user notice, no timers.
	startJob(env, { jobId: "job-3", label: "[wd:ci#3] again", command: "npm run build" });
	assert.equal(env.userNotices.length, 3);
	assert.equal(ofKind(env.sent, "stop-third").length, 1);
	const third = env.sent.findLast((s) => meta(s).kind === "stop-third")!;
	assert.equal(meta(third).jobId, "job-3");
	assert.equal(third.options.deliverAs, "steer");
	assert.equal(third.options.triggerTurn, true);
	assert.match(third.message.content, /job-3/);
	assert.match(third.message.content, /job_stop/);
	assert.match(third.message.content, /no longer shows.*running|ignore this message/);
	// job-1 still has its own timers; job-3 got none.
	const pendingBefore = env.clock.pendingCount();
	assert.equal(pendingBefore, 2); // job-1 check (40m) + hard (180m)
	env.clock.advance(600 * MIN);
	assert.equal(ofKind(env.sent, "check").filter((s) => meta(s).jobId === "job-3").length, 0);
	assert.equal(ofKind(env.sent, "stop").length, 1); // only job-1's 180m instruction
	// job-1's remaining checks (40..160m, 7) plus its 180m stop instruction.
	assert.equal(env.sent.length, 3 + 1 + 8);
});

test("an unknown chain tag is honored as declared, with a user notice", () => {
	const env = setup();
	startJob(env, { jobId: "job-9", label: "[wd:fresh#2] resume build", command: "npm run build" });
	assert.equal(env.userNotices.length, 1);
	env.clock.advance(10 * MIN);
	assert.equal(env.sent.length, 1);
	assert.equal(meta(env.sent[0]!).jobId, "job-9");
	assert.match(env.sent[0]!.message.content, /attempt 2 of watchdog chain fresh/);
	assert.match(env.sent[0]!.message.content, /10 minutes/);
});

test("a tag inside command text or a label defaulted to the command never links an attempt", () => {
	const env = setup();
	const same = `echo "[wd:zz#2]" && npm run build`;
	startJob(env, { jobId: "job-4", label: same, command: same });
	assert.equal(env.userNotices.length, 1);
	assert.match(env.userNotices[0]!.text, /job-4/);
	env.clock.advance(10 * MIN);
	assert.equal(env.sent.length, 0); // not attempt 2: own chain, 20-minute first check
	env.clock.advance(10 * MIN);
	assert.equal(env.sent.length, 1);
	assert.equal(meta(env.sent[0]!).jobId, "job-4");
	assert.equal(meta(env.sent[0]!).chainId, undefined);
	assert.doesNotMatch(env.sent[0]!.message.content, /chain zz|attempt 2 of watchdog chain/);
});

test("a duplicate or stale tag is reported and the job is watched as its own new job", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", label: "[wd:ci#1] build", command: "npm run build" });
	startJob(env, { jobId: "job-2", label: "[wd:ci#2] retry", command: "npm run build" });
	// A second job claiming attempt 2 of the same chain is stale.
	startJob(env, { jobId: "job-5", label: "[wd:ci#2] retry again", command: "npm run build" });
	// [0] is the unknown-chain notice for the first [wd:ci#1]; [1] rejects the stale re-tag.
	assert.equal(env.userNotices.length, 2);
	assert.match(env.userNotices[1]!.text, /job-5/);
	env.clock.advance(10 * MIN); // t=10m: job-5 must not behave like attempt 2 (no 10-minute check)
	assert.equal(ofKind(env.sent, "check").filter((s) => meta(s).jobId === "job-5").length, 0);
	env.clock.advance(10 * MIN); // t=20m: job-1 check and job-5 check (both own 20-minute clocks)
	const job5Checks = ofKind(env.sent, "check").filter((s) => meta(s).jobId === "job-5");
	assert.equal(job5Checks.length, 1);
	assert.equal(meta(job5Checks[0]!).chainId, undefined);
});

test("attempts are keyed by outputPath: a reused job id does not cross-match", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node a.js", outputPath: "run-a/job-1.log" });
	env.clock.advance(1 * MIN);
	startJob(env, { jobId: "job-1", command: "node b.js", outputPath: "run-b/job-1.log" });
	env.clock.advance(1 * MIN); // t = 2m
	stopJob(env, "job-1", { outputPath: "run-a/job-1.log", status: "stopped" });
	env.clock.advance(19 * MIN); // t = 21m: only run-b's check (elapsed 20m)
	assert.equal(env.sent.length, 1);
	assert.equal(meta(env.sent[0]!).outputPath, "run-b/job-1.log");
	env.clock.advance(600 * MIN);
	// run-b: checks at 21..161 (8) + one stop at 181m; run-a: nothing.
	assert.equal(env.sent.length, 9);
	assert.equal(ofKind(env.sent, "stop").length, 1);
	assert.equal(meta(env.sent[8]!).outputPath, "run-b/job-1.log");
});

test("session_shutdown and session_start clear every timer and reset the state", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", command: "node a.js" });
	startJob(env, { jobId: "job-2", label: "[wd:ci#2] retry", command: "npm run build" });
	assert.equal(env.clock.pendingCount(), 4); // 2 checks + 2 hard
	env.emit("session_shutdown", { reason: "quit" });
	assert.equal(env.clock.pendingCount(), 0);
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 0);

	// session_start re-arms the extension: a new job is watched normally.
	env.emit("session_start", { reason: "resume" });
	startJob(env, { jobId: "job-3", command: "node c.js" });
	env.clock.advance(20 * MIN);
	assert.equal(env.sent.length, 1);
	env.emit("session_shutdown", { reason: "reload" });
	assert.equal(env.clock.pendingCount(), 0);
});

test("every message is a displayed steer with triggerTurn and watchdog details", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", label: "[wd:ci#1] build", command: "npm run build" });
	startJob(env, { jobId: "job-2", label: "[wd:ci#3] jump", command: "npm run build" });
	env.clock.advance(200 * MIN);
	for (const sent of env.sent) {
		assert.match(sent.message.customType, /^background-job-watchdog\./);
		assert.equal(sent.message.display, true);
		assert.equal(sent.options.deliverAs, "steer");
		assert.equal(sent.options.triggerTurn, true);
		assert.equal(typeof meta(sent).jobId, "string");
		assert.ok((meta(sent).jobId ?? "").length > 0);
		assert.equal(typeof meta(sent).outputPath, "string");
	}
});

test("a tagged attempt 1 whose chain is later continued ends in a refusal, not a third watch", () => {
	const env = setup();
	startJob(env, { jobId: "job-1", label: "[wd:ci#1] build", command: "npm run build" });
	jobsNotice(env, "job-1", "exited", { outputPath: "job-1.log" });
	startJob(env, { jobId: "job-2", label: "[wd:ci#2] retry", command: "npm run build" });
	jobsNotice(env, "job-2", "stopped", { outputPath: "job-2.log" });
	// [0] unknown-chain for [wd:ci#1]; [1] closes the chain on the stopped attempt 2.
	assert.equal(env.userNotices.length, 2);
	startJob(env, { jobId: "job-3", label: "[wd:ci#3] once more", command: "npm run build" });
	assert.equal(ofKind(env.sent, "stop-third").length, 1);
	assert.equal(env.userNotices.length, 3);
	env.clock.advance(600 * MIN);
	assert.equal(env.sent.length, 1);
});
