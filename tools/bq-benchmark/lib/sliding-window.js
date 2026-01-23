/**
 * Sliding Window
 *
 * Calculates throughput and latency statistics from measurement samples.
 * Implements the sliding window algorithm that excludes warmup/cooldown.
 */

export class SlidingWindow {
	/**
	 * Create a new SlidingWindow calculator
	 *
	 * @param {Array} samples - Array of sample objects from measurement phase
	 */
	constructor(samples) {
		this.samples = samples;
	}

	/**
	 * Calculate throughput statistics (records/min and MB/min)
	 *
	 * @returns {Object} Throughput statistics for both checkpoint and table metrics
	 */
	calculateThroughput() {
		if (this.samples.length < 2) {
			return {
				checkpoint: this.emptyStats(),
				table: this.emptyStats(),
			};
		}

		// Calculate instantaneous throughput between consecutive samples
		const checkpointThroughputs = [];
		const tableThroughputs = [];

		for (let i = 1; i < this.samples.length; i++) {
			const prev = this.samples[i - 1];
			const curr = this.samples[i];

			const deltaTimeMin = (curr.timestamp - prev.timestamp) / 60000; // milliseconds to minutes

			if (deltaTimeMin > 0) {
				// Checkpoint-based throughput (ingestion)
				const checkpointDeltaRecords = curr.checkpoint.totalRecords - prev.checkpoint.totalRecords;
				const checkpointDeltaBytes = curr.checkpoint.totalBytes - prev.checkpoint.totalBytes;

				checkpointThroughputs.push({
					recordsPerMin: checkpointDeltaRecords / deltaTimeMin,
					mbPerMin: checkpointDeltaBytes / (1024 * 1024) / deltaTimeMin,
				});

				// Table-based throughput (query availability)
				const tableDeltaRecords = curr.table.totalRecords - prev.table.totalRecords;

				tableThroughputs.push({
					recordsPerMin: tableDeltaRecords / deltaTimeMin,
					// MB/min for table uses same size estimation as checkpoint
					mbPerMin: (tableDeltaRecords / checkpointDeltaRecords) * (checkpointDeltaBytes / (1024 * 1024) / deltaTimeMin),
				});
			}
		}

		return {
			checkpoint: {
				recordsPerMinute: this.calculateStats(checkpointThroughputs.map((t) => t.recordsPerMin)),
				mbPerMinute: this.calculateStats(checkpointThroughputs.map((t) => t.mbPerMin)),
			},
			table: {
				recordsPerMinute: this.calculateStats(tableThroughputs.map((t) => t.recordsPerMin)),
				mbPerMinute: this.calculateStats(tableThroughputs.map((t) => t.mbPerMin)),
			},
		};
	}

	/**
	 * Calculate latency percentiles (P50, P95, P99)
	 *
	 * @returns {Object} Latency percentiles for both checkpoint and table metrics
	 */
	calculateLatency() {
		const checkpointLatencies = [];
		const tableLatencies = [];

		for (const sample of this.samples) {
			// Checkpoint-based latency: time from BigQuery record to checkpoint update
			for (const checkpoint of sample.checkpoints) {
				if (checkpoint.lastTimestamp) {
					const syncLatency = sample.timestamp - new Date(checkpoint.lastTimestamp);
					checkpointLatencies.push(syncLatency);
				}
			}

			// Table-based latency: For now, use checkpoint latency + replication delta
			// This is an approximation; actual table latency would require tracking _syncedAt
			if (checkpointLatencies.length > 0 && sample.replicationLag) {
				// Estimate additional latency from replication lag
				const avgCheckpointLatency = checkpointLatencies[checkpointLatencies.length - 1];
				const replicationFactor = 1 + sample.replicationLag.percentLag / 100;
				tableLatencies.push(avgCheckpointLatency * replicationFactor);
			}
		}

		return {
			checkpoint: {
				p50: this.percentile(checkpointLatencies, 50),
				p95: this.percentile(checkpointLatencies, 95),
				p99: this.percentile(checkpointLatencies, 99),
				unit: 'milliseconds',
			},
			table: {
				p50: this.percentile(tableLatencies, 50),
				p95: this.percentile(tableLatencies, 95),
				p99: this.percentile(tableLatencies, 99),
				unit: 'milliseconds',
			},
		};
	}

