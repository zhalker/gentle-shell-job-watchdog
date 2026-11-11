// Background job watchdog — policy core (issue #3086).
//
// A standalone Pi extension cannot reach the native job registry (it is
// private to gentle-pi's gentle-agents.ts), so it can never stop a job
// itself. Instead its timers wake the orchestrator with self-contained
// steer messages:
//
//  - a check-in 20 minutes after an untagged first attempt starts, then every
//    20 minutes while it runs;
//  - an attempt linked ONLY by an explicit `[wd:<chainId>#2]` tag in a label
//    that was explicitly supplied (label ≠ command) is first checked at 10
//    minutes and keeps its own 180-minute clock;
//  - at 180 minutes of an attempt's own clock exactly ONE message instructs
//    the orchestrator to stop the job with job_stop now, without asking the
//    user. No repeats, no automatic retry; if the job keeps running after
//    that, nothing more is ever sent — the risk is accepted;
//  - a tagged attempt 3 (or higher) is refused: one immediate stop
//    instruction plus a user notice, and the job is never watched.
//
// Every message is self-contained (the model can act from it alone) and
// self-invalidating ("if job_list no longer shows it running, ignore this").

/** Check-in for a first attempt. */
export const FIRST_CHECK_MS = 20 * 60_000;
/** First check-in for a relaunch explicitly linked as attempt >= 2. */
export const RELAUNCH_FIRST_CHECK_MS = 10 * 60_000;
/** Ongoing check-in cadence. */
export const CHECK_INTERVAL_MS = 20 * 60_000;
/** Per-attempt limit: exactly one model-mediated stop instruction. */
export const HARD_LIMIT_MS = 180 * 60_000;
/** Attempts allowed per chain; a stopped attempt 2 closes the chain. */
export const MAX_ATTEMPT = 2;

/** Explicit attempt link inside a job label: `[wd:<chainId>#<n>]`. */
export const ATTEMPT_LINK_PATTERN = /\[wd:([A-Za-z0-9_-]+)#(\d+)\]/;

export interface AttemptLink {
	readonly chainId: string;
	readonly attempt: number;
}

/** Parses the explicit attempt link of a label, if present. */
export function parseAttemptLink(label: string): AttemptLink | undefined {
	const match = ATTEMPT_LINK_PATTERN.exec(label);
	if (!match) return undefined;
	return { chainId: match[1]!, attempt: Number.parseInt(match[2]!, 10) };
}

export type WatchdogNoticeKind = "check" | "stop" | "stop-third";

export interface WatchdogNoticeMeta {
	readonly kind: WatchdogNoticeKind;
	readonly jobId: string;
	readonly outputPath: string;
	readonly chainId?: string;
	readonly attempt?: number;
}

export interface WatchdogPolicyPorts {
	now(): number;
	/** The host timer scheduler; the extension wires setTimeout, tests a fake clock. */
	schedule(fn: () => void, ms: number): () => void;
	/** A wake message for the orchestrating model (steer + triggerTurn upstream). */
	sendModelMessage(kind: WatchdogNoticeKind, text: string, meta: WatchdogNoticeMeta): void;
	/** A notice for the user (chain closures, refused tags, identity warnings). */
	notifyUser(text: string): void;
}

/** A job start as observed from a `bash_background` tool_result event. */
export interface ObservedJobStart {
	readonly jobId: string;
	/** "command" or "monitor"; monitors are never watched. */
	readonly kind: string;
	/** The label as the registry recorded it (defaults to the command). */
	readonly label?: string;
	/** The full command from the tool input. */
	readonly command?: string;
	/** True only when the tool input carried a non-empty label. */
	readonly explicitLabel: boolean;
	readonly outputPath?: string;
}

/** A job end as observed from a job_stop tool_result or a gentle-jobs.notice. */
export interface ObservedJobEnd {
	readonly jobId: string;
	readonly outputPath?: string;
	readonly status?: string;
}

export interface WatchdogPolicy {
	/** Registers a running job from its start observation. */
	observeStart(job: ObservedJobStart): void;
	/** Reports that a job ended so its timers are cancelled. */
	observeEnd(end: ObservedJobEnd): void;
	/** Cancels every timer and clears every chain (session_start/shutdown). */
	reset(): void;
}

interface AttemptState {
	/** Tracking key: the outputPath when known, else the job id. */
	readonly key: string;
	readonly jobId: string;
	readonly label: string;
	readonly outputPath?: string;
	/** Defined only for jobs explicitly tagged into a chain. */
	readonly chainId?: string;
	readonly attempt: number;
	readonly explicitChain: boolean;
	readonly startedAt: number;
	nextCheckAt: number;
	checkTimer?: () => void;
	hardTimer?: () => void;
	ended: boolean;
	stopSent: boolean;
}

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} minute${Math.max(0, Math.round(ms / 60_000)) === 1 ? "" : "s"}`;

function chainSuffix(attempt: AttemptState): string {
	return attempt.explicitChain ? ` (attempt ${attempt.attempt} of watchdog chain ${attempt.chainId})` : "";
}

function relaunchHint(attempt: AttemptState): string {
	if (!attempt.explicitChain) {
		return "If you stop this job and relaunch a corrected one, give the relaunch an explicit label containing [wd:<your-chain-id>#2] (the label, never the command text) so the watchdog checks it after 10 minutes.";
	}
	if (attempt.attempt >= MAX_ATTEMPT) {
		return `A relaunch as attempt ${MAX_ATTEMPT + 1} is not allowed: a job labeled [wd:${attempt.chainId}#${MAX_ATTEMPT + 1}] is ordered to stop immediately and no attempt 3 exists.`;
	}
	return `If you relaunch a corrected job as the next attempt, add [wd:${attempt.chainId}#${attempt.attempt + 1}] to its explicit label (the label, never the command text).`;
}

