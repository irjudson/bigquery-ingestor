/**
 * Resource Monitor
 *
 * Monitors system resource usage (CPU, memory) during benchmark.
 * Note: Network I/O monitoring requires OS-specific implementations.
 */

export class ResourceMonitor {
	constructor() {
		this.samples = [];
		this.startUsage = null;
	}

	/**
	 * Start monitoring (capture baseline)
	 */
	start() {
		this.startUsage = {
			cpu: process.cpuUsage(),
			time: Date.now(),
		};
		this.samples = [];
	}

	/**
	 * Sample current resource usage
	 *
	 * @returns {Object} Resource usage snapshot
	 */
	sample() {
		const now = Date.now();
		const cpuUsage = process.cpuUsage(this.startUsage.cpu);
		const memUsage = process.memoryUsage();

		// Calculate CPU percentage
		const elapsedMs = now - this.startUsage.time;
		const elapsedUs = elapsedMs * 1000; // microseconds
		const totalCpuUs = cpuUsage.user + cpuUsage.system;
		const cpuPercent = (totalCpuUs / elapsedUs) * 100;

		const snapshot = {
			timestamp: now,
			cpu: {
				percent: cpuPercent,
				user: cpuUsage.user,
				system: cpuUsage.system,
			},
			memory: {
				rss: memUsage.rss,
				heapTotal: memUsage.heapTotal,
				heapUsed: memUsage.heapUsed,
				external: memUsage.external,
				rssMB: Math.round(memUsage.rss / (1024 * 1024)),
				heapUsedMB: Math.round(memUsage.heapUsed / (1024 * 1024)),
			},
		};

		this.samples.push(snapshot);
		return snapshot;
	}

	/**
	 * Get aggregated statistics from all samples
	 *
	 * @returns {Object} Resource usage statistics
	 */
	getStatistics() {
		if (this.samples.length === 0) {
			return null;
		}

		const cpuPercents = this.samples.map((s) => s.cpu.percent);
		const rssMBs = this.samples.map((s) => s.memory.rssMB);
		const heapMBs = this.samples.map((s) => s.memory.heapUsedMB);

		return {
			cpu: {
				mean: this.mean(cpuPercents),
				peak: Math.max(...cpuPercents),
				min: Math.min(...cpuPercents),
				unit: 'percent',
			},
			memory: {
				rssMean: this.mean(rssMBs),
				rssPeak: Math.max(...rssMBs),
				heapMean: this.mean(heapMBs),
				heapPeak: Math.max(...heapMBs),
				unit: 'MB',
			},
			sampleCount: this.samples.length,
		};
	}

	/**
	 * Calculate mean of an array
	 *
	 * @param {Array<number>} values - Array of numbers
	 * @returns {number} Mean value
	 * @private
	 */
	mean(values) {
		if (values.length === 0) {
			return 0;
		}
		return values.reduce((a, b) => a + b, 0) / values.length;
	}

	/**
	 * Reset monitor state
	 */
	reset() {
		this.samples = [];
		this.startUsage = null;
	}
}