	/**
	 * Calculate replication lag statistics
	 *
	 * @returns {Object} Replication lag statistics
	 */
	calculateReplicationLag() {
		const lagPercentages = [];
		const latencyDeltas = [];

		for (const sample of this.samples) {
			if (sample.replicationLag) {
				lagPercentages.push(sample.replicationLag.percentLag);

				// Approximate latency delta from replication lag
				// This is the additional time for data to become queryable
				const avgCheckpointLatency = this.getAvgCheckpointLatency(sample);
				const latencyDelta = avgCheckpointLatency * (sample.replicationLag.percentLag / 100);
				latencyDeltas.push(latencyDelta);
			}
		}

		return {
			percentLag: this.calculateStats(lagPercentages),
			latencyDelta: this.calculateStats(latencyDeltas),
		};
	}

	/**
	 * Calculate statistics for a set of values
	 *
	 * @param {Array<number>} values - Array of numeric values
	 * @returns {Object} Statistics (mean, median, min, max, stdDev)
	 * @private
	 */
	calculateStats(values) {
		if (values.length === 0) {
			return {
				mean: 0,
				median: 0,
				min: 0,
				max: 0,
				stdDev: 0,
			};
		}

		const sorted = values.slice().sort((a, b) => a - b);
		const mean = values.reduce((a, b) => a + b, 0) / values.length;

		return {
			mean: mean,
			median: this.percentile(sorted, 50),
			min: sorted[0],
			max: sorted[sorted.length - 1],
			stdDev: this.standardDeviation(values, mean),
		};
	}

	/**
	 * Calculate percentile from sorted values
	 *
	 * @param {Array<number>} sortedValues - Sorted array of values
	 * @param {number} p - Percentile (0-100)
	 * @returns {number} Percentile value
	 * @private
	 */
	percentile(sortedValues, p) {
		if (sortedValues.length === 0) {
			return 0;
		}

		// Sort if not already sorted
		const sorted = sortedValues.slice().sort((a, b) => a - b);

		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
	}

	/**
	 * Calculate standard deviation
	 *
	 * @param {Array<number>} values - Array of values
	 * @param {number} [mean] - Pre-calculated mean (optional)
	 * @returns {number} Standard deviation
	 * @private
	 */
	standardDeviation(values, mean = null) {
		if (values.length === 0) {
			return 0;
		}

		const avg = mean !== null ? mean : values.reduce((a, b) => a + b, 0) / values.length;
		const squaredDiffs = values.map((v) => Math.pow(v - avg, 2));
		const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;

		return Math.sqrt(avgSquaredDiff);
	}

	/**
	 * Get average checkpoint latency from a sample
	 *
	 * @param {Object} sample - Sample object
	 * @returns {number} Average checkpoint latency in milliseconds
	 * @private
	 */
	getAvgCheckpointLatency(sample) {
		const latencies = [];

		for (const checkpoint of sample.checkpoints) {
			if (checkpoint.lastTimestamp) {
				const latency = sample.timestamp - new Date(checkpoint.lastTimestamp);
				latencies.push(latency);
			}
		}

		if (latencies.length === 0) {
			return 0;
		}

		return latencies.reduce((a, b) => a + b, 0) / latencies.length;
	}

	/**
	 * Return empty stats structure
	 *
	 * @returns {Object} Empty statistics
	 * @private
	 */
	emptyStats() {
		return {
			recordsPerMinute: { mean: 0, median: 0, min: 0, max: 0, stdDev: 0 },
			mbPerMinute: { mean: 0, median: 0, min: 0, max: 0, stdDev: 0 },
		};
	}

	/**
	 * Get summary statistics for all metrics
	 *
	 * @returns {Object} Complete metrics summary
	 */
	getAllMetrics() {
		return {
			throughput: this.calculateThroughput(),
			latency: this.calculateLatency(),
			replicationLag: this.calculateReplicationLag(),
			sampleCount: this.samples.length,
			duration: this.samples.length > 1 ? (this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp) / 1000 : 0,
		};
	}
}
