/**
 * Phase Manager
 *
 * Controls the three-phase benchmark execution:
 * 1. Warmup - Stabilize system
 * 2. Measurement - Collect metrics
 * 3. Cooldown - Ensure completion
 */

export class PhaseManager {
	/**
	 * Create a new PhaseManager
	 *
	 * @param {Object} config - Configuration object
	 * @param {Object} [reporter] - Optional reporter for live updates
	 */
	constructor(config, reporter = null) {
		this.config = config;
		this.reporter = reporter;
	}

	/**
	 * Execute warmup phase
	 *
	 * @param {Function} sampleFn - Async function to collect one sample
	 * @returns {Promise<Array>} Array of samples (for reference, not used in metrics)
	 */
	async runWarmup(sampleFn) {
		const duration = this.config.warmupSeconds || 120;
		const samples = [];

		if (this.reporter) {
			this.reporter.phaseStart('warmup', duration);
		} else {
			console.log(`\n🔥 Warmup Phase (${duration}s)`);
			console.log('   Stabilizing system, allowing batch sizing to adjust...\n');
		}

		const startTime = Date.now();
		const endTime = startTime + duration * 1000;
		let lastReportTime = startTime;

		while (Date.now() < endTime) {
			try {
				const sample = await sampleFn();
				samples.push(sample);

				// Update reporter/console every few seconds
				const now = Date.now();
				const elapsed = (now - startTime) / 1000;
				const remaining = Math.max(0, duration - elapsed);

				if (this.reporter) {
					this.reporter.update('warmup', elapsed, duration, sample);
				} else if (now - lastReportTime > 5000) {
					// Console progress update every 5s
					console.log(`   Warmup: ${Math.floor(elapsed)}s / ${duration}s (${Math.floor(remaining)}s remaining)`);
					lastReportTime = now;
				}

				// Wait for next sample interval
				await this.sleep(this.config.sampleInterval * 1000);
			} catch (error) {
				console.error(`   Warning: Sample failed during warmup: ${error.message}`);
				// Continue with warmup
			}
		}

		if (this.reporter) {
			this.reporter.phaseEnd('warmup');
		} else {
			console.log(`   ✓ Warmup complete\n`);
		}

		return samples;
	}

	/**
	 * Execute measurement phase
	 *
	 * @param {Function} sampleFn - Async function to collect one sample
	 * @returns {Promise<Array>} Array of samples for metrics calculation
	 */
	async runMeasurement(sampleFn) {
		const duration = this.config.measureSeconds || 300;
		const samples = [];

		if (this.reporter) {
			this.reporter.phaseStart('measurement', duration);
		} else {
			console.log(`📊 Measurement Phase (${duration}s)`);
			console.log('   Collecting throughput metrics...\n');
		}

		const startTime = Date.now();
		const endTime = startTime + duration * 1000;
		let lastReportTime = startTime;

		while (Date.now() < endTime) {
			try {
				const sample = await sampleFn();
				samples.push(sample);

				// Calculate instantaneous throughput for live display
				if (samples.length >= 2) {
					const instant = this.calculateInstantThroughput(samples[samples.length - 2], samples[samples.length - 1]);
					sample.instantThroughput = instant;
				}

				const now = Date.now();
				const elapsed = (now - startTime) / 1000;

				if (this.reporter) {
					this.reporter.update('measurement', elapsed, duration, sample);
				} else if (now - lastReportTime > 5000) {
					// Console progress update every 5s
					const progress = Math.floor((elapsed / duration) * 100);
					console.log(`   Measurement: ${Math.floor(elapsed)}s / ${duration}s (${progress}%)`);

					if (sample.instantThroughput) {
						console.log(
							`     Records/min: ${Math.round(sample.instantThroughput.checkpoint.recordsPerMin).toLocaleString()}`
						);
						console.log(`     MB/min: ${sample.instantThroughput.checkpoint.mbPerMin.toFixed(1)}`);
					}

					lastReportTime = now;
				}

				// Wait for next sample interval
				await this.sleep(this.config.sampleInterval * 1000);
			} catch (error) {
				console.error(`   Warning: Sample failed during measurement: ${error.message}`);
				// Continue with measurement
			}
		}

		if (this.reporter) {
			this.reporter.phaseEnd('measurement');
		} else {
			console.log(`   ✓ Measurement complete (${samples.length} samples collected)\n`);
		}

		return samples;
	}

	/**
	 * Execute cooldown phase
	 *
	 * @param {Function} sampleFn - Async function to collect one sample
	 * @returns {Promise<Array>} Array of samples (for reference)
	 */
	async runCooldown(sampleFn) {
		const duration = this.config.cooldownSeconds || 60;
		const samples = [];

		if (this.reporter) {
			this.reporter.phaseStart('cooldown', duration);
		} else {
			console.log(`🏁 Cooldown Phase (${duration}s)`);
			console.log('   Allowing queued operations to complete...\n');
		}

		const startTime = Date.now();
		const endTime = startTime + duration * 1000;

		while (Date.now() < endTime) {
			try {
				const sample = await sampleFn();
				samples.push(sample);

				const now = Date.now();
				const elapsed = (now - startTime) / 1000;

				if (this.reporter) {
					this.reporter.update('cooldown', elapsed, duration, sample);
				}

				// Wait for next sample interval
				await this.sleep(this.config.sampleInterval * 1000);
			} catch (error) {
				console.error(`   Warning: Sample failed during cooldown: ${error.message}`);
				// Continue with cooldown
			}
		}

		if (this.reporter) {
			this.reporter.phaseEnd('cooldown');
		} else {
			console.log(`   ✓ Cooldown complete\n`);
		}

		return samples;
	}

	/**
	 * Calculate instantaneous throughput between two samples
	 *
	 * @param {Object} prevSample - Previous sample
	 * @param {Object} currSample - Current sample
	 * @returns {Object} Instantaneous throughput
	 * @private
	 */
	calculateInstantThroughput(prevSample, currSample) {
		const deltaTimeMin = (currSample.timestamp - prevSample.timestamp) / 60000;

		if (deltaTimeMin <= 0) {
			return {
				checkpoint: { recordsPerMin: 0, mbPerMin: 0 },
				table: { recordsPerMin: 0, mbPerMin: 0 },
			};
		}

		// Checkpoint-based throughput
		const checkpointDeltaRecords = currSample.checkpoint.totalRecords - prevSample.checkpoint.totalRecords;
		const checkpointDeltaBytes = currSample.checkpoint.totalBytes - prevSample.checkpoint.totalBytes;

		// Table-based throughput
		const tableDeltaRecords = currSample.table.totalRecords - prevSample.table.totalRecords;

		return {
			checkpoint: {
				recordsPerMin: checkpointDeltaRecords / deltaTimeMin,
				mbPerMin: checkpointDeltaBytes / (1024 * 1024) / deltaTimeMin,
			},
			table: {
				recordsPerMin: tableDeltaRecords / deltaTimeMin,
				mbPerMin:
					(tableDeltaRecords / (checkpointDeltaRecords || 1)) *
					(checkpointDeltaBytes / (1024 * 1024) / deltaTimeMin),
			},
		};
	}

	/**
	 * Sleep for specified milliseconds
	 *
	 * @param {number} ms - Milliseconds to sleep
	 * @returns {Promise<void>}
	 * @private
	 */
	sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