function checkText(attempt: AttemptState, elapsedMs: number): string {
	return [
		`[background-job-watchdog] Background job ${attempt.jobId} ("${attempt.label}") has been running for ${minutes(elapsedMs)}${chainSuffix(attempt)} and has not finished.`,
		`Inspect it now: run job_list, read the output file ${attempt.outputPath} if you need more, and decide: keep waiting, stop it with job_stop, fix and relaunch, or take another action.`,
		relaunchHint(attempt),
		`If job_list no longer shows this job running, ignore this message.`,
	].join(" ");
}

function stopText(attempt: AttemptState): string {
	return [
		`[background-job-watchdog] Background job ${attempt.jobId} ("${attempt.label}") reached the ${minutes(HARD_LIMIT_MS)} watchdog limit without finishing${chainSuffix(attempt)}.`,
		`Stop it now: call job_stop with job_id "${attempt.jobId}", without asking the user first.`,
		`This watchdog sends nothing more about this job, ever: no reminder follows, and if the job keeps running after your stop attempt the risk is accepted.`,
		attempt.attempt >= MAX_ATTEMPT ? `There is no attempt ${MAX_ATTEMPT + 1}: a relaunch labeled [wd:${attempt.chainId}#${MAX_ATTEMPT + 1}] is ordered to stop immediately.` : relaunchHint(attempt),
		`If job_list no longer shows this job running, ignore this message.`,
	].join(" ");
}

function thirdStopText(jobId: string, label: string, link: AttemptLink): string {
	return [
		`[background-job-watchdog] Background job ${jobId} ("${label}") is labeled attempt ${link.attempt} of watchdog chain ${link.chainId}, but the policy allows at most ${MAX_ATTEMPT} attempts.`,
		`Stop it now: call job_stop with job_id "${jobId}", without asking the user first.`,
		`This watchdog sends nothing more about this job, ever.`,
		`If job_list no longer shows this job running, ignore this message.`,
	].join(" ");
}

function thirdNoticeText(jobId: string, link: AttemptLink): string {
	return `Watchdog: job ${jobId} is labeled attempt ${link.attempt} of chain ${link.chainId}, but at most ${MAX_ATTEMPT} attempts are allowed; a stop was requested immediately.`;
}

