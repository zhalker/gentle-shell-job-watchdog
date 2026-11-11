// Deterministic fake clock shared by the watchdog tests. Timers fire in
// (time, scheduling order); a timer scheduled while another runs is picked up
// by the same advance() loop, so no real time and no real processes are used.

export class FakeClock {
	private t = 0;
	private seq = 0;
	private readonly timers = new Map<number, { at: number; fn: () => void; cancelled: boolean }>();

	readonly now = (): number => this.t;

	schedule = (fn: () => void, ms: number): (() => void) => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.t + Math.max(0, ms), fn, cancelled: false });
		return () => {
			const timer = this.timers.get(id);
			if (timer) timer.cancelled = true;
		};
	};

	/** Runs every timer due within the next `ms`, in (time, order) sequence. */
	advance = (ms: number): void => {
		const target = this.t + ms;
		for (;;) {
			let picked: { id: number; at: number } | undefined;
			for (const [id, timer] of this.timers) {
				if (timer.cancelled || timer.at > target) continue;
				if (!picked || timer.at < picked.at || (timer.at === picked.at && id < picked.id)) picked = { id, at: timer.at };
			}
			if (!picked) break;
			this.t = Math.max(this.t, picked.at);
			const timer = this.timers.get(picked.id);
			this.timers.delete(picked.id);
			if (timer && !timer.cancelled) timer.fn();
		}
		this.t = target;
	};

	/** Timers still scheduled and not cancelled. */
	pendingCount = (): number => {
		let n = 0;
		for (const timer of this.timers.values()) if (!timer.cancelled) n++;
		return n;
	};
}
