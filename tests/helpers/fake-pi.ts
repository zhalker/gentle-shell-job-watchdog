// Fake ExtensionAPI for the extension tests: captures event handlers, the
// steer messages the extension sends and the user notices it raises. No real
// Pi, no real jobs, no network: the tests drive one event at a time through
// the extension's public interface.

export interface FakeSentMessage {
	message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> };
	options: { deliverAs: string; triggerTurn: boolean };
}

export type FakeHandler = (event: unknown, ctx: unknown) => unknown;

export class FakePi {
	readonly sent: FakeSentMessage[] = [];
	readonly handlers = new Map<string, FakeHandler[]>();

	on(name: string, handler: FakeHandler): void {
		const list = this.handlers.get(name) ?? [];
		list.push(handler);
		this.handlers.set(name, list);
	}

	sendMessage(message: FakeSentMessage["message"], options: FakeSentMessage["options"]): void {
		this.sent.push({ message, options });
	}

	handlerCount(): number {
		let n = 0;
		for (const list of this.handlers.values()) n += list.length;
		return n;
	}
}

export interface FakePiEnv {
	pi: FakePi;
	emit(event: string, payload?: unknown): void;
	sent: FakeSentMessage[];
	userNotices: Array<{ text: string; level: string }>;
}

export function setupFakePi(): FakePiEnv {
	const pi = new FakePi();
	const userNotices: Array<{ text: string; level: string }> = [];
	const ctx = { ui: { notify: (text: string, level: string) => userNotices.push({ text, level }) } };
	return {
		pi,
		userNotices,
		sent: pi.sent,
		emit: (event, payload = {}) => {
			for (const handler of pi.handlers.get(event) ?? []) handler(payload, ctx);
		},
	};
}
