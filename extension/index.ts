// Background job watchdog — standalone Pi extension (issue #3086).
//
// Watches the parent session's `bash_background` jobs through tool_result
// events and `gentle-jobs.notice` messages, and wakes the orchestrator with
// self-contained steer messages: a check-in at 20 minutes of an untagged
// first attempt (10 minutes for an attempt explicitly tagged
// [wd:<chainId>#2] in its own label), every 20 minutes while it runs, and
// exactly one stop instruction at 180 minutes of the attempt's own clock.
//
// The extension NEVER stops a job: the native job registry is private to
// gentle-pi's gentle-agents.ts, so the 180-minute stop is an instruction the
// model must carry out with job_stop — the risk that the job keeps running
// is accepted. Child sessions skip the extension entirely, and jobs
// there would never be observed anyway (agents only get bash_background when
// their definition declares it).
//
// Timers are started only from events, never in the factory. session_start
// and session_shutdown clear every timer and all tracking state.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWatchdogPolicy, type ObservedJobEnd, type ObservedJobStart } from "./policy.ts";

/** Set to "1" in Gentle Agents child sessions; the watchdog is parent-only. */
export const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";

/** The custom message the native job registry sends when a job it owns ends. */
const JOB_NOTICE_TYPE = "gentle-jobs.notice";

export interface ExtensionOptions {
	/** Process environment; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Clock; defaults to Date.now. Injectable for tests. */
	now?: () => number;
	/** Timer scheduler; defaults to setTimeout. Injectable for tests. */
	schedule?: (fn: () => void, ms: number) => () => void;
}

interface GentleJobsDetails {
	jobId?: unknown;
	kind?: unknown;
	label?: unknown;
	status?: unknown;
	outputPath?: unknown;
}

function readGentleJobs(details: unknown): GentleJobsDetails | undefined {
	if (!details || typeof details !== "object") return undefined;
	const gentle = (details as { gentleJobs?: unknown }).gentleJobs;
	return gentle && typeof gentle === "object" ? (gentle as GentleJobsDetails) : undefined;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export default function backgroundJobWatchdog(pi: ExtensionAPI, options: ExtensionOptions = {}): void {
	if ((options.env ?? process.env)[CHILD_ENV] === "1") return;

	const now = options.now ?? (() => Date.now());
	const schedule = options.schedule ?? ((fn: () => void, ms: number) => {
		const timer = setTimeout(fn, Math.max(0, ms));
		(timer as { unref?: () => void }).unref?.();
		return () => clearTimeout(timer);
	});

	// Kept from the latest event context so timer-free notices (chain
	// closures, tag warnings) can reach the user.
	let ctx: ExtensionContext | undefined;

	const policy = createWatchdogPolicy({
		now,
		schedule,
		sendModelMessage: (kind, text, meta) => {
			try {
				pi.sendMessage(
					{ customType: `background-job-watchdog.${kind}`, content: text, display: true, details: { watchdog: meta } },
					{ deliverAs: "steer", triggerTurn: true },
				);
			} catch {
				// Best effort: a failed wake must never break the session.
			}
		},
		notifyUser: (text) => {
			try {
				ctx?.ui.notify(text, "warning");
			} catch {
				// The context decides whether notices are visible; never fatal.
			}
		},
	});

	pi.on("session_start", (_event, context) => {
		ctx = context as ExtensionContext;
		policy.reset();
	});

	pi.on("session_shutdown", () => {
		policy.reset();
		ctx = undefined;
	});

	pi.on("tool_result", (event, context) => {
		ctx = context as ExtensionContext;
		const { toolName, input, details } = event as { toolName?: unknown; input?: unknown; details?: unknown };
		const gentle = readGentleJobs(details);
		if (toolName === "bash_background") {
			const startInput = (input ?? {}) as { command?: unknown; label?: unknown };
			const labelInput = asString(startInput.label);
			const start: ObservedJobStart = {
				jobId: asString(gentle?.jobId) ?? "",
				kind: asString(gentle?.kind) ?? "command",
				label: asString(gentle?.label) ?? (labelInput?.trim() || undefined),
				command: asString(startInput.command),
				// The label is explicit only when the tool input carried a non-empty
				// label; the registry otherwise defaults the label to the command.
				explicitLabel: labelInput !== undefined && labelInput.trim() !== "",
				outputPath: asString(gentle?.outputPath),
			};
			policy.observeStart(start);
			return undefined;
		}
		if (toolName === "job_stop") {
			const stopInput = (input ?? {}) as { job_id?: unknown };
			const end: ObservedJobEnd = {
				jobId: asString(gentle?.jobId) ?? asString(stopInput.job_id) ?? "",
				outputPath: asString(gentle?.outputPath),
				status: asString(gentle?.status),
			};
			policy.observeEnd(end);
		}
		return undefined;
	});

	pi.on("message_end", (event, context) => {
		ctx = context as ExtensionContext;
		const message = (event as { message?: { customType?: unknown; details?: unknown } }).message;
		if (!message || message.customType !== JOB_NOTICE_TYPE) return undefined;
		const gentle = readGentleJobs(message.details);
		if (!gentle || gentle.kind === "monitor") return undefined;
		policy.observeEnd({
			jobId: asString(gentle.jobId) ?? "",
			outputPath: asString(gentle.outputPath),
			status: asString(gentle.status),
		});
		return undefined;
	});
}