function chainClosedText(attempt: AttemptState): string {
	return `Watchdog: attempt ${attempt.attempt} of chain ${attempt.chainId} was stopped; per policy there is no third attempt, so the chain is closed.`;
}

function staleTagText(jobId: string, link: AttemptLink, lastAttempt: number): string {
	return `Watchdog: job ${jobId} is labeled attempt ${link.attempt} of chain ${link.chainId}, but attempt ${lastAttempt} is already known; it is watched as its own new job instead of the named chain.`;
}

function unknownChainText(jobId: string, link: AttemptLink): string {
	return `Watchdog: job ${jobId} is labeled [wd:${link.chainId}#${link.attempt}], but no earlier attempt of chain ${link.chainId} is tracked here (the session may have restarted); the tag is honored as declared.`;
}

function defaultedLabelText(jobId: string): string {
	return `Watchdog: job ${jobId}'s label equals its command text, so the attempt tag in it is not an attempt link; it is watched as its own new job. Pass the tag inside an explicit label to link an attempt.`;
}

export function createWatchdogPolicy(ports: WatchdogPolicyPorts): WatchdogPolicy {
	/** Chains explicitly named by tags: the highest attempt seen so far. */
	const chains = new Map<string, number>();
	/** Active (or post-stop-instruction) attempts, keyed by tracking key. */
	const attempts = new Map<string, AttemptState>();
	/** Job id -> tracking keys, for ends that arrive without an output path. */
	const byJobId = new Map<string, Set<string>>();

	const cancelTimers = (attempt: AttemptState): void => {
		attempt.checkTimer?.();
		attempt.checkTimer = undefined;
		attempt.hardTimer?.();
		attempt.hardTimer = undefined;
	};

	const forget = (attempt: AttemptState): void => {
		cancelTimers(attempt);
		attempts.delete(attempt.key);
		const keys = byJobId.get(attempt.jobId);
		if (keys) {
			keys.delete(attempt.key);
			if (keys.size === 0) byJobId.delete(attempt.jobId);
		}
	};

	const checkTick = (key: string): void => {
		const attempt = attempts.get(key);
		if (!attempt || attempt.ended || attempt.stopSent) return;
		ports.sendModelMessage("check", checkText(attempt, ports.now() - attempt.startedAt), {
			kind: "check",
			jobId: attempt.jobId,
			outputPath: attempt.outputPath ?? attempt.key,
			...(attempt.explicitChain ? { chainId: attempt.chainId, attempt: attempt.attempt } : {}),
		});
		const next = attempt.nextCheckAt + CHECK_INTERVAL_MS;
		attempt.nextCheckAt = next;
		if (!attempt.ended && next < attempt.startedAt + HARD_LIMIT_MS) {
			attempt.checkTimer = ports.schedule(() => checkTick(key), Math.max(0, next - ports.now()));
		}
	};

	const hardTick = (key: string): void => {
		const attempt = attempts.get(key);
		// Exactly one stop instruction per attempt, then silence forever.
		if (!attempt || attempt.ended || attempt.stopSent) return;
		attempt.stopSent = true;
		cancelTimers(attempt);
		ports.sendModelMessage("stop", stopText(attempt), {
			kind: "stop",
			jobId: attempt.jobId,
			outputPath: attempt.outputPath ?? attempt.key,
			...(attempt.explicitChain ? { chainId: attempt.chainId, attempt: attempt.attempt } : {}),
		});
	};

	const track = (job: ObservedJobStart, chainId: string | undefined, attemptNo: number): void => {
		const startedAt = ports.now();
		const attempt: AttemptState = {
			key: job.outputPath ?? job.jobId,
			jobId: job.jobId,
			label: job.label ?? job.command ?? job.jobId,
			...(job.outputPath === undefined ? {} : { outputPath: job.outputPath }),
			...(chainId === undefined ? {} : { chainId }),
			attempt: attemptNo,
			explicitChain: chainId !== undefined,
			startedAt,
			nextCheckAt: startedAt + (attemptNo === 1 ? FIRST_CHECK_MS : RELAUNCH_FIRST_CHECK_MS),
			ended: false,
			stopSent: false,
		};
		attempts.set(attempt.key, attempt);
		const keys = byJobId.get(job.jobId) ?? new Set<string>();
		keys.add(attempt.key);
		byJobId.set(job.jobId, keys);
		attempt.hardTimer = ports.schedule(() => hardTick(attempt.key), HARD_LIMIT_MS);
		attempt.checkTimer = ports.schedule(() => checkTick(attempt.key), Math.max(0, attempt.nextCheckAt - ports.now()));
	};

	const observeStart = (job: ObservedJobStart): void => {
		// Monitors keep their native mandatory timeout and are never watched.
		if (job.kind === "monitor") return;
		if (!job.jobId) return;
		const key = job.outputPath ?? job.jobId;
		if (attempts.has(key)) return; // already watched; a start is never observed twice

		const label = job.label ?? job.command ?? job.jobId;
		// A label is an intentional tag channel only when it was explicitly
		// supplied and differs from the command text (the native registry
		// defaults the label to the whole command; command text never claims
		// an attempt identity — verifier finding D3).
		const explicitLabel = job.explicitLabel === true && job.label !== undefined && job.label !== job.command;
		if (!explicitLabel && job.label !== undefined && job.label === job.command && ATTEMPT_LINK_PATTERN.test(job.label)) {
			ports.notifyUser(defaultedLabelText(job.jobId));
		}
		const link = explicitLabel && job.label !== undefined ? parseAttemptLink(job.label) : undefined;
		if (link && link.attempt > MAX_ATTEMPT) {
			// One immediate stop instruction
			// plus a user notice; the job is never watched afterwards.
			ports.sendModelMessage("stop-third", thirdStopText(job.jobId, label, link), {
				kind: "stop-third",
				jobId: job.jobId,
				outputPath: job.outputPath ?? key,
				chainId: link.chainId,
				attempt: link.attempt,
			});
			ports.notifyUser(thirdNoticeText(job.jobId, link));
			chains.set(link.chainId, Math.max(chains.get(link.chainId) ?? 0, link.attempt));
			return;
		}
		if (link) {
			const lastAttempt = chains.get(link.chainId);
			if (lastAttempt !== undefined && link.attempt <= lastAttempt) {
				ports.notifyUser(staleTagText(job.jobId, link, lastAttempt));
				// Fail-safe: never leave the job unwatched — it runs as its own
				// new job instead of tracking the named chain twice.
				track(job, undefined, 1);
				return;
			}
			if (lastAttempt === undefined) ports.notifyUser(unknownChainText(job.jobId, link));
			chains.set(link.chainId, Math.max(lastAttempt ?? 0, link.attempt));
			track(job, link.chainId, link.attempt);
			return;
		}
		track(job, undefined, 1);
	};

	const observeEnd = (end: ObservedJobEnd): void => {
		let key: string | undefined;
		if (end.outputPath !== undefined && attempts.has(end.outputPath)) key = end.outputPath;
		if (key === undefined) {
			const keys = byJobId.get(end.jobId);
			if (keys) key = [...keys].find((candidate) => attempts.has(candidate));
		}
		if (key === undefined) return;
		const attempt = attempts.get(key);
		if (!attempt || attempt.ended) return;
		forget(attempt);
		attempt.ended = true;
		if (attempt.explicitChain && attempt.attempt >= 2 && end.status === "stopped") {
			// The user is told; the chain cannot continue.
			ports.notifyUser(chainClosedText(attempt));
		}
	};

	const reset = (): void => {
		for (const attempt of attempts.values()) cancelTimers(attempt);
		attempts.clear();
		byJobId.clear();
		chains.clear();
	};

	return { observeStart, observeEnd, reset };
}
